/**
 * Dual-tier rate limiter for CRP Worker endpoints.
 *
 * Distinguishes between:
 * - Public IP-based rate limits (/send, /tester-check)
 * - Per-User / UID-based rate limits (/feedback, /tester-me)
 *
 * Uses a memory store with sliding window tracking and automatic cleanup.
 */

export const RATE_LIMITS = {
  "/send": { max: 5, windowMs: 10 * 60 * 1000 }, // 5 reqs per 10 mins per IP
  "/tester-check": { max: 10, windowMs: 15 * 60 * 1000 }, // 10 reqs per 15 mins per IP
  "/feedback": { max: 10, windowMs: 60 * 60 * 1000 }, // 10 submissions per hour per UID
  "/tester-me": { max: 60, windowMs: 60 * 1000 }, // 60 requests per minute per UID
};

const memoryStore = new Map();

/** For tests: reset in-memory rate limit store */
export function _resetRateLimits() {
  memoryStore.clear();
}

/**
 * Checks if a request exceeds rate limits.
 *
 * @param {string} route
 * @param {string} key (IP address or UID)
 * @param {object} [env]
 * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterSeconds: number }>}
 */
export async function checkRateLimit(route, key, env = {}) {
  // Rate limiting is active when RATE_LIMITING="true" or TEST_RATE_LIMITING is set
  if (env.RATE_LIMITING !== "true" && !env.TEST_RATE_LIMITING) {
    return { allowed: true, remaining: Infinity, retryAfterSeconds: 0 };
  }

  const config = RATE_LIMITS[route];
  if (!config) return { allowed: true, remaining: Infinity, retryAfterSeconds: 0 };

  const storageKey = `rl:${route}:${key}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  let timestamps = memoryStore.get(storageKey) || [];
  timestamps = timestamps.filter((t) => t > windowStart);

  if (timestamps.length >= config.max) {
    const oldest = timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + config.windowMs - now) / 1000));
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
    };
  }

  timestamps.push(now);
  memoryStore.set(storageKey, timestamps);

  // Periodic garbage collection if store gets large
  if (memoryStore.size > 10000) {
    for (const [k, ts] of memoryStore.entries()) {
      if (!ts.length || ts[ts.length - 1] < now - 3600000) {
        memoryStore.delete(k);
      }
    }
  }

  return {
    allowed: true,
    remaining: config.max - timestamps.length,
    retryAfterSeconds: 0,
  };
}

/** Extract client IP from Worker request headers */
export function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "127.0.0.1"
  );
}
