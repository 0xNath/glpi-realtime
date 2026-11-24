//! Load test (step 6): N WebSocket clients on R items, against a server it starts itself
//! (default) or an existing one (`--addr`).
//!
//!   cargo run --release --example loadtest -- --valkey unix:///tmp/vk.sock --connections 20000 --rooms 2000
//!
//! It writes N sessions and their grants in Valkey (db 6, prefix rt:, as the plugin does),
//! opens the connections with a bounded concurrency, subscribes each to one item, then:
//! - handshake + subscription latency (p50/p95/p99/max);
//! - one item event per room published at once: time until every member received it;
//! - presence fan-out: one more member per room, time until the others saw the list;
//! - server memory (RSS, when started here).
//!
//! `--check` (CI): exit code 1 unless every connection, event and presence update went
//! through, with every p99 under `--max-p99-ms` and the RSS under `--max-rss-mib`.
//!
//! Keys it created are removed at the end.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use fred::prelude::*;
use futures_util::{SinkExt, StreamExt};
use glpi_realtime::auth::token_hash;
use glpi_realtime::config::{Config, Listen};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

const ORIGIN: &str = "https://loadtest.invalid";

struct Args {
    valkey: String,
    addr: Option<String>,
    connections: usize,
    rooms: usize,
    concurrency: usize,
    /// Fail (exit code 1) unless every connection, event and presence went through, within
    /// these limits: the CI's regression guard.
    check: bool,
    max_p99_ms: u64,
    max_rss_mib: u64,
}

fn args() -> Args {
    let mut a = Args {
        valkey: "unix:///run/valkey/valkey.sock".into(),
        addr: None,
        connections: 2000,
        rooms: 200,
        concurrency: 500,
        check: false,
        max_p99_ms: 1_000,
        max_rss_mib: 1_024,
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
            "--addr" => a.addr = Some(v),
            "--connections" => a.connections = v.parse().expect("--connections N"),
            "--rooms" => a.rooms = v.parse().expect("--rooms N"),
            "--concurrency" => a.concurrency = v.parse().expect("--concurrency N"),
            "--max-p99-ms" => a.max_p99_ms = v.parse().expect("--max-p99-ms N"),
            "--max-rss-mib" => a.max_rss_mib = v.parse().expect("--max-rss-mib N"),
            _ => panic!("unknown argument {k}"),
        }
    }
    a
}

fn token(i: usize) -> String {
    format!("{:064x}", 0x5eed_0000_0000_u64 + i as u64)
}

