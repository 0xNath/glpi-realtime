//! Who is looking at which item, across every server instance.
//!
//! - Valkey hash `rt:p:{room}`: one field per connection (`conn id` → JSON entry) with a
//!   field TTL. Live instances refresh their fields every `heartbeat`; the fields of a
//!   crashed instance expire on their own.
//! - Channel `rt:pc`: "room X changed". Every instance with local members in X re-reads the
//!   hash and pushes the new list to them.
//! - Clients always receive the full list of users (one entry per user, whatever the number
//!   of tabs), only when it changes. A joining connection always gets it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::Message;
use fred::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::avatar::Avatar;
use crate::config::Config;
use crate::protocol::{self, ByeReason, Room, ServerMsg};
use crate::registry::Registry;
use crate::store::{Store, fred_config};

/// Stored in Valkey, one per connection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub uid: u64,
    pub name: String,
    /// Unix seconds.
    pub since: u64,
    /// The tab is visible, focused and recently used.
    #[serde(default = "yes")]
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<Avatar>,
    /// Answer being written in the timeline (`followup`, `solution`...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composing: Option<String>,
}

/// Kinds of answers a client may announce.
pub const COMPOSE_KINDS: [&str; 5] = ["followup", "task", "solution", "validation", "document"];

fn yes() -> bool {
    true
}

/// Sent to clients, one per user.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PresenceUser {
    pub id: u64,
    pub name: String,
    pub since: u64,
    /// Active on at least one of their tabs.
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<Avatar>,
    /// What they are writing in the timeline, on any of their tabs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composing: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Changed {
    room: String,
    from: String,
}

struct LocalRoom {
    members: HashMap<Uuid, mpsc::Sender<Message>>,
    /// Connections that only look at the list (search results): they receive the list but
    /// are not in it.
    watchers: HashMap<Uuid, mpsc::Sender<Message>>,
    last_sent: Option<Vec<PresenceUser>>,
    /// Serializes refreshes of this room so that an older list never overwrites a newer one.
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
}

impl LocalRoom {
    fn new() -> Self {
        Self {
            members: HashMap::new(),
            watchers: HashMap::new(),
            last_sent: None,
            refresh_lock: Arc::default(),
        }
    }
}

pub struct Presence {
    store: Store,
    registry: Arc<Registry>,
    instance: String,
    ttl_secs: i64,
    rooms: Mutex<HashMap<Room, LocalRoom>>,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One entry per user: earliest arrival, ordered by arrival then id.
pub fn aggregate(entries: impl IntoIterator<Item = Entry>) -> Vec<PresenceUser> {
    let mut by_uid: HashMap<u64, PresenceUser> = HashMap::new();
    for e in entries {
        by_uid
            .entry(e.uid)
            .and_modify(|u| {
                u.since = u.since.min(e.since);
                u.active |= e.active;
                if u.composing.is_none() {
                    u.composing.clone_from(&e.composing);
                }
            })
            .or_insert(PresenceUser {
                id: e.uid,
                name: e.name,
                since: e.since,
                active: e.active,
                avatar: e.avatar,
                composing: e.composing,
            });
    }
    let mut users: Vec<_> = by_uid.into_values().collect();
    users.sort_by_key(|u| (u.since, u.id));
    users
}

impl Presence {
    pub fn new(store: Store, registry: Arc<Registry>, ttl_secs: u64) -> Arc<Self> {
        Arc::new(Self {
            store,
            registry,
            instance: Uuid::new_v4().to_string(),
            ttl_secs: ttl_secs.max(1) as i64,
            rooms: Mutex::new(HashMap::new()),
        })
    }

    pub async fn join(&self, room: &Room, conn: Uuid, entry: Entry, tx: mpsc::Sender<Message>) {
        {
            let mut rooms = self.rooms.lock().expect("presence poisoned");
            rooms
                .entry(room.clone())
                .or_insert_with(LocalRoom::new)
                .members
                .insert(conn, tx);
        }
        let json = serde_json::to_string(&entry).expect("entry serializes");
        if let Err(e) = self
            .store
            .presence_set(room, &conn.to_string(), &json, self.ttl_secs)
            .await
        {
            warn!(error = %e, %room, "presence: cannot record join");
        }
        self.announce(room).await;
        self.refresh(room, Some(conn)).await;
    }

