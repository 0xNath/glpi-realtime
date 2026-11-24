//! What this instance tells the GLPI plugin's configuration page (health checks): every
//! `PERIOD`, `rt:srv:{instance}` holds a JSON [`Status`] with a short TTL. The plugin
//! compares it with GLPI's own settings (version, cookie name, origins, item types), since
//! it cannot reach the server's socket itself (only the web server can).

use std::sync::Arc;
use std::time::Duration;

use fred::prelude::*;
use serde::Serialize;
use tokio::sync::watch;
use tracing::warn;
use uuid::Uuid;

use crate::config::{Config, Listen};
use crate::presence::now;
use crate::registry::Registry;
use crate::store::Store;

pub const PERIOD: Duration = Duration::from_secs(10);
/// Gone after three missed periods.
const TTL_SECS: i64 = 30;

#[derive(Debug, Serialize)]
pub struct Status {
    pub version: &'static str,
    pub instance: String,
    /// Unix seconds.
    pub started: u64,
    pub updated: u64,
    pub connections: usize,
    pub cookie_name: String,
    pub allowed_origins: Vec<String>,
    pub allowed_itemtypes: Vec<String>,
    pub listen: String,
    /// `revocation.keyspace_events` is on.
    pub keyspace_events: bool,
    /// Valkey's `notify-keyspace-events` holds what instant revocation needs: `ok`,
    /// `missing` (value given), or `unknown` (CONFIG GET refused, e.g. by an ACL).
    pub keyspace_config: String,
}

/// `notify-keyspace-events` must contain K (keyspace), g (generic: DEL) and x (expired);
/// `A` stands for every event class but not K.
pub fn keyspace_ok(flags: &str) -> bool {
    flags.contains('K') && (flags.contains('A') || (flags.contains('g') && flags.contains('x')))
}

async fn keyspace_config(store: &Store) -> String {
    let res: Result<Vec<String>, _> = store
        .pool()
        .next()
        .custom(fred::cmd!("CONFIG"), vec!["GET", "notify-keyspace-events"])
        .await;
    match res {
        Ok(v) => match v.get(1) {
            Some(flags) if keyspace_ok(flags) => "ok".into(),
            Some(flags) => format!("missing ({flags})"),
            None => "unknown".into(),
        },
        Err(_) => "unknown".into(),
    }
}

/// Publishes this instance's status until stopped, and removes it then.
pub async fn announce(
    cfg: Arc<Config>,
    store: Store,
    registry: Arc<Registry>,
    mut stop: watch::Receiver<bool>,
) {
    let instance = Uuid::new_v4().to_string();
    let key = format!("{}srv:{instance}", store.prefix());
    let started = now();
    let listen = match &cfg.listen {
        Listen::Unix { path, .. } => format!("unix:{}", path.display()),
        Listen::Tcp { addr } => format!("tcp:{addr}"),
    };
    let mut tick = tokio::time::interval(PERIOD);
    let mut keyspace = String::from("unknown");
    let mut n = 0u32;
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = stop.changed() => break,
        }
        // Valkey's configuration rarely changes: every 6 periods.
        if n.is_multiple_of(6) {
            keyspace = keyspace_config(&store).await;
        }
        n = n.wrapping_add(1);
        let status = Status {
            version: env!("CARGO_PKG_VERSION"),
            instance: instance.clone(),
            started,
            updated: now(),
            connections: registry.len(),
            cookie_name: cfg.security.cookie_name.clone(),
            allowed_origins: cfg.security.allowed_origins.clone(),
            allowed_itemtypes: cfg.security.allowed_itemtypes.clone(),
            listen: listen.clone(),
            keyspace_events: cfg.revocation.keyspace_events,
            keyspace_config: keyspace.clone(),
        };
        let json = serde_json::to_string(&status).expect("status serializes");
        let res: Result<(), _> = store
            .pool()
            .set(&key, json, Some(Expiration::EX(TTL_SECS)), None, false)
            .await;
        if let Err(e) = res {
            warn!(error = %e, "status: cannot publish");
        }
    }
    let _: Result<i64, _> = store.pool().del(&key).await;
}

#[cfg(test)]
mod tests {
    use super::keyspace_ok;

    #[test]
    fn keyspace_flags() {
        assert!(keyspace_ok("Kgx"));
        assert!(keyspace_ok("KEA"));
        assert!(keyspace_ok("xKg"));
        assert!(!keyspace_ok(""));
        assert!(!keyspace_ok("Egx"), "keyspace (K) events are the ones used");
        assert!(!keyspace_ok("Kx"), "DEL is a generic (g) event");
    }
}
