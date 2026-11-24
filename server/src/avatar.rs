//! User avatar as computed by GLPI (picture thumbnail, or initials on a color).
//! The values come from the plugin; they are re-validated here because they end up in
//! other users' pages (CSS `url(...)`, inline colors).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Avatar {
    /// Same-origin path of the picture, empty when GLPI draws initials.
    #[serde(default)]
    pub picture: String,
    #[serde(default)]
    pub initials: String,
    /// Background color of the initials (`#rgb` … `#rrggbbaa`).
    #[serde(default)]
    pub color: String,
    /// Text color of the initials.
    #[serde(default)]
    pub fg: String,
}

fn is_color(s: &str) -> bool {
    let hex = s.strip_prefix('#').unwrap_or("");
    matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A relative URL on the GLPI host, with no character able to escape a CSS `url("…")`.
fn is_safe_path(s: &str) -> bool {
    s.len() <= 512
        && s.starts_with('/')
        && !s.starts_with("//")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-~?=&%+,:;@".contains(&b))
}

impl Avatar {
    /// Parses the JSON written by the plugin; drops whatever does not look right.
    pub fn from_json(json: &str) -> Option<Avatar> {
        let a: Avatar = serde_json::from_str(json).ok()?;
        let picture = if is_safe_path(&a.picture) {
            a.picture
        } else {
            String::new()
        };
        let initials: String = a
            .initials
            .chars()
            .filter(|c| c.is_alphanumeric())
            .take(4)
            .collect();
        let color = if is_color(&a.color) {
            a.color
        } else {
            String::new()
        };
        let fg = if is_color(&a.fg) { a.fg } else { String::new() };
        if picture.is_empty() && initials.is_empty() {
            return None;
        }
        Some(Avatar {
            picture,
            initials,
            color,
            fg,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_avatars() {
        let a = Avatar::from_json(
            r##"{"picture":"/front/document.send.php?file=_pictures/ab/1.png","initials":"AM","color":"#5a7f9e","fg":"#fff"}"##,
        )
        .unwrap();
        assert_eq!(
            a.picture,
            "/front/document.send.php?file=_pictures/ab/1.png"
        );
        assert_eq!(
            (a.initials.as_str(), a.color.as_str(), a.fg.as_str()),
            ("AM", "#5a7f9e", "#fff")
        );
        let a = Avatar::from_json(r##"{"picture":"","initials":"ÉD","color":"#abc","fg":"#000"}"##)
            .unwrap();
        assert_eq!(a.initials, "ÉD");
    }

    #[test]
    fn hostile_values_are_dropped() {
        let a = Avatar::from_json(
            r##"{"picture":"/x.png\") ; background:url(https://evil","initials":"<b>X</b>","color":"red;x:y","fg":"#zzz"}"##,
        )
        .unwrap();
        assert_eq!(a.picture, "");
        assert_eq!(a.initials, "bXb"); // only letters/digits, max 4
        assert_eq!((a.color.as_str(), a.fg.as_str()), ("", ""));
        let a =
            Avatar::from_json(r##"{"picture":"//evil.example/x.png","initials":"A"}"##).unwrap();
        assert_eq!(a.picture, "", "protocol-relative URL refused");
        let a = Avatar::from_json(r##"{"picture":"https://evil.example/x.png","initials":"A"}"##)
            .unwrap();
        assert_eq!(a.picture, "", "absolute URL refused");
        assert!(Avatar::from_json(r##"{"picture":"","initials":""}"##).is_none());
        assert!(Avatar::from_json("not json").is_none());
        assert!(Avatar::from_json("[]").is_none());
    }
}
