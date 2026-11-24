mod common;

use std::time::Duration;

use common::*;
use fred::prelude::*;
use glpi_realtime::auth::token_hash;
use serde_json::{Value, json};

macro_rules! valkey_or_skip {
    () => {
        match valkey().await {
            Some(v) => v,
            None => return eprintln!("valkey-server not found: test skipped"),
        }
    };
}

async fn joined(addr: std::net::SocketAddr, tok: &str, room: &str) -> Ws {
    let mut ws = connect(addr, Some(ORIGIN), Some(tok)).await.unwrap();
    recv(&mut ws).await; // hello
    send(&mut ws, json!({"v":1,"t":"sub","room":room})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    ws
}

/// Publishes as the plugin does. The server subscribes asynchronously at start-up:
/// the first publication of a test waits until someone listens.
async fn publish(vk: &Valkey, batch: Value) {
    for _ in 0..100 {
        let n: i64 = vk.client.publish("rt:ev", batch.to_string()).await.unwrap();
        if n > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("nobody listens on rt:ev");
}

/// Next frame that is neither presence nor pong.
async fn next(ws: &mut Ws) -> Option<Value> {
    recv_within(ws, Duration::from_millis(700)).await
}

fn followup(id: u64, private: bool, author: u64) -> Value {
    json!({"kind":"followup.add","item":{"type":"ITILFollowup","id":id},
           "vis":{"right":"followup","private":private,"uids":[author]}})
}

#[tokio::test]
async fn events_are_filtered_with_each_grant() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tech = session(&vk, 10, "Tech").await;
    let user = session(&vk, 11, "Requester").await;
    let blind = session(&vk, 12, "NoFollowups").await;
    grant(
        &vk,
        &tech,
        "Ticket:5",
        &[
            ("read", "1"),
            ("see_public_followup", "1"),
            ("see_private_followup", "1"),
        ],
    )
    .await;
    grant(
        &vk,
        &user,
        "Ticket:5",
        &[
            ("read", "1"),
            ("see_public_followup", "1"),
            ("see_private_followup", "0"),
        ],
    )
    .await;
    grant(&vk, &blind, "Ticket:5", &[("read", "1")]).await;
    let mut t = joined(addr, &tech, "Ticket:5").await;
    let mut u = joined(addr, &user, "Ticket:5").await;
    let mut b = joined(addr, &blind, "Ticket:5").await;

    publish(
        &vk,
        json!({"room":"Ticket:5","by":{"id":10,"name":"Tech"},"events":[
            {"kind":"item.update","fields":["status","priority"]},
            followup(1, false, 10),
            followup(2, true, 10),
        ]}),
    )
    .await;

    let e = next(&mut t).await.unwrap();
    assert_eq!(e["t"], "event");
    assert_eq!(e["room"], "Ticket:5");
    assert_eq!(e["kind"], "item.update");
    assert_eq!(e["fields"], json!(["status", "priority"]));
    assert_eq!(e["by"], json!({"id":10,"name":"Tech"}));
    assert_eq!(next(&mut t).await.unwrap()["item"]["id"], 1);
    assert_eq!(
        next(&mut t).await.unwrap()["item"]["id"],
        2,
        "technician sees the private followup"
    );
    assert!(
        e.get("vis").is_none(),
        "visibility rules stay on the server"
    );

    assert_eq!(next(&mut u).await.unwrap()["kind"], "item.update");
    assert_eq!(next(&mut u).await.unwrap()["item"]["id"], 1);
    assert!(
        next(&mut u).await.is_none(),
        "no private followup for the requester"
    );

    assert_eq!(next(&mut b).await.unwrap()["kind"], "item.update");
    assert!(
        next(&mut b).await.is_none(),
        "no followup without a see right"
    );

    // The author of a private followup sees it whatever their rights.
    publish(&vk, json!({"room":"Ticket:5","by":{"id":11,"name":"Requester"},"events":[followup(3, true, 11)]})).await;
    assert_eq!(next(&mut u).await.unwrap()["item"]["id"], 3);
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn private_tasks_follow_session_groups() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let ingroup = session(&vk, 20, "InGroup").await;
    let outside = session(&vk, 21, "Outside").await;
    let _: () = vk
        .client
        .hset(
            format!("rt:s:{}", token_hash(&ingroup)),
            ("groups", "[4,8]"),
        )
        .await
        .unwrap();
    let flags = [
        ("read", "1"),
        ("see_public_task", "1"),
        ("see_private_task_groups", "1"),
    ];
    grant(&vk, &ingroup, "Ticket:6", &flags).await;
    grant(&vk, &outside, "Ticket:6", &flags).await;
    let mut a = joined(addr, &ingroup, "Ticket:6").await;
    let mut b = joined(addr, &outside, "Ticket:6").await;

    publish(
        &vk,
        json!({"room":"Ticket:6","by":{"id":1,"name":"x"},"events":[
        {"kind":"task.add","item":{"type":"TicketTask","id":9},
         "vis":{"right":"task","private":true,"uids":[1],"groups":[8]}}]}),
    )
    .await;
    assert_eq!(next(&mut a).await.unwrap()["item"]["id"], 9);
    assert!(next(&mut b).await.is_none());
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn regrant_withholds_events_until_the_grant_is_renewed() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let keeps = session(&vk, 30, "Keeps").await;
    let loses = session(&vk, 31, "Loses").await;
    grant(&vk, &keeps, "Ticket:7", &[("read", "1")]).await;
    grant(&vk, &loses, "Ticket:7", &[("read", "1")]).await;
    let mut k = joined(addr, &keeps, "Ticket:7").await;
    let mut l = joined(addr, &loses, "Ticket:7").await;
    recv_presence(&mut k, "Ticket:7").await;

    // The plugin deletes every grant on the item, then publishes.
    let _: i64 = vk
        .client
        .del(vec![
            format!("rt:g:{}:Ticket:7", token_hash(&keeps)),
            format!("rt:g:{}:Ticket:7", token_hash(&loses)),
        ])
        .await
        .unwrap();
    publish(
        &vk,
        json!({"room":"Ticket:7","by":{"id":1,"name":"x"},"regrant":true,
        "events":[{"kind":"actor.delete"}]}),
    )
    .await;
    assert_eq!(
        next(&mut k).await.unwrap(),
        json!({"v":1,"t":"regrant","room":"Ticket:7"})
    );
    assert_eq!(next(&mut l).await.unwrap()["t"], "regrant");
    assert!(
        next(&mut k).await.is_none(),
        "events of the regrant batch are withheld"
    );

    publish(
        &vk,
        json!({"room":"Ticket:7","events":[{"kind":"item.update"}]}),
    )
    .await;
    assert!(next(&mut k).await.is_none(), "stale members get nothing");

    // GLPI still allows `keeps`: grant rewritten (ajax/grant.php), then sub again.
    grant(&vk, &keeps, "Ticket:7", &[("read", "1")]).await;
    send(&mut k, json!({"v":1,"id":4,"t":"sub","room":"Ticket:7"})).await;
    assert_eq!(
        next(&mut k).await.unwrap(),
        json!({"v":1,"id":4,"t":"subscribed","room":"Ticket:7"})
    );
    publish(
        &vk,
        json!({"room":"Ticket:7","events":[{"kind":"item.update"}]}),
    )
    .await;
    assert_eq!(next(&mut k).await.unwrap()["kind"], "item.update");

    // `loses` has no grant any more: refused and removed from the room.
    send(&mut l, json!({"v":1,"id":5,"t":"sub","room":"Ticket:7"})).await;
    let r = next(&mut l).await.unwrap();
    assert_eq!(
        (r["t"].as_str(), r["code"].as_str(), r["id"].as_u64()),
        (Some("error"), Some("forbidden"), Some(5))
    );
    assert_eq!(present(&recv_presence(&mut k, "Ticket:7").await), [30]);
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn unanswered_regrant_removes_the_member() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.events.regrant_timeout_secs = 1;
    let (srv, addr) = start(cfg).await;
    let a = session(&vk, 40, "A").await;
    let b = session(&vk, 41, "B").await;
    grant(&vk, &a, "Ticket:8", &[("read", "1")]).await;
    grant(&vk, &b, "Ticket:8", &[("read", "1")]).await;
    let mut wa = joined(addr, &a, "Ticket:8").await;
    let mut wb = joined(addr, &b, "Ticket:8").await;
    recv_presence(&mut wa, "Ticket:8").await;

    publish(&vk, json!({"room":"Ticket:8","regrant":true})).await;
    assert_eq!(next(&mut wb).await.unwrap()["t"], "regrant");
    let m = recv_within(&mut wb, Duration::from_secs(3)).await.unwrap();
    assert_eq!(
        m,
        json!({"v":1,"t":"unsubscribed","room":"Ticket:8","reason":"forbidden"})
    );
    // `a` also ignored the regrant; both are gone from the room.
    assert_eq!(next(&mut wa).await.unwrap()["t"], "regrant");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn notifications_refresh_every_tab_and_alert_active_ones() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 50, "Alice").await;
    let bob = session(&vk, 51, "Bob").await;
    let carol = session(&vk, 52, "Carol").await;
    async fn opened(addr: std::net::SocketAddr, tok: &str, active: bool) -> Ws {
        let mut ws = connect(addr, Some(ORIGIN), Some(tok)).await.unwrap();
        recv(&mut ws).await;
        if !active {
            send(&mut ws, json!({"v":1,"t":"activity","active":false})).await;
        }
        // Make sure the activity message landed before anything is published.
        send(&mut ws, json!({"v":1,"t":"ping"})).await;
        recv(&mut ws).await;
        ws
    }
    let mut bob_front = opened(addr, &bob, true).await;
    let mut bob_back = opened(addr, &bob, false).await;
    let mut carol_back = opened(addr, &carol, false).await;
    let mut alice_ws = opened(addr, &alice, true).await;

    // Not subscribed to anything: notifications are addressed to users, not rooms.
    publish(
        &vk,
        json!({"by":{"id":50,"name":"Alice"},
        "notify":[{"to":[50,51,52],"kind":"assigned","item":"Ticket:9"}]}),
    )
    .await;

    let n = next(&mut bob_front).await.unwrap();
    assert_eq!(n["t"], "notification");
    assert_eq!(n["kind"], "assigned");
    assert_eq!(n["room"], "Ticket:9");
    assert_eq!(n["by"]["name"], "Alice");
    assert_eq!(n["alert"], true);
    assert!(n["nid"].as_str().is_some_and(|s| s.len() == 36));
    let quiet = next(&mut bob_back).await.unwrap();
    assert_eq!(
        (quiet["alert"].as_bool(), quiet["nid"].as_str()),
        (Some(false), n["nid"].as_str()),
        "background tab refreshes silently"
    );
    assert_eq!(
        next(&mut carol_back).await.unwrap()["alert"],
        true,
        "no active tab: every tab alerts"
    );
    assert!(
        next(&mut alice_ws).await.is_none(),
        "the author is not notified"
    );

    // Read in one tab: every tab of the user refreshes, the author's included, silently.
    publish(
        &vk,
        json!({"by":{"id":51,"name":"Bob"},"notify":[{"to":[51],"kind":"inbox","sync":true}]}),
    )
    .await;
    for ws in [&mut bob_front, &mut bob_back] {
        let m = next(ws).await.unwrap();
        assert_eq!(
            (m["kind"].as_str(), m["alert"].as_bool(), m["room"].as_str()),
            (Some("inbox"), Some(false), Some(""))
        );
    }
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn malformed_batches_are_dropped() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let a = session(&vk, 60, "A").await;
    grant(&vk, &a, "Ticket:10", &[("read", "1")]).await;
    let mut ws = joined(addr, &a, "Ticket:10").await;
    publish(
        &vk,
        json!({"room":"Ticket:10","events":[{"kind":"<img onerror=x>"}]}),
    )
    .await;
    publish(&vk, json!("not a batch")).await;
    publish(
        &vk,
        json!({"room":"Ticket:10","events":[{"kind":"item.update"}]}),
    )
    .await;
    assert_eq!(next(&mut ws).await.unwrap()["kind"], "item.update");
    assert!(next(&mut ws).await.is_none());
    srv.stop().await.unwrap();
}
