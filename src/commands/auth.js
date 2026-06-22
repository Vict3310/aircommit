import { Octokit } from '@octokit/rest';
import crypto from 'crypto';
import config from '../core/config.js';
import { saveUserSession, deleteUserSession, getUserSession, encrypt } from '../services/supabase.js';
import { registerZeroGCommands } from '../services/zerog-models.js';
import keyService from '../services/keys.js';

// ─── Security Helpers ───────────────────────────────────────────────────────

const NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Validates that a string contains only safe characters
 */
function isValidIdentifier(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[a-zA-Z0-9_.-]+$/.test(str);
}

/**
 * Validates GitHub owner/repo format
 */
function isValidGitHubPath(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(str);
}

/**
 * Generates a secure nonce with timestamp for expiration
 */
function generateSecureNonce() {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = crypto.randomBytes(24).toString('hex');
  return timestamp.toString(16) + random;
}

/**
 * Validates OAuth state and checks nonce expiration
 */
function verifyOAuthState(state) {
  if (!state || typeof state !== 'string') return null;

  const parts = state.split(':');
  if (parts.length !== 3) return null;

  const [chatId, nonce, signature] = parts;

  // Validate chatId format
  if (!isValidIdentifier(chatId)) return null;

  // Validate nonce format (hex, minimum length for timestamp + random)
  if (!/^[0-9a-f]{32,}$/i.test(nonce)) return null;

  // Extract timestamp from nonce and check expiration
  try {
    const nonceTimestamp = parseInt(nonce.substring(0, 8), 16);
    if (Math.abs(Date.now() - nonceTimestamp * 1000) > NONCE_EXPIRY_MS) {
      console.warn('[OAuth] Nonce expired for chatId:', chatId);
      return null;
    }
  } catch (e) {
    return null;
  }

  // Verify signature using constant-time comparison
  const expectedSignature = crypto.createHmac('sha256', config.githubClientSecret)
    .update(`${chatId}:${nonce}`).digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const signatureBuffer = Buffer.from(signature, 'hex');

  if (expectedBuffer.length !== signatureBuffer.length) return null;

  const isValid = crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  return isValid ? { chatId, nonce } : null;
}

