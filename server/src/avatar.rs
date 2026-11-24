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

/// How a support agent appears to self-service users when their entity anonymizes agents
/// (computed by GLPI: generic name or nickname, neutral initials).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Anon {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<Avatar>,
}

impl Anon {
    /// Parses the plugin's JSON; the avatar is validated like any other.
    pub fn from_json(json: &str) -> Option<Anon> {
        #[derive(Deserialize)]
        struct Raw {
            name: String,
            #[serde(default)]
            avatar: Option<serde_json::Value>,
        }
        let r: Raw = serde_json::from_str(json).ok()?;
        Some(Anon {
            name: r.name.chars().take(255).collect(),
            avatar: r.avatar.and_then(|a| Avatar::from_json(&a.to_string())),
        })
    }

    /// Re-validates an `anon` received inside a published batch.
    pub fn clean(self) -> Option<Anon> {
        Anon::from_json(&serde_json::to_string(&self).ok()?)
    }
}

/// Applies the anonymized representations of a frame for its recipient, and removes
/// them: users (presence), authors (`by`), lock holders and draft writers may carry an
/// `anon` object. For a session that must see agents anonymized, their `name` and
/// `avatar` become the anonymized ones. Frames without `anon` are returned unchanged
/// (anonymization disabled: no cost).
pub fn anonymize(text: &str, anon_view: bool) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    if !text.contains("\"anon\"") {
        return Cow::Borrowed(text);
    }
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Cow::Borrowed(text);
    };
    fn walk(v: &mut serde_json::Value, anon_view: bool) {
        match v {
            serde_json::Value::Object(map) => {
                if let Some(anon) = map.remove("anon")
                    && anon_view
                    && let serde_json::Value::Object(a) = anon
                {
                    if let Some(name) = a.get("name") {
                        map.insert("name".into(), name.clone());
                    }
                    match a.get("avatar") {
                        Some(av) => map.insert("avatar".into(), av.clone()),
                        None => map.remove("avatar"),
                    };
                }
                for child in map.values_mut() {
                    walk(child, anon_view);
                }
            }
            serde_json::Value::Array(items) => {
                for child in items {
                    walk(child, anon_view);
                }
            }
            _ => {}
        }
    }
    walk(&mut v, anon_view);
    Cow::Owned(v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_anonymized_for_self_service_only() {
        let frame = r#"{"t":"presence","users":[{"id":2,"name":"Alice Martin","avatar":{"picture":"/p.png"},"anon":{"name":"Helpdesk user","avatar":{"initials":"HE"}}},{"id":3,"name":"Rita"}]}"#;
        let tech: serde_json::Value = serde_json::from_str(&anonymize(frame, false)).unwrap();
        assert_eq!(tech["users"][0]["name"], "Alice Martin");
        assert!(tech["users"][0].get("anon").is_none(), "never sent as such");
        let user: serde_json::Value = serde_json::from_str(&anonymize(frame, true)).unwrap();
        assert_eq!(user["users"][0]["name"], "Helpdesk user");
        assert_eq!(user["users"][0]["avatar"]["initials"], "HE");
        assert_eq!(
            user["users"][1]["name"], "Rita",
            "requesters are not anonymized"
        );
        let plain = r#"{"t":"pong"}"#;
        assert!(
            matches!(anonymize(plain, true), std::borrow::Cow::Borrowed(_)),
            "no anon: untouched"
        );
        let no_avatar =
            r#"{"by":{"id":1,"name":"A","avatar":{"picture":"/x"},"anon":{"name":"H"}}}"#;
        let v: serde_json::Value = serde_json::from_str(&anonymize(no_avatar, true)).unwrap();
        assert!(
            v["by"].get("avatar").is_none(),
            "the real picture does not stay"
        );
    }

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
