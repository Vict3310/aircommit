# Deployment Guide

Production deployment checklist and step-by-step instructions for AirCommit.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [PM2 Production Setup](#pm2-production-setup)
3. [Docker / Docker Compose](#docker--docker-compose)
4. [HTTPS via Nginx](#https-via-nginx)
5. [Telegram Webhook Mode](#telegram-webhook-mode)
6. [Supabase Setup](#supabase-setup)
7. [0G Network Configuration](#0g-network-configuration)
8. [Redis for Caching](#redis-for-caching)
9. [Security Hardening](#security-hardening)
10. [Monitoring & Alerting](#monitoring--alerting)

---

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **npm 9+**
- **Git**
- **Telegram Bot Token** (from @BotFather)
- **OpenRouter API Key** (or alternative AI provider)
- **Supabase account** (for session persistence — optional but recommended)
- **Domain name** (for HTTPS/webhook — optional)

---

## PM2 Production Setup

PM2 provides process management, auto-restart, clustering, and log rotation.

### Install PM2

```bash
npm install -g pm2
```

### Start with ecosystem config

```bash
# Production start
pm2 start ecosystem.config.cjs --env production

# Save process list (survives reboot)
pm2 save

# Auto-start on system boot
pm2 startup
# Copy and run the printed command as root
```

### Useful PM2 commands

```bash
pm2 status           # View process status
pm2 logs             # View merged logs
pm2 logs aircommit   # View logs for specific app
pm2 reload aircommit # Zero-downtime reload
pm2 restart aircommit
pm2 stop aircommit
pm2 monit            # Interactive monitoring dashboard
```

### Log files

Logs go to `logs/err.log` and `logs/out.log` (configured in `ecosystem.config.cjs`).

---

## Docker / Docker Compose

### Quick start

```bash
docker-compose up -d --build
```

### Environment

Copy `.env.example` to `.env` and fill in values before running.

### Docker Compose services

| Service | Description |
|---------|-------------|
| `app` | AirCommit bot (builds from Dockerfile) |
| `redis` | Redis cache (persistent volume) |

### Single container (no Redis)

```bash
docker build -t aircommit .
docker run -d --name aircommit --env-file .env -p 3000:3000 aircommit
```

---

## HTTPS via Nginx

Required for Telegram webhook mode and secure bot API access.

### Install nginx

```bash
sudo apt update && sudo apt install nginx -y
```

### Install SSL certificate (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d bot.yourdomain.com
```

### Nginx configuration

```nginx
server {
    listen 443 ssl http2;
    server_name bot.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/bot.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.yourdomain.com/privkey.pem;

    # Increase client body size for webhook payloads
    client_max_body_size 10M;

    location /bot<YOUR_BOT_TOKEN> {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /webhook/github {
        proxy_pass http://localhost:3000/webhook/github;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://localhost:3000/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    location /status/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### Enable and start

```bash
sudo nginx -t && sudo systemctl restart nginx
sudo systemctl enable nginx
```

---

## Telegram Webhook Mode

When `WEBHOOK_URL` is set in `.env`, the bot runs in webhook mode instead of polling.

### Configure in .env

```bash
WEBHOOK_URL=https://bot.yourdomain.com
GITHUB_WEBHOOK_SECRET=<32+ char random string>
```

### Generate webhook secret

```bash
node -e "console.log(require('crypto').randomBytes(20).toString('hex'))"
```

### Verify webhook is set

```bash
curl -s https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo
```

Expected response:
```json
{"ok":true,"result":{"url":"https://bot.yourdomain.com/bot<YOUR_TOKEN>","has_custom_certificate":false,"pending_update_count":0}}
```

### Remove webhook (switch back to polling)

```bash
curl -X POST https://api.telegram.org/bot<YOUR_TOKEN>/deleteWebHook
```

---

## Supabase Setup

Supabase provides persistent session storage (replacing in-memory sessions that are lost on restart).

### Create Supabase project

1. Go to [supabase.com](https://supabase.com) and create a project
2. Copy **Project URL** and **Service Role Key** from Settings → API

### Database schema

Create the following table in your Supabase project:

```sql
-- Users table (sessions + encrypted tokens)
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT UNIQUE NOT NULL,
  github_token TEXT,
  custom_openrouter_key TEXT,
  custom_openai_key TEXT,
  custom_zerog_key TEXT,
  active_owner TEXT,
  active_repo TEXT,
  subscription_status TEXT DEFAULT 'free',
  subscription_expiry TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Chat archives (for 0G backup reference)
CREATE TABLE chat_archives (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  root_hash TEXT NOT NULL,
  message_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Enable Row Level Security (optional)

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_archives ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write all rows
CREATE POLICY "service_all" ON users FOR ALL USING (true);
CREATE POLICY "service_all" ON chat_archives FOR ALL USING (true);
```

---

## 0G Network Configuration

0G provides decentralized storage for audit logs and chat history archives.

### Required variables

```bash
ZEROG_PRIVATE_KEY=<your-64-char-hex-private-key>
ZEROG_EVM_RPC_URL=https://evmrpc-testnet.0g.ai
ZEROG_INDEXER_RPC_URL=https://indexer-storage-testnet-standard.0g.ai
```

### Get 0G private key

Your 0G private key is derived from your wallet. For testnet:

1. Create a wallet or use an existing one
2. Export the private key (64-char hex)
3. Set `ZEROG_PRIVATE_KEY` in `.env`

### Verify 0G connection

```bash
curl -s -X POST https://evmrpc-testnet.0g.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

---

## Redis for Caching

Redis provides session caching and file tree caching for faster response times.

### Install Redis (if not using Docker Compose)

```bash
sudo apt install redis-server -y
sudo systemctl enable redis-server
```

### Configure in .env

```bash
REDIS_URL=redis://localhost:6379
# If Redis has a password:
# REDIS_PASSWORD=your-redis-password
```

### Verify Redis connection

```bash
redis-cli ping
# Should return: PONG
```

**Note:** Redis is optional. The bot falls back gracefully if Redis is unavailable.

---

## Security Hardening

### Firewall

```bash
# Allow only SSH, HTTP, HTTPS
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### Fail2ban (SSH protection)

```bash
sudo apt install fail2ban -y
sudo systemctl enable fail2ban
```

### File permissions

```bash
# Ensure .env is not readable by others
chmod 600 .env

# Run as non-root user (Docker mode)
# See Dockerfile USER aircommit
```

### Rotate secrets

```bash
# Encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Webhook secret
node -e "console.log(require('crypto').randomBytes(20).toString('hex'))"
```

After rotation, update `.env` and restart:

```bash
pm2 restart aircommit
```

---

## Monitoring & Alerting

### PM2 monitoring

```bash
# Dashboard
pm2 monit

# Metrics export (optional — install pm2-metrics)
npm install -g pm2-metrics
pm2 set metrics true
```

### Health check endpoint

```bash
curl https://bot.yourdomain.com/health
```

Response:
```json
{
  "status": "ok",
  "uptime": 3600,
  "latencyMs": 45,
  "timestamp": "2024-01-01T12:00:00.000Z",
  "version": "1.0.0",
  "environment": "production",
  "checks": {
    "telegram": true,
    "supabase": true,
    "redis": true,
    "zerog": true
  }
}
```

### Log aggregation (optional)

For production deployments, consider:

- **Papertrail** or **Logtail** for remote log aggregation
- **Grafana + Loki** for self-hosted log management
- **Sentry** for error tracking (install `@sentry/node` and add error middleware)

### Sentry (optional — recommended for production)

Sentry provides real-time error tracking and performance monitoring.

1. Create a project at [sentry.io](https://sentry.io)
2. Copy the DSN (looks like `https://xxx@sentry.io/yyy`)
3. Add to `.env`:

```bash
SENTRY_DSN=https://xxx@sentry.io/yyy
# Optional: enable performance profiling (has overhead)
# SENTRY_PROFILE_ENABLED=true
```

4. Update `release` in `src/core/sentry.js` to match your deploy version

**Note:** Sentry is opt-in — the bot runs normally without it. Transient network errors are automatically filtered out.

---

## Troubleshooting

### Bot not responding

1. Check logs: `pm2 logs aircommit --lines 100`
2. Verify `.env` has `TELEGRAM_BOT_TOKEN` and `OPENROUTER_API_KEY`
3. Check Telegram webhook: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`

### Payment issues

1. Verify `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_WEBHOOK_SECRET` are set
2. Ensure `PAYSTACK_WEBHOOK_SECRET` matches the value configured in your Paystack dashboard
3. Verify `ADMIN_CHAT_IDS` is set for manual payment approval (bank/crypto fallback)
4. Check `payment.js` and `paystack.js` logs for errors
5. Test webhook at: `curl -X POST https://your-domain.com/webhook/paystack`

### Redis connection failures

Bot continues working without Redis — check logs for warnings. Install Redis or set `REDIS_URL`.

### 0G storage failures

Audit logs and backups continue to disk. Check `ZEROG_PRIVATE_KEY` and RPC URLs.

---

## Support

- GitHub Issues: [your-repo]/issues
- Telegram: [@YourSupportBot](https://t.me/YourSupportBot)
