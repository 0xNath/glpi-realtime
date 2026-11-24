mod common;

use std::time::Duration;

use common::*;
use fred::prelude::*;
use futures_util::SinkExt;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

macro_rules! valkey_or_skip {
    () => {
        match valkey().await {
            Some(v) => v,
            None => {
                eprintln!("valkey-server not found: test skipped");
                return;
            }
        }
    };
}

#[tokio::test]
async fn handshake_rejections() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tok = session(&vk, 2, "glpi").await;

    let e = connect(addr, None, Some(&tok)).await.unwrap_err();
    assert_eq!(http_status(&e), Some(403), "missing Origin");
    let e = connect(addr, Some("https://evil.test"), Some(&tok))
        .await
        .unwrap_err();
    assert_eq!(http_status(&e), Some(403), "foreign Origin");
    let e = connect(addr, Some(ORIGIN), None).await.unwrap_err();
    assert_eq!(http_status(&e), Some(401), "no cookie");
    let e = connect(addr, Some(ORIGIN), Some("deadbeef"))
        .await
        .unwrap_err();
    assert_eq!(http_status(&e), Some(401), "malformed token");
    let unknown = "f".repeat(64);
    let e = connect(addr, Some(ORIGIN), Some(&unknown))
        .await
        .unwrap_err();
    assert_eq!(http_status(&e), Some(401), "unknown token");

    srv.stop().await.unwrap();
}

#[tokio::test]
async fn hello_ping_and_versioning() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tok = session(&vk, 2, "glpi").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();

    let hello = recv(&mut ws).await;
    assert_eq!(hello["t"], "hello");
    assert_eq!(hello["v"], 1);
    assert_eq!(hello["user"]["id"], 2);
    assert_eq!(hello["user"]["name"], "glpi");

    send(&mut ws, json!({"v":1,"id":5,"t":"ping"})).await;
    let pong = recv(&mut ws).await;
    assert_eq!(
        (pong["t"].as_str(), pong["id"].as_u64()),
        (Some("pong"), Some(5))
    );

    send(&mut ws, json!({"v":2,"id":6,"t":"ping"})).await;
    let e = recv(&mut ws).await;
    assert_eq!(
        (e["code"].as_str(), e["id"].as_u64()),
        (Some("unsupported_version"), Some(6))
    );

    ws.send(Message::Text("not json".into())).await.unwrap();
    assert_eq!(recv(&mut ws).await["code"], "bad_request");

    ws.send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    assert_eq!(recv(&mut ws).await["code"], "bad_request");

    srv.stop().await.unwrap();
}

#[tokio::test]
async fn subscribe_requires_a_grant_written_by_glpi() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 10, "alice").await;
    let bob = session(&vk, 11, "bob").await;
    grant(
        &vk,
        &alice,
        "Ticket:42",
        &[("read", "1"), ("see_private_fup", "0")],
    )
    .await;

    let mut a = connect(addr, Some(ORIGIN), Some(&alice)).await.unwrap();
    let mut b = connect(addr, Some(ORIGIN), Some(&bob)).await.unwrap();
    recv(&mut a).await;
    recv(&mut b).await;

    send(&mut a, json!({"v":1,"id":1,"t":"sub","room":"Ticket:42"})).await;
    let r = recv(&mut a).await;
    assert_eq!(
        (r["t"].as_str(), r["room"].as_str(), r["id"].as_u64()),
        (Some("subscribed"), Some("Ticket:42"), Some(1))
    );

    // Bob has no grant for this ticket: GLPI never displayed it to him.
    send(&mut b, json!({"v":1,"id":1,"t":"sub","room":"Ticket:42"})).await;
    assert_eq!(recv(&mut b).await["code"], "forbidden");

    // A grant on another session is not reusable, and read=0 is not a grant.
    grant(&vk, &bob, "Ticket:43", &[("read", "0")]).await;
    send(&mut b, json!({"v":1,"t":"sub","room":"Ticket:43"})).await;
    assert_eq!(recv(&mut b).await["code"], "forbidden");

    // Only allowed item types, well-formed ids.
    send(&mut a, json!({"v":1,"t":"sub","room":"User:1"})).await;
    assert_eq!(recv(&mut a).await["code"], "bad_request");
    send(&mut a, json!({"v":1,"t":"sub","room":"Ticket:0"})).await;
    assert_eq!(recv(&mut a).await["code"], "bad_request");

    send(&mut a, json!({"v":1,"t":"unsub","room":"Ticket:42"})).await;
    assert_eq!(recv(&mut a).await["t"], "unsubscribed");

    srv.stop().await.unwrap();
}

