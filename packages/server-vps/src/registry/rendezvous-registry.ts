/**
 * Rendezvous Registry
 *
 * Manages meeting points and dead drops for peer discovery.
 * Uses SQLite storage for persistence across server restarts.
 *
 * Enables peers to find each other through:
 * - Daily meeting points with encrypted dead drop messages
 * - Hourly tokens for real-time peer matching
 */

import { EventEmitter } from 'events';
import type { Storage } from '../storage/interface.js';
import type { DailyPointEntry, HourlyTokenEntry, VectorClock } from '../types.js';

export interface DeadDropResult {
  peerId: string;
  deadDrop: string;
  relayId: string;
}

export interface LiveMatchResult {
  peerId: string;
  relayId: string;
}

export interface RendezvousRegistryConfig {
  dailyTtl: number;   // TTL for daily points in ms (default: 48 hours)
  hourlyTtl: number;  // TTL for hourly tokens in ms (default: 3 hours)
}

export interface RendezvousRegistryEvents {
  'match': (peerId: string, match: LiveMatchResult) => void;
  'daily-registered': (peerId: string, pointCount: number) => void;
  'hourly-registered': (peerId: string, tokenCount: number) => void;
}

const DEFAULT_CONFIG: RendezvousRegistryConfig = {
  dailyTtl: 48 * 60 * 60 * 1000,  // 48 hours
  hourlyTtl: 3 * 60 * 60 * 1000,  // 3 hours
};

export class RendezvousRegistry extends EventEmitter {
  private storage: Storage;
  private config: RendezvousRegistryConfig;

  // In-memory cache for active hourly tokens (for fast matching)
  private hourlyCache: Map<string, HourlyTokenEntry[]> = new Map();

