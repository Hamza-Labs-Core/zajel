/**
 * Chunk Relay Service
 *
 * Manages chunk caching, source tracking, and relay logic for the VPS server.
 * This is the VPS-side counterpart to the CF Worker's ChunkIndex.
 *
 * Responsibilities:
 * - Track which peers have which chunks (chunk_sources)
 * - Cache chunk data on disk via SQLite (chunk_cache)
 * - Relay chunks between peers: pull from sources, fan out to requesters
 * - TTL cleanup and LRU eviction for the cache
 * - Pending request deduplication (pull once, serve many)
 */

import type { Storage } from '../storage/interface.js';
import type { WebSocket } from 'ws';

/** TTL for cached chunks: 30 minutes */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** TTL for chunk source entries: 1 hour */
const SOURCE_TTL_MS = 60 * 60 * 1000;

/** Maximum cached chunks (LRU eviction cap) */
const MAX_CACHE_ENTRIES = 1000;

/** Cleanup interval: every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Stale pending request threshold: 2 minutes */
const PENDING_REQUEST_TTL_MS = 2 * 60 * 1000;

/** Maximum chunk payload size in bytes (64KB — matches Flutter app's chunkSize) */
const MAX_TEXT_CHUNK_PAYLOAD = 64 * 1024;

export interface ChunkAnnouncement {
  chunkId: string;
  routingHash?: string;
}

export interface PendingChunkRequest {
  peerId: string;
  ws: WebSocket;
  requestedAt: number;
}

export interface ChunkRelayStats {
  cachedChunks: number;
  trackedSources: number;
  pendingRequests: number;
}

export class ChunkRelay {
  private storage: Storage;

  /**
   * In-memory map of connected peers: peerId -> WebSocket
   * Used to know which peers are online for chunk pulls.
   */
  private onlinePeers: Map<string, WebSocket> = new Map();

  /**
   * Pending chunk requests: chunkId -> PendingChunkRequest[]
   * When a chunk is requested but not cached, we pull from a source peer.
   * Multiple requesters for the same chunk are queued here.
   */
  private pendingRequests: Map<string, PendingChunkRequest[]> = new Map();

  /**
   * Chunks currently being pulled: chunkId -> true
   * Prevents duplicate pull requests for the same chunk.
   */
  private activePulls: Set<string> = new Set();

  /**
   * Cleanup interval handle.
   */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Callback used to send a message to a specific peer.
   * Set by the handler when wiring up the relay.
   */
  private sendToPeer: ((peerId: string, message: object) => boolean) | null = null;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * Set the callback for sending messages to peers.
   */
  setSendCallback(fn: (peerId: string, message: object) => boolean): void {
    this.sendToPeer = fn;
  }

  /**
   * Start periodic cleanup.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch(err => {
        console.error('[ChunkRelay] Cleanup error:', err);
      });
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Register a peer as online (connected).
   */
  registerPeer(peerId: string, ws: WebSocket): void {
    this.onlinePeers.set(peerId, ws);
  }

  /**
   * Unregister a peer (disconnected).
   * Removes their chunk sources and pending requests.
   */
  async unregisterPeer(peerId: string): Promise<void> {
    this.onlinePeers.delete(peerId);
    await this.storage.deleteChunkSourcesByPeer(peerId);

    // Remove pending requests from this peer
    for (const [chunkId, requests] of this.pendingRequests) {
      const filtered = requests.filter(r => r.peerId !== peerId);
      if (filtered.length === 0) {
        this.pendingRequests.delete(chunkId);
      } else {
        this.pendingRequests.set(chunkId, filtered);
      }
    }
  }

