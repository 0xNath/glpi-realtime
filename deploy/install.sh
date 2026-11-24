#!/usr/bin/env bash
# Installs / upgrades glpi-realtime on this host (Arch Linux, GLPI in /var/www/glpi,
# nginx vhost /etc/nginx/conf.d/glpi.conf, uWSGI php-legacy, Valkey on a unix socket).
#
# Build first, as your user:   (cd server && cargo build --release) && (cd client && npm run build)
# Then:                        sudo bash deploy/install.sh https://glpi.example.org
set -euo pipefail

ORIGIN="${1:?usage: install.sh <https://glpi-origin>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GLPI=/var/www/glpi
VHOST=/etc/nginx/conf.d/glpi.conf
NGINX_CONF=/etc/nginx/nginx.conf
VALKEY_CONF=/etc/valkey/valkey.conf
BIN="$ROOT/server/target/release/glpi-realtime"
BACKUP=/root/glpi-realtime-backup-$(date +%Y%m%d-%H%M%S)
CONSOLE=(runuser -u glpi -- env PHP_INI_SCAN_DIR=:/etc/webapps/glpi/php-cli php-legacy "$GLPI/bin/console")

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)"; exit 1; }
[[ -x "$BIN" ]] || { echo "Missing $BIN: run 'cargo build --release' in server/ first"; exit 1; }
[[ -f "$ROOT/plugin/public/realtime.js" ]] || { echo "Missing client bundle: run 'npm run build' in client/ first"; exit 1; }

echo "==> Backup in $BACKUP"
mkdir -p "$BACKUP"
cp -a "$VHOST" "$NGINX_CONF" "$BACKUP"/
[[ -f "$VALKEY_CONF" ]] && cp -a "$VALKEY_CONF" "$BACKUP"/

# --- Server -------------------------------------------------------------------------
echo "==> System user, binary, configuration"
install -m 644 "$ROOT/deploy/sysusers.conf" /etc/sysusers.d/glpi-realtime.conf
systemd-sysusers /etc/sysusers.d/glpi-realtime.conf
install -m 755 "$BIN" /usr/local/bin/glpi-realtime
install -d -m 750 -o root -g glpi-realtime /etc/glpi-realtime
if [[ ! -f /etc/glpi-realtime/config.toml ]]; then
    sed "s#https://glpi.example.org#${ORIGIN}#" "$ROOT/deploy/config.toml.example" > /etc/glpi-realtime/config.toml
    chown root:glpi-realtime /etc/glpi-realtime/config.toml
    chmod 640 /etc/glpi-realtime/config.toml
else
    echo "   keeping existing /etc/glpi-realtime/config.toml"
fi
install -d -m 755 /usr/local/share/doc/glpi-realtime
install -m 644 "$ROOT/README.md" /usr/local/share/doc/glpi-realtime/README.md

# --- Valkey: keyspace notifications for instant revocation ---------------------------
echo "==> Valkey keyspace notifications (Kgx)"
if [[ -f "$VALKEY_CONF" ]] && ! grep -qE '^\s*notify-keyspace-events\s+\S*K' "$VALKEY_CONF"; then
    printf '\n# glpi-realtime: instant session revocation\nnotify-keyspace-events Kgx\n' >> "$VALKEY_CONF"
fi
valkey-cli -s /run/valkey/valkey.sock CONFIG SET notify-keyspace-events Kgx >/dev/null

# --- Service ----------------------------------------------------------------------------
echo "==> systemd service"
install -m 644 "$ROOT/deploy/glpi-realtime.service" /etc/systemd/system/glpi-realtime.service
systemctl daemon-reload
/usr/local/bin/glpi-realtime --config /etc/glpi-realtime/config.toml --check
systemctl enable glpi-realtime.service
systemctl restart glpi-realtime.service
sleep 1
curl -sf --unix-socket /run/glpi-realtime/rt.sock http://localhost/health && echo

# --- nginx --------------------------------------------------------------------------------
echo "==> nginx: /ws location, upstream, worker limits"
python3 - "$VHOST" "$ROOT/deploy/nginx-upstream.conf" "$ROOT/deploy/nginx-location.conf" <<'EOF'
import sys, pathlib
vhost, up, loc = (pathlib.Path(p) for p in sys.argv[1:])
s = vhost.read_text()
if "upstream glpi_realtime" not in s:
    s = up.read_text() + "\n" + s
if "location = /ws" not in s:
    anchor = "    location ~ /\\. {"
    if anchor not in s:
        sys.exit("cannot find where to insert the /ws location in " + str(vhost))
    s = s.replace(anchor, loc.read_text() + "\n" + anchor, 1)
vhost.write_text(s)
EOF
sed -i -E 's/^(\s*worker_connections\s+)[0-9]+;/\116384;/' "$NGINX_CONF"
grep -q '^worker_rlimit_nofile' "$NGINX_CONF" || sed -i -E '/^worker_processes/a worker_rlimit_nofile 100000;' "$NGINX_CONF"
if ! nginx -t; then
    cp -a "$BACKUP/glpi.conf" "$VHOST"
    cp -a "$BACKUP/nginx.conf" "$NGINX_CONF"
    echo "!! nginx configuration invalid: previous files restored"
    exit 1
fi
systemctl reload nginx

# --- GLPI plugin -----------------------------------------------------------------------------
echo "==> GLPI plugin"
rm -rf "$GLPI/plugins/realtime.new"
mkdir "$GLPI/plugins/realtime.new"
cp -r "$ROOT/plugin/setup.php" "$ROOT/plugin/hook.php" "$ROOT/plugin/src" "$ROOT/plugin/ajax" "$ROOT/plugin/front" "$ROOT/plugin/public" \
    "$GLPI/plugins/realtime.new/"
chown -R root:root "$GLPI/plugins/realtime.new"
find "$GLPI/plugins/realtime.new" -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} +
rm -rf "$GLPI/plugins/realtime"
mv "$GLPI/plugins/realtime.new" "$GLPI/plugins/realtime"
"${CONSOLE[@]}" plugin:install --force --username=glpi realtime
"${CONSOLE[@]}" plugin:activate realtime

echo
echo "Done. Backup: $BACKUP"
echo "Check: open a ticket in GLPI, then: journalctl -u glpi-realtime -f"
echo "Browser debug: localStorage.setItem('glpi-realtime-debug', '1') then reload"
