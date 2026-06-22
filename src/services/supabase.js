import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import crypto from 'crypto';
import config from '../core/config.js';

const ALGORITHM = 'aes-256-gcm';
let _encryptionKey = null;
let _encryptionKeyVolatile = false;

function getEncryptionKey() {
  if (!_encryptionKey) {
    if (config.encryptionKey) {
      const hex = config.encryptionKey.trim();
      if (hex.length !== 64) {
        console.error('[FATAL] ENCRYPTION_KEY must be a 32-byte (64-char) hex string. Aborting.');
        process.exit(1);
      }
      _encryptionKey = Buffer.from(hex, 'hex');
      _encryptionKeyVolatile = false;
    } else {
      // Check if there are existing encrypted tokens in the DB
      console.warn(
        '[FATAL] ENCRYPTION_KEY not set. ' +
        'All encrypted tokens (GitHub PATs, OpenRouter keys, 0G keys) will become unreadable after restart. ' +
        'Set ENCRYPTION_KEY= in your .env file. Aborting.'
      );
      process.exit(1);
    }
  }
  return _encryptionKey;
}

/**
 * Return true if the runtime encryption key is volatile (not persisted via ENCRYPTION_KEY env var).
 */
export function isEncryptionKeyVolatile() {
  try { getEncryptionKey(); } catch { /* ignored */ }
  return _encryptionKeyVolatile;
}

export function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an encrypted value. Returns null on failure (never returns plaintext on error).
 */
export function decrypt(text) {
  if (!text || typeof text !== 'string' || !text.includes(':')) return null;
  const parts = text.split(':');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[Security] Decryption failed:', e.message);
    return null; // Never return raw ciphertext — caller must handle
  }
}

let supabase = null;
if (config.supabaseUrl && config.supabaseKey) {
  supabase = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false },
    global: { fetch: fetch },
    realtime: { transport: ws }
  });
  console.log('🔗 Connected to Supabase');
} else {
  console.warn('⚠️ Supabase credentials missing. Relying on ephemeral memory.');
}

const memorySessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Cleans up expired sessions from the in-memory store.
 * Runs periodically to prevent token accumulation.
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [chatId, session] of memorySessions.entries()) {
    if (session._expiresAt && session._expiresAt < now) {
      memorySessions.delete(chatId);
    }
  }
}

// Auto-cleanup every 10 minutes; unref so it doesn't block process exit
setInterval(cleanupExpiredSessions, 10 * 60 * 1000).unref?.();

function normalizeChatId(chatId) {
  if (chatId === null || chatId === undefined) return '';
  return chatId.toString();
}

function isEncryptedValue(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 3 && parts.every(part => /^[0-9a-f]+$/i.test(part));
}

export async function getUserSession(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
  let sessionData = null;
  if (supabase) {
    const { data } = await supabase.from('users').select('*').eq('chat_id', normalizedChatId).single();
    if (data) {
      if (data.github_token) {
        data.github_token = decrypt(data.github_token);
      }
      sessionData = data;
    }
  } else {
    const memData = memorySessions.get(normalizedChatId);
    if (memData) {
      sessionData = JSON.parse(JSON.stringify(memData));
      // Decrypt tokens in memory mode just like Supabase mode
      if (sessionData.github_token) {
        sessionData.github_token = decrypt(sessionData.github_token);
      }
    } else {
      sessionData = null;
    }
  }

  // Decrypt the 0G master key if present (single encrypted string, not a JSON map)
  if (sessionData && sessionData.custom_zerog_key) {
    try {
      const decrypted = decrypt(sessionData.custom_zerog_key);
      // Check if it's legacy JSON (per-model key map) and migrate to single master key
      try {
        const parsed = JSON.parse(decrypted);
        if (typeof parsed === 'object' && parsed !== null) {
          const keys = Object.values(parsed).filter(k => typeof k === 'string' && k.length > 0);
          sessionData.custom_zerog_key = keys.length > 0 ? keys[0] : null;
        }
      } catch (_) {
        // Not JSON — it's a plain key string (new format)
        sessionData.custom_zerog_key = decrypted;
      }
    } catch (_) {
      sessionData.custom_zerog_key = null;
    }
  }

  return sessionData;
}

export async function saveUserSession(chatId, sessionData) {
  const normalizedChatId = normalizeChatId(chatId);
  let existing = {};
  if (supabase) {
    const { data } = await supabase.from('users').select('*').eq('chat_id', normalizedChatId).single();
    if (data) existing = data;
  } else {
    const memData = memorySessions.get(normalizedChatId);
    existing = memData ? JSON.parse(JSON.stringify(memData)) : {};
  }

  // If the existing token is encrypted, decrypt it first so we don't double-encrypt
  if (existing.github_token) {
    existing.github_token = decrypt(existing.github_token);
  }

  // If existing has an encrypted custom_zerog_key, decrypt it
  if (existing.custom_zerog_key) {
    const decrypted = decrypt(existing.custom_zerog_key);
    existing.custom_zerog_key = decrypted;
  }

  const merged = { ...existing, ...sessionData };

  const payload = { chat_id: chatId.toString(), ...merged };

  // Set expiry for in-memory sessions (24h TTL)
  if (!supabase) {
    payload._expiresAt = Date.now() + SESSION_TTL;
  }

  if (payload.github_token && !isEncryptedValue(payload.github_token)) {
    payload.github_token = encrypt(payload.github_token);
  }

  if (payload.custom_openrouter_key && !isEncryptedValue(payload.custom_openrouter_key)) {
    payload.custom_openrouter_key = encrypt(payload.custom_openrouter_key);
  }

  // Encrypt the 0G master key (single string, not a JSON object)
  if (payload.custom_zerog_key && !isEncryptedValue(payload.custom_zerog_key)) {
    payload.custom_zerog_key = encrypt(payload.custom_zerog_key);
  }

  if (supabase) {
    await supabase.from('users').upsert(payload);
  } else {
    memorySessions.set(normalizedChatId, payload);
  }
}

export async function deleteUserSession(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
  if (supabase) {
    await supabase.from('users').delete().eq('chat_id', normalizedChatId);
  } else {
    memorySessions.delete(normalizedChatId);
  }
}

export async function getChatIdsForRepository(owner, repo) {
  if (supabase) {
    const { data } = await supabase
      .from('users')
      .select('chat_id')
      .eq('active_owner', owner)
      .eq('active_repo', repo);

    return (data || []).map(row => row.chat_id.toString());
  }

  const chatIds = [];
  for (const [chatId, session] of memorySessions.entries()) {
    if (session?.active_owner === owner && session?.active_repo === repo) {
      chatIds.push(chatId.toString());
    }
  }
  return chatIds;
}

export function getSupabase() {
  return supabase;
}
