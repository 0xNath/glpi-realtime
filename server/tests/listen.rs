//! The unix socket listener (what production uses behind nginx or Apache): its mode and
//! group, what it does with what is already at its path, the WebSocket over it, its removal
//! at stop; and `run_until`, the stop on a signal.

mod common;

use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use glpi_realtime::config::{Config, Listen};
use glpi_realtime::server;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

macro_rules! valkey_or_skip {
    () => {
        match valkey().await {
            Some(v) => v,
            None => {
                eprintln!("valkey-server not found: test skipped");
                return;
            }
        }
    };
}

/// A directory with a short path: unix socket paths are limited to 108 bytes, and TMPDIR
/// may be long.
fn short_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("rt")
        .tempdir_in("/tmp")
        .unwrap()
}

fn unix_config(vk: &Valkey, path: &Path, mode: u32, group: Option<String>) -> Config {
    let mut c = config(vk);
    c.listen = Listen::Unix {
        path: path.to_path_buf(),
        mode,
        group,
    };
    c
}

async fn unix_get(path: &Path, uri: &str) -> (u16, String) {
    let mut s = UnixStream::connect(path).await.unwrap();
    s.write_all(format!("GET {uri} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.unwrap();
    (
        buf[9..12].parse().unwrap(),
        buf.split("\r\n\r\n").nth(1).unwrap_or("").to_string(),
    )
}

/// Next JSON text frame of a WebSocket over the unix socket.
async fn recv_unix(ws: &mut tokio_tungstenite::WebSocketStream<UnixStream>) -> serde_json::Value {
    use futures_util::StreamExt;
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let tokio_tungstenite::tungstenite::Message::Text(t) = m {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

/// A supplementary group of this process, not its primary one (the socket would get the
/// primary one anyway): its name and gid, as the server's `group` for nginx's group.
fn other_group(probe: &Path) -> Option<(String, u32)> {
    std::fs::write(probe, b"").ok()?;
    let primary = std::fs::metadata(probe).ok()?.gid();
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let groups: Vec<u32> = status
        .lines()
        .find_map(|l| l.strip_prefix("Groups:"))?
        .split_whitespace()
        .filter_map(|g| g.parse().ok())
        .collect();
    let etc = std::fs::read_to_string("/etc/group").ok()?;
    groups
        .into_iter()
        .filter(|&g| g != primary)
        .find_map(|gid| {
            etc.lines().find_map(|l| {
                let f: Vec<&str> = l.split(':').collect();
                (f.len() > 2 && f[2] == gid.to_string()).then(|| (f[0].to_string(), gid))
            })
        })
}

#[tokio::test]
async fn unix_socket_mode_websocket_and_removal_at_stop() {
    let vk = valkey_or_skip!();
    let dir = short_dir();
    let path = dir.path().join("rt.sock");
    let srv = server::start(unix_config(&vk, &path, 0o660, None), None)
        .await
        .unwrap();

    let meta = std::fs::symlink_metadata(&path).unwrap();
    assert!(meta.file_type().is_socket());
    assert_eq!(
        meta.permissions().mode() & 0o777,
        0o660,
        "the configured mode"
    );
    assert_eq!(unix_get(&path, "/health").await.0, 200);

    // A browser's WebSocket, through the socket as the web server forwards it.
    let tok = session(&vk, 21, "unix").await;
    let mut req = "ws://localhost/ws".into_client_request().unwrap();
    req.headers_mut()
        .insert("Origin", HeaderValue::from_static(ORIGIN));
    req.headers_mut().insert(
        "Cookie",
        HeaderValue::from_str(&format!("glpi_rt={tok}")).unwrap(),
    );
    let (mut ws, _) =
        tokio_tungstenite::client_async(req, UnixStream::connect(&path).await.unwrap())
            .await
            .unwrap();
    assert_eq!(recv_unix(&mut ws).await["t"], "hello");

    let stopping = tokio::spawn(srv.stop());
    assert_eq!(recv_unix(&mut ws).await["reason"], "shutdown");
    drop(ws);
    stopping.await.unwrap().unwrap();
    assert!(!path.exists(), "the socket is removed at stop");
}

#[tokio::test]
async fn unix_socket_other_mode() {
    let vk = valkey_or_skip!();
    let dir = short_dir();
    let path = dir.path().join("rt.sock");
    let srv = server::start(unix_config(&vk, &path, 0o600, None), None)
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn unix_socket_left_by_a_crash_is_replaced() {
    let vk = valkey_or_skip!();
    let dir = short_dir();
    let path = dir.path().join("rt.sock");
    // A socket nobody listens on any more (a killed server's).
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    assert!(
        std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_socket()
    );
    let srv = server::start(unix_config(&vk, &path, 0o660, None), None)
        .await
        .unwrap();
    assert_eq!(unix_get(&path, "/health").await.0, 200);
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn unix_path_holding_a_file_is_refused_and_left_alone() {
    let vk = valkey_or_skip!();
    let dir = short_dir();
    let path = dir.path().join("rt.sock");
    std::fs::write(&path, b"not a socket").unwrap();
    let err = match server::start(unix_config(&vk, &path, 0o660, None), None).await {
        Ok(_) => panic!("started over a regular file"),
        Err(e) => format!("{e:#}"),
    };
    assert!(err.contains("exists and is not a socket"), "{err}");
    assert_eq!(std::fs::read(&path).unwrap(), b"not a socket");
}

#[tokio::test]
async fn unix_socket_group() {
    let vk = valkey_or_skip!();
    let dir = short_dir();
    let Some((name, gid)) = other_group(&dir.path().join("probe")) else {
        eprintln!("this process has no supplementary group in /etc/group: test skipped");
        return;
    };
    let path: PathBuf = dir.path().join("rt.sock");
    let srv = server::start(unix_config(&vk, &path, 0o660, Some(name)), None)
        .await
        .unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().gid(), gid);
    srv.stop().await.unwrap();

    let err = match server::start(
        unix_config(&vk, &path, 0o660, Some("no-such-group-rt".into())),
        None,
    )
    .await
    {
        Ok(_) => panic!("started with an unknown group"),
        Err(e) => format!("{e:#}"),
    };
    assert!(err.contains("unknown group no-such-group-rt"), "{err}");
}

#[tokio::test]
async fn run_until_stops_on_the_signal_and_says_bye() {
    let vk = valkey_or_skip!();
    let (srv, addr) = start(config(&vk)).await;
    let tok = session(&vk, 22, "sig").await;
    let mut ws = connect(addr, Some(ORIGIN), Some(&tok)).await.unwrap();
    recv(&mut ws).await;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let running = tokio::spawn(srv.run_until(async {
        let _ = rx.await;
    }));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!running.is_finished(), "runs until the signal");
    tx.send(()).unwrap();
    assert_eq!(recv(&mut ws).await["reason"], "shutdown");
    drop(ws);
    tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
