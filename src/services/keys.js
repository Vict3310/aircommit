/**
 * Per-User API Key Management Service
 * 
 * Features:
 * - Multiple API keys per user (OpenRouter, 0G master key, custom providers)
 * - Key assignment to specific models or model categories
 * - Encrypted storage
 * - Key rotation and revocation
 * 
 * IMPORTANT: 0G uses ONE master key that unlocks ALL 0G models.
 * No longer uses per-model keys.
 */

import crypto from 'crypto';
import { getUserSession, saveUserSession, encrypt, decrypt } from './supabase.js';

// ─── Key Types ────────────────────────────────────────────────────────────────

const KEY_TYPES = {
    OPENROUTER: 'openrouter',
    ZEROG: 'zerog',           // 0G serving API (MASTER KEY - unlocks all 0G models)
    OPENAI: 'openai',         // OpenAI API (for voice, image)
    CUSTOM: 'custom',         // Custom AI provider
};

// ─── Model Category Mappings ─────────────────────────────────────────────────

/**
 * Maps model IDs to their category for key assignment
 */
const MODEL_CATEGORIES = {
    // OpenRouter models — use single key
    openrouter: [
        'qwen/',
        'meta-llama/',
        'anthropic/claude',
        'openai/gpt',
        'google/gemini',
        'x-ai/',
        'deepseek/',
        'nemotron/',
    ],
    // 0G models — each needs individual key
    zerog: [
        '0g/',
    ],
};

/**
 * Returns the category a model belongs to
 */
export function getModelCategory(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;

    for (const [category, prefixes] of Object.entries(MODEL_CATEGORIES)) {
        for (const prefix of prefixes) {
            if (modelId.startsWith(prefix)) {
                return category;
            }
        }
    }

    return 'openrouter'; // Default fallback
}

// ─── Key Storage Structure ───────────────────────────────────────────────────

/**
 * Key storage structure in database:
 * {
 *   custom_openrouter_key: string (encrypted),
 *   custom_openai_key: string (encrypted),
 *   custom_zerog_keys: { [modelId]: apiKey } (encrypted as JSON),
 *   custom_provider_keys: { [provider]: { url, key } } (encrypted as JSON)
 * }
 */

// ─── Key Management Functions ────────────────────────────────────────────────

/**
 * Get all keys for a user
 * Note: 0G now uses a single master key, not per-model keys
 */
export async function getUserKeys(chatId) {
    const session = await getUserSession(chatId);
    if (!session) return { keys: [], keyCount: 0 };

    const keys = {
        openrouter: !!session.custom_openrouter_key,
        openai: !!session.custom_openai_key,
        zerog: !!session.custom_zerog_key,  // Single master key
        custom: Object.keys(session.custom_provider_keys || {}),
    };

    return {
        keys,
        keyCount: Object.keys(keys).reduce((acc, type) => {
            return acc + (keys[type] ? 1 : 0);
        }, 0)
    };
}

/**
 * Save an OpenRouter API key
 */
export async function saveOpenRouterKey(chatId, apiKey) {
    if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('API key is required');
    }

    const encrypted = encrypt(apiKey);
    await saveUserSession(chatId, { custom_openrouter_key: encrypted });

    return { success: true, type: KEY_TYPES.OPENROUTER };
}

/**
 * Remove OpenRouter key
 */
export async function removeOpenRouterKey(chatId) {
    await saveUserSession(chatId, { custom_openrouter_key: null });
    return { success: true, type: KEY_TYPES.OPENROUTER };
}

/**
 * Save an OpenAI API key (for voice transcription, image generation)
 */
export async function saveOpenAIKey(chatId, apiKey) {
    if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('API key is required');
    }

    const encrypted = encrypt(apiKey);
    await saveUserSession(chatId, { custom_openai_key: encrypted });

    return { success: true, type: KEY_TYPES.OPENAI };
}

/**
 * Remove OpenAI key
 */
