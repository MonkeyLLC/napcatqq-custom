#!/bin/bash
set -e

# ============================================================
# NapCat Docker 启动脚本
# 自动检测 QQ 安装路径，设置必要环境变量，启动 NapCat
# ============================================================

QQ_DIR="/opt/QQ"

# --- 检测 QQ 安装 ---
if [ ! -d "$QQ_DIR" ]; then
  echo "[ERROR] QQ 未安装，找不到 $QQ_DIR"
  exit 1
fi

# --- 定位 wrapper.node ---
if [ -z "$NAPCAT_WRAPPER_PATH" ]; then
  # 优先查找 resources/app/wrapper.node（标准路径）
  WRAPPER=$(find "$QQ_DIR" -name "wrapper.node" -type f 2>/dev/null | head -1)
  if [ -z "$WRAPPER" ]; then
    echo "[ERROR] 找不到 wrapper.node"
    exit 1
  fi
  export NAPCAT_WRAPPER_PATH="$WRAPPER"
fi

# --- 定位 QQ package.json ---
if [ -z "$NAPCAT_QQ_PACKAGE_INFO_PATH" ]; then
  PKG=$(find "$QQ_DIR" -name "package.json" -path "*/resources/app/*" -type f 2>/dev/null | head -1)
  if [ -n "$PKG" ]; then
    export NAPCAT_QQ_PACKAGE_INFO_PATH="$PKG"
  fi
fi

# --- 定位 / 生成 version config.json ---
if [ -z "$NAPCAT_QQ_VERSION_CONFIG_PATH" ]; then
  # 先查找已有的 config.json
  VER_CFG=$(find "$QQ_DIR" -name "config.json" -path "*/versions/*" -type f 2>/dev/null | head -1)

  if [ -z "$VER_CFG" ] && [ -n "$NAPCAT_QQ_PACKAGE_INFO_PATH" ]; then
    # QQ deb 可能没有 versions/config.json，从 package.json 中提取版本号自动生成
    LINUX_VER=$(node -e "
      const p = require('$NAPCAT_QQ_PACKAGE_INFO_PATH');
      const v = p.linuxVersion || p.version || '3.2.28-48517';
      console.log(v);
    " 2>/dev/null || echo "3.2.28-48517")

    BUILD_ID=$(echo "$LINUX_VER" | sed 's/.*-//')

    VER_CFG="/tmp/qq-version-config.json"
    cat > "$VER_CFG" <<VEOF
{
  "baseVersion": "$LINUX_VER",
  "curVersion": "$LINUX_VER",
  "prevVersion": "",
  "onErrorVersions": [],
  "buildId": "$BUILD_ID"
}
VEOF
    echo "[INFO] 自动生成 version config: $LINUX_VER (buildId=$BUILD_ID)"
  fi

  if [ -n "$VER_CFG" ]; then
    export NAPCAT_QQ_VERSION_CONFIG_PATH="$VER_CFG"
  fi
fi

# --- 确保数据目录存在 ---
mkdir -p "${NAPCAT_WORKDIR:-/app/data}"

# --- 打印启动信息 ---
echo "========================================="
echo " NapCat Custom Docker"
echo "========================================="
echo " WRAPPER:  $NAPCAT_WRAPPER_PATH"
echo " PACKAGE:  $NAPCAT_QQ_PACKAGE_INFO_PATH"
echo " CONFIG:   $NAPCAT_QQ_VERSION_CONFIG_PATH"
echo " WORKDIR:  $NAPCAT_WORKDIR"
echo "========================================="

exec node /app/napcat.mjs "$@"
