mod common;

use std::time::Duration;

use common::*;
use fred::prelude::*;
use serde_json::json;

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

#[tokio::test]
async fn users_see_each_other_and_leaving_is_broadcast() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 10, "Alice").await;
    let bob = session(&vk, 11, "Bob").await;
    grant(&vk, &alice, "Ticket:5", &[("read", "1")]).await;
    grant(&vk, &bob, "Ticket:5", &[("read", "1")]).await;

    let mut a = joined(addr, &alice, "Ticket:5").await;
    assert_eq!(present(&recv_presence(&mut a, "Ticket:5").await), [10]);

    let mut b = joined(addr, &bob, "Ticket:5").await;
    let pb = recv_presence(&mut b, "Ticket:5").await;
    assert_eq!(present(&pb), [10, 11]);
    assert_eq!(pb["users"][1]["name"], "Bob");
    assert_eq!(present(&recv_presence(&mut a, "Ticket:5").await), [10, 11]);

    b.close(None).await.unwrap();
    assert_eq!(present(&recv_presence(&mut a, "Ticket:5").await), [10]);
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn several_tabs_count_once_and_unsub_leaves() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 20, "Alice").await;
    let bob = session(&vk, 21, "Bob").await;
    grant(&vk, &alice, "Ticket:6", &[("read", "1")]).await;
    grant(&vk, &bob, "Ticket:6", &[("read", "1")]).await;

    let mut a = joined(addr, &alice, "Ticket:6").await;
    recv_presence(&mut a, "Ticket:6").await;
    let mut b1 = joined(addr, &bob, "Ticket:6").await;
    assert_eq!(present(&recv_presence(&mut a, "Ticket:6").await), [20, 21]);
    // A second tab of Bob: the joiner gets the list, Alice gets nothing (unchanged).
    let mut b2 = joined(addr, &bob, "Ticket:6").await;
    assert_eq!(present(&recv_presence(&mut b2, "Ticket:6").await), [20, 21]);
    assert!(
        recv_matching(&mut a, Duration::from_millis(500), |m| m["t"] == "presence")
            .await
            .is_none(),
        "no broadcast when the list does not change"
    );
    // One tab leaves: Bob is still there.
    send(&mut b1, json!({"v":1,"t":"unsub","room":"Ticket:6"})).await;
    assert!(
        recv_matching(&mut a, Duration::from_millis(500), |m| m["t"] == "presence")
            .await
            .is_none()
    );
    // Last tab leaves.
    send(&mut b2, json!({"v":1,"t":"unsub","room":"Ticket:6"})).await;
    assert_eq!(present(&recv_presence(&mut a, "Ticket:6").await), [20]);
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn rooms_are_isolated_and_need_a_grant() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 30, "Alice").await;
    let carol = session(&vk, 32, "Carol").await;
    grant(&vk, &alice, "Ticket:7", &[("read", "1")]).await;
    grant(&vk, &carol, "Ticket:8", &[("read", "1")]).await;

    let mut a = joined(addr, &alice, "Ticket:7").await;
    recv_presence(&mut a, "Ticket:7").await;
    let mut c = joined(addr, &carol, "Ticket:8").await;
    assert_eq!(present(&recv_presence(&mut c, "Ticket:8").await), [32]);
    // Carol tries Ticket:7 without a grant: refused, and Alice sees nobody new.
    send(&mut c, json!({"v":1,"t":"sub","room":"Ticket:7"})).await;
    assert_eq!(recv(&mut c).await["code"], "forbidden");
    assert!(
        recv_matching(&mut a, Duration::from_millis(500), |m| m["t"] == "presence")
            .await
            .is_none()
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn two_instances_share_presence() {
    let vk = valkey_or_skip!();
    let (s1, addr1) = start(config(&vk)).await;
    let (s2, addr2) = start(config(&vk)).await;
    let alice = session(&vk, 40, "Alice").await;
    let bob = session(&vk, 41, "Bob").await;
    grant(&vk, &alice, "Ticket:9", &[("read", "1")]).await;
    grant(&vk, &bob, "Ticket:9", &[("read", "1")]).await;
    tokio::time::sleep(Duration::from_millis(300)).await; // subscribers ready

    let mut a = joined(addr1, &alice, "Ticket:9").await;
    recv_presence(&mut a, "Ticket:9").await;
    let mut b = joined(addr2, &bob, "Ticket:9").await;
    assert_eq!(present(&recv_presence(&mut b, "Ticket:9").await), [40, 41]);
    assert_eq!(present(&recv_presence(&mut a, "Ticket:9").await), [40, 41]);

    b.close(None).await.unwrap();
    assert_eq!(present(&recv_presence(&mut a, "Ticket:9").await), [40]);
    s1.stop().await.unwrap();
    s2.stop().await.unwrap();
}

#[tokio::test]
async fn entries_of_a_crashed_instance_expire() {
    let vk = valkey_or_skip!();
    let mut cfg = config(&vk);
    cfg.presence.heartbeat_secs = 1;
    cfg.presence.ttl_secs = 2;
    let (srv, addr) = start(cfg).await;
    let alice = session(&vk, 50, "Alice").await;
    grant(&vk, &alice, "Ticket:11", &[("read", "1")]).await;

    // A "ghost" written by an instance that died without cleaning up.
    let key = "rt:p:Ticket:11";
    let _: () = vk
        .client
        .hset(key, ("dead-conn", r#"{"uid":51,"name":"Ghost","since":1}"#))
        .await
        .unwrap();
    let _: Vec<i64> = vk.client.hexpire(key, 2, None, "dead-conn").await.unwrap();

    let mut a = joined(addr, &alice, "Ticket:11").await;
    assert_eq!(present(&recv_presence(&mut a, "Ticket:11").await), [51, 50]);
    // Alice's own entry is kept alive by the heartbeat, the ghost is not.
    let p = recv_matching(&mut a, Duration::from_secs(5), |m| m["t"] == "presence")
        .await
        .expect("update");
    assert_eq!(present(&p), [50]);
    tokio::time::sleep(Duration::from_secs(3)).await;
    let ttl: Vec<i64> = vk.client.httl(key, "dead-conn").await.unwrap_or_default();
    assert!(ttl.is_empty() || ttl == [-2], "ghost field gone: {ttl:?}");
    let live: i64 = vk.client.hlen(key).await.unwrap();
    assert_eq!(live, 1, "alice's entry survives several TTLs");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn shutdown_removes_entries() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 60, "Alice").await;
    grant(&vk, &alice, "Ticket:12", &[("read", "1")]).await;
    let mut a = joined(addr, &alice, "Ticket:12").await;
    recv_presence(&mut a, "Ticket:12").await;
    srv.stop().await.unwrap();
    let n: i64 = vk.client.hlen("rt:p:Ticket:12").await.unwrap();
    assert_eq!(n, 0);
    let _ = a.close(None).await;
}

fn activity(m: &serde_json::Value, uid: u64) -> bool {
    m["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["id"] == uid)
        .map(|u| u["active"].as_bool().unwrap())
        .expect("user listed")
}

#[tokio::test]
async fn activity_is_shared_and_any_tab_counts() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 70, "Alice").await;
    let bob = session(&vk, 71, "Bob").await;
    grant(&vk, &alice, "Ticket:13", &[("read", "1")]).await;
    grant(&vk, &bob, "Ticket:13", &[("read", "1")]).await;

    let mut a = joined(addr, &alice, "Ticket:13").await;
    recv_presence(&mut a, "Ticket:13").await;
    let mut b1 = joined(addr, &bob, "Ticket:13").await;
    let p = recv_presence(&mut a, "Ticket:13").await;
    assert!(activity(&p, 71), "active by default");

    // Bob's only tab goes to the background.
    send(&mut b1, json!({"v":1,"t":"activity","active":false})).await;
    assert!(!activity(&recv_presence(&mut a, "Ticket:13").await, 71));

    // Repeating the same state broadcasts nothing.
    send(&mut b1, json!({"v":1,"t":"activity","active":false})).await;
    assert!(
        recv_matching(&mut a, Duration::from_millis(500), |m| m["t"] == "presence")
            .await
            .is_none()
    );

    // A second, active tab makes Bob active again.
    let mut b2 = joined(addr, &bob, "Ticket:13").await;
    assert!(activity(&recv_presence(&mut a, "Ticket:13").await, 71));
    // Newcomers see the current state.
    let joiner = recv_presence(&mut b2, "Ticket:13").await;
    assert!(activity(&joiner, 71) && activity(&joiner, 70));

    // The active tab leaves: Bob is listed again, inactive.
    b2.close(None).await.unwrap();
    assert!(!activity(&recv_presence(&mut a, "Ticket:13").await, 71));
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn activity_before_subscribing_is_remembered() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 80, "Alice").await;
    let bob = session(&vk, 81, "Bob").await;
    grant(&vk, &alice, "Ticket:14", &[("read", "1")]).await;
    grant(&vk, &bob, "Ticket:14", &[("read", "1")]).await;
    let mut a = joined(addr, &alice, "Ticket:14").await;
    recv_presence(&mut a, "Ticket:14").await;

    let mut b = connect(addr, Some(ORIGIN), Some(&bob)).await.unwrap();
    recv(&mut b).await;
    send(&mut b, json!({"v":1,"t":"activity","active":false})).await;
    send(&mut b, json!({"v":1,"t":"sub","room":"Ticket:14"})).await;
    assert!(!activity(&recv_presence(&mut a, "Ticket:14").await, 81));
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn avatars_are_relayed_and_sanitized() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let alice = session(&vk, 90, "Alice").await;
    let mallory = session(&vk, 91, "Mallory").await;
    let key = |t: &str| format!("rt:s:{}", glpi_realtime::auth::token_hash(t));
    let _: () = vk
        .client
        .hset(key(&alice), ("avatar", r##"{"picture":"/front/document.send.php?file=_pictures/a.png","initials":"AL","color":"#5a7f9e","fg":"#ffffff"}"##))
        .await
        .unwrap();
    let _: () = vk
        .client
        .hset(key(&mallory), ("avatar", r##"{"picture":"/x\") ; background:url(//evil","initials":"<i>","color":"red","fg":"#fff"}"##))
        .await
        .unwrap();
    grant(&vk, &alice, "Ticket:15", &[("read", "1")]).await;
    grant(&vk, &mallory, "Ticket:15", &[("read", "1")]).await;

    let mut a = joined(addr, &alice, "Ticket:15").await;
    recv_presence(&mut a, "Ticket:15").await;
    let _m = joined(addr, &mallory, "Ticket:15").await;
    let p = recv_presence(&mut a, "Ticket:15").await;
    let users = p["users"].as_array().unwrap();
    assert_eq!(
        users[0]["avatar"]["picture"],
        "/front/document.send.php?file=_pictures/a.png"
    );
    assert_eq!(users[0]["avatar"]["color"], "#5a7f9e");
    assert_eq!(users[1]["avatar"]["picture"], "", "hostile picture dropped");
    assert_eq!(users[1]["avatar"]["color"], "", "hostile color dropped");
    assert_eq!(users[1]["avatar"]["initials"], "i");
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn self_service_users_see_agents_anonymized() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tech = session(&vk, 40, "Alice Martin").await;
    let colleague = session(&vk, 42, "Bob").await;
    let requester = session(&vk, 41, "Rita").await;
    use glpi_realtime::auth::token_hash;
    // As the plugin writes them: the agent's anonymized identity, the requester's view.
    let _: () = vk
        .client
        .hset(
            format!("rt:s:{}", token_hash(&tech)),
            [
                ("anon", r##"{"name":"Helpdesk user","avatar":{"picture":"","initials":"HE","color":"#667382","fg":"#ffffff"}}"##),
                ("avatar", r##"{"picture":"/front/document.send.php?file=_pictures/a.png","initials":"AM","color":"#123456","fg":"#ffffff"}"##),
            ],
        )
        .await
        .unwrap();
    let _: () = vk
        .client
        .hset(
            format!("rt:s:{}", token_hash(&requester)),
            ("anon_view", "1"),
        )
        .await
        .unwrap();
    for t in [&tech, &colleague, &requester] {
        grant(&vk, t, "Ticket:30", &[("read", "1")]).await;
    }
    let mut a = joined(addr, &tech, "Ticket:30").await;
    recv_presence(&mut a, "Ticket:30").await;
    let mut c = joined(addr, &colleague, "Ticket:30").await;
    let mut r = joined(addr, &requester, "Ticket:30").await;

    let seen = recv_matching(&mut r, Duration::from_secs(5), |m| {
        m["t"] == "presence" && m["users"].as_array().unwrap().len() == 3
    })
    .await
    .unwrap();
    let alice = seen["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["id"] == 40)
        .unwrap()
        .clone();
    assert_eq!(alice["name"], "Helpdesk user");
    assert_eq!(alice["avatar"]["initials"], "HE");
    assert!(
        !seen.to_string().contains("Alice") && !seen.to_string().contains("a.png"),
        "nothing identifying"
    );
    assert!(
        !seen.to_string().contains("\"anon\""),
        "the anon object itself is never sent"
    );

    let p = recv_matching(&mut c, Duration::from_secs(5), |m| {
        m["t"] == "presence" && m["users"].as_array().unwrap().len() == 3
    })
    .await
    .unwrap();
    assert!(
        p.to_string().contains("Alice Martin") && !p.to_string().contains("\"anon\""),
        "technicians see the names"
    );
    srv.stop().await.unwrap();
}
