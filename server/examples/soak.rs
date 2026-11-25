//! Soak test: waves of WebSocket clients for a while, against a server it starts itself,
//! to find what a one-minute load test cannot: memory or state that grows with use.
//!
//!   cargo run --release --example soak -- --valkey unix:///tmp/vk.sock --duration-secs 600
//!
//! Each wave opens `--connections` clients (sessions and grants written as the plugin
//! does, db 6, prefix rt:), each subscribes to an item, reports its activity, follows a
//! list of items and receives an event per item; then half close cleanly and half drop
//! their socket. Between waves: the server must hold no connection, and Valkey no
//! presence entry. At the end: the RSS of the last quarter of the run (median) must not
//! exceed that of the second quarter by more than `--max-growth-pct` (a leak keeps
//! growing; warming up, allocators and caches, levels off within the first quarter).
//!
//! `--check` (CI): exit code 1 on any of these, or when a wave lost connections or events.

use std::sync::Arc;
use std::time::{Duration, Instant};

use fred::prelude::*;
use futures_util::{SinkExt, StreamExt};
use glpi_realtime::auth::token_hash;
use glpi_realtime::config::{Config, Listen};
use serde_json::json;
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

const ORIGIN: &str = "https://soak.invalid";

struct Args {
    valkey: String,
    duration: Duration,
    connections: usize,
    rooms: usize,
    check: bool,
    max_growth_pct: u64,
}

fn args() -> Args {
    let mut a = Args {
        valkey: "unix:///run/valkey/valkey.sock".into(),
        duration: Duration::from_secs(300),
        connections: 500,
        rooms: 50,
        check: false,
        max_growth_pct: 10,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        if k == "--check" {
            a.check = true;
            continue;
        }
        let v = it.next().unwrap_or_default();
        match k.as_str() {
            "--valkey" => a.valkey = v,
            "--duration-secs" => {
                a.duration = Duration::from_secs(v.parse().expect("--duration-secs N"))
            }
            "--connections" => a.connections = v.parse().expect("--connections N"),
            "--rooms" => a.rooms = v.parse().expect("--rooms N"),
            "--max-growth-pct" => a.max_growth_pct = v.parse().expect("--max-growth-pct N"),
            _ => panic!("unknown argument {k}"),
        }
    }
    a
}

fn token(i: usize) -> String {
    format!("{:064x}", 0x50a4_0000_0000_u64 + i as u64)
}

