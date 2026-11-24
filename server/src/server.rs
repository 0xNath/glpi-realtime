//! Router, listeners, background tasks and graceful shutdown.

use std::future::Future;
use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};
use metrics_exporter_prometheus::PrometheusHandle;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::info;

use crate::config::{Config, Listen};
use crate::drafts::Drafts;
use crate::events::Hub;
use crate::locks::Locks;
use crate::presence::Presence;
use crate::protocol::ByeReason;
use crate::registry::Registry;
use crate::store::Store;
use crate::{revocation, ws};

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub store: Store,
    pub registry: Arc<Registry>,
    pub user_limiter: Arc<DefaultKeyedRateLimiter<u64>>,
    pub presence: Arc<Presence>,
    pub hub: Arc<Hub>,
    pub locks: Arc<Locks>,
    pub drafts: Arc<Drafts>,
    pub metrics: Option<PrometheusHandle>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws::handler))
        .route("/health", get(health))
        .route("/metrics", get(metrics_page))
        .with_state(state)
}

async fn health(State(app): State<AppState>) -> impl IntoResponse {
    let valkey = matches!(
        tokio::time::timeout(Duration::from_secs(1), app.store.ping()).await,
        Ok(Ok(()))
    );
    let body = serde_json::json!({
        "status": if valkey { "ok" } else { "degraded" },
        "valkey": valkey,
        "connections": app.registry.len(),
    });
    let code = if valkey {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, Json(body))
}

async fn metrics_page(State(app): State<AppState>) -> impl IntoResponse {
    match &app.metrics {
        Some(h) => (StatusCode::OK, h.render()),
        None => (StatusCode::NOT_FOUND, String::new()),
    }
}

/// A running server, returned by [`start`].
pub struct Running {
    /// Bound address when listening on TCP (useful with port 0 in tests).
    pub local_addr: Option<SocketAddr>,
    pub registry: Arc<Registry>,
    stop: watch::Sender<bool>,
    join: JoinHandle<anyhow::Result<()>>,
}

impl Running {
    /// Graceful stop: clients receive `bye{shutdown}`, then the process may exit.
    pub async fn stop(self) -> anyhow::Result<()> {
        let _ = self.stop.send(true);
        self.join.await.context("server task panicked")?
    }

    /// Runs until `signal` resolves (then stops gracefully) or the server fails.
    pub async fn run_until(self, signal: impl Future<Output = ()>) -> anyhow::Result<()> {
        let Running { stop, mut join, .. } = self;
        tokio::select! {
            _ = signal => {}
            r = &mut join => return r.context("server task panicked")?,
        }
        let _ = stop.send(true);
        join.await.context("server task panicked")?
    }
}

