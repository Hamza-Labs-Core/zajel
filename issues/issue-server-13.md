# [HIGH] RendezvousRegistry allows unbounded meeting point and token registration

**Area**: Server
**File**: packages/server/src/rendezvous-registry.js:37-74, packages/server/src/websocket-handler.js:160-187
**Type**: Security

**Description**: The `registerDailyPoints` and `registerHourlyTokens` methods accept arrays of `points` and `tokens` respectively, with no limit on array size. A single WebSocket message with `type: 'register_rendezvous'` can include thousands of daily points and hourly tokens. The `WebSocketHandler.handleRegisterRendezvous` passes these arrays directly to the registry without validation.

Additionally, there is no limit on how many unique meeting points or tokens can exist in the Maps. The only cleanup is TTL-based expiration via the 5-minute alarm.

**Impact**:
- Memory exhaustion: A single malicious peer can register millions of meeting points, each creating a new Map entry with an array containing the peer's data.
- CPU exhaustion: Each registration iterates all existing entries at each point to find matches, making the operation O(points * entries_per_point).
- The 5-minute cleanup alarm iterates all entries, which becomes very slow with millions of entries.

**Fix**:
1. Limit the number of points/tokens per registration message (e.g., max 50).
2. Limit the total number of entries in each Map (e.g., max 100,000).
3. Validate in `handleRegisterRendezvous`:
```js
if (dailyPoints.length > 50 || hourlyTokens.length > 50) {
  this.sendError(ws, 'Too many points/tokens (max 50 each)');
  return;
}
```
