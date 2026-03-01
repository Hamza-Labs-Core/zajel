# Phase 3: Major Refactors

## Item 1: Break up `_ZajelAppState` (1155 lines → thin orchestrator + 7 services)

**Problem**: `main.dart` `_ZajelAppState` handles initialization, lifecycle, notifications, deep links, connectivity, pairing, VoIP, auto-delete, and privacy — massive SRP violation.

### Current Responsibilities (lines in main.dart)

| Responsibility | Lines | Approx Size |
|---------------|-------|-------------|
| Initialization | 157-296 | 140 lines |
| Lifecycle management | 113-141 | 30 lines |
| Signaling reconnection | 298-434 | 137 lines |
| File transfer listeners | 436-506 | 70 lines |
| Pair/link request dialogs | 508-755 | 248 lines |
| Notification listeners | 757-840 | 83 lines |
| VoIP call handling | 843-996 | 154 lines |
| Auto-delete timer | 1016-1062 | 47 lines |
| Privacy/security | 998-1014 | 17 lines |

### Extraction Plan

| New File | Extracts | Key State Owned |
|----------|----------|----------------|
| `lib/core/services/app_initialization_service.dart` | `_initialize()`, `_connectToSignaling()` | Init result state |
| `lib/core/services/signaling_reconnect_service.dart` | `_setupSignalingReconnect` | `_signalingReconnectSubscription`, `_isReconnecting` |
| `lib/core/services/file_transfer_listener.dart` | `_setupFileTransferListeners` | 3 stream subscriptions |
| `lib/core/services/pair_request_handler.dart` | Pair/link request dialogs | Dialog state, NavigatorState key |
| `lib/core/services/notification_listener_service.dart` | `_setupNotificationListeners`, `_setupPeerStatusNotifications` | Message notification subscription |
| `lib/core/services/voip_call_handler.dart` | `_setupVoipCallListener`, `_showIncomingCallDialog` | VoIP subscription, dialog state |
| `lib/core/services/auto_delete_service.dart` | `_startAutoDeleteTimer`, `_runAutoDeleteCleanup` | Timer |

### Resulting `_ZajelAppState` (~150-200 lines)

```dart
class _ZajelAppState extends ConsumerState<ZajelApp> with WidgetsBindingObserver {
  bool _initialized = false;
  bool _disposed = false;
  bool _showPrivacyScreen = false;
  ConnectionManager? _connectionManager;

  late final SignalingReconnectService _reconnectService;
  late final FileTransferListener _fileTransferListener;
  late final PairRequestHandler _pairRequestHandler;
  late final NotificationListenerService _notificationListener;
  late final VoipCallHandler _voipCallHandler;
  late final AutoDeleteService _autoDeleteService;

  @override
  void initState() { ... }    // ~10 lines: create services
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) { ... }  // ~15 lines (kept inline)
  @override
  void dispose() { ... }      // ~15 lines: dispose all services
  @override
  Widget build(BuildContext context) { ... }  // ~30 lines (unchanged)
}
```

### Migration Path

Extract one service at a time, test after each:

1. `AutoDeleteService` (simplest, no UI, standalone timer)
2. `FileTransferListener` (stream subscriptions, no UI)
3. `NotificationListenerService` (stream subscriptions, no UI)
4. `SignalingReconnectService` (complex state, no UI)
5. `PairRequestHandler` (has dialog UI builders)
6. `VoipCallHandler` (has dialog UI and navigation)
7. `AppInitializationService` (orchestrates everything)
8. Slim down `_ZajelAppState`

### Tests

| File | Coverage |
|------|----------|
| `test/unit/services/app_initialization_service_test.dart` | Init order, failure handling |
| `test/unit/services/signaling_reconnect_service_test.dart` | Exponential backoff, max retries, disposed-during-reconnect |
| `test/unit/services/auto_delete_service_test.dart` | Timer scheduling, cleanup logic |

**Risk**: Low — pure extraction, no behavior changes. Run analyze + test after each service.

---

## Item 2: Break up `ConnectionManager` (1626 lines → facade + 6 sub-services)

**Problem**: `connection_manager.dart` manages WebRTC, signaling, state machines, file transfer, encryption, reconnection — too many responsibilities in the app's central nervous system.

