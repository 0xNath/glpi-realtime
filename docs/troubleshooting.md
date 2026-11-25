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

## The checks, one by one

Each check of the configuration page and of `plugins:realtime:check`, by the name it
shows (French in parentheses), with what to do when it fails. The page says the same,
with the values of your installation.

| Check | When it fails | Fix |
|---|---|---|
| **PHP redis extension** (Extension PHP redis) | The PHP running GLPI has no phpredis | Install it for that PHP (Debian/Ubuntu `php-redis`, Arch `php-redis` or `php-legacy-redis`, RHEL `php-pecl-redis`), then restart PHP. |
| **HTTPS** (HTTPS) | GLPI is served over plain HTTP | Serve it over HTTPS: the session cookie is `Secure`. |
| **GLPI's URL** (URL de GLPI) | GLPI's URL setting differs from the address people use | Set the address shown in Setup > General > General setup, "URL of the application". |
| **Plugin tables** (Tables du plugin) | The plugin's tables are missing | Run the upgrade: `deploy/install.sh` (or `bin/console plugin:install --force realtime`, then `plugin:activate`). |
| **Notification purge task** (Tâche de purge des notifications) | Not registered, disabled, or never run | Run the upgrade; enable `inboxpurge` in Setup > Automatic actions; GLPI's cron (below). |
| **Time-to-resolve alerts task** (Tâche des alertes d'échéance de résolution) | Not registered, or not run for 30 minutes | Run the upgrade; a system cron job running `php front/cron.php` every minute, the task in mode CLI. |
| **Browser client** (Client navigateur) | `public/realtime.js` is missing | Install a release archive, or build it (`cd client && npm ci && npm run build`) and run `deploy/install.sh`. |
| **PHP opcache and upgrades** (Opcache PHP et mises à jour) | opcache never revalidates files | Reload PHP after each upgrade: `deploy/install.sh` with `RELOAD_PHP`. |
| **Your WebSocket session** (Votre session WebSocket) | No token for your GLPI session, or Valkey lost it | Log out and in again once the Valkey checks pass; if it recurs, check `valkey_db` and `key_prefix`. |
| **Valkey connection** (Connexion à Valkey) | No socket, refused, wrong password, or permission denied | See "Valkey" below: the socket path (`valkey_socket`), the socket's group, the ACL user and password. |
| **Valkey version** (Version de Valkey) | Older than Valkey 9.0 (or Redis 7.4) | Upgrade it: presence needs hash field expiry (`HEXPIRE`). |
| **Valkey permissions** (Droits sur Valkey) | The ACL refuses one of the plugin's commands | Allow the keys and channels of `key_prefix` (`deploy/examples/valkey.conf.example`). |
| **glpi-realtime server** (Serveur glpi-realtime) | No server reports to this Valkey database | Start it (`systemctl start glpi-realtime`, `journalctl -u glpi-realtime`); its `config.toml` must use GLPI's Valkey: same `url`, `db`, `key_prefix`. |
| **Server version** (Version du serveur) | Plugin and server versions differ | Install both from the same release: `deploy/install.sh` does. |
| **Session cookie name** (Nom du cookie de session) | The plugin and the server use different names | The same `cookie_name` in `config.toml` (`[security]`) and in the plugin's settings. |
| **Allowed origin** (Origine autorisée) | The server refuses the address people use | Add it to `[security] allowed_origins` in `config.toml`, restart the server. |
| **Item types** (Types d'éléments) | The server refuses item types enabled in GLPI | Remove `[security] allowed_itemtypes` (the server then follows GLPI), or add them. |
| **Instant logout** (Déconnexion immédiate) | Keyspace notifications are off or not verifiable | `notify-keyspace-events Kgx` in `valkey.conf`; otherwise logouts take up to 15 s to close WebSockets. |
| **Web server forwards /ws** (Le serveur web transmet /ws) | GLPI answers `/ws`, or the server is unreachable behind the proxy | See "Nothing real-time happens" below: the `/ws` location, the socket's group. |
| **WebSocket upgrade** (Upgrade WebSocket) | The proxy drops the upgrade headers, or refuses the origin | nginx `proxy_http_version 1.1` and the `Upgrade`/`Connection` headers; `allowed_origins`. |

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
php8.4-fpm`), or let it wait for opcache. If you copied the files yourself:

```bash
php bin/console plugin:install --force --username=<admin> realtime
php bin/console plugin:activate realtime
```

## Notifications

| Symptom | Cause | Fix |
|---|---|---|
| "Notification purge task: never run" | GLPI's automatic actions do not run | A system cron job running `php front/cron.php` every minute, as the user running GLPI. |
| "Time-to-resolve alerts task: never run", or last run more than 30 min ago | GLPI's automatic actions do not run, or not every few minutes: no time-to-resolve alerts, and changes made by the mail collector are notified late | The same system cron job, every minute; the task's mode CLI (Setup > Automatic actions). |
| A technician gets nothing | Their preferences (bell > settings) or GLPI rights: notifications follow what the user may see | Check the bell's preferences and the user's profile. |
| Marking read, "Assume" or preferences do nothing on GLPI 11 | Plugin older than 0.5.0 (GLPI 11's CSRF check) | Upgrade the plugin. |

## Presence

| Symptom | Cause | Fix |
|---|---|---|
| Nobody shown on a computer, project or other item (tickets work) | Its type is not enabled: an upgraded install keeps its item types | Enable it in Setup > Plugins > Realtime, "Settings". If the "Item types" check warns, `config.toml` still restricts them: remove `allowed_itemtypes` from `[security]` and restart the server. |
| Real-time stops after Valkey restarted (before 0.7.0) | The server's listeners did not reconnect | Upgrade (0.7.0 reconnects and subscribes again), or restart the server. |
| Someone stays shown after closing their tab | The browser did not close the connection (sleep, network loss) | They disappear after `limits.idle_timeout_secs` (90 s by default). |
| A self-service user sees support agents' names | The entity does not anonymize them | GLPI's entity setting "Anonymize support agents": the real-time layer applies it too. |

## Still stuck

Open an issue with the output of `plugins:realtime:check --format=json` (it holds no
password) and the server's log around the problem.
