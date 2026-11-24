#!/usr/bin/env bash
# Installs or upgrades glpi-realtime's own files: the server binary and the GLPI plugin.
# Run it the first time and after every update; it is idempotent.
#
# It never creates nor edits configuration: /etc/glpi-realtime/config.toml, the systemd
# unit, the system user, the web server (vhost), PHP and Valkey are yours to set up once,
# from deploy/examples/ (see README, "Install").
#
# From the repository, build first, as your user:
#   (cd server && cargo build --release) && (cd client && npm ci && npm run build)
# or use a release archive (scripts/release.sh), which holds the built files. Then, as root:
#   sudo deploy/install.sh
#
# Settings (environment variables), with their defaults:
#   GLPI_DIR=/var/www/glpi            GLPI installation (contains bin/console)
#   PREFIX=/usr/local                 the binary goes to $PREFIX/bin/glpi-realtime
#   CONFIG=/etc/glpi-realtime/config.toml   only read, to check it before switching binaries
#   PHP=php                           PHP CLI command, e.g. PHP=php8.3, PHP=php-legacy, or
#                                     PHP="env PHP_INI_SCAN_DIR=:/etc/webapps/glpi/php-cli php-legacy"
#   GLPI_USER=<owner of $GLPI_DIR/files>   system user running GLPI's console
#   SERVICE=glpi-realtime             systemd unit restarted if it exists ("" to skip)
#   SKIP_PLUGIN_UPGRADE=0             1: copy the plugin files only (run GLPI's
#                                     plugin install/upgrade yourself)
#   RELOAD_PHP=                       command reloading GLPI's PHP once the files are copied, so
#                                     that opcache serves no old file next to new ones, e.g.
#                                     "systemctl reload php-fpm", "systemctl reload uwsgi@glpi",
#                                     "systemctl reload apache2" (empty: the script waits until
#                                     PHP revalidates, see OPCACHE_WAIT)
#   OPCACHE_WAIT=65                   seconds waited without RELOAD_PHP (opcache.revalidate_freq + 5;
#                                     0 when opcache.validate_timestamps revalidates every request)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GLPI_DIR="${GLPI_DIR:-/var/www/glpi}"
PREFIX="${PREFIX:-/usr/local}"
CONFIG="${CONFIG:-/etc/glpi-realtime/config.toml}"
PHP="${PHP:-php}"
SERVICE="${SERVICE-glpi-realtime}"
SKIP_PLUGIN_UPGRADE="${SKIP_PLUGIN_UPGRADE:-0}"
# From a release archive (bin/glpi-realtime, no sources) or from the repository (built).
if [[ -x "$ROOT/bin/glpi-realtime" && ! -d "$ROOT/server" ]]; then
    BIN="$ROOT/bin/glpi-realtime"
else
    BIN="${BIN:-$ROOT/server/target/release/glpi-realtime}"
fi
DEST="$PREFIX/bin/glpi-realtime"