### Current Responsibilities

| Responsibility | Lines | Approx Size |
|---------------|-------|-------------|
| Pairing code utilities | 1-73 | 73 lines |
| Signaling state types | 79-91 | 13 lines |
| Stream controllers (11+) | 112-145, 326, 334, 342 | 40+ lines (scattered) |
| Connection lifecycle | 191-440 | 250 lines |
| WebRTC coordination | 523-601 | 79 lines |
| Message routing | 671-812 | 142 lines |
| Signaling message handling | 859-1096 | 238 lines |
| Key rotation | 1122-1168 | 47 lines |
| Meeting point / reconnection | 1180-1598 | 419 lines |
| Linked device support | 814-857 | 44 lines |

### Extraction Plan

| New File | Extracts | State Owned |
|----------|----------|-------------|
| `lib/core/network/pairing_code_utils.dart` | Code generation, validation | None (pure functions) |
| `lib/core/network/message_router.dart` | Protocol prefix routing (`ginv:`, `grp:`, `typ:`, `rcpt:`) + all 11 broadcast stream controllers (including `_pairRequestController`, `_keyChangeController`, `_linkRequestController` which are currently scattered outside lines 112-145) | Stream controllers for events |
| `lib/core/network/signaling_message_handler.dart` | `_handleSignalingMessage` switch statement | None (delegates via callbacks) |
| `lib/core/network/peer_state_manager.dart` | `_peers` map, `_updatePeerState`, `_notifyPeersChanged` | Peers map, peers stream controller |
| `lib/core/network/redirect_connection_manager.dart` | Redirect server connections, cross-server pairing | `_redirectConnections`, `_peerToClient` maps |
| `lib/core/network/key_rotation_detector.dart` | `_checkKeyRotation` TOFU model | None (emits events) |

### Resulting `ConnectionManager`

Public API stays IDENTICAL — same streams, methods, properties:

```dart
class ConnectionManager {
  final CryptoService _cryptoService;
  final WebRTCService _webrtcService;
  final DeviceLinkService _deviceLinkService;
  final MessageRouter _messageRouter;
  final PeerStateManager _peerStateManager;
  final KeyRotationDetector _keyRotationDetector;
  final RedirectConnectionManager _redirectManager;
  final SignalingMessageHandler _signalingHandler;
  // ... delegates to sub-services
}
```

### Migration Path

1. Extract `PairingCodeUtils` (zero coupling, pure functions)
2. Extract `MessageRouter` (stream controllers move)
3. Extract `PeerStateManager` (peers map moves)
4. Extract `KeyRotationDetector` (small, isolated)
5. Extract `RedirectConnectionManager` (self-contained subsystem)
6. Extract `SignalingMessageHandler` (depends on above)
7. Verify all existing tests pass

### Tests

| File | Coverage |
|------|----------|
| `test/unit/network/pairing_code_utils_test.dart` | Validation, generation, character set |
| `test/unit/network/message_router_test.dart` | Protocol prefix routing |
| `test/unit/network/peer_state_manager_test.dart` | State transitions, trusted peer loading |
| `test/unit/network/key_rotation_detector_test.dart` | TOFU detection logic |

**Risk**: Medium — ConnectionManager is the central nervous system. Must keep public API contract identical. Existing tests + integration tests serve as regression guards.

---

## Item 3: Break up `ClientHandler` on Server (2820 lines → facade + 8 sub-handlers)

**Problem**: `client/handler.ts` handles ALL message types, routing, and state in a single class.

### Current Handler Groups

| Group | Lines | Approx Size |
|-------|-------|-------------|
| Type definitions | 1-306 | 306 lines |
| Registration & connection | 320-513 | 194 lines |
| Message routing | 586-769 | 184 lines |
| Relay registration | 774-867 | 94 lines |
| Rendezvous | 875-1030 | 156 lines |
| Pairing | 1083-1460 | 378 lines |
| Device linking | 1462-1670 | 209 lines |
| Signaling forwarding | 1672-1714 | 43 lines |
| Call signaling | 1716-1824 | 109 lines |
| Channels/streaming | 1826-2119 | 294 lines |
| Attestation | 2121-2252 | 132 lines |
| Chunks | 2254-2426 | 173 lines |
| Disconnect/cleanup | 2438-2565 | 128 lines |
| Utilities | 2567-2820 | 254 lines |

