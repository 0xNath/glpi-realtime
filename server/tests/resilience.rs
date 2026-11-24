//! Valkey goes away and comes back: a network blip (data kept) or a restart without
//! persistence (sessions and grants lost). The server must keep listening, and tell the
//! browsers when their session is gone so that GLPI issues a new one.

mod common;

use std::time::Duration;

use common::*;
use fred::prelude::*;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

macro_rules! valkey_or_skip {
    () => {
        match valkey().await {
            Some(v) => v,
            None => return eprintln!("valkey-server not found: test skipped"),
        }
    };
}

/// Publishes as the plugin does, once the server listens again (after a reconnection).
async fn publish(vk: &Valkey, batch: Value) {
    for _ in 0..300 {
        let n: i64 = vk.client.publish("rt:ev", batch.to_string()).await.unwrap();
        if n > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("nobody listens on rt:ev");
}

fn followup(id: u64) -> Value {
    json!({"room":"Ticket:5","by":{"id":11,"name":"Bob"},"events":[{"kind":"followup.add",
        "item":{"type":"ITILFollowup","id":id},"vis":{"right":"followup","private":false,"uids":[11]}}]})
}

async fn joined(vk: &Valkey, addr: std::net::SocketAddr, uid: u64) -> (Ws, String) {
    let tok = session(vk, uid, "Alice").await;
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
    (ws, tok)
}

async fn event(ws: &mut Ws) -> Value {
    recv_matching(ws, Duration::from_secs(5), |m| m["t"] == "event")
        .await
        .expect("an event")
}

#[tokio::test]
async fn listeners_reconnect_after_a_network_blip() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.revocation.keyspace_events = true; // the sweep (15 s) would be too slow to tell
    let (srv, addr) = start(cfg).await;
    let (mut ws, tok) = joined(&vk, addr, 10).await;
    publish(&vk, followup(1)).await;
    assert_eq!(event(&mut ws).await["kind"], "followup.add");

    // Every connection of the server to Valkey is cut; the data stays.
    assert!(vk.drop_clients().await > 0);

    // Item events flow again (the subscriber reconnected and subscribed again)...
    publish(&vk, followup(2)).await;
    let e = event(&mut ws).await;
    assert_eq!(e["item"]["id"], 2, "{e}");
    // ...and so does instant revocation, once its pattern is subscribed again (a session
    // deleted during the gap is caught by the periodic sweep).
    for _ in 0..50 {
        let n: i64 = vk
            .client
            .custom(fred::cmd!("PUBSUB"), vec!["NUMPAT"])
            .await
            .unwrap();
        if n > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _: i64 = vk
        .client
        .del(format!("rt:s:{}", glpi_realtime::auth::token_hash(&tok)))
        .await
        .unwrap();
    assert_eq!(close_code(&mut ws).await, Some(CloseCode::from(4001)));
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn a_restart_without_persistence_revokes_then_works_again() {
    let mut vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.revocation.sweep_interval_secs = 1;
    let (srv, addr) = start(cfg).await;
    let (mut ws, _) = joined(&vk, addr, 10).await;

    // Sessions and grants are gone: the browser is told its session ended (4001), so
    // that it asks GLPI for a new one (the client calls ajax/session.php).
    vk.restart().await;
    assert_eq!(close_code(&mut ws).await, Some(CloseCode::from(4001)));

    // GLPI issued a new token and grant: everything works again, events included.
    let (mut ws, _) = joined(&vk, addr, 10).await;
    publish(&vk, followup(3)).await;
    assert_eq!(event(&mut ws).await["item"]["id"], 3);
    srv.stop().await.unwrap();
}
