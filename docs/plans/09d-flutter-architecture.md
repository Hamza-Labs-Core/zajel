# Plan 09d: Flutter Architecture Issues

## Overview

18 issues across security, race conditions, correctness, cleanup, and feature gaps. Verified against current source code. Organized by priority: security > data correctness > race conditions > cleanup > features.

---

## Phase 1: Security (Do First)

### A15: Shell injection via `filePath` in `cmd /c` on Windows

**File**: `lib/features/chat/chat_screen.dart:438`

**Current code**:
```dart
result = await Process.run('cmd', ['/c', 'start', '', filePath]);
```

**Problem**: `filePath` originates from peer's file transfer (`transfer.fileName`). A malicious peer can craft filenames with shell metacharacters (`& calc.exe`, `| net user`). `cmd /c` parses the entire command line -- `Process.run` does NOT escape arguments for `cmd.exe`.

**Fix** (three layers of defense):

1. **Replace `cmd /c` with `explorer.exe`** (no shell parser):
```dart
result = await Process.run('explorer.exe', [filePath]);
```

2. **Sanitize filename on receipt** in `FileReceiveService.startTransfer`:
```dart
String sanitizeFileName(String name) {
  // Strip characters unsafe on any OS
  return name.replaceAll(RegExp(r'[/\\:*?"<>|&;$`\n\r]'), '_');
}
```

3. **Path containment check** before opening:
```dart
if (!filePath.startsWith(expectedDownloadDir)) {
  logger.warning('ChatScreen', 'File path outside download directory: $filePath');
  return;
}
```

**Tests**:
```dart
group('File path security', () {
  test('sanitizeFileName strips shell metacharacters', () {
    expect(sanitizeFileName('file & calc.exe'), 'file _ calc.exe');
    expect(sanitizeFileName('file|net user.txt'), 'file_net user.txt');
    expect(sanitizeFileName('normal-file.pdf'), 'normal-file.pdf');
  });

  test('rejects file path outside download directory', () async {
    // Attempt to open '../../etc/passwd'
    // Verify: warning logged, file not opened
  });

  test('opens file with explorer.exe on Windows', () async {
    // Mock Process.run, verify 'explorer.exe' called instead of 'cmd'
  });
});
```

---

## Phase 2: Race Conditions

### A9 + A8: Reconnect subscription leak + dynamic type

**Files**: `lib/main.dart:185-244`

**Problem**: `_setupSignalingReconnect` subscribes to `connectionState.listen(...)` but never stores/cancels the subscription. Duplicate reconnection attempts on re-call. Both methods use `dynamic` instead of `ConnectionManager`.

**Fix**:
```dart
StreamSubscription? _signalingReconnectSubscription;

void _setupSignalingReconnect(ConnectionManager connectionManager) {
  _signalingReconnectSubscription?.cancel();
  final signalingClient = ref.read(signalingClientProvider);
  if (signalingClient == null) return;

  _signalingReconnectSubscription = signalingClient.connectionState.listen((state) async {
    // ... existing logic
  });
}

Future<void> _connectToSignaling(ConnectionManager connectionManager) async {
  // ... existing logic with proper type
}

@override
void dispose() {
  _signalingReconnectSubscription?.cancel();
  // ... existing dispose logic
}
```

**Tests**:
```dart
test('cancels previous reconnect subscription before creating new one', () {
  // Setup: call _setupSignalingReconnect twice
  // Verify: first subscription cancelled, only one active listener
});

