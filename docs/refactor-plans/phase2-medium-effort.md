# Phase 2: Medium Effort Fixes

## Item 1: Split `app_providers.dart` (1024 lines → 9 domain files + barrel)

**Problem**: Monolithic provider file with 53 providers and 6 notifier classes, imported by 41 files.

### Provider Grouping

| New File | Contents | Est. Lines |
|----------|----------|-----------|
| `preferences_providers.dart` | sharedPreferencesProvider, themeModeProvider+Notifier, hasSeenOnboardingProvider, usernameProvider, userIdentityProvider | ~70 |
| `crypto_providers.dart` | cryptoServiceProvider, trustedPeersStorageProvider, bootstrapVerifierProvider | ~45 |
| `network_providers.dart` | meetingPointService, signalingClient, relayClient, reconnection, deviceLink, connectionManager, keyChangeStreamProvider, pendingKeyChangesProvider, linkedDevicesProvider, linkSessionStateProvider, webrtcService, bootstrapServerUrlProvider, serverDiscovery, discoveredServersProvider, selectedServer, signalingServerUrl, pairingCode, voipService, signalingConnected, signalingDisplayState | ~594 |
| `peer_providers.dart` | peersProvider, visiblePeersProvider, selectedPeerProvider, peerAliasesProvider, blockedPeersProvider+Notifier, blockedPeerDetailsProvider | ~210 |
| `chat_providers.dart` | messagesStreamProvider, messageStorageProvider, chatMessagesProvider+Notifier, lastMessageProvider, readReceiptServiceProvider | ~125 |
| `file_providers.dart` | fileReceiveServiceProvider, fileTransfersStreamProvider, fileStartsStreamProvider, fileChunksStreamProvider, fileCompletesStreamProvider | ~35 |
| `notification_providers.dart` | notificationSettingsProvider+Notifier, notificationServiceProvider | ~85 |
| `media_providers.dart` | backgroundBlurProvider, mediaServiceProvider, loggerServiceProvider | ~25 |
| `settings_providers.dart` | autoDeleteSettingsProvider+Notifier+Model, privacyScreenProvider+Notifier, activeScreenProvider+ActiveScreen, appInForegroundProvider | ~115 |

**Note**: `network_providers.dart` is the largest split file (~594 lines). If this is still too large, consider further splitting into `network_providers.dart` (signaling, relay, connection) and `device_link_providers.dart` (linked devices, link session state).

### Migration Strategy: Barrel Export Pattern

`app_providers.dart` becomes a barrel file — **zero changes needed in 41 importing files**:

```dart
// app_providers.dart — barrel file
export 'preferences_providers.dart';
export 'crypto_providers.dart';
export 'network_providers.dart';
export 'peer_providers.dart';
export 'chat_providers.dart';
export 'file_providers.dart';
export 'notification_providers.dart';
export 'media_providers.dart';
export 'settings_providers.dart';
```

### Circular Dependency Note

`network_providers.dart` uses `blockedPeersProvider` (from peer_providers) and `peer_providers.dart` uses `connectionManagerProvider` (from network_providers). Both files import each other directly (not via barrel) — Dart handles this fine at the library level.

### Steps

1. Create 9 new files in `lib/core/providers/`
2. Move each provider group with required imports
3. Replace `app_providers.dart` with barrel exports
4. Run `flutter analyze` + `flutter test test/`

**Risk**: Low with barrel pattern. Medium if circular imports aren't handled carefully.

---

## Item 2: Add Tests for `read_receipt_service`

**Service**: `lib/features/chat/services/read_receipt_service.dart` (85 lines)

**API**:
- Constructor: takes `ConnectionManager` + `MessageStorage`
- `start()`: subscribes to `connectionManager.receiptEvents`
- `sendReadReceipt(peerId)`: sends `rcpt:<timestamp>` via connection manager
- `_handleReceipt(peerId, payload)`: parses timestamp, calls `messageStorage.markMessagesAsRead()`
- `onStatusUpdated`: callback for UI refresh
- `dispose()`: cancels subscription

