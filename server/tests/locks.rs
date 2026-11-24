mod common;

use std::time::Duration;

use common::*;
use serde_json::{Value, json};

macro_rules! valkey_or_skip {
    () => {
        match valkey().await {
            Some(v) => v,
            None => return eprintln!("valkey-server not found: test skipped"),
        }
    };
}

const EDIT: &[(&str, &str)] = &[("read", "1"), ("update", "1")];

/// Connected and subscribed; returns the socket and its connection id.
async fn editor(addr: std::net::SocketAddr, tok: &str, room: &str) -> (Ws, String) {
    let mut ws = connect(addr, Some(ORIGIN), Some(tok)).await.unwrap();
    let hello = recv(&mut ws).await;
    send(&mut ws, json!({"v":1,"t":"sub","room":room})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    assert_eq!(
        recv_lock(&mut ws, room).await["holder"],
        Value::Null,
        "state sent after subscribing"
    );
    assert_eq!(
        recv_lock_scope(&mut ws, room, "solution").await["holder"],
        Value::Null
    );
    (ws, hello["conn"].as_str().unwrap().to_string())
}

async fn lock(ws: &mut Ws, room: &str, force: bool) -> Value {
    send(
        ws,
        json!({"v":1,"id":9,"t":"lock","room":room,"force":force}),
    )
    .await;
    recv_matching(ws, Duration::from_secs(3), |m| m["id"] == 9)
        .await
        .unwrap()
}

#[tokio::test]
async fn one_editor_at_a_time() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 10, "Alice").await;
    let bob = session(&vk, 11, "Bob").await;
    grant(&vk, &alice, "Ticket:5", EDIT).await;
    grant(&vk, &bob, "Ticket:5", EDIT).await;
    let (mut a, a_conn) = editor(addr, &alice, "Ticket:5").await;
    let (mut b, _) = editor(addr, &bob, "Ticket:5").await;

    let r = lock(&mut a, "Ticket:5", false).await;
    assert_eq!(r["t"], "lock");
    assert_eq!(r["holder"]["conn"], a_conn.as_str(), "Alice holds it");
    assert_eq!(r["holder"]["name"], "Alice");
    let seen = recv_lock(&mut b, "Ticket:5").await;
    assert_eq!(seen["holder"]["id"], 10, "Bob is told");

    let r = lock(&mut b, "Ticket:5", false).await;
    assert_eq!(r["holder"]["id"], 10, "Bob cannot take it");
    let r = lock(&mut b, "Ticket:5", true).await;
    assert_eq!(
        r["holder"]["id"], 10,
        "nor force it while Alice's tab is active"
    );

    // Renewal keeps the same holder and does not broadcast.
    assert_eq!(
        lock(&mut a, "Ticket:5", false).await["holder"]["since"],
        seen["holder"]["since"]
    );
    assert!(
        recv_matching(&mut b, Duration::from_millis(500), |m| m["t"] == "lock")
            .await
            .is_none()
    );

    // Alice's tab goes to the background: Bob may take over.
    send(&mut a, json!({"v":1,"t":"activity","active":false})).await;
    send(&mut a, json!({"v":1,"t":"ping"})).await;
    recv(&mut a).await;
    let r = lock(&mut b, "Ticket:5", true).await;
    assert_eq!(r["holder"]["id"], 11, "taken over");
    assert_eq!(
        recv_lock(&mut a, "Ticket:5").await["holder"]["id"],
        11,
        "Alice learns she lost it"
    );

    // Bob saves and releases.
    send(&mut b, json!({"v":1,"id":3,"t":"unlock","room":"Ticket:5"})).await;
    let r = recv_matching(&mut b, Duration::from_secs(3), |m| m["id"] == 3)
        .await
        .unwrap();
    assert_eq!(r["holder"], Value::Null);
    assert_eq!(recv_lock(&mut a, "Ticket:5").await["holder"], Value::Null);
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn disconnection_releases_and_newcomers_see_the_holder() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 20, "Alice").await;
    let bob = session(&vk, 21, "Bob").await;
    grant(&vk, &alice, "Ticket:6", EDIT).await;
    grant(&vk, &bob, "Ticket:6", EDIT).await;
    let (mut a, _) = editor(addr, &alice, "Ticket:6").await;
    lock(&mut a, "Ticket:6", false).await;

    let mut b = connect(addr, Some(ORIGIN), Some(&bob)).await.unwrap();
    recv(&mut b).await;
    send(&mut b, json!({"v":1,"t":"sub","room":"Ticket:6"})).await;
    assert_eq!(recv(&mut b).await["t"], "subscribed");
    assert_eq!(
        recv_lock(&mut b, "Ticket:6").await["holder"]["id"],
        20,
        "newcomer sees who edits"
    );

    a.close(None).await.unwrap();
    assert_eq!(
        recv_lock(&mut b, "Ticket:6").await["holder"],
        Value::Null,
        "closing the tab releases"
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn editing_needs_the_update_right() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let reader = session(&vk, 30, "Reader").await;
    grant(&vk, &reader, "Ticket:7", &[("read", "1"), ("update", "0")]).await;
    let (mut r, _) = editor(addr, &reader, "Ticket:7").await;
    let m = lock(&mut r, "Ticket:7", false).await;
    assert_eq!(
        (m["t"].as_str(), m["code"].as_str()),
        (Some("error"), Some("forbidden"))
    );
    let m = lock(&mut r, "Ticket:8", false).await;
    assert_eq!(m["code"], "forbidden", "not subscribed");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn a_lock_not_renewed_expires() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.locks.ttl_secs = 3;
    cfg.locks.sweep_secs = 1;
    let (srv, addr) = start(cfg).await;
    let alice = session(&vk, 40, "Alice").await;
    let bob = session(&vk, 41, "Bob").await;
    grant(&vk, &alice, "Ticket:9", EDIT).await;
    grant(&vk, &bob, "Ticket:9", EDIT).await;
    let (mut a, _) = editor(addr, &alice, "Ticket:9").await;
    let (mut b, _) = editor(addr, &bob, "Ticket:9").await;
    lock(&mut a, "Ticket:9", false).await;
    assert_eq!(recv_lock(&mut b, "Ticket:9").await["holder"]["id"], 40);
    // Alice stays connected but stops editing (no renewal).
    let m = recv_matching(&mut b, Duration::from_secs(6), |m| m["t"] == "lock")
        .await
        .unwrap();
    assert_eq!(m["holder"], Value::Null);
    let _ = &mut a;
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn one_solution_writer_at_a_time() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 50, "Alice").await;
    let bob = session(&vk, 51, "Bob").await;
    let carol = session(&vk, 52, "Carol").await;
    grant(&vk, &alice, "Ticket:11", &[("read", "1"), ("solve", "1")]).await;
    grant(
        &vk,
        &bob,
        "Ticket:11",
        &[("read", "1"), ("solve", "1"), ("update", "1")],
    )
    .await;
    grant(&vk, &carol, "Ticket:11", &[("read", "1"), ("update", "1")]).await;
    let (mut a, _) = editor(addr, &alice, "Ticket:11").await;
    let (mut b, _) = editor(addr, &bob, "Ticket:11").await;
    let (mut c, _) = editor(addr, &carol, "Ticket:11").await;

    send(
        &mut a,
        json!({"v":1,"id":1,"t":"lock","room":"Ticket:11","scope":"solution"}),
    )
    .await;
    let r = recv_matching(&mut a, Duration::from_secs(3), |m| m["id"] == 1)
        .await
        .unwrap();
    assert_eq!(
        (r["scope"].as_str(), r["holder"]["id"].as_u64()),
        (Some("solution"), Some(50))
    );
    assert_eq!(
        recv_lock_scope(&mut b, "Ticket:11", "solution").await["holder"]["id"],
        50
    );

    // Independent from the fields lock.
    assert_eq!(lock(&mut b, "Ticket:11", false).await["holder"]["id"], 51);
    send(
        &mut b,
        json!({"v":1,"id":2,"t":"lock","room":"Ticket:11","scope":"solution"}),
    )
    .await;
    let r = recv_matching(&mut b, Duration::from_secs(3), |m| m["id"] == 2)
        .await
        .unwrap();
    assert_eq!(
        r["holder"]["id"], 50,
        "Bob cannot write a solution meanwhile"
    );

    send(
        &mut c,
        json!({"v":1,"id":3,"t":"lock","room":"Ticket:11","scope":"solution"}),
    )
    .await;
    let r = recv_matching(&mut c, Duration::from_secs(3), |m| m["id"] == 3)
        .await
        .unwrap();
    assert_eq!(r["code"], "forbidden", "solving needs GLPI's solve right");

    a.close(None).await.unwrap();
    assert_eq!(
        recv_lock_scope(&mut b, "Ticket:11", "solution").await["holder"],
        Value::Null
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn composing_is_shown_in_presence() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 60, "Alice").await;
    let bob = session(&vk, 61, "Bob").await;
    grant(&vk, &alice, "Ticket:12", &[("read", "1")]).await;
    grant(&vk, &bob, "Ticket:12", &[("read", "1")]).await;
    let (mut a, _) = editor(addr, &alice, "Ticket:12").await;
    let (mut b, _) = editor(addr, &bob, "Ticket:12").await;
    recv_presence(&mut a, "Ticket:12").await;

    send(
        &mut a,
        json!({"v":1,"t":"compose","room":"Ticket:12","kind":"followup"}),
    )
    .await;
    let p = recv_matching(&mut b, Duration::from_secs(3), |m| {
        m["t"] == "presence"
            && m["users"]
                .as_array()
                .unwrap()
                .iter()
                .any(|u| u["composing"] == "followup")
    })
    .await
    .expect("Bob sees Alice writing");
    assert_eq!(
        p["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["id"] == 60)
            .unwrap()["composing"],
        "followup"
    );

    send(
        &mut a,
        json!({"v":1,"t":"compose","room":"Ticket:12","kind":null}),
    )
    .await;
    recv_matching(&mut b, Duration::from_secs(3), |m| {
        m["t"] == "presence"
            && m["users"]
                .as_array()
                .unwrap()
                .iter()
                .all(|u| u.get("composing").is_none())
    })
    .await
    .expect("done writing");

    send(
        &mut a,
        json!({"v":1,"id":4,"t":"compose","room":"Ticket:12","kind":"<script>"}),
    )
    .await;
    assert_eq!(recv(&mut a).await["code"], "bad_request");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn fields_held_for_a_solution_or_a_pending_answer() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tech = session(&vk, 70, "Tech").await;
    let other = session(&vk, 71, "Other").await;
    let requester = session(&vk, 72, "Requester").await;
    // An assigned technician may solve without the general update right.
    grant(
        &vk,
        &tech,
        "Ticket:13",
        &[("read", "1"), ("solve", "1"), ("add_followup", "1")],
    )
    .await;
    grant(&vk, &other, "Ticket:13", EDIT).await;
    grant(
        &vk,
        &requester,
        "Ticket:13",
        &[("read", "1"), ("add_followup", "0")],
    )
    .await;
    let (mut t, _) = editor(addr, &tech, "Ticket:13").await;
    let (mut o, _) = editor(addr, &other, "Ticket:13").await;
    let (mut q, _) = editor(addr, &requester, "Ticket:13").await;

    send(
        &mut t,
        json!({"v":1,"id":1,"t":"lock","room":"Ticket:13","reason":"solution"}),
    )
    .await;
    let r = recv_matching(&mut t, Duration::from_secs(3), |m| m["id"] == 1)
        .await
        .unwrap();
    assert_eq!(
        (r["holder"]["id"].as_u64(), r["holder"]["reason"].as_str()),
        (Some(70), Some("solution"))
    );
    let seen = recv_lock(&mut o, "Ticket:13").await;
    assert_eq!(
        seen["holder"]["reason"], "solution",
        "the others know why the fields are held"
    );
    assert_eq!(
        lock(&mut o, "Ticket:13", false).await["holder"]["id"],
        70,
        "and cannot edit them"
    );

    // Same holder, other reason: told again.
    send(
        &mut t,
        json!({"v":1,"t":"lock","room":"Ticket:13","reason":"pending"}),
    )
    .await;
    assert_eq!(
        recv_lock(&mut o, "Ticket:13").await["holder"]["reason"],
        "pending"
    );
    // A renewal for the same reason is not broadcast.
    send(
        &mut t,
        json!({"v":1,"t":"lock","room":"Ticket:13","reason":"pending"}),
    )
    .await;
    assert!(
        recv_matching(&mut o, Duration::from_millis(500), |m| m["t"] == "lock")
            .await
            .is_none()
    );

    send(
        &mut q,
        json!({"v":1,"id":2,"t":"lock","room":"Ticket:13","reason":"pending"}),
    )
    .await;
    let r = recv_matching(&mut q, Duration::from_secs(3), |m| m["id"] == 2)
        .await
        .unwrap();
    assert_eq!(r["code"], "forbidden", "needs the right to add the answer");
    send(
        &mut q,
        json!({"v":1,"id":3,"t":"lock","room":"Ticket:13","reason":"delete_all"}),
    )
    .await;
    let r = recv_matching(&mut q, Duration::from_secs(3), |m| m["id"] == 3)
        .await
        .unwrap();
    assert_eq!(r["code"], "bad_request");
    srv.stop().await.unwrap();
}
