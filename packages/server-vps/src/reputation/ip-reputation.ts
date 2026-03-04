/**
 * VPS IP Reputation Manager
 *
 * Manages IP reputation scores with persistent SQLite storage.
 * Integrates with the client handler to track behavioral events.
 */

import type { Storage, IPReputationEntry } from '../storage/interface.js';

export interface ReputationTier {
  limit: number;
  windowMs: number;
  blocked: boolean;
}

export class VPSReputationManager {
  constructor(private storage: Storage) {}

  /**
   * Record a reputation event for an IP address.
   *
   * @param ip - IP address
   * @param eventType - Type of event
   * @param metadata - Optional additional context
   * @returns New reputation score
   */
  async recordEvent(
    ip: string,
    eventType: 'rate_limit_hit' | 'connection_rejected' | 'invalid_request' | 'successful_attestation',
    metadata?: Record<string, unknown>
  ): Promise<number> {
    const pointsMap = {
      rate_limit_hit: 2,
      connection_rejected: 3,
      invalid_request: 5,
      successful_attestation: -1,
    };

    const points = pointsMap[eventType];
    return await this.storage.incrementReputation(ip, points, eventType, metadata);
  }

  /**
   * Get reputation score for an IP address with time-based decay.
   *
   * Decay schedule based on hours since last update:
   * - < 24h: no decay
   * - >= 24h: score * 0.5 (halved)
   * - >= 48h: score * 0.25 (quartered)
   *
   * Returns 0 if no record exists.
   */
  async getScore(ip: string): Promise<number> {
    const entry = await this.storage.getReputation(ip);
    if (!entry) return 0;

    const rawScore = entry.reputationScore;
    const ageMs = Date.now() - entry.lastUpdated;
    const hours = ageMs / (60 * 60 * 1000);

    if (hours >= 48) {
      return Math.floor(rawScore * 0.25);
    }
    if (hours >= 24) {
      return Math.floor(rawScore * 0.5);
    }
    return rawScore;
  }

  /**
   * Get full reputation entry for an IP address.
   */
  async getEntry(ip: string): Promise<IPReputationEntry | null> {
    return await this.storage.getReputation(ip);
  }

  /**
   * Calculate rate limit tier based on reputation score.
   *
   * Score tiers:
   * - 0-5: Normal
   * - 5-15: Reduced (50%)
   * - 15-30: Heavily restricted (10%)
   * - 30+: Blocked
   */
  getRateLimitTier(score: number, baseLimit: number, windowMs: number): ReputationTier {
    if (score >= 30) {
      return { limit: 0, windowMs: 300000, blocked: true }; // Blocked for 5 minutes
    }
    if (score >= 15) {
      return {
        limit: Math.max(1, Math.floor(baseLimit * 0.1)),
        windowMs,
        blocked: false,
      };
    }
    if (score >= 5) {
      return {
        limit: Math.max(1, Math.floor(baseLimit * 0.5)),
        windowMs,
        blocked: false,
      };
    }
    return { limit: baseLimit, windowMs, blocked: false };
  }

  /**
   * Check if an IP should be blocked based on reputation.
   */
  async isBlocked(ip: string): Promise<boolean> {
    const score = await this.getScore(ip);
    return score >= 30;
  }

  /**
   * Get top offending IPs for admin dashboard.
   */
  async getTopOffenders(limit = 100): Promise<IPReputationEntry[]> {
    return await this.storage.getTopOffenders(limit);
  }

  /**
   * Clean up old reputation event logs (keep last 30 days).
   */
  async cleanupOldEvents(): Promise<number> {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    return await this.storage.cleanupOldReputationEvents(thirtyDaysMs);
  }

  /**
   * Reset reputation score to 0 (admin override for false positive recovery).
   */
  async resetScore(ip: string): Promise<void> {
    await this.storage.setReputation(ip, 0);
  }

  /**
   * Set reputation score to a specific value (admin override).
   */
  async setScore(ip: string, score: number): Promise<void> {
    await this.storage.setReputation(ip, Math.max(0, score));
  }
}
