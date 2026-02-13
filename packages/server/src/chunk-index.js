/**
 * ChunkIndex
 *
 * Manages chunk availability tracking for the Zajel channel system.
 * Tracks which peers have which chunks and maintains a temporary cache
 * of chunk data with TTL-based cleanup.
 *
 * The chunk index is the server-side counterpart to the Flutter client's
 * channel chunk storage. It enables:
 * - Owners to announce their chunks to the server
 * - Subscribers to request chunks from the server
 * - Subscribers to re-announce chunks they've downloaded (swarm seeding)
 * - Server to cache frequently requested chunks temporarily
 */

export class ChunkIndex {
  constructor() {
    /**
     * Index of chunk sources: chunkId -> Array<ChunkSource>
     * Tracks which peers claim to have a given chunk.
     * @type {Map<string, Array<ChunkSource>>}
     */
    this.chunkSources = new Map();

    /**
     * Chunk data cache: chunkId -> CachedChunk
     * Temporary cache of actual chunk data for fast serving.
     * @type {Map<string, CachedChunk>}
     */
    this.chunkCache = new Map();

    /**
     * Pending requests: chunkId -> Array<PendingRequest>
     * Tracks subscribers waiting for a chunk that hasn't been cached yet.
     * Used for multicast optimization: pull once from source, serve many.
     * @type {Map<string, Array<PendingRequest>>}
     */
    this.pendingRequests = new Map();

    /** TTL for cached chunks: 30 minutes */
    this.CACHE_TTL = 30 * 60 * 1000;

    /** TTL for chunk source entries: 1 hour */
    this.SOURCE_TTL = 60 * 60 * 1000;

    /** Maximum cache size in entries (prevents unbounded memory growth) */
    this.MAX_CACHE_ENTRIES = 1000;

    /** Callback for notifying peers when a chunk becomes available */
    this.onChunkAvailable = null;
  }

  // ---------------------------------------------------------------------------
  // Chunk source registration (announce)
  // ---------------------------------------------------------------------------

  /**
   * Register a peer as a source for one or more chunks.
   * Called when a peer sends a chunk-announce message.
   *
   * @param {string} peerId - The peer announcing chunks
   * @param {Array<ChunkAnnouncement>} chunks - Chunk metadata to register
   * @returns {{registered: number}} Count of chunks registered
   */
  announceChunks(peerId, chunks) {
    const now = Date.now();
    let registered = 0;

    for (const chunk of chunks) {
      const { chunkId, routingHash } = chunk;

      if (!chunkId || !routingHash) continue;

      if (!this.chunkSources.has(chunkId)) {
        this.chunkSources.set(chunkId, []);
      }

      const sources = this.chunkSources.get(chunkId);

      // Remove existing entry from this peer (re-announce / refresh)
      const filtered = sources.filter(s => s.peerId !== peerId);

      filtered.push({
        peerId,
        routingHash,
        isCache: false,
        registeredAt: now,
        expires: now + this.SOURCE_TTL,
      });

      this.chunkSources.set(chunkId, filtered);
      registered++;
    }

    return { registered };
  }

  /**
   * Get all online sources for a chunk, excluding expired entries.
   *
   * @param {string} chunkId - The chunk to look up
   * @returns {Array<ChunkSource>} Active sources for the chunk
   */
  getChunkSources(chunkId) {
    const sources = this.chunkSources.get(chunkId) || [];
    const now = Date.now();
    return sources.filter(s => s.expires > now);
  }

  /**
   * Check if a chunk is available from any source (including cache).
   *
   * @param {string} chunkId - The chunk to check
   * @returns {boolean} Whether the chunk is available
   */
  isChunkAvailable(chunkId) {
    if (this.chunkCache.has(chunkId)) {
      const cached = this.chunkCache.get(chunkId);
      if (cached.expires > Date.now()) return true;
    }
    return this.getChunkSources(chunkId).length > 0;
  }

  // ---------------------------------------------------------------------------
  // Chunk cache management
  // ---------------------------------------------------------------------------

