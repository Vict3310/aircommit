/**
 * Security Middleware Module for AirCommit
 * 
 * Provides security headers, input validation, and request sanitization.
 */

import crypto from 'crypto';
import express from 'express';

import logger from './logger.js';

// ─── Security Constants ────────────────────────────────────────────────────────

const NONCE_LENGTH = 32;
const HASH_ALGORITHM = 'sha256';

// Safe characters for file paths - GitHub allows alphanumerics, dots, hyphens, underscores,
// slashes, @, +, and some Unicode. We restrict to the safest subset.
const SAFE_PATH_REGEX = /^[a-zA-Z0-9/_\-.~@+]+$/;
const MAX_PATH_LENGTH = 1024;

// Safe characters for repository identifiers
const SAFE_REPO_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const SAFE_ID_REGEX = /^[a-zA-Z0-9_.-]+$/;

// Command injection patterns to block
const COMMAND_INJECTION_PATTERNS = [
    /;/g,           // Command separator
    /&&/g,          // Logical AND
    /\|\|/g,        // Logical OR
    /\|/g,          // Pipe
    /`/g,           // Backtick execution
    /\$\(/g,        // $() execution
    /</g,           // Redirect input
    />/g,           // Redirect output
    /&/g,           // Background
    /\n/g,          // Newline injection
    /\r/g,          // Carriage return
];

// ─── Security Headers ─────────────────────────────────────────────────────────

/**
 * Sets security headers on all responses
 */
export function securityHeaders(req, res, next) {
    // Content Security Policy - restrict resource loading
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https://avatars.githubusercontent.com; " +
        "font-src 'self'; " +
        "connect-src 'self' https://*.openrouter.ai https://*.0g.ai https://api.github.com wss://*; " +
        "frame-src https://telegram.me; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'; " +
        "frame-ancestors 'none';"
    );

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');

    // XSS Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Strict Transport Security (should be overridden with actual domain in production)
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Permissions Policy
    res.setHeader('Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=()'
    );

    // Remove server version
    res.removeHeader('X-Powered-By');

    next();
}

// ─── Request Validation ───────────────────────────────────────────────────────

/**
 * Validates and sanitizes a file path
 */
export function validateFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return { valid: false, error: 'File path is required' };
    }

    // Check length
    if (filePath.length > MAX_PATH_LENGTH) {
        return { valid: false, error: 'File path too long' };
    }

    // Check for path traversal attempts
    if (filePath.includes('..') || filePath.includes('//')) {
        return { valid: false, error: 'Invalid file path' };
    }

    // Check for null bytes
    if (filePath.includes('\0') || filePath.includes('%00')) {
        return { valid: false, error: 'Invalid file path' };
    }

    // Sanitize - keep only safe path characters; strip all shell metacharacters
    const sanitized = filePath.replace(/[^a-zA-Z0-9/_.\-~@+]/g, '');

    if (sanitized.length === 0 || sanitized.startsWith('/') || sanitized.startsWith('\\')) {
        return { valid: false, error: 'Invalid file path format' };
    }

    return { valid: true, value: sanitized };
}

/**
 * Validates a repository identifier (owner/repo format)
 */
export function validateRepoIdentifier(repo) {
    if (!repo || typeof repo !== 'string') {
        return { valid: false, error: 'Repository identifier is required' };
    }

    const parts = repo.split('/');
    if (parts.length !== 2) {
        return { valid: false, error: 'Invalid repository format. Expected: owner/repo' };
    }

    const [owner, repoName] = parts;

    if (!SAFE_ID_REGEX.test(owner)) {
        return { valid: false, error: 'Invalid owner name' };
    }

    if (!SAFE_ID_REGEX.test(repoName)) {
        return { valid: false, error: 'Invalid repository name' };
    }

    if (owner.length > 39 || repoName.length > 100) {
        return { valid: false, error: 'Repository name too long' };
    }

    return { valid: true, owner, repo: repoName };
}

/**
 * Validates a Telegram chat ID
 */
export function validateChatId(chatId) {
    if (chatId === undefined || chatId === null) {
        return { valid: false, error: 'Chat ID is required' };
    }

    const id = typeof chatId === 'string' ? chatId : String(chatId);

    // Telegram chat IDs are numeric (positive for users, negative for groups/channels)
    if (!/^-?\d+$/.test(id)) {
        return { valid: false, error: 'Invalid chat ID format' };
    }

    return { valid: true, chatId: parseInt(id, 10) };
}

/**
 * Validates a model ID
 */
export function validateModelId(modelId) {
    if (!modelId || typeof modelId !== 'string') {
        return { valid: false, error: 'Model ID is required' };
    }

    // Allow model IDs with slashes, dots, hyphens, colons (e.g., "anthropic/claude-3.5-sonnet")
    if (!/^[a-zA-Z0-9\-_/.:]+$/.test(modelId)) {
        return { valid: false, error: 'Invalid model ID format' };
    }

    if (modelId.length > 200) {
        return { valid: false, error: 'Model ID too long' };
    }

    return { valid: true, modelId };
}

/**
 * Validates a branch name
 */
export function validateBranchName(branch) {
    if (!branch || typeof branch !== 'string') {
        return { valid: false, error: 'Branch name is required' };
    }

    // GitHub branch name validation
    if (!/^[a-zA-Z0-9_\-/.]+$/.test(branch)) {
        return { valid: false, error: 'Invalid branch name format' };
    }

    if (branch.length > 255) {
        return { valid: false, error: 'Branch name too long' };
    }

    // Reject obviously malicious names
    if (branch === '.' || branch === '..' || branch.startsWith('..')) {
        return { valid: false, error: 'Invalid branch name' };
    }

    return { valid: true, branch };
}

// ─── Command Injection Prevention ─────────────────────────────────────────────

/**
 * Checks if a string contains potential command injection patterns
 */
export function hasCommandInjection(str) {
    if (typeof str !== 'string') return false;

    return COMMAND_INJECTION_PATTERNS.some(pattern => pattern.test(str));
}

/**
 * Sanitizes a string for safe shell execution
 * NOTE: This is a defense-in-depth measure. Always prefer parameterized commands.
 */
export function sanitizeForShell(str) {
    if (typeof str !== 'string') return '';

    return str
        .replace(/'/g, "'\\''")    // Escape single quotes
        .replace(/"/g, '\\"')      // Escape double quotes
        .replace(/;/g, '\\;')      // Escape semicolons
        .replace(/&/g, '\\&')      // Escape ampersands
        .replace(/\|/g, '\\|')     // Escape pipes
        .replace(/`/g, '\\`')      // Escape backticks
        .replace(/\$/g, '\\$')     // Escape dollar signs
        .replace(/\n/g, '')        // Remove newlines
        .replace(/\r/g, '');       // Remove carriage returns
}

