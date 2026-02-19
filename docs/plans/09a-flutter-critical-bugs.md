# Plan 09a: Flutter Critical Bug Fixes

## Overview

10 critical/high-severity bugs verified against current source code. Organized by priority: crash fixes, memory leaks, security, code quality.

---

## PRIORITY 1: CRASH FIXES

### A7: `PeerFoundEvent.toString()` crashes on empty meetingPoint

**File**: `lib/core/network/peer_reconnection_service.dart:463`
**Verified**: `processLiveMatchFromRendezvous` (line 378) passes `meetingPoint: ''`, then `meetingPoint.substring(0, 10)` throws `RangeError`.

**Fix**:
```dart
@override
String toString() {
  final mpPreview = meetingPoint.length > 10
      ? '${meetingPoint.substring(0, 10)}...'
      : meetingPoint;
  return 'PeerFoundEvent(peerId: $peerId, meetingPoint: $mpPreview, isLive: $isLive)';
}
```

**Tests** (`test/unit/network/peer_reconnection_service_test.dart`):
```dart
group('PeerFoundEvent.toString', () {
  test('handles empty meetingPoint without crash', () {
    final event = PeerFoundEvent(peerId: 'abc', meetingPoint: '', isLive: true);
    expect(event.toString(), contains('meetingPoint:'));
    // Must not throw RangeError
  });

  test('handles short meetingPoint', () {
    final event = PeerFoundEvent(peerId: 'abc', meetingPoint: 'abcd', isLive: false);
    expect(event.toString(), contains('abcd'));
  });

  test('truncates long meetingPoint', () {
    final event = PeerFoundEvent(peerId: 'abc', meetingPoint: 'a' * 50, isLive: true);
    expect(event.toString(), contains('aaaaaaaaaa...'));
  });
});
```

---

### A6: Null assertion on disposed connection after await

**File**: `lib/core/network/webrtc_service.dart:496`
**Verified**: After `await _cryptoService.establishSession(peerId, publicKey)`, `_connections[peerId]!` can crash if the connection was closed during the await.

**Fix**:
```dart
await _cryptoService.establishSession(peerId, publicKey);
final conn = _connections[peerId];
if (conn == null) {
  logger.warning('WebRTCService', 'Connection for $peerId removed during handshake');
  return;
}
_updateConnectionState(conn, PeerConnectionState.connected);
```

**Tests** (`test/unit/network/webrtc_service_test.dart` -- new file):
```dart
test('handshake completes gracefully when connection removed during await', () async {
  // Setup: create connection, start handshake
  // During the establishSession await, call closeConnection(peerId)
  // Verify: no exception thrown, warning logged
});

test('handshake succeeds when connection still active', () async {
  // Normal path: connection exists after await
  // Verify: state updated to connected
});
```

---

### A3: `getPublicKeyBytes` unhandled base64 exception

**File**: `lib/core/storage/trusted_peers_storage_impl.dart:72`
**Verified**: `base64Decode(peer.publicKey)` throws `FormatException` on corrupted data. Callers null-check the return, so returning null is safe.

**Fix**:
```dart
@override
Future<Uint8List?> getPublicKeyBytes(String peerId) async {
  final peer = await getPeer(peerId);
  if (peer == null) return null;
  try {
    return base64Decode(peer.publicKey);
  } on FormatException {
    return null;
  }
}
```

**Tests** (`test/unit/storage/trusted_peers_storage_test.dart` -- new file):
```dart
test('getPublicKeyBytes returns null for corrupted base64', () async {
  // Store a peer with publicKey = '!!!invalid-base64!!!'
  final result = await storage.getPublicKeyBytes('peer-1');
  expect(result, isNull);
});

test('getPublicKeyBytes returns decoded bytes for valid key', () async {
  // Store a peer with valid base64 publicKey
  final result = await storage.getPublicKeyBytes('peer-1');
  expect(result, isNotNull);
  expect(result!.length, greaterThan(0));
});

test('getPublicKeyBytes returns null for unknown peer', () async {
  final result = await storage.getPublicKeyBytes('nonexistent');
  expect(result, isNull);
});
```

---

## PRIORITY 2: MEMORY LEAKS

### A1: Reconnect listener never cancelled

**File**: `lib/main.dart:198`
**Verified**: `signalingClient.connectionState.listen(...)` return value discarded. New listener created on each reconnect.

**Fix**:
1. Add field: `StreamSubscription? _signalingReconnectSubscription;`
2. In `_setupSignalingReconnect`:
```dart
_signalingReconnectSubscription?.cancel();
_signalingReconnectSubscription = signalingClient.connectionState.listen((state) async {
  // existing logic...
});
```
3. In `dispose()`: `_signalingReconnectSubscription?.cancel();`

**Tests** (widget test):
```dart
test('reconnect subscription is cancelled before creating new one', () {
  // Call _setupSignalingReconnect twice
  // Verify first subscription was cancelled
  // Verify only one active listener
});
```

---

### A2: `fileCompletes` subscribed twice, second never cancelled

