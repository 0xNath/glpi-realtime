#!/usr/bin/env bash
# Starts the disposable e2e environment (GLPI, glpi-realtime, Valkey, MariaDB), installs
# the plugin, creates the test accounts and ticket with random passwords, runs the plugin's
# checks, and writes the settings of the tests to $E2E_ENV_FILE. Then:
#   cd e2e && E2E_ENV_FILE=../.e2e.local.env npx playwright test
# Settings: GLPI_VERSION [12.0] (a tag of docker.io/glpi/glpi), COMPOSE [docker compose,
# else podman-compose], E2E_ENV_FILE [<repo>/.e2e.local.env], SERVER_SOURCE
# [server-build: compiles the server; server-prebuilt: e2e/env/bin/glpi-realtime].
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export GLPI_VERSION="${GLPI_VERSION:-12.0}"
ENV_FILE="${E2E_ENV_FILE:-$ROOT/.e2e.local.env}"
URL=https://localhost:8443
if [[ -z "${COMPOSE:-}" ]]; then
    if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE=podman-compose; fi
fi
# shellcheck disable=SC2086
compose() { $COMPOSE -f "$HERE/compose.yaml" "$@"; }
console() { compose exec -T glpi php bin/console "$@"; }

echo "==> GLPI $GLPI_VERSION: building and starting (from scratch)"
compose down -v >/dev/null 2>&1 || true
compose up -d --build

echo "==> Waiting for GLPI's installation"
for _ in $(seq 1 300); do
    code=$(curl -ks -o /dev/null -w '%{http_code}' "$URL/" || true)
    [[ "$code" == 200 ]] && break
    sleep 1
done
[[ "$code" == 200 ]] || { compose logs glpi | tail -50; echo "GLPI did not start" >&2; exit 1; }
console --version

echo "==> Plugins, settings, accounts"
console plugin:install --username=glpi realtime
console plugin:activate realtime
console plugin:install --username=glpi rtseed
console plugin:activate rtseed
console config:set url_base "$URL"
console config:set --context=plugin:realtime valkey_socket valkey:6379
alice=$(openssl rand -hex 12) bob=$(openssl rand -hex 12) carol=$(openssl rand -hex 12)
out=$(console plugins:rtseed:seed --alice-password="$alice" --bob-password="$bob" --carol-password="$carol")
ticket=$(sed -n 's/^ticket=\([0-9]*\).*/\1/p' <<<"$out")
[[ -n "$ticket" ]] || { echo "seed: $out" >&2; exit 1; }

umask 077
cat >"$ENV_FILE" <<ENV
GLPI_URL=$URL
RT_ALICE_PASSWORD=$alice
RT_BOB_PASSWORD=$bob
RT_CAROL_PASSWORD=$carol
RT_TICKET_ID=$ticket
E2E_INSECURE=1
ENV
echo "   settings of the tests: $ENV_FILE"

echo "==> Plugin checks"
sleep 2 # the server publishes its status every 10 s, the first one at start
set +e
console plugins:realtime:check
rc=$?
set -e
# Warnings are expected here (e.g. the purge task has not run yet); errors are not.
[[ $rc -lt 2 ]] || { compose logs glpi | tail -80; exit 1; }
echo "Ready: $URL (stop it with e2e/env/down.sh)"
