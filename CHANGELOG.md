# Changelog

Server and plugin share one version number. Upgrades never change your configuration:
"Configuration" lists what to edit yourself.

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
