mod common;

use std::time::Duration;

use common::*;
use serde_json::json;

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
async fn a_list_follows_presence_without_being_in_it() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 10, "Alice").await;
    let bob = session(&vk, 11, "Bob").await;
    let carol = session(&vk, 12, "Carol").await;
    for (t, rooms) in [
        (&alice, &["Ticket:5", "Ticket:6"][..]),
        (&bob, &["Ticket:5"][..]),
        (&carol, &["Ticket:5"][..]),
    ] {
        for r in rooms {
            grant(&vk, t, r, &[("read", "1")]).await;
        }
    }
    let mut a = on_item(addr, &alice, "Ticket:5").await;
    recv_presence(&mut a, "Ticket:5").await;

    let mut b = connect(addr, Some(ORIGIN), Some(&bob)).await.unwrap();
    recv(&mut b).await;
    send(
        &mut b,
        json!({"v":1,"id":1,"t":"watch","rooms":["Ticket:5","Ticket:6","Ticket:5","Computer:1"]}),
    )
    .await;
    let w = recv(&mut b).await;
    assert_eq!(
        w,
        json!({"v":1,"id":1,"t":"watching","rooms":["Ticket:5"]}),
        "only items Bob may read"
    );
    assert_eq!(
        present(&recv_presence(&mut b, "Ticket:5").await),
        [10],
        "Bob sees Alice, and is not in the list"
    );
    let changed = recv_matching(&mut a, Duration::from_millis(700), |m| m["t"] == "presence").await;
    assert!(
        changed.is_none(),
        "Alice's list does not change: Bob is not on the ticket"
    );

    let _c = on_item(addr, &carol, "Ticket:5").await;
    assert_eq!(
        present(&recv_presence(&mut b, "Ticket:5").await),
        [10, 12],
        "updates follow"
    );

    send(&mut b, json!({"v":1,"id":2,"t":"watch","rooms":[]})).await;
    assert_eq!(recv(&mut b).await["rooms"], json!([]));
    a.close(None).await.unwrap();
    let more = recv_matching(&mut b, Duration::from_millis(700), |m| m["t"] == "presence").await;
    assert!(more.is_none(), "no more updates once unwatched");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn watched_items_are_capped() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.limits.max_watched_rooms = 2;
    let (srv, addr) = start(cfg).await;
    let bob = session(&vk, 21, "Bob").await;
    for r in ["Ticket:1", "Ticket:2", "Ticket:3"] {
        grant(&vk, &bob, r, &[("read", "1")]).await;
    }
    let mut b = connect(addr, Some(ORIGIN), Some(&bob)).await.unwrap();
    recv(&mut b).await;
    send(
        &mut b,
        json!({"v":1,"id":1,"t":"watch","rooms":["Ticket:1","Ticket:2","Ticket:3"]}),
    )
    .await;
    assert_eq!(recv(&mut b).await["rooms"], json!(["Ticket:1", "Ticket:2"]));
    srv.stop().await.unwrap();
}
