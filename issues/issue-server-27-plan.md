# Plan: maxConnections value not validated in relay registration

**Retargeted**: This issue was originally identified in dead CF Worker code. The same vulnerability exists in the VPS server.

**Issue**: issue-server-27.md
**Severity**: MEDIUM
**Area**: Server (VPS)
**Files to modify**: `packages/server-vps/src/client/handler.ts`, `packages/server-vps/src/registry/relay-registry.ts`

## Analysis

In `packages/server-vps/src/client/handler.ts`, the `handleRegister` method (lines 726-766) destructures `maxConnections` with a default of 20 but no validation:

```ts
private async handleRegister(ws: WebSocket, message: RegisterMessage): Promise<void> {
  const { peerId, maxConnections = 20, publicKey } = message;
  // ...
  this.relayRegistry.register(peerId, {
    maxConnections,
    publicKey,
  });
}
```

In `packages/server-vps/src/registry/relay-registry.ts`, the `register` method (lines 41-65) accepts `maxConnections` as-is:

```ts
register(
  peerId: string,
  options: { maxConnections?: number; publicKey?: string | null } = {}
): void {
  const { maxConnections = 20, publicKey = null } = options;
  // ...
  const info: RelayInfo = {
    peerId,
    maxConnections,
    // ...
  };
  this.peers.set(peerId, info);
}
```

Similarly, `handleUpdateLoad` (handler.ts lines 771-787) passes `connectedCount` directly to `updateLoad` without validation:

```ts
private handleUpdateLoad(ws: WebSocket, message: UpdateLoadMessage): void {
  const { peerId, connectedCount } = message;
  // ...
  this.relayRegistry.updateLoad(peerId, connectedCount);
}
```

And `updateLoad` (relay-registry.ts lines 77-85) sets it directly:

```ts
updateLoad(peerId: string, connectedCount: number): boolean {
  const peer = this.peers.get(peerId);
  if (!peer) return false;
  peer.connectedCount = connectedCount;
  // ...
}
```

The capacity calculation in `getAvailableRelays` (relay-registry.ts line 97) divides by `maxConnections`:
```ts
const capacity = peer.connectedCount / peer.maxConnections;
```

If `maxConnections` is 0, this produces `Infinity`/`NaN`. If negative, the capacity check `< 0.5` always passes. The same issue exists in `getStats()` at line 151.

## Fix Steps

1. **Add validation in `handler.ts` `handleRegister`** (after line 727):

```ts
private async handleRegister(ws: WebSocket, message: RegisterMessage): Promise<void> {
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

  // ... rest uses maxConn instead of maxConnections
  this.relayRegistry.register(peerId, { maxConnections: maxConn, publicKey });
}
```

2. **Add validation in `handler.ts` `handleUpdateLoad`** (after line 772):

```ts
private handleUpdateLoad(ws: WebSocket, message: UpdateLoadMessage): void {
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

  // Update client's last seen
  const client = this.clients.get(peerId);
  if (client) {
    client.lastSeen = Date.now();
  }

  this.relayRegistry.updateLoad(peerId, count);
  // ...
}
```

3. **Add defensive validation in `relay-registry.ts` `register` method** (line 45) as defense-in-depth:

```ts
register(
  peerId: string,
  options: { maxConnections?: number; publicKey?: string | null } = {}
): void {
  const { maxConnections = 20, publicKey = null } = options;
  // Defense-in-depth: clamp maxConnections to valid range
  const maxConn = Math.max(1, Math.min(1000, Number(maxConnections) || 20));
  // ... use maxConn instead of maxConnections in the RelayInfo object
}
```

## Testing

- Test `handleRegister` with valid `maxConnections` values (1, 20, 1000).
- Test with invalid values: 0, -1, `Infinity`, `NaN`, `"string"`, `null`, `undefined`, very large numbers.
- Verify that `getAvailableRelays` never produces `NaN` or `Infinity` capacity values.
- Test `handleUpdateLoad` with valid and invalid `connectedCount` values.
- Verify that `getStats()` does not produce `NaN` or `Infinity` when iterating over peers.

## Risk Assessment

- **Low risk**: The validation only rejects values that would cause incorrect behavior. Legitimate clients always send reasonable numeric values.
- **Live code**: Unlike the original CF Worker target, this is live production code in the VPS server. The fix prevents real division-by-zero and capacity calculation bugs.
- The upper bound of 1000 for `maxConnections` is a reasonable safety limit. If a legitimate use case needs more, the constant can be adjusted.