#[tokio::test]
async fn room_limit_per_connection() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.limits.max_rooms_per_connection = 2;
    let (srv, addr) = start(cfg).await;
    let tok = session(&vk, 3, "u").await;
    for id in 1..=3 {
        grant(&vk, &tok, &format!("Ticket:{id}"), &[("read", "1")]).await;
    }
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await;
    for id in 1..=2 {
        send(
            &mut ws,
            json!({"v":1,"t":"sub","room":format!("Ticket:{id}")}),
        )
        .await;
        assert_eq!(recv(&mut ws).await["t"], "subscribed");
    }
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:3"})).await;
    assert_eq!(recv(&mut ws).await["code"], "too_many_rooms");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn revocation_by_sweep() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.revocation.sweep_interval_secs = 1;
    let (srv, addr) = start(cfg).await;
    let tok = session(&vk, 4, "u").await;
    let other = session(&vk, 5, "v").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    let mut keep = connect(addr, Some(ORIGIN), Some(&other)).await.unwrap();
    recv(&mut ws).await;
    recv(&mut keep).await;

    let _: i64 = vk
        .client
        .del(format!("rt:s:{}", glpi_realtime::auth::token_hash(&tok)))
        .await
        .unwrap();
    let bye = recv(&mut ws).await;
    assert_eq!(
        (bye["t"].as_str(), bye["reason"].as_str()),
        (Some("bye"), Some("revoked"))
    );
    assert_eq!(close_code(&mut ws).await, Some(CloseCode::from(4001)));

    // The other session is untouched.
    send(&mut keep, json!({"v":1,"t":"ping"})).await;
    assert_eq!(recv(&mut keep).await["t"], "pong");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn revocation_by_keyspace_notification_is_immediate() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.revocation.sweep_interval_secs = 3600;
    cfg.revocation.keyspace_events = true;
    let (srv, addr) = start(cfg).await;
    let tok = session(&vk, 6, "u").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await;
    tokio::time::sleep(Duration::from_millis(300)).await; // subscriber ready

    let _: i64 = vk
        .client
        .del(format!("rt:s:{}", glpi_realtime::auth::token_hash(&tok)))
        .await
        .unwrap();
    let bye = recv_within(&mut ws, Duration::from_secs(1))
        .await
        .expect("no bye within 1s");
    assert_eq!(bye["reason"], "revoked");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn connection_limit_per_user() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.limits.max_connections_per_user = 2;
    let (srv, addr) = start(cfg).await;
    let tok = session(&vk, 7, "u").await;
    let _a = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    let mut b = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    let e = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap_err();
    assert_eq!(http_status(&e), Some(429));

    // Closing one frees a slot.
    b.close(None).await.unwrap();
    drop(b);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(connect(addr, Some(ORIGIN), Some(&tok)).await.is_ok());
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn rate_limit_then_policy_close() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.limits.messages_per_second = 1;
    cfg.limits.burst = 2;
    cfg.limits.max_violations = 3;
    let (srv, addr) = start(cfg).await;
    let tok = session(&vk, 8, "u").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await;
    for _ in 0..10 {
        send(&mut ws, json!({"v":1,"t":"ping"})).await;
    }
    let mut seen = Vec::new();
    while let Some(m) = recv_within(&mut ws, Duration::from_secs(2)).await {
        let label = m["code"]
            .as_str()
            .or(m["reason"].as_str())
            .or(m["t"].as_str())
            .unwrap()
            .to_string();
        seen.push(label);
    }
    assert_eq!(
        seen,
        [
            "pong",
            "pong",
            "rate_limited",
            "rate_limited",
            "rate_limited",
            "policy"
        ]
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn oversized_message_closes_connection() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.limits.max_message_bytes = 1024;
    let (srv, addr) = start(cfg).await;
    let tok = session(&vk, 9, "u").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await;
    let _ = ws.send(Message::Text("x".repeat(4096).into())).await;
    let code = close_code(&mut ws).await;
    assert!(matches!(code, None | Some(CloseCode::Size)), "got {code:?}");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn idle_client_is_dropped() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.limits.ping_interval_secs = 1;
    cfg.limits.idle_timeout_secs = 2;
    let (srv, addr) = start(cfg).await;
    let tok = session(&vk, 12, "u").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await;
    assert_eq!(srv.registry.len(), 1);
    // Not reading means not answering server pings.
    tokio::time::sleep(Duration::from_millis(3500)).await;
    // The server has given up on the connection and forgotten it.
    assert_eq!(srv.registry.len(), 0);
    // What the client still manages to read before its (late) pongs hit a closed
    // socket depends on timing: either `bye{idle}` or a transport error, never more traffic.
    let mut texts = Vec::new();
    while let Some(m) = recv_within(&mut ws, Duration::from_secs(1)).await {
        texts.push(m);
    }
    assert!(
        texts
            .iter()
            .all(|m| m["t"] == "bye" && m["reason"] == "idle"),
        "{texts:?}"
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn graceful_shutdown_says_bye() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tok = session(&vk, 13, "u").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await;
    let stopping = tokio::spawn(srv.stop());
    let bye = recv(&mut ws).await;
    assert_eq!(bye["reason"], "shutdown");
    assert_eq!(close_code(&mut ws).await, Some(CloseCode::Restart));
    stopping.await.unwrap().unwrap();
}

#[tokio::test]
async fn health_endpoint() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let (code, body) = http_get(addr, "/health").await;
    assert_eq!(code, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["valkey"], true);
    srv.stop().await.unwrap();
}