**File**: `lib/main.dart:325,640`
**Verified**: First in `_setupFileTransferListeners` (stored as `_fileCompleteSubscription`), second in `_setupNotificationListeners` (discarded). Also `messages.listen` at line 608 is discarded.

**Fix**:
1. Add fields:
```dart
StreamSubscription? _notificationMessageSubscription;
StreamSubscription? _notificationFileCompleteSubscription;
```
2. Store both in `_setupNotificationListeners()`
3. Cancel both in `dispose()`

**Tests** (widget test):
```dart
test('notification subscriptions are cancelled on dispose', () {
  // Create app state, setup listeners
  // Call dispose
  // Verify subscriptions cancelled
});
```

---

## PRIORITY 3: SECURITY

### A4: VoIP forces relay even in production

**File**: `lib/core/network/voip_service.dart:378`
**Verified**: `iceTransportPolicy: 'relay'` set when `_iceServers != null` -- should also require `Environment.isE2eTest` like the data channel path.

**Fix**:
1. Add `_forceRelay` field to VoIPService constructor
2. Use `if (_forceRelay)` instead of `if (_iceServers != null)`
3. Wire in provider: `forceRelay: iceServers != null && Environment.isE2eTest`

**Tests** (`test/unit/network/voip_service_test.dart`):
```dart
test('does not force relay in production when TURN servers configured', () async {
  final voip = VoIPService(mockMedia, mockSignaling,
    iceServers: [{'urls': 'turn:example.com'}],
    forceRelay: false);
  // Verify iceTransportPolicy is NOT 'relay'
});

test('forces relay in E2E test mode', () async {
  final voip = VoIPService(mockMedia, mockSignaling,
    iceServers: [{'urls': 'turn:example.com'}],
    forceRelay: true);
  // Verify iceTransportPolicy is 'relay'
});
```

---

### A5: HKDF empty salt -- no forward secrecy

**File**: `lib/core/crypto/crypto_service.dart:209`
**Verified**: `nonce: const []` means same X25519 shared secret always derives same session key. `establishSession` uses the long-lived identity key pair, not ephemeral keys.

**Status**: Design-level limitation. `generateEphemeralKeyPair()` exists (line 291) but is never called from `establishSession()`.

**Recommended approach**: Document as known limitation. True fix requires protocol changes (ephemeral key exchange over data channel). See Plan 09e (TOFU safety numbers) for the broader identity/crypto roadmap.

**Immediate mitigation**: Add code comment documenting the limitation:
```dart
// NOTE: Using empty salt means same identity keys always derive same session key.
// Forward secrecy requires ephemeral key exchange per session (not yet implemented).
// See docs/plans/09a-flutter-critical-bugs.md#A5
```

---

### SF-C5: Silent key regeneration on storage corruption

**File**: `lib/core/crypto/crypto_service.dart:335`
**Verified**: `catch (_)` silently generates new identity keys, breaking all peer trust.

**Fix**:
```dart
} catch (e) {
  logger.warning('CryptoService',
    'Failed to load identity keys from storage, generating new keys. '
    'Existing peer trust relationships will be broken. Error: $e');
}
```

Add `bool _keysWereRegenerated = false;` flag for UI consumption.

**Tests** (`test/unit/crypto/crypto_service_test.dart`):
```dart
test('logs warning when identity keys cannot be loaded from storage', () async {
  // Mock secure storage to throw on read
  await cryptoService.initialize();
  // Verify: new keys generated, warning logged, keysWereRegenerated is true
});

test('keysWereRegenerated is false on normal initialization', () async {
  await cryptoService.initialize();
  expect(cryptoService.keysWereRegenerated, isFalse);
});
```

---

### SF-C6: Session key loading silently returns null

**File**: `lib/core/crypto/crypto_service.dart:380`

**Fix**: Add `logger.warning(...)` in the catch block. Same pattern as SF-C5.

**Tests**: Add test for corrupted session key storage returning null with warning log.

---

## PRIORITY 4: CODE QUALITY

### SF-C4: Empty catch discards disconnectPeer errors

**File**: `lib/features/chat/chat_screen.dart:833`

**Fix**: Replace `catch (_) {}` with `catch (e) { logger.warning('ChatScreen', 'Failed to disconnect peer: $e'); }`

**Tests**: Logging-only change, no behavioral test needed.

---

## Implementation Order

| Order | Issue | Type | Effort |
|-------|-------|------|--------|
| 1 | A7 | Crash fix | 5 min |
| 2 | A6 | Crash fix | 5 min |
| 3 | A3 | Crash fix | 10 min |
| 4 | A1 | Memory leak | 10 min |
| 5 | A2 | Memory leak | 10 min |
| 6 | A4 | Security/perf | 15 min |
| 7 | SF-C5 | Security visibility | 10 min |
| 8 | SF-C6 | Security visibility | 5 min |
| 9 | SF-C4 | Code quality | 5 min |
| 10 | A5 | Design limitation | Document only |

**Total estimated new tests**: ~20 test cases across 4 test files.
