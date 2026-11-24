//! One editor at a time, per item and scope.
//!
//! - `fields` (step 4): the item's fields panel. Needs the grant flag `update`.
//! - `solution`: writing a solution. Needs `solve`. The plugin also refuses, in GLPI, a
//!   second solution while one is pending or accepted.
//!
//! - Valkey key `rt:l:{room}` (fields) or `rt:l:{room}:{scope}`: JSON [`Holder`] with a short
//!   TTL, renewed by the holder's client while it edits. Acquired and released atomically
//!   (Lua): a connection only ever renews or releases its own lock.
//! - Taking it from someone else (`force`) is allowed only when the holder's tab is
//!   inactive (presence) or gone.
//! - Channel `rt:lc`: "the lock of room X changed". Instances with local members re-read
//!   it and push `lock{room, scope, holder}` to them. Expiry is noticed by a short sweep.
//!
//! Locks are advisory, like presence: GLPI still accepts any authorized update.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fred::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::avatar::{Anon, Avatar};
use crate::config::Config;
use crate::events::{Delivery, Hub};
use crate::presence::{Entry, now};
use crate::protocol::{self, Room, ServerMsg};
use crate::store::{Store, fred_config};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    #[default]
    Fields,
    Solution,
}

impl Scope {
    pub const ALL: [Scope; 2] = [Scope::Fields, Scope::Solution];

    /// Grant flag GLPI must have set for the session.
    pub fn right(self) -> &'static str {
        match self {
            Scope::Fields => "update",
            Scope::Solution => "solve",
        }
    }
}

/// Who edits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Holder {
    /// Connection id (clients compare it with the `conn` of their `hello`).
    pub conn: String,
    pub id: u64,
    pub name: String,
    /// Unix seconds.
    pub since: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<Avatar>,
    /// Why the fields are held without being edited: an answer that changes the status
    /// (`solution`, `pending`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anon: Option<Anon>,
}

/// Reasons a fields lock may be taken for, besides editing the fields.
pub const REASONS: [&str; 2] = ["solution", "pending"];

/// Takes the lock, renews it (same connection, updating its reason) or returns the
/// current holder. ARGV: conn, holder JSON, force ("1"), ttl ms.
/// Returns "1" or "0" (changed for the others or not) followed by the stored JSON.
const ACQUIRE: &str = r#"
local cur = redis.call('GET', KEYS[1])
if cur and ARGV[3] ~= '1' then
  local h = cjson.decode(cur)
  if h.conn ~= ARGV[1] then return '0' .. cur end
  local n = cjson.decode(ARGV[2])
  if h.reason ~= n.reason then
    h.reason = n.reason
    local v = cjson.encode(h)
    redis.call('SET', KEYS[1], v, 'PX', ARGV[4])
    return '1' .. v
  end
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
  return '0' .. cur
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[4])
return '1' .. ARGV[2]
"#;

/// Releases the lock if this connection holds it. ARGV: conn.
const RELEASE: &str = r#"
local cur = redis.call('GET', KEYS[1])
if cur and cjson.decode(cur).conn == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
"#;

#[derive(Serialize, Deserialize)]
struct Changed {
    room: String,
    #[serde(default)]
    scope: Scope,
    from: String,
}

pub struct Locks {
    store: Store,
    hub: Arc<Hub>,
    instance: String,
    ttl_ms: u64,
    /// Last state pushed per local room and scope, to push only changes.
    known: Mutex<HashMap<(Room, Scope), Option<Holder>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LockError {
    /// Valkey unavailable.
    Unavailable,
}

impl Locks {
    pub fn new(store: Store, hub: Arc<Hub>, ttl_secs: u64) -> Arc<Self> {
        Arc::new(Self {
            store,
            hub,
            instance: Uuid::new_v4().to_string(),
            ttl_ms: ttl_secs.max(1) * 1000,
            known: Mutex::default(),
        })
    }

    pub fn ttl_secs(&self) -> u64 {
        self.ttl_ms / 1000
    }

    fn key(&self, room: &Room, scope: Scope) -> String {
        match scope {
            Scope::Fields => format!("{}l:{room}", self.store.prefix()),
            Scope::Solution => format!("{}l:{room}:solution", self.store.prefix()),
        }
    }

    fn channel(&self) -> String {
        format!("{}lc", self.store.prefix())
    }

    pub async fn holder(&self, room: &Room, scope: Scope) -> Result<Option<Holder>, LockError> {
        let raw: Option<String> = self
            .store
            .pool()
            .get(self.key(room, scope))
            .await
            .map_err(|_| LockError::Unavailable)?;
        Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
    }

    /// Takes or renews the lock. With `force`, takes it from a holder whose tab is
    /// inactive or gone. Returns the holder afterwards (us, or whoever keeps it).
    pub async fn acquire(
        &self,
        room: &Room,
        scope: Scope,
        me: Holder,
        force: bool,
    ) -> Result<Option<Holder>, LockError> {
        let force = force && self.can_take_over(room, scope, &me.conn).await;
        let me_conn = me.conn.clone();
        let json = serde_json::to_string(&me).expect("holder serializes");
        let cur: String = self
            .store
            .pool()
            .next()
            .eval(
                ACQUIRE,
                self.key(room, scope),
                vec![
                    me.conn.clone(),
                    json.clone(),
                    if force { "1" } else { "0" }.to_string(),
                    self.ttl_ms.to_string(),
                ],
            )
            .await
            .map_err(|e| {
                warn!(error = %e, %room, "locks: acquire failed");
                LockError::Unavailable
            })?;
        // Newly taken, or its reason changed: everyone must know.
        let (changed, stored) = cur.split_at(cur.len().min(1));
        let scope_label = match scope {
            Scope::Fields => "fields",
            Scope::Solution => "solution",
        };
        let ours = serde_json::from_str::<Holder>(stored).is_ok_and(|h| h.conn == me_conn);
        let result = match (changed == "1", ours) {
            (true, _) => "taken",
            (false, true) => "renewed",
            (false, false) => "busy",
        };
        metrics::counter!("rt_locks_total", "scope" => scope_label, "result" => result)
            .increment(1);
        if changed == "1" {
            self.changed(room, scope).await;
        }
        Ok(serde_json::from_str(stored).ok())
    }

