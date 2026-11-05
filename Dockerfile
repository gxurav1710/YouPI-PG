# =============================================================================
# YOUPI PG V2 — Multi-Stage Production Dockerfile
# Native NPM Workspaces on Node.js 24 Alpine
# =============================================================================

# ── Stage 0: Base ────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:429bdfbc204b4eabc6438e6d34e4e9d8dd2ca1df8289bcd78cdd3c5db387b7a5 AS base
RUN apk update && apk upgrade --no-cache && apk add --no-cache libc6-compat
WORKDIR /app

# ── Stage 1: Dependencies ───────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

# Copy root and all workspace package manifests for layer cache optimization
COPY package.json package-lock.json ./
COPY packages/common/package.json ./packages/common/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/merchant-sdk/package.json ./packages/merchant-sdk/
COPY packages/observer-sdk/package.json ./packages/observer-sdk/
COPY apps/payment-api/package.json ./apps/payment-api/
COPY apps/checkout-portal/package.json ./apps/checkout-portal/
COPY apps/merchant-admin/package.json ./apps/merchant-admin/
COPY apps/sms-observer/package.json ./apps/sms-observer/
COPY apps/gmail-observer/package.json ./apps/gmail-observer/
COPY apps/control-center/package.json ./apps/control-center/
COPY apps/coin-wallet-store/package.json ./apps/coin-wallet-store/
COPY apps/payment-help/package.json ./apps/payment-help/
COPY apps/android-observer-app/package.json ./apps/android-observer-app/

# Clean installation of dependencies. Install scripts stay disabled during `npm ci` so no
# arbitrary third-party postinstall code runs during the build, then better-sqlite3's native
# binding is compiled explicitly: it is a transitive dependency of the WhatsApp Berry SDK and
# has no prebuilt binary for node 24 on musl, so skipping it leaves that feature broken.
#
# There is no prebuilt binary to fall back on, so the C toolchain has to be present for
# node-gyp. It is installed here in the throwaway deps stage only - the runner image is
# built FROM base and therefore never inherits it.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --ignore-scripts \
 && npm rebuild better-sqlite3

# ── Stage 2: Builder ────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
COPY . .

# Compile TypeScript packages
RUN npm run build

# Prune development tooling before packaging production runner image
RUN npm prune --omit=dev

# ── Stage 3: Runner ─────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV YOUPI_MODE=production
ENV YOUPI_BIND_HOST=0.0.0.0

WORKDIR /app

# Harden runtime image: strip unused package managers and CLI build tools to minimize attack surface and vulnerabilities
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /opt/yarn*

# Create unprivileged application user
RUN addgroup -S -g 1001 youpi && \
    adduser -S -u 1001 -G youpi youpi

# Copy built application and workspace modules
COPY --from=builder --chown=youpi:youpi /app ./

# Setup data persistence directory for native SQLite
RUN mkdir -p /app/data && chown -R youpi:youpi /app/data
VOLUME ["/app/data"]

# Expose unified gateway port
EXPOSE 10000 6100 7000

USER youpi

# Native healthcheck pinging unified cloud gateway
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:10000/health || exit 1

CMD ["node", "scripts/start-render.js"]