    /// Replaces the entry of a connection already in the room (activity change).
    pub async fn update(&self, room: &Room, conn: Uuid, entry: Entry) {
        if !self.has_room(room) {
            return;
        }
        let json = serde_json::to_string(&entry).expect("entry serializes");
        if let Err(e) = self
            .store
            .presence_set(room, &conn.to_string(), &json, self.ttl_secs)
            .await
        {
            return warn!(error = %e, %room, "presence: cannot record update");
        }
        self.announce(room).await;
        self.refresh(room, None).await;
    }

    pub async fn leave(&self, room: &Room, conn: Uuid) {
        let still_local = {
            let mut rooms = self.rooms.lock().expect("presence poisoned");
            match rooms.get_mut(room) {
                Some(r) => {
                    r.members.remove(&conn);
                    if r.members.is_empty() && r.watchers.is_empty() {
                        rooms.remove(room);
                        false
                    } else {
                        true
                    }
                }
                None => false,
            }
        };
        if let Err(e) = self.store.presence_del(room, &conn.to_string()).await {
            warn!(error = %e, %room, "presence: cannot record leave");
        }
        self.announce(room).await;
        if still_local {
            self.refresh(room, None).await;
        }
    }

    /// Follows a room's list without being in it (list pages). The current list is sent.
    pub async fn watch(&self, room: &Room, conn: Uuid, tx: mpsc::Sender<Message>) {
        self.rooms
            .lock()
            .expect("presence poisoned")
            .entry(room.clone())
            .or_insert_with(LocalRoom::new)
            .watchers
            .insert(conn, tx);
        self.refresh(room, Some(conn)).await;
    }

    pub fn unwatch(&self, room: &Room, conn: Uuid) {
        let mut rooms = self.rooms.lock().expect("presence poisoned");
        if let Some(r) = rooms.get_mut(room) {
            r.watchers.remove(&conn);
            if r.members.is_empty() && r.watchers.is_empty() {
                rooms.remove(room);
            }
        }
    }

    async fn announce(&self, room: &Room) {
        let msg = serde_json::to_string(&Changed {
            room: room.to_string(),
            from: self.instance.clone(),
        })
        .expect("serializes");
        if let Err(e) = self
            .store
            .publish(&self.store.presence_channel(), msg)
            .await
        {
            warn!(error = %e, "presence: cannot publish change");
        }
    }

