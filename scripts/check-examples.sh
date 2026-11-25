#!/usr/bin/env bash
# Runs the examples of deploy/ through the software they are written for, so that the
# documentation stays true: the server's configurations, Valkey's, nginx's and Apache's
# vhosts, the Caddyfile, the compose file, the Prometheus rules (and their tests), the
# systemd unit and sysusers file; and the metrics the
# README, the dashboard and the rules name are the server's. Needs Docker or Podman (CONTAINER=...) and
# cargo (server). Exit code 1 on the first broken example.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EX="$ROOT/deploy/examples"
if [[ -z "${CONTAINER:-}" ]]; then
    if command -v docker >/dev/null; then CONTAINER=docker; else CONTAINER=podman; fi
fi
if [[ -z "${COMPOSE:-}" ]]; then
    if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE=podman-compose; fi
fi
# The images, from scripts/examples-images/Dockerfile (which Dependabot keeps current).
image() { awk -v n="$1" '$1 == "FROM" && $3 == "AS" && $4 == n { print $2 }' "$ROOT/scripts/examples-images/Dockerfile"; }
NGINX=$(image nginx) HTTPD=$(image httpd) CADDY=$(image caddy) VALKEY=$(image valkey) PROMETHEUS=$(image prometheus)
for i in "$NGINX" "$HTTPD" "$CADDY" "$VALKEY" "$PROMETHEUS"; do [[ -n "$i" ]] || { echo "an image is missing from scripts/examples-images/Dockerfile" >&2; exit 1; }; done
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# check <label> <command...>: the command must succeed (its output shown only if not).
check() {
    local label=$1 out
    shift
    if out=$("$@" 2>&1); then
        echo "ok   $label"
    else
        echo "FAIL $label" >&2
        echo "$out" | tail -20 >&2
        exit 1
    fi
}
run() { "$CONTAINER" run --rm --network none "$@"; }

# A throw-away certificate where the vhosts expect one.
mkdir -p "$TMP/ssl"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=glpi.example.org \
    -keyout "$TMP/ssl/privkey.pem" -out "$TMP/ssl/fullchain.pem" 2>/dev/null
chmod 644 "$TMP/ssl/"*.pem

echo "== Server"
cargo build -q --manifest-path "$ROOT/server/Cargo.toml"
BIN="$ROOT/server/target/debug/glpi-realtime"
check "config.toml.example" "$BIN" --config "$EX/config.toml.example" --check
check "deploy/container/config.toml (with the variable the image needs)" \
    env GLPI_RT_SECURITY__ALLOWED_ORIGINS='["https://glpi.example.org"]' "$BIN" --config "$ROOT/deploy/container/config.toml" --check

echo "== systemd"
if command -v systemd-analyze >/dev/null; then
    # The unit as written, its binary the one just built: any warning (an unknown key, a
    # wrong value) fails, though systemd-analyze itself only exits 1 on errors.
    sed "s#/usr/local/bin/glpi-realtime#$BIN#g" "$EX/glpi-realtime.service" > "$TMP/glpi-realtime.service"
    check "glpi-realtime.service" sh -c 'out=$(systemd-analyze verify "$1" 2>&1); [ -z "$out" ] || { echo "$out"; exit 1; }' _ "$TMP/glpi-realtime.service"
    mkdir -p "$TMP/root/etc"
    check "sysusers.conf" sh -c 'systemd-sysusers --root="$1" "$2" && grep -q "^glpi-realtime:" "$1/etc/passwd"' _ "$TMP/root" "$EX/sysusers.conf"
else
    echo "skip glpi-realtime.service, sysusers.conf (no systemd here)"
fi

echo "== Valkey"
# The example as is, but its socket and data in a scratch directory; it must start.
check "valkey.conf.example" run -v "$EX/valkey.conf.example:/conf/valkey.conf:ro" "$VALKEY" \
    sh -c 'valkey-server /conf/valkey.conf --unixsocket /tmp/v.sock --dir /tmp --daemonize yes --pidfile /tmp/v.pid \
           && sleep 1 && test -s /tmp/v.pid'

echo "== nginx"
cat > "$TMP/nginx.conf" <<'EOF'
events {}
http {
    include /etc/nginx/mime.types;
    include /conf/nginx-glpi.conf;
}
EOF
# As /etc/nginx/nginx.conf: the example's relative includes (fastcgi_params) resolve there.
check "nginx-glpi.conf" run --entrypoint nginx -v "$TMP/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "$EX/nginx-glpi.conf:/conf/nginx-glpi.conf:ro" -v "$TMP/ssl:/etc/ssl/glpi:ro" "$NGINX" -q -t

echo "== Apache httpd"
cat > "$TMP/httpd.conf" <<'EOF'
Include conf/httpd.conf
LoadModule ssl_module modules/mod_ssl.so
LoadModule socache_shmcb_module modules/mod_socache_shmcb.so
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
LoadModule rewrite_module modules/mod_rewrite.so
Listen 443
Include /conf/apache-glpi.conf
EOF
check "apache-glpi.conf" run -v "$TMP/httpd.conf:/conf/httpd.conf:ro" -v "$EX/apache-glpi.conf:/conf/apache-glpi.conf:ro" \
    -v "$TMP/ssl:/etc/ssl/glpi:ro" "$HTTPD" sh -c 'mkdir -p /var/www/glpi/public && httpd -t -f /conf/httpd.conf'

echo "== Caddy"
check "Caddyfile.example" run -e GLPI_HOST=glpi.example.org -v "$EX/Caddyfile.example:/etc/caddy/Caddyfile:ro" "$CADDY" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "== Compose"
# shellcheck disable=SC2086
check "compose.yaml" env GLPI_HOST=glpi.example.org GLPI_DB_PASSWORD=example $COMPOSE -f "$EX/compose.yaml" config

echo "== Prometheus"
check "prometheus-rules.yml" run --entrypoint promtool -v "$EX/prometheus-rules.yml:/conf/prometheus-rules.yml:ro" "$PROMETHEUS" \
    check rules /conf/prometheus-rules.yml
# Each alert fires when it should, and only then (scripts/prometheus-rules.test.yml).
check "prometheus-rules.yml: alert tests" run --entrypoint promtool -v "$EX/prometheus-rules.yml:/conf/prometheus-rules.yml:ro" \
    -v "$ROOT/scripts/prometheus-rules.test.yml:/conf/test.yml:ro" "$PROMETHEUS" test rules /conf/test.yml

echo "== Metrics"
# The server's metrics (from its sources) against those the README lists (all of them)
# and those the dashboard and the alerts use (no other).
names() { grep -ohE "$1" "${@:2}" | grep -oE 'rt_[a-z_]+' | sort -u; }
names 'metrics::(counter|gauge|histogram)!\("rt_[a-z_]+"' -r "$ROOT/server/src" > "$TMP/server"
names '`rt_[a-z_]+`' "$ROOT/README.md" > "$TMP/readme"
names 'rt_[a-z_]+' "$EX/grafana-dashboard.json" "$EX/prometheus-rules.yml" > "$TMP/used"
check "README lists every metric of the server" diff "$TMP/server" "$TMP/readme"
check "dashboard and alerts use the server's metrics only" sh -c "comm -13 '$TMP/server' '$TMP/used' | (! grep .)"

echo "All examples are valid."
