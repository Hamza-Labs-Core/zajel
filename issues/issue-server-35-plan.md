# Plan: Stale server cleanup during listServers uses sequential await in loop

**Issue**: issue-server-35.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/server-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/server-registry-do.js`, the `listServers` method (lines 90-111) iterates over all server entries and deletes stale ones with `await` inside the loop:

```js
async listServers(corsHeaders) {
  const now = Date.now();
  const servers = [];
  const entries = await this.state.storage.list({ prefix: 'server:' });

  for (const [key, server] of entries) {
    if (now - server.lastSeen < this.serverTTL) {
      servers.push(server);
    } else {
      await this.state.storage.delete(key);  // Sequential await on line 103
    }
  }

  return new Response(
    JSON.stringify({ servers }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

Each `await this.state.storage.delete(key)` is a separate I/O operation. With many stale entries, this serializes deletions, blocking the DO (and all other requests) for the duration.

Cloudflare Durable Object storage's `delete()` method accepts an array of keys for batch deletion.

## Fix Steps

1. **Replace the sequential delete with batch deletion** in `listServers` (lines 90-111):

```js
async listServers(corsHeaders) {
  const now = Date.now();
  const servers = [];
  const staleKeys = [];

  const entries = await this.state.storage.list({ prefix: 'server:' });

  for (const [key, server] of entries) {
    if (now - server.lastSeen < this.serverTTL) {
      servers.push(server);
    } else {
      staleKeys.push(key);
    }
  }

  // Batch delete all stale entries in a single operation
  if (staleKeys.length > 0) {
    await this.state.storage.delete(staleKeys);
  }

  return new Response(
    JSON.stringify({ servers }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

2. The `this.state.storage.delete(staleKeys)` call where `staleKeys` is an array performs a batch deletion in a single storage operation, which is significantly faster than sequential deletes.

## Testing

- Test with no stale entries: verify `servers` array contains all entries and no delete is called.
- Test with all entries stale: verify `servers` array is empty and all entries are deleted.
- Test with a mix: verify only active servers are returned and stale entries are deleted.
- Measure response time with a large number of stale entries (e.g., 100) and compare sequential vs. batch.

## Risk Assessment

- **Very low risk**: The batch delete produces the same result as sequential deletes -- all stale keys are removed. The only difference is performance (single I/O operation vs. N operations).
- **Correctness**: Durable Object storage guarantees atomicity for batch operations, so all stale keys are either all deleted or none are (in case of failure).
- **Memory note**: Collecting `staleKeys` into an array uses slightly more memory than the sequential approach, but this is negligible since keys are short strings and the number of servers is typically small.
