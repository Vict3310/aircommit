/**
 * Pending Actions Manager
 *
 * Stores user-initiated GitHub actions (patches, builds, file creates)
 * that require explicit approve/reject before execution.
 *
 * Each entry has a 5-minute TTL. Expired entries are cleaned up on access
 * and periodically by a background interval.
 */

const ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cleanupIntervalMs = 5 * 60 * 1000; // Run cleanup every 5 minutes

export const pendingActions = new Map();

/**
 * Generates a unique action ID (8-char alphanumeric)
 */
export function generateActionId() {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Set a pending action with an expiration timestamp
 */
export function setPendingAction(actionId, data) {
  const entry = {
    ...data,
    createdAt: Date.now(),
    expiresAt: Date.now() + ACTION_TTL_MS
  };
  pendingActions.set(actionId, entry);
  return entry;
}

/**
 * Get a pending action, returning null if expired or missing
 */
export function getPendingAction(actionId) {
  const entry = pendingActions.get(actionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingActions.delete(actionId);
    return null;
  }
  return entry;
}

/**
 * Delete a pending action (called on approve/reject)
 */
export function deletePendingAction(actionId) {
  return pendingActions.delete(actionId);
}

/**
 * Clean up expired entries. Safe to call manually or run periodically.
 */
export function cleanupExpiredActions() {
  const now = Date.now();
  for (const [id, entry] of pendingActions.entries()) {
    if (now > entry.expiresAt) {
      pendingActions.delete(id);
    }
  }
}

// Auto-cleanup every 5 minutes
const _cleanupTimer = setInterval(cleanupExpiredActions, cleanupIntervalMs);
if (_cleanupTimer.unref) _cleanupTimer.unref();
