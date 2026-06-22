/**
 * Redis-powered caching layer for AirCommit
 * 
 * Features:
 * - Session cache with automatic fallback
 * - File tree cache with invalidation
 * - Configurable TTLs
 */

import { createClient } from 'redis';
import config from '../core/config.js';

// ─── Cache Client ─────────────────────────────────────────────────────────────

let redisClient = null;
let redisConnected = false;

export async function connectRedis() {
  if (redisClient) return redisClient;

  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      password: process.env.REDIS_PASSWORD,
      socket: {
        connectTimeout: 2000, // 2 second timeout
        retryDelay: 0,
      },
    });

    let redisErrorLogged = false;
    redisClient.on('error', (err) => {
      if (!redisErrorLogged && !redisConnected) {
        console.warn('[Redis] Connection error:', err.message);
        redisErrorLogged = true;
      }
      redisConnected = false;
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected to Redis');
      redisConnected = true;
    });

    redisClient.on('reconnecting', () => {
      // Silent - we're not using Redis and don't need reconnect noise
    });

    await Promise.race([
      redisClient.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout')), 3000)
      ),
    ]);

    redisConnected = true;
    return redisClient;
  } catch (error) {
    console.warn('[Redis] Failed to connect, running without cache:', error.message);
    redisConnected = false;
    redisClient = null; // Reset so we don't keep retrying
    return null;
  }
}

export function isRedisConnected() {
  return redisConnected && redisClient;
}

// ─── Session Cache ────────────────────────────────────────────────────────────

const SESSION_TTL = 300; // 5 minutes

export async function getSessionCache(chatId) {
  if (!isRedisConnected()) return null;

  try {
    const cached = await redisClient.get(`session:${chatId}`);
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  } catch (error) {
    console.warn('[Cache] Session read error:', error.message);
    return null;
  }
}

export async function setSessionCache(chatId, sessionData, ttl = SESSION_TTL) {
  if (!isRedisConnected()) return false;

  try {
    await redisClient.setEx(`session:${chatId}`, ttl, JSON.stringify(sessionData));
    return true;
  } catch (error) {
    console.warn('[Cache] Session write error:', error.message);
    return false;
  }
}

export async function invalidateSessionCache(chatId) {
  if (!isRedisConnected()) return false;

  try {
    await redisClient.del(`session:${chatId}`);
    return true;
  } catch (error) {
    console.warn('[Cache] Session invalidate error:', error.message);
    return false;
  }
}

// ─── File Tree Cache ────────────────────────────────────────────────────────

const FILE_TREE_TTL = 3600; // 1 hour
const FILE_TREE_MAX = 1000; // Max entries

export async function getFileTreeCache(owner, repo, branch) {
  if (!isRedisConnected()) return null;

  const cacheKey = `filetree:${owner}/${repo}:${branch}`;

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  } catch (error) {
    console.warn('[Cache] File tree read error:', error.message);
    return null;
  }
}

export async function setFileTreeCache(owner, repo, branch, filePaths) {
  if (!isRedisConnected()) return false;

  const cacheKey = `filetree:${owner}/${repo}:${branch}`;

  try {
    await redisClient.setEx(cacheKey, FILE_TREE_TTL, JSON.stringify(filePaths));
    await redisClient.lPush('filetree:keys', cacheKey);
    // Trim to max entries
    const keys = await redisClient.lRange('filetree:keys', 0, FILE_TREE_MAX - 1);
    if (keys.length > FILE_TREE_MAX) {
      const toDelete = keys.slice(FILE_TREE_MAX);
      await redisClient.del(toDelete);
      await redisClient.lTrim('filetree:keys', 0, FILE_TREE_MAX - 1);
    }
    return true;
  } catch (error) {
    console.warn('[Cache] File tree write error:', error.message);
    return false;
  }
}

export async function invalidateFileTreeCache(owner, repo) {
  if (!isRedisConnected()) return false;

  try {
    const keys = await redisClient.keys(`filetree:${owner}/${repo}:*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    return true;
  } catch (error) {
    console.warn('[Cache] File tree invalidate error:', error.message);
    return false;
  }
}

// ─── General Purpose Cache ────────────────────────────────────────────────────

export async function setCache(key, value, ttl = 300) {
  if (!isRedisConnected()) return false;

  try {
    await redisClient.setEx(key, ttl, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn('[Cache] Set error:', error.message);
    return false;
  }
}

export async function getCache(key) {
  if (!isRedisConnected()) return null;

  try {
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.warn('[Cache] Get error:', error.message);
    return null;
  }
}

export async function deleteCache(key) {
  if (!isRedisConnected()) return false;

  try {
    await redisClient.del(key);
    return true;
  } catch (error) {
    console.warn('[Cache] Delete error:', error.message);
    return false;
  }
}

// ─── Shutdown Hook ────────────────────────────────────────────────────────────

export async function disconnectRedis() {
  try {
    if (redisClient) {
      await redisClient.quit();
      redisConnected = false;
    }
  } catch (e) { /* ignore */ }
}
