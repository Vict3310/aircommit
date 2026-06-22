/**
 * WebSocket service for real-time status updates
 * Uses Express WebSocket for client-side updates
 */

import { WebSocketServer } from 'ws';
import { WebSocket } from 'ws';
import http from 'http';
import config from '../core/config.js';

let wss = null;
let server = null;

// ─── Security Constants ──────────────────────────────────────────────────────

const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message
const MAX_QUEUE_SIZE = 100; // Max queued updates per chat
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 5000; // 5 seconds tolerance

// Allowed WebSocket origins (same as CORS)
const ALLOWED_WS_ORIGINS = [
  config.baseUrl,
  'https://telegram.me',
  'https://web.telegram.org',
  'https://web.telegram.org/a/',
  'https://web.telegram.org/k/'
].filter(Boolean);

// ─── Status Update Queue ──────────────────────────────────────────────────────

const statusQueues = new Map(); // chatId → array of status updates

/**
 * Validates WebSocket origin
 */
function validateWebSocketOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Same-origin allowed
  return ALLOWED_WS_ORIGINS.includes(origin);
}

/**
 * Validates chat ID format
 */
function validateChatIdFormat(chatId) {
  if (!chatId || typeof chatId !== 'string') return false;
  // Telegram chat IDs are numeric (positive for users, negative for groups)
  return /^-?\d+$/.test(chatId);
}

/**
 * Initialize WebSocket server
 */
export function initWebSocket(httpServer) {
  server = httpServer;

  wss = new WebSocketServer({
    noServer: true,
    maxPayload: 0 // Disable payload limit for now (controlled per-message)
  });

  wss.on('connection', (ws, req) => {
    // ─── Origin Validation ──────────────────────────────────────────────
    if (!validateWebSocketOrigin(req)) {
      console.warn('[WebSocket] Connection rejected: invalid origin');
      ws.close(1008, 'Origin not allowed');
      return;
    }

    // ─── Extract and validate chat ID ───────────────────────────────────
    const pathname = req.url?.split('?')[0] || '';
    const chatId = pathname.split('/status/').pop() || req.url?.split('/').pop();

    if (!chatId || chatId === '' || chatId === 'status') {
      ws.close(1008, 'No chat ID provided');
      return;
    }

    if (!validateChatIdFormat(chatId)) {
      console.warn('[WebSocket] Connection rejected: invalid chat ID format');
      ws.close(1008, 'Invalid chat ID');
      return;
    }

    console.log(`[WebSocket] Client connected for chat ${chatId}`);

    // ─── Message Handler with Size Limit ────────────────────────────────
    ws.setMaxListeners(MAX_MESSAGE_SIZE);

    ws.on('message', (message, isBinary) => {
      // Don't allow binary messages
      if (isBinary) {
        ws.close(1003, 'Binary messages not supported');
        return;
      }

      // Check message size
      if (message.length > MAX_MESSAGE_SIZE) {
        ws.close(1009, 'Message too large');
        return;
      }

      try {
        const data = JSON.parse(message.toString());

        // Only accept pong/heartbeat messages
        if (data.type === 'pong') {
          ws.isHeartbeat = Date.now();
        } else {
          ws.close(1003, 'Unexpected message type');
        }
      } catch (err) {
        ws.close(1003, 'Invalid JSON');
      }
    });

    ws.on('close', () => {
      console.log(`[WebSocket] Client disconnected for chat ${chatId}`);
      statusQueues.delete(chatId);
    });

    ws.on('error', (err) => {
      console.warn(`[WebSocket] Error for chat ${chatId}:`, err.message);
    });

    ws.isAlive = true;

    // Send queued status updates
    const queued = statusQueues.get(chatId) || [];
    queued.forEach(update => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(update));
      }
    });
  });

  // Heartbeat to keep connections alive
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log('[WebSocket] Terminating dead connection');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => {
    clearInterval(interval);
  });

  console.log('[WebSocket] Server initialized');
  return wss;
}

/**
 * upgrade HTTP request to WebSocket
 */
export function upgradeWebSocket(req, socket, head) {
  if (!wss) return;

  const pathname = req.url?.split('?')[0];
  if (pathname && pathname.startsWith('/status/')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
}

/**
 * Send status update to a specific chat
 */
export function sendStatusUpdate(chatId, status) {
  if (!wss) return false;

  // Validate chat ID format
  if (!validateChatIdFormat(String(chatId))) {
    console.warn('[WebSocket] Rejected: invalid chat ID format');
    return false;
  }

  // Sanitize status message
  const statusStr = typeof status === 'string' ? status : String(status);
  if (statusStr.length > 4000) {
    console.warn('[WebSocket] Status message truncated');
  }

  const statusData = {
    type: 'status',
    chatId: String(chatId),
    status: statusStr.substring(0, 4000),
    timestamp: Date.now(),
  };

  let sent = false;
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      const wsChatId = ws.url?.split('/').pop();
      if (wsChatId === String(chatId)) {
        try {
          ws.send(JSON.stringify(statusData));
          sent = true;
        } catch (err) {
          console.warn('[WebSocket] Send error:', err.message);
        }
      }
    }
  });

  // Queue for late joiners (with size limit)
  if (!sent) {
    if (!statusQueues.has(chatId)) {
      statusQueues.set(chatId, []);
    }
    const queue = statusQueues.get(chatId);
    if (queue.length < MAX_QUEUE_SIZE) {
      queue.push(statusData);
    } else {
      console.warn('[WebSocket] Queue full for chat', chatId);
    }
  }

  return sent;
}

/**
 * Close all WebSocket connections
 */
export function closeWebSocket() {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (server) {
    server = null;
  }
}

/**
 * Send status to bot (for backward compatibility with polling)
 */
export async function sendStatusToBot(bot, chatId, status) {
  try {
    // Try WebSocket first (real-time)
    if (sendStatusUpdate(chatId, status)) {
      return true;
    }

    // Fallback: store for client to poll
    await bot.sendChatAction(chatId, 'typing');
    return false;
  } catch (error) {
    console.warn('[WebSocket] Send error:', error.message);
    return false;
  }
}
