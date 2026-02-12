/**
 * ChunkIndex Tests
 *
 * Tests for the chunk availability tracking and caching system:
 * - Chunk announcement (source registration)
 * - Cache management with TTL
 * - Pending request tracking (multicast optimization)
 * - Peer disconnect cleanup
 * - Expiration cleanup
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChunkIndex } from '../chunk-index.js';

describe('ChunkIndex', () => {
  let index;

  beforeEach(() => {
    index = new ChunkIndex();
  });

  // ---------------------------------------------------------------------------
  // Chunk announcement
  // ---------------------------------------------------------------------------

  describe('announceChunks', () => {
    it('should register chunk sources', () => {
      const result = index.announceChunks('peer1', [
        { chunkId: 'ch_001', routingHash: 'hash_a' },
        { chunkId: 'ch_002', routingHash: 'hash_a' },
      ]);

      expect(result.registered).toBe(2);
      expect(index.getChunkSources('ch_001')).toHaveLength(1);
      expect(index.getChunkSources('ch_002')).toHaveLength(1);
    });

    it('should track multiple peers for the same chunk', () => {
      index.announceChunks('peer1', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);
      index.announceChunks('peer2', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);

      const sources = index.getChunkSources('ch_001');
      expect(sources).toHaveLength(2);
      expect(sources.map(s => s.peerId)).toContain('peer1');
      expect(sources.map(s => s.peerId)).toContain('peer2');
    });

    it('should update existing entry on re-announce', () => {
      index.announceChunks('peer1', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);
      index.announceChunks('peer1', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);

      // Should still be just one entry for peer1
      const sources = index.getChunkSources('ch_001');
      expect(sources).toHaveLength(1);
      expect(sources[0].peerId).toBe('peer1');
    });

    it('should skip entries with missing chunkId or routingHash', () => {
      const result = index.announceChunks('peer1', [
        { chunkId: '', routingHash: 'hash_a' },
        { chunkId: 'ch_001', routingHash: '' },
        { chunkId: 'ch_002', routingHash: 'hash_a' },
      ]);

      expect(result.registered).toBe(1);
    });

    it('should store routing hash on source entry', () => {
      index.announceChunks('peer1', [{ chunkId: 'ch_001', routingHash: 'hash_xyz' }]);

      const sources = index.getChunkSources('ch_001');
      expect(sources[0].routingHash).toBe('hash_xyz');
    });
  });

  // ---------------------------------------------------------------------------
  // Chunk availability
  // ---------------------------------------------------------------------------

  describe('isChunkAvailable', () => {
    it('should return true when a source exists', () => {
      index.announceChunks('peer1', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);
      expect(index.isChunkAvailable('ch_001')).toBe(true);
    });

    it('should return true when chunk is cached', () => {
      index.cacheChunk('ch_001', { chunk_id: 'ch_001', routing_hash: 'hash_a' });
      expect(index.isChunkAvailable('ch_001')).toBe(true);
    });

    it('should return false for unknown chunk', () => {
      expect(index.isChunkAvailable('ch_unknown')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Chunk cache
  // ---------------------------------------------------------------------------

  describe('cacheChunk', () => {
    it('should store and retrieve chunk data', () => {
      const data = { chunk_id: 'ch_001', routing_hash: 'hash_a', payload: 'abc' };
      index.cacheChunk('ch_001', data);

      const cached = index.getCachedChunk('ch_001');
      expect(cached).toEqual(data);
    });

    it('should return null for non-cached chunk', () => {
      expect(index.getCachedChunk('ch_unknown')).toBeNull();
    });

    it('should register server as a chunk source when caching', () => {
      index.cacheChunk('ch_001', { chunk_id: 'ch_001', routing_hash: 'hash_a' });

      const sources = index.getChunkSources('ch_001');
      const serverSource = sources.find(s => s.peerId === '__server_cache__');
      expect(serverSource).toBeDefined();
      expect(serverSource.isCache).toBe(true);
    });

    it('should report cached state correctly', () => {
      expect(index.isChunkCached('ch_001')).toBe(false);
      index.cacheChunk('ch_001', { chunk_id: 'ch_001' });
      expect(index.isChunkCached('ch_001')).toBe(true);
    });

    it('should increment access count on get', () => {
      index.cacheChunk('ch_001', { chunk_id: 'ch_001' });
      index.getCachedChunk('ch_001');
      index.getCachedChunk('ch_001');

      // Access internal state to verify
      const entry = index.chunkCache.get('ch_001');
      expect(entry.accessCount).toBe(2);
    });

    it('should evict expired cache entries', () => {
      index.cacheChunk('ch_001', { chunk_id: 'ch_001' });

      // Manually expire the entry
      index.chunkCache.get('ch_001').expires = Date.now() - 1;

      expect(index.getCachedChunk('ch_001')).toBeNull();
      expect(index.isChunkCached('ch_001')).toBe(false);
    });

    it('should evict oldest entry when cache is full', () => {
      index.MAX_CACHE_ENTRIES = 3;

      // Fill cache
      index.cacheChunk('ch_001', { chunk_id: 'ch_001' });
      // Backdate the first entry
      index.chunkCache.get('ch_001').cachedAt = Date.now() - 10000;

      index.cacheChunk('ch_002', { chunk_id: 'ch_002' });
      index.cacheChunk('ch_003', { chunk_id: 'ch_003' });

      // This should evict ch_001 (oldest)
      index.cacheChunk('ch_004', { chunk_id: 'ch_004' });

      expect(index.getCachedChunk('ch_001')).toBeNull();
      expect(index.getCachedChunk('ch_002')).not.toBeNull();
      expect(index.getCachedChunk('ch_004')).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Pending requests (multicast optimization)
  // ---------------------------------------------------------------------------

  describe('pending requests', () => {
    it('should return true for first request', () => {
      const isFirst = index.addPendingRequest('ch_001', 'peer1');
      expect(isFirst).toBe(true);
    });

    it('should return false for subsequent requests', () => {
      index.addPendingRequest('ch_001', 'peer1');
      const isFirst = index.addPendingRequest('ch_001', 'peer2');
      expect(isFirst).toBe(false);
    });

    it('should not add duplicate requests from the same peer', () => {
      index.addPendingRequest('ch_001', 'peer1');
      index.addPendingRequest('ch_001', 'peer1');

      const pending = index.consumePendingRequests('ch_001');
      expect(pending).toHaveLength(1);
    });

    it('should consume and clear pending requests', () => {
      index.addPendingRequest('ch_001', 'peer1');
      index.addPendingRequest('ch_001', 'peer2');

      const pending = index.consumePendingRequests('ch_001');
      expect(pending).toHaveLength(2);
      expect(pending.map(r => r.peerId)).toContain('peer1');
      expect(pending.map(r => r.peerId)).toContain('peer2');

      // Should be empty after consume
      expect(index.consumePendingRequests('ch_001')).toHaveLength(0);
    });

    it('should track pending request status', () => {
      expect(index.hasPendingRequests('ch_001')).toBe(false);
      index.addPendingRequest('ch_001', 'peer1');
      expect(index.hasPendingRequests('ch_001')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Peer disconnect
  // ---------------------------------------------------------------------------

  describe('unregisterPeer', () => {
    it('should remove all chunk sources for the peer', () => {
      index.announceChunks('peer1', [
        { chunkId: 'ch_001', routingHash: 'hash_a' },
        { chunkId: 'ch_002', routingHash: 'hash_a' },
      ]);
      index.announceChunks('peer2', [
        { chunkId: 'ch_001', routingHash: 'hash_a' },
      ]);

      index.unregisterPeer('peer1');

      // ch_001 should still have peer2
      const sources1 = index.getChunkSources('ch_001');
      expect(sources1).toHaveLength(1);
      expect(sources1[0].peerId).toBe('peer2');

      // ch_002 should be empty (map entry removed)
      expect(index.getChunkSources('ch_002')).toHaveLength(0);
    });

    it('should remove pending requests from the peer', () => {
      index.addPendingRequest('ch_001', 'peer1');
      index.addPendingRequest('ch_001', 'peer2');

      index.unregisterPeer('peer1');

      const pending = index.consumePendingRequests('ch_001');
      expect(pending).toHaveLength(1);
      expect(pending[0].peerId).toBe('peer2');
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  describe('cleanup', () => {
    it('should remove expired chunk sources', () => {
      index.announceChunks('peer1', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);

      // Manually expire the source
      const sources = index.chunkSources.get('ch_001');
      sources[0].expires = Date.now() - 1;

      index.cleanup();

      expect(index.getChunkSources('ch_001')).toHaveLength(0);
    });

    it('should remove expired cache entries', () => {
      index.cacheChunk('ch_001', { chunk_id: 'ch_001' });
      index.chunkCache.get('ch_001').expires = Date.now() - 1;

      index.cleanup();

      expect(index.isChunkCached('ch_001')).toBe(false);
    });

    it('should remove stale pending requests', () => {
      index.addPendingRequest('ch_001', 'peer1');
      // Backdate the request by more than 5 minutes
      index.pendingRequests.get('ch_001')[0].requestedAt = Date.now() - 6 * 60 * 1000;

      index.cleanup();

      expect(index.hasPendingRequests('ch_001')).toBe(false);
    });

    it('should keep non-expired entries', () => {
      index.announceChunks('peer1', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);
      index.cacheChunk('ch_002', { chunk_id: 'ch_002' });
      index.addPendingRequest('ch_003', 'peer2');

      index.cleanup();

      expect(index.getChunkSources('ch_001')).toHaveLength(1);
      expect(index.isChunkCached('ch_002')).toBe(true);
      expect(index.hasPendingRequests('ch_003')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('should report correct statistics', () => {
      index.announceChunks('peer1', [
        { chunkId: 'ch_001', routingHash: 'hash_a' },
        { chunkId: 'ch_002', routingHash: 'hash_a' },
      ]);
      index.announceChunks('peer2', [
        { chunkId: 'ch_001', routingHash: 'hash_a' },
      ]);
      index.cacheChunk('ch_003', { chunk_id: 'ch_003' });
      index.addPendingRequest('ch_004', 'peer3');

      const stats = index.getStats();

      // ch_001 (peer1, peer2), ch_002 (peer1), ch_003 (server cache)
      expect(stats.trackedChunks).toBe(3);
      // peer1 on ch_001, peer2 on ch_001, peer1 on ch_002, server_cache on ch_003
      expect(stats.totalSources).toBe(4);
      expect(stats.cachedChunks).toBe(1);
      expect(stats.pendingRequests).toBe(1);
    });

    it('should report empty stats initially', () => {
      const stats = index.getStats();
      expect(stats.trackedChunks).toBe(0);
      expect(stats.totalSources).toBe(0);
      expect(stats.cachedChunks).toBe(0);
      expect(stats.pendingRequests).toBe(0);
    });
  });
});