    /// Re-reads the room and pushes the list to local members if it changed
    /// (and to `force` in any case).
    pub async fn refresh(&self, room: &Room, force: Option<Uuid>) {
        let lock = {
            let rooms = self.rooms.lock().expect("presence poisoned");
            match rooms.get(room) {
                Some(r) => Arc::clone(&r.refresh_lock),
                None => return,
            }
        };
        let _guard = lock.lock().await;

        let raw = match self.store.presence_list(room).await {
            Ok(raw) => raw,
            Err(e) => return warn!(error = %e, %room, "presence: cannot read room"),
        };
        let users = aggregate(
            raw.values()
                .filter_map(|v| serde_json::from_str::<Entry>(v).ok()),
        );

        let targets: Vec<(Uuid, mpsc::Sender<Message>)> = {
            let mut rooms = self.rooms.lock().expect("presence poisoned");
            let Some(r) = rooms.get_mut(room) else { return };
            let changed = r.last_sent.as_ref() != Some(&users);
            if changed {
                r.last_sent = Some(users.clone());
            }
            r.members
                .iter()
                .chain(r.watchers.iter())
                .filter(|(id, _)| changed || Some(**id) == force)
                .map(|(id, tx)| (*id, tx.clone()))
                .collect()
        };
        if targets.is_empty() {
            return;
        }
        let text = protocol::encode(
            &ServerMsg::Presence {
                room: room.to_string(),
                users,
            },
            None,
        );
        for (id, tx) in targets {
            match tx.try_send(Message::Text(text.clone().into())) {
                Ok(()) => metrics::counter!("rt_messages_out_total").increment(1),
                Err(mpsc::error::TrySendError::Full(_)) => {
                    self.registry.close_conn(id, ByeReason::Slow);
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {}
            }
        }
    }

    fn local_rooms(&self) -> Vec<(Room, Vec<String>)> {
        let rooms = self.rooms.lock().expect("presence poisoned");
        rooms
            .iter()
            .map(|(room, r)| {
                (
                    room.clone(),
                    r.members.keys().map(Uuid::to_string).collect(),
                )
            })
            .collect()
    }

    fn has_room(&self, room: &Room) -> bool {
        self.rooms
            .lock()
            .expect("presence poisoned")
            .contains_key(room)
    }

    /// Keeps this instance's fields alive and notices entries that expired elsewhere.
    pub async fn heartbeat(self: Arc<Self>, every: Duration, mut stop: watch::Receiver<bool>) {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = stop.changed() => return,
            }
            let rooms = self.local_rooms();
            if rooms.is_empty() {
                continue;
            }
            if let Err(e) = self.store.presence_touch(&rooms, self.ttl_secs).await {
                warn!(error = %e, "presence: heartbeat failed");
            }
            for (room, _) in &rooms {
                self.refresh(room, None).await;
            }
        }
    }

    /// Reacts to changes announced by other instances.
    pub async fn listen(self: Arc<Self>, cfg: Arc<Config>, mut stop: watch::Receiver<bool>) {
        let sub = match fred_config(&cfg.valkey)
            .and_then(|c| Builder::from_config(c).build_subscriber_client())
        {
            Ok(s) => s,
            Err(e) => return warn!(error = %e, "presence: subscriber disabled"),
        };
        if let Err(e) = sub.init().await {
            return warn!(error = %e, "presence: subscriber disabled");
        }
        let _resub = sub.manage_subscriptions();
        let mut rx = sub.message_rx();
        if let Err(e) = sub.subscribe(self.store.presence_channel()).await {
            return warn!(error = %e, "presence: subscriber disabled");
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
                    if self.has_room(&room) {
                        debug!(%room, "presence: remote change");
                        self.refresh(&room, None).await;
                    }
                }
            }
        }
        let _ = sub.quit().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(uid: u64, name: &str, since: u64) -> Entry {
        Entry {
            uid,
            name: name.into(),
            since,
            active: false,
            avatar: None,
            composing: None,
        }
    }

    #[test]
    fn user_is_active_if_any_tab_is() {
        let mut tab2 = e(1, "alice", 20);
        tab2.active = true;
        let users = aggregate([e(1, "alice", 10), tab2, e(2, "bob", 5)]);
        assert_eq!(
            users.iter().map(|u| (u.id, u.active)).collect::<Vec<_>>(),
            [(2, false), (1, true)]
        );
    }

    #[test]
    fn entries_without_activity_are_active() {
        let old: Entry = serde_json::from_str(r#"{"uid":1,"name":"a","since":1}"#).unwrap();
        assert!(old.active);
    }

    #[test]
    fn one_entry_per_user_ordered_by_arrival() {
        let users = aggregate([
            e(2, "bob", 20),
            e(1, "alice", 30),
            e(2, "bob", 10),
            e(3, "carol", 10),
        ]);
        assert_eq!(
            users,
            vec![
                PresenceUser {
                    id: 2,
                    name: "bob".into(),
                    since: 10,
                    active: false,
                    avatar: None,
                    composing: None,
                },
                PresenceUser {
                    id: 3,
                    name: "carol".into(),
                    since: 10,
                    active: false,
                    avatar: None,
                    composing: None,
                },
                PresenceUser {
                    id: 1,
                    name: "alice".into(),
                    since: 30,
                    active: false,
                    avatar: None,
                    composing: None,
                },
            ]
        );
        assert!(aggregate([]).is_empty());
    }
}
