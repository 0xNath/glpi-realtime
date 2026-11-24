#!/usr/bin/env bash
# Builds the release archives in dist/:
#   glpi-realtime-<version>-linux-<arch>.tar.gz   server binary + deploy/ + docs
#   glpi-plugin-realtime-<version>.tar.bz2         GLPI plugin, ready for <GLPI>/plugins/
#   SHA256SUMS
# The binary is static (musl) when the target is installed:
#   rustup target add x86_64-unknown-linux-musl
# otherwise it is linked against the build host's glibc (said so below).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

server_v=$(sed -n 's/^version = "\(.*\)"$/\1/p' server/Cargo.toml | head -1)
plugin_v=$(sed -n "s/^define('PLUGIN_REALTIME_VERSION', '\(.*\)');$/\1/p" plugin/setup.php)
[[ "$server_v" == "$plugin_v" ]] || { echo "!! versions differ: server $server_v, plugin $plugin_v"; exit 1; }
grep -q "^## $server_v" CHANGELOG.md || { echo "!! CHANGELOG.md has no '## $server_v' section"; exit 1; }
python3 scripts/i18n.py --check
[[ -z "$(git status --porcelain)" ]] || echo "   warning: uncommitted changes are included"
VERSION=$server_v
ARCH=$(uname -m)

echo "==> Tests"
scripts/test-all.sh

echo "==> Client bundle"
(cd client && npm ci --silent && npm run -s build)

echo "==> Server binary"
TARGET="$ARCH-unknown-linux-musl"
if rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
    (cd server && cargo build --release --locked --target "$TARGET")
    BIN="server/target/$TARGET/release/glpi-realtime"
    echo "   static binary ($TARGET)"
else
    (cd server && cargo build --release --locked)
    BIN="server/target/release/glpi-realtime"
    echo "   glibc binary (install $TARGET for a static one)"
fi

rm -rf dist && mkdir -p dist/stage
S="dist/stage/glpi-realtime-$VERSION"
mkdir -p "$S/bin" "$S/plugin" "$S/deploy"
install -m 755 "$BIN" "$S/bin/glpi-realtime"
cp -r deploy/examples "$S/deploy/" && cp deploy/install.sh deploy/update.sh "$S/deploy/"
cp README.md CHANGELOG.md "$S/" && cp -r docs "$S/"
# install.sh expects the repository layout: plugin files and the bundle next to it.
cp -r plugin/setup.php plugin/hook.php plugin/src plugin/ajax plugin/front plugin/locales plugin/public "$S/plugin/"
tar -C dist/stage -czf "dist/glpi-realtime-$VERSION-linux-$ARCH.tar.gz" "glpi-realtime-$VERSION"

P="dist/stage/realtime"
mkdir -p "$P"
cp -r plugin/setup.php plugin/hook.php plugin/src plugin/ajax plugin/front plugin/locales plugin/public "$P/"
tar -C dist/stage -cjf "dist/glpi-plugin-realtime-$VERSION.tar.bz2" realtime

rm -rf dist/stage
(cd dist && sha256sum ./*.tar.* > SHA256SUMS)
ls -l dist
