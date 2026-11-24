//! Live item events and user notifications, published by the GLPI plugin.
//!
//! The plugin publishes one JSON [`Batch`] per item and per GLPI request on the channel
//! `rt:ev`. Events carry no content: a kind (`followup.add`), the author, the sub-item
//! reference and, for item updates, the names of the changed fields. Clients reload from
//! GLPI, which applies its own rights.
//!
//! Each event says who may see it ([`Visibility`]): the server checks it against the
//! grant flags GLPI computed for each session, mirroring GLPI's `canViewItem()` rules.
//! When rights may have changed (actors, entity), the plugin deletes every grant on the
//! item and sets `regrant`: members stop receiving events until their grant is rewritten
//! by GLPI and they subscribe again.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use fred::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::config::Config;
use crate::protocol::{self, ByeReason, Room, ServerMsg};
use crate::registry::Registry;
use crate::store::{Grant, Store, fred_config};

pub const MAX_EVENTS_PER_BATCH: usize = 64;
pub const MAX_FIELDS: usize = 64;
pub const MAX_RECIPIENTS: usize = 1000;

/// Who did it (uid 0 for automatic actions: crons, mail collector).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Actor {
    #[serde(default)]
    pub id: u64,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ItemRef {
    #[serde(rename = "type")]
    pub itemtype: String,
    pub id: u64,
}

/// Rights family governing the visibility of a sub-item.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Right {
    Followup,
    Task,
}

/// Who may receive an event, besides anyone with `read` on the item when `right` is None.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Visibility {
    pub right: Option<Right>,
    pub private: bool,
    /// Users who always see the sub-item (author, assigned technician).
    pub uids: Vec<u64>,
    /// Technician groups of a private task (seen with `see_private_task_groups`).
    pub groups: Vec<u64>,
}

impl Visibility {
    /// GLPI's `ITILFollowup::canViewItem()` / `CommonITILTask::canViewItem()`, evaluated on
    /// the flags GLPI computed for the session.
    pub fn allows(&self, grant: &Grant, uid: u64, groups: &[u64]) -> bool {
        if self.uids.contains(&uid) {
            return true;
        }
        match self.right {
            None => true,
            Some(Right::Followup) => {
                grant.has("see_private_followup")
                    || (!self.private && grant.has("see_public_followup"))
            }
            Some(Right::Task) => {
                grant.has("see_private_task")
                    || (!self.private && grant.has("see_public_task"))
                    || (self.private
                        && grant.has("see_private_task_groups")
                        && self.groups.iter().any(|g| groups.contains(g)))
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Event {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<ItemRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
    #[serde(default, skip_serializing)]
    pub vis: Visibility,
}

/// A personal notification: the recipients' bells must refresh (from GLPI).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Notify {
    pub to: Vec<u64>,
    /// Event (`assigned`, `commented`...), or `inbox` for a read-state change.
    pub kind: String,
    /// Item concerned (`Ticket:5`, `ProjectTask:3`); the batch room when absent.
    #[serde(default)]
    pub item: Option<String>,
    /// Read state or preferences changed: refresh silently, the author's tabs included.
    #[serde(default)]
    pub sync: bool,
}

/// What the plugin publishes, once per item and per GLPI request. Personal
/// notifications of items nobody subscribes to come without a room.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Batch {
    #[serde(default)]
    pub room: Option<String>,
    #[serde(default)]
    pub by: Actor,
    /// Rights on the item may have changed: every grant on it was deleted.
    #[serde(default)]
    pub regrant: bool,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub notify: Vec<Notify>,
}

fn is_word(s: &str, max: usize, extra: &[u8]) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || extra.contains(&b))
}

/// `Itemtype:id`, any GLPI item type (notifications are not limited to subscribable rooms).
fn is_item_ref(s: &str) -> bool {
    s.split_once(':')
        .is_some_and(|(t, id)| is_word(t, 64, b"\\") && id.parse::<u64>().is_ok_and(|n| n > 0))
}

