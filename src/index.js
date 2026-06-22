import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import crypto from 'crypto';
import http from 'http';

import config from './core/config.js';
import logger from './core/logger.js';
import { saveUserSession, getUserSession, getChatIdsForRepository, decrypt, getSupabase } from './services/supabase.js';
import { saveHistories, chatHistories } from './commands/chat.js';
import { requireSession, fetchFile, invalidateFileTree } from './services/github.js';
import { triggerBackgroundSync } from './services/sync.js';
import { verifyOAuthState } from './commands/auth.js';
import { connectRedis, disconnectRedis } from './services/cache.js';
import { initWebSocket, upgradeWebSocket } from './services/websocket.js';
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
app.use('/webhook/', express.raw({ type: 'application/json', limit: '1mb' }));
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

function verifyGithubWebhookSignature(rawBody, signatureHeader) {
  if (!rawBody || !signatureHeader) return false;

  // Validate webhook secret exists
  if (!config.githubWebhookSecret || config.githubWebhookSecret.length < 32) {
    logger.error({ component: 'webhook' }, 'Webhook secret is missing or too short');
    return false;
  }

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
  if (err.message === 'fetch failed' || err.code === 'EFATAL' || err.code === 'ECONNRESET') {
    logger.warn({ component: 'process', error: err.message }, 'Ignored transient network exception');
    return;
  }
  logger.fatal({ component: 'process', error: err }, 'Uncaught Exception');
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
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
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
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const accessToken = tokenData.access_token;

    const userRes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${accessToken}`, 'User-Agent': 'AirCommit' }
    });
    const userData = await userRes.json();

    await saveUserSession(chatId, {
      github_token: accessToken,
      active_owner: userData.login,
      active_repo: null
    });

    res.send('<h1>Authentication successful!</h1><p>You can close this window and return to Telegram.</p>');
    bot.sendMessage(chatId, `✅ Successfully linked GitHub account: *${userData.login}*\n\nUse \`/repos\` to list your repositories, then \`/use <owner>/<repo>\` to select one.`, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error({ component: 'oauth', error: error.message }, 'OAuth error');
    res.status(500).send('Authentication failed: ' + error.message);
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

// ─── Health Check Endpoint ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/editor', (req, res) => {
  res.sendFile(path.resolve('./src/public/editor.html'));
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
    res.status(500).json({ error: error.message });
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
    // await connectRedis().catch(() => { }); // Disabled - Redis not installed

    // Pre-fetch 0G models (non-blocking)
    getZeroGModels().catch(() => { });

    // Restore chat history from 0G (non-blocking)
    restoreChatHistoryFrom0G().catch(() => { });

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
            const history = JSON.parse(archive.payload);
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

// ─── Register Commands ────────────────────────────────────────────────────────
registerAuthCommands(bot);
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
    const payload = JSON.parse(msg.web_app_data.data);
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
process.on('uncaughtException', (err) => {
  logger.fatal({ component: 'process', error: err }, 'Uncaught Exception');
  saveHistories();
});

process.on('unhandledRejection', (reason) => {
  logger.error({ component: 'process', reason }, 'Unhandled Rejection');
});

process.on('SIGINT', async () => {
  logger.info({ component: 'process' }, 'Shutting down — saving chat history...');
  saveHistories();
  await disconnectRedis();
  process.exit(0);
});

logger.info({ component: 'app' }, 'AirCommit V2 is live!');