  /**
   * Store chunk data in the server cache.
   *
   * @param {string} chunkId - Chunk identifier
   * @param {Object} chunkData - Full chunk JSON data
   * @returns {boolean} Whether the chunk was cached (false if cache is full)
   */
  cacheChunk(chunkId, chunkData) {
    // Evict expired entries first
    this._evictExpiredCache();

    if (this.chunkCache.size >= this.MAX_CACHE_ENTRIES) {
      // Evict oldest entry
      this._evictOldestCacheEntry();
    }

    const now = Date.now();
    this.chunkCache.set(chunkId, {
      data: chunkData,
      cachedAt: now,
      expires: now + this.CACHE_TTL,
      accessCount: 0,
    });

    // Also register the server as a source for this chunk
    if (!this.chunkSources.has(chunkId)) {
      this.chunkSources.set(chunkId, []);
    }

    const sources = this.chunkSources.get(chunkId);
    const filtered = sources.filter(s => s.peerId !== '__server_cache__');
    filtered.push({
      peerId: '__server_cache__',
      routingHash: chunkData.routing_hash || '',
      isCache: true,
      registeredAt: now,
      expires: now + this.CACHE_TTL,
    });
    this.chunkSources.set(chunkId, filtered);

    return true;
  }

  /**
   * Get cached chunk data.
   *
   * @param {string} chunkId - Chunk identifier
   * @returns {Object|null} Cached chunk data, or null if not cached
   */
  getCachedChunk(chunkId) {
    const cached = this.chunkCache.get(chunkId);
    if (!cached) return null;

    if (cached.expires <= Date.now()) {
      this.chunkCache.delete(chunkId);
      return null;
    }

    cached.accessCount++;
    return cached.data;
  }

