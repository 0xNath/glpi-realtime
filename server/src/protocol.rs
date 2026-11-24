//! Wire protocol, version 1. Text frames carry JSON: `{"v":1,"t":"<type>",...}`.
//! See docs/protocol.md.

use serde::{Deserialize, Serialize};

use crate::presence::PresenceUser;

pub const VERSION: u8 = 1;

/// A subscribable room: `<Itemtype>:<id>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Room {
    pub itemtype: String,
    pub id: u64,
}

impl Room {
    pub fn parse(s: &str, allowed_itemtypes: &[String]) -> Option<Room> {
        let (itemtype, id) = s.split_once(':')?;
        let id: u64 = id.parse().ok().filter(|&n| n > 0)?;
        allowed_itemtypes
            .iter()
            .any(|t| t == itemtype)
            .then(|| Room {
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
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    UnsupportedVersion,
    Forbidden,
    RateLimited,
    TooManyRooms,
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
    },
    Subscribed {
        room: String,
    },
    Unsubscribed {
        room: String,
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
