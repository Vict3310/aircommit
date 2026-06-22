/**
 * 0G Model Manager - Dynamic model discovery and key management
 * 
 * This module handles:
 * - Fetching live 0G models from their API
 * - Managing per-model API keys
 * - Displaying which models need keys vs which are available
 */

import config from '../core/config.js';
import { getUserSession, saveUserSession } from './supabase.js';
import keyService from './keys.js';

const ZEROG_API_BASE = 'https://router-api.0g.ai';
const ZEROG_MODELS_ENDPOINT = `${ZEROG_API_BASE}/v1/models`;

// ─── Model Tier Definitions ───────────────────────────────────────────────────

export const ZEROG_MODELS_CACHE_KEY = 'zerog_models';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetches available 0G models from the API
 */
export async function fetchZeroGModels() {
  try {
    const response = await fetch(ZEROG_MODELS_ENDPOINT);
    if (!response.ok) {
      throw new Error(`0G API returned ${response.status}`);
    }

    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data : [];

    // Extract model IDs and format them
    const modelList = models
      .filter(m => m && m.id)
      .map(m => ({
        id: `0g/${m.id}`,
        label: `${m.id} (${m.provider || '0G'})`,
        available: !m.encrypted || m.encrypted === false
      }));

    return modelList;
  } catch (error) {
    console.error('[0G Models] Failed to fetch models:', error.message);
    // Return default list as fallback
    return [
      { id: '0g/DeepSeek-V3.2', label: 'DeepSeek V3.2 (0G ⚡)', available: true },
      { id: '0g/DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro (0G ⚡)', available: true },
      { id: '0g/0GM-1.0-35B-A3B', label: '0GM 1.0 35B (0G ⚡)', available: true },
      { id: '0g/Qwen3.7-Max', label: 'Qwen 3.7 Max (0G ⚡)', available: true },
      { id: '0g/GLM-5.1-FP8', label: 'GLM 5.1 (0G ⚡)', available: true },
    ];
  }
}

/**
 * Fetches models and caches them (for performance)
 */
export async function getZeroGModels(forceRefresh = false) {
  // In production, you might want to cache this in a database
  // For now, just fetch fresh each time
  return await fetchZeroGModels();
}

/**
 * Gets the 0G master API key (unlocks ALL 0G models)
 */
export function getZeroGModelKey() {
  // Now returns the master key, not per-model key
  // This function is deprecated - use resolveAIKey from keys.js instead
  return null;
}

/**
 * Saves the 0G MASTER API key (unlocks ALL 0G models)
 * @deprecated Use saveZeroGKey from keys.js instead
 */
export async function saveZeroGModelKey(chatId, modelId, apiKey) {
  // Model ID is ignored - one key for all models
  return keyService.saveZeroGKey(chatId, apiKey);
}

/**
 * Removes the 0G master API key
 * @deprecated Use removeZeroGKey from keys.js instead
 */
export async function removeZeroGModelKey(chatId, modelId) {
  return keyService.removeZeroGKey(chatId);
}

/**
 * Checks if user has a 0G master key
 * @deprecated Use getUserKeys from keys.js instead
 */
export async function hasZeroGModelKey(chatId, modelId) {
  const session = await getUserSession(chatId);
  return !!session?.custom_zerog_key;
}

/**
 * Returns a formatted list of 0G models showing availability status
 * Shows master key status instead of per-model status
 */
export async function getZeroGModelsStatusMessage(chatId) {
  const models = await getZeroGModels();
  const session = await getUserSession(chatId);
  const hasMasterKey = !!session?.custom_zerog_key;

  let message = `⚡ *0G Models Status*\n\n`;
  message += hasMasterKey
    ? `✅ *Master API Key Active* — ALL models unlocked!\n\n`
    : `🔒 *No 0G API Key* — Enter your master key to unlock all models\n\n`;

  for (const model of models) {
    const status = hasMasterKey ? '✅' : '🔒';
    message += `${status} ${model.label}\n`;
    if (!hasMasterKey) {
      message += `   🔑 Use \`/zerogkey <your-0g-api-key>\` to unlock ALL models\n`;
    }
    message += '\n';
  }

  return message;
}

