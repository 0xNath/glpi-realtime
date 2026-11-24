# glpi-realtime

Optional real-time layer for GLPI 11 and 12, on tickets, changes and problems alike: presence,
typing indicators, live updates of the item and its timeline, instant notifications, a
single editor for the fields, one solution at a time, and shared answer drafts.

- `server/`: WebSocket server in Rust (tokio, axum, fred/Valkey).
- `plugin/`: GLPI plugin `realtime` (PHP): issues session tokens and per-item grants.
- `client/`: browser client in TypeScript, bundled into `plugin/public/realtime.js`.
- `deploy/`: `install.sh` (installs and upgrades the binary and the plugin), and
  `examples/`: configuration, systemd unit, system user, Valkey, nginx and Apache vhosts.
- `e2e/`: end-to-end tests in a real Chromium, against your GLPI or a disposable one
  (`e2e/env/`, containers) ([setup](e2e/README.md)).
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
| 6 | Load test at 20 000 connections ([results](#performance)), hardening | done |

## Performance

Measured with the load test tool on one machine (16 threads, server as its own process,
Valkey on a unix socket, version 0.4.0):

| | 20 000 connections on 2 000 items |
|---|---|
| Connecting all of them | 1.6 s, no failure; handshake + subscription p99 122 ms |
| One event in every item, published at once | all delivered, p99 149 ms |
| One newcomer in every item | every member told, p99 389 ms |
| Server memory | 541 MiB (≈ 25 KiB per connection) |
| Server CPU for the whole run | 10 s |

```bash
cd server && cargo run --release --example loadtest -- --valkey unix:///path/to/valkey.sock \
    --connections 20000 --rooms 2000 [--addr 127.0.0.1:8090]   # without --addr: starts its own server
```

It uses Valkey db 6 with the `rt:` prefix (sessions `rt:s:5eed…`) and removes its keys at
the end: point it to a test Valkey, not production's.

## Build and test

Requirements: Rust ≥ 1.85, Node ≥ 22.6, `valkey-server` (integration tests),
`php-legacy` with the `redis` extension (plugin and interop tests).

```bash
./scripts/test-all.sh          # Rust unit + integration, PHP plugin, client
(cd server && cargo build --release)
(cd client && npm ci && npm run build)
```

End-to-end, against a disposable GLPI in containers (Docker or Podman; any
`docker.io/glpi/glpi` tag with `GLPI_VERSION`):

```bash
e2e/env/up.sh && (cd e2e && npm ci && E2E_ENV_FILE=../.e2e.local.env npx playwright test)
e2e/env/down.sh
```

The CI runs them on GLPI 11.0, 12.0.0, the latest 12.0 and the next one (nightly, warning only).

## Install

`deploy/install.sh` only installs the project's own files: the server binary and the GLPI
plugin. It never writes configuration: the files below are set up once, by you, from
`deploy/examples/`, so that the project fits any distribution and upgrades never touch them.

Requirements: GLPI 11 or 12 with the PHP `redis` extension (phpredis), Valkey ≥ 9.0 (or Redis ≥ 7.4,
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
restarted if the unit exists], `SKIP_PLUGIN_UPGRADE=1` to only copy the plugin files,
`RELOAD_PHP` [command reloading GLPI's PHP after the copy, e.g. `systemctl reload
php-fpm`; without it the script waits `OPCACHE_WAIT`, 65 s, for opcache to revalidate].
PHP's opcache can otherwise serve old plugin files next to new ones for a while after an
upgrade.
For example:

```bash
sudo GLPI_DIR=/usr/share/glpi PHP=php8.3 deploy/install.sh                       # Debian-like
sudo PHP="env PHP_INI_SCAN_DIR=:/etc/webapps/glpi/php-cli php-legacy" \
     RELOAD_PHP="systemctl reload uwsgi@glpi" deploy/install.sh                        # Arch, uWSGI
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

Protect it: whoever can write to Valkey can forge sessions. Give the server and GLPI an
ACL user limited to `rt:*` keys and channels (`valkey.conf.example`); set its password in
`config.toml` (`[valkey] username`, `password`) and in GLPI with
`bin/console config:set --context=plugin:realtime valkey_password '…'` (encrypted
with GLPI's key).


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

### 5. Check

**Setup > Plugins > Realtime** (the plugin's configuration page, for users who may
change GLPI's configuration) checks everything the real-time layer needs and says how to
fix what is missing: PHP's redis extension, HTTPS, the plugin's tables and cron task, the
client bundle; Valkey (connection, ACL login, version, permissions); the server instances
(each publishes its status in Valkey: version, cookie name, allowed origins and item
types, keyspace notifications), compared with GLPI's settings; and, from the browser, the
web server's `/ws` location and a real WebSocket.

The same checks from the command line, for scripts and monitoring (run as the user
running GLPI; `deploy/install.sh` runs it at the end, `CHECK=0` to skip):

```bash
php bin/console plugins:realtime:check            # [--format=json] [--no-web]
```

The web server is checked through GLPI's URL (as browsers reach it): `/ws` must reach the
server, and a WebSocket upgrade must get through with GLPI's origin. Exit code, as
monitoring tools expect it: 0 everything works, 1 warnings, 2 errors.

### Releases

`scripts/release.sh` builds `dist/glpi-realtime-<version>-linux-<arch>.tar.gz` (the
binary, static when the `x86_64-unknown-linux-musl` target is installed, plus `deploy/`,
the plugin and the docs: run `deploy/install.sh` from it, nothing to compile) and
`dist/glpi-plugin-realtime-<version>.tar.bz2` (the plugin alone). The CI workflow
(`.github/workflows/ci.yml`) runs every suite and the dependency audits, and publishes
those archives for `v*` tags.

### Upgrading

Run step 1 again (see [CHANGELOG.md](CHANGELOG.md) for what to edit yourself). Configuration is never changed by an upgrade; notes for versions that
need you to edit it:

- **0.3.0**: changes and problems have every feature: add `"Change", "Problem"` to
  `security.allowed_itemtypes` in `config.toml` (the plugin adds them to its own list if
  it still had its old default).

## Configuration

See [`deploy/examples/config.toml.example`](deploy/examples/config.toml.example). Each value can be overridden
with `GLPI_RT_<SECTION>__<KEY>`. Plugin settings (Valkey socket and db, key prefix, cookie
name, enabled item types) are in GLPI's configuration table, context `plugin:realtime`,
and must match the server.

## Translations

- Plugin messages: GLPI's gettext, domain `realtime` (`plugin/locales/*.po`, compiled
  `.mo`). Maintainers: `scripts/i18n.py` extracts the strings and compiles.
- Browser texts: French and English are built in. Any other language:
  `cd client && npm run i18n-template` writes `plugin/locales/client/template.json`; copy it
  to `<lang>.json` (`de_DE.json` or `de.json`, after GLPI's language codes), translate
  the texts (`{0}`, `{1}`… are values), and deploy: no rebuild.

## Operations

- Health: `curl --unix-socket /run/glpi-realtime/rt.sock http://localhost/health`
- Metrics (Prometheus): `.../metrics` — `rt_connections`, `rt_handshakes_total{result}`,
  `rt_messages_in_total`, `rt_messages_out_total`, `rt_errors_total{code}`,
  `rt_disconnects_total{reason}`, `rt_revocations_total`, `rt_events_total`,
  `rt_events_rejected_total`.
- Browser debug: `localStorage.setItem('glpi-realtime-debug', '1')`, then reload.
