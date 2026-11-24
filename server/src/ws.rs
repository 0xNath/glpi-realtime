//! WebSocket handshake and per-connection loop.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use governor::{Quota, RateLimiter};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{info, warn};

use crate::auth;
use crate::events::{self, Delivery};
use crate::locks;
use crate::presence::{self, Entry};
use crate::protocol::{self, ByeReason, ClientMsg, Decoded, ErrorCode, Room, ServerMsg, UserInfo};
use crate::registry::{RegisterError, Registration};
use crate::server::AppState;
use crate::store::{Grant, Session};

fn reject(status: StatusCode, reason: &'static str) -> Response {
    metrics::counter!("rt_handshakes_total", "result" => reason).increment(1);
    info!(reason, "handshake rejected");
    (status, reason).into_response()
}

pub async fn handler(
    State(app): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !auth::origin_allowed(origin, &app.cfg.security.allowed_origins) {
        return reject(StatusCode::FORBIDDEN, "origin");
    }

    let cookies = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok());
    let Some(token) =
        auth::cookie_value(cookies, &app.cfg.security.cookie_name).and_then(auth::valid_token)
    else {
        return reject(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let hash = auth::token_hash(token);

    let session = match tokio::time::timeout(Duration::from_secs(2), app.store.session(&hash)).await
    {
        Ok(Ok(Some(s))) => s,
        Ok(Ok(None)) => return reject(StatusCode::UNAUTHORIZED, "unauthorized"),
        Ok(Err(e)) => {
            warn!(error = %e, "valkey error during handshake");
            return reject(StatusCode::SERVICE_UNAVAILABLE, "unavailable");
        }
        Err(_) => return reject(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    };

    let registration = match app.registry.register(session.uid, &hash) {
        Ok(r) => r,
        Err(RegisterError::UserFull) => return reject(StatusCode::TOO_MANY_REQUESTS, "user_full"),
        Err(RegisterError::InstanceFull) => {
            return reject(StatusCode::SERVICE_UNAVAILABLE, "instance_full");
        }
    };

    metrics::counter!("rt_handshakes_total", "result" => "ok").increment(1);
    let max = app.cfg.limits.max_message_bytes;
    ws.max_message_size(max)
        .max_frame_size(max)
        .on_upgrade(move |socket| {
            let (ev_tx, ev_rx) = mpsc::channel(app.cfg.limits.outbound_queue);
            Connection::new(app, registration, hash, session, ev_tx).run(socket, ev_rx)
        })
}

enum End {
    /// Peer closed or the transport failed.
    Gone,
    /// We close, after telling the client why.
    Bye(ByeReason),
    /// Outbound queue full: drop without further writes.
    Slow,
}

struct Joined {
    /// Flags GLPI computed for this session; filter the item's events.
    grant: Grant,
    since: u64,
    /// Set by `regrant`: no event until the client subscribes again, removed at this deadline.
    stale_until: Option<Instant>,
    /// Answer being written in this room's timeline.
    composing: Option<String>,
}

enum PushError {
    Full,
    Closed,
}

struct Connection {
    app: AppState,
    reg: Registration,
    hash: String,
    session: Session,
    rooms: HashMap<Room, Joined>,
    /// Tab activity reported by the client (active until told otherwise).
    active: bool,
    /// Same, shared with the hub to target notifications.
    active_flag: Arc<AtomicBool>,
    /// Where the hub sends this connection's events and notifications.
    ev_tx: mpsc::Sender<Delivery>,
    violations: u32,
}

impl Connection {
    fn new(
        app: AppState,
        reg: Registration,
        hash: String,
        session: Session,
        ev_tx: mpsc::Sender<Delivery>,
    ) -> Self {
        Self {
            app,
            reg,
            hash,
            session,
            rooms: HashMap::new(),
            active: true,
            active_flag: Arc::new(AtomicBool::new(true)),
            ev_tx,
            violations: 0,
        }
    }

    async fn run(mut self, socket: WebSocket, mut ev_rx: mpsc::Receiver<Delivery>) {
        let limits = self.app.cfg.limits.clone();
        self.app.hub.add_user(
            self.session.uid,
            self.reg.id,
            self.ev_tx.clone(),
            Arc::clone(&self.active_flag),
        );
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::channel::<Message>(limits.outbound_queue);

        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let is_close = matches!(m, Message::Close(_));
                if sink.send(m).await.is_err() || is_close {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        let conn_limiter = RateLimiter::direct(
            Quota::per_second(nz(limits.messages_per_second)).allow_burst(nz(limits.burst)),
        );
        let idle = Duration::from_secs(limits.idle_timeout_secs);
        let mut ping = tokio::time::interval(Duration::from_secs(limits.ping_interval_secs));
        ping.tick().await;
        let mut last_seen = Instant::now();
        let mut close_rx = self.reg.close.clone();

        let hello = ServerMsg::Hello {
            conn: self.reg.id.to_string(),
            user: UserInfo {
                id: self.session.uid,
                name: self.session.name.clone(),
            },
            ping_interval: limits.ping_interval_secs,
            lock_ttl: self.app.locks.ttl_secs(),
        };
        info!(conn = %self.reg.id, uid = self.session.uid, "connection opened");
        let mut end = match push_json(&tx, &hello, None) {
            Ok(()) => None,
            Err(_) => Some(End::Slow),
        };

        while end.is_none() {
            let stale_deadline = self.rooms.values().filter_map(|j| j.stale_until).min();
            end = tokio::select! {
                biased;
                _ = close_rx.changed() => Some(End::Bye(close_rx.borrow().unwrap_or(ByeReason::Shutdown))),
                Some(d) = ev_rx.recv() => self.deliver(&tx, d),
                _ = sleep_until(stale_deadline) => self.expire_stale(&tx).await,
                _ = ping.tick() => {
                    if last_seen.elapsed() > idle {
                        Some(End::Bye(ByeReason::Idle))
                    } else {
                        push(&tx, Message::Ping(Default::default())).err().map(|_| End::Slow)
                    }
                }
                frame = stream.next() => match frame {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => Some(End::Gone),
                    Some(Ok(msg)) => {
                        last_seen = Instant::now();
                        match msg {
                            Message::Text(text) => {
                                metrics::counter!("rt_messages_in_total").increment(1);
                                let allowed = conn_limiter.check().is_ok()
                                    && self.app.user_limiter.check_key(&self.session.uid).is_ok();
                                if allowed {
                                    self.handle_text(&tx, &text).await
                                } else {
                                    self.violations += 1;
                                    if self.violations > limits.max_violations {
                                        Some(End::Bye(ByeReason::Policy))
                                    } else {
                                        self.error(&tx, ErrorCode::RateLimited, "slow down", None)
                                    }
                                }
                            }
                            Message::Binary(_) => {
                                self.error(&tx, ErrorCode::BadRequest, "binary frames are not supported yet", None)
                            }
                            Message::Ping(_) | Message::Pong(_) | Message::Close(_) => None,
                        }
                    }
                },
            };
        }

        self.app.hub.remove_user(self.session.uid, self.reg.id);
        for room in std::mem::take(&mut self.rooms).into_keys() {
            self.app.hub.leave(&room, self.reg.id);
            self.app
                .locks
                .release_all(&room, &self.reg.id.to_string())
                .await;
            if !self.app.hub.has_room(&room) {
                self.app.locks.forget(&room);
            }
            self.app.presence.leave(&room, self.reg.id).await;
        }
        let end = end.unwrap_or(End::Gone);
        let reason = match &end {
            End::Gone => "gone",
            End::Slow => "slow",
            End::Bye(r) => bye_label(*r),
        };
        metrics::counter!("rt_disconnects_total", "reason" => reason).increment(1);
        info!(conn = %self.reg.id, uid = self.session.uid, reason, "connection closed");

        match end {
            End::Gone => drop(tx),
            End::Slow => writer.abort(),
            End::Bye(r) => {
                let _ = push_json(&tx, &ServerMsg::Bye { reason: r }, None);
                let _ = push(
                    &tx,
                    Message::Close(Some(CloseFrame {
                        code: close_code(r),
                        reason: Utf8Bytes::from_static(bye_label(r)),
                    })),
                );
                drop(tx);
                // Leave the client a moment to read `bye`, but never hang on a dead peer.
                let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
            }
        }
        // `self.reg` is dropped here: the registry forgets the connection.
    }

    async fn handle_text(&mut self, tx: &mpsc::Sender<Message>, text: &str) -> Option<End> {
        let env = match protocol::decode(text) {
            Decoded::Ok(env) => env,
            Decoded::Err(code, message, id) => return self.error(tx, code, &message, id),
        };
        let id = env.id;
        match env.msg {
            ClientMsg::Ping {} => reply(tx, &ServerMsg::Pong {}, id),
            ClientMsg::Activity { active } => {
                if active != self.active {
                    self.active = active;
                    self.active_flag.store(active, Ordering::Relaxed);
                    let rooms: Vec<(Room, u64, Option<String>)> = self
                        .rooms
                        .iter()
                        .map(|(r, j)| (r.clone(), j.since, j.composing.clone()))
                        .collect();
                    for (room, since, composing) in rooms {
                        self.app
                            .presence
                            .update(&room, self.reg.id, self.entry(since, composing))
                            .await;
                    }
                }
                None
            }
            ClientMsg::Lock { room, force, scope } => {
                self.handle_lock(tx, room, scope, true, force, id).await
            }
            ClientMsg::Unlock { room, scope } => {
                self.handle_lock(tx, room, scope, false, false, id).await
            }
            ClientMsg::Compose { room, kind } => self.handle_compose(tx, room, kind, id).await,
            ClientMsg::Unsub { room } => {
                if let Some(r) = Room::parse(&room, &self.app.cfg.security.allowed_itemtypes) {
                    self.leave(&r).await;
                }
                reply(tx, &ServerMsg::Unsubscribed { room, reason: None }, id)
            }
            ClientMsg::Sub { room } => {
                let Some(r) = Room::parse(&room, &self.app.cfg.security.allowed_itemtypes) else {
                    return self.error(tx, ErrorCode::BadRequest, "unknown room", id);
                };
                if self.rooms.contains_key(&r) {
                    return self.resubscribe(tx, r, room, id).await;
                }
                if self.rooms.len() >= self.app.cfg.limits.max_rooms_per_connection {
                    return self.error(tx, ErrorCode::TooManyRooms, "too many rooms", id);
                }
                match self.app.store.grant(&self.hash, &r).await {
                    Ok(Some(g)) if g.has("read") => {
                        info!(conn = %self.reg.id, uid = self.session.uid, room = %r, "subscribed");
                        let since = presence::now();
                        self.rooms.insert(
                            r.clone(),
                            Joined {
                                grant: g,
                                since,
                                stale_until: None,
                                composing: None,
                            },
                        );
                        self.app.hub.join(&r, self.reg.id, self.ev_tx.clone());
                        if let Some(end) = reply(tx, &ServerMsg::Subscribed { room }, id) {
                            return Some(end);
                        }
                        let entry = self.entry(since, None);
                        self.app
                            .presence
                            .join(&r, self.reg.id, entry, tx.clone())
                            .await;
                        // Who edits the fields, right away.
                        for scope in locks::Scope::ALL {
                            if let Some(msg) = self.app.locks.state(&r, scope).await
                                && let Some(end) = reply(tx, &msg, None)
                            {
                                return Some(end);
                            }
                        }
                        None
                    }
                    Ok(_) => {
                        info!(conn = %self.reg.id, uid = self.session.uid, room = %r, "subscription refused: no grant");
                        self.error(tx, ErrorCode::Forbidden, "no grant for this room", id)
                    }
                    Err(e) => {
                        warn!(error = %e, "valkey error while reading grant");
                        self.error(tx, ErrorCode::Internal, "temporarily unavailable", id)
                    }
                }
            }
        }
    }

    /// `sub` on a room already joined: re-reads the grant (after `regrant`, or to pick
    /// up new flags). Without a grant any more, the connection leaves the room.
    async fn resubscribe(
        &mut self,
        tx: &mpsc::Sender<Message>,
        r: Room,
        room: String,
        id: Option<u32>,
    ) -> Option<End> {
        match self.app.store.grant(&self.hash, &r).await {
            Ok(Some(g)) if g.has("read") => {
                if let Some(j) = self.rooms.get_mut(&r) {
                    j.grant = g;
                    j.stale_until = None;
                }
                reply(tx, &ServerMsg::Subscribed { room }, id)
            }
            Ok(_) => {
                info!(conn = %self.reg.id, uid = self.session.uid, room = %r, "grant gone: leaving room");
                self.leave(&r).await;
                self.error(tx, ErrorCode::Forbidden, "no grant for this room", id)
            }
            Err(e) => {
                warn!(error = %e, "valkey error while reading grant");
                self.error(tx, ErrorCode::Internal, "temporarily unavailable", id)
            }
        }
    }

    async fn leave(&mut self, r: &Room) {
        if self.rooms.remove(r).is_some() {
            self.app.hub.leave(r, self.reg.id);
            self.app
                .locks
                .release_all(r, &self.reg.id.to_string())
                .await;
            if !self.app.hub.has_room(r) {
                self.app.locks.forget(r);
            }
            self.app.presence.leave(r, self.reg.id).await;
        }
    }

    /// `lock` / `unlock`: only on a joined room, with GLPI's `update` right, and not
    /// while a regrant is pending.
    async fn handle_lock(
        &mut self,
        tx: &mpsc::Sender<Message>,
        room: String,
        scope: locks::Scope,
        take: bool,
        force: bool,
        id: Option<u32>,
    ) -> Option<End> {
        let Some(r) = Room::parse(&room, &self.app.cfg.security.allowed_itemtypes) else {
            return self.error(tx, ErrorCode::BadRequest, "unknown room", id);
        };
        let conn = self.reg.id.to_string();
        if !take {
            self.app.locks.release(&r, scope, &conn).await;
        } else {
            let allowed = self
                .rooms
                .get(&r)
                .is_some_and(|j| j.stale_until.is_none() && j.grant.has(scope.right()));
            if !allowed {
                return self.error(tx, ErrorCode::Forbidden, "cannot edit this item", id);
            }
            let me = locks::holder(
                self.reg.id,
                self.session.uid,
                &self.session.name,
                self.session.avatar.clone(),
            );
            if self.app.locks.acquire(&r, scope, me, force).await.is_err() {
                return self.error(tx, ErrorCode::Internal, "temporarily unavailable", id);
            }
        }
        match self.app.locks.state(&r, scope).await {
            Some(msg) => reply(tx, &msg, id),
            None => self.error(tx, ErrorCode::Internal, "temporarily unavailable", id),
        }
    }

    /// Something from the hub: item events (filtered with our grant) or a notification.
    fn deliver(&mut self, tx: &mpsc::Sender<Message>, d: Delivery) -> Option<End> {
        let (room, batch) = match d {
            Delivery::Text(text) => return push_text(tx, text),
            Delivery::Room(room, batch) => (room, batch),
        };
        let Some(j) = self.rooms.get_mut(&room) else {
            return None; // left meanwhile
        };
        if batch.regrant && j.stale_until.is_none() {
            let timeout = Duration::from_secs(self.app.cfg.events.regrant_timeout_secs);
            j.stale_until = Some(Instant::now() + timeout);
            return reply(
                tx,
                &ServerMsg::Regrant {
                    room: room.to_string(),
                },
                None,
            );
        }
        if j.stale_until.is_some() {
            return None;
        }
        for msg in events::frames_for(
            &room,
            &batch,
            &j.grant,
            self.session.uid,
            &self.session.groups,
        ) {
            if let Some(end) = reply(tx, &msg, None) {
                return Some(end);
            }
        }
        None
    }

    /// Rooms whose `regrant` was not answered in time: rights are assumed lost.
    async fn expire_stale(&mut self, tx: &mpsc::Sender<Message>) -> Option<End> {
        let now = Instant::now();
        let expired: Vec<Room> = self
            .rooms
            .iter()
            .filter(|(_, j)| j.stale_until.is_some_and(|t| t <= now))
            .map(|(r, _)| r.clone())
            .collect();
        for r in expired {
            info!(conn = %self.reg.id, uid = self.session.uid, room = %r, "regrant timed out: leaving room");
            self.leave(&r).await;
            let msg = ServerMsg::Unsubscribed {
                room: r.to_string(),
                reason: Some("forbidden"),
            };
            if let Some(end) = reply(tx, &msg, None) {
                return Some(end);
            }
        }
        None
    }

    /// `compose`: what this tab writes in the room's timeline, in its presence entry.
    async fn handle_compose(
        &mut self,
        tx: &mpsc::Sender<Message>,
        room: String,
        kind: Option<String>,
        id: Option<u32>,
    ) -> Option<End> {
        if kind
            .as_deref()
            .is_some_and(|k| !presence::COMPOSE_KINDS.contains(&k))
        {
            return self.error(tx, ErrorCode::BadRequest, "unknown kind", id);
        }
        let Some(r) = Room::parse(&room, &self.app.cfg.security.allowed_itemtypes) else {
            return self.error(tx, ErrorCode::BadRequest, "unknown room", id);
        };
        let Some(j) = self.rooms.get_mut(&r) else {
            return self.error(tx, ErrorCode::Forbidden, "not subscribed", id);
        };
        if j.composing != kind {
            j.composing.clone_from(&kind);
            let since = j.since;
            self.app
                .presence
                .update(&r, self.reg.id, self.entry(since, kind))
                .await;
        }
        None
    }

    fn entry(&self, since: u64, composing: Option<String>) -> Entry {
        Entry {
            uid: self.session.uid,
            name: self.session.name.clone(),
            since,
            active: self.active,
            avatar: self.session.avatar.clone(),
            composing,
        }
    }

    fn error(
        &self,
        tx: &mpsc::Sender<Message>,
        code: ErrorCode,
        message: &str,
        id: Option<u32>,
    ) -> Option<End> {
        metrics::counter!("rt_errors_total", "code" => code.as_str()).increment(1);
        reply(
            tx,
            &ServerMsg::Error {
                code,
                message: message.to_string(),
            },
            id,
        )
    }
}

fn reply(tx: &mpsc::Sender<Message>, msg: &ServerMsg, id: Option<u32>) -> Option<End> {
    match push_json(tx, msg, id) {
        Ok(()) => None,
        Err(PushError::Full) => Some(End::Slow),
        Err(PushError::Closed) => Some(End::Gone),
    }
}

fn push(tx: &mpsc::Sender<Message>, m: Message) -> Result<(), PushError> {
    tx.try_send(m).map_err(|e| match e {
        mpsc::error::TrySendError::Full(_) => PushError::Full,
        mpsc::error::TrySendError::Closed(_) => PushError::Closed,
    })?;
    metrics::counter!("rt_messages_out_total").increment(1);
    Ok(())
}

fn push_text(tx: &mpsc::Sender<Message>, text: String) -> Option<End> {
    match push(tx, Message::Text(text.into())) {
        Ok(()) => None,
        Err(PushError::Full) => Some(End::Slow),
        Err(PushError::Closed) => Some(End::Gone),
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending().await,
    }
}

fn push_json(
    tx: &mpsc::Sender<Message>,
    msg: &ServerMsg,
    id: Option<u32>,
) -> Result<(), PushError> {
    push(tx, Message::Text(protocol::encode(msg, id).into()))
}

fn nz(n: u32) -> NonZeroU32 {
    NonZeroU32::new(n).unwrap_or(NonZeroU32::MIN)
}

fn bye_label(r: ByeReason) -> &'static str {
    match r {
        ByeReason::Revoked => "revoked",
        ByeReason::Shutdown => "shutdown",
        ByeReason::Policy => "policy",
        ByeReason::Slow => "slow",
        ByeReason::Idle => "idle",
    }
}

/// Close codes: 4001 tells the client not to reconnect until it has a new session.
fn close_code(r: ByeReason) -> u16 {
    match r {
        ByeReason::Revoked => 4001,
        ByeReason::Shutdown => 1012,
        ByeReason::Policy => 1008,
        ByeReason::Slow => 1013,
        ByeReason::Idle => 1001,
    }
}
