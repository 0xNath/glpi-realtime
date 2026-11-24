//! WebSocket handshake and per-connection loop.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use governor::{Quota, RateLimiter};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::auth;
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
        .on_upgrade(move |socket| Connection::new(app, registration, hash, session).run(socket))
}

enum End {
    /// Peer closed or the transport failed.
    Gone,
    /// We close, after telling the client why.
    Bye(ByeReason),
    /// Outbound queue full: drop without further writes.
    Slow,
}

#[allow(dead_code)] // grant flags are used by ticket events (step 3)
struct Joined {
    grant: Grant,
    since: u64,
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
    violations: u32,
}

impl Connection {
    fn new(app: AppState, reg: Registration, hash: String, session: Session) -> Self {
        Self {
            app,
            reg,
            hash,
            session,
            rooms: HashMap::new(),
            active: true,
            violations: 0,
        }
    }

    async fn run(mut self, socket: WebSocket) {
        let limits = self.app.cfg.limits.clone();
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
        };
        info!(conn = %self.reg.id, uid = self.session.uid, "connection opened");
        let mut end = match push_json(&tx, &hello, None) {
            Ok(()) => None,
            Err(_) => Some(End::Slow),
        };

        while end.is_none() {
            end = tokio::select! {
                biased;
                _ = close_rx.changed() => Some(End::Bye(close_rx.borrow().unwrap_or(ByeReason::Shutdown))),
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

        for room in std::mem::take(&mut self.rooms).into_keys() {
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
                    let rooms: Vec<(Room, u64)> = self
                        .rooms
                        .iter()
                        .map(|(r, j)| (r.clone(), j.since))
                        .collect();
                    for (room, since) in rooms {
                        self.app
                            .presence
                            .update(&room, self.reg.id, self.entry(since))
                            .await;
                    }
                }
                None
            }
            ClientMsg::Unsub { room } => {
                if let Some(r) = Room::parse(&room, &self.app.cfg.security.allowed_itemtypes)
                    && self.rooms.remove(&r).is_some()
                {
                    self.app.presence.leave(&r, self.reg.id).await;
                }
                reply(tx, &ServerMsg::Unsubscribed { room }, id)
            }
            ClientMsg::Sub { room } => {
                let Some(r) = Room::parse(&room, &self.app.cfg.security.allowed_itemtypes) else {
                    return self.error(tx, ErrorCode::BadRequest, "unknown room", id);
                };
                if self.rooms.contains_key(&r) {
                    return reply(tx, &ServerMsg::Subscribed { room }, id);
                }
                if self.rooms.len() >= self.app.cfg.limits.max_rooms_per_connection {
                    return self.error(tx, ErrorCode::TooManyRooms, "too many rooms", id);
                }
                match self.app.store.grant(&self.hash, &r).await {
                    Ok(Some(g)) if g.has("read") => {
                        info!(conn = %self.reg.id, uid = self.session.uid, room = %r, "subscribed");
                        let since = presence::now();
                        self.rooms.insert(r.clone(), Joined { grant: g, since });
                        if let Some(end) = reply(tx, &ServerMsg::Subscribed { room }, id) {
                            return Some(end);
                        }
                        let entry = self.entry(since);
                        self.app
                            .presence
                            .join(&r, self.reg.id, entry, tx.clone())
                            .await;
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

    fn entry(&self, since: u64) -> Entry {
        Entry {
            uid: self.session.uid,
            name: self.session.name.clone(),
            since,
            active: self.active,
            avatar: self.session.avatar.clone(),
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
