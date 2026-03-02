# [MEDIUM] Chunk cache stores full chunk data in memory with no per-entry size limit

**Area**: Server
**File**: packages/server/src/chunk-index.js:135-168
**Type**: Security

**Description**: The `cacheChunk` method stores the full `chunkData` object in the in-memory Map with only an entry count limit (`MAX_CACHE_ENTRIES = 1000`), not a total memory limit. While `handleChunkPush` in the WebSocket handler validates `JSON.stringify(data).length <= 64KB`, the `cacheChunk` method itself has no size validation and can be called from other code paths.

1000 entries at 64KB each = 64MB of memory, which is half the Cloudflare Workers isolate memory limit (128MB).

**Impact**: Legitimate use at max capacity (1000 cached 64KB chunks) consumes 64MB of the 128MB memory budget, leaving limited room for all other in-memory data structures (relay registry, rendezvous registry, chunk sources, pending requests, WebSocket connections). This can trigger OOM crashes under normal load.

**Fix**:
1. Reduce `MAX_CACHE_ENTRIES` to a safer value (e.g., 100-200 entries) or add a total memory budget:
```js
this.MAX_CACHE_BYTES = 16 * 1024 * 1024; // 16MB total cache
this.currentCacheBytes = 0;
```
2. Track per-entry size and enforce the total cache budget.
3. Move chunk caching to Durable Object storage or a KV namespace instead of in-memory storage.