### Test File: `test/unit/chat/read_receipt_service_test.dart`

**Test cases**:
1. `start() subscribes to receiptEvents stream`
2. `sendReadReceipt() sends rcpt:<timestamp> to correct peer`
3. `sendReadReceipt() silently catches errors when peer is offline`
4. `receiving a valid receipt marks messages as read in storage`
5. `receiving a valid receipt calls onStatusUpdated callback with peerId`
6. `receiving a valid receipt with 0 updated rows does NOT call onStatusUpdated`
7. `receiving invalid (non-numeric) payload logs warning, does not update storage`
8. `dispose() cancels the subscription`
9. `multiple receipts from different peers handled independently`

**Mocking**: Use `StreamController<(String, String)>` to simulate `receiptEvents`.

**Risk**: Very Low — purely additive.

---

## Item 3: Add Tests for `typing_indicator_service`

**Service**: `lib/features/chat/services/typing_indicator_service.dart` (114 lines)

**API**:
- Constructor: takes `ConnectionManager`
- `start()`: subscribes to `connectionManager.typingEvents`
- `sendTyping(peerId)`: debounced (3 sec), sends `typ:start`
- `isTyping(peerId)`: returns current state
- `typingStates`: broadcast stream of `Map<String, bool>`
- Auto-expire: typing state clears after 5 seconds
- `dispose()`: cancels subscription, timers, closes controller

### Test File: `test/unit/chat/typing_indicator_service_test.dart`

**Test cases**:
1. `start() subscribes to typingEvents stream`
2. `receiving 'start' payload sets peer as typing`
3. `isTyping() returns true for typing peer, false for unknown`
4. `typingStates stream emits updated map`
5. `typing state auto-expires after 5 seconds` (use fakeAsync)
6. `consecutive 'start' events reset the 5-second timer`
7. `sendTyping() sends typ:start on first call`
8. `sendTyping() debounces — second call within 3 seconds suppressed`
9. `sendTyping() sends again after 3 seconds`
10. `dispose() cancels all timers and closes stream`

**Timer testing**: Use `fakeAsync` from `package:flutter_test`.

**Risk**: Very Low — purely additive.

---

## Item 4: Add TTL to Upstream Queues

**Problem**: Server queues upstream messages for offline channel owners (up to 100 per channel) with no expiration. If owner never reconnects, stale messages sit in memory forever.

**Current state** in `client/handler.ts`:
- Line 386: `upstreamQueues: Map<string, Array<{ data: object; timestamp: number }>>`
- Line 391: `MAX_UPSTREAM_QUEUE_SIZE = 100`
- Lines 1974-1985: Messages queued with `timestamp: Date.now()`
- Lines 1844-1850: All queued messages flushed on owner reconnect
- Line 2670-2702: `cleanup()` cleans stale rate limiters but NOT upstream queues

### Files to Modify

| File | Change |
|------|--------|
| `packages/server-vps/src/constants.ts` | Add `UPSTREAM_QUEUE = { MAX_QUEUE_SIZE: 100, TTL_MS: 5 * 60 * 1000 }` |
| `packages/server-vps/src/client/handler.ts` | Add TTL eviction to `cleanup()` method; filter stale messages on flush in `handleChannelOwnerRegister()` |

### Implementation Details

**In `cleanup()`** (line 2670), add after rate limiter cleanup:
```typescript
for (const [channelId, queue] of this.upstreamQueues) {
  const valid = queue.filter(item => now - item.timestamp < UPSTREAM_QUEUE.TTL_MS);
  if (valid.length === 0) {
    this.upstreamQueues.delete(channelId);
  } else {
    this.upstreamQueues.set(channelId, valid);
  }
}
```

