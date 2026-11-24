//! Cross-language check: a token and a grant issued by the real plugin PHP code
//! are accepted by the server (same keys, same hashing, same flags).

mod common;

use std::process::Command;

use common::*;
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
