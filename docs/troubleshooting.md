# Troubleshooting

Start with the checks: **Setup > Plugins > Realtime** in GLPI, or, as the user running
GLPI, in GLPI's directory:

```bash
php bin/console plugins:realtime:check
```

Each failing check says what is wrong and how to fix it; this page explains the usual
causes in more detail. The server's log: `journalctl -u glpi-realtime`. In a browser:
`localStorage.setItem('glpi-realtime-debug', '1')`, reload, and read the console.

GLPI keeps working whatever fails here: the real-time layer only adds to it.

## Nothing real-time happens in the browser

| Symptom | Cause | Fix |
|---|---|---|
| No bell, no presence bar | The plugin is not active, or PHP serves an old copy of it | Setup > Plugins: activate it. After an upgrade, see [below](#the-plugin-was-deactivated-after-an-upgrade). |
| "Web server forwards /ws": HTTP 404 | The vhost has no `/ws` location: GLPI answers | Add it (README, "Web server"), reload the web server. |
| HTTP 502, 503 or 504 on `/ws` | The web server cannot reach the server's socket | `systemctl status glpi-realtime`. The socket is `0660`: the web server's user must be in `[listen] group` (Debian: `www-data`, RHEL: `nginx`/`apache`). |
| "WebSocket upgrade": HTTP 400 | The proxy does not pass the upgrade | nginx: `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`, `proxy_set_header Connection "upgrade"`. Apache ≥ 2.4.47: `upgrade=websocket` on the `ProxyPass`. |
| HTTP 403 on the WebSocket | The browser's origin is not allowed | `[security] allowed_origins` in `config.toml` must hold GLPI's address exactly as browsers use it (`https://glpi.example.org`, with the port if not 443), then restart the server. Behind another proxy, it must pass `Host` (and `X-Forwarded-Proto`). |
| HTTP 401 on the WebSocket | No session token for this GLPI session | Log out and in again (the token is issued at login). If it keeps happening: the plugin's `cookie_name` and `[security] cookie_name` differ, or GLPI and the server use different Valkey databases or prefixes (`valkey_db`, `key_prefix`). |
| HTTP 429 | The web server's rate limit (nginx `limit_req` on `/ws`, or on `login.php`) | Raise its `burst`: every tab opens a WebSocket, and reconnects after a server restart. |
| Works over HTTPS only | By design: the session cookie is `Secure` | Serve GLPI over HTTPS. |

## Valkey

| Symptom | Cause | Fix |
|---|---|---|
| "Permission denied" on the socket | The user running PHP, or `glpi-realtime`, is not in the socket's group | Add both users to Valkey's socket group (`unixsocketperm 660`), restart PHP and the server. |
| `NOAUTH` or `WRONGPASS` | ACL user or password differs between Valkey, `config.toml` and GLPI | Same user and password in the three places (README, "Valkey"). |
| "does not expire hash fields" | Valkey < 9.0 or Redis < 7.4 (no `HEXPIRE`) | Upgrade Valkey (or Redis). |
| Logouts take up to 15 s to close WebSockets | Keyspace notifications are off | `notify-keyspace-events Kgx` in `valkey.conf`, and `[revocation] keyspace_events = true`. |

## The plugin was deactivated after an upgrade

GLPI deactivates a plugin whose version changed until it is upgraded, and PHP's opcache
may serve old plugin files next to new ones for `opcache.revalidate_freq` seconds.
`deploy/install.sh` handles both: run it with `RELOAD_PHP` (e.g. `systemctl reload
php8.3-fpm`), or let it wait for opcache. If you copied the files yourself:

```bash
php bin/console plugin:install --force --username=<admin> realtime
php bin/console plugin:activate realtime
```

## Notifications

| Symptom | Cause | Fix |
|---|---|---|
| "Notification purge task: never run" | GLPI's automatic actions do not run | A system cron job running `php front/cron.php` every minute, as the user running GLPI. |
| A technician gets nothing | Their preferences (bell > settings) or GLPI rights: notifications follow what the user may see | Check the bell's preferences and the user's profile. |
| Marking read, "Assume" or preferences do nothing on GLPI 11 | Plugin older than 0.5.0 (GLPI 11's CSRF check) | Upgrade the plugin. |

## Presence

| Symptom | Cause | Fix |
|---|---|---|
| Someone stays shown after closing their tab | The browser did not close the connection (sleep, network loss) | They disappear after `limits.idle_timeout_secs` (90 s by default). |
| A self-service user sees support agents' names | The entity does not anonymize them | GLPI's entity setting "Anonymize support agents": the real-time layer applies it too. |

## Still stuck

Open an issue with the output of `plugins:realtime:check --format=json` (it holds no
password) and the server's log around the problem.
