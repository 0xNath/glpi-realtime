# End-to-end tests

Real Chromium sessions (`/usr/bin/chromium` when present, else Playwright's: `npx playwright
install chromium`; override with `CHROMIUM`), against a disposable GLPI or your own.

## Disposable environment

`env/up.sh` starts, in containers (Docker Compose, else podman-compose): the official GLPI
image (`GLPI_VERSION`, any `docker.io/glpi/glpi` tag, default `12.0`) with HTTPS on
`https://localhost:8443` (self-signed) and the `/ws` location of
`deploy/examples/apache-glpi.conf`, glpi-realtime on a unix socket, Valkey on a unix
socket and MariaDB. It installs the plugin with `deploy/install.sh` from a release
layout, as users do, creates the accounts below (Alice Martin, Bob Durand, Carol Petit)
and the test items with random passwords (test-only plugin `env/rtseed`), runs
`plugins:realtime:check` (fails on errors) and writes the settings to
`../.e2e.local.env`. Every run starts from scratch.

```bash
env/up.sh                                    # GLPI_VERSION=11.0 env/up.sh
npm ci && E2E_ENV_FILE=../.e2e.local.env npx playwright test
env/down.sh
```

- `UPGRADE_FROM=v0.4.0`: installs that release's plugin first, creates data with it,
  upgrades with `deploy/install.sh`, and checks that the plugin is active, at the new
  version, with its data kept.
- `PLUGIN_MAX_GLPI=99.99.99`: lifts the plugin's newest GLPI, to try an unreleased one
  (`GLPI_VERSION=dev-nightly`).
- `SERVER_SOURCE=server-prebuilt`: takes `env/bin/glpi-realtime` (a static binary, as the
  CI does) instead of compiling the server in the image.
- `RELEASE_ARCHIVE=<glpi-realtime-<version>-linux-x86_64.tar.gz>`: installs that release
  archive (server and plugin) instead of this repository: what the CI does with each
  published release.
- Screenshots of the README and of GLPI's catalog, on a fresh environment:
  `npx playwright test --config screenshots.config.ts` (writes `docs/img/`).

## Your GLPI

### Accounts

| Login | Default profile | Test ticket |
|---|---|---|
| `rt-alice` | Technician | can open it |
| `rt-bob` | one that may change GLPI's configuration (e.g. Super-Admin) | can open it |
| `rt-carol` | any, but must have Self-Service (the test switches to it) | must NOT see it as Self-Service (not requester/observer) |

`user:grant` adds a profile but does not make it the default one: set *Default profile*
in Administration → Users → the user.

Credentials in `../.e2e.env` (or the file named by `E2E_ENV_FILE`) (mode 600, git-ignored):

```
GLPI_URL=https://glpi.example.org
RT_ALICE_PASSWORD=...
RT_BOB_PASSWORD=...
RT_CAROL_PASSWORD=...
RT_TICKET_ID=3
# Optional: the tests that need these are skipped without them.
RT_ASSIGN_TICKET_ID=4      # unassigned, rt-alice may assign herself (the test does, for good)
RT_SOLUTION_TICKET_ID=5    # assigned to rt-alice, unsolved (the test solves it, for good)
RT_CHANGE_ID=1
RT_PROBLEM_ID=1
RT_COMPUTER_ID=1           # the tests rename it and change its comment
RT_PROJECT_ID=1            # renamed by the tests
RT_PROJECT_TASK_ID=1       # renamed by the tests
```

## What is covered

Connection, presence and revocation at logout; followups appearing live in the timeline
(no content on the WebSocket); the fields lock, on tickets, changes and problems; "is
writing" placeholders, shared drafts followed live and taken over; the solution button
while the fields are edited, and GLPI refusing a second solution whatever the browser
does; presence on the ticket list; the bell (read and unread, preferences, assume) and
mentions notified at once; projects, project tasks and assets (presence, the single
editor of their form, GLPI refusing an outdated form, presence on the asset list); the
configuration page and its settings form; accessibility (axe-core, WCAG 2.1 AA) of the
real-time layer's elements; a Valkey restart (disposable environment only:
`E2E_VALKEY_RESTART`, written by `env/up.sh`), after which open pages come back by
themselves.

## Run (your GLPI)

```bash
npm ci && npx playwright test
```
