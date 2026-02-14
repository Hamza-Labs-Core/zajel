# Plan: RelayRegistry stale peers never cleaned up

**Issue**: issue-server-26.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/relay-registry.js`, `packages/server/src/durable-objects/relay-registry-do.js`

## Analysis

In `packages/server/src/relay-registry.js`, the `RelayRegistry` class stores peers in an in-memory `Map` (line 12: `this.peers = new Map()`). Each peer entry has a `lastUpdate` timestamp (set on line 32), but there is no method to clean up peers whose `lastUpdate` is stale.

In `packages/server/src/durable-objects/relay-registry-do.js`, the `alarm()` method (lines 50-57) calls cleanup on `rendezvousRegistry` and `chunkIndex`, but not on `relayRegistry`:

```js
async alarm() {
  this.rendezvousRegistry.cleanup();
  this.chunkIndex.cleanup();
  await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
}
```

While peers are normally cleaned up on WebSocket disconnect (via `handleDisconnect` in `websocket-handler.js` line 398), a network failure where the WebSocket close event is never fired would leave a stale entry in the `peers` Map indefinitely. This stale entry would appear in `getAvailableRelays` results.

Note: `RelayRegistryDO` is currently dead code (deleted in wrangler.jsonc migration v3).

## Fix Steps

1. **Add a `cleanup` method to `RelayRegistry`** in `packages/server/src/relay-registry.js`, after the `getStats` method (after line 131):

```js
/**
 * Remove peers whose lastUpdate is older than the given threshold.
 * @param {number} [maxAge=600000] - Maximum age in ms (default 10 minutes)
 */
cleanup(maxAge = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [id, peer] of this.peers) {
    if (now - peer.lastUpdate > maxAge) {
      this.peers.delete(id);
    }
  }
}
```

2. **Call `relayRegistry.cleanup()` from `RelayRegistryDO.alarm()`** in `packages/server/src/durable-objects/relay-registry-do.js`, adding it at line 52 before or after the existing cleanup calls:

```js
async alarm() {
  this.relayRegistry.cleanup();
  this.rendezvousRegistry.cleanup();
  this.chunkIndex.cleanup();
  await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
}
```

## Testing

- Add a unit test for `RelayRegistry.cleanup()`:
  - Register several peers with varying `lastUpdate` timestamps.
  - Call `cleanup()` and verify only stale peers are removed.
  - Verify that recently-updated peers are retained.
- Test that the `alarm()` handler in `RelayRegistryDO` calls all three cleanup methods.
- Verify that `getAvailableRelays()` does not return stale peers after cleanup.

## Risk Assessment

- **Low risk**: The cleanup method only removes peers that have not sent any update for 10 minutes. Active peers send heartbeats more frequently than this threshold.
- **Dead code caveat**: `RelayRegistryDO` is currently deleted in wrangler migrations, so this has no production impact until re-enabled. However, applying the fix now is good practice.
- If a peer reconnects after being cleaned up, it will simply re-register. No data loss occurs.
