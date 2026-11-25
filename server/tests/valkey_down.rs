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
