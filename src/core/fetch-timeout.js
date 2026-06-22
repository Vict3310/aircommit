/**
 * Timeout-safe fetch wrapper.
 * Wraps every external HTTP request in AbortSignal.timeout() so
 * hanging upstream APIs (OpenRouter, GitHub, npm registry, 0G) cannot
 * tie up event-loop threads forever.
 *
 * @param {string} url - URL to fetch
 * @param {RequestInit} [init={}] - fetch options
 * @param {number} [timeoutMs=10000] - timeout in ms (default 10s)
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const signal = init.signal || controller.signal;
    const response = await fetch(url, { ...init, signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}