impl Batch {
    /// Parses and validates a batch; anything malformed is dropped as a whole.
    pub fn parse(text: &str, allowed_itemtypes: &[String]) -> Option<(Option<Room>, Batch)> {
        let mut b: Batch = serde_json::from_str(text).ok()?;
        let room = match &b.room {
            Some(r) => Some(Room::parse(r, allowed_itemtypes)?),
            // Item events and regrants need a room.
            None if b.events.is_empty() && !b.regrant => None,
            None => return None,
        };
        if b.events.len() > MAX_EVENTS_PER_BATCH || b.notify.len() > MAX_EVENTS_PER_BATCH {
            return None;
        }
        b.by.name = b.by.name.chars().take(255).collect();
        for e in &mut b.events {
            if !is_word(&e.kind, 32, b".") {
                return None;
            }
            if let Some(i) = &e.item
                && (!is_word(&i.itemtype, 64, b"\\") || i.id == 0)
            {
                return None;
            }
            e.fields.retain(|f| is_word(f, 64, b""));
            e.fields.truncate(MAX_FIELDS);
            e.vis.uids.truncate(MAX_RECIPIENTS);
            e.vis.groups.truncate(MAX_RECIPIENTS);
        }
        for n in &mut b.notify {
            if !is_word(&n.kind, 32, b".") || n.item.as_deref().is_some_and(|i| !is_item_ref(i)) {
                return None;
            }
            n.to.retain(|&u| u > 0);
            n.to.truncate(MAX_RECIPIENTS);
        }
        Some((room, b))
    }
}

/// What the hub hands to a connection task.
#[derive(Debug)]
pub enum Delivery {
    /// Item batch: the connection filters it with its own grant.
    Room(Room, Arc<Batch>),
    /// Encoded `notification` frame, already targeted.
    Text(String),
}

struct UserConn {
    tx: mpsc::Sender<Delivery>,
    active: Arc<AtomicBool>,
}

/// Local connections by room and by user, for fan-out.
pub struct Hub {
    registry: Arc<Registry>,
    rooms: Mutex<HashMap<Room, HashMap<Uuid, mpsc::Sender<Delivery>>>>,
    users: Mutex<HashMap<u64, HashMap<Uuid, UserConn>>>,
}

impl Hub {
    pub fn new(registry: Arc<Registry>) -> Arc<Self> {
        Arc::new(Self {
            registry,
            rooms: Mutex::default(),
            users: Mutex::default(),
        })
    }

    pub fn add_user(
        &self,
        uid: u64,
        conn: Uuid,
        tx: mpsc::Sender<Delivery>,
        active: Arc<AtomicBool>,
    ) {
        self.users
            .lock()
            .expect("hub poisoned")
            .entry(uid)
            .or_default()
            .insert(conn, UserConn { tx, active });
    }

    pub fn remove_user(&self, uid: u64, conn: Uuid) {
        let mut users = self.users.lock().expect("hub poisoned");
        if let Some(m) = users.get_mut(&uid) {
            m.remove(&conn);
            if m.is_empty() {
                users.remove(&uid);
            }
        }
    }

    pub fn join(&self, room: &Room, conn: Uuid, tx: mpsc::Sender<Delivery>) {
        self.rooms
            .lock()
            .expect("hub poisoned")
            .entry(room.clone())
            .or_default()
            .insert(conn, tx);
    }

    pub fn leave(&self, room: &Room, conn: Uuid) {
        let mut rooms = self.rooms.lock().expect("hub poisoned");
        if let Some(m) = rooms.get_mut(room) {
            m.remove(&conn);
            if m.is_empty() {
                rooms.remove(room);
            }
        }
    }

    fn deliver(&self, conn: Uuid, tx: &mpsc::Sender<Delivery>, d: Delivery) {
        if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(d) {
            self.registry.close_conn(conn, ByeReason::Slow);
        }
    }

    /// Fans a batch out to the local members of its room, then sends its notifications.
    pub fn dispatch(&self, room: Option<&Room>, batch: Batch) {
        let batch = Arc::new(batch);
        if let Some(room) = room
            && (!batch.events.is_empty() || batch.regrant)
        {
            let members: Vec<(Uuid, mpsc::Sender<Delivery>)> = self
                .rooms
                .lock()
                .expect("hub poisoned")
                .get(room)
                .map(|m| m.iter().map(|(id, tx)| (*id, tx.clone())).collect())
                .unwrap_or_default();
            for (id, tx) in &members {
                self.deliver(*id, tx, Delivery::Room(room.clone(), Arc::clone(&batch)));
            }
        }
        for n in &batch.notify {
            let item = n.item.clone().or_else(|| room.map(Room::to_string));
            self.notify(item.unwrap_or_default(), &batch.by, n);
        }
    }