export async function removeOpenAIKey(chatId) {
    await saveUserSession(chatId, { custom_openai_key: null });
    return { success: true, type: KEY_TYPES.OPENAI };
}

/**
 * Save a 0G MASTER API key (unlocks ALL 0G models)
 * One key for all models - no per-model keys needed
 */
export async function saveZeroGKey(chatId, apiKey) {
    if (!apiKey) {
        throw new Error('API key is required');
    }

    // Store as single master key (custom_zerog_key, not custom_zerog_keys map)
    const encrypted = encrypt(apiKey);
    await saveUserSession(chatId, { custom_zerog_key: encrypted });

    return { success: true, type: KEY_TYPES.ZEROG };
}

/**
 * Remove the 0G master key
 */
export async function removeZeroGKey(chatId) {
    await saveUserSession(chatId, { custom_zerog_key: null });
    return { success: true, type: KEY_TYPES.ZEROG };
}

// ─── Legacy Per-Model Key Compatibility (deprecated) ──────────────────────────
// These functions are kept for backward compatibility during migration.
// Users should migrate to the master key system.

/**
 * @deprecated Use saveZeroGKey(chatId, apiKey) instead - one key for all models
 */
export async function saveZeroGModelKey(chatId, modelId, apiKey) {
    // Just save as master key - it works for all models now
    return saveZeroGKey(chatId, apiKey);
}

/**
 * @deprecated Use removeZeroGKey(chatId) instead
 */
export async function removeZeroGModelKey(chatId, modelId) {
    return removeZeroGKey(chatId);
}

/**
 * Save a custom provider key (for future extensibility)
 */
export async function saveCustomProviderKey(chatId, provider, config) {
    if (!provider || !config || !config.apiKey) {
        throw new Error('Provider and config with apiKey are required');
    }

    const session = await getUserSession(chatId);
    const providers = session?.custom_provider_keys || {};

    providers[provider] = {
        url: config.url || null,
        apiKey: encrypt(config.apiKey),
        createdAt: new Date().toISOString(),
    };

    await saveUserSession(chatId, { custom_provider_keys: providers });

    return { success: true, type: KEY_TYPES.CUSTOM, provider };
}

/**
 * Remove a custom provider key
 */
export async function removeCustomProviderKey(chatId, provider) {
    const session = await getUserSession(chatId);
    const providers = session?.custom_provider_keys || {};

    delete providers[provider];

    await saveUserSession(chatId, { custom_provider_keys: providers });

    return { success: true, type: KEY_TYPES.CUSTOM, provider };
}

/**
 * Get the API key for a specific model
 * Returns: { apiKey, endpoint, modelId }
 * 
 * 0G models now use a SINGLE master key that unlocks ALL 0G models.
 */
export async function resolveAIKey(chatId, modelId, serverConfig) {
    if (!modelId) {
        return {
            apiKey: serverConfig.openrouterKey,
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            model: modelId || serverConfig.codingModel
        };
    }

    const session = await getUserSession(chatId);
    const category = getModelCategory(modelId);

    // 0G models — use master key (unlocks ALL 0G models)
    if (category === 'zerog') {
        const cleanModelId = modelId.replace('0g/', '');

        // Check for master 0G key (new system)
        if (session?.custom_zerog_key) {
            const decryptedKey = decrypt(session.custom_zerog_key);
            if (decryptedKey) {
                return {
                    apiKey: decryptedKey,
                    endpoint: 'https://router-api.0g.ai/v1/chat/completions',
                    model: cleanModelId
                };
            }
        }

        // Fall back to server 0G config if available
        if (serverConfig?.zerogApiKey) {
            return {
                apiKey: serverConfig.zerogApiKey,
                endpoint: 'https://router-api.0g.ai/v1/chat/completions',
                model: cleanModelId
            };
        }

        return null; // No key available
    }

    // OpenRouter models — use user's OpenRouter key or server key
    if (category === 'openrouter') {
        const userKey = session?.custom_openrouter_key;
        if (userKey) {
            const decryptedKey = decrypt(userKey);
            return {
                apiKey: decryptedKey,
                endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                model: modelId
            };
        }

        return {
            apiKey: serverConfig.openrouterKey,
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            model: modelId
        };
    }

    // Custom provider
    if (category === 'custom') {
        const providers = session?.custom_provider_keys || {};
        const provider = providers[modelId];
        if (provider) {
            return {
                apiKey: decrypt(provider.apiKey),
                endpoint: provider.url || `https://${modelId}.api`,
                model: modelId
            };
        }
    }

    return null;
}

