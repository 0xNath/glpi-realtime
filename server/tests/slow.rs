//! A browser that stops reading (frozen tab, dead network) is dropped with close code
//! 1013 once its outbound queue is full, instead of the server buffering for it without
//! end. Others in the same room are not affected.

mod common;

use common::*;
use fred::prelude::*;
use futures_util::StreamExt;
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

/// A batch of `n` public followups on Ticket:5: one frame each for the browser.
fn batch(n: u64) -> Value {
    let events: Vec<Value> = (1..=n)
        .map(|id| {
            // Large frames (64 field names of 64 characters), to fill the buffers sooner.
            let fields: Vec<String> = (0..64).map(|f| format!("{f:0>64}")).collect();
            json!({"kind":"followup.add","item":{"type":"ITILFollowup","id":id},"fields":fields,
            "vis":{"right":"followup","private":false,"uids":[11]}})
        })
        .collect();
    json!({"room":"Ticket:5","by":{"id":11,"name":"Bob"},"events":events})
}

async fn member(vk: &Valkey, addr: std::net::SocketAddr, uid: u64) -> Ws {
    let tok = session(vk, uid, "Reader").await;
    grant(
        vk,
        &tok,
        "Ticket:5",
        &[("read", "1"), ("see_public_followup", "1")],
    )
    .await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await; // hello
    send(&mut ws, json!({"v":1,"t":"sub","room":"Ticket:5"})).await;
    assert_eq!(recv(&mut ws).await["t"], "subscribed");
    ws
}

#[tokio::test]
async fn a_client_that_stops_reading_is_dropped() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.limits.outbound_queue = 32;
    let (srv, addr) = start(cfg).await;
    let mut frozen = member(&vk, addr, 10).await;
    let mut reader = member(&vk, addr, 12).await;
    // The reader keeps reading (in the background) and counts the events it gets.
    // Returns the events it got, and whether its connection is still open (quiet for
    // a second, not closed).
    let reading = tokio::spawn(async move {
        let mut n = 0u64;
        loop {
            match tokio::time::timeout(Duration::from_secs(1), reader.next()).await {
                Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) => {
                    n += u64::from(t.contains("\"event\""));
                }
                Ok(
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
                    | None
                    | Some(Err(_)),
                ) => {
                    return (n, false);
                }
                Ok(Some(Ok(_))) => {}
                Err(_) => return (n, true),
            }
        }
    });
    // Enough to fill the frozen client's socket buffers, then its queue.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut sent = 0u64;
    loop {
        let _: i64 = vk
            .client
            .publish("rt:ev", batch(4).to_string())
            .await
            .unwrap();
        sent += 1;
        let open: i64 = srv_conns(addr).await;
        if open < 2 || Instant::now() > deadline {
            break;
        }
        // Paced: a client that reads keeps up; the frozen one fills its socket
        // buffers, then its queue.
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(
        Instant::now() <= deadline,
        "the frozen client was dropped ({sent} batches)"
    );
    // Reading now, it gets what was buffered, then the end of the connection: the
    // close frame (1013) usually cannot reach it, its queue being full.
    let mut frames = 0;
    let ended = loop {
        match tokio::time::timeout(Duration::from_secs(5), frozen.next()).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(f)))) => {
                break f.is_none_or(|f| u16::from(f.code) == 1013);
            }
            Ok(Some(Ok(_))) => frames += 1,
            Ok(None | Some(Err(_))) => break true,
            Err(_) => break false, // still open
        }
    };
    assert!(
        ended,
        "the frozen client's connection ended (after {frames} frames)"
    );
    let (events, open) = reading.await.unwrap();
    assert!(
        events > 0 && open,
        "the member who reads keeps receiving ({events} events, open: {open})"
    );
    srv.stop().await.unwrap();
}

/// Open connections, from /health.
async fn srv_conns(addr: std::net::SocketAddr) -> i64 {
    let (_, body) = http_get(addr, "/health").await;
    serde_json::from_str::<Value>(&body).unwrap()["connections"]
        .as_i64()
        .unwrap()
}
