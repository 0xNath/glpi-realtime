# Changelog

Server and plugin share one version number. Upgrades never change your configuration:
"Configuration" lists what to edit yourself.

## 0.5.0

- GLPI 11 is supported (11.0.0 or later). Fixed for it: list presence, the bell's actions,
  notification preferences and "assign to me" were refused by GLPI 11's CSRF check (the
  client now sends GLPI's token when the page has one).
- `bin/console plugins:realtime:check`: the configuration page's checks from the command
  line (text or JSON, exit code 0/1/2 for monitoring), including the web server's `/ws`
  location and WebSocket upgrade; `deploy/install.sh` runs it at the end (`CHECK=0` to skip).
- Troubleshooting guide (`docs/troubleshooting.md`), linked from the checks.
- Release archives for x86_64 and aarch64 (static binaries), with build provenance
  attestations (`gh attestation verify`).
- Plugin setting `valkey_socket` also accepts `host[:port]` (TCP), not only a unix socket.
- Accessibility (WCAG 2.1 AA, checked with axe-core): contrast of the bell's active tab
  and status badges, of the "is writing" placeholders and of the checks' badges whatever
  GLPI's palette; labels on the preferences' lists.
- Fixed: the commands given by the messages and the README are GLPI's `config:set` (not
  `glpi:config:set`) and `php front/cron.php`.
- Fixed: a presence update could keep a hovered avatar's user card from opening.
- Fixed: the English text of the fields lock ("has been editing … for a moment").
- `plugin.xml` for GLPI's plugin catalog; screenshots in the README.
- Client translation template moved to `plugin/locales/client-template.json`, so that
  `plugin/locales/client/` holds translations only (Weblate).
- Tests: disposable end-to-end environment (`e2e/env/`: GLPI, glpi-realtime, Valkey,
  MariaDB in containers; the plugin installed with `deploy/install.sh`), run by the CI on
  GLPI 11.0, 12.0.0, 12.0, after an upgrade from the previous release, and (warnings
  only) on 12.0 nightly and GLPI's main branch; new tests for the bell, changes and
  problems, draft takeover, the second solution refused by GLPI, accessibility.
- CI: actions pinned to commits, Dependabot for Cargo, npm and actions.

## 0.4.0

- GLPI refuses to save a ticket/change/problem fields form older than the database
  (optimistic concurrency, `date_mod`), whatever the browsers do.
- Rights changes apply during the session: profiles, groups, profile rights (grants
  deleted, affected tabs regrant); deactivated or deleted users are disconnected.
- Support agents are anonymized for self-service users when the entity asks GLPI to
  (`anonymize_support_agents`): presence, events, notifications, drafts, locks.
- Valkey ACL: user and password for the server (`valkey.username`, `valkey.password`) and
  the plugin (`valkey_username`, `valkey_password`, stored encrypted by GLPI).
- Load test tool (`cargo run --release --example loadtest`); 20 000 connections measured.
  Fixes found with it: listen backlog (bursts were delayed by 1–2 s), WebSocket buffers
  (memory divided by 6), `listen.type = "tcp"` in config.toml was rejected.
- Live timeline: background tabs reload once when shown, visible ones are spread.
- List pages: rows already granted are not checked again.
- Bell for self-service users (one tab); desktop notifications (opt-in per browser).
- Shared drafts: GLPI images shown in the read-only view; taking over a solution brings
  its locks along.
- Translations: plugin messages through GLPI's gettext (`plugin/locales/*.po`); other
  client languages from `plugin/locales/client/<lang>.json` (template generated).
- Accessibility: `prefers-reduced-motion`, keyboard navigation in the bell.
- Metrics for locks, drafts, notifications, list watches; example Grafana dashboard.
- End-to-end tests for the fields lock, live timeline, drafts and list presence;
  multi-instance and Valkey ACL tests; CI workflow; release archives.

Configuration: optional new keys `limits.listen_backlog` (4096),
`limits.max_watched_rooms` (200), `valkey.username`/`password`. Valkey ACL users need
the channels `rt:*` and `__keyspace@*__:rt:*` (see `deploy/examples/valkey.conf.example`).

## 0.3.0

- Changes and problems get every feature of tickets.
- Single editor also when a solution or a "put on hold" answer is being written.
- Shared answer drafts (step 5): follow live, take over.
- Presence on list pages (`watch`).
- Deployment installs the project's files only; configuration examples for nginx,
  Apache, systemd, Valkey.

Configuration: add `"Change", "Problem"` to `security.allowed_itemtypes`.

## 0.2.0

- Live ticket events and timeline; one solution at a time (GLPI-side guard).
- Notification bell (Notifier+ feature set): queues, preferences, sound, full page.
- Single editor for ticket fields (step 4).

## 0.1.0

- WebSocket server, session tokens and per-item grants, presence.