fn pct(v: &mut [Duration], p: f64) -> Duration {
    v.sort();
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

/// Prints the percentiles; returns the p99 (None without sample).
fn report(label: &str, v: &mut [Duration]) -> Option<Duration> {
    if v.is_empty() {
        println!("{label}: no sample");
        return None;
    }
    println!(
        "{label}: n={} p50={:?} p95={:?} p99={:?} max={:?}",
        v.len(),
        pct(v, 0.5),
        pct(v, 0.95),
        pct(v, 0.99),
        pct(v, 1.0)
    );
    Some(pct(v, 0.99))
}

fn rss_mib() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    let kb: u64 = s
        .lines()
        .find(|l| l.starts_with("VmRSS:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some(kb / 1024)
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

    // Server: ours, or the given one.
    let (addr, server) = match &a.addr {
        Some(addr) => (addr.clone(), None),
        None => {
            let mut cfg = Config {
                listen: Listen::Tcp {
                    addr: "127.0.0.1:0".parse()?,
                },
                ..Config::default()
            };
            cfg.valkey.url = a.valkey.clone();
            cfg.security.allowed_origins = vec![ORIGIN.into()];
            cfg.limits.max_connections = a.connections + a.rooms + 1000;
            cfg.limits.max_connections_per_user = 2;
            cfg.limits.outbound_queue = 1024;
            let srv = glpi_realtime::server::start(cfg, None).await?;
            (srv.local_addr.unwrap().to_string(), Some(srv))
        }
    };
    println!(
        "server {addr}: {} connections on {} items",
        a.connections, a.rooms
    );

    // Sessions and grants, as the plugin writes them.
    let t0 = Instant::now();
    for chunk in (0..a.connections + a.rooms)
        .collect::<Vec<_>>()
        .chunks(1000)
    {
        let pipe = vk.pipeline();
        for &i in chunk {
            let h = token_hash(&token(i));
            let _: () = pipe
                .hset(
                    format!("rt:s:{h}"),
                    [("uid", (i + 1).to_string()), ("name", format!("User {i}"))],
                )
                .await?;
            let _: () = pipe.expire(format!("rt:s:{h}"), 3600, None).await?;
            let room = format!("Ticket:{}", i % a.rooms + 1);
            let _: () = pipe
                .hset(format!("rt:g:{h}:{room}"), [("read", "1")])
                .await?;
            let _: () = pipe.expire(format!("rt:g:{h}:{room}"), 3600, None).await?;
        }
        let _: Vec<Value> = pipe.all().await?;
    }
    println!("setup: {:?}", t0.elapsed());

    // Connections.
    let sem = Arc::new(Semaphore::new(a.concurrency));
    let failed = Arc::new(AtomicUsize::new(0));
    let started = Instant::now();
    let mut tasks = Vec::with_capacity(a.connections);
    for i in 0..a.connections {
        let (sem, failed, addr) = (Arc::clone(&sem), Arc::clone(&failed), addr.clone());
        let rooms = a.rooms;
        tasks.push(tokio::spawn(async move {
            let _p = sem.acquire().await.ok()?;
            let t = Instant::now();
            let mut req = format!("ws://{addr}/ws").into_client_request().ok()?;
            req.headers_mut()
                .insert("Origin", HeaderValue::from_static(ORIGIN));
            req.headers_mut().insert(
                "Cookie",
                HeaderValue::from_str(&format!("glpi_rt={}", token(i))).ok()?,
            );
            let Ok((mut ws, _)) = tokio_tungstenite::connect_async(req).await else {
                failed.fetch_add(1, Ordering::Relaxed);
                return None;
            };
            next_json(&mut ws, |m| m["t"] == "hello").await?;
            let room = format!("Ticket:{}", i % rooms + 1);
            ws.send(Message::Text(
                serde_json::json!({"v":1,"t":"sub","room":room})
                    .to_string()
                    .into(),
            ))
            .await
            .ok()?;
            next_json(&mut ws, |m| m["t"] == "subscribed").await?;
            Some((ws, room, t.elapsed()))
        }));
    }
    let mut conns = vec![];
    let mut handshake = vec![];
    for t in tasks {
        if let Ok(Some((ws, room, d))) = t.await {
            handshake.push(d);
            conns.push((ws, room));
        }
    }
    println!(
        "connected: {} in {:?} ({} failed){}",
        conns.len(),
        started.elapsed(),
        failed.load(Ordering::Relaxed),
        rss_mib()
            .map(|m| format!(", load test + server RSS {m} MiB"))
            .unwrap_or_default()
    );
    let mut problems: Vec<String> = vec![];
    let limit = Duration::from_millis(a.max_p99_ms);
    let failures = failed.load(Ordering::Relaxed);
    if failures > 0 || conns.len() < a.connections {
        problems.push(format!("{} of {} connections", conns.len(), a.connections));
    }
    if let Some(m) = rss_mib().filter(|&m| m > a.max_rss_mib) {
        problems.push(format!("RSS {m} MiB > {} MiB", a.max_rss_mib));
    }
    if let Some(p) = report("handshake+sub", &mut handshake).filter(|&p| p > limit) {
        problems.push(format!("handshake p99 {p:?} > {limit:?}"));
    }

    // Drain the presence lists that followed the subscriptions.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (wss, rooms): (Vec<Ws>, Vec<String>) = conns.into_iter().unzip();
    let mut readers = vec![];
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(&'static str, Instant)>();
    for mut ws in wss {
        let tx = tx.clone();
        readers.push(tokio::spawn(async move {
            while let Some(Ok(m)) = ws.next().await {
                if let Message::Text(t) = m {
                    if t.contains("\"t\":\"event\"") {
                        let _ = tx.send(("event", Instant::now()));
                    } else if t.contains("\"t\":\"presence\"") {
                        let _ = tx.send(("presence", Instant::now()));
                    }
                }
            }
        }));
    }
    drop(tx);
    while tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .is_ok()
    {}

    // One event per room, published at once.
    let t = Instant::now();
    for r in 1..=a.rooms {
        let batch = serde_json::json!({"room": format!("Ticket:{r}"), "by": {"id": 0, "name": "load"}, "events": [{"kind":"item.update","fields":["status"]}]});
        let _: i64 = vk.publish("rt:ev", batch.to_string()).await?;
    }
    let mut lat = vec![];
    let expected = rooms.len();
    while lat.len() < expected {
        match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await {
            Ok(Some(("event", at))) => lat.push(at - t),
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    println!("events: {} of {expected} delivered", lat.len());
    if lat.len() < expected {
        problems.push(format!("{} of {expected} events delivered", lat.len()));
    }
    if let Some(p) = report("event delivery (from publish)", &mut lat).filter(|&p| p > limit) {
        problems.push(format!("event p99 {p:?} > {limit:?}"));
    }

    // Presence fan-out: one newcomer per room.
    let t = Instant::now();
    let mut newcomers = vec![];
    for r in 0..a.rooms {
        let i = a.connections + r;
        let addr = addr.clone();
        newcomers.push(tokio::spawn(async move {
            let mut req = format!("ws://{addr}/ws").into_client_request().ok()?;
            req.headers_mut()
                .insert("Origin", HeaderValue::from_static(ORIGIN));
            req.headers_mut().insert(
                "Cookie",
                HeaderValue::from_str(&format!("glpi_rt={}", token(i))).ok()?,
            );
            let (mut ws, _) = tokio_tungstenite::connect_async(req).await.ok()?;
            next_json(&mut ws, |m| m["t"] == "hello").await?;
            let room = format!("Ticket:{}", i % a.rooms + 1);
            ws.send(Message::Text(
                serde_json::json!({"v":1,"t":"sub","room":room})
                    .to_string()
                    .into(),
            ))
            .await
            .ok()?;
            next_json(&mut ws, |m| m["t"] == "subscribed").await?;
            Some(ws)
        }));
    }
    let mut keep = vec![];
    for n in newcomers {
        if let Ok(Some(ws)) = n.await {
            keep.push(ws);
        }
    }
    println!("newcomers connected: {} of {}", keep.len(), a.rooms);
    let mut pres = vec![];
    while pres.len() < expected {
        match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await {
            Ok(Some(("presence", at))) => pres.push(at - t),
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    println!("presence: {} of {expected} members told", pres.len());
    if pres.len() < expected {
        problems.push(format!("{} of {expected} presence updates", pres.len()));
    }
    if let Some(p) =
        report("presence fan-out (from first newcomer)", &mut pres).filter(|&p| p > limit)
    {
        problems.push(format!("presence p99 {p:?} > {limit:?}"));
    }

    // Clean up.
    drop(keep);
    for r in readers {
        r.abort();
    }
    for chunk in (0..a.connections + a.rooms)
        .collect::<Vec<_>>()
        .chunks(1000)
    {
        let pipe = vk.pipeline();
        for &i in chunk {
            let h = token_hash(&token(i));
            let room = format!("Ticket:{}", i % a.rooms + 1);
            let _: () = pipe
                .del(vec![format!("rt:s:{h}"), format!("rt:g:{h}:{room}")])
                .await?;
        }
        let _: Vec<Value> = pipe.all().await?;
    }
    if let Some(s) = server {
        s.stop().await?;
    }
    if a.check {
        if !problems.is_empty() {
            anyhow::bail!("load check failed: {}", problems.join("; "));
        }
        println!(
            "load check passed (p99 <= {limit:?}, RSS <= {} MiB)",
            a.max_rss_mib
        );
    }
    Ok(())
}
