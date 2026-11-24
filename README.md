# glpi-realtime

Optional real-time layer for GLPI 12, on tickets, changes and problems alike: presence,
typing indicators, live updates of the item and its timeline, instant notifications, a
single editor for the fields, one solution at a time, and shared answer drafts.

- `server/`: WebSocket server in Rust (tokio, axum, fred/Valkey).
- `plugin/`: GLPI plugin `realtime` (PHP): issues session tokens and per-item grants.
- `client/`: browser client in TypeScript, bundled into `plugin/public/realtime.js`.
- `deploy/`: `install.sh` (installs and upgrades the binary and the plugin), and
  `examples/`: configuration, systemd unit, system user, Valkey, nginx and Apache vhosts.
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
| 4 | Single editor for ticket fields | done |
| 5 | Shared answer drafts: follow live, take over | done |
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

`deploy/install.sh` only installs the project's own files: the server binary and the GLPI
plugin. It never writes configuration: the files below are set up once, by you, from
`deploy/examples/`, so that the project fits any distribution and upgrades never touch them.

Requirements: GLPI 12 with the PHP `redis` extension (phpredis), Valkey ≥ 9.0 (or Redis ≥ 7.4,
for hash field TTLs), systemd (or any supervisor), nginx or Apache httpd ≥ 2.4.47.

### 1. Build, then install the files (also for every upgrade)

```bash
(cd server && cargo build --release) && (cd client && npm ci && npm run build)
sudo deploy/install.sh
```

Settings are environment variables (defaults in brackets): `GLPI_DIR` [`/var/www/glpi`],
`PREFIX` [`/usr/local`, binary in `$PREFIX/bin`], `CONFIG`
[`/etc/glpi-realtime/config.toml`, only read to validate it before switching binaries],
`PHP` [`php`], `GLPI_USER` [owner of `$GLPI_DIR/files`], `SERVICE` [`glpi-realtime`,
restarted if the unit exists], `SKIP_PLUGIN_UPGRADE=1` to only copy the plugin files.
For example:

```bash
sudo GLPI_DIR=/usr/share/glpi PHP=php8.3 deploy/install.sh                       # Debian-like
sudo PHP="env PHP_INI_SCAN_DIR=:/etc/webapps/glpi/php-cli php-legacy" deploy/install.sh   # Arch
```

The script copies the plugin into `$GLPI_DIR/plugins/realtime` (read-only for the web
server), runs GLPI's `plugin:install` and `plugin:activate` (tables, cron task; settings
are kept) and restarts the service. `deploy/update.sh` is an alias.

### 2. System user, configuration, service (once)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin glpi-realtime
#   or, with systemd-sysusers: deploy/examples/sysusers.conf in /etc/sysusers.d/
sudo install -d -m 750 -o root -g glpi-realtime /etc/glpi-realtime
sudo install -m 640 -o root -g glpi-realtime deploy/examples/config.toml.example /etc/glpi-realtime/config.toml
sudoedit /etc/glpi-realtime/config.toml      # allowed_origins, listen.group, valkey.url
glpi-realtime --config /etc/glpi-realtime/config.toml --check
```

`listen.group` is the web server's group (Arch: `http`, Debian/Ubuntu: `www-data`,
RHEL/Fedora: `nginx` or `apache`): the socket is `0660` so that only it can connect.

Copy `deploy/examples/glpi-realtime.service` to `/etc/systemd/system/`, adjust
`SupplementaryGroups` (Valkey's socket group and the web server's group) and the binary
path if `PREFIX` is not `/usr/local`, then `systemctl daemon-reload && systemctl enable
--now glpi-realtime`. The unit is sandboxed (no capabilities, read-only system, syscall
filter) and raises `LimitNOFILE` for 20 000 connections.

### 3. Valkey (once)

See `deploy/examples/valkey.conf.example`: a unix socket readable by its group (add the
`glpi-realtime` user and the user running PHP to that group), and
`notify-keyspace-events Kgx` for instant revocation at logout (else set
`revocation.keyspace_events = false`: sessions are then checked every 15 s). The plugin
settings (`valkey_socket`, `valkey_db`, `key_prefix`, `cookie_name`) default to the same
values as `config.toml.example`; change both sides together.

### 4. Web server (once)

The browser opens `wss://<glpi-host>/ws`: the GLPI vhost proxies that path to the
server's unix socket, with WebSocket upgrade and long timeouts. Full examples:
[`deploy/examples/nginx-glpi.conf`](deploy/examples/nginx-glpi.conf) and
[`deploy/examples/apache-glpi.conf`](deploy/examples/apache-glpi.conf).

nginx, inside the GLPI `server` block (plus the `upstream` and `limit_req_zone` at http
level, see the example):

```nginx
location = /ws {
    limit_req zone=glpi_ws burst=20 nodelay;
    proxy_pass http://glpi_realtime;              # upstream: unix:/run/glpi-realtime/rt.sock
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_buffering off;
}
```

Apache httpd ≥ 2.4.47 (`proxy`, `proxy_http`), inside the GLPI `VirtualHost`:

```apache
ProxyPass "/ws" "unix:/run/glpi-realtime/rt.sock|http://localhost/ws" upgrade=websocket timeout=3600
ProxyPreserveHost On
```

For 20 000 WebSockets, raise the web server's limits (nginx: `worker_rlimit_nofile`,
`worker_connections`; Apache event MPM: `MaxRequestWorkers` and related), as noted in the
examples.

### Upgrading

Run step 1 again. Configuration is never changed by an upgrade; notes for versions that
need you to edit it:

- **0.3.0**: changes and problems have every feature: add `"Change", "Problem"` to
  `security.allowed_itemtypes` in `config.toml` (the plugin adds them to its own list if
  it still had its old default).

## Configuration

See [`deploy/examples/config.toml.example`](deploy/examples/config.toml.example). Each value can be overridden
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