/// Valkey protected by an ACL user: the server authenticates, the anonymous default user
/// is disabled.
#[tokio::test]
async fn valkey_acl_user() {
    let Some(vk) = valkey_with(
        &[
            "--user",
            "default",
            "off",
            "--user",
            "glpi-rt",
            "on",
            ">s3cret",
            "~rt:*",
            "&rt:*",
            "&__keyspace@*__:rt:*",
            "+@all",
        ],
        Some(("glpi-rt", "s3cret")),
    )
    .await
    else {
        return eprintln!("valkey-server not found: test skipped");
    };
    let mut cfg = config(&vk);
    cfg.valkey.username = Some("glpi-rt".into());
    cfg.valkey.password = Some("s3cret".into());
    let (srv, addr) = start(cfg).await;
    let tok = session(&vk, 5, "Alice").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    assert_eq!(recv(&mut ws).await["t"], "hello");
    srv.stop().await.unwrap();

    let mut bad = config(&vk);
    bad.valkey.username = Some("glpi-rt".into());
    bad.valkey.password = Some("wrong".into());
    assert!(
        glpi_realtime::server::start(bad, None).await.is_err(),
        "wrong password: refused at start"
    );
}

/// What the plugin's configuration page reads (health checks).
#[tokio::test]
async fn instances_publish_their_status_for_glpi() {
    let vk = valkey_or_skip!();
    let (srv, _) = start(config(&vk)).await;
    let mut found = None;
    for _ in 0..50 {
        let keys: Vec<String> = vk
            .client
            .custom(fred::cmd!("KEYS"), vec!["rt:srv:*"])
            .await
            .unwrap_or_default();
        if let Some(k) = keys.first() {
            let raw: Option<String> = vk.client.get(k).await.unwrap();
            found = raw;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let s: serde_json::Value = serde_json::from_str(&found.expect("status published")).unwrap();
    assert_eq!(s["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(s["cookie_name"], "glpi_rt");
    assert_eq!(s["allowed_origins"][0], ORIGIN);
    assert_eq!(
        s["keyspace_config"], "ok",
        "the test Valkey has notify-keyspace-events Kgx"
    );
    srv.stop().await.unwrap();
    let left: Vec<String> = vk
        .client
        .custom(fred::cmd!("KEYS"), vec!["rt:srv:*"])
        .await
        .unwrap_or_default();
    assert!(left.is_empty(), "removed when the instance stops");
}
