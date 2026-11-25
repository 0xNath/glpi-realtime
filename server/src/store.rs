//! Read-only view of what the GLPI plugin writes into Valkey.
//!
//! Keys (prefix configurable, default `rt:`):
//! - `rt:s:{token_hash}` hash `uid`, `name`, `avatar`, `groups` — session, TTL slid by
//!   every GLPI request.
//! - `rt:g:{token_hash}:{Itemtype}:{id}` hash of `0`/`1` flags — rights computed by GLPI.
//! - `rt:ev` channel — item events and notifications (see `events`).

use std::collections::HashMap;

use fred::prelude::*;

use crate::avatar::{Anon, Avatar};
use crate::config::ValkeyConfig;
use crate::protocol::Room;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub uid: u64,
    pub name: String,
    pub avatar: Option<Avatar>,
    /// GLPI groups of the user (private tasks of "my groups").
    pub groups: Vec<u64>,
    /// How this user appears to self-service users when agents are anonymized.
    pub anon: Option<Anon>,
    /// This session must see support agents anonymized.
    pub anon_view: bool,
}

/// Rights of one session on one item, as computed by GLPI when the item was displayed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grant {
    flags: HashMap<String, bool>,
}

impl Grant {
    pub fn has(&self, flag: &str) -> bool {
        self.flags.get(flag).copied().unwrap_or(false)
    }

    pub fn from_flags(flags: impl IntoIterator<Item = (String, bool)>) -> Self {
        Self {
            flags: flags.into_iter().collect(),
        }
    }
}

#[derive(Clone)]
pub struct Store {
    pool: Pool,
    prefix: String,
}

pub fn fred_config(cfg: &ValkeyConfig) -> Result<Config, Error> {
    let mut c = if cfg.url.starts_with("unix://") {
        Config::from_url_unix(&cfg.url)?
    } else {
        Config::from_url(&cfg.url)?
    };
    c.database = Some(cfg.db);
    if let Some(p) = &cfg.password {
        c.password = Some(p.clone());
        c.username.clone_from(&cfg.username);
    }
    Ok(c)
}

/// How long a command may wait for Valkey (a reconnection included) before failing.
/// Every command is a single key operation: Valkey answers them in microseconds.
pub const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Reconnection after a loss of Valkey: at once, then backing off up to 5 s, forever.
fn reconnect_policy() -> ReconnectPolicy {
    ReconnectPolicy::new_exponential(0, 100, 5_000, 2)
}

