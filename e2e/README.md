# End-to-end tests

Real Chromium sessions against the GLPI instance (`/usr/bin/chromium`, override with `CHROMIUM`).

## Accounts

| Login | Default profile | Test ticket |
|---|---|---|
| `rt-alice` | Technician | can open it |
| `rt-bob` | Technician | can open it |
| `rt-carol` | any, but must have Self-Service (the test switches to it) | must NOT see it as Self-Service (not requester/observer) |

`user:grant` adds a profile but does not make it the default one: set *Default profile*
in Administration → Users → the user.

Credentials in `../.e2e.env` (mode 600, git-ignored):

```
GLPI_URL=https://glpi.example.org
RT_ALICE_PASSWORD=...
RT_BOB_PASSWORD=...
RT_CAROL_PASSWORD=...
RT_TICKET_ID=3
```

## Run

```bash
npm ci && npx playwright test
```
