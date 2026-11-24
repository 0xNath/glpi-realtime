#![forbid(unsafe_code)]
//! glpi-realtime: WebSocket server bringing presence, live events, notifications
//! and collaborative drafts to GLPI. GLPI (through the `realtime` plugin) is the only
//! authority on identities and rights; this server only reads what it wrote in Valkey.

pub mod auth;
pub mod avatar;
pub mod config;
pub mod drafts;
pub mod events;
pub mod locks;
pub mod presence;
pub mod protocol;
pub mod registry;
pub mod revocation;
pub mod server;
pub mod status;
pub mod store;
pub mod ws;
