# Plan 13: Message Routing Separation

## Problem Statement

All WebRTC messages flow through a single broadcast `_messagesController` stream in
`ConnectionManager`. Different features filter by string prefix (`ginv:`, `grp:`, etc.)
to find their messages. This causes:

1. **Silent message loss** — Broadcast streams don't buffer. If a consumer isn't listening
   when a message arrives, it's gone forever. This caused the group invitation bug where
   `GroupInvitationService.start()` was never called.
2. **Every listener sees every message** — Three+ consumers each scan every message for
   their prefix, discarding 90%+ of what they receive.
3. **Fragile initialization order** — All consumers must attach before any messages arrive,
   or protocol messages are silently dropped.
4. **No separation of concerns** — `main.dart` must know about `ginv:` and `grp:` prefixes
   to skip them. Adding a new protocol prefix requires updating every consumer.

---

## Current Architecture

```
WebRTC data channel (per peer)
       │
       ▼
  WebRTCService._handleMessageChannelData()
       │
       ├─ Handshake JSON → onHandshakeComplete (separate path, OK)
       │
       └─ Encrypted message → decrypt → onMessage callback
              │
              ▼
    ConnectionManager.onMessage handler
              │
              ├─ link_* prefix → _handleLinkedDeviceMessage() ← properly routed
              │
              └─ EVERYTHING ELSE → _messagesController.add()  ← one firehose
                                          │
                          ┌────────────────┼────────────────┐
                          ▼                ▼                ▼
                    main.dart        GroupInvitation    WebRtcP2P
                    (notifs)         Service            Adapter
                    skips ginv/grp   filters ginv/grp   filters grp
```

### Message Prefixes in Use

| Prefix | Purpose | Current Consumer |
|--------|---------|------------------|
| `ginv:` | Group invitation JSON | `GroupInvitationService._handleInvitation()` |
| `grp:` | Group message data (base64 encrypted) | `GroupInvitationService._handleGroupData()` + `WebRtcP2PAdapter` |
| `link_` | Linked device proxy | `ConnectionManager._handleLinkedDeviceMessage()` |
| (none) | 1:1 chat plaintext | `main.dart` → persistence + notifications |

### Prefixes Reserved (Not Implemented)

| Prefix | Planned Purpose |
|--------|-----------------|
| `typ:` | Typing indicators |
| `rcpt:` | Read receipts |
| `grm:` | Group member removal |

### Channels (Separate Path)

Broadcast channels already have a completely separate data path:
- Communication via VPS relay WebSocket (not WebRTC data channels)
- Chunks announced/requested via signaling protocol messages
- Storage in dedicated `chunks` SQLite table
- No prefix routing needed — they don't share the WebRTC message stream

---

## Target Architecture

Route protocol messages at the `ConnectionManager` level — the same place `link_` is
already handled. Each message type gets a dedicated stream. No consumer needs to filter.

```
WebRTC data channel (per peer)
       │
       ▼
  WebRTCService.onMessage
       │
       ▼
  ConnectionManager.onMessage handler
       │
       ├─ link_*  → _handleLinkedDeviceMessage()          (existing, no change)
       │
       ├─ ginv:   → _groupInvitationController.add()      (NEW dedicated stream)
       │
       ├─ grp:    → _groupDataController.add()            (NEW dedicated stream)
       │
       ├─ typ:    → _typingController.add()               (NEW, future-ready)
       │
       ├─ rcpt:   → _receiptController.add()              (NEW, future-ready)
       │
       └─ (plain) → _peerMessageController.add()          (RENAMED, 1:1 only)
                          │
                          ▼
                    main.dart (notifs + persistence)
                    No prefix filtering needed.
```

### New Public API on ConnectionManager

```dart
/// 1:1 peer chat messages only (no protocol prefixes).
Stream<(String peerId, String message)> get peerMessages;

/// Group invitation payloads (ginv: prefix stripped).
Stream<(String peerId, String payload)> get groupInvitations;

/// Group message data (grp: prefix stripped, raw base64).
Stream<(String peerId, String payload)> get groupData;

/// Typing indicator events (typ: prefix stripped).
Stream<(String peerId, String payload)> get typingEvents;

/// Read receipt events (rcpt: prefix stripped).
Stream<(String peerId, String payload)> get receiptEvents;

/// Legacy: all messages (deprecated, kept for backward compatibility during migration).
@Deprecated('Use peerMessages, groupInvitations, or groupData instead')
Stream<(String peerId, String message)> get messages;
```

### Consumer Changes

| Consumer | Before | After |
|----------|--------|-------|
| `main.dart` notification listener | `messages.listen` + skip `ginv:`/`grp:` | `peerMessages.listen` (no filtering) |
| `GroupInvitationService.start()` | `messages.listen` + filter `ginv:`/`grp:` | `groupInvitations.listen` + `groupData.listen` |
| `WebRtcP2PAdapter` | `messages.listen` + filter `grp:` | `groupData.listen` (no filtering) |
| `ChatScreen` (future) | Uses provider chain | No change needed |