test('reconnect subscription cancelled on dispose', () {
  // Setup: create app state, setup listeners
  // Call dispose
  // Verify: subscription cancelled
});
```

---

### A22: File notification fires before file written to disk

**Files**: `lib/main.dart:325-351,639-659`

**Problem**: Duplicate `fileCompletes.listen(...)` -- one in `_setupFileTransferListeners` (writes to disk), one in `_setupNotificationListeners` (shows notification). Both fire simultaneously on broadcast stream. Notification appears before file exists.

**Fix**: Remove duplicate listener from `_setupNotificationListeners`. Move notification into `_setupFileTransferListeners` after `completeTransfer`:
```dart
// In _setupFileTransferListeners, after savedPath != null:
if (savedPath != null) {
  // ... existing file handling ...
  // Emit notification HERE, after file is saved
  notificationService.showFileNotification(
    peerName: peerName,
    fileName: fileName,
  );
}
```

**Tests**:
```dart
test('file notification fires only after file written to disk', () async {
  // Emit a fileComplete event
  // Verify: completeTransfer called before showFileNotification
});
```

---

### A12: VoIP dispose race -- `_cleanup()` not awaited

**File**: `lib/core/network/voip_service.dart:678-695`

**Problem**: `_cleanup()` is async, returns `Future<void>`. `dispose()` calls it without await. `_cleanup` internally calls `_notifyState(CallState.ended)` which adds to `_stateController`. If `_stateController.close()` executes first, `StateError` thrown.

**Fix**: Add `_disposed` guard:
```dart
bool _disposed = false;

@override
void dispose() {
  _disposed = true;
  for (final sub in _subscriptions) { sub.cancel(); }
  _subscriptions.clear();
  _ringingTimeout?.cancel();
  _reconnectionTimeout?.cancel();

  // Synchronous cleanup -- don't call async _cleanup() from synchronous dispose
  final pc = _peerConnection;
  _peerConnection = null;
  pc?.close();   // fire-and-forget
  _mediaService.stopAllTracks();
  _pendingIceCandidates.clear();
  _currentCall = null;

  _stateController.close();
  _remoteStreamController.close();
  super.dispose();
}

void _notifyState(CallState state) {
  if (_disposed || _stateController.isClosed) return;
  _stateController.add(state);
  notifyListeners();
}
```

**Tests**:
```dart
test('dispose does not throw StateError from _notifyState', () {
  final voip = createVoIPService();
  voip.dispose();
  // Verify: no exception thrown
  // Verify: _stateController is closed
});

test('_notifyState no-ops after dispose', () {
  final voip = createVoIPService();
  voip.dispose();
  // Calling _notifyState should not throw
});
```

---

### A13 + A20: Relay handshake sent before data channel open

**File**: `lib/core/network/relay_client.dart:404-434`

**Problem**: `createOffer` starts WebRTC negotiation but doesn't wait for data channel to open. `sendMessage` called immediately -- fails. State emitted as `connected` before connection exists.

**Fix**: Wait for connection before sending handshake:
```dart
Future<void> _connectToRelay(RelayInfo relay) async {
  await _webrtcService.createOffer(relay.peerId);
  _relayConnections[relay.peerId] = RelayConnection(...);

  // Wait for data channel to open
  await _webrtcService.waitForConnection(relay.peerId, timeout: Duration(seconds: 30));

  // NOW send handshake and emit connected state
  await _webrtcService.sendMessage(relay.peerId, jsonEncode({
    'type': 'relay_handshake', ...
  }));

  _stateController.add(RelayStateEvent(
    relayId: relay.peerId,
    state: RelayConnectionState.connected,
  ));
}
```

Add `waitForConnection` to WebRTCService:
```dart
Future<void> waitForConnection(String peerId, {Duration timeout = const Duration(seconds: 30)}) async {
  final completer = Completer<void>();
  // Listen for connection state change to connected
  // Complete on connected, throw on timeout
}
```

**Tests**:
```dart
test('relay handshake sent only after data channel opens', () async {
  // Mock WebRTCService to delay connection
  // Verify: sendMessage called after waitForConnection completes
});

test('relay emits connected only after handshake sent', () async {
  // Verify: RelayConnectionState.connected not emitted until handshake succeeds
});

test('relay handles connection timeout gracefully', () async {
  // Mock WebRTCService.waitForConnection to timeout
  // Verify: error logged, not crashed
});
```

---

## Phase 3: Correctness

### A19: `Peer.props` misses `connectionState`

**File**: `lib/core/models/peer.dart:76`

**Current**: `List<Object?> get props => [id, displayName, publicKey];`

**Problem**: Equatable uses `props` for equality. Missing `connectionState` means Riverpod won't rebuild widgets when peer transitions between `connected`/`disconnected`.

**Fix**:
```dart
@override
List<Object?> get props => [id, displayName, publicKey, connectionState, isLocal];
```

Leave `lastSeen` out to avoid excessive rebuilds on timestamp changes.

**Tests**:
```dart
test('peers with different connectionState are not equal', () {
  final a = Peer(id: '1', connectionState: PeerConnectionState.connected);
  final b = Peer(id: '1', connectionState: PeerConnectionState.disconnected);
  expect(a, isNot(equals(b)));
});

