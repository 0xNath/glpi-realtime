//! Wire protocol, version 1. Text frames carry JSON: `{"v":1,"t":"<type>",...}`.
//! See docs/protocol.md.

use serde::{Deserialize, Serialize};

use crate::drafts::{Draft, Kind};
use crate::events::{Actor, Event};
use crate::locks::{Holder, Scope};
use crate::presence::PresenceUser;

pub const VERSION: u8 = 1;

/// A subscribable room: `<Itemtype>:<id>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Room {
    pub itemtype: String,
    pub id: u64,
}

/// Longest item type accepted (a PHP class name, namespace included).
const MAX_ITEMTYPE: usize = 100;

/// A PHP class name: `Ticket`, `Glpi\CustomAsset\ServerAsset`.
fn is_class_name(s: &str) -> bool {
    let mut parts = s.split('\\');
    s.len() <= MAX_ITEMTYPE
        && parts.all(|p| {
            let mut c = p.chars();
            c.next()
                .is_some_and(|f| f.is_ascii_alphabetic() || f == '_')
                && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        })
}

impl Room {
    /// `<Itemtype>:<id>`. With an empty `allowed_itemtypes`, any item type GLPI grants
    /// (the plugin's `enabled_itemtypes`): every room needs a grant written by GLPI for
    /// that very item anyway. A non-empty list restricts them.
    pub fn parse(s: &str, allowed_itemtypes: &[String]) -> Option<Room> {
        let (itemtype, id) = s.split_once(':')?;
        // One name per room: digits only, no leading zero nor sign ("Ticket:09" is not 9).
        if id.starts_with('0') || !id.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let id: u64 = id.parse().ok().filter(|&n| n > 0)?;
        let allowed = if allowed_itemtypes.is_empty() {
            is_class_name(itemtype)
        } else {
            allowed_itemtypes.iter().any(|t| t == itemtype)
        };
        allowed.then(|| Room {
            itemtype: itemtype.to_string(),
            id,
        })
    }
}

impl std::fmt::Display for Room {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.itemtype, self.id)
    }
}

