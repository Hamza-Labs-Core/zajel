# Plan: Chunk announce accepts unbounded chunk arrays

**Issue**: issue-server-14.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/websocket-handler.js`
- `packages/server/src/chunk-index.js`

## Analysis

In `packages/server/src/websocket-handler.js`:
- `handleChunkAnnounce()` (lines 235-272): Validates that `chunks` is a non-empty array (line 248: `if (!Array.isArray(chunks) || chunks.length === 0)`) but does NOT limit its length.
- After announcing, the method iterates all chunks again (lines 262-271) checking `hasPendingRequests` and sending `chunk_pull` messages, amplifying the work per announce.

In `packages/server/src/chunk-index.js`:
- `announceChunks()` (lines 65-96): Iterates the chunks array without a length check. Each chunk creates entries in `chunkSources` Map.
- `chunkSources` Map has no size limit (unlike `chunkCache` which caps at `MAX_CACHE_ENTRIES = 1000` at line 47).
- `SOURCE_TTL` is 1 hour (line 44), so entries persist for a long time.
- `cleanup()` (lines 301-327) iterates all entries in all three Maps every 5 minutes, becoming slower with millions of entries.

## Fix Steps

1. **Add chunk array length limit in `handleChunkAnnounce()` (websocket-handler.js, after line 248)**:
   ```js
   const MAX_CHUNKS_PER_ANNOUNCE = 100;
   if (chunks.length > MAX_CHUNKS_PER_ANNOUNCE) {
     this.sendError(ws, `Too many chunks per announce (max ${MAX_CHUNKS_PER_ANNOUNCE})`);
     return;
   }
   ```

2. **Validate individual chunk entries** in `handleChunkAnnounce()`:
   ```js
   for (const chunk of chunks) {
     if (!chunk.chunkId || typeof chunk.chunkId !== 'string' || chunk.chunkId.length > 256) {
       this.sendError(ws, 'Invalid chunk entry: chunkId must be a string up to 256 chars');
       return;
     }
     if (!chunk.routingHash || typeof chunk.routingHash !== 'string' || chunk.routingHash.length > 256) {
       this.sendError(ws, 'Invalid chunk entry: routingHash must be a string up to 256 chars');
       return;
     }
   }
   ```

3. **Add a `MAX_SOURCE_ENTRIES` cap in `chunk-index.js`**:
   ```js
   this.MAX_SOURCE_ENTRIES = 50000; // Maximum total entries in chunkSources
   ```

4. **Check the cap in `announceChunks()`** (chunk-index.js, before the loop at line 69):
   ```js
   // Count total sources
   let totalSources = 0;
   for (const sources of this.chunkSources.values()) {
     totalSources += sources.length;
   }
   if (totalSources >= this.MAX_SOURCE_ENTRIES) {
     return { registered: 0, error: 'Chunk source registry full' };
   }
   ```

5. **Add per-peer source limit** in `announceChunks()`:
   ```js
   // Limit sources per peer (e.g., max 1000 chunks per peer)
   const MAX_SOURCES_PER_PEER = 1000;
   let peerSourceCount = 0;
   for (const sources of this.chunkSources.values()) {
     peerSourceCount += sources.filter(s => s.peerId === peerId).length;
   }
   if (peerSourceCount >= MAX_SOURCES_PER_PEER) {
     return { registered: 0, error: 'Per-peer chunk source limit reached' };
   }
   ```

## Testing

- Verify that announcing <= 100 chunks succeeds.
- Verify that announcing > 100 chunks is rejected.
- Verify that the global source entry limit is enforced.
- Verify that per-peer limits prevent a single peer from monopolizing the index.
- Verify that chunk request/pull/push flows still work correctly.
- Run existing chunk-related tests.

## Risk Assessment

- **Client compatibility**: The Flutter app's `chunkSize` is 64KB. For a typical message or file, the number of chunks depends on total size. 100 chunks per announce (6.4MB per message) should be sufficient for most use cases. Larger files can be announced in multiple messages.
- **Per-peer count scan performance**: Counting per-peer sources requires iterating all entries. At scale, this could be slow. Consider maintaining a per-peer counter Map for O(1) lookups.
- **Global cap vs per-peer cap**: Both are needed. The global cap prevents total memory exhaustion. The per-peer cap prevents a single malicious peer from filling the index.
