# ============================================================
# NapCat custom Docker image (amd64 / arm64)
# ============================================================

# ------ Stage 1: build NapCat ------
FROM node:20-slim AS builder

RUN npm install -g pnpm

WORKDIR /build
COPY . .
RUN pnpm install
RUN pnpm run build:shell

# ------ Stage 2: runtime ------
FROM ubuntu:22.04

ARG QQ_DEB_URL_AMD64=https://dldir1v6.qq.com/qqfile/qq/QQNT/f9cbaab2/linuxqq_3.2.28-48517_amd64.deb
ARG QQ_DEB_URL_ARM64=https://dldir1v6.qq.com/qqfile/qq/QQNT/f9cbaab2/linuxqq_3.2.28-48517_arm64.deb

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg xvfb xauth dbus-user-session \
      libglib2.0-0 libnss3 libatk-bridge2.0-0 \
      libcups2 libdrm2 libgtk-3-0 libgbm1 \
      libasound2 libx11-xcb1 libxcomposite1 \
      libxdamage1 libxrandr2 libpango-1.0-0 \
      libcairo2 libatspi2.0-0 libgnutls30 libnotify4 libxss1 libxtst6 \
      libsecret-1-0 libdbus-1-3 libgdk-pixbuf-2.0-0 && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then \
      QQ_URL="${QQ_DEB_URL_ARM64}"; \
    else \
      QQ_URL="${QQ_DEB_URL_AMD64}"; \
    fi && \
    echo "Downloading QQ: $QQ_URL" && \
    curl -fsSL -o /tmp/qq.deb "$QQ_URL" && \
    dpkg -i /tmp/qq.deb || apt-get install -f -y && \
    rm -f /tmp/qq.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app/napcat
COPY --from=builder /build/packages/napcat-shell/dist /app/napcat

RUN npm install --omit=dev express@^5.0.0 ws@^8.18.3

WORKDIR /app
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /app/data /app/.config

ENV NAPCAT_WORKDIR=/app/data \
    NAPCAT_DISABLE_PIPE=1 \
    NAPCAT_DISABLE_MULTI_PROCESS=1

EXPOSE 6099 3000 3001

VOLUME ["/app/data"]

ENTRYPOINT ["/entrypoint.sh"]