    /// Every tab of each recipient refreshes its bell; the active ones (or all of them
    /// when none is active) are told to alert (sound). A sync never alerts and reaches
    /// the author's own tabs.
    fn notify(&self, item: String, by: &Actor, n: &Notify) {
        let nid = Uuid::new_v4().to_string();
        let encode = |alert: bool| {
            protocol::encode(
                &ServerMsg::Notification {
                    nid: nid.clone(),
                    kind: n.kind.clone(),
                    room: item.clone(),
                    by: by.clone(),
                    alert,
                },
                None,
            )
        };
        let (loud, quiet) = (encode(true), encode(false));
        let targets: Vec<(Uuid, mpsc::Sender<Delivery>, bool)> = {
            let users = self.users.lock().expect("hub poisoned");
            n.to.iter()
                .filter(|uid| n.sync || **uid != by.id)
                .filter_map(|uid| users.get(uid))
                .flat_map(|conns| {
                    let any_active = conns.values().any(|c| c.active.load(Ordering::Relaxed));
                    conns.iter().map(move |(id, c)| {
                        let alert = !n.sync && (!any_active || c.active.load(Ordering::Relaxed));
                        (*id, c.tx.clone(), alert)
                    })
                })
                .collect()
        };
        for (id, tx, alert) in targets {
            let text = if alert { loud.clone() } else { quiet.clone() };
            self.deliver(id, &tx, Delivery::Text(text));
        }
    }

    /// Receives batches published by the plugin (any GLPI front end) and dispatches them.
    pub async fn listen(
        self: Arc<Self>,
        cfg: Arc<Config>,
        store: Store,
        mut stop: watch::Receiver<bool>,
    ) {
        let sub = match fred_config(&cfg.valkey)
            .and_then(|c| Builder::from_config(c).build_subscriber_client())
        {
            Ok(s) => s,
            Err(e) => return warn!(error = %e, "events: subscriber disabled"),
        };
        if let Err(e) = sub.init().await {
            return warn!(error = %e, "events: subscriber disabled");
        }
        let _resub = sub.manage_subscriptions();
        let mut rx = sub.message_rx();
        if let Err(e) = sub.subscribe(store.events_channel()).await {
            return warn!(error = %e, "events: subscriber disabled");
        }
        info!("listening to item events");
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                m = rx.recv() => {
                    let Ok(m) = m else { continue };
                    let Ok(text) = m.value.convert::<String>() else { continue };
                    match Batch::parse(&text, &cfg.security.allowed_itemtypes) {
                        Some((room, batch)) => {
                            metrics::counter!("rt_events_total").increment(batch.events.len() as u64);
                            debug!(room = ?room.as_ref().map(Room::to_string), events = batch.events.len(), regrant = batch.regrant, "events: batch");
                            self.dispatch(room.as_ref(), batch);
                        }
                        None => {
                            metrics::counter!("rt_events_rejected_total").increment(1);
                            warn!("events: malformed batch dropped");
                        }
                    }
                }
            }
        }
        let _ = sub.quit().await;
    }
}

