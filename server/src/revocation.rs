//! Closes connections whose GLPI session token disappeared from Valkey
//! (logout, expiry, explicit revocation by the plugin).

use std::sync::Arc;
use std::time::Duration;

use fred::prelude::*;
use tokio::sync::watch;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::protocol::ByeReason;
use crate::registry::Registry;
use crate::store::{Store, fred_config};

fn revoke(registry: &Registry, hash: &str) {
    let n = registry.close_session(hash, ByeReason::Revoked);
    if n > 0 {
        metrics::counter!("rt_revocations_total").increment(n as u64);
        debug!(connections = n, "session revoked");
    }
}

/// Periodic safety net: works whatever the Valkey configuration.
pub async fn sweep(
    store: Store,
    registry: Arc<Registry>,
    every: Duration,
    mut stop: watch::Receiver<bool>,
) {
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = stop.changed() => return,
        }
        let sessions = registry.sessions();
        if sessions.is_empty() {
            continue;
        }
        match store.sessions_alive(&sessions).await {
            Ok(alive) => {
                for (hash, ok) in sessions.iter().zip(alive) {
                    if !ok {
                        revoke(&registry, hash);
                    }
                }
            }
            // Valkey unreachable: keep connections, retry next tick.
            Err(e) => warn!(error = %e, "revocation sweep failed"),
        }
    }
}

/// Instant revocation through keyspace notifications (`notify-keyspace-events Kgx`).
pub async fn keyspace(
    cfg: Arc<Config>,
    store: Store,
    registry: Arc<Registry>,
    mut stop: watch::Receiver<bool>,
) {
    let sub = match fred_config(&cfg.valkey)
        .and_then(|c| Builder::from_config(c).build_subscriber_client())
    {
        Ok(s) => s,
        Err(e) => return warn!(error = %e, "keyspace subscriber disabled"),
    };
    if let Err(e) = sub.init().await {
        return warn!(error = %e, "keyspace subscriber disabled");
    }
    let _resub = sub.manage_subscriptions();
    // fred routes `__keyspace@...` messages to a dedicated channel, not to `message_rx`.
    let mut rx = sub.keyspace_event_rx();
    let key_prefix = store.session_key("");
    let pattern = format!("__keyspace@{}__:{key_prefix}*", cfg.valkey.db);
    if let Err(e) = sub.psubscribe(pattern).await {
        return warn!(error = %e, "keyspace subscriber disabled");
    }
    info!("listening to keyspace notifications for session revocation");
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            ev = rx.recv() => {
                let Ok(ev) = ev else { continue };
                if ev.db == cfg.valkey.db
                    && matches!(ev.operation.as_str(), "del" | "expired" | "unlink" | "evicted")
                    && let Some(hash) = ev.key.as_str().and_then(|k| k.strip_prefix(key_prefix.as_str()))
                {
                    revoke(&registry, hash);
                }
            }
        }
    }
    let _ = sub.quit().await;
}
