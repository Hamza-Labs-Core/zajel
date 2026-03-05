# Story 001: Fix Federation Reconnect Bug

## Priority: IMMEDIATE
## Severity: HIGH
## Component: packages/server-vps

## Summary

The federation reconnect logic in `ServerConnectionManager.handleDisconnect()` contains a contradictory conditional that prevents reconnection from ever being attempted when `maxReconnectAttempts` is set to `0` (the documented convention for "infinite retries"). This means that if a federation peer disconnects for any reason, the VPS server will never attempt to re-establish the connection, silently degrading the federation mesh until a full server restart.

## Current Behavior

In `packages/server-vps/src/federation/transport/server-connection.ts`, lines 486-493, the reconnect logic reads:

```typescript
// Only attempt reconnect for outgoing connections
if (conn.isOutgoing && this.config.maxReconnectAttempts !== 0) {
  if (
    this.config.maxReconnectAttempts === 0 ||
    conn.reconnectAttempts < this.config.maxReconnectAttempts
  ) {
    this.scheduleReconnect(conn.entry, conn.reconnectAttempts + 1);
  }
}
```

The outer guard on line 486 (`this.config.maxReconnectAttempts !== 0`) evaluates to `false` when `maxReconnectAttempts` is `0`, which is the value that means "infinite retries" per the interface doc on line 26 (`maxReconnectAttempts: number; // 0 = infinite`). The entire reconnect block is skipped. The inner condition on line 488 (`this.config.maxReconnectAttempts === 0`) would correctly allow infinite retries, but it is never reached.

In `packages/server-vps/src/index.ts`, line 217, the production configuration explicitly sets:

```typescript
transport: {
  // ...
  maxReconnectAttempts: 0, // Infinite
},
```

This confirms that every production deployment uses the value `0`, meaning no VPS server in the federation ever reconnects after a disconnect.

## Expected Behavior

When `maxReconnectAttempts` is `0`, the server should retry reconnection indefinitely with exponential backoff. When `maxReconnectAttempts` is a positive integer N, the server should retry up to N times and then stop. The outer guard should only prevent reconnection when reconnects are explicitly disabled (which would require a different sentinel value, or removing the outer guard entirely since the inner condition already handles both cases).

## Root Cause Analysis

The developer who wrote the outer guard (`!== 0`) likely intended it to mean "if reconnection is not disabled" but chose `0` as both the "infinite" sentinel and the "disabled" value. The result is a logical contradiction:

1. The interface documents `0 = infinite` (line 26).
2. The outer guard treats `0` as "disabled" (line 486: `!== 0` fails when value is `0`).
3. The inner guard treats `0` as "infinite" (line 488: `=== 0` would allow unlimited retries).

The outer guard makes the inner guard dead code for the `0` case. This is a classic off-by-one-style semantic bug where two different parts of the same function disagree on the meaning of a sentinel value.

The code flow when a peer disconnects:
1. `handleDisconnect()` is called (line 476)
2. Connection is cleaned up and removed from the map (lines 480-481)
3. `'disconnected'` event is emitted (line 483)
4. The reconnect check on line 486 evaluates `0 !== 0` which is `false`
5. No reconnect is scheduled -- the peer is permanently lost

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server-vps/src/federation/transport/server-connection.ts` | 26 | Interface documenting `0 = infinite` |
| `packages/server-vps/src/federation/transport/server-connection.ts` | 486-493 | Contradictory reconnect conditional |
| `packages/server-vps/src/federation/transport/server-connection.ts` | 499-513 | `scheduleReconnect()` -- never called in production |
| `packages/server-vps/src/index.ts` | 217 | Production config setting `maxReconnectAttempts: 0` |

## Reproduction Steps

1. Deploy two VPS federation servers with the default config (`maxReconnectAttempts: 0`).
2. Allow them to establish a federation connection.
3. Forcibly terminate one server's process (or simulate a network partition).
4. Restart the terminated server.
5. Observe that the surviving server never attempts to reconnect to the restarted peer.
6. The federation link is permanently severed until both servers are restarted, or the bootstrap heartbeat re-discovers the peer and calls `addDiscoveredPeer()`.

## Impact Assessment

- **Federation resilience is broken**: Any transient network disruption (brief DNS failure, TCP reset, cloud provider maintenance) permanently severs federation links. The SWIM gossip protocol will eventually mark the peer as failed, but the transport layer never attempts reconnection.
- **Silent degradation**: There are no errors or warnings logged when reconnection is skipped. The server simply forgets about the peer. Operators have no indication that the mesh is degrading.
- **Partial mitigation via bootstrap heartbeat**: The bootstrap heartbeat in `index.ts` (line 404) periodically discovers peers and calls `addDiscoveredPeer()`, which may re-establish connections. However, this depends on the bootstrap server being available and has a longer delay (heartbeat interval) compared to the intended exponential backoff reconnect.
- **Denial of Service amplifier**: An attacker who can cause brief connection resets between federation peers can permanently partition the mesh without sustained effort.

## Proposed Fix

Remove the outer guard entirely. The inner conditional already correctly handles both cases (`0` for infinite, positive integer for bounded retries):

```typescript
private handleDisconnect(serverId: string, code: number, reason: string): void {
  const conn = this.connections.get(serverId);
  if (!conn) return;

  this.cleanupConnection(serverId, conn);
  this.connections.delete(serverId);

  this.emit('disconnected', serverId, code, reason);

  // Only attempt reconnect for outgoing connections
  if (conn.isOutgoing) {
    if (
      this.config.maxReconnectAttempts === 0 ||
      conn.reconnectAttempts < this.config.maxReconnectAttempts
    ) {
      this.scheduleReconnect(conn.entry, conn.reconnectAttempts + 1);
    }
  }
}
```

Alternatively, if a "disable reconnection" sentinel is needed, use `-1` or `Infinity` or a separate boolean flag, and update the interface documentation accordingly.

## Acceptance Criteria

- [ ] When `maxReconnectAttempts` is `0`, the server retries reconnection indefinitely with exponential backoff.
- [ ] When `maxReconnectAttempts` is a positive integer N, the server retries exactly N times then stops.
- [ ] After a transient peer disconnect, the surviving server successfully reconnects within the backoff window.
- [ ] Reconnection attempts are logged at info level so operators can observe recovery.
- [ ] The `ServerConnectionConfig` interface documentation accurately describes the semantics of `maxReconnectAttempts`.

## Test Requirements

- **Unit test**: Create a test for `handleDisconnect()` with `maxReconnectAttempts = 0` that verifies `scheduleReconnect()` is called.
- **Unit test**: Create a test with `maxReconnectAttempts = 3` that verifies reconnect stops after 3 attempts.
- **Unit test**: Verify that incoming connections (`isOutgoing = false`) never trigger reconnection regardless of config.
- **Integration test**: Start two federation servers, disconnect one, verify the other reconnects within the expected backoff window.

## Dependencies

- None. This is a self-contained bug fix.