### Extraction Plan

| New File | Extracts | State Owned |
|----------|----------|-------------|
| `src/client/types.ts` | All message type interfaces, `ClientMessage` union | None |
| `src/client/context.ts` | `HandlerContext` interface (shared state access) | None |
| `src/client/pairing-handler.ts` | Pairing code register, pair request/response, expiry | `pendingPairRequests`, timers, entropy |
| `src/client/link-handler.ts` | Link request/response, expiry | `pendingLinkRequests`, timers |
| `src/client/signaling-forwarder.ts` | Signaling + call signaling forwarding | None (stateless relay) |
| `src/client/channel-handler.ts` | Channel owner/subscribe, upstream, streaming | `channelOwners`, `channelSubscribers`, `activeStreams`, `upstreamQueues` |
| `src/client/attestation-handler.ts` | Attest request/response | `wsToConnectionId` |
| `src/client/relay-handler.ts` | Register, updateLoad, rendezvous, getRelays, heartbeat | None (uses shared maps) |

### `HandlerContext` Interface

```typescript
interface HandlerContext {
  identity: ServerIdentity;
  endpoint: string;
  pairingCodeToWs: Map<string, WebSocket>;
  wsToPairingCode: Map<WebSocket, string>;
  pairingCodeToPublicKey: Map<string, string>;
  clients: Map<string, ClientInfo>;
  wsToClient: Map<WebSocket, string>;
  send(ws: WebSocket, message: object): boolean;
  sendError(ws: WebSocket, message: string): void;
  notifyClient(peerId: string, message: object): boolean;
}
```

### Migration Path

1. Create `types.ts` (move all interfaces)
2. Create `context.ts` (define shared interface)
3. Extract `SignalingForwarder` (stateless, lowest risk)
4. Extract `PairingHandler` (most tested)
5. Extract `LinkHandler`
6. Extract `ChannelHandler`
7. Extract `AttestationHandler`
8. Extract `RelayHandler`
9. Refactor `handleMessage` to delegate
10. Refactor `handleDisconnect` to delegate cleanup

### Tests

Existing test files provide regression coverage:
- `tests/unit/client-handler-pairing.test.ts`
- `tests/unit/client-handler-channels.test.ts`
- `tests/unit/client-handler-call-signaling.test.ts`
- `tests/unit/client-handler-chunks.test.ts`

New tests:
- `tests/unit/link-handler.test.ts`
- `tests/unit/signaling-forwarder.test.ts`

**Risk**: Medium — `HandlerContext` interface is the key risk. All existing tests serve as regression guards.

---

## Item 4: Add Forward Secrecy (Key Rotation Mechanism)

**Problem**: Session keys persist until peer disconnects. No forward secrecy — compromise of one key exposes all past messages.

**Constraint**: Do NOT use Signal Protocol (AGPL-licensed). Design simpler mechanism.

### Design: Two-Phase Approach

#### Phase A: Per-Session Ephemeral Keys (basic forward secrecy)

At WebRTC handshake:
1. Both peers generate ephemeral X25519 key pairs
2. Exchange ephemeral public keys alongside identity public keys
3. Session key = `HKDF(identity_ECDH || ephemeral_ECDH, "zajel_session_v2")`
4. Ephemeral private keys deleted immediately
5. If identity key compromised later, past sessions can't be decrypted

**Extended handshake format**:
```json
{
  "type": "handshake",
  "publicKey": "<identity_public_key_base64>",
  "ephemeralKey": "<ephemeral_public_key_base64>",
  "username": "Alice",
  "stableId": "AB12CD34EF567890",
  "ratchetVersion": 1
}
```

#### Phase B: In-Session Ratchet (ongoing forward secrecy)

Every N messages (default 100) or T minutes (default 30):
1. Initiator generates random 32-byte nonce
2. Sends `ratchet:<base64 JSON>` control message
3. Both sides: `new_key = HKDF(current_key || nonce, info="zajel_ratchet")`
4. Old key securely deleted (kept briefly for grace messages)

