/**
 * Simple in-memory sliding window rate limiter for Cloudflare Workers.
 *
 * Uses a Map with composite keys (e.g., "ip:tier") and {count, resetAt} values.
 * Counters are lost if the Worker isolate is evicted; this is
 * acceptable as a best-effort defense layer.
 * Deterministic pruning runs every 100 requests to bound memory usage.
 */

export class RateLimiter {
  constructor() {
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.counters = new Map();
    /** @type {number} Request counter for deterministic pruning */
    this.requestCount = 0;
  }

  /**
   * Check whether a request from the given key is within the rate limit.
   *
   * @param {string} key - Composite key (e.g., "ip:tier" or "serverId:operation")
   * @param {number} limit - Maximum requests per window
   * @param {number} windowMs - Window duration in milliseconds
   * @returns {{ allowed: boolean, remaining: number, retryAfter: number }}
   */
  check(key, limit, windowMs) {
    const now = Date.now();
    const entry = this.counters.get(key);

    // Deterministic pruning: every 100 requests
    this.requestCount += 1;
    if (this.requestCount % 100 === 0) {
      this.prune();
    }

    if (!entry || now >= entry.resetAt) {
      // Start a new window
      this.counters.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfter: 0 };
    }

    entry.count += 1;

    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

    if (entry.count > limit) {
      return { allowed: false, remaining: 0, retryAfter };
    }

    return { allowed: true, remaining: limit - entry.count, retryAfter };
  }

  /**
   * Prune expired entries to prevent unbounded memory growth.
   * Called deterministically every 100 requests (see check() method).
   */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.counters) {
      if (now >= entry.resetAt) {
        this.counters.delete(key);
      }
    }
  }

  /**
   * Get all counters (for testing purposes only).
   * @returns {Map<string, {count: number, resetAt: number}>}
   */
  getCounters() {
    return this.counters;
  }
}

/** Singleton rate limiter instance for the Worker isolate */
export const rateLimiter = new RateLimiter();
