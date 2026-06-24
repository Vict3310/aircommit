import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import http from 'http';

import config from './core/config.js';
import logger from './core/logger.js';
import { saveUserSession, getUserSession, getChatIdsForRepository, decrypt, getSupabase } from './services/supabase.js';
import { saveHistories, chatHistories } from './commands/chat.js';
import { requireSession, fetchFile, invalidateFileTree } from './services/github.js';
import { triggerBackgroundSync } from './services/sync.js';
import { verifyOAuthState } from './commands/auth.js';
import { connectRedis, disconnectRedis, isRedisConnected } from './services/cache.js';
import { initWebSocket, upgradeWebSocket, closeWebSocket } from './services/websocket.js';
import { getZeroGModels } from './services/zerog-models.js';
import { downloadChatArchiveFrom0G } from './services/zerog.js';

// Security modules
import {
  securityHeaders,
  securityLogger,
  validateFilePath,
  validateRepoIdentifier,
  validateChatId,
  validateModelId,
  validateBranchName,
  hasCommandInjection,
  sanitizeForShell,
  allowCORS,
  bodySizeLimit,
  SimpleRateLimiter
} from './core/security.js';

// Sentry error monitoring (opt-in, initialized only if SENTRY_DSN is set)
import { initSentry } from './core/sentry.js';

// Initialize Sentry early (before any other module)
initSentry();

// Import fetchWithTimeout for timeout-safe external HTTP requests
import { fetchWithTimeout } from './core/fetch-timeout.js';

import { registerAuthCommands } from './commands/auth.js';
import { registerRepoCommands } from './commands/repo.js';
import { registerCodeCommands } from './commands/code.js';
import { registerChatCommands } from './commands/chat.js';
import { registerRagCommands } from './commands/rag.js';
import { registerAuditCommands } from './commands/audit.js';
import { registerBackupCommands } from './commands/backup.js';
import { registerArchiveCommands } from './commands/archive.js';
import { registerCompileCommands } from './commands/compile.js';
import { registerBuildCommands } from './commands/build.js';
import { registerContextCommands } from './commands/context.js';
import { registerRunCommands } from './commands/run.js';
import { registerMultiRepoCommands } from './services/multirepo.js';
import { registerPRReviewCommands } from './services/pr-review.js';
import { registerAdvancedCommands } from './services/advanced-features.js';
import { registerPaymentCommands } from './commands/payment.js';
import { verifyWebhookSignature, createCheckoutSession, verifyTransaction } from './services/paystack.js';

// ─── Web Server & OAuth ───────────────────────────────────────────────────────
const app = express();

// Apply request ID to all requests
app.use((req, res, next) => {
  req.requestId = logger.generateRequestId();
  next();
});

// Apply security headers to all responses
app.use(securityHeaders);
app.use(securityLogger);

// CSRF protection - origin checking for stateful endpoints
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    config.baseUrl,
    'https://telegram.me',
    'https://web.telegram.org',
    'https://web.telegram.org/a/',
    'https://web.telegram.org/k/'
  ].filter(Boolean);

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Verify state origin for sensitive POST requests
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const path = req.path;
    // Only require origin check for state-modifying endpoints
    if (path.includes('/webhook') || path.includes('/auth')) {
      if (!origin || !allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: 'Forbidden: Invalid origin' });
      }
    }
  }

  next();
});

