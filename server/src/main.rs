#![forbid(unsafe_code)]

use std::path::PathBuf;

use clap::Parser;
use glpi_realtime::config::Config;
use glpi_realtime::server;
use metrics_exporter_prometheus::PrometheusBuilder;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(version, about = "Real-time collaboration server for GLPI")]
struct Args {
    /// TOML configuration file. Values can be overridden with GLPI_RT_<SECTION>__<KEY>.
    #[arg(short, long, default_value = "/etc/glpi-realtime/config.toml")]
    config: PathBuf,
    /// Validate the configuration and exit.
    #[arg(long)]
    check: bool,
    /// Ask the running server's /health (on its listen address) and exit 0 if it is
    /// healthy: for container health checks (the image has no shell nor curl).
    #[arg(long)]
    healthcheck: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let cfg = Config::load(Some(&args.config))?;
    if args.check {
        println!("configuration OK");
        return Ok(());
    }
    if args.healthcheck {
        return healthcheck(&cfg).await;
    }

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&cfg.log.filter));
    let fmt = tracing_subscriber::fmt().with_env_filter(filter);
    if cfg.log.format == "json" {
        fmt.json().init();
    } else {
        fmt.init();
    }

    let metrics = PrometheusBuilder::new().install_recorder()?;
    server::start(cfg, Some(metrics))
        .await?
        .run_until(server::shutdown_signal())
        .await
}

/// GET /health on the server's own listener; an error unless it answers 200.
async fn healthcheck(cfg: &Config) -> anyhow::Result<()> {
    use glpi_realtime::config::Listen;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let request = b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    let mut answer = Vec::new();
    let io = async {
        match &cfg.listen {
            Listen::Tcp { addr } => {
                // A wildcard address is reached on the loopback.
                let mut target = *addr;
                if target.ip().is_unspecified() {
                    target.set_ip(std::net::Ipv4Addr::LOCALHOST.into());
                }
                let mut s = tokio::net::TcpStream::connect(target).await?;
                s.write_all(request).await?;
                s.read_to_end(&mut answer).await?;
            }
            Listen::Unix { path, .. } => {
                let mut s = tokio::net::UnixStream::connect(path).await?;
                s.write_all(request).await?;
                s.read_to_end(&mut answer).await?;
            }
        }
        anyhow::Ok(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), io).await??;
    let status = String::from_utf8_lossy(&answer);
    let line = status.lines().next().unwrap_or_default();
    anyhow::ensure!(line.contains(" 200 "), "unhealthy: {line}");
    println!("healthy");
    Ok(())
}
