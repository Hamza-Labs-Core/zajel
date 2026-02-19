# [HIGH] Chunk announce accepts unbounded chunk arrays

**Area**: Server
**File**: packages/server/src/websocket-handler.js:235-272
**Type**: Security

**Description**: The `handleChunkAnnounce` method validates that `chunks` is a non-empty array but does not limit its length. A single `chunk_announce` message can contain an arbitrarily large array of chunk announcements. Each chunk creates entries in the `chunkSources` Map and potentially triggers `chunk_pull` requests.

The `chunkSources` Map in `ChunkIndex` has no size limit -- unlike `chunkCache` which caps at `MAX_CACHE_ENTRIES = 1000`. The `SOURCE_TTL` is 1 hour, so entries persist for a long time.

**Impact**:
- Memory exhaustion: A malicious peer can announce millions of fake chunks, filling the `chunkSources` Map with entries that persist for 1 hour.
- CPU waste: Each announced chunk triggers a `hasPendingRequests` check and potentially a `chunk_pull` message.
- The `chunkIndex.cleanup()` method iterates all entries in all three Maps every 5 minutes, becoming very slow with millions of entries.

**Fix**:
1. Limit the number of chunks per announce message:
```js
if (chunks.length > 100) {
  this.sendError(ws, 'Too many chunks (max 100 per announce)');
  return;
}
```
2. Add a maximum size for `chunkSources` Map similar to `MAX_CACHE_ENTRIES`.
3. Limit the total number of chunk sources a single peer can register.