/**
 * Command handlers for 0G model management
 */
export function registerZeroGCommands(bot) {
  // /zerogmodels — Show all 0G models with availability status
  bot.onText(/^\/zerogmodels$/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      await bot.sendChatAction(chatId, 'typing');
      const message = await getZeroGModelsStatusMessage(chatId);
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  });

  // /zerogkey — Save/remove 0G MASTER API key (unlocks ALL 0G models)
  bot.onText(/^\/zerogkey(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1]?.trim();

    if (!input) {
      return bot.sendMessage(chatId,
        `⚡ *0G API Key (Master Key)*\n\n` +
        `One key unlocks ALL 0G models — no per-model keys needed!\n\n` +
        `📝 *Usage:*\n` +
        `\`/zerogkey <your-0g-api-key>\`\n\n` +
        `✅ *This key unlocks:*\n` +
        `• DeepSeek V3.2\n` +
        `• DeepSeek V4 Pro\n` +
        `• 0GM 1.0 35B\n` +
        `• Qwen 3.7 Max\n` +
        `• GLM 5.1\n` +
        `• And all other 0G models\n\n` +
        `🗑️ To remove: \`/zerogkey clear\`\n\n` +
        `Get your key at: https://www.0g.ai/`,
        { parse_mode: 'Markdown' });
    }

    if (input === 'clear') {
      await keyService.removeZeroGKey(chatId);
      return bot.sendMessage(chatId, `🗑️ 0G master key removed. All 0G models locked.`, { parse_mode: 'Markdown' });
    }

    // The key is the entire input (no model ID prefix needed)
    const key = input;

    // Validate key format
    const validation = keyService.validateKeyFormat(keyService.KEY_TYPES.ZEROG, key);
    if (!validation.valid) {
      return bot.sendMessage(chatId, `❌ ${validation.error}`);
    }

    // Validate the key by making a test request to 0G
    try {
      await bot.sendChatAction(chatId, 'typing');

      const testRes = await fetch(`${ZEROG_API_BASE}/v1/models`, {
        headers: { 'Authorization': `Bearer ${key}` }
      });

      if (!testRes.ok) {
        const errorData = await testRes.json().catch(() => ({}));
        throw new Error(errorData.message || 'Key validation failed.');
      }

      const keyModels = await testRes.json();
      if (keyModels.data && Array.isArray(keyModels.data)) {
        const availableModelIds = keyModels.data.map(m => m.id.trim());
        await bot.sendMessage(chatId,
          `✅ *0G Key Valid!*\n\n` +
          `Your key has access to ${availableModelIds.length} models:\n\n` +
          `${availableModelIds.slice(0, 10).map(m => `🚀 ${m}`).join('\n')}${availableModelIds.length > 10 ? `\n...and ${availableModelIds.length - 10} more` : ''}\n\n` +
          `All models are now unlocked! Use \`/model 0g/<model-id>\` to switch.`,
          { parse_mode: 'Markdown' });
      }
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Invalid 0G API key: ${e.message}`);
    }

    try {
      // Save as master key (unlocks ALL models)
      await keyService.saveZeroGKey(chatId, key);

      await bot.sendMessage(chatId,
        `✅ *0G Master Key Saved!*\n\n` +
        `Your key is securely stored and unlocks **ALL 0G models**:\n\n` +
        `• DeepSeek V3.2\n` +
        `• DeepSeek V4 Pro\n` +
        `• 0GM 1.0 35B-A3B\n` +
        `• Qwen 3.7 Max\n` +
        `• GLM 5.1\n\n` +
        `Use \`/zerogmodels\` to see all available models.\n` +
        `Use \`/model 0g/DeepSeek-V3.2\` to switch.`,
        { parse_mode: 'Markdown' });
    } catch (error) {
      await bot.sendMessage(chatId, `❌ Error saving key: ${error.message}`);
    }
  });
}
