#!/usr/bin/env bash
# Runs every test suite. Needs valkey-server, php-legacy (or php) with the redis extension, node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Rust (unit + integration + interop)"
(cd "$ROOT/server" && cargo clippy --all-targets -q -- -D warnings && cargo test -q)

echo "== PHP plugin"
"$ROOT/scripts/test-php.sh"

echo "== Deployment scripts"
"$ROOT/scripts/test-deploy.sh"

echo "== Client"
(cd "$ROOT/client" && npm run -s typecheck && npm test --silent)

echo "All suites passed."