    /// Releases the lock if `conn` holds it (unlock, leaving the room, disconnection).
    pub async fn release(&self, room: &Room, scope: Scope, conn: &str) {
        let res: Result<i64, _> = self
            .store
            .pool()
            .next()
            .eval(RELEASE, self.key(room, scope), vec![conn.to_string()])
            .await;
        match res {
            Ok(1) => self.changed(room, scope).await,
            Ok(_) => {}
            Err(e) => warn!(error = %e, %room, "locks: release failed"),
        }
    }

    /// Releases every scope held by `conn` on the room.
    pub async fn release_all(&self, room: &Room, conn: &str) {
        for scope in Scope::ALL {
            self.release(room, scope, conn).await;
        }
    }

    /// The holder's tab is inactive (presence says so) or its connection is gone.
    async fn can_take_over(&self, room: &Room, scope: Scope, me: &str) -> bool {
        let Ok(Some(h)) = self.holder(room, scope).await else {
            return true;
        };
        if h.conn == me {
            return true;
        }
        match self.store.presence_list(room).await {
            Ok(entries) => match entries.get(&h.conn) {
                Some(raw) => serde_json::from_str::<Entry>(raw).is_ok_and(|e| !e.active),
                None => true, // left the item
            },
            Err(_) => false,
        }
    }

    /// Re-reads the lock locally, then tells the other instances.
    async fn changed(&self, room: &Room, scope: Scope) {
        self.refresh(room, scope).await;
        let msg = serde_json::to_string(&Changed {
            room: room.to_string(),
            scope,
            from: self.instance.clone(),
        })
        .expect("serializes");
        if let Err(e) = self.store.publish(&self.channel(), msg).await {
            warn!(error = %e, "locks: cannot publish change");
        }
    }

    /// Pushes the current holder to local members if it changed.
    pub async fn refresh(&self, room: &Room, scope: Scope) {
        let Ok(holder) = self.holder(room, scope).await else {
            return;
        };
        {
            let mut known = self.known.lock().expect("locks poisoned");
            let k = (room.clone(), scope);
            if known.get(&k) == Some(&holder) {
                return;
            }
            known.insert(k, holder.clone());
        }
        let text = protocol::encode(
            &ServerMsg::Lock {
                room: room.to_string(),
                scope,
                holder,
            },
            None,
        );
        self.hub.broadcast(room, Delivery::Text(text));
    }

    /// The state of one scope, for a reply or a connection that just joined.
    pub async fn state(&self, room: &Room, scope: Scope) -> Option<ServerMsg> {
        let holder = self.holder(room, scope).await.ok()?;
        Some(ServerMsg::Lock {
            room: room.to_string(),
            scope,
            holder,
        })
    }

    /// Forgets rooms without local members.
    pub fn forget(&self, room: &Room) {
        self.known
            .lock()
            .expect("locks poisoned")
            .retain(|(r, _), _| r != room);
    }

    /// Notices locks that expired (holder crashed or stopped renewing).
    pub async fn sweep(self: Arc<Self>, every: Duration, mut stop: watch::Receiver<bool>) {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = stop.changed() => return,
            }
            let held: Vec<(Room, Scope)> = self
                .known
                .lock()
                .expect("locks poisoned")
                .iter()
                .filter(|(_, h)| h.is_some())
                .map(|(k, _)| k.clone())
                .collect();
            for (room, scope) in held {
                self.refresh(&room, scope).await;
            }
        }
    }

    /// Reacts to lock changes made through other instances.
    pub async fn listen(self: Arc<Self>, cfg: Arc<Config>, mut stop: watch::Receiver<bool>) {
        let sub = match fred_config(&cfg.valkey)
            .and_then(|c| Builder::from_config(c).build_subscriber_client())
        {
            Ok(s) => s,
            Err(e) => return warn!(error = %e, "locks: subscriber disabled"),
        };
        if let Err(e) = sub.init().await {
            return warn!(error = %e, "locks: subscriber disabled");
        }
        let _resub = sub.manage_subscriptions();
        let mut rx = sub.message_rx();
        if let Err(e) = sub.subscribe(self.channel()).await {
            return warn!(error = %e, "locks: subscriber disabled");
        }
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                m = rx.recv() => {
                    let Ok(m) = m else { continue };
                    let Ok(text) = m.value.convert::<String>() else { continue };
                    let Ok(c) = serde_json::from_str::<Changed>(&text) else { continue };
                    if c.from == self.instance {
                        continue;
                    }
                    let Some(room) = Room::parse(&c.room, &cfg.security.allowed_itemtypes) else { continue };
                    if self.hub.has_room(&room) {
                        debug!(%room, "locks: remote change");
                        self.refresh(&room, c.scope).await;
                    }
                }
            }
        }
        let _ = sub.quit().await;
    }
}

/// Holder description for a connection.
pub fn holder(
    conn: Uuid,
    uid: u64,
    name: &str,
    avatar: Option<Avatar>,
    anon: Option<Anon>,
) -> Holder {
    Holder {
        conn: conn.to_string(),
        id: uid,
        name: name.to_string(),
        since: now(),
        avatar,
        reason: None,
        anon,
    }
}
