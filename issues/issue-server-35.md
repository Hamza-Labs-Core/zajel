# [LOW] Stale server cleanup during listServers uses sequential await in loop

**Area**: Server
**File**: packages/server/src/durable-objects/server-registry-do.js:97-105
**Type**: Best Practice

**Description**: The `listServers` method iterates over all server entries and deletes stale ones using `await` inside the loop:
```js
for (const [key, server] of entries) {
  if (now - server.lastSeen < this.serverTTL) {
    servers.push(server);
  } else {
    await this.state.storage.delete(key);  // Sequential await in loop
  }
}
```
Each `await` serializes the delete operations. If there are many stale entries, this loop blocks the DO for a significant time.

**Impact**: Under high churn (many servers registering and expiring), the `GET /servers` endpoint becomes slow as it serially deletes stale entries. Since the DO processes requests sequentially, this blocks all other requests during cleanup.

**Fix**: Batch the deletes:
```js
const staleKeys = [];
for (const [key, server] of entries) {
  if (now - server.lastSeen < this.serverTTL) {
    servers.push(server);
  } else {
    staleKeys.push(key);
  }
}
if (staleKeys.length > 0) {
  await this.state.storage.delete(staleKeys);
}
```
Durable Object storage's `delete()` method accepts an array of keys for batch deletion.
