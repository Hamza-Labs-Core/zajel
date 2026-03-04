/**
 * IP Reputation Manager
 *
 * Tracks IP behavior across time using Cloudflare's Cache API for
 * cross-isolate persistence. Implements progressive rate limiting
 * based on accumulated reputation score.
 */

/**
 * Reputation scoring rules:
 * - Rate limit hit: +2 points
 * - Connection rejected: +3 points
 * - Invalid request (malformed JSON, NaN, expired nonce): +5 points
 * - Successful attestation: -1 point (good behavior credit)
 *
 * Score tiers:
 * - 0-5: Normal rate limits
 * - 5-15: Reduced limits (50% of normal)
 * - 15-30: Heavily restricted (10% of normal)
 * - 30+: Temporary block (5 minutes)
 */

const SCORE_DECAY_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in ms
const SCORE_DECAY_FACTOR = 0.5; // Halve the score every 24 hours
const REPUTATION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export class IPReputationManager {
  constructor(cacheApi) {
    this.cache = cacheApi;
    this.localScores = new Map(); // Hot cache for current isolate
  }

  /**
   * Get the current reputation score for an IP address.
   * Checks local cache first, then Cache API.
   *
   * @param {string} ip - IP address
   * @returns {Promise<number>} Current reputation score (0 = clean)
   */
  async getScore(ip) {
    // Check local cache
    const localEntry = this.localScores.get(ip);
    if (localEntry) {
      // Apply time-based decay
      const decayedScore = this._applyDecay(localEntry.score, localEntry.updatedAt);
      if (decayedScore !== localEntry.score) {
        localEntry.score = decayedScore;
        localEntry.updatedAt = Date.now();
      }
      return decayedScore;
    }

    // Check Cache API
    const cacheKey = new Request(`https://reputation.internal/${ip}`);
    const cached = await this.cache.match(cacheKey);
    if (cached) {
      const data = await cached.json();
      const decayedScore = this._applyDecay(data.score, data.updatedAt);

      // Update local cache
      this.localScores.set(ip, {
        score: decayedScore,
        updatedAt: Date.now(),
      });
      return decayedScore;
    }

    // New IP - no reputation data
    return 0;
  }

  /**
   * Increment reputation score for an IP address.
   *
   * Note on Cache API `max-age` semantics: The CF Cache API `max-age` counts
   * from the time the response was **stored** (i.e., each `cache.put()`), not
   * from the last access. Because `incrementScore` calls `cache.put` with a
   * fresh `max-age` on every update, the TTL is effectively reset each time
   * the score changes. IPs that stop generating events will have their cache
   * entries naturally expire after `REPUTATION_TTL` seconds of inactivity.
   *
   * @param {string} ip - IP address
   * @param {number} points - Points to add (positive = worse reputation)
   * @param {number} [ttlSeconds] - Cache TTL (default: 7 days)
   * @returns {Promise<number>} New score
   */
  async incrementScore(ip, points, ttlSeconds = REPUTATION_TTL) {
    const current = await this.getScore(ip);
    const newScore = Math.max(0, current + points); // Never go below 0
    const now = Date.now();

    // Update local cache
    this.localScores.set(ip, {
      score: newScore,
      updatedAt: now,
    });

    // Persist to Cache API (shared across isolates)
    const cacheKey = new Request(`https://reputation.internal/${ip}`);
    const response = new Response(
      JSON.stringify({
        score: newScore,
        updatedAt: now,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${ttlSeconds}`,
        },
      }
    );
    await this.cache.put(cacheKey, response);

    return newScore;
  }

  /**
   * Get rate limit tier based on reputation score.
   *
   * @param {number} score - Reputation score
   * @param {{limit: number, windowMs: number}} baseTier - Base rate limit config
   * @returns {{limit: number, windowMs: number, blocked: boolean}} Adjusted rate limit
   */
  getRateLimit(score, baseTier) {
    if (score >= 30) {
      // Temporary block: 0 requests allowed for 5 minutes
      return { limit: 0, windowMs: 300000, blocked: true };
    }
    if (score >= 15) {
      // Heavily restricted: 10% of normal
      return {
        limit: Math.max(1, Math.floor(baseTier.limit * 0.1)),
        windowMs: baseTier.windowMs,
        blocked: false,
      };
    }
    if (score >= 5) {
      // Reduced limits: 50% of normal (min 1 to avoid accidental zero-limit blocking)
      return {
        limit: Math.max(1, Math.floor(baseTier.limit * 0.5)),
        windowMs: baseTier.windowMs,
        blocked: false,
      };
    }
    // Normal limits
    return { ...baseTier, blocked: false };
  }

  /**
   * Apply time-based decay to a score.
   * Score halves every 24 hours without new events.
   *
   * @private
   * @param {number} score - Current score
   * @param {number} updatedAt - Timestamp of last update (ms)
   * @returns {number} Decayed score
   */
  _applyDecay(score, updatedAt) {
    const now = Date.now();
    const elapsed = now - updatedAt;
    const decayPeriods = elapsed / SCORE_DECAY_INTERVAL;

    if (decayPeriods < 1) {
      // Less than 24 hours - no decay
      return score;
    }

    // Apply exponential decay: score * (0.5 ^ decayPeriods)
    const decayed = score * Math.pow(SCORE_DECAY_FACTOR, decayPeriods);
    return Math.max(0, Math.floor(decayed));
  }

  /**
   * Prune local cache to prevent unbounded memory growth.
   * Call periodically (e.g., every N requests).
   */
  pruneLocalCache() {
    // Keep only the most recent 1000 entries
    if (this.localScores.size > 1000) {
      const entries = Array.from(this.localScores.entries());
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      this.localScores = new Map(entries.slice(0, 1000));
    }
  }
}
