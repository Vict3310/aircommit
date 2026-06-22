/**
 * Simple Structured Logger for AirCommit
 * Uses console.log with structured output (pino removed due to compatibility)
 */

import crypto from 'crypto';

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

function shouldLog(level) {
    return LEVELS[level] >= LEVELS[logLevel];
}

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

        if (level === 'error' || level === 'fatal') {
            console.error(`${prefix} ${msg}`, JSON.stringify(entry));
        } else if (level === 'warn') {
            console.warn(`${prefix} ${msg}`, JSON.stringify(entry));
        } else {
            console.log(`${prefix} ${msg}`);
        }
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

// Default instance
const defaultLogger = createLogger('aircommit');

export default defaultLogger;
export { createLogger };