  /**
   * Check if a chunk is in the server cache.
   *
   * @param {string} chunkId - Chunk identifier
   * @returns {boolean} Whether the chunk is cached
   */
  isChunkCached(chunkId) {
    const cached = this.chunkCache.get(chunkId);
    if (!cached) return false;
    if (cached.expires <= Date.now()) {
      this.chunkCache.delete(chunkId);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pending request management (multicast optimization)
  // ---------------------------------------------------------------------------

  /**
   * Register a pending request for a chunk.
   * If multiple subscribers request the same chunk, the server pulls once
   * from the source and serves all waiting subscribers.
   *
   * @param {string} chunkId - Chunk identifier
   * @param {string} peerId - Requesting peer
   * @returns {boolean} Whether this is the first request (triggers a pull from source)
   */
  addPendingRequest(chunkId, peerId) {
    if (!this.pendingRequests.has(chunkId)) {
      this.pendingRequests.set(chunkId, []);
    }

    const pending = this.pendingRequests.get(chunkId);

    // Don't add duplicate requests from the same peer
    if (pending.some(r => r.peerId === peerId)) {
      return false;
    }

    const isFirst = pending.length === 0;

    pending.push({
      peerId,
      requestedAt: Date.now(),
    });

    return isFirst;
  }

  /**
   * Get and clear all pending requests for a chunk.
   *
   * @param {string} chunkId - Chunk identifier
   * @returns {Array<PendingRequest>} All pending requests
   */
  consumePendingRequests(chunkId) {
    const pending = this.pendingRequests.get(chunkId) || [];
    this.pendingRequests.delete(chunkId);
    return pending;
  }

  /**
   * Check if there are pending requests for a chunk.
   *
   * @param {string} chunkId - Chunk identifier
   * @returns {boolean} Whether there are pending requests
   */
  hasPendingRequests(chunkId) {
    const pending = this.pendingRequests.get(chunkId);
    return !!(pending && pending.length > 0);
  }

  // ---------------------------------------------------------------------------
  // Peer disconnect handling
  // ---------------------------------------------------------------------------

  /**
   * Remove all chunk sources for a disconnected peer.
   *
   * @param {string} peerId - The disconnected peer
   */
  unregisterPeer(peerId) {
    for (const [chunkId, sources] of this.chunkSources) {
      const filtered = sources.filter(s => s.peerId !== peerId);
      if (filtered.length === 0) {
        this.chunkSources.delete(chunkId);
      } else {
        this.chunkSources.set(chunkId, filtered);
      }
    }

    // Also remove pending requests from this peer
    for (const [chunkId, pending] of this.pendingRequests) {
      const filtered = pending.filter(r => r.peerId !== peerId);
      if (filtered.length === 0) {
        this.pendingRequests.delete(chunkId);
      } else {
        this.pendingRequests.set(chunkId, filtered);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Clean up expired entries from all maps.
   */
  cleanup() {
    const now = Date.now();

    // Clean chunk sources
    for (const [chunkId, sources] of this.chunkSources) {
      const valid = sources.filter(s => s.expires > now);
      if (valid.length === 0) {
        this.chunkSources.delete(chunkId);
      } else {
        this.chunkSources.set(chunkId, valid);
      }
    }

    // Clean chunk cache
    this._evictExpiredCache();

    // Clean pending requests older than 5 minutes (stale)
    const staleThreshold = now - 5 * 60 * 1000;
    for (const [chunkId, pending] of this.pendingRequests) {
      const valid = pending.filter(r => r.requestedAt > staleThreshold);
      if (valid.length === 0) {
        this.pendingRequests.delete(chunkId);
      } else {
        this.pendingRequests.set(chunkId, valid);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  /**
   * Get index statistics.
   *
   * @returns {Object} Statistics about the chunk index
   */
  getStats() {
    let totalSources = 0;
    for (const sources of this.chunkSources.values()) {
      totalSources += sources.length;
    }

    let totalPending = 0;
    for (const pending of this.pendingRequests.values()) {
      totalPending += pending.length;
    }

    return {
      trackedChunks: this.chunkSources.size,
      totalSources,
      cachedChunks: this.chunkCache.size,
      pendingRequests: totalPending,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Evict expired entries from the chunk cache.
   * @private
   */
  _evictExpiredCache() {
    const now = Date.now();
    for (const [chunkId, cached] of this.chunkCache) {
      if (cached.expires <= now) {
        this.chunkCache.delete(chunkId);
        // Also remove server cache source entry
        const sources = this.chunkSources.get(chunkId);
        if (sources) {
          const filtered = sources.filter(s => s.peerId !== '__server_cache__');
          if (filtered.length === 0) {
            this.chunkSources.delete(chunkId);
          } else {
            this.chunkSources.set(chunkId, filtered);
          }
        }
      }
    }
  }

  /**
   * Evict the oldest cache entry (LRU-ish eviction).
   * @private
   */
  _evictOldestCacheEntry() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, cached] of this.chunkCache) {
      if (cached.cachedAt < oldestTime) {
        oldestTime = cached.cachedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.chunkCache.delete(oldestKey);
    }
  }
}

/**
 * @typedef {Object} ChunkSource
 * @property {string} peerId - Peer that has this chunk (or '__server_cache__')
 * @property {string} routingHash - The chunk's routing hash
 * @property {boolean} isCache - Whether this is a server cache entry
 * @property {number} registeredAt - Unix timestamp of registration
 * @property {number} expires - Unix timestamp when this entry expires
 */

/**
 * @typedef {Object} ChunkAnnouncement
 * @property {string} chunkId - Chunk identifier
 * @property {string} routingHash - Routing hash for DHT lookup
 */

/**
 * @typedef {Object} CachedChunk
 * @property {Object} data - Full chunk JSON data
 * @property {number} cachedAt - Unix timestamp of when cached
 * @property {number} expires - Unix timestamp when cache expires
 * @property {number} accessCount - Number of times accessed
 */

/**
 * @typedef {Object} PendingRequest
 * @property {string} peerId - Requesting peer ID
 * @property {number} requestedAt - Unix timestamp of request
 */
