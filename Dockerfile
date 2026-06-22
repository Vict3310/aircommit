# ─── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install native deps needed for websocket & other native modules
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build 2>/dev/null || true

# ─── Production stage ───────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

ENV NODE_ENV=production

# Non-root user
RUN addgroup -S aircommit && adduser -S aircommit -G aircommit

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Change ownership to non-root user
RUN chown -R aircommit:aircommit /app

USER aircommit

EXPOSE 3000

# Health check (HTTP probe, not full dependency check)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