**In `handleChannelOwnerRegister()`** flush (line 1845):
```typescript
const now = Date.now();
const valid = queue.filter(item => now - item.timestamp < UPSTREAM_QUEUE.TTL_MS);
for (const item of valid) { this.send(ws, item.data); }
this.upstreamQueues.delete(channelId);
```

### Tests to Add

In `tests/unit/client-handler-channels.test.ts`:
- `should expire queued upstream messages after TTL`
- `should not deliver expired messages when owner reconnects`
- `cleanup() should remove expired upstream queue entries`

Use `vi.useFakeTimers()` from vitest.

**Risk**: Low — additive behavior, existing queue behavior preserved for fresh messages.

---

## Item 5: Protect `/stats` Endpoint with Auth

**Problem**: `/stats` endpoint in `index.ts` (lines 108-127) is fully public. Exposes: serverId, nodeId, endpoint, region, uptime, connections, relay counts, active codes, collision risk.

**Existing auth infrastructure**: `admin/auth.ts` has `requireAuth(req, res, secret)` middleware.

### Files to Modify

| File | Change |
|------|--------|
| `packages/server-vps/src/index.ts` | Add `requireAuth` check to `/stats` and `/metrics` endpoints |

### Implementation

```typescript
import { requireAuth } from './admin/auth.js';

if (req.url === '/stats') {
  if (!config.admin.jwtSecret) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin not configured' }));
    return;
  }
  const auth = requireAuth(req, res, config.admin.jwtSecret);
  if (!auth) return; // requireAuth already sent 401
  // ... existing stats logic ...
}
```

Apply same to `/metrics` endpoint (lines 130-153).

**Note**: `/health` stays public — it's a simple availability check with no sensitive data.

### Tests

- `GET /stats without auth returns 401`
- `GET /stats with valid JWT returns 200`
- `GET /metrics without auth returns 401`

**Risk**: Low — operational endpoint. Verify no automated monitoring relies on unauthenticated `/stats` before deploying.

---

## Item 6: Fix CORS

**Problem**: `admin/routes.ts` line 27 falls back to wildcard CORS:
```typescript
res.setHeader('Access-Control-Allow-Origin', this.config.cfAdminUrl || '*');
```

Combined with `Access-Control-Allow-Credentials: true`, this is a security concern.

### Files to Modify

| File | Change |
|------|--------|
| `packages/server-vps/src/admin/routes.ts` | Remove `|| '*'` fallback; conditionally set CORS headers only when `cfAdminUrl` is configured |

### Implementation

```typescript
// Before:
res.setHeader('Access-Control-Allow-Origin', this.config.cfAdminUrl || '*');

// After:
if (this.config.cfAdminUrl) {
  res.setHeader('Access-Control-Allow-Origin', this.config.cfAdminUrl);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}
// No CORS headers = same-origin only (admin dashboard served from same origin)
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
```

### Tests

- `CORS headers set to cfAdminUrl when configured`
- `No wildcard CORS when cfAdminUrl is not set`
- `OPTIONS preflight returns 204 with correct headers`

**Risk**: Low — admin dashboard is served from same origin (`/admin/`). The CF admin URL, when configured, gets proper CORS.

---

## Dependencies and Execution Order

| Item | Dependencies | Parallelizable with |
|------|-------------|-------------------|
| 1 (Split providers) | None | Items 4, 5, 6 |
| 2 (Read receipt tests) | None | All |
| 3 (Typing tests) | None | All |
| 4 (TTL upstream) | None | Items 5, 6 |
| 5 (Auth /stats) | None | Items 4, 6 |
| 6 (Fix CORS) | None | Items 4, 5 |

### Recommended Waves

**Wave A** (parallel): Items 2, 3 (purely additive tests)
**Wave B** (parallel): Items 4, 5, 6 (server changes — can batch in one commit)
**Wave C**: Item 1 (provider split — most files touched, benefits from stable test suite)
