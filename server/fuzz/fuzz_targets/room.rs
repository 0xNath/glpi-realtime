//! A room name sent by a browser: never panics, and an accepted room prints back as sent
//! (it becomes part of Valkey keys).
#![no_main]

use glpi_realtime::protocol::Room;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    for allowed in [vec![], vec!["Ticket".to_string(), "Computer".to_string()]] {
        if let Some(room) = Room::parse(text, &allowed) {
            assert_eq!(room.to_string(), text, "a room is its own name");
            assert!(!room.itemtype.contains(':') && !room.itemtype.contains(char::is_whitespace));
        }
    }
});
