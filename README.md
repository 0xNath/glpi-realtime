# glpi-realtime

Optional real-time layer for GLPI 12: presence, typing indicators, live ticket updates,
instant notifications, a single editor for ticket fields and collaborative answers.

- `server/`: WebSocket server in Rust (tokio, axum, fred/Valkey).
- `plugin/`: GLPI plugin `realtime` (PHP): issues session tokens and per-item grants.
- `client/`: browser client in TypeScript, bundled into `plugin/public/realtime.js`.
- `deploy/`: systemd unit, nginx snippets, configuration example, install and update scripts.
- `e2e/`: end-to-end tests in a real Chromium against the GLPI instance ([setup](e2e/README.md)).
- `docs/`: [protocol](docs/protocol.md), [security model](docs/security.md).

GLPI works unchanged when the server, Valkey or the plugin is absent.

## Architecture

```
Browser ──wss /ws──► nginx ──unix socket──► glpi-realtime (Rust)
   │                                            │ reads tokens, grants
   └── GLPI pages ──► nginx ──► uWSGI/PHP ──────┴──► Valkey (db 6)
                               (plugin writes tokens, grants; publishes events)
```

## Status

| Step | Content | State |
|---|---|---|
| 1 | Server skeleton, authentication, grants, deployment | done |
| 2 | Presence | done |
| 3 | Ticket events, notifications (bell with queues, preferences, sound, full page) | done |
| 4 | Single editor for ticket fields | — |
| 5 | Collaborative answers (TipTap + Yjs) | — |
| 6 | Load test at 20 000 connections, hardening | — |

## Build and test

Requirements: Rust ≥ 1.85, Node ≥ 22.6, `valkey-server` (integration tests),
`php-legacy` with the `redis` extension (plugin and interop tests).

```bash
./scripts/test-all.sh          # Rust unit + integration, PHP plugin, client
(cd server && cargo build --release)
(cd client && npm ci && npm run build)
```

## Install

```bash
sudo bash deploy/install.sh https://glpi.example.org   # first time
sudo bash deploy/update.sh                             # upgrades: binary and plugin files only
```

The script installs the binary and the sandboxed systemd service, the configuration
(`/etc/glpi-realtime/config.toml`), enables Valkey keyspace notifications, adds the
`/ws` location to the GLPI nginx vhost, raises nginx worker limits for 20 000
WebSockets, and installs and activates the GLPI plugin. Previous files are saved in
`/root/glpi-realtime-backup-*`.

## Configuration

See [`deploy/config.toml.example`](deploy/config.toml.example). Each value can be overridden
with `GLPI_RT_<SECTION>__<KEY>`. Plugin settings (Valkey socket and db, key prefix, cookie
name, enabled item types) are in GLPI's configuration table, context `plugin:realtime`,
and must match the server.

## Operations

- Health: `curl --unix-socket /run/glpi-realtime/rt.sock http://localhost/health`
- Metrics (Prometheus): `.../metrics` — `rt_connections`, `rt_handshakes_total{result}`,
  `rt_messages_in_total`, `rt_messages_out_total`, `rt_errors_total{code}`,
  `rt_disconnects_total{reason}`, `rt_revocations_total`, `rt_events_total`,
  `rt_events_rejected_total`.
- Browser debug: `localStorage.setItem('glpi-realtime-debug', '1')`, then reload.
