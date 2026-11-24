//! Configuration: defaults < TOML file < environment (`GLPI_RT_SECTION__KEY`).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use figment::Figment;
use figment::providers::{Env, Format, Serialized, Toml};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub listen: Listen,
    pub valkey: ValkeyConfig,
    pub security: SecurityConfig,
    pub limits: Limits,
    pub revocation: RevocationConfig,
    pub presence: PresenceConfig,
    pub events: EventsConfig,
    pub locks: LocksConfig,
    pub drafts: DraftsConfig,
    pub shutdown: ShutdownConfig,
    pub log: LogConfig,
}

/// Where the HTTP/WebSocket server listens. nginx proxies `/ws` to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Listen {
    Unix {
        path: PathBuf,
        /// File mode of the socket (TOML accepts octal: `0o660`).
        #[serde(default = "default_socket_mode")]
        mode: u32,
        /// Group owning the socket (nginx's group, e.g. `http`). The process must be a member.
        #[serde(default)]
        group: Option<String>,
    },
    Tcp {
        addr: SocketAddr,
    },
}

fn default_socket_mode() -> u32 {
    0o660
}

impl Default for Listen {
    fn default() -> Self {
        Listen::Unix {
            path: PathBuf::from("/run/glpi-realtime/rt.sock"),
            mode: default_socket_mode(),
            group: Some("http".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ValkeyConfig {
    /// `unix:///run/valkey/valkey.sock` or `redis://127.0.0.1:6379`.
    pub url: String,
    /// Logical database shared with the GLPI plugin.
    pub db: u8,
    pub pool_size: usize,
    /// Prefix of every key written by the plugin and read by the server.
    pub key_prefix: String,
}

impl Default for ValkeyConfig {
    fn default() -> Self {
        Self {
            url: "unix:///run/valkey/valkey.sock".into(),
            db: 6,
            pool_size: 8,
            key_prefix: "rt:".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SecurityConfig {
    /// Cookie set by the plugin, sent by the browser on the WebSocket handshake.
    pub cookie_name: String,
    /// Exact `Origin` values accepted on the handshake (scheme://host[:port]).
    pub allowed_origins: Vec<String>,
    /// Item types a client may subscribe to (`Ticket:42`).
    pub allowed_itemtypes: Vec<String>,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            cookie_name: "glpi_rt".into(),
            allowed_origins: vec![],
            allowed_itemtypes: vec!["Ticket".into(), "Change".into(), "Problem".into()],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    /// Hard cap on simultaneous connections for this instance.
    pub max_connections: usize,
    pub max_connections_per_user: usize,
    pub max_message_bytes: usize,
    pub max_rooms_per_connection: usize,
    /// Token bucket per connection.
    pub messages_per_second: u32,
    pub burst: u32,
    /// Token bucket shared by all connections of a user.
    pub user_messages_per_second: u32,
    pub user_burst: u32,
    /// Rate-limit violations tolerated before the connection is closed.
    pub max_violations: u32,
    /// Messages queued towards a client before it is considered too slow and dropped.
    pub outbound_queue: usize,
    pub ping_interval_secs: u64,
    pub idle_timeout_secs: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: 25_000,
            max_connections_per_user: 10,
            max_message_bytes: 64 * 1024,
            max_rooms_per_connection: 50,
            messages_per_second: 20,
            burst: 40,
            user_messages_per_second: 50,
            user_burst: 100,
            max_violations: 20,
            outbound_queue: 256,
            ping_interval_secs: 30,
            idle_timeout_secs: 90,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RevocationConfig {
    /// Periodic check that the session keys of open connections still exist.
    pub sweep_interval_secs: u64,
    /// Also react instantly to Valkey keyspace notifications
    /// (requires `notify-keyspace-events` to contain `K`, `g` and `x`).
    pub keyspace_events: bool,
}

impl Default for RevocationConfig {
    fn default() -> Self {
        Self {
            sweep_interval_secs: 15,
            keyspace_events: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PresenceConfig {
    /// How often each instance refreshes its presence entries.
    pub heartbeat_secs: u64,
    /// Lifetime of an entry that is not refreshed (crashed instance).
    pub ttl_secs: u64,
}

impl Default for PresenceConfig {
    fn default() -> Self {
        Self {
            heartbeat_secs: 15,
            ttl_secs: 45,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EventsConfig {
    /// After a `regrant`, time given to a client to obtain a new grant and subscribe
    /// again before it is removed from the room.
    pub regrant_timeout_secs: u64,
}

impl Default for EventsConfig {
    fn default() -> Self {
        Self {
            regrant_timeout_secs: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LocksConfig {
    /// Lifetime of a fields lock that its holder stops renewing (clients renew every
    /// third of it while editing).
    pub ttl_secs: u64,
    /// How often expired locks are noticed.
    pub sweep_secs: u64,
}

impl Default for LocksConfig {
    fn default() -> Self {
        Self {
            ttl_secs: 30,
            sweep_secs: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DraftsConfig {
    /// A shared draft is kept this long after its last change, so that a draft left by a
    /// closed tab can be taken over.
    pub ttl_secs: u64,
}

impl Default for DraftsConfig {
    fn default() -> Self {
        Self { ttl_secs: 900 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ShutdownConfig {
    /// Time given to clients to receive `bye` before the process exits.
    pub grace_secs: u64,
}

impl Default for ShutdownConfig {
    fn default() -> Self {
        Self { grace_secs: 5 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LogConfig {
    /// `text` or `json`.
    pub format: String,
    /// tracing `EnvFilter` directive; `RUST_LOG` wins when set.
    pub filter: String,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            format: "text".into(),
            filter: "info".into(),
        }
    }
}

impl Config {
    pub fn load(path: Option<&Path>) -> Result<Self, Box<figment::Error>> {
        let mut fig = Figment::from(Serialized::defaults(Config::default()));
        if let Some(p) = path {
            fig = fig.merge(Toml::file_exact(p));
        }
        let cfg: Config = fig.merge(Env::prefixed("GLPI_RT_").split("__")).extract()?;
        cfg.validate()
            .map_err(|e| Box::new(figment::Error::from(e)))?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.security.allowed_origins.is_empty() {
            return Err("security.allowed_origins must list at least one origin".into());
        }
        if self.security.cookie_name.is_empty() {
            return Err("security.cookie_name must not be empty".into());
        }
        let l = &self.limits;
        if l.messages_per_second == 0
            || l.user_messages_per_second == 0
            || l.burst == 0
            || l.user_burst == 0
        {
            return Err("rate limits must be > 0".into());
        }
        if l.ping_interval_secs == 0 || l.idle_timeout_secs <= l.ping_interval_secs {
            return Err(
                "limits.idle_timeout_secs must be greater than limits.ping_interval_secs".into(),
            );
        }
        let p = &self.presence;
        if p.heartbeat_secs == 0 || p.ttl_secs < 2 * p.heartbeat_secs {
            return Err("presence.ttl_secs must be at least twice presence.heartbeat_secs".into());
        }
        if self.locks.ttl_secs < 3 || self.locks.sweep_secs == 0 {
            return Err("locks.ttl_secs must be at least 3 and locks.sweep_secs > 0".into());
        }
        if self.events.regrant_timeout_secs == 0 {
            return Err("events.regrant_timeout_secs must be > 0".into());
        }
        if l.outbound_queue == 0 || l.max_connections == 0 || l.max_connections_per_user == 0 {
            return Err("queue and connection limits must be > 0".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_need_an_origin() {
        assert!(Config::default().validate().is_err());
        let mut c = Config::default();
        c.security.allowed_origins = vec!["https://glpi.example".into()];
        assert!(c.validate().is_ok());
    }

    #[test]
    fn toml_with_octal_mode() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("c.toml");
        std::fs::write(
            &p,
            r#"
            [listen]
            type = "unix"
            path = "/tmp/x.sock"
            mode = 0o600
            [security]
            allowed_origins = ["https://glpi.example"]
            "#,
        )
        .unwrap();
        let c = Config::load(Some(&p)).unwrap();
        match c.listen {
            Listen::Unix { mode, .. } => assert_eq!(mode, 0o600),
            _ => panic!("expected unix"),
        }
        assert_eq!(c.valkey.db, 6);
    }

    #[test]
    fn idle_must_exceed_ping() {
        let mut c = Config::default();
        c.security.allowed_origins = vec!["https://g".into()];
        c.limits.idle_timeout_secs = c.limits.ping_interval_secs;
        assert!(c.validate().is_err());
    }
}
