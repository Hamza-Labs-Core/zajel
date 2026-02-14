# Plan: Chunk announce accepts unbounded chunk arrays

**Retargeted**: This issue was originally identified in dead CF Worker code (`packages/server/src/websocket-handler.js` and `packages/server/src/chunk-index.js`). The same vulnerability exists in the VPS server.

**Issue**: issue-server-14.md
**Severity**: HIGH
**Area**: Server (VPS)
**Files to modify**:
- `packages/server-vps/src/client/handler.ts`
- `packages/server-vps/src/client/chunk-relay.ts`

## Analysis

In `packages/server-vps/src/client/handler.ts`:
- `handleChunkAnnounce()` (lines 2119-2171): Validates that `chunks` is a non-empty array at line 2132 (`if (!chunks || !Array.isArray(chunks) || chunks.length === 0)`) but does **NOT limit its length**.
- After announcing, the method iterates all chunks again at lines 2159-2169 to notify channel subscribers about new chunks, amplifying the work per announce.
- Individual chunk entry validation (lines 2138-2143) only checks for `chunkId` existence, not string length or format:
  ```ts
  for (const chunk of chunks) {
    if (!chunk.chunkId) {
      this.sendError(ws, 'Each chunk must have a chunkId');
      return;
    }
  }
  ```

In `packages/server-vps/src/client/chunk-relay.ts`:
- `handleAnnounce()` (lines 162-172): Iterates the chunks array without a length check. Each chunk triggers a `storage.saveChunkSource()` call at line 167, writing a row to SQLite.
- The `SOURCE_TTL_MS` is 1 hour (line 22), so source entries persist for a long time.
- `cleanup()` (lines 315-337) iterates expired entries every 5 minutes (`CLEANUP_INTERVAL_MS` at line 28), but only removes expired entries, not excessive ones. It does not enforce a total source count cap.
- Unlike the in-memory `chunkSources` Map in the CF Worker's `chunk-index.js`, the VPS stores sources in SQLite via the storage interface. This means unbounded announcements exhaust both disk space and query performance.

## Fix Steps

1. **Add chunk array length limit in `handleChunkAnnounce()` (handler.ts, after the existing array check at line 2132)**:
   ```ts
   const MAX_CHUNKS_PER_ANNOUNCE = 100;
   if (chunks.length > MAX_CHUNKS_PER_ANNOUNCE) {
     this.sendError(ws, `Too many chunks per announce (max ${MAX_CHUNKS_PER_ANNOUNCE})`);
     return;
   }
   ```

2. **Validate individual chunk entries more thoroughly** in `handleChunkAnnounce()` (replace lines 2138-2143):
   ```ts
   for (const chunk of chunks) {
     if (!chunk.chunkId || typeof chunk.chunkId !== 'string' || chunk.chunkId.length > 256) {
       this.sendError(ws, 'Invalid chunk entry: chunkId must be a string up to 256 chars');
       return;
     }
     if (chunk.routingHash !== undefined && (typeof chunk.routingHash !== 'string' || chunk.routingHash.length > 256)) {
       this.sendError(ws, 'Invalid chunk entry: routingHash must be a string up to 256 chars');
       return;
     }
   }
   ```

3. **Add a per-peer source limit in `chunk-relay.ts` `handleAnnounce()`** (before the loop at line 165):
   ```ts
   const MAX_SOURCES_PER_PEER = 1000;

   // Count existing sources for this peer (via storage query)
   const existingCount = await this.storage.countChunkSourcesByPeer(peerId);
   if (existingCount + chunks.length > MAX_SOURCES_PER_PEER) {
     return {
       registered: 0,
       error: `Per-peer chunk source limit reached (max ${MAX_SOURCES_PER_PEER})`,
     };
   }
   ```
   This requires adding a `countChunkSourcesByPeer(peerId: string): Promise<number>` method to the storage interface.

4. **Add a global source count limit in `chunk-relay.ts`**:
   ```ts
   const MAX_TOTAL_SOURCES = 50000;

   async handleAnnounce(peerId: string, chunks: ChunkAnnouncement[]): Promise<{ registered: number; error?: string }> {
     // Check global cap
     const totalSources = await this.storage.countAllChunkSources();
     if (totalSources >= MAX_TOTAL_SOURCES) {
       return { registered: 0, error: 'Chunk source registry full' };
     }

     // Check per-peer cap
     const peerSources = await this.storage.countChunkSourcesByPeer(peerId);
     if (peerSources + chunks.length > MAX_SOURCES_PER_PEER) {
       return { registered: 0, error: 'Per-peer chunk source limit reached' };
     }

     let registered = 0;
     for (const chunk of chunks) {
       if (!chunk.chunkId) continue;
       await this.storage.saveChunkSource(chunk.chunkId, peerId);
       registered++;
     }

     return { registered };
   }
   ```

5. **Update `handleChunkAnnounce()` in handler.ts** to handle the new error return from `handleAnnounce()`:
   ```ts
   const result = await this.chunkRelay.handleAnnounce(peerId, chunks);

   if (result.error) {
     this.sendError(ws, result.error);
     return;
   }
   ```
   Note: The current code at line 2148 does not check for an `error` field in the result. The `handleAnnounce()` return type needs to be updated to include `error?: string`.

## Testing

- Verify that announcing <= 100 chunks succeeds.
- Verify that announcing > 100 chunks is rejected with an error message.
- Verify that chunkId values exceeding 256 characters are rejected.
- Verify that the per-peer source limit is enforced (register close to the limit, then announce more).
- Verify that the global source count limit is enforced.
- Verify that chunk request/pull/push flows still work correctly after adding limits.
- Run existing chunk-related tests.

## Risk Assessment

- **Client compatibility**: The Flutter app's `chunkSize` is 64KB (matching `MAX_TEXT_CHUNK_PAYLOAD` at chunk-relay.ts line 34). For a typical message or file, the number of chunks depends on total size. 100 chunks per announce (6.4MB per message) should be sufficient for most use cases. Larger files can be announced in multiple batched messages.
- **SQLite performance**: The per-peer and global count queries require `COUNT(*)` on the chunk sources table. Adding an index on `peer_id` in the chunk_sources table is recommended for O(log n) performance. Without an index, the count query becomes slow at scale.
- **Global cap vs per-peer cap**: Both are needed. The global cap prevents total storage exhaustion. The per-peer cap prevents a single malicious peer from filling the index. The per-peer cap (1000) multiplied by a reasonable number of concurrent peers should be well below the global cap (50000).
- **Return type change**: Adding `error?: string` to the `handleAnnounce()` return type is a minor interface change. The caller in handler.ts must be updated to check for errors.
