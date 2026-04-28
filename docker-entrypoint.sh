#!/bin/bash
set -euo pipefail

QQ_DIR="/opt/QQ"
QQ_APP_DIR="$QQ_DIR/resources/app"
NAPCAT_DIR="/app/napcat"
DATA_DIR="${NAPCAT_WORKDIR:-/app/data}"
QQ_CONFIG_DIR="$DATA_DIR/.config/QQ"
QQ_VERSION_CONFIG="$QQ_CONFIG_DIR/versions/config.json"
QQ_PACKAGE_JSON="$QQ_APP_DIR/package.json"
QQ_LOAD_SCRIPT="$QQ_APP_DIR/loadNapCat.js"

if [ ! -d "$QQ_DIR" ]; then
  echo "[ERROR] QQ is not installed at $QQ_DIR"
  exit 1
fi

if [ ! -f "$NAPCAT_DIR/napcat.mjs" ]; then
  echo "[ERROR] NapCat bundle not found at $NAPCAT_DIR/napcat.mjs"
  exit 1
fi

mkdir -p "$DATA_DIR" "$DATA_DIR/config" "$DATA_DIR/logs" "$DATA_DIR/cache" "$DATA_DIR/plugins"
mkdir -p "$QQ_CONFIG_DIR/versions" /app/.config

cp -rn "$NAPCAT_DIR/config/." "$DATA_DIR/config/" 2>/dev/null || true

export HOME=/app
export XDG_CONFIG_HOME=/app/.config
export DISPLAY="${DISPLAY:-:99}"

rm -rf /app/.config/QQ
ln -s "$QQ_CONFIG_DIR" /app/.config/QQ

if [ ! -f "$QQ_VERSION_CONFIG" ]; then
  LINUX_VER="$(node -e "const p = require('$QQ_PACKAGE_JSON'); console.log(p.linuxVersion || p.version || '3.2.28-48517')")"
  BUILD_ID="${LINUX_VER##*-}"
  cat > "$QQ_VERSION_CONFIG" <<EOF
{
  "baseVersion": "$LINUX_VER",
  "curVersion": "$LINUX_VER",
  "prevVersion": "",
  "onErrorVersions": [],
  "buildId": "$BUILD_ID"
}
EOF
  echo "[INFO] Generated QQ version config: $LINUX_VER (buildId=$BUILD_ID)"
fi

cat > "$QQ_LOAD_SCRIPT" <<'EOF'
const path = require('path');

(async () => {
  await import('file://' + path.join('/app/napcat', 'napcat.mjs'));
})();
EOF

if [ ! -f "${QQ_PACKAGE_JSON}.napcat.bak" ]; then
  cp "$QQ_PACKAGE_JSON" "${QQ_PACKAGE_JSON}.napcat.bak"
fi

node -e "
  const fs = require('fs');
  const file = '$QQ_PACKAGE_JSON';
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.main = './loadNapCat.js';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
"

echo "========================================="
echo " NapCat Custom Docker"
echo "========================================="
echo " QQ APP:   $QQ_APP_DIR"
echo " NAPCAT:   $NAPCAT_DIR"
echo " WORKDIR:  $DATA_DIR"
echo " DISPLAY:  $DISPLAY"
echo "========================================="

rm -f /tmp/.X99-lock
Xvfb "$DISPLAY" -screen 0 1366x768x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
sleep 1

if command -v dbus-run-session >/dev/null 2>&1; then
  exec dbus-run-session -- "$QQ_DIR/qq" --no-sandbox "$@"
fi

exec "$QQ_DIR/qq" --no-sandbox "$@"