// ─── Key Validation ──────────────────────────────────────────────────────────

/**
 * Validates an API key format based on provider type
 */
export function validateKeyFormat(type, key) {
    if (!key || typeof key !== 'string') {
        return { valid: false, error: 'API key is required' };
    }

    switch (type) {
        case KEY_TYPES.OPENROUTER:
            if (!key.startsWith('sk-or-')) {
                return { valid: false, error: 'OpenRouter keys start with "sk-or-"' };
            }
            if (key.length < 30) {
                return { valid: false, error: 'OpenRouter key appears too short' };
            }
            return { valid: true, type: KEY_TYPES.OPENROUTER };

        case KEY_TYPES.OPENAI:
            if (!key.startsWith('sk-') && !key.startsWith('sk-proj-')) {
                return { valid: false, error: 'OpenAI keys start with "sk-" or "sk-proj-"' };
            }
            return { valid: true, type: KEY_TYPES.OPENAI };

        case KEY_TYPES.ZEROG:
            // 0G keys can vary — just check length
            if (key.length < 20) {
                return { valid: false, error: 'API key appears too short' };
            }
            return { valid: true, type: KEY_TYPES.ZEROG };

        case KEY_TYPES.CUSTOM:
            if (key.length < 10) {
                return { valid: false, error: 'API key appears too short' };
            }
            return { valid: true, type: KEY_TYPES.CUSTOM };

        default:
            return { valid: false, error: 'Unknown key type' };
    }
}

// ─── Key List Formatting ─────────────────────────────────────────────────────

/**
 * Generates a user-friendly key status message
 * 0G now shows as single master key, not per-model
 */
export async function generateKeyStatusMessage(chatId) {
    const { keys } = await getUserKeys(chatId);

    let message = `🔑 *Your API Keys*\n\n`;

    // OpenRouter
    message += keys.openrouter
        ? `✅ *OpenRouter* — Active (unlocks ALL models)\n`
        : `❌ *OpenRouter* — Not set\n   /key <your-key>\n`;

    // OpenAI
    message += keys.openai
        ? `✅ *OpenAI* — Active (voice, image)\n`
        : `❌ *OpenAI* — Not set\n   /openai <your-key>\n`;

    // 0G models — single master key
    if (keys.zerog) {
        message += `\n⚡ *0G Network* — Master key active (unlocks ALL 0G models)\n`;
    } else {
        message += `\n❌ *0G Network* — No key set\n   /zerogkey <your-0g-api-key>\n`;
    }

    // Custom providers
    if (keys.custom.length > 0) {
        message += `\n🔌 *Custom Providers* (${keys.custom.length}):\n`;
        for (const provider of keys.custom) {
            message += `  ✅ ${provider}\n`;
        }
    }

    message += `\n🗑️ *Remove a key:*\n   /key clear | /openai clear | /zerogkey clear`;

    return message;
}

// ─── Export All ──────────────────────────────────────────────────────────────

export default {
    KEY_TYPES,
    getModelCategory,
    getUserKeys,
    saveOpenRouterKey,
    removeOpenRouterKey,
    saveOpenAIKey,
    removeOpenAIKey,
    saveZeroGKey,       // NEW: Master key for ALL 0G models
    removeZeroGKey,
    saveCustomProviderKey,
    removeCustomProviderKey,
    // Legacy compatibility (deprecated)
    saveZeroGModelKey,
    removeZeroGModelKey,
    resolveAIKey,
    validateKeyFormat,
    generateKeyStatusMessage,
};