/// Frames of a batch that one member may see.
pub fn frames_for(
    room: &Room,
    batch: &Batch,
    grant: &Grant,
    uid: u64,
    groups: &[u64],
) -> Vec<ServerMsg> {
    batch
        .events
        .iter()
        .filter(|e| e.vis.allows(grant, uid, groups))
        .map(|e| ServerMsg::Event {
            room: room.to_string(),
            by: batch.by.clone(),
            event: e.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(flags: &[&str]) -> Grant {
        Grant::from_flags(flags.iter().map(|f| (f.to_string(), true)))
    }

    fn types() -> Vec<String> {
        vec!["Ticket".into()]
    }

    #[test]
    fn public_followups_need_a_see_right() {
        let v = Visibility {
            right: Some(Right::Followup),
            ..Default::default()
        };
        assert!(v.allows(&grant(&["read", "see_public_followup"]), 1, &[]));
        assert!(v.allows(&grant(&["read", "see_private_followup"]), 1, &[]));
        assert!(!v.allows(&grant(&["read"]), 1, &[]));
    }

    #[test]
    fn private_followups() {
        let v = Visibility {
            right: Some(Right::Followup),
            private: true,
            uids: vec![7],
            groups: vec![],
        };
        assert!(!v.allows(&grant(&["read", "see_public_followup"]), 1, &[]));
        assert!(v.allows(&grant(&["read", "see_private_followup"]), 1, &[]));
        assert!(
            v.allows(&grant(&["read"]), 7, &[]),
            "the author sees their own"
        );
    }

    #[test]
    fn private_tasks_and_groups() {
        let v = Visibility {
            right: Some(Right::Task),
            private: true,
            uids: vec![3, 4],
            groups: vec![12],
        };
        let g = grant(&["read", "see_public_task", "see_private_task_groups"]);
        assert!(!v.allows(&g, 1, &[11]));
        assert!(v.allows(&g, 1, &[11, 12]), "member of the technician group");
        assert!(
            !v.allows(&grant(&["read", "see_public_task"]), 1, &[12]),
            "group right needed"
        );
        assert!(v.allows(&grant(&["read"]), 4, &[]), "assigned technician");
        assert!(v.allows(&grant(&["see_private_task"]), 1, &[]));
    }

    #[test]
    fn plain_events_reach_every_reader() {
        assert!(Visibility::default().allows(&grant(&["read"]), 1, &[]));
    }

    #[test]
    fn parse_and_validate() {
        let ok = r#"{"room":"Ticket:4","by":{"id":7,"name":"Alice"},
            "events":[{"kind":"ticket.update","fields":["status","bad field","priority"]},
                      {"kind":"followup.add","item":{"type":"ITILFollowup","id":3},
                       "vis":{"right":"followup","private":true,"uids":[7]}}],
            "notify":[{"to":[9,0],"kind":"followup"}]}"#;
        let (room, b) = Batch::parse(ok, &types()).unwrap();
        assert_eq!(room.unwrap().to_string(), "Ticket:4");
        assert_eq!(b.events[0].fields, ["status", "priority"]);
        assert_eq!(b.events[1].vis.right, Some(Right::Followup));
        assert_eq!(b.notify[0].to, [9]);

        for bad in [
            r#"{"room":"Computer:1","events":[]}"#,
            r#"{"room":"Ticket:1","events":[{"kind":"<script>"}]}"#,
            r#"{"room":"Ticket:1","events":[{"kind":"x","item":{"type":"A B","id":1}}]}"#,
            r#"{"room":"Ticket:1","events":[{"kind":"x","item":{"type":"A","id":0}}]}"#,
            r#"{"room":"Ticket:1","events":[{"kind":"x","vis":{"right":"admin"}}]}"#,
            r#"{"events":[{"kind":"ticket.update"}]}"#,
            r#"{"regrant":true}"#,
            r#"{"notify":[{"to":[1],"kind":"assigned","item":"Ticket"}]}"#,
            r#"{"notify":[{"to":[1],"kind":"assigned","item":"Ticket:x"}]}"#,
            "nope",
        ] {
            assert!(Batch::parse(bad, &types()).is_none(), "{bad}");
        }
    }

    #[test]
    fn personal_notifications_need_no_room() {
        let (room, b) = Batch::parse(
            r#"{"by":{"id":1,"name":"A"},"notify":[{"to":[2],"kind":"assigned","item":"ProjectTask:3"},
                {"to":[1],"kind":"inbox","sync":true}]}"#,
            &types(),
        )
        .unwrap();
        assert!(room.is_none());
        assert_eq!(b.notify[0].item.as_deref(), Some("ProjectTask:3"));
        assert!(b.notify[1].sync);
    }

    #[test]
    fn visibility_is_not_sent_to_clients() {
        let (room, b) = Batch::parse(
            r#"{"room":"Ticket:4","by":{"id":7,"name":"A"},"events":[{"kind":"task.add",
                "item":{"type":"TicketTask","id":2},"vis":{"right":"task","uids":[7],"groups":[5]}}]}"#,
            &types(),
        )
        .unwrap();
        let room = room.unwrap();
        let frames = frames_for(&room, &b, &grant(&["read", "see_public_task"]), 1, &[]);
        let s = protocol::encode(&frames[0], None);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["t"], "event");
        assert_eq!(v["kind"], "task.add");
        assert_eq!(v["item"]["type"], "TicketTask");
        assert_eq!(v["by"]["name"], "A");
        assert!(v.get("vis").is_none());
    }
}
