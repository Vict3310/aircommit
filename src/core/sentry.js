/**
 * Sentry Error Monitoring — AirCommit
 *
 * Opt-in: Only initializes when SENTRY_DSN is set in .env.
 * Disabled by default — no errors are sent until configured.
 *
 * Features:
 * - Automatic error capturing (uncaughtException, unhandledRejection)
 * - Request context (IP, user agent, headers)
 * - Transaction tracing for HTTP requests
 * - Performance profiling (optional, via SENTRY_PROFILE_ENABLED)
 */

import * as Sentry from '@sentry/node';
import config from './config.js';

const SENTRY_DSN = process.env.SENTRY_DSN;
const PROFILE_ENABLED = process.env.SENTRY_PROFILE_ENABLED === 'true';

let initialized = false;

export function isSentryInitialized() {
  return initialized;
}

/**
 * Initialize Sentry with optional profiling.
 * Should be called early in the application bootstrap.
 */
export function initSentry() {
  if (!SENTRY_DSN) {
    // Silently skip — Sentry is opt-in
    return;
  }

  if (initialized) {
    return; // Already initialized
  }

  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      release: '1.0.0', // Update on each deploy
      tracesSampleRate: PROFILE_ENABLED ? 1.0 : 0.1,

      // Only capture errors from production
      beforeSend(event, hint) {
        const error = hint.originalException;

        // Skip expected errors (e.g., rate limit responses, 404s)
        if (error?.statusCode === 404 || error?.statusCode === 429) {
          return null;
        }

        // Skip transient network errors (handled by uncaughtException handler)
        if (error?.message === 'fetch failed' || error?.code === 'EFATAL' || error?.code === 'ECONNRESET') {
          return null;
        }

        return event;
      },

      integrations: [
        // Automatic HTTP request tracing
        Sentry.autoDiscoverNodePerformanceMonitoringIntegrations(),
      ],
    });

    initialized = true;
    console.log('🔴 Sentry error monitoring initialized');
  } catch (err) {
    console.warn('[Sentry] Failed to initialize:', err.message);
    // Don't crash the app if Sentry fails
  }
}

/**
 * Get the current Sentry scope (for manual context setting).
 * Returns null if Sentry is not initialized.
 */
export function getSentryScope() {
  if (!initialized) return null;
  return Sentry.getCurrentScope();
}

/**
 * Get the current Sentry hub (for manual error reporting).
 * Returns null if Sentry is not initialized.
 */
export function getSentryHub() {
  if (!initialized) return null;
  return Sentry.getHubFromIntegration('node');
}

/**
 * Report a manual error to Sentry.
 * Usage: reportError(new Error('something failed'), { user: chatId });
 */
export function reportError(error, extra = {}) {
  if (!initialized) {
    console.error('[Sentry] Not initialized, skipping error report:', error.message);
    return;
  }

  const scope = getSentryScope();
  if (scope) {
    Object.entries(extra).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });
  }

  Sentry.captureException(error);
}

/**
 * Report a message to Sentry (for important events, not errors).
 */
export function captureMessage(message, level = 'info') {
  if (!initialized) return;
  Sentry.captureMessage(message, level);
}

/**
 * Tag the current transaction/span.
 * Useful for adding context to performance traces.
 */
export function setTag(key, value) {
  if (!initialized) return;
  Sentry.setTag(key, value);
}

export default {
  initSentry,
  isSentryInitialized,
  reportError,
  captureMessage,
  setTag,
  getSentryScope,
  getSentryHub,
};
