//! The binary itself (main.rs): its options, the health check the container image uses,
//! and a real run stopped by SIGTERM, as systemd and container runtimes stop it.

mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::*;
use glpi_realtime::config::Listen;
use glpi_realtime::server;

const BIN: &str = env!("CARGO_BIN_EXE_glpi-realtime");

macro_rules! valkey_or_skip {
    () => {
        match valkey().await {
            Some(v) => v,
            None => return eprintln!("valkey-server not found: test skipped"),
        }
    };
}

/// A configuration file for the binary.
fn config_file(dir: &Path, body: &str) -> std::path::PathBuf {
    let path = dir.join("config.toml");
    // A valid configuration names the origins it accepts.
    let body = if body.contains("[security]") {
        body.to_string()
    } else {
        format!("{body}[security]\nallowed_origins = [\"{ORIGIN}\"]\n")
    };
    std::fs::File::create(&path)
        .unwrap()
        .write_all(body.as_bytes())
        .unwrap();
    path
}

fn run(args: &[&str]) -> (bool, String, String) {
    let out = Command::new(BIN).args(args).output().unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn version_and_help() {
    let (ok, out, _) = run(&["--version"]);
    assert!(ok);
    assert_eq!(
        out.trim(),
        format!("glpi-realtime {}", env!("CARGO_PKG_VERSION"))
    );
    let (ok, out, _) = run(&["--help"]);
    assert!(ok && out.contains("--healthcheck"));
}

#[test]
fn check_says_whether_the_configuration_is_valid() {
    let dir = tempfile::tempdir().unwrap();
    let good = config_file(
        dir.path(),
        "[listen]\ntype = \"tcp\"\naddr = \"127.0.0.1:9\"\n[security]\nallowed_origins = [\"https://glpi.example.org\"]\n",
    );
    let (ok, out, _) = run(&["--config", good.to_str().unwrap(), "--check"]);
    assert!(ok, "valid: exit 0");
    assert_eq!(out.trim(), "configuration OK");

    // A setting raised to its minimum: still valid, with a warning.
    std::fs::write(
        &good,
        format!("[limits]\noutbound_queue = 16\n[security]\nallowed_origins = [\"{ORIGIN}\"]\n"),
    )
    .unwrap();
    let (ok, out, err) = run(&["--config", good.to_str().unwrap(), "--check"]);
    assert!(ok && out.trim() == "configuration OK", "{err}");
    assert!(err.contains("outbound_queue = 16 raised to 128"), "{err}");

    std::fs::write(&good, "[limits]\nmax_connections = \"many\"\n").unwrap();
    let (ok, _, err) = run(&["--config", good.to_str().unwrap(), "--check"]);
    assert!(!ok, "invalid: an error exit");
    assert!(
        err.contains("max_connections"),
        "names what is wrong: {err}"
    );

    let (ok, _, err) = run(&["--config", "/nonexistent/glpi-realtime.toml", "--check"]);
    assert!(!ok, "a missing file is an error, not the defaults");
    assert!(!err.is_empty());
}

#[tokio::test]
async fn healthcheck_tcp_wildcard_and_unix() {
    let vk = valkey_or_skip!();
    // TCP, through the wildcard address the server binds to. (Linux already reaches the
    // loopback when connecting to 0.0.0.0: the substitution is for other systems.)
    let port = free_port();
    let mut cfg = config(&vk);
    cfg.listen = Listen::Tcp {
        addr: format!("127.0.0.1:{port}").parse().unwrap(),
    };
    let srv = server::start(cfg, None).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = config_file(
        dir.path(),
        &format!("[listen]\ntype = \"tcp\"\naddr = \"0.0.0.0:{port}\"\n"),
    );
    let (ok, out, err) = tokio::task::spawn_blocking(move || {
        run(&["--config", file.to_str().unwrap(), "--healthcheck"])
    })
    .await
    .unwrap();
    assert!(ok, "healthy through the wildcard address: {err}");
    assert_eq!(out.trim(), "healthy");
    srv.stop().await.unwrap();

    // Nobody listening: an error exit, as the container runtime expects.
    let file = config_file(
        dir.path(),
        &format!("[listen]\ntype = \"tcp\"\naddr = \"127.0.0.1:{port}\"\n"),
    );
    let (ok, _, _) = tokio::task::spawn_blocking(move || {
        run(&["--config", file.to_str().unwrap(), "--healthcheck"])
    })
    .await
    .unwrap();
    assert!(!ok, "no server: unhealthy");

    // Unix socket.
    let sdir = tempfile::Builder::new()
        .prefix("rt")
        .tempdir_in("/tmp")
        .unwrap();
    let sock = sdir.path().join("rt.sock");
    let mut cfg = config(&vk);
    cfg.listen = Listen::Unix {
        path: sock.clone(),
        mode: 0o600,
        group: None,
    };
    let srv = server::start(cfg, None).await.unwrap();
    let file = config_file(
        dir.path(),
        &format!("[listen]\ntype = \"unix\"\npath = \"{}\"\n", sock.display()),
    );
    let (ok, out, _) = tokio::task::spawn_blocking(move || {
        run(&["--config", file.to_str().unwrap(), "--healthcheck"])
    })
    .await
    .unwrap();
    assert!(
        ok && out.trim() == "healthy",
        "healthy over the unix socket"
    );
    srv.stop().await.unwrap();
}

#[tokio::test]
async fn healthcheck_of_something_that_is_not_the_server() {
    // Something answers, but not 200: unhealthy, with the status line.
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut s, _) = l.accept().await.unwrap();
        let mut buf = [0u8; 256];
        let _ = s.read(&mut buf).await;
        let _ = s
            .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
            .await;
    });
    let dir = tempfile::tempdir().unwrap();
    let file = config_file(
        dir.path(),
        &format!("[listen]\ntype = \"tcp\"\naddr = \"127.0.0.1:{port}\"\n"),
    );
    let (ok, _, err) = tokio::task::spawn_blocking(move || {
        run(&["--config", file.to_str().unwrap(), "--healthcheck"])
    })
    .await
    .unwrap();
    assert!(!ok);
    assert!(err.contains("unhealthy") && err.contains("503"), "{err}");
}

#[tokio::test]
async fn runs_logs_in_json_and_stops_on_sigterm() {
    let vk = valkey_or_skip!();
    let port = free_port();
    let dir = tempfile::tempdir().unwrap();
    let file = config_file(
        dir.path(),
        &format!(
            "[listen]\ntype = \"tcp\"\naddr = \"127.0.0.1:{port}\"\n[valkey]\nurl = \"unix://{}\"\ndb = 6\n[security]\nallowed_origins = [\"{ORIGIN}\"]\n[log]\nformat = \"json\"\nfilter = \"info\"\n[shutdown]\ngrace_secs = 1\n",
            vk.socket.display()
        ),
    );
    let mut child = Command::new(BIN)
        .args(["--config", file.to_str().unwrap()])
        .env_remove("RUST_LOG")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Up when /health answers.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut up = false;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            up = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(up, "the server listens");
    let (code, _) = http_get(format!("127.0.0.1:{port}").parse().unwrap(), "/metrics").await;
    assert_eq!(code, 200, "metrics are served when run as the binary");

    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "stopped within its grace");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(status.success(), "a clean exit on SIGTERM");
    let mut logs = String::new();
    use std::io::Read;
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut logs)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut logs)
        .unwrap();
    let first = logs
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default();
    assert!(first.starts_with('{'), "JSON logs: {first}");
}
