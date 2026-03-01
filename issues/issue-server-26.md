# [MEDIUM] RelayRegistry stale peers never cleaned up

**Area**: Server
**File**: packages/server/src/relay-registry.js
**Type**: Bug

**Description**: The `RelayRegistry` class tracks peers with a `lastUpdate` timestamp but never uses it to expire stale peers. The `RelayRegistryDO.alarm()` calls `rendezvousRegistry.cleanup()` and `chunkIndex.cleanup()`, but there is no `relayRegistry.cleanup()` call. The `RelayRegistry` class itself has no `cleanup()` method.

If a peer registers but never disconnects cleanly (e.g., network failure where WebSocket close event is not fired), their entry persists in the `peers` Map indefinitely.

**Impact**: Stale peer entries accumulate in the relay registry, consuming memory and polluting the `getAvailableRelays` results. Clients may attempt to connect to stale relays that are no longer reachable, causing connection failures and degraded user experience.

**Fix**:
1. Add a `cleanup()` method to `RelayRegistry` that removes peers whose `lastUpdate` is older than a threshold (e.g., 10 minutes):
```js
cleanup(maxAge = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [id, peer] of this.peers) {
    if (now - peer.lastUpdate > maxAge) {
      this.peers.delete(id);
    }
  }
}
```
2. Call it from `RelayRegistryDO.alarm()`.
