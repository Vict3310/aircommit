/**
 * Bot Command Rate Limiter
 *
 * Provides a shared SimpleRateLimiter instance with tiered limits:
 * - Heavy commands (/smart, /build, /pr, /fix, /create): 5/min
 * - Light commands (everything else): 20/min
 */
import { SimpleRateLimiter } from './security.js';

// Shared instance: 1-minute sliding window
export const botRateLimiter = new SimpleRateLimiter(60000, 100);

/**
 * Check rate limit and return a Telegram-ready message if rate limited
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} [tier='light'] - 'heavy' for resource-intensive commands
 * @returns {string|null} - Rate limit error message, or null if allowed
 */
export function checkBotRateLimit(chatId, tier = 'light') {
    const result = botRateLimiter.isAllowedTiered(String(chatId), tier);
    if (!result.allowed) {
        const resetAt = new Date(Date.now() + result.retryAfter * 1000);
        const resetTime = resetAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const tierLabel = tier === 'heavy'
            ? 'Heavy commands'
            : 'Commands';
        return `⏳ Rate limited. Try again at *${resetTime}* (${result.retryAfter}s).\n\n${tierLabel} are limited per minute. Please wait before retrying.`;
    }
    return null;
}
