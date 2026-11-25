#!/usr/bin/env bash
# Test coverage, to see what no test exercises (no threshold: the browser code is mostly
# covered by the end-to-end tests, which this does not measure). Rust with cargo-llvm-cov,
# the PHP plugin with pcov or Xdebug (each skipped when absent), the client with Node's
# built-in coverage. Needs what scripts/test-all.sh needs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Rust (unit + integration)"
if cargo llvm-cov --version >/dev/null 2>&1; then
    (cd "$ROOT/server" && cargo llvm-cov -q --summary-only)
else
    echo "skip: cargo-llvm-cov is not installed (cargo install cargo-llvm-cov; rustup component add llvm-tools-preview)"
fi

echo "== PHP plugin"
PHP=${PHP:-$(command -v php-legacy || command -v php)}
if "$PHP" -m 2>/dev/null | grep -qxiE 'pcov|xdebug'; then
    dir=$(mktemp -d)
    PHP_COVERAGE_DIR="$dir" "$ROOT/scripts/test-php.sh" >/dev/null
    "$PHP" "$ROOT/plugin/tests/coverage_report.php" "$dir"
    rm -rf "$dir"
else
    echo "skip: neither pcov nor Xdebug in $PHP (pecl install pcov)"
fi

echo "== Client (unit tests; DOM code is covered by e2e/)"
(cd "$ROOT/client" && npm run -s coverage) | sed -n '/start of coverage report/,/end of coverage report/p'
