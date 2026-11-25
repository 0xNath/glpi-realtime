# glpi-realtime: notes for Claude Code

Real-time layer for GLPI 11 and 12: Rust WebSocket server (`server/`), GLPI plugin
(`plugin/`, PHP), browser client (`client/`, TypeScript bundled into
`plugin/public/realtime.js`). README.md describes the features, install and layout;
docs/security.md the trust model (GLPI is the only authority, Valkey a trust boundary).

## Working rules (the maintainer's)

- Answer the maintainer in French; code, comments, docs, commit messages in English.
- Never write system configuration (vhosts, units, /etc): the project ships examples in
  `deploy/examples/`, users set things up themselves. `deploy/install.sh` only installs
  the project's own files.
- No `sudo` here. The maintainer deploys their instance (Arch, uWSGI) with:
  `sudo PHP="env PHP_INI_SCAN_DIR=:/etc/webapps/glpi/php-cli php-legacy" RELOAD_PHP="systemctl reload uwsgi@glpi" deploy/install.sh`
- Do not commit the project to anything on the maintainer's behalf (response times,
  support, guarantees) in docs or policies.
- Dependencies and CI actions: exact versions at least two weeks old; actions pinned to
  a commit SHA with the version in a comment (Dependabot updates them).

## Autonomy

The maintainer wants Claude to work on this project on its own. Within these bounds,
act without asking; report what was done (pull request links, what was verified).

**On its own**
- Work on a branch (`claude/<topic>`), commit, push, open a pull request and enable
  auto-merge (`gh pr merge --auto --squash`): `master` is protected and only merges when
  the required CI checks pass. Never push to `master` directly.
- Push through `gh` without touching git's configuration:
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push -u origin <branch>`.
- Dependabot pull requests: check what changes (release notes for majors, the two-week
  rule), merge when green, close with an explanation otherwise.
- Issues labelled `claude`: the work queue. Reproduce, fix with a test that fails
  without the fix, open the pull request, link it from the issue.
- Triage new issues, answer installation questions from docs/troubleshooting.md.

**On its own, but say so in the pull request and the CHANGELOG**
- Changes of defaults, configuration users must edit, upgrade behaviour, the protocol:
  list the decision and its alternatives in the pull request description.

**Never without the maintainer**
- Tags and releases (they publish archives and the image), secrets, repository
  settings and branch protection, deleting branches other than merged `claude/*` ones,
  rewriting published history, force pushes.
- Anything said publicly in the project's name beyond issue and pull request comments
  (announcements, the GLPI catalog, forums).
- The maintainer's own server: deploying needs `sudo`. Tell them when a merged change
  is worth deploying, with the command above.
- Spending beyond the CI (paid services, new hosted tools).

When blocked on one of these, finish everything else, then ask once with the options.

## Verify, do not assume

Every change is checked by running it; report the actual output.

```bash
scripts/test-all.sh                       # Rust (clippy -D warnings, unit, integration), PHP plugin, client
(cd client && npm run build)              # the bundle is committed: rebuild after client/src changes
python3 scripts/i18n.py                   # after plugin message changes; French catalog must stay complete
(cd client && npm run i18n-template)      # after client text changes
scripts/check-examples.sh                 # after deploy/ changes: examples run through nginx, httpd, Caddy, Valkey, compose
scripts/coverage.sh                       # what no unit/integration test exercises (also in the CI's summary)
```

End-to-end, in a disposable GLPI (Podman here, Docker in the CI): build, install with
`deploy/install.sh`, seed accounts and items, then Playwright.

```bash
e2e/env/up.sh                                            # GLPI_VERSION=11.0|12.0.0|12.0|dev-nightly
cd e2e && E2E_ENV_FILE=../.e2e.local.env npx playwright test
e2e/env/down.sh
```

The suite can run again on the same environment: the tests that change their item for
good (assume, solution) skip themselves once done, with the reason.

Options of `up.sh`: `UPGRADE_FROM=v0.6.0` (upgrade test), `RELEASE_ARCHIVE=...` (install
a release archive), `PLUGIN_MAX_GLPI=99.99.99` (unreleased GLPI). Plain
`npx playwright test` in `e2e/` runs against the maintainer's instance
(https://glpi.renaudna.fr, accounts rt-alice, rt-bob (admin), rt-carol in `.e2e.env`).

- A bug fix comes with a test that fails without it: show it failing on the old code.
- Reproduce reported problems in the disposable environment before changing code.
- Screenshots of the README: `npx playwright test --config screenshots.config.ts` on a
  fresh environment.

## Known pitfalls

- GLPI deactivates a plugin whose `plugin_init` throws, and opcache may serve old files
  next to new ones after an upgrade: nothing in `setup.php` may fail before its `try`.
- GLPI 11 checks a CSRF token on AJAX POSTs (`X-Glpi-Csrf-Token`, `client/src/http.ts`);
  GLPI 12 relies on `Sec-Fetch-Site`. GLPI 12 loads answer forms after the page.
- GLPI's console command is `config:set`; its cron is `php front/cron.php`.
- Podman rootless: no port below 1024; unix socket paths must stay under 108 bytes (the
  scratchpad path is too long for one).
- `cargo fuzz` needs `--target <host>` (prebuilt cargo-fuzz defaults to musl).
- The server must keep listening across Valkey restarts (`store::subscriber`); every
  room needs a grant GLPI wrote, which is what makes `allowed_itemtypes` optional.

## Releases

Use the project skill `/release` (`.claude/skills/release/`): suites, e2e matrix,
review in a fresh session, CHANGELOG and README "Upgrading", version bump, then the
maintainer pushes the tag. The CI publishes archives and the image, then checks the
published release.

## CI

`.github/workflows/ci.yml` runs everything above plus the e2e matrix, load test, fuzzing
and, for tags, the release jobs; on pull requests (not on pushes to other branches:
a branch's CI starts with its pull request), master, tags, and every Monday at 02:00 UTC
(the GLPI nightly jobs). Follow a run with `gh run watch` / `gh run view --log-failed`,
`gh pr checks`, or `/loop` to check back.

`.github/workflows/claude.yml`: Claude on GitHub (@claude from maintainers, triage of
new issues with comment/label rights only, reviews of pull requests from this
repository); off until the repository variable `CLAUDE_ENABLED=true` and the secret
`ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) exist, and the Claude GitHub app is
installed.

## Working in parallel

Independent tasks (docs, a fuzz target, a feature) can run in subagents or isolated
worktrees; reviews of a release diff are best done by a fresh session (`/code-review`,
`/security-review`), not the one that wrote the code.