---

## Detailed Design

### 1. ConnectionManager Stream Controllers

Replace single `_messagesController` with dedicated controllers:

```dart
// 1:1 peer chat messages (plain text, no prefix)
final _peerMessageController =
    StreamController<(String peerId, String message)>.broadcast();

// Group invitations (ginv: prefix stripped)
final _groupInvitationController =
    StreamController<(String peerId, String payload)>.broadcast();

// Group message data (grp: prefix stripped)
final _groupDataController =
    StreamController<(String peerId, String payload)>.broadcast();

// Typing indicators (typ: prefix stripped) — future
final _typingController =
    StreamController<(String peerId, String payload)>.broadcast();

// Read receipts (rcpt: prefix stripped) — future
final _receiptController =
    StreamController<(String peerId, String payload)>.broadcast();

// Legacy catch-all (deprecated)
final _messagesController =
    StreamController<(String peerId, String message)>.broadcast();
```

### 2. Routing Logic in onMessage

```dart
_webrtcService.onMessage = (peerId, message) {
  final stableId = _toStableId(peerId);

  // Linked device proxy (existing)
  if (stableId.startsWith('link_')) {
    _handleLinkedDeviceMessage(stableId, message);
    return;
  }

  // Route by protocol prefix
  if (message.startsWith('ginv:')) {
    _groupInvitationController.add((stableId, message.substring(5)));
  } else if (message.startsWith('grp:')) {
    _groupDataController.add((stableId, message.substring(4)));
  } else if (message.startsWith('typ:')) {
    _typingController.add((stableId, message.substring(4)));
  } else if (message.startsWith('rcpt:')) {
    _receiptController.add((stableId, message.substring(5)));
  } else {
    // Plain 1:1 chat message
    _peerMessageController.add((stableId, message));
  }

  // Legacy stream (all messages, including prefixed — for backward compat)
  _messagesController.add((stableId, message));

  // Forward to linked devices (all message types)
  _deviceLinkService.broadcastToLinkedDevices(
    fromPeerId: stableId,
    plaintext: message,
  );
};
```

### 3. Consumer Updates

#### main.dart — Notification Listener

```dart
// BEFORE:
connectionManager.messages.listen((event) {
  final (peerId, message) = event;
  if (message.startsWith('ginv:') || message.startsWith('grp:')) return;
  // ... persist + notify
});

// AFTER:
connectionManager.peerMessages.listen((event) {
  final (peerId, message) = event;
  // No prefix filtering needed — only plain chat messages arrive here
  // ... persist + notify
});
```

#### GroupInvitationService.start()

```dart
// BEFORE:
void start() {
  _messageSub = _connectionManager.messages.listen((event) {
    final (peerId, message) = event;
    if (message.startsWith(_invitePrefix)) {
      _handleInvitation(peerId, message.substring(_invitePrefix.length));
    } else if (message.startsWith(_groupDataPrefix)) {
      _handleGroupData(peerId, message.substring(_groupDataPrefix.length));
    }
  });
}

// AFTER:
void start() {
  _inviteSub = _connectionManager.groupInvitations.listen((event) {
    final (peerId, payload) = event;
    _handleInvitation(peerId, payload);  // prefix already stripped
  });
  _groupDataSub = _connectionManager.groupData.listen((event) {
    final (peerId, payload) = event;
    _handleGroupData(peerId, payload);  // prefix already stripped
  });
}
```

#### WebRtcP2PAdapter

```dart
// BEFORE:
_messagesSub = _connectionManager.messages.listen((event) {
  final (deviceId, message) = event;
  if (!message.startsWith(_groupDataPrefix)) return;
  final payloadB64 = message.substring(_groupDataPrefix.length);
  // ...
});

// AFTER:
_messagesSub = _connectionManager.groupData.listen((event) {
  final (deviceId, payloadB64) = event;
  // prefix already stripped — process directly
  // ...
});
```

### 4. Cleanup on dispose()

```dart
Future<void> dispose() async {
  await _peerMessageController.close();
  await _groupInvitationController.close();
  await _groupDataController.close();
  await _typingController.close();
  await _receiptController.close();
  await _messagesController.close();  // legacy
  // ... existing dispose logic
}
```

### 5. Backward Compatibility

The legacy `messages` stream is kept as `@Deprecated` during migration. It continues
to emit all messages (prefixed and plain). This allows any missed consumers to keep
working while we migrate. Remove in a follow-up once all consumers are verified.

---

## What About Per-Entity Streams?

A further refinement would be per-entity streams:
- `peerMessagesFor(peerId)` — messages from one specific peer
- `groupMessagesFor(groupId)` — messages in one specific group
- `channelMessagesFor(channelId)` — messages in one specific channel

**Assessment**: Not needed at the routing layer.

