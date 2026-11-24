//! An event batch read from Valkey's channel: malformed ones are dropped, never a panic.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = glpi_realtime::events::Batch::parse(text, &[]);
        let _ = glpi_realtime::events::Batch::parse(text, &["Ticket".to_string()]);
    }
});
