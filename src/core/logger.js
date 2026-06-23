/**
 * Structured Logger for AirCommit
 *
 * Features:
 * - Console output (pretty in dev, JSON in production)
 * - File logging with daily rotation (logs/*.log)
 * - Structured JSON output for log aggregation
 * - Log levels: debug, info, warn, error, fatal
 * - Request-ID binding for distributed tracing
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

function shouldLog(level) {
    return LEVELS[level] >= LEVELS[logLevel];
}

// ─── File Transport ──────────────────────────────────────────────────────────

const LOG_DIR = path.resolve('./logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const DATE = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const LOG_FILE = path.join(LOG_DIR, `aircommit-${DATE}.log`);
const ERR_LOG_FILE = path.join(LOG_DIR, `errors-${DATE}.log`);

/**
 * Writes a log line to the appropriate file.
 * Creates new file each day (rotation is implicit via date in filename).
 */
function writeToFile(entry, level) {
    const line = JSON.stringify(entry) + '\n';
    try {
        if (level === 'error' || level === 'fatal') {
            fs.appendFileSync(ERR_LOG_FILE, line, 'utf8');
        }
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (err) {
        // Don't let file write failures crash the logger
        console.error('[Logger] Failed to write to file:', err.message);
    }
}

// ─── Logger Factory ──────────────────────────────────────────────────────────

function createLogger(name) {
    const requestId = crypto.randomBytes(8).toString('hex');

    function log(level, arg1, arg2) {
        if (!shouldLog(level)) return;

        let msg, meta;
        if (typeof arg1 === 'object' && arg1 !== null) {
            // Called as: logger.info({ component: 'x' }, 'message')
            meta = { ...arg1 };
            msg = arg2 || meta.message || '';
        } else {
            // Called as: logger.info('message')
            msg = arg1 || '';
            meta = arg2 || {};
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${level.toUpperCase()}] [${name}]`;
        const entry = {
            timestamp,
            level,
            component: name,
            message: msg,
            ...meta,
        };

        // Console output
        if (isProduction) {
            // Production: JSON for log aggregation
            console.log(JSON.stringify(entry));
        } else if (level === 'error' || level === 'fatal') {
            console.error(`${prefix} ${msg}`, JSON.stringify(entry, null, 2));
        } else if (level === 'warn') {
            console.warn(`${prefix} ${msg}`, JSON.stringify(entry));
        } else {
            console.log(`${prefix} ${msg}`);
        }

        // File output (always, for production logging)
        writeToFile(entry, level);
    }

    return {
        debug: (msg, meta) => log('debug', msg, meta),
        info: (msg, meta) => log('info', msg, meta),
        warn: (msg, meta) => log('warn', msg, meta),
        error: (msg, meta) => log('error', msg, meta),
        fatal: (msg, meta) => log('fatal', msg, meta),
        child: (bindings) => createLogger(name ? `${name}:${JSON.stringify(bindings)}` : JSON.stringify(bindings)),
        withRequest: (req, extraBindings = {}) => {
            const rid = req?.requestId || crypto.randomBytes(8).toString('hex');
            return createLogger(`${name}:${rid}`);
        },
        generateRequestId: () => crypto.randomBytes(8).toString('hex'),
    };
}

// ─── Default Instance ────────────────────────────────────────────────────────

const defaultLogger = createLogger('aircommit');

export default defaultLogger;
export { createLogger };