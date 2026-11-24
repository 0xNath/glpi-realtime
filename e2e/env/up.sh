#!/usr/bin/env bash
# Starts the disposable e2e environment (GLPI, glpi-realtime, Valkey, MariaDB), installs
# the plugin with deploy/install.sh (from a release layout, as users do), creates the test
# accounts and items with random passwords, runs the plugin's checks, and writes the
# settings of the tests to $E2E_ENV_FILE. Then:
#   cd e2e && E2E_ENV_FILE=../.e2e.local.env npx playwright test
#
# Settings:
#   GLPI_VERSION [12.0]      a tag of docker.io/glpi/glpi
#   UPGRADE_FROM             a git ref (e.g. v0.4.0): install that plugin first, create data
#                            with it, then upgrade with deploy/install.sh and check that the
#                            plugin is active, at the new version, with its data kept
#   PLUGIN_MAX_GLPI          overrides the plugin's newest GLPI (testing an unreleased GLPI)
#   COMPOSE                  [docker compose, else podman-compose]
#   E2E_ENV_FILE             [<repo>/.e2e.local.env]
#   SERVER_SOURCE            [server-build: compiles the server; server-prebuilt:
#                            e2e/env/bin/glpi-realtime]
#   RELEASE_ARCHIVE          a release archive (glpi-realtime-<version>-linux-x86_64.tar.gz):
#                            installs it, server and plugin, instead of this repository
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
as_root() { compose exec -T -u root glpi "$@"; }
die() { echo "!! $*" >&2; compose logs glpi 2>&1 | tail -60 >&2; exit 1; }

# The older plugin of the upgrade test, built into the image (/opt/realtime-old).
find "$HERE/.old" -mindepth 1 ! -name .gitignore -exec rm -rf {} +
if [[ -n "${UPGRADE_FROM:-}" ]]; then
    echo "==> Plugin $UPGRADE_FROM, for the upgrade test"
    git -C "$ROOT" archive "$UPGRADE_FROM" plugin | tar -x -C "$HERE/.old"
fi

# The release installed: this repository, or a published archive.
find "$HERE/release" -mindepth 1 ! -name .gitignore -exec rm -rf {} +
if [[ -n "${RELEASE_ARCHIVE:-}" ]]; then
    echo "==> Release archive $(basename "$RELEASE_ARCHIVE")"
    tar -xzf "$RELEASE_ARCHIVE" -C "$HERE/release" --strip-components=1
    [[ -x "$HERE/release/bin/glpi-realtime" ]] || die "no bin/glpi-realtime in $RELEASE_ARCHIVE"
    export RELEASE_SOURCE=release-archive
fi

echo "==> GLPI $GLPI_VERSION: building and starting (from scratch)"
compose down -v >/dev/null 2>&1 || true
compose up -d --build

echo "==> Waiting for GLPI's installation"
code=000
for _ in $(seq 1 300); do
    code=$(curl -ks -o /dev/null -w '%{http_code}' "$URL/" || true)
    [[ "$code" == 200 ]] && break
    sleep 1
done
[[ "$code" == 200 ]] || die "GLPI did not start"
console --version
console config:set url_base "$URL"
if [[ -n "${PLUGIN_MAX_GLPI:-}" ]]; then
    as_root sed -i "s/define('PLUGIN_REALTIME_MAX_GLPI', '[^']*')/define('PLUGIN_REALTIME_MAX_GLPI', '$PLUGIN_MAX_GLPI')/" /opt/release/plugin/setup.php
fi

console plugin:install --username=glpi rtseed
console plugin:activate rtseed
seed() {
    alice=$(openssl rand -hex 12) bob=$(openssl rand -hex 12) carol=$(openssl rand -hex 12)
    out=$(console plugins:rtseed:seed --alice-password="$alice" --bob-password="$bob" --carol-password="$carol")
    echo "$out"
    grep -q '^ticket=[0-9]' <<<"$out" || die "seed: $out"
}
# deploy/install.sh as users run it (no systemd here: the server is supervisord's).
install_plugin() {
    as_root env GLPI_DIR=/var/www/glpi GLPI_USER=www-data SERVICE= OPCACHE_WAIT=3 CHECK=0 \
        CONFIG=/etc/glpi-realtime/config.toml /opt/release/deploy/install.sh
}

if [[ -n "${UPGRADE_FROM:-}" ]]; then
    as_root cp -r /opt/realtime-old/plugin /var/www/glpi/plugins/realtime
    console plugin:install --username=glpi realtime
    console plugin:activate realtime
    seed
    before=$(console plugins:rtseed:count)
    echo "   before: $before"
    echo "==> Upgrade with deploy/install.sh"
    install_plugin
    after=$(console plugins:rtseed:count)
    echo "   after:  $after"
    python3 - "$before" "$after" "$(sed -n "s/define('PLUGIN_REALTIME_VERSION', '\(.*\)');/\1/p" "$ROOT/plugin/setup.php")" <<'PY' || die "upgrade"
import json, sys
before, after, version = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
assert after["active"], "the plugin is not active after the upgrade"
assert after["version"] == version, f"version {after['version']}, expected {version}"
for table, n in before["tables"].items():
    assert after["tables"].get(table, 0) >= n, f"{table}: {n} rows before, {after['tables'].get(table)} after"
print(f"   upgraded to {version}, active, data kept")
PY
    # As the CHANGELOG asks of upgraders: the item types of 0.6.0 (projects, assets).
    console config:set --context=plugin:realtime enabled_itemtypes \
        '["Ticket","Change","Problem","Project","ProjectTask","Computer","Monitor","NetworkEquipment","Peripheral","Phone","Printer"]'
else
    echo "==> Install with deploy/install.sh"
    install_plugin
    seed
fi

id() { sed -n "s/^$1=\([0-9]*\).*/\1/p" <<<"$out"; }
umask 077
cat >"$ENV_FILE" <<ENV
GLPI_URL=$URL
RT_ALICE_PASSWORD=$alice
RT_BOB_PASSWORD=$bob
RT_CAROL_PASSWORD=$carol
RT_TICKET_ID=$(id ticket)
RT_ASSIGN_TICKET_ID=$(id assign_ticket)
RT_SOLUTION_TICKET_ID=$(id solution_ticket)
RT_CHANGE_ID=$(id change)
RT_PROBLEM_ID=$(id problem)
RT_COMPUTER_ID=$(id computer)
RT_PROJECT_ID=$(id project)
RT_PROJECT_TASK_ID=$(id project_task)
E2E_INSECURE=1
E2E_VALKEY_RESTART=$COMPOSE -f $HERE/compose.yaml restart valkey
ENV
echo "   settings of the tests: $ENV_FILE"

echo "==> Plugin checks"
sleep 2 # the server publishes its status every 10 s, the first one at start
set +e
console plugins:realtime:check
rc=$?
set -e
# Warnings are expected here (e.g. the purge task has not run yet); errors are not.
[[ $rc -lt 2 ]] || die "the plugin's checks found errors"
echo "Ready: $URL (stop it with e2e/env/down.sh)"
