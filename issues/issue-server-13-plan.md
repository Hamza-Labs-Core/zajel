# Plan: Unbounded rendezvous registration allows memory/storage exhaustion

**Retargeted**: This issue was originally identified in dead CF Worker code (`packages/server/src/websocket-handler.js` and `packages/server/src/rendezvous-registry.js`). The same vulnerability exists in the VPS server.

**Issue**: issue-server-13.md
**Severity**: HIGH
**Area**: Server (VPS)
**Files to modify**:
- `packages/server-vps/src/client/handler.ts`
- `packages/server-vps/src/registry/rendezvous-registry.ts`
- `packages/server-vps/src/registry/distributed-rendezvous.ts`

## Analysis

In `packages/server-vps/src/client/handler.ts`:
- `handleRegisterRendezvous()` (lines 795-897): Accepts `dailyPoints` and `hourlyTokens` arrays from the message at lines 802-803:
  ```ts
  const dailyPoints = message.dailyPoints || message.daily_points || [];
  const hourlyTokens = message.hourlyTokens || message.hourly_tokens || [];
  ```
  These arrays are passed to the distributed rendezvous layer with **no size validation** on the array length.
- The method also accepts `deadDropsMap` (line 807-808) and `legacyDeadDrop` (line 809) without validating payload sizes.
- When `hasPerPointDeadDrops` is true (line 824), the method iterates all points at lines 838-847, calling `this.distributedRendezvous.registerDailyPoints()` for each point with a dead drop. An attacker sending 100,000 points would trigger 100,000 individual registration calls.

In `packages/server-vps/src/registry/distributed-rendezvous.ts`:
- `registerDailyPoints()` (line 63): Accepts the points array and iterates each point at line 76 to determine routing, then passes local points to the underlying registry. No size cap on the input.
- `registerHourlyTokens()`: Similarly has no size cap.

In `packages/server-vps/src/registry/rendezvous-registry.ts`:
- Uses SQLite storage for persistence. Each daily point and hourly token creates a database row via `storage.saveDailyPoint()` and `storage.saveHourlyToken()`.
- The in-memory `hourlyCache` Map (line 48) grows unbounded as tokens are registered.
- Cleanup runs periodically (configured via `config.cleanup.interval` in index.ts line 364) but only removes expired entries, not excessive ones.

## Fix Steps

1. **Add array size validation in `handleRegisterRendezvous()` (handler.ts, after line 803)**:
   ```ts
   const MAX_POINTS_PER_MESSAGE = 50;
   const MAX_TOKENS_PER_MESSAGE = 50;

   if (dailyPoints.length > MAX_POINTS_PER_MESSAGE) {
     this.sendError(ws, `Too many daily points (max ${MAX_POINTS_PER_MESSAGE})`);
     return;
   }
   if (hourlyTokens.length > MAX_TOKENS_PER_MESSAGE) {
     this.sendError(ws, `Too many hourly tokens (max ${MAX_TOKENS_PER_MESSAGE})`);
     return;
   }
   ```

2. **Validate array element types** in `handleRegisterRendezvous()` (after the size check):
   ```ts
   if (!Array.isArray(dailyPoints) || !dailyPoints.every(p => typeof p === 'string' && p.length <= 128)) {
     this.sendError(ws, 'Invalid daily points format');
     return;
   }
   if (!Array.isArray(hourlyTokens) || !hourlyTokens.every(t => typeof t === 'string' && t.length <= 128)) {
     this.sendError(ws, 'Invalid hourly tokens format');
     return;
   }
   ```

3. **Validate `deadDropsMap` entries** in `handleRegisterRendezvous()`:
   ```ts
   // Validate dead drops map size and values
   if (Object.keys(deadDropsMap).length > MAX_POINTS_PER_MESSAGE) {
     this.sendError(ws, 'Too many dead drops');
     return;
   }
   for (const [key, value] of Object.entries(deadDropsMap)) {
     if (typeof key !== 'string' || key.length > 128) {
       this.sendError(ws, 'Invalid dead drop key');
       return;
     }
     if (typeof value !== 'string' || value.length > 4096) {
       this.sendError(ws, 'Dead drop payload too large (max 4KB)');
       return;
     }
   }
   ```

4. **Validate `legacyDeadDrop` and `relayId` field sizes** in `handleRegisterRendezvous()`:
   ```ts
   if (legacyDeadDrop && (typeof legacyDeadDrop !== 'string' || legacyDeadDrop.length > 4096)) {
     this.sendError(ws, 'Dead drop payload too large (max 4KB)');
     return;
   }
   if (relayId && (typeof relayId !== 'string' || relayId.length > 128)) {
     this.sendError(ws, 'Invalid relayId');
     return;
   }
   ```

5. **Add per-peer registration limits** in `RendezvousRegistry`:
   - Track how many points/tokens each peer has registered.
   - Reject registrations that would exceed a per-peer cap (e.g., 500 points and 500 tokens per peer).
   - This prevents a single peer from monopolizing storage even with many small batched registrations.

## Testing

- Verify that registration with <= 50 daily points and <= 50 hourly tokens succeeds.
- Verify that registration with > 50 points/tokens is rejected with an error message.
- Verify that non-string or overly long point/token values are rejected.
- Verify that dead drop payloads > 4KB are rejected.
- Verify that existing rendezvous matching logic still works after adding validation.
- Run existing rendezvous tests.

## Risk Assessment

- **Client compatibility**: Verify the Flutter app's rendezvous registration sends <= 50 points/tokens per message. If the client sends more, increase the limit or have the client batch registrations across multiple messages.
- **Per-peer limits vs per-message limits**: Both are needed. The per-message limit prevents a single large message from overwhelming the server. The per-peer limit (implemented in the registry) prevents accumulated abuse across many small messages.
- **SQLite storage implications**: Unlike the CF Worker's in-memory Maps, the VPS uses SQLite for persistence. Unbounded writes can exhaust disk space and slow down queries. The per-message and per-peer limits protect both memory and disk.
- **Performance at scale**: The dead drops map iteration at lines 838-847 calls `registerDailyPoints()` once per point with a dead drop. With the 50-point limit, this is at most 50 calls per message, which is acceptable.