/// A pub/sub client that does not give up. Its first connection is retried until Valkey
/// answers (the server may start before it); after a loss it reconnects and subscribes
/// again (`manage_subscriptions`). None when the server stops meanwhile.
pub async fn subscriber(
    cfg: &ValkeyConfig,
    what: &'static str,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> Option<fred::clients::SubscriberClient> {
    let mut delay = std::time::Duration::from_millis(250);
    loop {
        let attempt = fred_config(cfg).and_then(|c| {
            Builder::from_config(c)
                .with_connection_config(|c| {
                    c.connection_timeout = std::time::Duration::from_secs(2);
                })
                .set_policy(reconnect_policy())
                .build_subscriber_client()
        });
        let error = match attempt {
            Ok(sub) => match sub.init().await {
                Ok(_) => {
                    let _resubscribe = sub.manage_subscriptions();
                    tracing::info!(what, "subscriber connected");
                    return Some(sub);
                }
                Err(e) => {
                    let _ = sub.quit().await;
                    e
                }
            },
            Err(e) => e,
        };
        tracing::warn!(what, error = %error, retry_in_ms = delay.as_millis() as u64, "waiting for Valkey");
        tokio::select! {
            _ = stop.changed() => return None,
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(std::time::Duration::from_secs(5));
    }
}

impl Store {
    pub async fn connect(cfg: &ValkeyConfig) -> Result<Self, Error> {
        let pool = Builder::from_config(fred_config(cfg)?)
            .with_connection_config(|c| {
                c.connection_timeout = std::time::Duration::from_secs(2);
            })
            // Without it a command waits for Valkey's return (fred's default): the
            // browser's request goes unanswered and its connection handles nothing else.
            .with_performance_config(|p| p.default_command_timeout = COMMAND_TIMEOUT)
            .set_policy(reconnect_policy())
            .build_pool(cfg.pool_size.max(1))?;
        pool.init().await?;
        Ok(Self {
            pool,
            prefix: cfg.key_prefix.clone(),
        })
    }

    pub fn session_key(&self, hash: &str) -> String {
        format!("{}s:{hash}", self.prefix)
    }

    pub fn grant_key(&self, hash: &str, room: &Room) -> String {
        format!("{}g:{hash}:{room}", self.prefix)
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// A connected client of the pool, or an error at once when Valkey is gone: a
    /// command would otherwise wait for its return (fred queues it until it reconnects),
    /// and the browser's connection would handle nothing else meanwhile.
    pub fn client(&self) -> Result<&Client, Error> {
        let c = self.pool.next_connected();
        if c.is_connected() {
            Ok(c)
        } else {
            Err(Error::new(ErrorKind::IO, "Valkey is unavailable"))
        }
    }

    /// Runs `f` on a connected client (see [`Store::client`]), for modules with their
    /// own keys (locks, drafts, status).
    pub async fn with<T, Fut>(&self, f: impl FnOnce(Client) -> Fut) -> Result<T, Error>
    where
        Fut: std::future::Future<Output = Result<T, Error>>,
    {
        f(self.client()?.clone()).await
    }

    pub async fn ping(&self) -> Result<(), Error> {
        let _: String = self.client()?.ping(None).await?;
        Ok(())
    }

    pub async fn session(&self, hash: &str) -> Result<Option<Session>, Error> {
        let h: HashMap<String, String> = self.client()?.hgetall(self.session_key(hash)).await?;
        let uid = h
            .get("uid")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|&u| u > 0);
        Ok(uid.map(|uid| Session {
            uid,
            name: h.get("name").cloned().unwrap_or_default(),
            avatar: h.get("avatar").and_then(|a| Avatar::from_json(a)),
            groups: h
                .get("groups")
                .and_then(|g| serde_json::from_str::<Vec<u64>>(g).ok())
                .unwrap_or_default(),
            anon: h.get("anon").and_then(|a| Anon::from_json(a)),
            anon_view: h.get("anon_view").is_some_and(|v| v == "1"),
        }))
    }

    pub async fn grant(&self, hash: &str, room: &Room) -> Result<Option<Grant>, Error> {
        let h: HashMap<String, String> = self.client()?.hgetall(self.grant_key(hash, room)).await?;
        if h.is_empty() {
            return Ok(None);
        }
        Ok(Some(Grant::from_flags(
            h.into_iter().map(|(k, v)| (k, v == "1")),
        )))
    }

    /// For each room, whether this session has a grant with `read=1`. One pipeline.
    pub async fn readable(&self, hash: &str, rooms: &[Room]) -> Result<Vec<bool>, Error> {
        if rooms.is_empty() {
            return Ok(vec![]);
        }
        let client = self.client()?;
        let pipe = client.pipeline();
        for r in rooms {
            let _: () = pipe.hget(self.grant_key(hash, r), "read").await?;
        }
        let res: Vec<Option<String>> = pipe.all().await?;
        Ok(res.into_iter().map(|v| v.as_deref() == Some("1")).collect())
    }

    /// For each session hash, whether its key still exists. Pipelined in chunks.
    pub async fn sessions_alive(&self, hashes: &[String]) -> Result<Vec<bool>, Error> {
        let mut out = Vec::with_capacity(hashes.len());
        for chunk in hashes.chunks(1000) {
            let client = self.client()?;
            let pipe = client.pipeline();
            for h in chunk {
                let _: () = pipe.exists(self.session_key(h)).await?;
            }
            let res: Vec<i64> = pipe.all().await?;
            out.extend(res.into_iter().map(|n| n > 0));
        }
        Ok(out)
    }

    // --- Presence: `rt:p:{room}` hash, one field per connection, field TTL ---------------

    pub fn presence_key(&self, room: &Room) -> String {
        format!("{}p:{room}", self.prefix)
    }

    /// Pub/sub channel on which the plugin publishes item events and notifications.
    pub fn events_channel(&self) -> String {
        format!("{}ev", self.prefix)
    }

    /// Pub/sub channel announcing presence changes to every instance.
    pub fn presence_channel(&self) -> String {
        format!("{}pc", self.prefix)
    }

    pub async fn presence_set(
        &self,
        room: &Room,
        conn: &str,
        entry: &str,
        ttl_secs: i64,
    ) -> Result<(), Error> {
        let key = self.presence_key(room);
        let client = self.client()?;
        let pipe = client.pipeline();
        let _: () = pipe.hset(&key, (conn, entry)).await?;
        let _: () = pipe.hexpire(&key, ttl_secs, None, conn).await?;
        let _: Vec<Value> = pipe.all().await?;
        Ok(())
    }

    pub async fn presence_del(&self, room: &Room, conn: &str) -> Result<(), Error> {
        let _: i64 = self.client()?.hdel(self.presence_key(room), conn).await?;
        Ok(())
    }

    /// Raw entries (connection id → JSON); expired fields are already gone.
    pub async fn presence_list(&self, room: &Room) -> Result<HashMap<String, String>, Error> {
        self.client()?.hgetall(self.presence_key(room)).await
    }

    /// Refreshes the TTL of this instance's fields, one pipeline for all rooms.
    pub async fn presence_touch(
        &self,
        rooms: &[(Room, Vec<String>)],
        ttl_secs: i64,
    ) -> Result<(), Error> {
        for chunk in rooms.chunks(500) {
            let client = self.client()?;
            let pipe = client.pipeline();
            for (room, conns) in chunk {
                if !conns.is_empty() {
                    let _: () = pipe
                        .hexpire(self.presence_key(room), ttl_secs, None, conns.clone())
                        .await?;
                }
            }
            let _: Vec<Value> = pipe.all().await?;
        }
        Ok(())
    }

    pub async fn publish(&self, channel: &str, message: String) -> Result<(), Error> {
        let _: i64 = self.client()?.publish(channel, message).await?;
        Ok(())
    }
}
