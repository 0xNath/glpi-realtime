#!/usr/bin/env bash
# The PHP plugin's tests (part of scripts/test-all.sh). Needs valkey-server and PHP with
# the redis extension. With PHP_COVERAGE_DIR set (scripts/coverage.sh), each test script
# also records which lines of plugin/src it ran (pcov or Xdebug) into that directory.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHP=${PHP:-$(command -v php-legacy || command -v php)}
# Load igbinary/redis only when this PHP does not already (setup-php, distro packages).
PHPX=()
for ext in igbinary redis; do
    "$PHP" -m 2>/dev/null | grep -qx "$ext" || PHPX+=(-d "extension=$ext")
done
if [[ -n "${PHP_COVERAGE_DIR:-}" ]]; then
    PHPX+=(-d pcov.enabled=1 -d "pcov.directory=$ROOT/plugin/src" -d xdebug.mode=coverage
           -d "auto_prepend_file=$ROOT/plugin/tests/coverage_prepend.php")
fi

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
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/guard_test.php"
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/rights_test.php" "$PORT"
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/health_test.php" "$PORT"
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/settings_test.php"
"$PHP" "${PHPX[@]}" "$ROOT/plugin/tests/sla_test.php"
