//! Shared answer drafts (step 5).
//!
//! One shared draft per item and answer kind (followup, task, solution). Its writer pushes
//! the editor's HTML as they type; members who joined (`draft_watch`) see it live,
//! read-only, and may take over when the writer is inactive or gone. This is the only
//! content that travels on the WebSocket: only to members with GLPI's right to add that
//! kind of answer (and to see private ones when the draft is private), never logged.
//!
//! - Valkey key `rt:d:{room}:{kind}`: JSON [`Draft`], kept `ttl` after the last change so
//!   that a draft left by a closed tab can be taken over. Written atomically (Lua): only
//!   its writer updates it.
//! - Channel `rt:dc`: "draft (room, kind) changed". Instances re-read it and push `draft`
//!   to their local watchers and `draft_info` (who writes, no content) to local members.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use fred::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::config::Config;
use crate::events::{Delivery, Hub};
use crate::locks::Holder;
use crate::presence::{Entry, now};
use crate::protocol::{self, Room, ServerMsg};
use crate::store::{Grant, Store, fred_config};

/// Largest draft accepted (HTML, after the client removed pasted images).
pub const MAX_HTML: usize = 48 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Followup,
    Task,
    Solution,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::Followup, Kind::Task, Kind::Solution];

    fn as_str(self) -> &'static str {
        match self {
            Kind::Followup => "followup",
            Kind::Task => "task",
            Kind::Solution => "solution",
        }
    }

    /// Grant flag needed to write or follow this kind of draft.
    pub fn right(self) -> &'static str {
        match self {
            Kind::Followup => "add_followup",
            Kind::Task => "add_task",
            Kind::Solution => "solve",
        }
    }

    /// Grant flag needed when the draft is private.
    fn private_right(self) -> Option<&'static str> {
        match self {
            Kind::Followup => Some("see_private_followup"),
            Kind::Task => Some("see_private_task"),
            Kind::Solution => None,
        }
    }

    /// May this session follow (or take over) a draft?
    pub fn allows(self, grant: &Grant, private: bool) -> bool {
        grant.has(self.right()) && (!private || self.private_right().is_none_or(|r| grant.has(r)))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Draft {
    pub writer: Holder,
    pub html: String,
    pub private: bool,
    /// Unix seconds.
    pub updated: u64,
}

/// Writes the draft if it has no writer or we are its writer (or `force`).
/// ARGV: conn, draft JSON, force ("1"), ttl seconds. Returns the stored JSON.
const WRITE: &str = r#"
local cur = redis.call('GET', KEYS[1])
if cur and ARGV[3] ~= '1' and cjson.decode(cur).writer.conn ~= ARGV[1] then return cur end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
return ARGV[2]
"#;

/// Deletes the draft if we are its writer. ARGV: conn.
const END: &str = r#"
local cur = redis.call('GET', KEYS[1])
if cur and cjson.decode(cur).writer.conn == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
"#;

#[derive(Serialize, Deserialize)]
struct Changed {
    room: String,
    kind: Kind,
    from: String,
}

struct Watcher {
    tx: mpsc::Sender<Delivery>,
    grant: Grant,
}

pub struct Drafts {
    store: Store,
    hub: Arc<Hub>,
    instance: String,
    ttl_secs: u64,
    watchers: Mutex<HashMap<(Room, Kind), HashMap<Uuid, Watcher>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DraftError {
    /// Someone else writes it.
    Locked(Box<Draft>),
    TooLarge,
    Unavailable,
}

impl Drafts {
    pub fn new(store: Store, hub: Arc<Hub>, ttl_secs: u64) -> Arc<Self> {
        Arc::new(Self {
            store,
            hub,
            instance: Uuid::new_v4().to_string(),
            ttl_secs: ttl_secs.max(60),
            watchers: Mutex::default(),
        })
    }

    fn key(&self, room: &Room, kind: Kind) -> String {
        format!("{}d:{room}:{}", self.store.prefix(), kind.as_str())
    }

    fn channel(&self) -> String {
        format!("{}dc", self.store.prefix())
    }

    pub async fn get(&self, room: &Room, kind: Kind) -> Result<Option<Draft>, DraftError> {
        let raw: Option<String> = self
            .store
            .pool()
            .get(self.key(room, kind))
            .await
            .map_err(|_| DraftError::Unavailable)?;
        Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
    }

    /// The writer's new content. The first write makes the caller the writer.
    pub async fn write(
        &self,
        room: &Room,
        kind: Kind,
        writer: Holder,
        html: String,
        private: bool,
    ) -> Result<(), DraftError> {
        if html.len() > MAX_HTML {
            return Err(DraftError::TooLarge);
        }
        let draft = Draft {
            writer,
            html,
            private,
            updated: now(),
        };
        let stored = self.store_draft(room, kind, &draft, false).await?;
        if stored.writer.conn != draft.writer.conn {
            metrics::counter!("rt_drafts_total", "op" => "locked").increment(1);
            return Err(DraftError::Locked(Box::new(stored)));
        }
        metrics::counter!("rt_drafts_total", "op" => "write").increment(1);
        self.changed(room, kind).await;
        Ok(())
    }

    async fn store_draft(
        &self,
        room: &Room,
        kind: Kind,
        draft: &Draft,
        force: bool,
    ) -> Result<Draft, DraftError> {
        let json = serde_json::to_string(draft).expect("draft serializes");
        let cur: String = self
            .store
            .pool()
            .next()
            .eval(
                WRITE,
                self.key(room, kind),
                vec![
                    draft.writer.conn.clone(),
                    json,
                    if force { "1" } else { "0" }.to_string(),
                    self.ttl_secs.to_string(),
                ],
            )
            .await
            .map_err(|e| {
                warn!(error = %e, %room, "drafts: write failed");
                DraftError::Unavailable
            })?;
        serde_json::from_str(&cur).map_err(|_| DraftError::Unavailable)
    }

    /// Sent or discarded by its writer.
    pub async fn end(&self, room: &Room, kind: Kind, conn: &str) {
        let res: Result<i64, _> = self
            .store
            .pool()
            .next()
            .eval(END, self.key(room, kind), vec![conn.to_string()])
            .await;
        match res {
            Ok(1) => self.changed(room, kind).await,
            Ok(_) => {}
            Err(e) => warn!(error = %e, %room, "drafts: end failed"),
        }
    }

    /// Takes over a draft whose writer is inactive or gone. Returns it, now ours.
    pub async fn take(
        &self,
        room: &Room,
        kind: Kind,
        me: Holder,
        grant: &Grant,
    ) -> Result<Option<Draft>, DraftError> {
        let Some(mut d) = self.get(room, kind).await? else {
            return Ok(None);
        };
        if !kind.allows(grant, d.private) {
            return Ok(None);
        }
        if d.writer.conn != me.conn && !self.writer_away(room, &d.writer.conn).await {
            return Err(DraftError::Locked(Box::new(d)));
        }
        d.writer = me;
        d.updated = now();
        metrics::counter!("rt_drafts_total", "op" => "take").increment(1);
        let stored = self.store_draft(room, kind, &d, true).await?;
        self.changed(room, kind).await;
        Ok(Some(stored))
    }

    /// The writer's tab is inactive (presence) or their connection left the item.
    async fn writer_away(&self, room: &Room, conn: &str) -> bool {
        match self.store.presence_list(room).await {
            Ok(entries) => match entries.get(conn) {
                Some(raw) => serde_json::from_str::<Entry>(raw).is_ok_and(|e| !e.active),
                None => true,
            },
            Err(_) => false,
        }
    }

    pub fn watch(
        &self,
        room: &Room,
        kind: Kind,
        conn: Uuid,
        tx: mpsc::Sender<Delivery>,
        grant: Grant,
    ) {
        self.watchers
            .lock()
            .expect("drafts poisoned")
            .entry((room.clone(), kind))
            .or_default()
            .insert(conn, Watcher { tx, grant });
    }

    pub fn unwatch(&self, room: &Room, kind: Kind, conn: Uuid) {
        let mut w = self.watchers.lock().expect("drafts poisoned");
        let k = (room.clone(), kind);
        if let Some(m) = w.get_mut(&k) {
            m.remove(&conn);
            if m.is_empty() {
                w.remove(&k);
            }
        }
    }

    pub fn unwatch_all(&self, room: &Room, conn: Uuid) {
        for kind in Kind::ALL {
            self.unwatch(room, kind, conn);
        }
    }

    /// Re-reads the draft and pushes it here, then tells the other instances.
    async fn changed(&self, room: &Room, kind: Kind) {
        self.push(room, kind).await;
        let msg = serde_json::to_string(&Changed {
            room: room.to_string(),
            kind,
            from: self.instance.clone(),
        })
        .expect("serializes");
        if let Err(e) = self.store.publish(&self.channel(), msg).await {
            warn!(error = %e, "drafts: cannot publish change");
        }
    }

    /// Content to the local watchers allowed to see it; who writes to every member
    /// (connections filter it with their grant, see ws.rs).
    async fn push(&self, room: &Room, kind: Kind) {
        let Ok(draft) = self.get(room, kind).await else {
            return;
        };
        let watchers: Vec<(mpsc::Sender<Delivery>, bool)> = self
            .watchers
            .lock()
            .expect("drafts poisoned")
            .get(&(room.clone(), kind))
            .map(|m| {
                m.values()
                    .map(|w| {
                        let ok = draft
                            .as_ref()
                            .is_none_or(|d| kind.allows(&w.grant, d.private));
                        (w.tx.clone(), ok)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let content = draft_msg(room, kind, draft.as_ref());
        for (tx, ok) in watchers {
            if ok {
                let _ = tx.try_send(Delivery::Text(content.clone()));
            }
        }
        let away = match &draft {
            Some(d) => self.writer_away(room, &d.writer.conn).await,
            None => false,
        };
        self.hub
            .broadcast_info(room, info(room, kind, draft.as_ref(), away));
    }

    /// What a member sees after subscribing: who writes each kind (no content).
    pub async fn infos(&self, room: &Room) -> Vec<(Kind, ServerMsg, bool)> {
        let mut out = vec![];
        for kind in Kind::ALL {
            if let Ok(Some(d)) = self.get(room, kind).await {
                let away = self.writer_away(room, &d.writer.conn).await;
                let (msg, private, _) = info(room, kind, Some(&d), away);
                out.push((kind, msg, private));
            }
        }
        out
    }

    /// The content for one connection that just joined.
    pub async fn content(&self, room: &Room, kind: Kind, grant: &Grant) -> Option<String> {
        let d = self.get(room, kind).await.ok()?;
        if d.as_ref().is_some_and(|d| !kind.allows(grant, d.private)) {
            return None;
        }
        Some(draft_msg(room, kind, d.as_ref()))
    }

    /// The writer's connection is gone: members are told the draft can be taken over.
    pub async fn writer_left(&self, room: &Room, conn: &str) {
        for kind in Kind::ALL {
            if self
                .get(room, kind)
                .await
                .ok()
                .flatten()
                .is_some_and(|d| d.writer.conn == conn)
            {
                self.changed(room, kind).await;
            }
        }
    }

    pub async fn listen(self: Arc<Self>, cfg: Arc<Config>, mut stop: watch::Receiver<bool>) {
        let sub = match fred_config(&cfg.valkey)
            .and_then(|c| Builder::from_config(c).build_subscriber_client())
        {
            Ok(s) => s,
            Err(e) => return warn!(error = %e, "drafts: subscriber disabled"),
        };
        if let Err(e) = sub.init().await {
            return warn!(error = %e, "drafts: subscriber disabled");
        }
        let _resub = sub.manage_subscriptions();
        let mut rx = sub.message_rx();
        if let Err(e) = sub.subscribe(self.channel()).await {
            return warn!(error = %e, "drafts: subscriber disabled");
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
                        debug!(%room, "drafts: remote change");
                        self.push(&room, c.kind).await;
                    }
                }
            }
        }
        let _ = sub.quit().await;
    }
}

fn draft_msg(room: &Room, kind: Kind, d: Option<&Draft>) -> String {
    protocol::encode(
        &ServerMsg::Draft {
            room: room.to_string(),
            kind,
            draft: d.cloned(),
        },
        None,
    )
}

/// Who writes (no content), whether they left (the draft can be taken over), and
/// whether it is private (for filtering).
fn info(room: &Room, kind: Kind, d: Option<&Draft>, away: bool) -> (ServerMsg, bool, Kind) {
    (
        ServerMsg::DraftInfo {
            room: room.to_string(),
            kind,
            writer: d.map(|d| d.writer.clone()),
            private: d.is_some_and(|d| d.private),
            updated: d.map(|d| d.updated),
            away,
        },
        d.is_some_and(|d| d.private),
        kind,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(flags: &[&str]) -> Grant {
        Grant::from_flags(flags.iter().map(|f| (f.to_string(), true)))
    }

    #[test]
    fn rights_per_kind_and_privacy() {
        let tech = grant(&["read", "add_followup", "see_private_followup", "add_task"]);
        let requester = grant(&["read", "add_followup"]);
        assert!(Kind::Followup.allows(&tech, true));
        assert!(Kind::Followup.allows(&requester, false));
        assert!(
            !Kind::Followup.allows(&requester, true),
            "private followups"
        );
        assert!(
            !Kind::Task.allows(&tech, true),
            "private tasks need see_private_task"
        );
        assert!(!Kind::Solution.allows(&tech, false), "solutions need solve");
        assert!(Kind::Solution.allows(&grant(&["solve"]), true));
    }
}
