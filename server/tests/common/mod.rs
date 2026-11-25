//! Test harness: a throw-away Valkey and a server bound to 127.0.0.1:0.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use fred::prelude::*;
use futures_util::{SinkExt, StreamExt};
use glpi_realtime::auth::token_hash;
use glpi_realtime::config::{Config, Listen};
use glpi_realtime::server::{self, Running};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub const ORIGIN: &str = "https://glpi.test";

pub struct Valkey {
    child: Child,
    _dir: tempfile::TempDir,
    bin: &'static str,
    extra: Vec<String>,
    auth: Option<(String, String)>,
    /// Unix socket of this test's private Valkey (no TCP port: no collisions between tests).
    pub socket: std::path::PathBuf,
    pub client: Client,
}

impl Drop for Valkey {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Starts a private `valkey-server`; returns None (test skipped) when the binary is missing.
pub async fn valkey() -> Option<Valkey> {
    valkey_with(&[], None).await
}

/// A private Valkey with extra settings; `auth` (user, password) for the test client.
pub async fn valkey_with(extra: &[&str], auth: Option<(&str, &str)>) -> Option<Valkey> {
    let bin = ["valkey-server", "redis-server"].into_iter().find(|b| {
        Command::new(b)
            .arg("--version")
            .stdout(Stdio::null())
            .status()
            .is_ok()
    })?;
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("valkey.sock");
    let extra: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
    let auth = auth.map(|(u, p)| (u.to_string(), p.to_string()));
    let child = spawn_valkey(bin, &socket, dir.path(), &extra).await;
    let client = test_client(&socket, &auth).await;
    Some(Valkey {
        child,
        _dir: dir,
        bin,
        extra,
        auth,
        socket,
        client,
    })
}

async fn spawn_valkey(
    bin: &str,
    socket: &std::path::Path,
    dir: &std::path::Path,
    extra: &[String],
) -> Child {
    let _ = std::fs::remove_file(socket);
    let child = Command::new(bin)
        .args(["--port", "0", "--save", "", "--appendonly", "no"])
        .args(["--notify-keyspace-events", "Kgx"])
        .arg("--unixsocket")
        .arg(socket)
        .arg("--dir")
        .arg(dir)
        .args(extra)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..500 {
        if std::os::unix::net::UnixStream::connect(socket).is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    child
}

async fn test_client(socket: &std::path::Path, auth: &Option<(String, String)>) -> Client {
    let mut cfg =
        fred::prelude::Config::from_url_unix(&format!("unix://{}", socket.display())).unwrap();
    cfg.database = Some(6);
    if let Some((u, p)) = auth {
        cfg.username = Some(u.clone());
        cfg.password = Some(p.clone());
    }
    let client = Builder::from_config(cfg).build().unwrap();
    client.init().await.unwrap();
    client
}

impl Valkey {
    /// A restart without persistence: every key is lost (sessions, grants, presence).
    pub async fn restart(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.child = spawn_valkey(self.bin, &self.socket, self._dir.path(), &self.extra).await;
        self.client = test_client(&self.socket, &self.auth).await;
    }

    /// A network blip: every other client (the server's) is disconnected, the data is kept.
    /// Returns how many connections were cut.
    pub async fn drop_clients(&self) -> i64 {
        let mut n = 0;
        for kind in ["normal", "pubsub"] {
            let killed: i64 = self
                .client
                .custom(
                    fred::cmd!("CLIENT"),
                    vec!["KILL", "TYPE", kind, "SKIPME", "yes"],
                )
                .await
                .unwrap();
            n += killed;
        }
        n
    }
}

pub fn config(vk: &Valkey) -> Config {
    let mut c = Config {
        listen: Listen::Tcp {
            addr: "127.0.0.1:0".parse().unwrap(),
        },
        ..Config::default()
    };
    c.valkey.url = format!("unix://{}", vk.socket.display());
    c.valkey.db = 6;
    c.valkey.pool_size = 2;
    c.security.allowed_origins = vec![ORIGIN.into()];
    c.shutdown.grace_secs = 2;
    c
}

pub async fn start(cfg: Config) -> (Running, SocketAddr) {
    let r = server::start(cfg, None).await.unwrap();
    let addr = r.local_addr.unwrap();
    (r, addr)
}

/// Creates a GLPI session as the plugin would; returns the clear token (cookie value).
pub async fn session(vk: &Valkey, uid: u64, name: &str) -> String {
    let token: String = (0..64)
        .map(|i| char::from(b"0123456789abcdef"[(uid as usize * 7 + i * 13) % 16]))
        .collect();
    let token = format!("{:0>64}", &token[..64]);
    let _: () = vk
        .client
        .hset(
            format!("rt:s:{}", token_hash(&token)),
            [("uid", uid.to_string()), ("name", name.to_string())],
        )
        .await
        .unwrap();
    token
}

pub async fn grant(vk: &Valkey, token: &str, room: &str, flags: &[(&str, &str)]) {
    let key = format!("rt:g:{}:{room}", token_hash(token));
    let _: () = vk.client.hset(key, flags.to_vec()).await.unwrap();
}

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn connect(
    addr: SocketAddr,
    origin: Option<&str>,
    token: Option<&str>,
) -> Result<Ws, WsError> {
    let mut req = format!("ws://{addr}/ws").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut()
            .insert("Origin", HeaderValue::from_str(o).unwrap());
    }
    if let Some(t) = token {
        req.headers_mut().insert(
            "Cookie",
            HeaderValue::from_str(&format!("other=1; glpi_rt={t}")).unwrap(),
        );
    }
    tokio_tungstenite::connect_async(req)
        .await
        .map(|(ws, _)| ws)
}

pub fn http_status(err: &WsError) -> Option<u16> {
    match err {
        WsError::Http(resp) => Some(resp.status().as_u16()),
        _ => None,
    }
}

/// Next JSON text message, skipping control frames, `presence` and `lock` broadcasts.
pub async fn recv(ws: &mut Ws) -> serde_json::Value {
    recv_within(ws, Duration::from_secs(3))
        .await
        .expect("timed out waiting for a message")
}

pub async fn recv_within(ws: &mut Ws, d: Duration) -> Option<serde_json::Value> {
    recv_matching(ws, d, |m| m["t"] != "presence" && m["t"] != "lock").await
}

/// Next `presence` message for `room`.
pub async fn recv_presence(ws: &mut Ws, room: &str) -> serde_json::Value {
    recv_matching(ws, Duration::from_secs(5), |m| {
        m["t"] == "presence" && m["room"] == room
    })
    .await
    .expect("timed out waiting for presence")
}

/// Ids of the users in a `presence` message.
pub fn present(m: &serde_json::Value) -> Vec<u64> {
    m["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["id"].as_u64().unwrap())
        .collect()
}

pub async fn recv_matching(
    ws: &mut Ws,
    d: Duration,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + d;
    loop {
        let m = tokio::time::timeout_at(deadline, ws.next())
            .await
            .ok()??
            .ok()?;
        if let Message::Text(t) = m {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if pred(&v) {
                return Some(v);
            }
        }
    }
}

/// Waits for the close frame and returns its code.
pub async fn close_code(ws: &mut Ws) -> Option<CloseCode> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Ok(Some(Ok(Message::Close(f)))) => return f.map(|f| f.code),
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

pub async fn send(ws: &mut Ws, v: serde_json::Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

/// Minimal HTTP GET for /health and /metrics.
pub async fn http_get(addr: SocketAddr, path: &str) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.unwrap();
    let code = buf[9..12].parse().unwrap();
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (code, body)
}

/// Next `lock` message for `room` (fields scope).
pub async fn recv_lock(ws: &mut Ws, room: &str) -> serde_json::Value {
    recv_lock_scope(ws, room, "fields").await
}

/// Next `lock` message for `room` and `scope`.
pub async fn recv_lock_scope(ws: &mut Ws, room: &str, scope: &str) -> serde_json::Value {
    recv_matching(ws, Duration::from_secs(5), |m| {
        m["t"] == "lock" && m["room"] == room && m["scope"] == scope
    })
    .await
    .expect("timed out waiting for lock")
}

impl Valkey {
    /// Valkey is gone (until [`Valkey::restart`]): every command of the server fails.
    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