  constructor(storage: Storage, config: Partial<RendezvousRegistryConfig> = {}) {
    super();
    this.storage = storage;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register daily meeting points with a dead drop message
   * @returns Found dead drops from other peers at these points
   */
  async registerDailyPoints(
    peerId: string,
    options: { points: string[]; deadDrop: string; relayId: string }
  ): Promise<{ deadDrops: DeadDropResult[] }> {
    const { points, deadDrop, relayId } = options;
    const now = Date.now();
    const expiresAt = now + this.config.dailyTtl;
    const result: { deadDrops: DeadDropResult[] } = { deadDrops: [] };

    for (const pointHash of points) {
      // Get existing entries at this point
      const entries = await this.storage.getDailyPoints(pointHash);

      // Collect dead drops from other peers
      for (const entry of entries) {
        if (entry.peerId !== peerId && entry.deadDrop && entry.expiresAt > now) {
          result.deadDrops.push({
            peerId: entry.peerId,
            deadDrop: entry.deadDrop,
            relayId: entry.relayId || '',
          });
        }
      }

      // Save our entry (storage handles upsert)
      await this.storage.saveDailyPoint({
        pointHash,
        peerId,
        deadDrop,
        relayId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
        vectorClock: {},
      });
    }

    this.emit('daily-registered', peerId, points.length);
    return result;
  }

  /**
   * Register hourly tokens for live peer matching
   * @returns Found live matches at these tokens
   */
  async registerHourlyTokens(
    peerId: string,
    options: { tokens: string[]; relayId: string }
  ): Promise<{ liveMatches: LiveMatchResult[] }> {
    const { tokens, relayId } = options;
    const now = Date.now();
    const expiresAt = now + this.config.hourlyTtl;
    const result: { liveMatches: LiveMatchResult[] } = { liveMatches: [] };

    for (const tokenHash of tokens) {
      // Get existing entries at this token
      const entries = await this.storage.getHourlyTokens(tokenHash);

      // Find live matches
      for (const entry of entries) {
        if (entry.peerId !== peerId && entry.expiresAt > now) {
          const match: LiveMatchResult = {
            peerId: entry.peerId,
            relayId: entry.relayId || '',
          };
          result.liveMatches.push(match);

          // Notify the other peer about this new match
          this.emit('match', entry.peerId, { peerId, relayId });
        }
      }

      // Save our entry
      const hourlyEntry: HourlyTokenEntry = {
        tokenHash,
        peerId,
        relayId,
        expiresAt,
        createdAt: now,
        vectorClock: {},
      };
      await this.storage.saveHourlyToken(hourlyEntry);

      // Update cache
      this.updateHourlyCache(tokenHash, hourlyEntry);
    }

    this.emit('hourly-registered', peerId, tokens.length);
    return result;
  }

  /**
   * Get entries at a daily meeting point
   */
  async getDailyPoint(point: string): Promise<DailyPointEntry[]> {
    const entries = await this.storage.getDailyPoints(point);
    const now = Date.now();
    return entries.filter(e => e.expiresAt > now);
  }

  /**
   * Get entries at an hourly token
   */
  async getHourlyToken(token: string): Promise<HourlyTokenEntry[]> {
    const entries = await this.storage.getHourlyTokens(token);
    const now = Date.now();
    return entries.filter(e => e.expiresAt > now);
  }

  /**
   * Unregister a peer from all meeting points and tokens
   */
  async unregisterPeer(peerId: string): Promise<void> {
    await this.storage.deleteDailyPointsByPeer(peerId);
    await this.storage.deleteHourlyTokensByPeer(peerId);

    // Clear from cache
    for (const [token, entries] of this.hourlyCache) {
      const filtered = entries.filter(e => e.peerId !== peerId);
      if (filtered.length === 0) {
        this.hourlyCache.delete(token);
      } else {
        this.hourlyCache.set(token, filtered);
      }
    }
  }

  /**
   * Clean up expired entries
   */
  async cleanup(): Promise<{ dailyRemoved: number; hourlyRemoved: number }> {
    const now = Date.now();

    const dailyRemoved = await this.storage.deleteExpiredDailyPoints(now);
    const hourlyRemoved = await this.storage.deleteExpiredHourlyTokens(now);

    // Clean cache
    for (const [token, entries] of this.hourlyCache) {
      const valid = entries.filter(e => e.expiresAt > now);
      if (valid.length === 0) {
        this.hourlyCache.delete(token);
      } else {
        this.hourlyCache.set(token, valid);
      }
    }

    return { dailyRemoved, hourlyRemoved };
  }

  /**
   * Get registry statistics
   */
  async getStats(): Promise<{
    dailyPoints: number;
    hourlyTokens: number;
    cachedHourlyTokens: number;
  }> {
    // This could be optimized with COUNT queries
    const dailyStats = await this.storage.getDailyPointStats();
    const hourlyStats = await this.storage.getHourlyTokenStats();

    return {
      dailyPoints: dailyStats.totalEntries,
      hourlyTokens: hourlyStats.totalEntries,
      cachedHourlyTokens: this.hourlyCache.size,
    };
  }

  /**
   * Update the in-memory hourly cache
   */
  private updateHourlyCache(tokenHash: string, entry: HourlyTokenEntry): void {
    if (!this.hourlyCache.has(tokenHash)) {
      this.hourlyCache.set(tokenHash, []);
    }

    const entries = this.hourlyCache.get(tokenHash)!;

    // Remove old entry from same peer
    const filtered = entries.filter(e => e.peerId !== entry.peerId);
    filtered.push(entry);

    this.hourlyCache.set(tokenHash, filtered);
  }

  /**
   * Warm up the hourly cache from storage
   * Call this on startup to restore recent tokens
   */
  async warmupCache(): Promise<void> {
    const now = Date.now();
    const recentThreshold = now - this.config.hourlyTtl;

    // Get all non-expired hourly tokens
    // This would need a new storage method to be efficient
    // For now, we just start with an empty cache and build it up
    this.hourlyCache.clear();
  }
}