/**
 * Validates and sanitizes an AI model response before processing
 */
export function validateAIResponse(response) {
    if (!response || typeof response !== 'object') {
        return { valid: false, error: 'Invalid response format' };
    }

    // Limit response size
    const responseStr = JSON.stringify(response);
    if (responseStr.length > 100000) {
        return { valid: false, error: 'Response too large' };
    }

    return { valid: true, response };
}

// ─── API Key Validation ───────────────────────────────────────────────────────

/**
 * Validates an API key format (basic check)
 */
export function validateAPIKey(key) {
    if (!key || typeof key !== 'string') {
        return { valid: false, error: 'API key is required' };
    }

    // OpenRouter keys start with "sk-or-"
    if (key.startsWith('sk-or-') && key.length >= 50) {
        return { valid: true, type: 'openrouter' };
    }

    // Generic key format check (alphanumeric with hyphens)
    if (/^[a-zA-Z0-9\-_]{20,}/.test(key)) {
        return { valid: true, type: 'generic' };
    }

    return { valid: false, error: 'Invalid API key format' };
}

// ─── Rate Limiting Helpers ────────────────────────────────────────────────────

/**
 * Simple in-memory rate limiter
 * Can be replaced with Redis-backed rate limiter in production
 */
export class SimpleRateLimiter {
    constructor(windowMs = 60000, maxRequests = 100) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
        this.requests = new Map();

