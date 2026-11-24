//! Cross-language check: a token and a grant issued by the real plugin PHP code
//! are accepted by the server (same keys, same hashing, same flags).

mod common;

use std::process::Command;

use common::*;
use fred::interfaces::PubsubInterface;
use fred::types::Value;
use serde_json::json;

fn php() -> Option<&'static str> {
    ["php-legacy", "php"].into_iter().find(|b| {
        Command::new(b)
            .args([
                "-d",
                "extension=igbinary",
                "-d",
                "extension=redis",
                "-r",
                "exit(class_exists('Redis') ? 0 : 1);",
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

fn run_php(php: &str, script: &str, args: &[String]) -> std::process::Output {
    let script = format!("{}/../plugin/tests/{script}", env!("CARGO_MANIFEST_DIR"));
    let out = Command::new(php)
        .args(["-d", "extension=igbinary", "-d", "extension=redis", &script])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{script}: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

#[tokio::test]
async fn token_issued_by_the_plugin_is_accepted() {
    let Some(vk) = valkey().await else {
        return eprintln!("valkey missing: skipped");
    };
    let Some(php) = php() else {
        return eprintln!("php with redis missing: skipped");
    };
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../plugin/tests/issue_token.php"
    );
    let out = Command::new(php)
        .args(["-d", "extension=igbinary", "-d", "extension=redis", script])
        .args([
            vk.socket.display().to_string(),
            "5".into(),
            "Bob Durand".into(),
            "42".into(),
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let issued: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let token = issued["cookie"]["token"].as_str().unwrap().to_string();
    assert_eq!(issued["cookie"]["name"], "glpi_rt");
    assert_eq!(
        issued["hash"].as_str().unwrap(),
        glpi_realtime::auth::token_hash(&token)
    );

    let (srv, addr) = start(config(&vk)).await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&token)).await.unwrap();
    let hello = recv(&mut ws).await;
    assert_eq!(hello["user"]["id"], 5);
    assert_eq!(hello["user"]["name"], "Bob Durand");

    // The avatar computed by the plugin reaches the presence list.
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:42"})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    let p = recv_presence(&mut ws, "Ticket:42").await;
    assert_eq!(
        p["users"][0]["avatar"]["picture"],
        "/front/document.send.php?file=_pictures/ab/5.png"
    );
    assert_eq!(p["users"][0]["avatar"]["initials"], "BO");
    send(&mut ws, json!({"v":1,"t":"unsub","room":"Ticket:42"})).await;
    assert_eq!(recv(&mut ws).await["t"], "unsubscribed");

    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:42"})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:43"})).await;
    assert_eq!(recv(&mut ws).await["code"], "forbidden");
    srv.stop().await.unwrap();
}

/// Hooks of the real plugin code → Valkey → server → the right browsers, filtered.
#[tokio::test]
async fn events_published_by_the_plugin_reach_clients() {
    let Some(vk) = valkey().await else {
        return eprintln!("valkey missing: skipped");
    };
    let Some(php) = php() else {
        return eprintln!("php with redis missing: skipped");
    };
    let sock = vk.socket.display().to_string();
    let out = run_php(
        php,
        "issue_token.php",
        &[sock.clone(), "5".into(), "Rita".into(), "42".into()],
    );
    let issued: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let token = issued["cookie"]["token"].as_str().unwrap().to_string();

    let (srv, addr) = start(config(&vk)).await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&token)).await.unwrap();
    recv(&mut ws).await;
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:42"})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    // Wait until the server listens to events.
    for _ in 0..100 {
        let n: Vec<Value> = vk.client.pubsub_numsub("rt:ev").await.unwrap();
        if n.get(1).and_then(Value::as_i64).is_some_and(|c| c > 0) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    run_php(
        php,
        "publish_events.php",
        &[sock.clone(), "9".into(), "42".into(), "changes".into()],
    );
    let mut got = vec![];
    while let Some(m) = recv_within(&mut ws, std::time::Duration::from_millis(700)).await {
        got.push(m);
    }
    let kinds: Vec<(&str, &str)> = got
        .iter()
        .map(|m| (m["t"].as_str().unwrap(), m["kind"].as_str().unwrap_or("")))
        .collect();
    assert_eq!(
        kinds,
        [
            ("event", "item.update"),
            ("event", "followup.add"),
            ("event", "actor.add"),
            ("notification", "status_changed"), // Rita is the requester
            ("notification", "commented"),
            ("notification", "assigned"),
        ],
        "the private followup is filtered out: {got:?}"
    );
    assert_eq!(got[0]["fields"], json!(["status"]));
    assert_eq!(got[1]["item"]["id"], 1);
    assert_eq!(got[5]["by"], json!({"id":9,"name":"Tech 9"}));
    assert_eq!(got[5]["room"], "Ticket:42");
    assert_eq!(got[5]["alert"], true);

    // Removing an actor revokes every grant: the next `sub` is refused until GLPI says so.
    run_php(
        php,
        "publish_events.php",
        &[sock, "9".into(), "42".into(), "unassign".into()],
    );
    assert_eq!(recv(&mut ws).await["t"], "regrant");
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:42"})).await;
    assert_eq!(recv(&mut ws).await["code"], "forbidden");
    srv.stop().await.unwrap();
}
