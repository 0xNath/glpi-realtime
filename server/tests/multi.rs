//! Two server instances on the same Valkey (behind one nginx, or during a rolling restart):
//! what one user does on instance A reaches a user on instance B.

mod common;

use std::time::Duration;

use common::*;
use fred::prelude::*;
use serde_json::{Value, json};

macro_rules! valkey_or_skip {
    () => {
        match valkey().await {
            Some(v) => v,
            None => return eprintln!("valkey-server not found: test skipped"),
        }
    };
}

async fn on_item(addr: std::net::SocketAddr, tok: &str, room: &str) -> Ws {
    let mut ws = connect(addr, Some(ORIGIN), Some(tok)).await.unwrap();
    recv(&mut ws).await;
    send(&mut ws, json!({"v":1,"t":"sub","room":room})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    ws
}

#[tokio::test]
async fn presence_locks_drafts_and_events_cross_instances() {
    let vk = valkey_or_skip!();
    let (a_srv, a_addr) = start(config(&vk)).await;
    let (b_srv, b_addr) = start(config(&vk)).await;
    let alice = session(&vk, 10, "Alice").await;
    let bob = session(&vk, 11, "Bob").await;
    let flags = [("read", "1"), ("update", "1"), ("add_followup", "1")];
    grant(&vk, &alice, "Ticket:5", &flags).await;
    grant(&vk, &bob, "Ticket:5", &flags).await;

    let mut a = on_item(a_addr, &alice, "Ticket:5").await; // instance A
    recv_presence(&mut a, "Ticket:5").await;
    let mut b = on_item(b_addr, &bob, "Ticket:5").await; // instance B

    // Presence.
    assert_eq!(present(&recv_presence(&mut b, "Ticket:5").await), [10, 11]);
    assert_eq!(
        present(&recv_presence(&mut a, "Ticket:5").await),
        [10, 11],
        "A learns about Bob on B"
    );

    // Fields lock taken on A, seen on B, refused to Bob.
    send(&mut a, json!({"v":1,"id":1,"t":"lock","room":"Ticket:5"})).await;
    let seen = recv_matching(&mut b, Duration::from_secs(3), |m| {
        m["t"] == "lock" && m["scope"] == "fields" && !m["holder"].is_null()
    })
    .await
    .unwrap();
    assert_eq!(seen["holder"]["id"], 10);
    send(&mut b, json!({"v":1,"id":2,"t":"lock","room":"Ticket:5"})).await;
    let r = recv_matching(&mut b, Duration::from_secs(3), |m| m["id"] == 2)
        .await
        .unwrap();
    assert_eq!(r["holder"]["id"], 10, "one lock for all instances");

    // Shared draft written on A, followed from B.
    send(
        &mut a,
        json!({"v":1,"t":"draft","room":"Ticket:5","kind":"followup","html":"<p>sur A</p>"}),
    )
    .await;
    recv_matching(&mut b, Duration::from_secs(3), |m| {
        m["t"] == "draft_info" && !m["writer"].is_null()
    })
    .await
    .unwrap();
    send(
        &mut b,
        json!({"v":1,"t":"draft_watch","room":"Ticket:5","kind":"followup","on":true}),
    )
    .await;
    assert_eq!(
        recv_matching(&mut b, Duration::from_secs(3), |m| m["t"] == "draft")
            .await
            .unwrap()["draft"]["html"],
        "<p>sur A</p>"
    );
    send(
        &mut a,
        json!({"v":1,"t":"draft","room":"Ticket:5","kind":"followup","html":"<p>sur A, suite</p>"}),
    )
    .await;
    assert_eq!(
        recv_matching(&mut b, Duration::from_secs(3), |m| m["t"] == "draft")
            .await
            .unwrap()["draft"]["html"],
        "<p>sur A, suite</p>",
        "live across instances"
    );

    // Item events reach both instances.
    let batch: Value = json!({"room":"Ticket:5","events":[{"kind":"item.update"}]});
    let _: i64 = vk.client.publish("rt:ev", batch.to_string()).await.unwrap();
    for ws in [&mut a, &mut b] {
        assert!(
            recv_matching(ws, Duration::from_secs(3), |m| m["t"] == "event")
                .await
                .is_some()
        );
    }

    // Instance A stops (restart): Alice's presence and lock go for Bob too, in any order.
    a_srv.stop().await.unwrap();
    let (mut left, mut freed) = (false, false);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while !(left && freed) && tokio::time::Instant::now() < deadline {
        let Some(m) = recv_matching(&mut b, Duration::from_secs(1), |m| {
            m["t"] == "presence" || m["t"] == "lock"
        })
        .await
        else {
            continue;
        };
        left |= m["t"] == "presence" && present(&m) == [11];
        freed |= m["t"] == "lock" && m["scope"] == "fields" && m["holder"].is_null();
    }
    assert!(left, "Alice left with her instance");
    assert!(freed, "the lock of a stopped instance is released");
    b_srv.stop().await.unwrap();
}