        // Auto-cleanup every 5 minutes
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 5 * 60 * 1000);

        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }

    isAllowed(key) {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        if (!this.requests.has(key)) {
            this.requests.set(key, []);
        }

        const keyRequests = this.requests.get(key);
        const validRequests = keyRequests.filter(t => t > windowStart);
        this.requests.set(key, validRequests);

        if (validRequests.length >= this.maxRequests) {
            return { allowed: false, remaining: 0, retryAfter: Math.ceil((validRequests[0] - windowStart) / 1000) };
        }

        validRequests.push(now);
        return { allowed: true, remaining: this.maxRequests - validRequests.length };
    }

    /**
     * Check rate limit with tiered limits for heavy vs light commands
     * @param {string} key - Identifier (e.g., chat ID)
     * @param {string} [tier='light'] - 'heavy' for /smart, /build, /pr, /fix; 'light' for everything else
     * @returns {{ allowed: boolean, remaining: number, retryAfter?: number }}
     */
    isAllowedTiered(key, tier = 'light') {
        const heavyKey = `${key}:heavy`;
        const lightKey = `${key}:light`;

        if (tier === 'heavy') {
            // Heavy commands: stricter limit (5 per minute)
            const heavyResult = this._check(heavyKey, 5);
            if (!heavyResult.allowed) return heavyResult;
            // Also count against light limit
            const lightResult = this._check(lightKey, 15);
            if (!lightResult.allowed) return lightResult;
            return heavyResult;
        }
        return this._check(lightKey, 20);
    }

    /**
     * Internal check with a custom max
     */
    _check(key, maxRequests) {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        if (!this.requests.has(key)) {
            this.requests.set(key, []);
        }

        const keyRequests = this.requests.get(key);
        const validRequests = keyRequests.filter(t => t > windowStart);
        this.requests.set(key, validRequests);

        if (validRequests.length >= maxRequests) {
            return { allowed: false, remaining: 0, retryAfter: Math.ceil((validRequests[0] - windowStart) / 1000) };
        }

        validRequests.push(now);
        return { allowed: true, remaining: maxRequests - validRequests.length };
    }

    cleanup() {
        const now = Date.now();
        for (const [key, requests] of this.requests.entries()) {
            const valid = requests.filter(t => t > now - this.windowMs);
            if (valid.length === 0) {
                this.requests.delete(key);
            }
        }
    }

    /**
     * Manually stop the cleanup interval
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

// ─── Cryptographic Helpers ────────────────────────────────────────────────────

/**
 * Generates a cryptographically secure random string
 */
export function generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
}

/**
 * Generates a cryptographically secure nonce
 */
export function generateSecureNonce() {
    const timestamp = Math.floor(Date.now() / 1000);
    const random = crypto.randomBytes(24).toString('hex');
    return timestamp.toString(16) + random;
}

/**
 * Performs timing-safe comparison of two strings (Web Crypto API).
 */
export async function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;

    const bufA = new TextEncoder().encode(a);
    const bufB = new TextEncoder().encode(b);

    return await crypto.subtle.timingSafeEqual(bufA, bufB);
}

// ─── Content-Type Validation ──────────────────────────────────────────────────

/**
 * Allowed CORS origins (configurable)
 */
export function allowCORS(origins = ['https://telegram.me', 'https://web.telegram.org']) {
    return (req, res, next) => {
        const origin = req.headers.origin;

        if (origin && origins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
        }

        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }

        next();
    };
}

/**
 * Validates Content-Type for incoming JSON requests
 */
export function requireJSONContent(req, res, next) {
    const contentType = req.headers['content-type'];

    if (!contentType || !contentType.includes('application/json')) {
        return res.status(415).json({ error: 'Unsupported Media Type', message: 'Content-Type must be application/json' });
    }

    next();
}

// ─── Request Size Limits ──────────────────────────────────────────────────────

/**
 * Limits request body size
 */
export function bodySizeLimit(maxSize = '1mb') {
    return express.json({ limit: maxSize });
}

// ─── WebSocket Security ───────────────────────────────────────────────────────

/**
 * Validates WebSocket origin
 */
export function validateWebSocketOrigin(allowedOrigins = []) {
    return (connection, req) => {
        const origin = req.headers['origin'];

        if (!origin) {
            // Allow same-origin connections
            return true;
        }

        if (allowedOrigins.length === 0) {
            // No restrictions if no origins configured
            return true;
        }

        return allowedOrigins.includes(origin);
    };
}

// ─── Logging Middleware ───────────────────────────────────────────────────────

/**
 * Logs security-relevant request information
 */
export function securityLogger(req, res, next) {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const isSecurityEvent = [401, 403, 429].includes(res.statusCode);

        if (isSecurityEvent || req.path.includes('/auth') || req.path.includes('/webhook')) {
            logger.warn({
                component: 'security',
                method: req.method,
                path: req.path,
                statusCode: res.statusCode,
                duration: `${duration}ms`,
                ip: req.ip || req.connection.remoteAddress,
                userAgent: req.headers['user-agent'],
                timestamp: new Date().toISOString()
            });
        }
    });

    next();
}

// ─── Export Express Middleware ─────────────────────────────────────────────────

/**
 * Complete security middleware stack for Express
 * Usage: app.use(securityMiddleware());
 */
export function securityMiddleware() {
    return [
        securityHeaders,
        securityLogger
    ];
}