#!/usr/bin/env bash
# Upgrades an existing installation: server binary and plugin files only
# (configuration, nginx and Valkey are left untouched).
#
# Build first, as your user:   (cd server && cargo build --release) && (cd client && npm run build)
# Then:                        sudo bash deploy/update.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GLPI=/var/www/glpi
BIN="$ROOT/server/target/release/glpi-realtime"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)"; exit 1; }
[[ -x "$BIN" ]] || { echo "Missing $BIN: run 'cargo build --release' in server/ first"; exit 1; }
[[ -d "$GLPI/plugins/realtime" ]] || { echo "Not installed yet: use deploy/install.sh"; exit 1; }

echo "==> Server"
install -m 755 "$BIN" /usr/local/bin/glpi-realtime.new
/usr/local/bin/glpi-realtime.new --config /etc/glpi-realtime/config.toml --check
mv /usr/local/bin/glpi-realtime.new /usr/local/bin/glpi-realtime
install -m 644 "$ROOT/deploy/glpi-realtime.service" /etc/systemd/system/glpi-realtime.service
systemctl daemon-reload
systemctl restart glpi-realtime
sleep 1
curl -sf --unix-socket /run/glpi-realtime/rt.sock http://localhost/health && echo

echo "==> Plugin files"
rm -rf "$GLPI/plugins/realtime.new"
mkdir "$GLPI/plugins/realtime.new"
cp -r "$ROOT/plugin/setup.php" "$ROOT/plugin/hook.php" "$ROOT/plugin/src" "$ROOT/plugin/ajax" "$ROOT/plugin/public" \
    "$GLPI/plugins/realtime.new/"
chown -R root:root "$GLPI/plugins/realtime.new"
find "$GLPI/plugins/realtime.new" -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} +
rm -rf "$GLPI/plugins/realtime.old"
mv "$GLPI/plugins/realtime" "$GLPI/plugins/realtime.old"
mv "$GLPI/plugins/realtime.new" "$GLPI/plugins/realtime"
rm -rf "$GLPI/plugins/realtime.old"

echo "Done. Browsers pick up the new client on their next page load."
