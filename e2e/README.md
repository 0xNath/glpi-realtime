# End-to-end tests

Real Chromium sessions (`/usr/bin/chromium` when present, else Playwright's: `npx playwright
install chromium`; override with `CHROMIUM`), against a disposable GLPI or your own.

## Disposable environment

`env/up.sh` starts, in containers (Docker Compose, else podman-compose): the official GLPI
image (`GLPI_VERSION`, any `docker.io/glpi/glpi` tag, default `12.0`) with HTTPS on
`https://localhost:8443` (self-signed) and the `/ws` location of
`deploy/examples/apache-glpi.conf`, glpi-realtime on a unix socket, Valkey and MariaDB.
It installs the plugin, creates the accounts below and the ticket with random passwords
(test-only plugin `env/rtseed`), runs `plugins:realtime:check` (fails on errors) and
writes the settings to `../.e2e.local.env`. Every run starts from scratch.

```bash
env/up.sh                                    # GLPI_VERSION=12.0.0 env/up.sh
npm ci && E2E_ENV_FILE=../.e2e.local.env npx playwright test
env/down.sh
```

The server is compiled in the image; `SERVER_SOURCE=server-prebuilt` takes
`env/bin/glpi-realtime` instead (a static binary: what the CI does).

## Your GLPI

### Accounts

| Login | Default profile | Test ticket |
|---|---|---|
| `rt-alice` | Technician | can open it |
| `rt-bob` | Technician | can open it |
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
```

## What is covered

Connection and presence, followups appearing live in the timeline (no content on the
WebSocket), the fields lock, "is writing" placeholders and shared drafts, the solution
button while the fields are edited, presence on the ticket list.

## Run (your GLPI)

```bash
npm ci && npx playwright test
```