test('peers with same props are equal', () {
  final a = Peer(id: '1', connectionState: PeerConnectionState.connected);
  final b = Peer(id: '1', connectionState: PeerConnectionState.connected);
  expect(a, equals(b));
});
```

---

### A23: `sendMessage` checks `selectedPeerProvider` not current peer

**File**: `lib/features/chat/chat_screen.dart:570`

**Problem**: In split-view or after navigation, `selectedPeerProvider` may point to a different peer than `widget.peerId`. Wrong connection state used for send/queue decision.

**Fix**:
```dart
final peersAsync = ref.read(peersProvider);
bool isConnected = false;
peersAsync.whenData((peers) {
  final peer = peers.firstWhereOrNull((p) => p.id == widget.peerId);
  isConnected = peer?.connectionState == PeerConnectionState.connected;
});
if (!isConnected) {
  // Queue as pending
}
```

**Tests**:
```dart
test('sendMessage checks actual peer, not selectedPeerProvider', () {
  // Set selectedPeerProvider to peer A (connected)
  // Open chat for peer B (disconnected)
  // Send message -- should be queued, not sent
});
```

---

### A11: `blockedPeerDetailsProvider` never updated on block/unblock

**File**: `lib/core/providers/app_providers.dart:394-405`

**Problem**: `StateProvider` reads from SharedPreferences only at creation. Block/unblock updates SharedPreferences but never invalidates the provider. Stale UI until restart.

**Fix (Option B -- better architecture)**: Move blocked peer details into `BlockedPeersNotifier`:
```dart
class BlockedPeersState {
  final Set<String> blockedKeys;
  final Map<String, String> details; // publicKey -> displayName
  const BlockedPeersState({this.blockedKeys = const {}, this.details = const {}});
}

class BlockedPeersNotifier extends StateNotifier<BlockedPeersState> {
  // ... block() and unblock() update both sets atomically
}
```

Then `blockedPeerDetailsProvider` becomes a derived provider.

**Tests**:
```dart
test('blocking a peer updates details provider immediately', () {
  ref.read(blockedPeersProvider.notifier).block('pubkey123', 'Alice');
  final details = ref.read(blockedPeerDetailsProvider);
  expect(details['pubkey123'], 'Alice');
});