fn rss_kib() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    s.lines()
        .find(|l| l.starts_with("VmRSS:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_json(
    ws: &mut Ws,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> Option<serde_json::Value> {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .ok()??
            .ok()?;
        if let Message::Text(t) = m {
            let v: serde_json::Value = serde_json::from_str(&t).ok()?;
            if pred(&v) {
                return Some(v);
            }
        }
    }
}

async fn send(ws: &mut Ws, v: serde_json::Value) -> Option<()> {
    ws.send(Message::Text(v.to_string().into())).await.ok()
}

/// One client of a wave: hello, subscribe, activity, a list watched. Returns its socket.
async fn client(addr: String, i: usize, rooms: usize) -> Option<(Ws, String)> {
    let mut req = format!("ws://{addr}/ws").into_client_request().ok()?;
    req.headers_mut()
        .insert("Origin", HeaderValue::from_static(ORIGIN));
    req.headers_mut().insert(
        "Cookie",
        HeaderValue::from_str(&format!("glpi_rt={}", token(i))).ok()?,
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.ok()?;
    next_json(&mut ws, |m| m["t"] == "hello").await?;
    let room = format!("Ticket:{}", i % rooms + 1);
    send(&mut ws, json!({"v":1,"t":"sub","room":room})).await?;
    next_json(&mut ws, |m| m["t"] == "subscribed").await?;
    send(&mut ws, json!({"v":1,"t":"activity","active":false})).await?;
    send(&mut ws, json!({"v":1,"t":"activity","active":true})).await?;
    let list: Vec<String> = (0..5)
        .map(|k| format!("Ticket:{}", (i + k) % rooms + 1))
        .collect();
    send(&mut ws, json!({"v":1,"t":"watch","rooms":list})).await?;
    next_json(&mut ws, |m| m["t"] == "watching").await?;
    Some((ws, room))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let a = args();
    let mut vcfg = if a.valkey.starts_with("unix://") {
        fred::prelude::Config::from_url_unix(&a.valkey)?
    } else {
        fred::prelude::Config::from_url(&a.valkey)?
    };
    vcfg.database = Some(6);
    let vk = Builder::from_config(vcfg).build()?;
    vk.init().await?;

    let mut cfg = Config {
        listen: Listen::Tcp {
            addr: "127.0.0.1:0".parse()?,
        },
        ..Config::default()
    };
    cfg.valkey.url = a.valkey.clone();
    cfg.security.allowed_origins = vec![ORIGIN.into()];
    cfg.limits.max_connections = a.connections + 100;
    cfg.limits.outbound_queue = 1024;
    let srv = glpi_realtime::server::start(cfg, None).await?;
    let addr = srv.local_addr.unwrap().to_string();

    // Sessions and grants (their own item, and the items of their list), as GLPI writes them.
    let pipe = vk.pipeline();
    for i in 0..a.connections {
        let h = token_hash(&token(i));
        let _: () = pipe
            .hset(
                format!("rt:s:{h}"),
                [("uid", (i + 1).to_string()), ("name", format!("Soak {i}"))],
            )
            .await?;
        let _: () = pipe.expire(format!("rt:s:{h}"), 7200, None).await?;
        for k in 0..5 {
            let room = format!("Ticket:{}", (i + k) % a.rooms + 1);
            let _: () = pipe
                .hset(format!("rt:g:{h}:{room}"), [("read", "1")])
                .await?;
            let _: () = pipe.expire(format!("rt:g:{h}:{room}"), 7200, None).await?;
        }
    }
    let _: Vec<Value> = pipe.all().await?;
    println!(
        "server {addr}: waves of {} clients on {} items for {:?}",
        a.connections, a.rooms, a.duration
    );

    let started = Instant::now();
    let mut problems: Vec<String> = vec![];
    // (elapsed, RSS KiB) after each wave.
    let mut rss: Vec<(Duration, u64)> = vec![];
    let mut wave = 0;
    while started.elapsed() < a.duration {
        wave += 1;
        let sem = Arc::new(Semaphore::new(200));
        let tasks: Vec<_> = (0..a.connections)
            .map(|i| {
                let (sem, addr) = (Arc::clone(&sem), addr.clone());
                let rooms = a.rooms;
                tokio::spawn(async move {
                    let _p = sem.acquire().await.ok()?;
                    client(addr, i, rooms).await
                })
            })
            .collect();
        let mut conns = vec![];
        for t in tasks {
            if let Ok(Some(c)) = t.await {
                conns.push(c);
            }
        }
        if conns.len() < a.connections {
            problems.push(format!(
                "wave {wave}: {} of {} connections",
                conns.len(),
                a.connections
            ));
        }
        // One event per item: every member receives it.
        for r in 1..=a.rooms {
            let batch = json!({"room": format!("Ticket:{r}"), "by": {"id": 0, "name": ""}, "events": [{"kind": "item.update"}]});
            let _: i64 = vk.publish("rt:ev", batch.to_string()).await?;
        }
        let mut received = 0;
        for (ws, room) in conns.iter_mut() {
            let room = room.clone();
            if next_json(ws, |m| m["t"] == "event" && m["room"] == room.as_str())
                .await
                .is_some()
            {
                received += 1;
            }
        }
        if received < conns.len() {
            problems.push(format!(
                "wave {wave}: {received} of {} events received",
                conns.len()
            ));
        }
        // Leave: half cleanly, half dropping the socket.
        for (k, (mut ws, _)) in conns.into_iter().enumerate() {
            if k % 2 == 0 {
                let _ = ws.close(None).await;
            }
            drop(ws);
        }
        // Everything they left must go: connections, then presence entries.
        let deadline = Instant::now() + Duration::from_secs(20);
        while srv.registry.len() > 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if srv.registry.len() > 0 {
            problems.push(format!(
                "wave {wave}: {} connections left on the server",
                srv.registry.len()
            ));
        }
        let mut presence = 0;
        while Instant::now() < deadline {
            presence = 0;
            for r in 1..=a.rooms {
                let n: i64 = vk.hlen(format!("rt:p:Ticket:{r}")).await?;
                presence += n;
            }
            if presence == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if presence > 0 {
            problems.push(format!(
                "wave {wave}: {presence} presence entries left in Valkey"
            ));
        }
        let now = rss_kib().unwrap_or(0);
        rss.push((started.elapsed(), now));
        if wave % 50 == 1 {
            println!(
                "wave {wave}: {received} events, RSS {} MiB, {:?} elapsed",
                now / 1024,
                started.elapsed()
            );
        }
    }

    // Median RSS of the waves within [from, to) of the run.
    let median = |from: f64, to: f64| -> Option<u64> {
        let mut v: Vec<u64> = rss
            .iter()
            .filter(|(t, _)| {
                let f = t.as_secs_f64() / a.duration.as_secs_f64();
                f >= from && f < to
            })
            .map(|&(_, r)| r)
            .collect();
        v.sort_unstable();
        v.get(v.len() / 2).copied()
    };
    match (median(0.25, 0.5), median(0.75, 2.0)) {
        (Some(mid), Some(end)) if mid > 0 => {
            let growth = (end.saturating_sub(mid) * 100) / mid;
            println!(
                "{wave} waves; RSS (median) second quarter {} MiB, last quarter {} MiB (+{growth} %)",
                mid / 1024,
                end / 1024
            );
            if growth > a.max_growth_pct {
                problems.push(format!(
                    "RSS grew by {growth} % between the second and the last quarter (> {} %)",
                    a.max_growth_pct
                ));
            }
        }
        _ => problems.push(format!(
            "only {wave} waves: not enough to compare the RSS over time"
        )),
    }

    // Our sessions and grants go.
    let pipe = vk.pipeline();
    for i in 0..a.connections {
        let h = token_hash(&token(i));
        let _: () = pipe.del(format!("rt:s:{h}")).await?;
        for k in 0..5 {
            let _: () = pipe
                .del(format!("rt:g:{h}:Ticket:{}", (i + k) % a.rooms + 1))
                .await?;
        }
    }
    let _: Vec<Value> = pipe.all().await?;
    srv.stop().await?;

    if problems.is_empty() {
        println!("soak: ok ({wave} waves)");
        Ok(())
    } else {
        for p in &problems {
            println!("PROBLEM {p}");
        }
        if a.check {
            std::process::exit(1);
        }
        Ok(())
    }
}
