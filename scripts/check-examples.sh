#!/usr/bin/env bash
# Runs the examples of deploy/ through the software they are written for, so that the
# documentation stays true: the server's configurations, Valkey's, nginx's and Apache's
# vhosts, the Caddyfile, the compose file, the Prometheus rules; and the metrics the
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
NGINX=docker.io/library/nginx:1.31.8
HTTPD=docker.io/library/httpd:2.4.70
CADDY=docker.io/library/caddy:2.11.8
VALKEY=docker.io/valkey/valkey:9.0
PROMETHEUS=docker.io/prom/prometheus:v3.5.0
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
check "prometheus-rules.yml" run --entrypoint promtool -v "$EX/prometheus-rules.yml:/conf/rules.yml:ro" "$PROMETHEUS" \
    check rules /conf/rules.yml

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
