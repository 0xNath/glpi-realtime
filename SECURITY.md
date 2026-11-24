# Security policy

glpi-realtime handles GLPI sessions (a WebSocket token per session) and decides, from what
GLPI wrote, who may follow which item. A flaw here can expose who works on what, the
titles of items, shared drafts, or let someone act in another user's name: please report
it privately.

## Reporting a vulnerability

Use GitHub's private reporting: **Security > Report a vulnerability** on this repository
(<https://github.com/0xNath/glpi-realtime/security/advisories/new>). Do not open a public
issue, and do not test on a GLPI you do not own: the disposable environment of the
end-to-end tests (`e2e/env/up.sh`) gives you one in a few minutes.

Please include: the version (`plugins:realtime:check` prints it), GLPI's version, what an
attacker needs (an account? which profile? network access to Valkey?), and steps or a
proof of concept. Fixes are released as soon as they are ready, with an advisory
crediting you (unless you prefer not to be named).

## Supported versions

Security fixes go to the latest release only: upgrades never change your configuration
(`deploy/install.sh`, see the README).

## Scope

In scope: the server (`server/`), the GLPI plugin (`plugin/`), the browser client
(`client/`), the installation script and the examples of `deploy/`.

Out of scope, by design (see [docs/security.md](docs/security.md)):

- Write access to Valkey: whoever can write `rt:*` keys can forge sessions and grants.
  Valkey must be reachable only by the server and GLPI (unix socket, ACL user).
- GLPI's own vulnerabilities, and what any GLPI user can already see in GLPI.
- Denial of service needing more connections than the configured limits allow.
