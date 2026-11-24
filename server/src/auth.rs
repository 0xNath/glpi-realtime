//! Handshake checks: Origin, session cookie, token format and hashing.
//!
//! The plugin generates `bin2hex(random_bytes(32))` (64 lowercase hex chars), stores the
//! session under `rt:s:{sha256(token)}` and sends the token in an HttpOnly cookie
//! restricted to `/ws`. Only the hash ever reaches Valkey.

use sha2::{Digest, Sha256};

pub const TOKEN_LEN: usize = 64;

/// Returns the token if it has the expected shape; anything else is rejected
/// before touching Valkey.
pub fn valid_token(token: &str) -> Option<&str> {
    (token.len() == TOKEN_LEN
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
    .then_some(token)
}

pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Extracts a cookie value from one or more `Cookie` header values.
pub fn cookie_value<'a>(headers: impl IntoIterator<Item = &'a str>, name: &str) -> Option<&'a str> {
    headers
        .into_iter()
        .flat_map(|h| h.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.trim().trim_matches('"'))
}

/// Exact match against the allow-list (scheme and host are case-insensitive).
pub fn origin_allowed(origin: Option<&str>, allowed: &[String]) -> bool {
    match origin {
        Some(o) => {
            let o = o.trim_end_matches('/');
            allowed
                .iter()
                .any(|a| a.trim_end_matches('/').eq_ignore_ascii_case(o))
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOK: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn token_shape() {
        assert!(valid_token(TOK).is_some());
        assert!(valid_token(&TOK[1..]).is_none());
        assert!(valid_token(&TOK.to_uppercase()).is_none());
        assert!(valid_token(&format!("{}g", &TOK[1..])).is_none());
        assert!(valid_token("").is_none());
    }

    #[test]
    fn hash_is_sha256_hex() {
        assert_eq!(
            token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn cookie_parsing() {
        let h = ["a=1; glpi_rt=xyz; b=2"];
        assert_eq!(cookie_value(h, "glpi_rt"), Some("xyz"));
        assert_eq!(
            cookie_value(["glpi_rtx=1", "glpi_rt=\"q\""], "glpi_rt"),
            Some("q")
        );
        assert_eq!(cookie_value(["a=1"], "glpi_rt"), None);
    }

    #[test]
    fn origins() {
        let allowed = vec!["https://glpi.example".to_string()];
        assert!(origin_allowed(Some("https://glpi.example"), &allowed));
        assert!(origin_allowed(Some("HTTPS://GLPI.EXAMPLE/"), &allowed));
        assert!(!origin_allowed(Some("https://evil.example"), &allowed));
        assert!(!origin_allowed(Some("https://glpi.example.evil"), &allowed));
        assert!(!origin_allowed(Some("null"), &allowed));
        assert!(!origin_allowed(None, &allowed));
    }
}
