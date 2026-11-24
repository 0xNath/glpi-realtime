//! The handshake's Cookie and Origin headers (untrusted): no panic; a token accepted from a
//! cookie is exactly 64 hex digits.
#![no_main]

use glpi_realtime::auth::{cookie_value, origin_allowed, valid_token};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    let (cookie, origin) = text.split_once('\n').unwrap_or((text, ""));
    if let Some(token) = cookie_value([cookie], "glpi_rt").and_then(valid_token) {
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    }
    let _ = origin_allowed(Some(origin), &["https://glpi.example.org".to_string()]);
});
