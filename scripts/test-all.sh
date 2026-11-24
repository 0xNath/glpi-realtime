#!/usr/bin/env bash
# Runs every test suite. Needs valkey-server, php-legacy (or php) with the redis extension, node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHP=$(command -v php-legacy || command -v php)
PHPX=(-d extension=igbinary -d extension=redis)

echo "== Rust (unit + integration + interop)"
(cd "$ROOT/server" && cargo clippy --all-targets -q -- -D warnings && cargo test -q)

echo "== PHP plugin"
for f in $(find "$ROOT/plugin" -name '*.php'); do "$PHP" -l "$f" >/dev/null; done
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
valkey-server --port "$PORT" --bind 127.0.0.1 --save "" --appendonly no >/dev/null 2>&1 &
VK=$!
trap 'kill $VK 2>/dev/null' EXIT
sleep 0.3
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/plugin_test.php" "$PORT"
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/events_test.php" "$PORT"
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/inbox_test.php"
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/solution_test.php"

echo "== Client"
(cd "$ROOT/client" && npm run -s typecheck && npm test --silent)

echo "All suites passed."
