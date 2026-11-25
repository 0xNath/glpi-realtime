#!/usr/bin/env bash
# Tests of deploy/notes.sh (the upgrade notes deploy/install.sh prints), on a changelog of
# its own (the real one changes with every release).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1"; diff <(echo "$3") <(echo "$2") | sed 's/^/     /'; fail=1; fi; }
cat >"$T/CHANGELOG.md" <<'MD'
# Changelog

## Unreleased

- Something new.

Configuration: set `a` (unreleased).

## 0.3.0

- More.

Configuration: add `b`,
then restart.

## 0.2.0

- Nothing to edit.

## 0.1.0

Configuration: first.
MD
notes() { "$ROOT/deploy/notes.sh" "$1" "$2" "$T/CHANGELOG.md"; }
check "upgrade over several versions: their notes, oldest first, those up to the target" \
    "$(notes 0.0.9 0.3.0 | grep -v Unreleased)" "$(printf '0.1.0 — Configuration: first.\n0.3.0 — Configuration: add `b`,\nthen restart.')"
check "from the repository: the unreleased notes too" \
    "$(notes 0.2.0 0.3.0)" "$(printf '0.3.0 — Configuration: add `b`,\nthen restart.\nUnreleased — Configuration: set `a` (unreleased).')"
check "a version without notes: nothing" "$(notes 0.1.0 0.2.0 | grep -v Unreleased)" ""
check "same version: only unreleased ones" "$(notes 0.3.0 0.3.0)" "Unreleased — Configuration: set \`a\` (unreleased)."
check "versions compare as versions (0.10 after 0.9)" \
    "$(printf '## 0.10.0\n\nConfiguration: ten.\n\n## 0.9.0\n\nConfiguration: nine.\n' >"$T/v.md"; "$ROOT/deploy/notes.sh" 0.9.0 0.10.0 "$T/v.md")" "0.10.0 — Configuration: ten."
check "no changelog: nothing" "$("$ROOT/deploy/notes.sh" 0.1.0 0.2.0 "$T/none.md")" ""
exit $fail
