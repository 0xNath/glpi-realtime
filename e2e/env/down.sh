#!/usr/bin/env bash
# Stops the disposable e2e environment and removes its data.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "${COMPOSE:-}" ]]; then
    if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE=podman-compose; fi
fi
# shellcheck disable=SC2086
$COMPOSE -f "$HERE/compose.yaml" down -v