test('unblocking a peer removes from details provider', () {
  ref.read(blockedPeersProvider.notifier).block('pubkey123', 'Alice');
  ref.read(blockedPeersProvider.notifier).unblock('pubkey123');
  final details = ref.read(blockedPeerDetailsProvider);
  expect(details.containsKey('pubkey123'), isFalse);
});
```

---

### A10: `async void` handler loses errors

**File**: `lib/core/network/connection_manager.dart:644`

**Fix**: Change signature to `Future<void>`:
```dart
Future<void> _handleSignalingMessage(SignalingMessage message) async {
```

Safe because `Stream.listen` accepts `void Function(T)` and Dart allows passing `Future<void> Function(T)` where `void Function(T)` is expected.

**Tests**: Existing tests continue to pass. No new tests needed.

---

### A14: QR URL parsing without pubkey validation

**File**: `lib/core/network/device_link_service.dart`

**Fix**: Validate `publicKey` part is valid base64 of expected length:
```dart
final publicKey = parts[1];
try {
  final decoded = base64Decode(publicKey);
  if (decoded.length != 32) {
    logger.warning('parseQrData', 'Invalid public key length: ${decoded.length}');
    return null;
  }
} on FormatException {
  logger.warning('parseQrData', 'Invalid base64 in public key');
  return null;
}
```

**Tests**:
```dart
test('rejects QR with invalid base64 publicKey', () {
  final result = parseQrData('${qrProtocol}code:!!!notbase64:wss://server');
  expect(result, isNull);
});

test('rejects QR with wrong-length publicKey', () {
  final shortKey = base64Encode(Uint8List(16)); // 16 bytes instead of 32
  final result = parseQrData('${qrProtocol}code:$shortKey:wss://server');
  expect(result, isNull);
});
```

---

## Phase 4: Cleanup

### A21: `DeadDrop`/`LiveMatch`/`RendezvousResult` defined in two files

**Files**: `lib/core/network/dead_drop.dart` + `lib/core/network/signaling_client.dart:1186-1259`

**Problem**: Two separate type hierarchies with different fields and structures. Name collisions without `show`/`hide`.

**Fix**: Make signaling-specific classes private (`_LiveMatch`, `_DeadDrop`) since they're only used within `signaling_client.dart`'s message parsing. Export public versions from `dead_drop.dart` only.

**Tests**: Existing tests pass. No new tests needed.

---

## Phase 5: Feature Gaps

### A25: Chat history hard-capped at 100 messages, no pagination

**File**: `lib/core/storage/message_storage.dart:103`

**Problem**: `getMessages` defaults to `LIMIT 100 OFFSET 0` with `ORDER BY timestamp ASC`. Returns OLDEST 100 messages, not newest. `ChatMessagesNotifier._loadMessages()` never passes offset.

**Fix**:
1. Change default query to get newest: `ORDER BY timestamp DESC LIMIT 100`, reverse in memory
2. Add `loadMore()` to `ChatMessagesNotifier` for scroll-based pagination
3. In chat screen, detect scroll-to-top and call `loadMore()`

**Tests**:
```dart
test('getMessages returns newest messages first', () async {
  // Insert 150 messages
  final messages = await storage.getMessages('peer1');
  expect(messages.length, 100);
  // Verify: messages are the 50 newest (150-100), not oldest
});

test('loadMore fetches next page', () async {
  // Insert 150 messages, load initial page
  await notifier.loadMore();
  // Verify: now has 150 messages total
});
```

---

### A24: Bootstrap verifier keys are placeholder

**File**: `lib/core/crypto/bootstrap_verifier.dart:14-15`

**Action**: Run `generate-bootstrap-keys.mjs`, compare with deployed keys. If mismatch, rotate.

**Tests**: Add CI check that verifies bootstrap verifier can validate a test signature.

---

### A16: Auto-delete messages (TODO)

**File**: `lib/features/settings/settings_screen.dart:112-117`

**Needs**:
1. `autoDeleteEnabled` + `autoDeleteDuration` in settings
2. Periodic cleanup task in `MessageStorage`
3. Wire settings toggle to provider
4. Also delete file attachments from disk

---

### A17: Background blur (incomplete)

**File**: `lib/core/media/background_blur_processor.dart`

**Needs**: TFLite selfie segmentation model, frame interception in WebRTC pipeline. Multi-week effort. Defer.

---

### A18: Reconnection handler gaps

**File**: `lib/core/network/peer_reconnection_service.dart`

**Status**: Mostly scaffolded. Provider-based wiring works. Main gap: `PeerReconnectionService.connect()` creates a separate `SignalingClient` (should not be called -- provider wiring is correct path). Clean up unused `connect()` method.

---

## Implementation Order

| Phase | Issue | Effort | Risk |
|-------|-------|--------|------|
| 1 | **A15** Shell injection | Small | HIGH |
| 2 | **A9+A8** Reconnect leak + dynamic | Small | Medium |
| 3 | **A22** File notification timing | Small | Medium |
| 4 | **A12** VoIP dispose race | Small | Medium |
| 5 | **A13+A20** Relay handshake race | Medium | Medium |
| 6 | **A19** Peer.props | Small | Medium |
| 7 | **A23** Wrong peer check | Small | Medium |
| 8 | **A11** Stale blocked list | Medium | Low |
| 9 | **A10** async void | Small | Low |
| 10 | **A14** QR pubkey validation | Small | Low |
| 11 | **A21** Duplicate types | Medium | Low |
| 12 | **A25** Chat pagination | Medium | Low |
| 13 | **A24** Bootstrap keys | Small | Low |
| 14 | **A16** Auto-delete | Medium | Low |
| 15 | **A17** Background blur | Large | Low |
| 16 | **A18** Reconnection cleanup | Medium | Low |

**Total new tests**: ~25 test cases across multiple test files