app.use(cors({
  origin: (req, callback) => {
    const allowedOrigins = [
      config.baseUrl,
      'https://telegram.me',
      'https://web.telegram.org',
      'https://web.telegram.org/a/',
      'https://web.telegram.org/k/'
    ].filter(Boolean);

    const origin = req?.headers?.origin;
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Request size limits
// Parse JSON bodies and capture raw body for HMAC verification
app.use('/webhook/', (req, res, next) => {
  express.json({
    type: 'application/json',
    limit: '1mb',
    verify: (r, _res, buf) => { req.rawBody = buf.toString('utf-8'); }
  })(req, res, next);
});
app.use('/auth/', bodySizeLimit('500kb'));
app.use(bodySizeLimit('100kb'));

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 auth requests per windowMs
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-chat rate limiting for Telegram bot commands
const botRateLimiter = new SimpleRateLimiter(60000, 20); // 20 commands per minute per chat

// Apply rate limiting to sensitive endpoints
app.use('/auth/', authLimiter);
app.use('/webhook/github', apiLimiter);

// ─── Command Logging ─────────────────────────────────────────────────────────
// Logs command usage for analytics — privacy-safe (no message body, no user content)

const COMMAND_LOG_FILE = path.resolve('./command_log.json');
const MAX_LOG_ENTRIES = 10000; // Rotate at this size

function loadCommandLog() {
  try {
    if (fs.existsSync(COMMAND_LOG_FILE)) {
      const raw = fs.readFileSync(COMMAND_LOG_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    logger.warn({ component: 'command-log', error: e.message }, 'Failed to load command log');
  }
  return [];
}

let commandLog = loadCommandLog();
console.log(`📊 Loaded ${commandLog.length} command log entries.`);

/**
 * Log a command usage event. Does NOT log message content.
 */
function logCommandUsage(chatId, command, metadata = {}) {
  try {
    commandLog.push({
      timestamp: new Date().toISOString(),
      chatId: String(chatId),
      command,
      ...metadata
    });
    // Trim to max entries
    if (commandLog.length > MAX_LOG_ENTRIES) {
      commandLog = commandLog.slice(-MAX_LOG_ENTRIES);
    }
    // Persist to disk
    fs.writeFileSync(COMMAND_LOG_FILE, JSON.stringify(commandLog, null, 2));
  } catch (e) {
    logger.warn({ component: 'command-log', error: e.message }, 'Failed to persist command log');
  }
}

/**
 * Save command log to disk (for graceful shutdown)
 */
function saveCommandLog() {
  try {
    fs.writeFileSync(COMMAND_LOG_FILE, JSON.stringify(commandLog, null, 2));
  } catch (e) {
    logger.warn({ component: 'command-log', error: e.message }, 'Failed to save command log on shutdown');
  }
}

function verifyGithubWebhookSignature(rawBody, signatureHeader) {
  if (!rawBody || !signatureHeader) return false;

  const [algorithm, signature] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !signature) return false;

  const expected = crypto
    .createHmac('sha256', config.githubWebhookSecret)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const signatureBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== signatureBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

// Telegram webhook integration
let bot;
if (config.webhookUrl) {
  bot = new TelegramBot(config.token, { webHook: true });
  bot.setWebHook(`${config.webhookUrl}/bot${config.token}`);
  app.post(`/bot${config.token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  logger.info({ component: 'bot', mode: 'webhook' }, 'Bot starting in WEBHOOK mode');
} else {
  bot = new TelegramBot(config.token, { polling: true });
  logger.info({ component: 'bot', mode: 'polling' }, 'Bot starting in POLLING mode');

  bot.on('polling_error', (error) => {
    if (error.code === 'EFATAL' || error.message.includes('fetch failed')) {
      // Ignore transient network errors during polling
    } else {
      logger.warn({ component: 'bot', error: error.message }, 'Telegram Polling Error');
    }
  });
}

// Prevent Node.js from crashing entirely on unhandled fetch errors from underlying undici/node-fetch
process.on('uncaughtException', (err) => {
  const transient = err.message === 'fetch failed' || err.code === 'EFATAL' || err.code === 'ECONNRESET';
  if (transient) {
    logger.warn({ component: 'process', error: err.message }, 'Ignored transient network exception');
    return;
  }
  logger.fatal({ component: 'process', error: err }, 'Uncaught Exception');
  saveHistories();
  saveCommandLog();
});

// ─── Global Command Logging Interceptor ───────────────────────────────────────
// Logs all bot commands before they're processed by specific modules

bot.on('message', async (msg) => {
  const text = msg.text || '';
  const chatId = msg.chat?.id;
  if (!chatId) return;

  // Match commands (starts with / followed by alphanumeric)
  const cmdMatch = text.match(/^\/([a-zA-Z0-9_]+)/);
  if (cmdMatch) {
    const fullCommand = cmdMatch[0];
    const command = cmdMatch[1].toLowerCase();
    const isCallback = !!msg.callback_query;

    logCommandUsage(chatId, command, {
      isCallback,
      isVoice: !!msg.voice,
      isPhoto: !!msg.photo?.length,
      commandLength: fullCommand.length
    });
  }
});

process.on('unhandledRejection', (reason, promise) => {
  if (reason?.message === 'fetch failed' || reason?.code === 'EFATAL' || reason?.code === 'ECONNRESET') {
    logger.warn({ component: 'process', error: reason.message }, 'Ignored transient network rejection');
    return;
  }
  logger.error({ component: 'process', reason }, 'Unhandled Rejection');
});

app.get('/auth/github', (req, res) => {
  const state = req.query.state;
  if (!state || typeof state !== 'string') return res.status(400).send('Missing state');

  // Verify OAuth state with nonce expiration check
  const { chatId, nonce } = verifyOAuthState(state);
  if (!chatId) {
    return res.status(400).send('Invalid or expired state');
  }

  const redirectUri = `${config.baseUrl}/auth/github/callback`;
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${config.githubClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo&state=${encodeURIComponent(state)}`;
  res.redirect(githubAuthUrl);
});

app.get('/auth/github/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code || !state || typeof state !== 'string') return res.status(400).send('Invalid callback');

  // Verify OAuth state with nonce expiration check
  const { chatId, nonce } = verifyOAuthState(state);
  if (!chatId) {
    return res.status(400).send('Invalid or expired callback state');
  }

  try {
    const tokenRes = await fetchWithTimeout('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code
      })
    }, 15000);

    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const accessToken = tokenData.access_token;

    // ─── Validate token scopes ─────────────────────────────────────
    const scopeCheckRes = await fetchWithTimeout('https://api.github.com/user', {
      headers: { 'Authorization': `token ${accessToken}`, 'User-Agent': 'AirCommit' }
    }, 15000);
    const scopes = scopeCheckRes.headers.get('x-oauth-scopes') || '';
    const userData = await scopeCheckRes.json();

    const scopeList = scopes.split(',').map(s => s.trim().toLowerCase());

    // Block dangerous scopes
    const dangerousScopes = ['admin:org', 'delete_repo', 'admin:repo_hook', 'admin:org_hook', 'site_admin'];
    const foundDangerous = scopeList.filter(s => dangerousScopes.includes(s));
    if (foundDangerous.length > 0) {
      logger.warn({
        component: 'oauth',
        chatId,
        user: userData.login,
        dangerousScopes: foundDangerous
      }, `⚠️ Token has dangerous scopes: ${foundDangerous.join(', ')}`);
      bot.sendMessage(chatId,
        `⚠️ *Security Warning*\n\n` +
        `Your GitHub token has broad permissions:\n\`${foundDangerous.join(', ')}\`\n\n` +
        `AirCommit only needs \`repo\` scope. Consider revoking this token at:\n` +
        `https://github.com/settings/applications\n\n` +
        `Proceeding with limited functionality.`,
        { parse_mode: 'Markdown' }
      );
    }

    // Check for minimum required scope
    const hasRepoScope = scopeList.includes('repo') || scopeList.some(s => s.startsWith('repo:'));
    if (!hasRepoScope) {
      logger.warn({
        component: 'oauth',
        chatId,
        user: userData.login,
        scopes: scopeList
      }, 'Token missing repo scope');
      res.send('<h1>Insufficient permissions</h1><p>The token does not include <code>repo</code> scope. Please re-authorize.</p>');
      return bot.sendMessage(chatId,
        `❌ *Insufficient Permissions*\n\n` +
        `The authorized token is missing the \`repo\` scope.\n\n` +
        `Please run \`/login\` again and approve the full \`repo\` scope.`,
        { parse_mode: 'Markdown' }
      );
    }

    await saveUserSession(chatId, {
      github_token: accessToken,
      active_owner: userData.login,
      active_repo: null
    });

    res.send('<h1>Authentication successful!</h1><p>You can close this window and return to Telegram.</p>');
    bot.sendMessage(chatId, `✅ Successfully linked GitHub account: *${userData.login}*\n\nUse \`/repos\` to list your repositories, then \`/use <owner>/<repo>\` to select one.`, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error({ component: 'oauth', error: error.message }, 'OAuth error');
    res.status(500).send('Authentication failed. Please try again or contact support if the issue persists.');
  }
});

app.post('/webhook/github', async (req, res) => {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];
  const payload = req.body;

  // Validate signature
  if (!verifyGithubWebhookSignature(req.rawBody, signature)) {
    return res.status(401).send('Invalid webhook signature.');
  }

  // Validate payload structure
  if (!payload || typeof payload !== 'object') {
    return res.status(400).send('Invalid payload.');
  }

  // Validate repository information
  const repositoryFullName = payload?.repository?.full_name;
  if (!repositoryFullName || typeof repositoryFullName !== 'string') {
    return res.status(400).send('Invalid repository information.');
  }

  // Validate repository name format (owner/repo)
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repositoryFullName)) {
    return res.status(400).send('Invalid repository name format.');
  }

  try {
    const owner = payload.repository.owner?.login || repositoryFullName.split('/')[0];
    const repo = payload.repository.name || repositoryFullName.split('/')[1];

    // Validate owner and repo names
    if (!/^[a-zA-Z0-9_-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
      return res.status(400).send('Invalid repository owner or name.');
    }

    const chatIds = await getChatIdsForRepository(owner, repo);

    if (chatIds.length === 0) {
      return res.sendStatus(200);
    }

    if (event === 'push') {
      const branch = payload.ref?.split('/').pop();
      if (!branch || typeof branch !== 'string') {
        return res.status(400).send('Invalid branch information.');
      }
      for (const chatId of chatIds) {
        bot.sendMessage(chatId, `🚀 *Push to \`${branch}\` in \`${payload.repository.full_name}\`*\n${payload.commits?.length || 0} commit(s) pushed.`, { parse_mode: 'Markdown' });
      }
    } else if (event === 'pull_request') {
      if (!payload.pull_request?.number || !payload.pull_request?.title) {
        return res.status(400).send('Invalid pull request information.');
      }
      for (const chatId of chatIds) {
        bot.sendMessage(chatId, `🌿 *Pull Request ${payload.action}: \`${payload.repository.full_name}\`*\n[#${payload.pull_request.number} ${payload.pull_request.title}](${payload.pull_request.html_url})`, { parse_mode: 'Markdown' });
      }
    } else if (event === 'issues') {
      if (!payload.issue?.number || !payload.issue?.title) {
        return res.status(400).send('Invalid issue information.');
      }
      for (const chatId of chatIds) {
        bot.sendMessage(chatId, `🐞 *Issue ${payload.action}: \`${payload.repository.full_name}\`*\n[#${payload.issue.number} ${payload.issue.title}](${payload.issue.html_url})`, { parse_mode: 'Markdown' });
      }
    }
  } catch (error) {
    logger.error({ component: 'webhook', error: error.message }, 'Webhook error');
  }

  res.sendStatus(200);
});

// ─── Paystack Webhook ─────────────────────────────────────────────────────────
// Handles payment confirmations from Paystack
app.post('/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  // Verify webhook signature
  if (!verifyWebhookSignature(rawBody, signature)) {
    logger.warn({ component: 'paystack-webhook' }, 'Invalid Paystack webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;

  try {
    // Only handle 'charge.success' events
    if (event.event !== 'charge.success') {
      return res.sendStatus(200);
    }

    const data = event.data;
    const reference = data.reference;

    // Verify the transaction on Paystack's side
    const isSuccessful = await verifyTransaction(reference);
    if (!isSuccessful) {
      logger.warn({ component: 'paystack-webhook', reference }, 'Transaction not verified as successful');
      return res.sendStatus(200);
    }

    // Parse reference: aircommit_{tier}_{chatId}_{timestamp}
    const parts = reference.split('_');
    if (parts.length < 4 || parts[0] !== 'aircommit') {
      logger.warn({ component: 'paystack-webhook', reference }, 'Invalid Paystack reference format');
      return res.sendStatus(200);
    }

    const tier = parts[1];
    const chatId = parseInt(parts[2], 10);

    // Activate subscription
    const { activateSubscription } = await import('./services/subscription.js');
    const subscriptionData = await activateSubscription(chatId, tier, 30, 'paystack');
    const { saveUserSession } = await import('./services/supabase.js');
    await saveUserSession(chatId, subscriptionData);

    // Send confirmation to user via Telegram
    try {
      const tierConfig = (await import('./services/subscription.js')).SUBSCRIPTION_TIERS[tier];
      bot.sendMessage(chatId,
        `🎉 *${tierConfig.name} Activated!*\n\n` +
        `Your AirCommit ${tierConfig.name} plan is now active for 30 days.\n\n` +
        `✨ *Features unlocked:*\n` +
        `• Commands: ${tierConfig.commandsPerDay < 0 ? 'Unlimited' : tierConfig.commandsPerDay + '/month'}\n` +
        `• Repos: ${tierConfig.maxRepos < 0 ? 'Unlimited' : tierConfig.maxRepos}\n\n` +
        `Use \`/status\` to see your plan details.`
      );
    } catch (notifyError) {
      logger.error({ component: 'paystack-webhook', error: notifyError.message }, 'Failed to notify user of activation');
    }

    logger.info({ component: 'paystack-webhook', chatId, tier }, 'Paystack payment confirmed, subscription activated');

  } catch (error) {
    logger.error({ component: 'paystack-webhook', error: error.message }, 'Paystack webhook processing failed');
  }

  res.sendStatus(200);
});

// ─── Health Check Endpoint ─────────────────────────────────────────────────────
// Rate-limited health check (10 req/min) to prevent abuse
const healthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 health checks per windowMs
  message: { error: 'Too many health check requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/health', healthLimiter);
app.get('/health', async (req, res) => {
  try {
    const start = Date.now();
    const checks = {
      telegram: false,
      supabase: false,
      redis: 'skipped',
      zerog: false,
    };
    let status = 'ok';

    // ─── Telegram Bot Check ─────────────────────────────────────────────────
    try {
      const me = await bot.getMe();
      checks.telegram = !!me;
    } catch (err) {
      checks.status = 'degraded';
    }

    // ─── Supabase Check (only if configured) ────────────────────────────────
    if (config.supabaseUrl && config.supabaseKey) {
      try {
        const supabase = getSupabase();
        if (supabase) {
          const { error } = await supabase.from('users').select('id').limit(1);
          checks.supabase = !error;
        } else {
          checks.supabase = false;
        }
      } catch {
        checks.supabase = false;
        status = 'degraded';
      }
    } else {
      checks.supabase = 'skipped';
    }

    // ─── Redis Check (only if configured) ───────────────────────────────────
    if (isRedisConnected()) {
      checks.redis = true;
    } else if (process.env.REDIS_URL || process.env.REDIS_PASSWORD) {
      checks.redis = 'failed';
      status = 'degraded';
    }

    // ─── 0G Check (only if configured) ──────────────────────────────────────
    if (config.zerogPrivateKey) {
      try {
        await fetch(config.zerogEvmRpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
          signal: AbortSignal.timeout(3000)
        });
        checks.zerog = true;
      } catch {
        status = 'degraded';
      }
    } else {
      checks.zerog = 'skipped';
    }

    const latency = Date.now() - start;

    res.json({
      status,
      uptime: Math.round(process.uptime()),
      latencyMs: latency,
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      checks
    });
  } catch (err) {
    logger.error({ component: 'health', error: err.message }, 'Health check failed');
    res.status(500).json({ status: 'error', message: 'Health check unavailable' });
  }
});

app.get('/editor', async (req, res) => {
  const { chatId } = req.query;
  // Require authenticated session — prevent unauthenticated access to Monaco editor
  if (!chatId || typeof chatId !== 'string') {
    return res.status(401).send('Unauthorized: chatId query parameter required');
  }
  try {
    const session = await getUserSession(chatId);
    if (!session || !session.github_token || !session.active_owner || !session.active_repo) {
      return res.status(401).send('Unauthorized: must be logged in and have a repo selected');
    }
    res.sendFile(path.resolve('./src/public/editor.html'));
  } catch (error) {
    logger.error({ component: 'editor', error: error.message }, 'Editor access error');
    res.status(500).send('Editor unavailable');
  }
});

app.get('/api/file', async (req, res) => {
  const reqLogger = logger.withRequest(req);
  const { chatId, file } = req.query;

  // ─── Input Validation ───────────────────────────────────────────────
  if (!chatId || !file) return res.status(400).json({ error: 'Missing chatId or file parameter' });

  // Validate chat ID format
  if (!/^-?\d+$/.test(String(chatId))) {
    return res.status(400).json({ error: 'Invalid chat ID format' });
  }

  // Validate file path
  if (typeof file !== 'string' || file.length > 1024) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  // Check for path traversal
  if (file.includes('..') || file.includes('//')) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  try {
    const session = await getUserSession(chatId);
    if (!session || !session.active_owner || !session.active_repo) {
      return res.status(401).json({ error: 'Unauthorized or no repo selected' });
    }
    const { octokit, owner, repo } = await requireSession(chatId);
    const { content } = await fetchFile(octokit, owner, repo, file);
    res.json({ content });
  } catch (error) {
    reqLogger.error({ error: error.message }, 'File fetch error');
    res.status(500).json({ error: 'Failed to fetch file. Check that the file exists and you have access.' });
  }
});

// We start the server via httpServer below (WebSocket + HTTP combined)
// This line was a duplicate and needs to be removed.
// The httpServer.listen() call below handles both HTTP and WS on the same port.

// ─── Warm Cache & Initialize Services ───────────────────────────────────────
// Warm up caches and pre-load data for instant first responses
async function warmServices() {
  try {
    logger.info({ component: 'warmup' }, 'Warming up services...');

    // Connect Redis (non-blocking, skip if not available)
    connectRedis().catch(err => logger.warn({ component: 'warmup', error: err.message }, 'Redis warm-up skipped'));

    // Pre-fetch 0G models (non-blocking)
    getZeroGModels().catch(err => logger.warn({ component: 'warmup', error: err.message }, '0G models warm-up skipped'));

    // Restore chat history from 0G (non-blocking)
    restoreChatHistoryFrom0G().catch(err => logger.warn({ component: 'warmup', error: err.message }, 'Chat history restore skipped'));

    logger.info({ component: 'warmup' }, 'Service warm-up complete');
  } catch (error) {
    logger.warn({ component: 'warmup', error: error.message }, 'Warm-up warning');
  }
}

/**
 * Restores chat history from 0G archives on startup
 */
async function restoreChatHistoryFrom0G() {
  if (!config.zerogPrivateKey) {
    logger.info({ component: '0g' }, '0G not configured - skipping chat history restoration');
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    logger.info({ component: '0g' }, 'Supabase not configured - skipping chat history restoration');
    return;
  }

  try {
    const allChats = Array.from(chatHistories.keys());
    logger.info({ component: '0g', chatCount: allChats.length }, 'Restoring chat sessions from 0G...');

    for (const chatId of allChats) {
      try {
        const { data } = await supabase
          .from('chat_archives')
          .select('root_hash')
          .eq('chat_id', chatId.toString())
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (data?.root_hash) {
          const archive = await downloadChatArchiveFrom0G(data.root_hash);
          if (archive && typeof archive.payload === 'string') {
            let history;
            try {
              history = JSON.parse(archive.payload);
            } catch (parseErr) {
              logger.warn({ component: '0g', chatId, error: parseErr.message }, 'Failed to parse archived history JSON');
              continue;
            }
            if (Array.isArray(history)) {
              chatHistories.set(chatId, history);
              logger.info({ component: '0g', chatId, messageCount: history.length }, 'Restored chat history');
            }
          }
        }
      } catch (err) {
        // Silently skip chats that fail to restore
        logger.warn({ component: '0g', chatId, error: err.message }, 'Failed to restore chat');
      }
    }
  } catch (error) {
    logger.warn({ component: '0g', error: error.message }, 'Chat history restoration failed');
  }
}

warmServices();

// ─── WebSocket Upgrade Handler ───────────────────────────────────────────────
const httpServer = http.createServer(app);
initWebSocket(httpServer);

// Upgrade WebSocket connections
httpServer.on('upgrade', (req, socket, head) => {
  upgradeWebSocket(req, socket, head);
});

// Only listen once — the httpServer handles both HTTP and WebSocket upgrades
if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(config.port, () => {
    logger.info({ component: 'server', port: config.port }, 'Server (HTTP/WebSocket) AirCommit listening');
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function sendStatus(chatId, initialText) {
  try {
    const statusMsg = await bot.sendMessage(chatId, initialText, { parse_mode: 'Markdown' });
    return {
      update: async (text) => {
        try {
          await bot.editMessageText(text, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
        } catch (_) { }
      },
      delete: async () => {
        try {
          await bot.deleteMessage(chatId, statusMsg.message_id);
        } catch (_) { }
      }
    };
  } catch (e) {
    return {
      update: async () => { },
      delete: async () => { }
    };
  }
}

async function safeSend(chatId, text, extra = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
  } catch (err) {
    if (err?.response?.body?.description?.includes("can't parse entities")) {
      const plain = text.replace(/[*_\`\[\]]/g, '');
      return await bot.sendMessage(chatId, plain, extra);
    }
    throw err;
  }
}

// ─── Express Error Handling Middleware ───────────────────────────────────────
// Catch 404 and forward to central error handler

app.use((req, res, next) => {
  const err = new Error(`Not Found — ${req.method} ${req.path}`);
  err.statusCode = 404;
  next(err);
});

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const environment = process.env.NODE_ENV || 'development';
  const log = logger.withRequest(req);

  log.error(
    { component: 'express-error', statusCode, path: req.path, method: req.method },
    err.message
  );

  res.status(statusCode).json({
    error: statusCode === 404 ? 'Not Found' : 'Internal Server Error',
    message: err.message,
    ...(environment === 'development' ? { stack: err.stack } : {})
  });
});

// ─── Register Commands ────────────────────────────────────────────────────────
registerAuthCommands(bot, sendStatus);
registerRepoCommands(bot);
registerCodeCommands(bot, sendStatus);
registerChatCommands(bot, sendStatus, safeSend);
registerRagCommands(bot, sendStatus);
registerAuditCommands(bot, sendStatus);
registerBackupCommands(bot, sendStatus);
registerArchiveCommands(bot, sendStatus);
registerCompileCommands(bot, sendStatus);
registerBuildCommands(bot, sendStatus);
registerContextCommands(bot, sendStatus);
registerRunCommands(bot, sendStatus);
registerMultiRepoCommands(bot, sendStatus);
registerPRReviewCommands(bot, sendStatus);
registerAdvancedCommands(bot, sendStatus);
registerPaymentCommands(bot);

// ─── Monaco Editor Web App Save Handler ──────────────────────────────────────
bot.on('web_app_data', async (msg) => {
  const chatId = msg.chat.id;
  try {
    let payload;
    try {
      payload = JSON.parse(msg.web_app_data.data);
    } catch (parseErr) {
      logger.warn({ component: 'editor', chatId, error: parseErr.message }, 'Invalid JSON in web_app_data');
      await sendStatus(chatId, '❌ Invalid data format');
      return;
    }
    if (payload.action !== 'save_file') return;

    const { filePath, newContent } = payload;

    // ─── Input Validation ───────────────────────────────────────────────
    if (!filePath || typeof filePath !== 'string' || filePath.length > 1024) {
      await sendStatus(chatId, '❌ Invalid file path');
      return;
    }

    // Check for path traversal
    if (filePath.includes('..') || filePath.includes('//')) {
      await sendStatus(chatId, '❌ Invalid file path');
      return;
    }

    if (!newContent || typeof newContent !== 'string' || newContent.length > 100000) {
      await sendStatus(chatId, '❌ Invalid file content');
      return;
    }

    const status = await sendStatus(chatId, `✍️ Saving changes from editor to \`${filePath}\`...`);

    try {
      const { octokit, owner, repo, github_token } = await requireSession(chatId);
      let sha;
      try {
        const existing = await fetchFile(octokit, owner, repo, filePath);
        sha = existing.sha;
      } catch (err) {
        // File doesn't exist yet, will be created
        if (!err.message?.includes('Not Found')) {
          logger.warn({ component: 'editor', error: err.message }, 'Error checking file');
        }
      }

      const contentBase64 = Buffer.from(newContent).toString('base64');
      await octokit.repos.createOrUpdateFileContents({
        owner, repo,
        path: filePath,
        message: `edit: update ${filePath} via AirCommit editor`,
        content: contentBase64,
        sha
      });
      await status.update(`✅ *Saved!* \`${filePath}\` committed to GitHub.`);
      triggerBackgroundSync(chatId, owner, repo, github_token);
    } catch (err) {
      logger.error({ component: 'editor', error: err.message }, 'Save error');
      await status.update(`❌ Save failed: ${err.message}`);
    }
  } catch (err) {
    logger.error({ component: 'editor', error: err.message }, 'Web app data error');
  }
});

// ─── Crash Resistance ────────────────────────────────────────────────────────
// Note: The main uncaughtException/unhandledRejection handlers are defined
// earlier in this file to avoid overwriting them.  SIGINT handles graceful
// shutdown with chat-history persistence.

process.on('SIGINT', async () => {
  logger.info({ component: 'process' }, 'Shutting down — saving chat history...');

  // 1. Stop accepting new connections
  httpServer.close();

  // 2. Save chat history to disk
  saveHistories();

  // 3. Save command log to disk
  saveCommandLog();

  // 4. Close WebSocket connections gracefully
  closeWebSocket();

  // 5. Disconnect Redis if connected
  await disconnectRedis();

  logger.info({ component: 'process' }, 'Shutdown complete');
  process.exit(0);
});

logger.info({ component: 'app' }, 'AirCommit V2 is live!');