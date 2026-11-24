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

const TECH: &[(&str, &str)] = &[
    ("read", "1"),
    ("add_followup", "1"),
    ("see_private_followup", "1"),
    ("solve", "1"),
];
const REQUESTER: &[(&str, &str)] = &[("read", "1"), ("add_followup", "1")];

async fn member(addr: std::net::SocketAddr, tok: &str, room: &str) -> Ws {
    let mut ws = connect(addr, Some(ORIGIN), Some(tok)).await.unwrap();
    recv(&mut ws).await; // hello
    send(&mut ws, json!({"v":1,"t":"sub","room":room})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    ws
}

async fn next_t(ws: &mut Ws, t: &str) -> Option<Value> {
    recv_matching(ws, Duration::from_secs(3), |m| m["t"] == t).await
}

async fn quiet(ws: &mut Ws, t: &str) -> bool {
    recv_matching(ws, Duration::from_millis(500), |m| m["t"] == t)
        .await
        .is_none()
}

fn write(html: &str, private: bool) -> Value {
    json!({"v":1,"t":"draft","room":"Ticket:5","kind":"followup","html":html,"private":private})
}

#[tokio::test]
async fn followers_see_the_draft_live_members_only_who_writes() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 10, "Alice").await;
    let bob = session(&vk, 11, "Bob").await;
    let reader = session(&vk, 12, "Reader").await;
    grant(&vk, &alice, "Ticket:5", TECH).await;
    grant(&vk, &bob, "Ticket:5", TECH).await;
    grant(&vk, &reader, "Ticket:5", &[("read", "1")]).await;
    let mut a = member(addr, &alice, "Ticket:5").await;
    let mut b = member(addr, &bob, "Ticket:5").await;
    let mut r = member(addr, &reader, "Ticket:5").await;

    send(&mut a, write("<p>Bonjour</p>", false)).await;
    let info = next_t(&mut b, "draft_info").await.unwrap();
    assert_eq!(info["writer"]["id"], 10);
    assert_eq!(info["away"], false);
    assert!(
        info.get("draft").is_none() && !info.to_string().contains("Bonjour"),
        "no content to members"
    );
    assert!(
        quiet(&mut r, "draft_info").await,
        "not to those who cannot add followups"
    );

    send(
        &mut b,
        json!({"v":1,"id":1,"t":"draft_watch","room":"Ticket:5","kind":"followup","on":true}),
    )
    .await;
    let d = next_t(&mut b, "draft").await.unwrap();
    assert_eq!(d["draft"]["html"], "<p>Bonjour</p>");
    assert_eq!(d["draft"]["writer"]["name"], "Alice");

    send(&mut a, write("<p>Bonjour, voici</p>", false)).await;
    assert_eq!(
        next_t(&mut b, "draft").await.unwrap()["draft"]["html"],
        "<p>Bonjour, voici</p>",
        "live"
    );

    send(
        &mut r,
        json!({"v":1,"id":2,"t":"draft_watch","room":"Ticket:5","kind":"followup","on":true}),
    )
    .await;
    assert_eq!(next_t(&mut r, "error").await.unwrap()["code"], "forbidden");

    // Bob cannot write the same shared draft while Alice does.
    send(
        &mut b,
        json!({"v":1,"id":3,"t":"draft","room":"Ticket:5","kind":"followup","html":"x"}),
    )
    .await;
    assert_eq!(next_t(&mut b, "error").await.unwrap()["code"], "locked");

    // Sent: followers and members are told it is over.
    send(
        &mut a,
        json!({"v":1,"t":"draft_end","room":"Ticket:5","kind":"followup"}),
    )
    .await;
    assert_eq!(next_t(&mut b, "draft").await.unwrap()["draft"], Value::Null);
    assert_eq!(
        next_t(&mut b, "draft_info").await.unwrap()["writer"],
        Value::Null
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn private_drafts_stay_with_those_who_see_private_followups() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 20, "Alice").await;
    let req = session(&vk, 21, "Requester").await;
    grant(&vk, &alice, "Ticket:5", TECH).await;
    grant(&vk, &req, "Ticket:5", REQUESTER).await;
    let mut a = member(addr, &alice, "Ticket:5").await;
    let mut q = member(addr, &req, "Ticket:5").await;

    send(&mut a, write("<p>interne</p>", true)).await;
    assert!(
        quiet(&mut q, "draft_info").await,
        "the requester does not learn about it"
    );
    send(
        &mut q,
        json!({"v":1,"id":1,"t":"draft_watch","room":"Ticket:5","kind":"followup","on":true}),
    )
    .await;
    assert_eq!(next_t(&mut q, "error").await.unwrap()["code"], "forbidden");

    // A draft that becomes private stops reaching followers who cannot see it.
    send(&mut a, write("<p>public</p>", false)).await;
    assert_eq!(
        next_t(&mut q, "draft_info").await.unwrap()["private"],
        false
    );
    send(
        &mut q,
        json!({"v":1,"id":2,"t":"draft_watch","room":"Ticket:5","kind":"followup","on":true}),
    )
    .await;
    assert_eq!(
        next_t(&mut q, "draft").await.unwrap()["draft"]["html"],
        "<p>public</p>"
    );
    send(&mut a, write("<p>finalement interne</p>", true)).await;
    assert!(quiet(&mut q, "draft").await);
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn a_draft_left_behind_can_be_taken_over() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 30, "Alice").await;
    let bob = session(&vk, 31, "Bob").await;
    grant(&vk, &alice, "Ticket:5", TECH).await;
    grant(&vk, &bob, "Ticket:5", TECH).await;
    let mut a = member(addr, &alice, "Ticket:5").await;
    let mut b = member(addr, &bob, "Ticket:5").await;
    send(&mut a, write("<p>presque fini</p>", false)).await;
    next_t(&mut b, "draft_info").await.unwrap();

    send(
        &mut b,
        json!({"v":1,"id":1,"t":"draft_take","room":"Ticket:5","kind":"followup"}),
    )
    .await;
    assert_eq!(
        next_t(&mut b, "error").await.unwrap()["code"],
        "locked",
        "Alice is still writing"
    );

    a.close(None).await.unwrap();
    let info = next_t(&mut b, "draft_info").await.unwrap();
    assert_eq!(
        (info["writer"]["id"].as_u64(), info["away"].as_bool()),
        (Some(30), Some(true)),
        "left behind"
    );

    send(
        &mut b,
        json!({"v":1,"id":2,"t":"draft_take","room":"Ticket:5","kind":"followup"}),
    )
    .await;
    let d = recv_matching(&mut b, Duration::from_secs(3), |m| m["id"] == 2)
        .await
        .unwrap();
    assert_eq!(d["t"], "draft");
    assert_eq!(
        d["draft"]["html"], "<p>presque fini</p>",
        "Bob gets the text to continue"
    );
    assert_eq!(d["draft"]["writer"]["id"], 31);

    // A newcomer is told who writes now, at subscription.
    let mut a2 = member(addr, &alice, "Ticket:5").await;
    let info = next_t(&mut a2, "draft_info").await.unwrap();
    assert_eq!(
        (info["writer"]["id"].as_u64(), info["away"].as_bool()),
        (Some(31), Some(false))
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn limits_and_rights() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 40, "Alice").await;
    grant(&vk, &alice, "Ticket:5", REQUESTER).await;
    let mut a = member(addr, &alice, "Ticket:5").await;
    send(
        &mut a,
        json!({"v":1,"t":"draft","room":"Ticket:5","kind":"followup","html":"x".repeat(49 * 1024)}),
    )
    .await;
    assert_eq!(next_t(&mut a, "error").await.unwrap()["code"], "too_large");
    send(
        &mut a,
        json!({"v":1,"t":"draft","room":"Ticket:5","kind":"solution","html":"x"}),
    )
    .await;
    assert_eq!(
        next_t(&mut a, "error").await.unwrap()["code"],
        "forbidden",
        "solving needs solve"
    );
    send(
        &mut a,
        json!({"v":1,"t":"draft","room":"Ticket:6","kind":"followup","html":"x"}),
    )
    .await;
    assert_eq!(
        next_t(&mut a, "error").await.unwrap()["code"],
        "forbidden",
        "not subscribed"
    );
    srv.stop().await.unwrap();
}
