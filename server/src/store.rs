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

impl Store {
    pub async fn connect(cfg: &ValkeyConfig) -> Result<Self, Error> {
        let pool = Builder::from_config(fred_config(cfg)?)
            .with_connection_config(|c| {
                c.connection_timeout = std::time::Duration::from_secs(2);
            })
            .set_policy(ReconnectPolicy::new_exponential(0, 100, 5_000, 2))
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

    /// Raw access for modules with their own keys (locks).
    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    pub async fn ping(&self) -> Result<(), Error> {
        let _: String = self.pool.ping(None).await?;
        Ok(())
    }

    pub async fn session(&self, hash: &str) -> Result<Option<Session>, Error> {
        let h: HashMap<String, String> = self.pool.hgetall(self.session_key(hash)).await?;
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
        let h: HashMap<String, String> = self.pool.hgetall(self.grant_key(hash, room)).await?;
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
        let client = self.pool.next();
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
            let client = self.pool.next();
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
        let client = self.pool.next();
        let pipe = client.pipeline();
        let _: () = pipe.hset(&key, (conn, entry)).await?;
        let _: () = pipe.hexpire(&key, ttl_secs, None, conn).await?;
        let _: Vec<Value> = pipe.all().await?;
        Ok(())
    }

    pub async fn presence_del(&self, room: &Room, conn: &str) -> Result<(), Error> {
        let _: i64 = self.pool.hdel(self.presence_key(room), conn).await?;
        Ok(())
    }

    /// Raw entries (connection id → JSON); expired fields are already gone.
    pub async fn presence_list(&self, room: &Room) -> Result<HashMap<String, String>, Error> {
        self.pool.hgetall(self.presence_key(room)).await
    }

    /// Refreshes the TTL of this instance's fields, one pipeline for all rooms.
    pub async fn presence_touch(
        &self,
        rooms: &[(Room, Vec<String>)],
        ttl_secs: i64,
    ) -> Result<(), Error> {
        for chunk in rooms.chunks(500) {
            let client = self.pool.next();
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
        let _: i64 = self.pool.next().publish(channel, message).await?;
        Ok(())
    }
}
