# Plan: Chunk cache stores full chunk data in memory with no per-entry size limit

**Issue**: issue-server-31.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/chunk-index.js`

## Analysis

In `packages/server/src/chunk-index.js`, the `cacheChunk` method (lines 135-168) stores chunk data in an in-memory `Map` with a count-based limit:

```js
this.MAX_CACHE_ENTRIES = 1000;  // line 47
```

While the WebSocket handler (`websocket-handler.js` line 361-363) validates chunk push payload size to 64KB:
```js
const payloadSize = JSON.stringify(data).length;
if (payloadSize > MAX_TEXT_CHUNK_PAYLOAD) { ... }
```

The `cacheChunk` method itself (line 135) has no size validation and could be called from other code paths without the 64KB check.

At maximum capacity: 1000 entries * 64KB = 64MB. The Cloudflare Workers isolate memory limit is 128MB, so this cache alone could consume half the available memory, leaving insufficient room for other data structures.

Note: `ChunkIndex` is part of the dead code (`RelayRegistryDO` is deleted in wrangler migrations), but the fix is important for correctness if re-enabled.

## Fix Steps

1. **Reduce `MAX_CACHE_ENTRIES` and add a total memory budget** in the constructor (around line 47):

```js
/** Maximum cache size in entries */
this.MAX_CACHE_ENTRIES = 200;

/** Maximum total cache size in bytes */
this.MAX_CACHE_BYTES = 16 * 1024 * 1024; // 16MB

/** Current total cache size in bytes */
this.currentCacheBytes = 0;
```

2. **Add per-entry size validation and total budget tracking** in `cacheChunk` (line 135). Replace the current method:

```js
cacheChunk(chunkId, chunkData) {
  // Calculate entry size
  const entrySize = JSON.stringify(chunkData).length * 2; // approximate memory (UTF-16)

  // Reject individual entries that are too large (64KB limit)
  const MAX_ENTRY_SIZE = 64 * 1024;
  if (entrySize > MAX_ENTRY_SIZE) {
    return false;
  }

  // Evict expired entries first
  this._evictExpiredCache();

  // Evict entries until we have room in both count and byte budgets
  while (
    (this.chunkCache.size >= this.MAX_CACHE_ENTRIES ||
     this.currentCacheBytes + entrySize > this.MAX_CACHE_BYTES) &&
    this.chunkCache.size > 0
  ) {
    this._evictOldestCacheEntry();
  }

  // If still over budget after eviction, refuse to cache
  if (this.currentCacheBytes + entrySize > this.MAX_CACHE_BYTES) {
    return false;
  }

  const now = Date.now();
  this.chunkCache.set(chunkId, {
    data: chunkData,
    cachedAt: now,
    expires: now + this.CACHE_TTL,
    accessCount: 0,
    size: entrySize,
  });
  this.currentCacheBytes += entrySize;

  // ... rest of source registration logic (lines 153-166) stays the same
```

3. **Update `_evictOldestCacheEntry`** (line 388) to track byte budget:

```js
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
    const evicted = this.chunkCache.get(oldestKey);
    this.currentCacheBytes -= (evicted.size || 0);
    this.chunkCache.delete(oldestKey);
  }
}
```

4. **Update `_evictExpiredCache`** (line 365) to track byte budget:

```js
_evictExpiredCache() {
  const now = Date.now();
  for (const [chunkId, cached] of this.chunkCache) {
    if (cached.expires <= now) {
      this.currentCacheBytes -= (cached.size || 0);
      this.chunkCache.delete(chunkId);
      // ... existing source cleanup logic
    }
  }
}
```

## Testing

- Test that caching a chunk below the size limit succeeds.
- Test that caching a chunk above 64KB individual limit is rejected.
- Test that the total byte budget is enforced (cache many chunks until budget is reached, then verify old entries are evicted).
- Test that `MAX_CACHE_ENTRIES` limit of 200 is enforced.
- Test that expired entries are evicted and byte budget is correctly decremented.
- Verify `getStats()` still returns correct values.

## Risk Assessment

- **Low risk**: Reducing `MAX_CACHE_ENTRIES` from 1000 to 200 means the cache holds fewer entries, which reduces cache hit rate but dramatically improves memory safety. At 200 entries * 64KB = ~12.5MB max, well within safe limits.
- **Byte tracking accuracy**: Using `JSON.stringify(chunkData).length * 2` as an approximation of memory usage (UTF-16 encoding) is rough but conservative enough.
- **Dead code caveat**: This code is part of the dead `RelayRegistryDO` system, but fixing it now prevents future issues if re-enabled.
