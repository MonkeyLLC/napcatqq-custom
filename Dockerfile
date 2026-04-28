# ============================================================
# NapCat 自定义 Docker 镜像（支持 amd64 / arm64）
# 构建: docker build -t napcat-custom .
# 运行: docker run -d -p 6099:6099 -p 3000:3000 -v napcat-data:/app/data --name napcat napcat-custom
# ============================================================

# ------ Stage 1: 编译 NapCat ------
FROM node:20-slim AS builder

RUN npm install -g pnpm

WORKDIR /build
COPY . .
RUN pnpm install
RUN pnpm run build:shell

# ------ Stage 2: 运行环境 ------
FROM node:20-slim

# QQ Linux 版本，可通过 --build-arg 覆盖
ARG QQ_DEB_URL_AMD64=https://dldir1v6.qq.com/qqfile/qq/QQNT/f9cbaab2/linuxqq_3.2.28-48517_amd64.deb
ARG QQ_DEB_URL_ARM64=https://dldir1v6.qq.com/qqfile/qq/QQNT/f9cbaab2/linuxqq_3.2.28-48517_arm64.deb

# 安装 QQ Linux 及运行时依赖
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      wget ca-certificates \
      # wrapper.node 运行时依赖的共享库
      libglib2.0-0 libnss3 libatk-bridge2.0-0 \
      libcups2 libdrm2 libgtk-3-0 libgbm1 \
      libasound2 libx11-xcb1 libxcomposite1 \
      libxdamage1 libxrandr2 libpango-1.0-0 \
      libcairo2 libatspi2.0-0 && \
    ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then \
      QQ_URL="${QQ_DEB_URL_ARM64}"; \
    else \
      QQ_URL="${QQ_DEB_URL_AMD64}"; \
    fi && \
    echo "Downloading QQ: $QQ_URL" && \
    wget -q -O /tmp/qq.deb "$QQ_URL" && \
    dpkg -i /tmp/qq.deb || apt-get install -f -y && \
    rm -f /tmp/qq.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 从 builder 阶段拷贝编译产物
WORKDIR /app
COPY --from=builder /build/packages/napcat-shell/dist /app

# 安装运行时 npm 依赖（Vite 构建时 external 的包：express, ws）
RUN npm install --omit=dev express@^5.0.0 ws@^8.18.3

# 拷贝启动脚本
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 持久化数据目录（配置、日志、缓存）
RUN mkdir -p /app/data

# 默认环境变量
ENV NAPCAT_WORKDIR=/app/data \
    NAPCAT_DISABLE_PIPE=1 \
    NAPCAT_DISABLE_MULTI_PROCESS=1

# WebUI 6099 / OneBot HTTP 3000 / OneBot WS 3001
EXPOSE 6099 3000 3001

VOLUME ["/app/data"]

ENTRYPOINT ["/entrypoint.sh"]