  /**
   * Check if a peer is online.
   */
  isPeerOnline(peerId: string): boolean {
    const ws = this.onlinePeers.get(peerId);
    if (!ws) return false;
    return ws.readyState === ws.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Handler: chunk_announce
  // ---------------------------------------------------------------------------

  /**
   * Handle chunk_announce: peer announces it has chunks.
   * Stores the source mappings in the database.
   */
  async handleAnnounce(peerId: string, chunks: ChunkAnnouncement[]): Promise<{ registered: number; error?: string }> {
    let registered = 0;

    for (const chunk of chunks) {
      if (!chunk.chunkId) continue;
      await this.storage.saveChunkSource(chunk.chunkId, peerId);
      registered++;
    }

    return { registered };
  }

  // ---------------------------------------------------------------------------
  // Handler: chunk_request
  // ---------------------------------------------------------------------------

  /**
   * Handle chunk_request: peer requests a chunk.
   *
   * 1. If cached, serve immediately.
   * 2. If not cached, find an online source peer and send chunk_pull.
   * 3. Track the request as pending. If another request for the same
   *    chunk is already in-flight, just queue this requester (dedup).
   */
  async handleRequest(
    peerId: string,
    ws: WebSocket,
    chunkId: string,
    channelId: string
  ): Promise<{ served: boolean; pulling: boolean; error?: string }> {
    // 1. Check cache first
    const cached = await this.storage.getCachedChunk(chunkId);
    if (cached) {
      // Serve from cache: parse stored JSON back to object so clients
      // receive the same format as a relay-served chunk.
      let cachedData: object | string;
      try {
        cachedData = JSON.parse(cached.data.toString('utf-8'));
      } catch {
        cachedData = cached.data.toString('base64'); // Legacy fallback
      }
      this.sendToWs(ws, {
        type: 'chunk_data',
        chunkId,
        channelId: cached.channelId,
        data: cachedData,
        source: 'cache',
      });
      return { served: true, pulling: false };
    }

    // 2. Check if we're already pulling this chunk
    if (this.activePulls.has(chunkId)) {
      // Just queue this requester
      this.addPendingRequest(chunkId, peerId, ws);
      return { served: false, pulling: true };
    }

    // 3. Find an online source peer
    const sources = await this.storage.getChunkSources(chunkId);
    const onlineSource = sources.find(s => s.peerId !== peerId && this.isPeerOnline(s.peerId));

    if (!onlineSource) {
      return { served: false, pulling: false, error: 'No source available for chunk' };
    }

    // Queue the requester
    this.addPendingRequest(chunkId, peerId, ws);

    // Mark as pulling and send chunk_pull to the source peer
    this.activePulls.add(chunkId);

    if (this.sendToPeer) {
      this.sendToPeer(onlineSource.peerId, {
        type: 'chunk_pull',
        chunkId,
        channelId,
      });
    }

    return { served: false, pulling: true };
  }

  // ---------------------------------------------------------------------------
  // Handler: chunk_push
  // ---------------------------------------------------------------------------

  /**
   * Handle chunk_push: peer sends chunk data (response to a chunk_pull).
   *
   * 1. Cache the chunk data.
   * 2. Fan out to all pending requesters.
   * 3. Clear the active pull.
   */
  async handlePush(
    peerId: string,
    chunkId: string,
    channelId: string,
    data: string | object // JSON object (from client) or string (legacy)
  ): Promise<{ cached: boolean; servedCount: number; error?: string }> {
    // 1. Normalize to JSON string for size validation and caching
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    if (dataStr.length > MAX_TEXT_CHUNK_PAYLOAD) {
      return {
        cached: false,
        servedCount: 0,
        error: `Chunk payload too large: ${dataStr.length} bytes exceeds ${MAX_TEXT_CHUNK_PAYLOAD} byte limit`,
      };
    }

    // 2. Cache the chunk as UTF-8 JSON string
    const buffer = Buffer.from(dataStr, 'utf-8');
    await this.storage.cacheChunk(chunkId, channelId, buffer);

    // Enforce LRU cap
    await this.storage.evictLruChunks(MAX_CACHE_ENTRIES);

    // Also register the pushing peer as a source
    await this.storage.saveChunkSource(chunkId, peerId);

    // 3. Fan out to pending requesters — forward original data object
    const pending = this.pendingRequests.get(chunkId) || [];
    this.pendingRequests.delete(chunkId);

    let servedCount = 0;
    for (const request of pending) {
      const sent = this.sendToWs(request.ws, {
        type: 'chunk_data',
        chunkId,
        channelId,
        data,
        source: 'relay',
      });
      if (sent) servedCount++;
    }

    // 4. Clear active pull
    this.activePulls.delete(chunkId);

    return { cached: true, servedCount };
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Run periodic cleanup:
   * - Delete cached chunks older than CACHE_TTL_MS
   * - Evict LRU chunks if over MAX_CACHE_ENTRIES
   * - Delete stale chunk sources older than SOURCE_TTL_MS
   * - Purge stale pending requests
   */
  async cleanup(): Promise<{ expiredChunks: number; expiredSources: number; stalePending: number }> {
    const expiredChunks = await this.storage.cleanupExpiredChunks(CACHE_TTL_MS);
    await this.storage.evictLruChunks(MAX_CACHE_ENTRIES);
    const expiredSources = await this.storage.cleanupExpiredChunkSources(SOURCE_TTL_MS);

    // Clean up stale pending requests
    const now = Date.now();
    let stalePending = 0;
    for (const [chunkId, requests] of this.pendingRequests) {
      const valid = requests.filter(r => now - r.requestedAt < PENDING_REQUEST_TTL_MS);
      const removed = requests.length - valid.length;
      stalePending += removed;

      if (valid.length === 0) {
        this.pendingRequests.delete(chunkId);
        this.activePulls.delete(chunkId);
      } else {
        this.pendingRequests.set(chunkId, valid);
      }
    }

    return { expiredChunks, expiredSources, stalePending };
  }

  /**
   * Get cached chunk IDs for a channel.
   * Used when a new subscriber joins to inform them of existing content.
   */
  async getCachedChunkIdsForChannel(channelId: string): Promise<string[]> {
    return this.storage.getCachedChunkIdsByChannel(channelId);
  }

  /**
   * Get relay statistics.
   */
  async getStats(): Promise<ChunkRelayStats> {
    const cachedChunks = await this.storage.getCachedChunkCount();

    let trackedSources = 0;
    // We can't easily count all sources without a dedicated method,
    // so we'll use a rough estimate based on pendingRequests
    // For stats, return cached chunk count and pending request count
    let pendingRequests = 0;
    for (const requests of this.pendingRequests.values()) {
      pendingRequests += requests.length;
    }

    return {
      cachedChunks,
      trackedSources,
      pendingRequests,
    };
  }

  /**
   * Shutdown: stop cleanup and clear state.
   */
  shutdown(): void {
    this.stopCleanup();
    this.pendingRequests.clear();
    this.activePulls.clear();
    this.onlinePeers.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private addPendingRequest(chunkId: string, peerId: string, ws: WebSocket): void {
    if (!this.pendingRequests.has(chunkId)) {
      this.pendingRequests.set(chunkId, []);
    }

    const pending = this.pendingRequests.get(chunkId)!;

    // Don't add duplicate requests from the same peer
    if (pending.some(r => r.peerId === peerId)) return;

    pending.push({
      peerId,
      ws,
      requestedAt: Date.now(),
    });
  }

  private sendToWs(ws: WebSocket, message: object): boolean {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
        return true;
      }
    } catch (e) {
      console.error('[ChunkRelay] Failed to send message:', e);
    }
    return false;
  }
}

// Export constants for testing
export { CACHE_TTL_MS, SOURCE_TTL_MS, MAX_CACHE_ENTRIES, CLEANUP_INTERVAL_MS, PENDING_REQUEST_TTL_MS, MAX_TEXT_CHUNK_PAYLOAD };