**Ratchet control message**:
```json
{
  "type": "key_ratchet",
  "nonce": "<32-byte nonce base64>",
  "epoch": 5,
  "version": 1
}
```

### Files to Create/Modify

| File | Change |
|------|--------|
| `lib/core/crypto/key_ratchet.dart` | **NEW** — `KeyRatchet` class: schedule, nonce generation, threshold logic |
| `lib/core/protocol/ratchet_protocol.dart` | **NEW** — Wire format, version negotiation |
| `lib/core/crypto/crypto_service.dart` | Add `deriveSessionKeyWithEphemeral()`, `ratchetSessionKey()`, `_previousSessionKeys` grace map |
| `lib/core/network/webrtc_service.dart` | Extend handshake for ephemeral key exchange; handle `ratchet:` messages |
| `lib/core/network/connection_manager.dart` | Add `ratchet:` prefix to message router |

### Backward Compatibility

- `ratchetVersion` field enables opt-in negotiation
- Missing `ephemeralKey` in handshake → fall back to current static key behavior
- Old clients work, just without forward secrecy

### Tests

| File | Coverage |
|------|----------|
| `test/unit/crypto/key_ratchet_test.dart` | Schedule, threshold, nonce generation |
| `test/unit/crypto/ephemeral_key_exchange_test.dart` | Dual ECDH derivation, key consistency |
| `test/unit/crypto/forward_secrecy_test.dart` | Old key deletion, grace period |
| `test/unit/crypto/ratchet_protocol_test.dart` | Wire format, backward compatibility |

**Risk**: HIGH — crypto layer changes can break all peer communication. Implement behind feature flag (`ratchetVersion`), extensive deterministic testing, update headless client too.

---

## Item 5: Comprehensive ConnectionManager Tests

**Current coverage**: ~10% (181 lines testing 1626-line class). Only basic init, pairing code validation, stream existence, dispose.

### Test Groups to Add

| Group | Tests | Priority |
|-------|-------|----------|
| **Signaling Connection Lifecycle** | connect, disconnect, reconnect, pairing code reuse | High |
| **Peer Management** | code validation, state transitions, pair accept/reject, redirect routing | High |
| **Signaling Message Handling** | PairIncoming, PairMatched, PairRejected, PairTimeout, Offer/Answer/ICE, Link events | High |
| **WebRTC Callbacks** | handshake complete, message routing (ginv/grp/typ/rcpt), state changes, linked devices | High |
| **File Transfer** | chunk/start/complete translation, sendFile delegation | Medium |
| **Key Rotation** | new key detection, storage recording, key change events, system messages | Medium |
| **Meeting Points / Reconnection** | daily/hourly point derivation, rendezvous registration, live match handling | Medium |
| **Multi-Server / Redirect** | additional server connection, redirect registration, cross-server pairing | Low |
| **Dispose and Cleanup** | subscription cancellation, stream controller closing, WebRTC disposal | High |

### Test Infrastructure Needed

Additional mocks beyond existing:
- `MockMessageStorage` (for key rotation system messages)
- `FakeSignalingClient` with controllable message stream

### Suggested Order

1. Set up test infrastructure
2. Group 9: Dispose/Cleanup
3. Group 2: Peer Management
4. Group 4: WebRTC Callbacks
5. Group 5: File Transfer
6. Group 6: Key Rotation
7. Group 1: Signaling Lifecycle (needs FakeSignalingClient)
8. Group 3: Signaling Messages (complex async)
9. Group 7: Meeting Points
10. Group 8: Multi-Server

**Risk**: Low — tests don't modify production code.

---

## Overall Execution Order (Phase 3)

```
5 → 2 → 1 → 3 → 4
```

| Order | Item | Reason |
|-------|------|--------|
| 1st | ConnectionManager tests (#5) | Safety net BEFORE refactoring |
| 2nd | Break up ConnectionManager (#2) | Tests guard against regression |
| 3rd | Break up _ZajelAppState (#1) | Depends on stable ConnectionManager API |
| 4th | Break up ClientHandler (#3) | Server-side, independent of Flutter (can parallel with #1) |
| 5th | Forward secrecy (#4) | LAST — modifies crypto + handshake, touches refactored code |