pub async fn start(cfg: Config, metrics: Option<PrometheusHandle>) -> anyhow::Result<Running> {
    cfg.validate().map_err(anyhow::Error::msg)?;
    let cfg = Arc::new(cfg);
    let store = Store::connect(&cfg.valkey)
        .await
        .context("connecting to Valkey")?;
    let registry = Registry::new(
        cfg.limits.max_connections,
        cfg.limits.max_connections_per_user,
    );
    let user_quota = Quota::per_second(
        NonZeroU32::new(cfg.limits.user_messages_per_second).unwrap_or(NonZeroU32::MIN),
    )
    .allow_burst(NonZeroU32::new(cfg.limits.user_burst).unwrap_or(NonZeroU32::MIN));
    let hub = Hub::new(Arc::clone(&registry));
    let locks = Locks::new(store.clone(), Arc::clone(&hub), cfg.locks.ttl_secs);
    let drafts = Drafts::new(store.clone(), Arc::clone(&hub), cfg.drafts.ttl_secs);
    let state = AppState {
        cfg: Arc::clone(&cfg),
        store: store.clone(),
        registry: Arc::clone(&registry),
        user_limiter: Arc::new(RateLimiter::keyed(user_quota)),
        presence: Presence::new(store.clone(), Arc::clone(&registry), cfg.presence.ttl_secs),
        hub,
        locks,
        drafts,
        metrics,
    };
    let (stop_tx, stop_rx) = watch::channel(false);

    // Background tasks.
    tokio::spawn(Arc::clone(&state.presence).heartbeat(
        Duration::from_secs(cfg.presence.heartbeat_secs),
        stop_rx.clone(),
    ));
    tokio::spawn(Arc::clone(&state.presence).listen(Arc::clone(&cfg), stop_rx.clone()));
    tokio::spawn(Arc::clone(&state.hub).listen(Arc::clone(&cfg), store.clone(), stop_rx.clone()));
    tokio::spawn(
        Arc::clone(&state.locks).sweep(Duration::from_secs(cfg.locks.sweep_secs), stop_rx.clone()),
    );
    tokio::spawn(Arc::clone(&state.locks).listen(Arc::clone(&cfg), stop_rx.clone()));
    tokio::spawn(Arc::clone(&state.drafts).listen(Arc::clone(&cfg), stop_rx.clone()));
    tokio::spawn(revocation::sweep(
        store.clone(),
        Arc::clone(&registry),
        Duration::from_secs(cfg.revocation.sweep_interval_secs.max(1)),
        stop_rx.clone(),
    ));
    if cfg.revocation.keyspace_events {
        tokio::spawn(revocation::keyspace(
            Arc::clone(&cfg),
            store.clone(),
            Arc::clone(&registry),
            stop_rx.clone(),
        ));
    }
    {
        let limiter = Arc::clone(&state.user_limiter);
        let mut stop = stop_rx.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_secs(60));
            loop {
                tokio::select! {
                    _ = t.tick() => limiter.retain_recent(),
                    _ = stop.changed() => return,
                }
            }
        });
    }

    let app = router(state);
    let grace = Duration::from_secs(cfg.shutdown.grace_secs);
    let shutdown = {
        let registry = Arc::clone(&registry);
        let mut stop = stop_rx.clone();
        async move {
            let _ = stop.changed().await;
            info!(connections = registry.len(), "shutting down");
            registry.close_all(ByeReason::Shutdown);
        }
    };

    let (local_addr, join): (Option<SocketAddr>, JoinHandle<anyhow::Result<()>>) = match &cfg.listen
    {
        Listen::Tcp { addr } => {
            let l = tokio::net::TcpListener::bind(addr)
                .await
                .with_context(|| format!("binding {addr}"))?;
            let local = l.local_addr()?;
            info!(%local, "listening (tcp)");
            let reg = Arc::clone(&registry);
            (
                Some(local),
                tokio::spawn(async move {
                    axum::serve(l, app).with_graceful_shutdown(shutdown).await?;
                    drain(&reg, grace).await;
                    Ok(())
                }),
            )
        }
        Listen::Unix { path, mode, group } => {
            let l = bind_unix(path, *mode, group.as_deref())?;
            info!(path = %path.display(), "listening (unix)");
            let reg = Arc::clone(&registry);
            let path = path.clone();
            (
                None,
                tokio::spawn(async move {
                    axum::serve(l, app).with_graceful_shutdown(shutdown).await?;
                    drain(&reg, grace).await;
                    let _ = std::fs::remove_file(&path);
                    Ok(())
                }),
            )
        }
    };

    Ok(Running {
        local_addr,
        registry,
        stop: stop_tx,
        join,
    })
}

/// Upgraded WebSockets are not tracked by axum: wait for them explicitly.
async fn drain(registry: &Registry, grace: Duration) {
    let deadline = Instant::now() + grace;
    while !registry.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn bind_unix(
    path: &Path,
    mode: u32,
    group: Option<&str>,
) -> anyhow::Result<tokio::net::UnixListener> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        anyhow::ensure!(
            meta.file_type().is_socket(),
            "{} exists and is not a socket",
            path.display()
        );
        std::fs::remove_file(path)?;
    }
    let l = tokio::net::UnixListener::bind(path)
        .with_context(|| format!("binding {}", path.display()))?;
    if let Some(g) = group {
        let gid = gid_of(g, &std::fs::read_to_string("/etc/group")?)
            .with_context(|| format!("unknown group {g}"))?;
        std::os::unix::fs::chown(path, None, Some(gid))
            .with_context(|| format!("chgrp {g} on socket"))?;
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(l)
}

pub fn gid_of(name: &str, etc_group: &str) -> Option<u32> {
    etc_group.lines().find_map(|l| {
        let mut f = l.split(':');
        (f.next()? == name)
            .then(|| f.nth(1)?.parse().ok())
            .flatten()
    })
}

/// Resolves on SIGINT or SIGTERM.
pub async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("installing SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::gid_of;

    #[test]
    fn group_lookup() {
        let g = "root:x:0:root\nhttp:x:33:\nvalkey:x:938:http,glpi\n";
        assert_eq!(gid_of("http", g), Some(33));
        assert_eq!(gid_of("valkey", g), Some(938));
        assert_eq!(gid_of("htt", g), None);
    }
}
