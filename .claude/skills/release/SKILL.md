---
name: release
description: Prepare a glpi-realtime release (version bump, CHANGELOG, upgrade notes, full verification, review in a fresh session) up to the point where the maintainer pushes the tag. Use when asked to prepare, cut or check a release.
---

# Preparing a release

The maintainer pushes and tags; this prepares everything before that, and reports what
was verified with the actual outputs. Stop and ask when a step fails or a decision is
needed (e.g. whether a change is breaking).

## 1. What changed

- `git describe --tags --abbrev=0` gives the previous release; read
  `git log --oneline <previous>..HEAD` and `git diff --stat <previous>..HEAD`.
- Classify: features, fixes, configuration changes users must make, protocol changes.
  New version: minor for features or configuration changes, patch for fixes only.
  Tell the maintainer the proposed version and why before going on.

## 2. Version, CHANGELOG, upgrade notes

- `plugin/setup.php` (`PLUGIN_REALTIME_VERSION`), `server/Cargo.toml` (then
  `cargo update -p glpi-realtime --offline` in `server/`), `plugin.xml` (a new
  `<version>` with its download URL), `VERSION=` in the README's install step.
- CHANGELOG.md: a section for the version, user-facing first; a "Configuration"
  paragraph when users must edit something. The README's "Upgrading" list gets the
  same note.
- Compatibility bounds (`PLUGIN_REALTIME_MIN_GLPI` / `MAX_GLPI`) only change after the
  end-to-end tests passed on that GLPI.

## 3. Verify (report each result)

```bash
scripts/test-all.sh
python3 scripts/i18n.py --check
(cd server && cargo fmt --check)
(cd client && npm run build) && git diff --exit-code plugin/public/realtime.js
scripts/check-examples.sh
```

End-to-end on fresh environments (`e2e/env/up.sh`, then
`cd e2e && E2E_ENV_FILE=../.e2e.local.env npx playwright test`):

- `GLPI_VERSION=12.0`, `GLPI_VERSION=11.0`;
- `UPGRADE_FROM=<previous tag>` (data kept, plugin active at the new version);
- `RELEASE_ARCHIVE=` an archive from `SKIP_TESTS=1 scripts/release.sh` (what users get).

Every test must pass; a flaky one is investigated, not retried until green.

## 4. Review in a fresh session

The session that wrote the code shares its blind spots. Ask the maintainer to run, in a
new Claude Code session, on `<previous>..HEAD`:

- `/security-review` (sessions, grants, CSRF, what reaches Valkey and browsers);
- `/code-review`.

Fix what they find (with a test that fails before the fix), then verify again.

## 5. Hand over

Commit when the maintainer asks, then give them:

```bash
git push origin master
# once the CI is green:
git tag v<version> && git push origin v<version>
```

The tag publishes the archives (x86_64, aarch64), the image and their attestations, then
the `release-check` job installs the published archive and runs the end-to-end tests:
it must pass before announcing the release.