#[derive(Debug, Deserialize)]
pub struct Envelope {
    pub v: u8,
    /// Optional client correlation id, echoed in the reply.
    #[serde(default)]
    pub id: Option<u32>,
    #[serde(flatten)]
    pub msg: ClientMsg,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    Sub {
        room: String,
    },
    Unsub {
        room: String,
    },
    Ping {},
    /// The tab became active or inactive (visible, focused, recently used).
    Activity {
        active: bool,
    },
    /// Take (or renew, while editing) the item's fields lock. `force`: take it from a
    /// holder whose tab is inactive.
    Lock {
        room: String,
        #[serde(default)]
        force: bool,
        #[serde(default)]
        scope: Scope,
        /// Fields held for an answer that changes the status (`solution`, `pending`).
        #[serde(default)]
        reason: Option<String>,
    },
    /// Release a lock.
    Unlock {
        room: String,
        #[serde(default)]
        scope: Scope,
    },
    /// The writer's draft (editor HTML, pasted images removed). The first one makes the
    /// sender the writer of this shared draft; `locked` when someone else is.
    Draft {
        room: String,
        kind: Kind,
        html: String,
        #[serde(default)]
        private: bool,
    },
    /// The writer sent or discarded the draft.
    DraftEnd {
        room: String,
        kind: Kind,
    },
    /// Follow (or stop following) a draft, read-only.
    DraftWatch {
        room: String,
        kind: Kind,
        on: bool,
    },
    /// Become the writer of a draft whose writer is inactive or gone.
    DraftTake {
        room: String,
        kind: Kind,
    },
    /// Follow the presence of these items without being in them (list pages). Replaces
    /// the previous set; items without a `read` grant are left out.
    Watch {
        rooms: Vec<String>,
    },
    /// Writing an answer in the timeline (`followup`, `task`, `solution`, `validation`,
    /// `document`), or `null` when done. Shown to the other members (presence).
    Compose {
        room: String,
        kind: Option<String>,
    },
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    UnsupportedVersion,
    Forbidden,
    RateLimited,
    TooManyRooms,
    /// Someone else holds it (shared draft).
    Locked,
    /// Content larger than allowed (shared draft).
    TooLarge,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::UnsupportedVersion => "unsupported_version",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::TooManyRooms => "too_many_rooms",
            ErrorCode::Locked => "locked",
            ErrorCode::TooLarge => "too_large",
            ErrorCode::Internal => "internal",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub id: u64,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Hello {
        conn: String,
        user: UserInfo,
        ping_interval: u64,
        /// Lifetime of a fields lock, seconds: holders renew it every third of it.
        lock_ttl: u64,
    },
    Subscribed {
        room: String,
    },
    Unsubscribed {
        room: String,
        /// Set when the server removed the subscription itself (rights lost).
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
    Pong {},
    Error {
        code: ErrorCode,
        message: String,
    },
    Bye {
        reason: ByeReason,
    },
    /// Everyone currently on the item (one entry per user, including the recipient).
    Presence {
        room: String,
        users: Vec<PresenceUser>,
    },
    /// Something changed on the item. No content: clients reload from GLPI.
    Event {
        room: String,
        by: Actor,
        #[serde(flatten)]
        event: Event,
    },
    /// Rights on the item may have changed: ask GLPI for a new grant, then `sub` again.
    /// No event is delivered for this room until then.
    Regrant {
        room: String,
    },
    /// Reply to `watch`: the items whose presence is now followed.
    Watching {
        rooms: Vec<String>,
    },
    /// A shared draft, to those who follow it (and to its new writer after a takeover).
    /// `null`: sent or discarded.
    Draft {
        room: String,
        kind: Kind,
        draft: Option<Draft>,
    },
    /// Who writes a shared draft (no content), to members who may follow it.
    /// `writer: null`: no draft any more.
    DraftInfo {
        room: String,
        kind: Kind,
        writer: Option<Holder>,
        private: bool,
        updated: Option<u64>,
        /// The writer's tab is inactive or gone: the draft can be taken over.
        away: bool,
    },
    /// Who edits the item's fields (`null`: nobody). After `subscribed`, on change, and in
    /// reply to `lock` / `unlock`.
    Lock {
        room: String,
        scope: Scope,
        holder: Option<Holder>,
    },
    /// The user's notifications changed (assignment, answer on one of their tickets,
    /// read in another tab...): refresh the bell from GLPI. `alert`: play the sound here.
    Notification {
        nid: String,
        kind: String,
        /// Item concerned (`Ticket:5`), empty for a read-state change.
        room: String,
        by: Actor,
        alert: bool,
    },
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ByeReason {
    /// Session revoked (logout, expiry, rights change).
    Revoked,
    /// Server restarting: reconnect after a delay.
    Shutdown,
    /// Too many rate-limit violations.
    Policy,
    /// Client could not keep up with outgoing messages.
    Slow,
    /// No activity within the idle timeout.
    Idle,
}

#[derive(Serialize)]
struct Out<'a> {
    v: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u32>,
    #[serde(flatten)]
    msg: &'a ServerMsg,
}

pub fn encode(msg: &ServerMsg, id: Option<u32>) -> String {
    serde_json::to_string(&Out {
        v: VERSION,
        id,
        msg,
    })
    .expect("server messages always serialize")
}

pub enum Decoded {
    Ok(Envelope),
    Err(ErrorCode, String, Option<u32>),
}

pub fn decode(text: &str) -> Decoded {
    // Read the version and id first so that errors can still be correlated.
    #[derive(Deserialize)]
    struct Head {
        v: Option<u8>,
        id: Option<u32>,
    }
    let head: Head = match serde_json::from_str(text) {
        Ok(h) => h,
        Err(_) => return Decoded::Err(ErrorCode::BadRequest, "invalid JSON".into(), None),
    };
    if head.v != Some(VERSION) {
        return Decoded::Err(
            ErrorCode::UnsupportedVersion,
            format!("protocol version {VERSION} required"),
            head.id,
        );
    }
    match serde_json::from_str::<Envelope>(text) {
        Ok(env) => Decoded::Ok(env),
        Err(e) => Decoded::Err(ErrorCode::BadRequest, e.to_string(), head.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types() -> Vec<String> {
        vec!["Ticket".into()]
    }

    #[test]
    fn rooms() {
        assert_eq!(
            Room::parse("Ticket:42", &types()),
            Some(Room {
                itemtype: "Ticket".into(),
                id: 42
            })
        );
        assert!(Room::parse("Ticket:0", &types()).is_none());
        assert!(Room::parse("Ticket:-1", &types()).is_none());
        assert!(Room::parse("Computer:1", &types()).is_none());
        assert!(Room::parse("Ticket:1:2", &types()).is_none());
        assert!(Room::parse("Ticket", &types()).is_none());
    }

    #[test]
    fn rooms_follow_glpi_without_a_list() {
        let any: Vec<String> = vec![];
        assert!(Room::parse("Computer:1", &any).is_some());
        assert_eq!(
            Room::parse("Glpi\\CustomAsset\\ServerAsset:4", &any).map(|r| r.to_string()),
            Some("Glpi\\CustomAsset\\ServerAsset:4".to_string())
        );
        for bad in [
            "Ticket:09",
            "Ticket:+9",
            "Ticket: 9",
            "9Ticket:1",
            "Tick et:1",
            "Ticket\\:1",
            "\\Ticket:1",
            ":1",
            "Ti-cket:1",
            "Ticket:0",
        ] {
            assert!(Room::parse(bad, &any).is_none(), "{bad}");
        }
        assert!(Room::parse(&format!("{}:1", "A".repeat(101)), &any).is_none());
    }

    #[test]
    fn decode_ok() {
        match decode(r#"{"v":1,"id":7,"t":"sub","room":"Ticket:3"}"#) {
            Decoded::Ok(e) => {
                assert_eq!(e.id, Some(7));
                assert_eq!(
                    e.msg,
                    ClientMsg::Sub {
                        room: "Ticket:3".into()
                    }
                );
            }
            _ => panic!(),
        }
        assert!(matches!(decode(r#"{"v":1,"t":"ping"}"#), Decoded::Ok(_)));
    }

    #[test]
    fn decode_errors() {
        assert!(matches!(
            decode("nope"),
            Decoded::Err(ErrorCode::BadRequest, _, None)
        ));
        assert!(matches!(
            decode(r#"{"v":2,"id":1,"t":"ping"}"#),
            Decoded::Err(ErrorCode::UnsupportedVersion, _, Some(1))
        ));
        assert!(matches!(
            decode(r#"{"v":1,"id":2,"t":"rm_rf"}"#),
            Decoded::Err(ErrorCode::BadRequest, _, Some(2))
        ));
        assert!(matches!(
            decode(r#"{"v":1,"t":"sub"}"#),
            Decoded::Err(ErrorCode::BadRequest, _, None)
        ));
    }

    #[test]
    fn encode_shape() {
        let s = encode(
            &ServerMsg::Subscribed {
                room: "Ticket:1".into(),
            },
            Some(3),
        );
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["id"], 3);
        assert_eq!(v["t"], "subscribed");
        assert_eq!(v["room"], "Ticket:1");
        let s = encode(
            &ServerMsg::Bye {
                reason: ByeReason::Revoked,
            },
            None,
        );
        assert_eq!(s, r#"{"v":1,"t":"bye","reason":"revoked"}"#);
    }
}
