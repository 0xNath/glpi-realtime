//! Valkey stops while browsers are connected. Requests that need it are answered
//! "temporarily unavailable" within seconds; they do not wait for Valkey's return,
//! which would freeze the connection (nothing else it sends is handled meanwhile).

mod common;

use common::*;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

macro_rules! valkey_or_skip {
    () => {
        match valkey().await {
            Some(v) => v,
            None => return eprintln!("valkey-server not found: test skipped"),
        }
    };
}

/// The reply to the request `id`, waited for at most `within`.
async fn reply(ws: &mut Ws, id: u64, within: Duration) -> Option<Value> {
    recv_matching(ws, within, |m| m["id"] == id).await
}

#[tokio::test]
async fn requests_fail_fast_while_valkey_is_down_then_work_again() {
    let mut vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tok = session(&vk, 10, "Alice").await;
    grant(
        &vk,
        &tok,
        "Ticket:5",
        &[("read", "1"), ("update", "1"), ("add_followup", "1")],
    )
    .await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await; // hello
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:5"})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");

    vk.stop();
    let started = Instant::now();
    send(&mut ws, json!({"v":1,"t":"lock","room":"Ticket:5","id":1})).await;
    let r = reply(&mut ws, 1, Duration::from_secs(10))
        .await
        .expect("the lock request is answered while Valkey is down");
    assert_eq!(r["t"], "error");
    assert_eq!(r["message"], "temporarily unavailable");
    // The connection is not frozen: the next request is answered too.
    send(
        &mut ws,
        json!({"v":1,"t":"draft","room":"Ticket:5","kind":"followup","html":"<p>x</p>","id":2}),
    )
    .await;
    let r = reply(&mut ws, 2, Duration::from_secs(10))
        .await
        .expect("the draft is answered while Valkey is down");
    assert_eq!(r["message"], "temporarily unavailable");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "both within the command timeout: {:?}",
        started.elapsed()
    );

    // Valkey is back (with its data lost): GLPI's new grant is honoured again.
    vk.restart().await;
    let tok = session(&vk, 10, "Alice").await;
    grant(&vk, &tok, "Ticket:5", &[("read", "1"), ("update", "1")]).await;
    let mut ws = loop {
        match connect(addr, Some(ORIGIN), Some(&tok)).await {
            Ok(ws) => break ws,
            Err(_) if started.elapsed() < Duration::from_secs(30) => {
                tokio::time::sleep(Duration::from_millis(200)).await
            }
            Err(e) => panic!("no connection after Valkey's return: {e}"),
        }
    };
    recv(&mut ws).await; // hello
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:5"})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    send(&mut ws, json!({"v":1,"t":"lock","room":"Ticket:5","id":3})).await;
    let r = reply(&mut ws, 3, Duration::from_secs(5))
        .await
        .expect("lock");
    assert_eq!(r["t"], "lock", "{r}");
    srv.stop().await.unwrap();
}

/// Every request needing Valkey gets its error (or is a no-op) during the outage, the
/// connection stays open, and new connections are refused with 503.
#[tokio::test]
async fn every_request_is_answered_during_the_outage() {
    let mut vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tok = session(&vk, 10, "Alice").await;
    grant(
        &vk,
        &tok,
        "Ticket:5",
        &[("read", "1"), ("update", "1"), ("add_followup", "1")],
    )
    .await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await; // hello
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:5"})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    // Whatever joining sends (presence, locks) is read before the outage.
    while recv_within(&mut ws, Duration::from_millis(300))
        .await
        .is_some()
    {}
    vk.stop();
    // fred notices the closed socket at once; wait until a request fails fast.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let unavailable = [
        (
            10,
            json!({"v":1,"id":10,"t":"draft_take","room":"Ticket:5","kind":"followup"}),
        ),
        (11, json!({"v":1,"id":11,"t":"sub","room":"Ticket:6"})),
        (12, json!({"v":1,"id":12,"t":"sub","room":"Ticket:5"})), // a resubscription
        (13, json!({"v":1,"id":13,"t":"watch","rooms":["Ticket:7"]})),
        // The reply to unlock is the lock's state, which cannot be read.
        (16, json!({"v":1,"id":16,"t":"unlock","room":"Ticket:5"})),
    ];
    for (id, msg) in unavailable {
        send(&mut ws, msg).await;
        let r = reply(&mut ws, id, Duration::from_secs(5))
            .await
            .unwrap_or_else(|| panic!("request {id} answered"));
        assert_eq!(r["t"], "error", "{r}");
        assert_eq!(r["message"], "temporarily unavailable", "{r}");
    }
    // Nothing to read: following the draft is refused, as for a draft that does not exist.
    send(
        &mut ws,
        json!({"v":1,"id":14,"t":"draft_watch","room":"Ticket:5","kind":"followup","on":true}),
    )
    .await;
    let r = reply(&mut ws, 14, Duration::from_secs(5)).await.unwrap();
    assert_eq!(r["t"], "error", "{r}");
    // Requests without an answer of their own: logged, nothing sent, the connection stays.
    for msg in [
        json!({"v":1,"t":"activity","active":false}),
        json!({"v":1,"t":"draft_end","room":"Ticket:5","kind":"followup"}),
        json!({"v":1,"t":"compose","room":"Ticket:5","kind":"followup"}),
    ] {
        send(&mut ws, msg).await;
    }
    let err = recv_matching(&mut ws, Duration::from_millis(500), |m| m["t"] == "error").await;
    assert!(err.is_none(), "no error for those: {err:?}");
    send(
        &mut ws,
        json!({"v":1,"id":15,"t":"unsub","room":"Ticket:5"}),
    )
    .await;
    let r = reply(&mut ws, 15, Duration::from_secs(5))
        .await
        .expect("still connected: the unsub is answered");
    assert_eq!(r["t"], "unsubscribed", "{r}");

    let refused = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap_err();
    assert_eq!(http_status(&refused), Some(503));
    srv.stop().await.unwrap();
}