- **Per-peer**: The UI already filters by peerId in `chatMessagesProvider(peerId)`.
  The persistence layer in main.dart must see all peers to save all messages.
- **Per-group**: GroupInvitationService already routes to the correct group by
  checking membership. The stream volume is low enough that filtering is fine.
- **Per-channel**: Already separate — channels use VPS relay, not WebRTC streams.

Per-entity streams would add complexity (dynamic stream creation/teardown) without
meaningful benefit. The per-type routing eliminates the real problems (silent loss,
universal filtering, fragile init order).

---

## Test Plan

### Unit Tests

1. **ConnectionManager routing tests**:
   - Verify `ginv:` message → `groupInvitations` stream (prefix stripped)
   - Verify `grp:` message → `groupData` stream (prefix stripped)
   - Verify `typ:` message → `typingEvents` stream (prefix stripped)
   - Verify `rcpt:` message → `receiptEvents` stream (prefix stripped)
   - Verify plain message → `peerMessages` stream (no prefix)
   - Verify `link_` peerId → `_handleLinkedDeviceMessage` (existing behavior)
   - Verify all messages also emit on legacy `messages` stream
   - Verify linked device broadcast receives all message types

2. **GroupInvitationService tests**:
   - Verify listens to `groupInvitations` stream (not `messages`)
   - Verify listens to `groupData` stream (not `messages`)
   - Verify prefix is already stripped (no double-stripping)

3. **WebRtcP2PAdapter tests**:
   - Verify listens to `groupData` stream (not `messages`)
   - Verify prefix is already stripped

4. **main.dart notification listener tests**:
   - Verify listens to `peerMessages` (not `messages`)
   - Verify `ginv:` messages do NOT arrive (no need to skip)
   - Verify `grp:` messages do NOT arrive (no need to skip)

### Integration Tests

5. **End-to-end message routing**:
   - Send plain text → arrives in peerMessages, persisted, notification shown
   - Send `ginv:` → arrives in groupInvitations, group created on receiver
   - Send `grp:` → arrives in groupData, decrypted and displayed
   - Verify no cross-contamination between streams

### Existing Tests

6. **All 1489 existing tests must pass** — no regression

---

## Implementation Steps

### Phase 1: Add Dedicated Streams (non-breaking)

1. Add new `StreamController`s to `ConnectionManager`
2. Add new public `Stream` getters
3. Add routing logic in `onMessage` handler (emit to both new + legacy streams)
4. Add `dispose()` cleanup for new controllers
5. Write unit tests for routing logic
6. **All existing tests pass** — legacy stream still works

### Phase 2: Migrate Consumers

7. Update `GroupInvitationService.start()` to use `groupInvitations` + `groupData`
8. Update `GroupInvitationService.dispose()` to cancel both subscriptions
9. Update `WebRtcP2PAdapter` to use `groupData`
10. Update `main.dart` `_setupNotificationListeners` to use `peerMessages`
11. Remove prefix-skip logic from main.dart
12. Update tests for changed consumer code
13. **All tests pass**

### Phase 3: Deprecate Legacy Stream

14. Mark `messages` getter as `@Deprecated`
15. Remove `groupInvitationServiceProvider` init line from `main.dart` (added in
    the bug fix) — the provider now subscribes to a dedicated stream that's
    properly initialized before messages flow. But actually, we still need the
    provider to be initialized at startup so the listener is attached. Keep it.
16. Verify no other code references `messages` stream
17. Run full test suite

### Phase 4: Future Protocol Messages (optional, later)

18. Implement `typ:` typing indicators using `typingEvents` stream
19. Implement `rcpt:` read receipts using `receiptEvents` stream
20. Each new protocol feature has a clean, dedicated stream from day one

---

## Files to Modify

| File | Change |
|------|--------|
| `lib/core/network/connection_manager.dart` | Add stream controllers, routing logic, public getters |
| `lib/features/groups/services/group_invitation_service.dart` | Use `groupInvitations` + `groupData` streams |
| `lib/features/groups/services/webrtc_p2p_adapter.dart` | Use `groupData` stream |
| `lib/main.dart` | Use `peerMessages` stream, remove prefix filtering |
| `test/` (various) | Update/add tests for new routing |

## Files NOT Modified

| File | Reason |
|------|--------|
| Channel services | Already on separate VPS relay path |
| WebRTCService | No change — still one message channel per peer, routing happens above |
| Group models/storage | No change — data models unchanged |
| Chat screen | No change — consumes via providers, not streams directly |

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Consumer misses messages during migration | Legacy `messages` stream kept during transition |
| Prefix stripping done twice | Tests verify payload arrives without prefix |
| New stream not listened to | Same risk as before — but now each stream has exactly one consumer, making it obvious |
| Linked device broadcast breaks | Broadcast happens before routing, using original message with prefix intact |
| Test coverage gap | Explicit routing tests for each prefix + each stream |
