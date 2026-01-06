/**
 * RendezvousRegistry
 *
 * Manages meeting points and dead drops for peer discovery in Zajel.
 * Enables peers to find each other through:
 * - Daily meeting points with encrypted dead drop messages
 * - Hourly tokens for real-time peer matching
 */

export class RendezvousRegistry {
  constructor() {
    /** @type {Map<string, Array<DailyEntry>>} */
    this.dailyPoints = new Map();

    /** @type {Map<string, Array<HourlyEntry>>} */
    this.hourlyTokens = new Map();

    /** Time-to-live for daily points: 48 hours */
    this.DAILY_TTL = 48 * 60 * 60 * 1000;

    /** Time-to-live for hourly tokens: 3 hours */
    this.HOURLY_TTL = 3 * 60 * 60 * 1000;

    /** Callback for match notifications */
    this.onMatch = null;
  }

  /**
   * Register daily meeting points with a dead drop message
   * @param {string} peerId - Registering peer's ID
   * @param {Object} options - Registration options
   * @param {string[]} options.points - Array of daily meeting point hashes
   * @param {string} options.deadDrop - Encrypted dead drop payload
   * @param {string} options.relayId - Relay ID for reaching this peer
   * @returns {{deadDrops: Array<DeadDropResult>}} Found dead drops from other peers
   */
  registerDailyPoints(peerId, { points, deadDrop, relayId }) {
    const now = Date.now();
    const result = { deadDrops: [] };

    for (const point of points) {
      if (!this.dailyPoints.has(point)) {
        this.dailyPoints.set(point, []);
      }

      const entries = this.dailyPoints.get(point);

      // Find existing dead drops (not our own, not expired)
      for (const entry of entries) {
        if (entry.peerId !== peerId && entry.deadDrop && entry.expires > now) {
          result.deadDrops.push({
            peerId: entry.peerId,
            deadDrop: entry.deadDrop,
            relayId: entry.relayId,
          });
        }
      }

      // Remove old entry from same peer
      const filtered = entries.filter(e => e.peerId !== peerId);

      // Add new entry
      filtered.push({
        peerId,
        deadDrop,
        relayId,
        expires: now + this.DAILY_TTL,
      });

      this.dailyPoints.set(point, filtered);
    }

    return result;
  }

  /**
   * Register hourly tokens for live peer matching
   * @param {string} peerId - Registering peer's ID
   * @param {Object} options - Registration options
   * @param {string[]} options.tokens - Array of hourly token hashes
   * @param {string} options.relayId - Relay ID for reaching this peer
   * @returns {{liveMatches: Array<LiveMatchResult>}} Found live matches
   */
  registerHourlyTokens(peerId, { tokens, relayId }) {
    const now = Date.now();
    const result = { liveMatches: [] };

    for (const token of tokens) {
      if (!this.hourlyTokens.has(token)) {
        this.hourlyTokens.set(token, []);
      }

      const entries = this.hourlyTokens.get(token);

      // Find live matches (not our own, not expired)
      for (const entry of entries) {
        if (entry.peerId !== peerId && entry.expires > now) {
          result.liveMatches.push({
            peerId: entry.peerId,
            relayId: entry.relayId,
          });

          // Notify the other peer about this new match
          if (this.onMatch) {
            this.onMatch(entry.peerId, { peerId, relayId });
          }
        }
      }

      // Remove old entry from same peer
      const filtered = entries.filter(e => e.peerId !== peerId);

      // Add new entry
      filtered.push({
        peerId,
        relayId,
        expires: now + this.HOURLY_TTL,
      });

      this.hourlyTokens.set(token, filtered);
    }

    return result;
  }

  /**
   * Get entries at a daily meeting point
   * @param {string} point - Meeting point hash
   * @returns {Array<DailyEntry>} Active entries at this point
   */
  getDailyPoint(point) {
    const entries = this.dailyPoints.get(point) || [];
    const now = Date.now();
    return entries.filter(e => e.expires > now);
  }

  /**
   * Clean up expired entries from all maps
   */
  cleanup() {
    const now = Date.now();

    // Clean daily points
    for (const [point, entries] of this.dailyPoints) {
      const valid = entries.filter(e => e.expires > now);
      if (valid.length === 0) {
        this.dailyPoints.delete(point);
      } else {
        this.dailyPoints.set(point, valid);
      }
    }

    // Clean hourly tokens
    for (const [token, entries] of this.hourlyTokens) {
      const valid = entries.filter(e => e.expires > now);
      if (valid.length === 0) {
        this.hourlyTokens.delete(token);
      } else {
        this.hourlyTokens.set(token, valid);
      }
    }
  }

  /**
   * Unregister a peer from all meeting points and tokens
   * @param {string} peerId - Peer ID to remove
   */
  unregisterPeer(peerId) {
    // Remove from daily points
    for (const [point, entries] of this.dailyPoints) {
      const filtered = entries.filter(e => e.peerId !== peerId);
      if (filtered.length === 0) {
        this.dailyPoints.delete(point);
      } else {
        this.dailyPoints.set(point, filtered);
      }
    }

    // Remove from hourly tokens
    for (const [token, entries] of this.hourlyTokens) {
      const filtered = entries.filter(e => e.peerId !== peerId);
      if (filtered.length === 0) {
        this.hourlyTokens.delete(token);
      } else {
        this.hourlyTokens.set(token, filtered);
      }
    }
  }

  /**
   * Get registry statistics
   * @returns {Object} Statistics about the registry
   */
  getStats() {
    let totalDailyEntries = 0;
    let totalHourlyEntries = 0;

    for (const entries of this.dailyPoints.values()) {
      totalDailyEntries += entries.length;
    }

    for (const entries of this.hourlyTokens.values()) {
      totalHourlyEntries += entries.length;
    }

    return {
      dailyPoints: this.dailyPoints.size,
      hourlyTokens: this.hourlyTokens.size,
      totalEntries: totalDailyEntries + totalHourlyEntries,
      dailyEntries: totalDailyEntries,
      hourlyEntries: totalHourlyEntries,
    };
  }
}

/**
 * @typedef {Object} DailyEntry
 * @property {string} peerId - Peer identifier
 * @property {string} deadDrop - Encrypted dead drop payload
 * @property {string} relayId - Relay ID for reaching this peer
 * @property {number} expires - Unix timestamp when this entry expires
 */

/**
 * @typedef {Object} HourlyEntry
 * @property {string} peerId - Peer identifier
 * @property {string} relayId - Relay ID for reaching this peer
 * @property {number} expires - Unix timestamp when this entry expires
 */

/**
 * @typedef {Object} DeadDropResult
 * @property {string} peerId - Peer who left the dead drop
 * @property {string} deadDrop - Encrypted dead drop payload
 * @property {string} relayId - Relay ID for reaching the peer
 */

/**
 * @typedef {Object} LiveMatchResult
 * @property {string} peerId - Matched peer ID
 * @property {string} relayId - Relay ID for reaching the peer
 */
