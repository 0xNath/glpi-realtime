//! Configuration: defaults < TOML file < environment (`GLPI_RT_SECTION__KEY`).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use figment::Figment;
use figment::providers::{Env, Format, Toml};
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

/// Smallest outbound queue: two full batches of item events (one frame per event).
pub const MIN_OUTBOUND_QUEUE: usize = 2 * crate::events::MAX_EVENTS_PER_BATCH;

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
            // The web server's group differs between distributions: set it in config.toml.
            group: None,
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
    /// Valkey ACL user and password (`AUTH`), when Valkey requires them.
    pub username: Option<String>,
    pub password: Option<String>,
}

impl Default for ValkeyConfig {
    fn default() -> Self {
        Self {
            url: "unix:///run/valkey/valkey.sock".into(),
            db: 6,
            pool_size: 8,
            key_prefix: "rt:".into(),
            username: None,
            password: None,
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
    /// Item types a client may subscribe to (`Ticket:42`). Empty (the default): those GLPI
    /// enables (the plugin's `enabled_itemtypes`, through its grants); a list restricts them.
    pub allowed_itemtypes: Vec<String>,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            cookie_name: "glpi_rt".into(),
            allowed_origins: vec![],
            // Empty: whatever GLPI enables (the plugin's `enabled_itemtypes`).
            allowed_itemtypes: vec![],
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
    /// Items whose presence a list page may follow (`watch`).
    pub max_watched_rooms: usize,
    /// Pending connections the listening socket queues (bursts: nginx reconnecting every
    /// client after a restart). Capped by the kernel (`net.core.somaxconn`).
    pub listen_backlog: u32,
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
            max_watched_rooms: 200,
            listen_backlog: 4096,
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
        // No serialized defaults: every section has `#[serde(default)]`, and merging the
        // default unix listener into `listen = { type = "tcp", ... }` would add unix fields.
        let mut fig = Figment::new();
        if let Some(p) = path {
            fig = fig.merge(Toml::file_exact(p));
        }
        let cfg: Config = fig.merge(Env::prefixed("GLPI_RT_").split("__")).extract()?;
        cfg.validate()
            .map_err(|e| Box::new(figment::Error::from(e)))?;
        Ok(cfg)
    }

    /// Raises settings below what the server needs to work at all, and says which. A
    /// configuration that worked keeps starting after an upgrade.
    pub fn raise_minimums(&mut self) -> Vec<String> {
        let mut notes = vec![];
        let min = MIN_OUTBOUND_QUEUE;
        if self.limits.outbound_queue < min {
            notes.push(format!(
                "limits.outbound_queue = {} raised to {min}: one batch of item events from GLPI can hold {} frames, a smaller queue drops every member of the item",
                self.limits.outbound_queue,
                crate::events::MAX_EVENTS_PER_BATCH
            ));
            self.limits.outbound_queue = min;
        }
        notes
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

    /// A queue too small for one batch of events is raised, and said; others are kept.
    #[test]
    fn a_too_small_outbound_queue_is_raised() {
        let mut c = super::Config::default();
        c.limits.outbound_queue = 32;
        let notes = c.raise_minimums();
        assert_eq!(c.limits.outbound_queue, super::MIN_OUTBOUND_QUEUE);
        assert!(
            notes.len() == 1 && notes[0].contains("outbound_queue = 32 raised to 128"),
            "{notes:?}"
        );
        c.limits.outbound_queue = 300;
        assert!(c.raise_minimums().is_empty());
        assert_eq!(c.limits.outbound_queue, 300);
    }

    /// Each rule of `validate` refuses its own mistake, with a message naming the setting.
    #[test]
    fn validate_refuses_each_inconsistent_setting() {
        use super::Config;
        let base = || {
            let mut c = Config::default();
            c.security.allowed_origins = vec!["https://glpi.example.org".into()];
            c
        };
        assert_eq!(base().validate(), Ok(()));
        type Spoil = Box<dyn Fn(&mut Config)>;
        let cases: Vec<(&str, Spoil)> = vec![
            (
                "allowed_origins",
                Box::new(|c| c.security.allowed_origins.clear()),
            ),
            ("cookie_name", Box::new(|c| c.security.cookie_name.clear())),
            (
                "rate limits",
                Box::new(|c| c.limits.messages_per_second = 0),
            ),
            (
                "rate limits",
                Box::new(|c| c.limits.user_messages_per_second = 0),
            ),
            ("rate limits", Box::new(|c| c.limits.burst = 0)),
            ("rate limits", Box::new(|c| c.limits.user_burst = 0)),
            (
                "idle_timeout_secs",
                Box::new(|c| c.limits.ping_interval_secs = 0),
            ),
            (
                "idle_timeout_secs",
                Box::new(|c| c.limits.idle_timeout_secs = c.limits.ping_interval_secs),
            ),
            (
                "presence.ttl_secs",
                Box::new(|c| c.presence.heartbeat_secs = 0),
            ),
            (
                "presence.ttl_secs",
                Box::new(|c| c.presence.ttl_secs = 2 * c.presence.heartbeat_secs - 1),
            ),
            ("locks.ttl_secs", Box::new(|c| c.locks.ttl_secs = 2)),
            ("locks.ttl_secs", Box::new(|c| c.locks.sweep_secs = 0)),
            (
                "regrant_timeout_secs",
                Box::new(|c| c.events.regrant_timeout_secs = 0),
            ),
            (
                "connection limits",
                Box::new(|c| c.limits.outbound_queue = 0),
            ),
            (
                "connection limits",
                Box::new(|c| c.limits.max_connections = 0),
            ),
            (
                "connection limits",
                Box::new(|c| c.limits.max_connections_per_user = 0),
            ),
        ];
        for (i, (words, spoil)) in cases.iter().enumerate() {
            let mut c = base();
            spoil(&mut c);
            let err = c.validate().expect_err(&format!("case {i} refused"));
            assert!(err.contains(words), "case {i}: {err}");
        }
        // The limits themselves are accepted.
        let mut c = base();
        c.presence.ttl_secs = 2 * c.presence.heartbeat_secs;
        c.locks.ttl_secs = 3;
        c.limits.idle_timeout_secs = c.limits.ping_interval_secs + 1;
        assert_eq!(c.validate(), Ok(()));
    }

    /// Every section and setting of the server is in deploy/examples/config.toml.example
    /// (set, or commented out): users discover them there.
    #[test]
    fn the_example_lists_every_setting() {
        let example = include_str!("../../deploy/examples/config.toml.example");
        let mut keys: std::collections::HashMap<String, std::collections::HashSet<String>> =
            Default::default();
        let mut section = String::new();
        for line in example.lines() {
            let l = line.trim_start_matches('#').trim();
            if let Some(name) = l.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
                section = name.to_string();
            } else if let Some((key, _)) = l.split_once('=') {
                keys.entry(section.clone())
                    .or_default()
                    .insert(key.trim().to_string());
            }
        }
        let defaults = serde_json::to_value(Config::default()).unwrap();
        for (name, value) in defaults.as_object().unwrap() {
            let Some(fields) = value.as_object() else {
                continue;
            };
            if name == "listen" {
                continue; // a choice of forms (unix or tcp), each shown in the example
            }
            let found = keys
                .get(name)
                .unwrap_or_else(|| panic!("[{name}] is not in config.toml.example"));
            for field in fields.keys() {
                assert!(
                    found.contains(field),
                    "[{name}] {field} is not in config.toml.example"
                );
            }
        }
    }

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
    fn tcp_listener_from_toml() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("c.toml");
        std::fs::write(
            &p,
            "[listen]\ntype = \"tcp\"\naddr = \"127.0.0.1:8090\"\n[security]\nallowed_origins = [\"https://g\"]\n",
        )
        .unwrap();
        let c = Config::load(Some(&p)).unwrap();
        assert!(matches!(c.listen, Listen::Tcp { .. }));
        assert_eq!(
            c.limits.listen_backlog, 4096,
            "other sections keep their defaults"
        );
    }

    #[test]
    fn idle_must_exceed_ping() {
        let mut c = Config::default();
        c.security.allowed_origins = vec!["https://g".into()];
        c.limits.idle_timeout_secs = c.limits.ping_interval_secs;
        assert!(c.validate().is_err());
    }
}