// Tier definitions
const FREE_MODELS = [
  { id: 'qwen/qwen-2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B (Free)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (Free)' },
  { id: 'qwen/qwen3-coder:free', label: 'Qwen 3 Coder (Free)' },
  { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (Free)' },
];

const PREMIUM_MODELS = [
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (Premium ⭐)' },
  { id: 'anthropic/claude-3-opus', label: 'Claude 3 Opus (Premium ⭐)' },
  { id: 'openai/gpt-4o', label: 'GPT-4o (Premium ⭐)' },
  { id: 'google/gemini-pro-1.5', label: 'Gemini 1.5 Pro (Premium ⭐)' },
  { id: 'x-ai/grok-3', label: 'Grok 3 (Premium ⭐)' },
];

const ZEROG_MODELS = [
  { id: '0g/DeepSeek-V3.2', label: 'DeepSeek V3.2 (0G ⚡)' },
  { id: '0g/DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro (0G ⚡)' },
  { id: '0g/0GM-1.0-35B-A3B', label: '0GM 1.0 35B (0G ⚡)' },
  { id: '0g/Qwen3.7-Max', label: 'Qwen 3.7 Max (0G ⚡)' },
  { id: '0g/GLM-5.1-FP8', label: 'GLM 5.1 (0G ⚡)' },
];

function signOAuthState(chatId) {
  const nonce = generateSecureNonce();
  const payload = `${chatId}:${nonce}`;
  const signature = crypto.createHmac('sha256', config.githubClientSecret).update(payload).digest('hex');
  return `${payload}:${signature}`;
}

export function registerAuthCommands(bot) {
  bot.onText(/^\/start$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `👋 *Welcome to AirCommit!*\n\n` +
      `Your AI coding assistant — right inside Telegram.\n\n` +
      `💻 *Features:*\n` +
      `• AI code fixes & smart refactoring\n` +
      `• Compile Solidity contracts\n` +
      `• Run code in a sandbox\n` +
      `• Multi-repo support\n\n` +
      `🆓 *Free Tier* — 10 commands/day\n` +
      `🚀 *Pro* — N2,000/week for unlimited\n\n` +
      `👉 To begin, connect your GitHub:\n\`/login\` or \`/login <PAT>\`\n\n` +
      `💎 Upgrade anytime: \`/upgrade\``,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/^\/login(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const pat = match[1];

    if (pat) {
      try {
        const octokit = new Octokit({ auth: pat });
        const { data } = await octokit.request('GET /user');
        await saveUserSession(chatId, { github_token: pat, active_owner: data.login, active_repo: null });
        bot.sendMessage(chatId, `✅ Successfully logged in as *${data.login}* using PAT!\n\nUse \`/repos\` to list your repositories, then \`/use <owner>/<repo>\` to select one.`, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, `❌ Invalid PAT. Please try again.`);
      }
      return;
    }

    if (!config.githubClientId || !config.githubClientSecret) {
      bot.sendMessage(chatId, `⚠️ GitHub OAuth is not configured on this deployment. Use \`/login <YOUR_PAT>\` instead.`);
      return;
    }

    const authState = signOAuthState(chatId);
    const authUrl = `${config.baseUrl}/auth/github?state=${encodeURIComponent(authState)}`;
    bot.sendMessage(chatId, `🔐 *Connect GitHub Account*\n\nClick the link below to authorize AirCommit:\n[Authorize GitHub](${authUrl})\n\nOr reply with \`/login <YOUR_PAT>\` to use a token.`, { parse_mode: 'Markdown' });
  });

  bot.onText(/^\/logout$/, async (msg) => {
    const chatId = msg.chat.id;
    await deleteUserSession(chatId);
    bot.sendMessage(chatId, `👋 You have been logged out.`);
  });

  bot.onText(/^\/status$/, async (msg) => {
    const chatId = msg.chat.id;
    const session = await getUserSession(chatId);

    if (!session || !session.github_token) {
      bot.sendMessage(chatId, '🔴 You are not logged in.');
    } else {
      const hasCustomKey = !!session.custom_openrouter_key;
      const hasZeroGKey = Object.keys(session.custom_zerog_keys || {}).length > 0;
      const model = session.selected_model || config.codingModel;

      let tier = '🆓 Free Tier';
      if (model.startsWith('0g/')) tier = '⚡ 0G Network';
      else if (hasCustomKey) tier = '👑 BYOK (OpenRouter)';

      bot.sendMessage(chatId,
        `🟢 *AirCommit Status*\n\n` +
        `🧑‍💻 GitHub: *${session.active_owner}*\n` +
        `📁 Active Repo: \`${session.active_owner}/${session.active_repo || 'None'}\`\n\n` +
        `🤖 *AI Configuration*\n` +
        `💳 Tier: ${tier}\n` +
        `🧠 Model: \`${model}\`\n\n` +
        `Use \`/key <openrouter_api_key>\` to unlock premium models.\n` +
        `Use \`/zerogmodels\` to list all 0G models.\n` +
        `Use \`/zerogkey <model_id> <0g_api_key>\` to unlock 0G models.\n` +
        `Use \`/model <model_id>\` to switch AI models.`,
        { parse_mode: 'Markdown' });
    }
  });

  // /key — Save a personal OpenRouter API key (encrypted) or clear it
  bot.onText(/^\/key(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1]?.trim();

    if (!input) {
      return bot.sendMessage(chatId,
        `🔑 *Bring Your Own Key (BYOK)*\n\n` +
        `Link your personal API keys to unlock premium AI models.\n\n` +
        `📝 *Available Key Types:*\n\n` +
        `🚀 **OpenRouter** (unlocks ALL models):\n` +
        `\`/key <your-openrouter-key>\`\n\n` +
        `🎤 **OpenAI** (for voice notes, DALL-E):\n` +
        `\`/openai <your-openai-key>\`\n\n` +
        `⚡ **0G Model** (per-model key):\n` +
        `\`/zerogkey <model> <key>\`\n\n` +
        `🗑️ *Management:*  \`/keys\` (view all)  \`/key clear\` (remove)`,
        { parse_mode: 'Markdown' });
    }

    if (input === 'clear') {
      await keyService.removeOpenRouterKey(chatId);
      await saveUserSession(chatId, { selected_model: null });
      return bot.sendMessage(chatId, `🗑️ OpenRouter key removed. Reverted to *free tier models*.`, { parse_mode: 'Markdown' });
    }

    // Validate the key format
    const validation = keyService.validateKeyFormat(keyService.KEY_TYPES.OPENROUTER, input);
    if (!validation.valid) {
      return bot.sendMessage(chatId, `❌ ${validation.error}`);
    }

    // Validate the key by making a test request to OpenRouter
    try {
      const testRes = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${input}` }
      });
      if (!testRes.ok) {
        const errorData = await testRes.json().catch(() => ({}));
        throw new Error(errorData.message || 'Key validation failed.');
      }
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Invalid OpenRouter key: ${e.message}`);
    }

    await keyService.saveOpenRouterKey(chatId, input);
    bot.sendMessage(chatId,
      `✅ *API Key Saved!*\n\n` +
      `Your key is encrypted and stored securely. You now have access to *all premium models*:\n\n` +
      `• Claude 3.5 Sonnet\n` +
      `• GPT-4o\n` +
      `• Gemini 1.5 Pro\n` +
      `• Grok 3\n` +
      `• And all other premium models\n\n` +
      `Use \`/models\` to see available models.`,
      { parse_mode: 'Markdown' });
  });

  // /keys — Show all configured API keys
  bot.onText(/^\/keys$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const message = await keyService.generateKeyStatusMessage(chatId);
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  });

  // /openai — Save/remove OpenAI API key for voice notes
  bot.onText(/^\/openai(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1]?.trim();

    if (!input) {
      return bot.sendMessage(chatId,
        `🎤 *OpenAI API Key*\n\n` +
        `Link your OpenAI key to enable:\n` +
        `• Voice note transcription ( Whisper )\n` +
        `• Image generation ( DALL-E )\n\n` +
        `📝 *Usage:*\n` +
        `\`/openai <your-openai-key>\`\n\n` +
        `🗑️ To remove: \`/openai clear\`\n\n` +
        `Get your key at: https://platform.openai.com/api-keys`,
        { parse_mode: 'Markdown' });
    }

    if (input === 'clear') {
      await keyService.removeOpenAIKey(chatId);
      return bot.sendMessage(chatId, `🗑️ OpenAI key removed. Voice notes will use the *server key* if available.`, { parse_mode: 'Markdown' });
    }

    // Validate key format
    const validation = keyService.validateKeyFormat(keyService.KEY_TYPES.OPENAI, input);
    if (!validation.valid) {
      return bot.sendMessage(chatId, `❌ ${validation.error}`);
    }

    // Test the key
    try {
      const testRes = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${input}` }
      });
      if (!testRes.ok) {
        const errorData = await testRes.json().catch(() => ({}));
        throw new Error(errorData.error?.message || 'Key validation failed.');
      }
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Invalid OpenAI key: ${e.message}`);
    }

    await keyService.saveOpenAIKey(chatId, input);
    bot.sendMessage(chatId,
      `✅ *OpenAI Key Saved!*\n\n` +
      `You can now send voice notes for transcription!\n\n` +
      `💡 Tip: Voice messages are transcribed and treated as commands.\n` +
      `Just say something like "fix the login button" and send it as voice.`,
      { parse_mode: 'Markdown' });
  });

  // /models — List all available models grouped by tier
  bot.onText(/^\/models$/, async (msg) => {
    const chatId = msg.chat.id;
    const session = await getUserSession(chatId);
    const hasKey = !!session?.custom_openrouter_key;
    const hasZeroG = Object.keys(session?.custom_zerog_keys || {}).length > 0;

    const freeList = FREE_MODELS.map((m, i) => `${i + 1}. \`${m.id}\`\n   ${m.label}`).join('\n');
    const premiumList = PREMIUM_MODELS.map((m, i) => `${i + 1}. \`${m.id}\`\n   ${m.label}`).join('\n');
    const zeroGList = ZEROG_MODELS.map((m, i) => `${i + 1}. \`${m.id}\`\n   ${m.label}`).join('\n');

    bot.sendMessage(chatId,
      `🤖 *Available AI Models*\n\n` +
      `🆓 *Free Models* (available to all):\n${freeList}\n\n` +
      `👑 *Premium Models* (requires \`/key\`):${hasKey ? '' : ' 🔒'}\n${premiumList}\n\n` +
      `⚡ *0G Models* (requires \`/zerogkey\`):${hasZeroG ? '' : ' 🔒'}\n${zeroGList}\n\n` +
      `To switch model, run:\n\`/model <model-id>\``,
      { parse_mode: 'Markdown' });
  });

  // /model — Switch to a specific model
  bot.onText(/^\/model(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const modelId = match[1]?.trim();

    if (!modelId) {
      const session = await getUserSession(chatId);
      const current = session?.selected_model || config.codingModel;
      return bot.sendMessage(chatId, `🤖 Current model: \`${current}\`\n\nRun \`/models\` to see all options, then \`/model <id>\` to switch.`, { parse_mode: 'Markdown' });
    }

    // Check model access via key service
    const keyStatus = await keyService.resolveAIKey(chatId, modelId, {
      openrouterKey: config.openrouterKey,
      zerogApiKey: null
    });

    if (!keyStatus) {
      const isZeroG = ZEROG_MODELS.some(m => m.id === modelId);
      if (isZeroG) {
        return bot.sendMessage(chatId,
          `🔒 *0G Model Locked*\n\n` +
          `\`${modelId}\` requires a 0G API key.\n\n` +
          `Run \`/zerogkey ${modelId} <0g_api_key>\` to unlock.`,
          { parse_mode: 'Markdown' });
      }
      return bot.sendMessage(chatId,
        `🔒 *Model Requires Key*\n\n` +
        `\`${modelId}\` requires a personal API key.\n\n` +
        `Run \`/key\` to set up your key.`,
        { parse_mode: 'Markdown' });
    }

    await saveUserSession(chatId, { selected_model: modelId });
    const modelLabel = [...FREE_MODELS, ...PREMIUM_MODELS, ...ZEROG_MODELS].find(m => m.id === modelId)?.label || modelId;
    bot.sendMessage(chatId, `✅ AI model switched to:\n*${modelLabel}*\n\nAll future \`/fix\`, \`/smart\`, and chat responses will use this model.`, { parse_mode: 'Markdown' });
  });

  // Register 0G model management commands
  registerZeroGCommands(bot);
}

// Export security helpers
export { verifyOAuthState, signOAuthState };