die() { echo "!! $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
[[ -x "$BIN" ]] || die "missing $BIN: run 'cargo build --release' in server/ first"
[[ -f "$ROOT/plugin/public/realtime.js" ]] || die "missing client bundle: run 'npm run build' in client/ first"
[[ -f "$GLPI_DIR/bin/console" ]] || die "no GLPI in $GLPI_DIR (set GLPI_DIR)"
# From the repository: refuse stale builds (sources newer than what would be installed).
if [[ -d "$ROOT/server/src" ]] && [[ -n "$(find "$ROOT/server/src" "$ROOT/server/Cargo.toml" "$ROOT/server/Cargo.lock" -newer "$BIN" -print -quit)" ]]; then
    die "$BIN is older than server/ sources: run 'cargo build --release' in server/ first"
fi
if [[ -d "$ROOT/client/src" ]] && [[ -n "$(find "$ROOT/client/src" -newer "$ROOT/plugin/public/realtime.js" -print -quit)" ]]; then
    die "plugin/public/realtime.js is older than client/src: run 'npm run build' in client/ first"
fi

# --- Server binary ----------------------------------------------------------------------
echo "==> Server binary: $DEST"
install -d "$PREFIX/bin"
install -m 755 "$BIN" "$DEST.new"
if [[ -f "$CONFIG" ]]; then
    # The new binary must accept the existing configuration before it replaces the old one.
    "$DEST.new" --config "$CONFIG" --check || { rm -f "$DEST.new"; die "$CONFIG is not valid for this version (see README)"; }
else
    echo "   no $CONFIG yet: create it from deploy/examples/config.toml.example"
fi
mv "$DEST.new" "$DEST"

# --- GLPI plugin --------------------------------------------------------------------------
echo "==> GLPI plugin: $GLPI_DIR/plugins/realtime"
NEW="$GLPI_DIR/plugins/realtime.new"
rm -rf "$NEW"
mkdir "$NEW"
cp -r "$ROOT/plugin/setup.php" "$ROOT/plugin/hook.php" "$ROOT/plugin/src" "$ROOT/plugin/ajax" \
    "$ROOT/plugin/front" "$ROOT/plugin/locales" "$ROOT/plugin/public" "$NEW/"
# Read-only for the web server, like GLPI's own code.
chown -R root:root "$NEW"
find "$NEW" -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} +
rm -rf "$GLPI_DIR/plugins/realtime.old"
[[ -d "$GLPI_DIR/plugins/realtime" ]] && mv "$GLPI_DIR/plugins/realtime" "$GLPI_DIR/plugins/realtime.old"
mv "$NEW" "$GLPI_DIR/plugins/realtime"
rm -rf "$GLPI_DIR/plugins/realtime.old"

# PHP's opcache may keep serving old plugin files for opcache.revalidate_freq seconds: the
# upgrade (and its activation) must only happen once PHP sees the new files only.
if [[ -n "${RELOAD_PHP:-}" ]]; then
    echo "==> Reloading PHP: $RELOAD_PHP"
    # shellcheck disable=SC2086
    $RELOAD_PHP
elif [[ "$SKIP_PLUGIN_UPGRADE" != 1 && "${OPCACHE_WAIT:-65}" -gt 0 ]]; then
    echo "==> Waiting ${OPCACHE_WAIT:-65} s for PHP's opcache to see the new files (set RELOAD_PHP to skip)"
    sleep "${OPCACHE_WAIT:-65}"
fi

if [[ "$SKIP_PLUGIN_UPGRADE" != 1 ]]; then
    # GLPI's console must run as the user owning GLPI's writable files.
    GLPI_USER="${GLPI_USER:-$(stat -c %U "$GLPI_DIR/files" 2>/dev/null || true)}"
    [[ -n "$GLPI_USER" && "$GLPI_USER" != root ]] || die "cannot tell which user runs GLPI: set GLPI_USER (or SKIP_PLUGIN_UPGRADE=1)"
    echo "==> Plugin install/upgrade (as $GLPI_USER, with: $PHP)"
    # Creates or upgrades the plugin's tables and cron task (settings are kept), then
    # activates it: GLPI disables a plugin whose version changed until it is upgraded.
    # shellcheck disable=SC2086 # $PHP may hold "env VAR=... php"
    runuser -u "$GLPI_USER" -- $PHP "$GLPI_DIR/bin/console" plugin:install --force --username=glpi realtime
    # shellcheck disable=SC2086
    runuser -u "$GLPI_USER" -- $PHP "$GLPI_DIR/bin/console" plugin:activate realtime
fi

# --- Service ------------------------------------------------------------------------------
if [[ -n "$SERVICE" ]] && command -v systemctl >/dev/null && systemctl cat "$SERVICE" >/dev/null 2>&1; then
    echo "==> Restarting $SERVICE"
    systemctl try-restart "$SERVICE"
else
    echo "   service not restarted (no systemd unit '$SERVICE'): restart the server yourself"
fi

echo
echo "Done. Browsers pick up the new client on their next page load."
echo "First install? Follow README, \"Install\": configuration, service, Valkey, web server."
