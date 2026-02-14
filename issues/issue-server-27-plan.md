# Plan: maxConnections value not validated in relay registration

**Issue**: issue-server-27.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/websocket-handler.js`, `packages/server/src/relay-registry.js`

## Analysis

In `packages/server/src/websocket-handler.js`, the `handleRegister` method (lines 111-136) destructures `maxConnections` with a default of 20 but no validation:

```js
handleRegister(ws, message) {
  const { peerId, maxConnections = 20, publicKey } = message;
  // ...
  this.relayRegistry.register(peerId, { maxConnections, publicKey });
}
```

In `packages/server/src/relay-registry.js`, the `register` method (line 22) accepts `maxConnections` as-is:

```js
register(peerId, { maxConnections = 20, publicKey = null } = {}) {
  // ...
  this.peers.set(peerId, { peerId, maxConnections, ... });
}
```

Similarly, `handleUpdateLoad` (websocket-handler.js line 143-153) passes `connectedCount` directly to `updateLoad` without validation:

```js
handleUpdateLoad(ws, message) {
  const { peerId, connectedCount } = message;
  this.relayRegistry.updateLoad(peerId, connectedCount);
}
```

And `updateLoad` (relay-registry.js line 50-56) sets it directly:

```js
updateLoad(peerId, connectedCount) {
  const peer = this.peers.get(peerId);
  if (peer) {
    peer.connectedCount = connectedCount;
  }
}
```

The capacity calculation in `getAvailableRelays` (line 71) divides by `maxConnections`:
```js
const capacity = peer.connectedCount / peer.maxConnections;
```

If `maxConnections` is 0, this produces `Infinity`/`NaN`. If negative, the capacity check `< 0.5` always passes.

## Fix Steps

1. **Add validation in `websocket-handler.js` `handleRegister`** (after line 112):

```js
handleRegister(ws, message) {
  const { peerId, maxConnections = 20, publicKey } = message;

  if (!peerId) {
    this.sendError(ws, 'Missing required field: peerId');
    return;
  }

  // Validate maxConnections
  const maxConn = Number(maxConnections);
  if (!Number.isFinite(maxConn) || maxConn < 1 || maxConn > 1000) {
    this.sendError(ws, 'maxConnections must be a finite number between 1 and 1000');
    return;
  }

  this.wsConnections.set(peerId, ws);
  this.relayRegistry.register(peerId, { maxConnections: maxConn, publicKey });
  // ...
}
```

2. **Add validation in `websocket-handler.js` `handleUpdateLoad`** (after line 144):

```js
handleUpdateLoad(ws, message) {
  const { peerId, connectedCount } = message;

  if (!peerId) {
    this.sendError(ws, 'Missing required field: peerId');
    return;
  }

  const count = Number(connectedCount);
  if (!Number.isFinite(count) || count < 0 || count > 10000) {
    this.sendError(ws, 'connectedCount must be a finite non-negative number');
    return;
  }

  this.relayRegistry.updateLoad(peerId, count);
  // ...
}
```

3. **Add defensive validation in `relay-registry.js` `register` method** (line 22) as defense-in-depth:

```js
register(peerId, { maxConnections = 20, publicKey = null } = {}) {
  const maxConn = Math.max(1, Math.min(1000, Number(maxConnections) || 20));
  // ... use maxConn instead of maxConnections
}
```

## Testing

- Test `handleRegister` with valid `maxConnections` values (1, 20, 1000).
- Test with invalid values: 0, -1, `Infinity`, `NaN`, `"string"`, `null`, `undefined`, very large numbers.
- Verify that `getAvailableRelays` never produces `NaN` or `Infinity` capacity values.
- Test `handleUpdateLoad` with valid and invalid `connectedCount` values.

## Risk Assessment

- **Low risk**: The validation only rejects values that would cause incorrect behavior. Legitimate clients always send reasonable numeric values.
- **Dead code caveat**: `RelayRegistryDO` is currently dead code, but the validation should still be applied for correctness if the code is ever re-enabled.
- The upper bound of 1000 for `maxConnections` is a reasonable safety limit. If a legitimate use case needs more, the constant can be adjusted.
