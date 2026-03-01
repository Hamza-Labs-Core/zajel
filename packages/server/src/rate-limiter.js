/**
 * Simple in-memory sliding window rate limiter for Cloudflare Workers.
 *
 * Uses a Map with IP keys and {count, resetAt} values.
 * Counters are lost if the Worker isolate is evicted; this is
 * acceptable as a best-effort defense layer.
 */

export class RateLimiter {
  constructor() {
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.counters = new Map();
  }

  /**
   * Check whether a request from the given IP is within the rate limit.
   *
   * @param {string} ip - Client IP address
   * @param {number} limit - Maximum requests per window
   * @param {number} windowMs - Window duration in milliseconds
   * @returns {{ allowed: boolean, remaining: number }}
   */
  check(ip, limit, windowMs) {
    const now = Date.now();
    const entry = this.counters.get(ip);

    if (!entry || now >= entry.resetAt) {
      // Start a new window
      this.counters.set(ip, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1 };
    }

    entry.count += 1;

    if (entry.count > limit) {
      return { allowed: false, remaining: 0 };
    }

    return { allowed: true, remaining: limit - entry.count };
  }

  /**
   * Prune expired entries to prevent unbounded memory growth.
   * Called periodically (e.g., every N requests).
   */
  prune() {
    const now = Date.now();
    for (const [ip, entry] of this.counters) {
      if (now >= entry.resetAt) {
        this.counters.delete(ip);
      }
    }
  }
}

/** Singleton rate limiter instance for the Worker isolate */
export const rateLimiter = new RateLimiter();
