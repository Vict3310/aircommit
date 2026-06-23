# AirCommit — AI-Powered GitHub Assistant via Telegram

AirCommit is a **Telegram bot** that lets developers manage GitHub repositories using natural language. Write code, review PRs, run builds, and deploy — all from your chat app.

---

## Features

| Category | Commands |
|----------|----------|
| **Auth** | `/login`, `/logout`, `/status`, `/key` (BYOK), `/models` |
| **Code** | `/smart`, `/fix`, `/create`, `/view`, `/patch` |
| **PR** | `/pr-review`, `/pr-suggest`, `/pr-autoapprove`, `/pr-list` |
| **Repo** | `/repos`, `/use`, `/files`, `/tree` |
| **Build** | `/compile`, `/build`, `/run` |
| **Chat** | `/chat`, `/help` |
| **Payment** | `/subscribe`, `/payment`, `/status`, `/billing`, `/cancel` |
| **0G** | `/zerog`, `/audit`, `/backup`, `/archive` |

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/your-org/aircommit.git
cd aircommit
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather on Telegram |
| `OPENROUTER_API_KEY` | From [openrouter.ai](https://openrouter.ai) |
| `ENCRYPTION_KEY` | 64-char hex — generate with the one-liner in `.env.example` |

If enabling **paid tiers**, you MUST set the payment addresses (see `.env.example` warnings).

### 3. Start

```bash
# Development
npm start

# Production (PM2)
pm2 start ecosystem.config.cjs --env production
pm2 save
```

---

## Deployment

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for:

- PM2 production setup
- Docker / Docker Compose (with Redis)
- HTTPS via nginx reverse proxy
- Telegram webhook configuration
- Supabase setup
- 0G network configuration
- Security hardening

---

## Architecture

```
Telegram
  └─► Bot API (polling or webhook)
      └─► Express.js + WebSocket server (port 3000)
          ├─► GitHub API (Octokit REST)
          ├─► AI Models (OpenRouter, 0G router, BYOK)
          ├─► Supabase (session persistence)
          ├─► 0G Storage (audit logs, backups)
          └─► Redis (optional caching layer)
```

---

## Subscription Tiers

| Tier | Price | Features |
|------|-------|----------|
| **Free** | $0 | Limited AI calls, free models |
| **Starter** | $5/mo | More calls, premium models |
| **Pro** | $15/mo | Unlimited, priority routing |
| **Team** | Custom | Shared repos, admin dashboard |

**Payment methods:**
- ⭐ **Telegram Stars** (primary, instant)
- 🏦 Bank transfer (manual approval)
- ₮ USDT (BSC) (manual approval)
- BNB (BSC) (manual approval)

---

## Security

- AES-256-GCM encrypted token storage
- Scoped Octokit tokens (repo scope only)
- Rate limiting (tiered: 20 cmd/min light, 5 cmd/min heavy)
- Security headers (CSP, HSTS, X-Frame-Options)
- Input validation on all paths
- HMAC webhook signature verification
- Read-only mode for restricted users

---

## Environment Variables

See **[.env.example](./.env.example)** for the full list. Key variables:

- **Required:** `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, `ENCRYPTION_KEY`
- **Payment (CRITICAL):** `PAYMENT_USDT_BSC`, `PAYMENT_BNB_BSC`, `PAYMENT_BANK_ACCOUNT` — must be real addresses
- **Optional:** `SUPABASE_*`, `ZEROG_*`, `GROQ_API_KEY`, `REDIS_URL`

---

## Contributing

Contributions welcome. Please open an issue or PR with a clear description.

---

## License

ISC
