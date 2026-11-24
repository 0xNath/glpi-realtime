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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let cfg = Config::load(Some(&args.config))?;
    if args.check {
        println!("configuration OK");
        return Ok(());
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
