# Plan: RendezvousRegistry allows unbounded meeting point and token registration

**Issue**: issue-server-13.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/websocket-handler.js`
- `packages/server/src/rendezvous-registry.js`

## Analysis

In `packages/server/src/websocket-handler.js`:
- `handleRegisterRendezvous()` (lines 160-187): Accepts `dailyPoints` and `hourlyTokens` arrays from the message (line 163-164) and passes them directly to the registry methods with no size validation.

In `packages/server/src/rendezvous-registry.js`:
- `registerDailyPoints()` (lines 37-73): Iterates `points` array without checking its length. Each point creates a Map entry.
- `registerHourlyTokens()` (lines 84-127): Iterates `tokens` array without checking its length.
- Both Maps (`dailyPoints` and `hourlyTokens`) have no size cap.
- Cleanup runs every 5 minutes via the alarm in `relay-registry-do.js` line 52, but only removes expired entries, not excessive ones.
- For each point/token, the code iterates all existing entries at that key (lines 49-57, 98-111), making registration O(points * entries_per_point).

## Fix Steps

1. **Add array size validation in `handleRegisterRendezvous()` (websocket-handler.js, after line 167)**:
   ```js
   // Limit arrays to prevent abuse
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

2. **Validate array element types** in `handleRegisterRendezvous()`:
   ```js
   if (!Array.isArray(dailyPoints) || !dailyPoints.every(p => typeof p === 'string' && p.length <= 128)) {
     this.sendError(ws, 'Invalid daily points format');
     return;
   }
   if (!Array.isArray(hourlyTokens) || !hourlyTokens.every(t => typeof t === 'string' && t.length <= 128)) {
     this.sendError(ws, 'Invalid hourly tokens format');
     return;
   }
   ```

3. **Add global size caps in `rendezvous-registry.js`**:
   - Add constants at the top of the class:
     ```js
     this.MAX_DAILY_POINTS = 100000;
     this.MAX_HOURLY_TOKENS = 100000;
     ```
   - In `registerDailyPoints()` (before line 42):
     ```js
     if (this.dailyPoints.size >= this.MAX_DAILY_POINTS) {
       return { deadDrops: [], error: 'Daily points registry full' };
     }
     ```
   - In `registerHourlyTokens()` (before line 91):
     ```js
     if (this.hourlyTokens.size >= this.MAX_HOURLY_TOKENS) {
       return { liveMatches: [], error: 'Hourly tokens registry full' };
     }
     ```

4. **Validate `deadDrop` and `relayId` field sizes** in `handleRegisterRendezvous()`:
   ```js
   if (deadDrop && (typeof deadDrop !== 'string' || deadDrop.length > 4096)) {
     this.sendError(ws, 'Dead drop payload too large (max 4KB)');
     return;
   }
   if (relayId && (typeof relayId !== 'string' || relayId.length > 128)) {
     this.sendError(ws, 'Invalid relayId');
     return;
   }
   ```

## Testing

- Verify that registration with <= 50 daily points and <= 50 hourly tokens succeeds.
- Verify that registration with > 50 points/tokens is rejected.
- Verify that non-string or overly long point/token values are rejected.
- Verify that the global size cap prevents excessive entries.
- Verify that existing rendezvous matching logic still works.
- Run existing rendezvous tests.

## Risk Assessment

- **Client compatibility**: Verify the Flutter app's rendezvous registration sends <= 50 points/tokens per message. If the client sends more, increase the limit or have the client batch registrations.
- **Global cap impact**: A global cap of 100,000 entries per Map should be far more than needed for normal operation. If reached, it indicates either a bug or an attack.
- **Performance at scale**: Even with limits, iterating entries per point (lines 49-57) is O(entries_per_point). This is acceptable with the per-message limit since each point typically has very few entries.
