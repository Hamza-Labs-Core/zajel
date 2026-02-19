# Plan 09e: TOFU Safety Number Warning System

## Overview

When a known peer reconnects with a different public key, the app must detect the key change, show a visible warning, let the user acknowledge it, and provide a way to verify the new safety number. This feature spans all three clients (Flutter, web, headless).

**Prerequisite**: Works best with the `stableId` system from Plan 10 (provides stable anchor across key rotations). Without stableId, key rotation detection relies on meeting-point-based reconnection.

---

## Current State

- **Identity**: `TrustedPeer.publicKey` stored via `flutter_secure_storage`. No `previousPublicKey` or rotation tracking.
- **Key rotation detection**: Does NOT exist in main branch. Plan05 branch has `_checkKeyRotation` that silently auto-accepts.
- **Fingerprint UI**: Partially built -- `CryptoService.getPublicKeyFingerprint()` exists. Chat screen has `_FingerprintVerificationSection` showing individual SHA-256 hex. Web client has `FingerprintDisplay.tsx` with copy-to-clipboard.
- **Message model**: `MessageType` has `text`, `file`, `image`, `handshake`, `ack`. No `system` type.

---

## Safety Number Design

### Computation

Both peers compute the same number by sorting keys before hashing:

```dart
String computeSafetyNumber(String publicKeyA_Base64, String publicKeyB_Base64) {
  final bytesA = base64Decode(publicKeyA_Base64);
  final bytesB = base64Decode(publicKeyB_Base64);

  // Sort lexicographically so both sides get same result
  final sorted = [bytesA, bytesB]..sort((a, b) {
    for (var i = 0; i < a.length && i < b.length; i++) {
      if (a[i] != b[i]) return a[i].compareTo(b[i]);
    }
    return a.length.compareTo(b.length);
  });

  final combined = Uint8List.fromList([...sorted[0], ...sorted[1]]);
  final hash = sha256.convert(combined);
  return _formatSafetyNumber(hash.bytes);
}
```

### Format

60 digits displayed in a 12x5 grid (Signal-like):
```
12345 67890 12345 67890
12345 67890 12345 67890
12345 67890 12345 67890
```

```dart
String _formatSafetyNumber(List<int> hashBytes) {
  final buffer = StringBuffer();
  for (var i = 0; i < 24 && i + 1 < hashBytes.length; i += 2) {
    final val = (hashBytes[i] << 8 | hashBytes[i + 1]) % 100000;
    buffer.write(val.toString().padLeft(5, '0'));
  }
  return buffer.toString().substring(0, 60);
}
```

---

## Step 1: Data Model Changes

### TrustedPeer model additions

**File**: `lib/core/storage/trusted_peers_storage.dart`

```dart
class TrustedPeer {
  // ... existing fields ...

  /// Previous public key before most recent rotation (null if never rotated).
  final String? previousPublicKey;

  /// When the most recent key rotation was detected.
  final DateTime? keyRotatedAt;

  /// Whether the user has acknowledged/dismissed the key change warning.
  final bool keyChangeAcknowledged;
}
```

Update `fromJson`, `toJson`, `copyWith`, `fromPeer`. Migration defaults:
- `previousPublicKey`: `null`
- `keyRotatedAt`: `null`
- `keyChangeAcknowledged`: `true` (no retroactive warnings for existing peers)

### MessageType addition

**File**: `lib/core/models/message.dart`

```dart
enum MessageType {
  text, file, image, handshake, ack,
  system,  // NEW: key change notifications, etc.
}
```

### Storage interface additions

**File**: `lib/core/storage/trusted_peers_storage.dart`

```dart
Future<void> recordKeyRotation(String peerId, String oldPublicKey, String newPublicKey);
Future<void> acknowledgeKeyChange(String peerId);
Future<List<TrustedPeer>> getPeersWithPendingKeyChanges();
```

**Tests**:
```dart
group('TrustedPeer key rotation', () {
  test('fromJson handles missing new fields (backward compat)', () {
    final json = {'id': 'peer1', 'publicKey': 'abc', 'trustedAt': '...'};
    final peer = TrustedPeer.fromJson(json);
    expect(peer.previousPublicKey, isNull);
    expect(peer.keyChangeAcknowledged, isTrue);
  });

  test('toJson includes new fields', () {
    final peer = TrustedPeer(..., previousPublicKey: 'old', keyRotatedAt: DateTime.now());
    final json = peer.toJson();
    expect(json['previousPublicKey'], 'old');
    expect(json['keyRotatedAt'], isNotNull);
  });

  test('copyWith works for new fields', () {
    final peer = TrustedPeer(...);
    final updated = peer.copyWith(keyChangeAcknowledged: false);
    expect(updated.keyChangeAcknowledged, isFalse);
  });
});
```

---

## Step 2: Storage Implementation

**File**: `lib/core/storage/trusted_peers_storage_impl.dart`

### recordKeyRotation
1. Load existing peer
2. Set `previousPublicKey` = existing `publicKey`
3. Set `publicKey` = new key
4. Set `keyRotatedAt` = now
5. Set `keyChangeAcknowledged` = false
6. Persist

### acknowledgeKeyChange
1. Load peer, set `keyChangeAcknowledged = true`, persist

**Tests**:
```dart
group('SecureTrustedPeersStorage key rotation', () {
  test('recordKeyRotation persists old key, new key, timestamp', () async {
    await storage.addPeer(TrustedPeer(id: 'p1', publicKey: 'oldKey'));
    await storage.recordKeyRotation('p1', 'oldKey', 'newKey');
    final peer = await storage.getPeer('p1');
    expect(peer!.publicKey, 'newKey');
    expect(peer.previousPublicKey, 'oldKey');
    expect(peer.keyRotatedAt, isNotNull);
    expect(peer.keyChangeAcknowledged, isFalse);
  });

  test('acknowledgeKeyChange clears the flag', () async {
    await storage.recordKeyRotation('p1', 'old', 'new');
    await storage.acknowledgeKeyChange('p1');
    final peer = await storage.getPeer('p1');
    expect(peer!.keyChangeAcknowledged, isTrue);
  });

  test('getPeersWithPendingKeyChanges returns correct peers', () async {
    await storage.recordKeyRotation('p1', 'old1', 'new1');
    await storage.acknowledgeKeyChange('p1');
    await storage.recordKeyRotation('p2', 'old2', 'new2');
    final pending = await storage.getPeersWithPendingKeyChanges();
    expect(pending.length, 1);
    expect(pending.first.id, 'p2');
  });
});
```

---

## Step 3: Safety Number in CryptoService

**File**: `lib/core/crypto/crypto_service.dart`

Add `computeSafetyNumber()` (see computation above).

**Tests**:
```dart
group('CryptoService.computeSafetyNumber', () {
  test('same result regardless of key order', () {
    final a = computeSafetyNumber('keyA', 'keyB');
    final b = computeSafetyNumber('keyB', 'keyA');
    expect(a, equals(b));
  });

  test('different result for different key pairs', () {
    final a = computeSafetyNumber('keyA', 'keyB');
    final b = computeSafetyNumber('keyA', 'keyC');
    expect(a, isNot(equals(b)));
  });

  test('consistent format: 60 digits', () {
    final number = computeSafetyNumber('keyA', 'keyB');
    expect(number.length, 60);
    expect(number, matches(RegExp(r'^\d{60}$')));
  });

  test('round-trip: both peers compute same number', () {
    // Simulate Alice and Bob each computing
    final alice = computeSafetyNumber(alicePubKey, bobPubKey);
    final bob = computeSafetyNumber(bobPubKey, alicePubKey);
    expect(alice, equals(bob));
  });
});
```

---

## Step 4: Key Rotation Detection in ConnectionManager

**File**: `lib/core/network/connection_manager.dart`

### Add onHandshakeComplete callback to WebRTCService

**File**: `lib/core/network/webrtc_service.dart`

Separate handshake processing from state transition. Add callback when handshake data received:
```dart
Function(String peerId, String publicKey, String? stableId, String? username)? onHandshakeComplete;
```

### Add key-change stream

```dart
final _keyChangeController = StreamController<(String peerId, String oldKey, String newKey)>.broadcast();
Stream<(String, String, String)> get keyChanges => _keyChangeController.stream;
```

### Key rotation check in handshake handler

```dart
Future<void> _checkKeyRotation(String peerId, String newPublicKey) async {
  final stored = await _trustedPeersStorage.getPeer(peerId);
  if (stored == null) return; // First trust, no rotation

  if (stored.publicKey != newPublicKey) {
    logger.warning('ConnectionManager',
        'Key rotation detected for $peerId (old: ${stored.publicKey.substring(0, 8)}...)');
    await _trustedPeersStorage.recordKeyRotation(peerId, stored.publicKey, newPublicKey);
    _keyChangeController.add((peerId, stored.publicKey, newPublicKey));

    // Insert system message
    final msg = Message(
      localId: const Uuid().v4(),
      peerId: peerId,
      content: 'Safety number changed. Tap to verify.',
      type: MessageType.system,
      timestamp: DateTime.now(),
      isOutgoing: false,
      status: MessageStatus.delivered,
    );
    await _messageStorage.addMessage(msg);
  }
}
```

**Tests**:
```dart
group('ConnectionManager key rotation', () {
  test('known peer with same key: no event emitted', () async {
    await storage.addPeer(TrustedPeer(id: 'p1', publicKey: 'keyA'));
    await manager.handleHandshake('p1', 'keyA');
    // Verify: keyChanges stream did NOT emit
  });

  test('known peer with different key: event emitted, storage updated', () async {
    await storage.addPeer(TrustedPeer(id: 'p1', publicKey: 'keyA'));
    await manager.handleHandshake('p1', 'keyB');
    // Verify: keyChanges stream emitted ('p1', 'keyA', 'keyB')
    // Verify: storage updated with newKey
  });

  test('unknown peer: no rotation event', () async {
    await manager.handleHandshake('newPeer', 'keyA');
    // Verify: no event, first trust established
  });

  test('system message inserted on key rotation', () async {
    await storage.addPeer(TrustedPeer(id: 'p1', publicKey: 'keyA'));
    await manager.handleHandshake('p1', 'keyB');
    final messages = await messageStorage.getMessages('p1');
    expect(messages.any((m) => m.type == MessageType.system), isTrue);
  });
});
```

---

## Step 5: Provider Changes

**File**: `lib/core/providers/app_providers.dart`

```dart
final keyChangeStreamProvider = StreamProvider<(String, String, String)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.keyChanges;
});

final pendingKeyChangesProvider = FutureProvider<Map<String, TrustedPeer>>((ref) async {
  final storage = ref.watch(trustedPeersStorageProvider);
  final peers = await storage.getPeersWithPendingKeyChanges();
  return { for (final p in peers) p.id: p };
});
```

---

## Step 6: UI Components

### KeyChangeBanner in Chat Screen

**File**: `lib/features/chat/chat_screen.dart`

Insert between offline banner and message list:
```dart
if (_hasUnacknowledgedKeyChange(widget.peerId))
  _KeyChangeBanner(
    peerId: widget.peerId,
    onVerify: () => _showSafetyNumberScreen(context),
    onDismiss: () => _acknowledgeKeyChange(widget.peerId),
  ),
```

- Yellow/orange warning background
- Warning icon
- Text: "The safety number with [PeerName] has changed. This could mean they reinstalled the app or their device changed."
- Two buttons: "Verify" and "OK"

### System Message Bubble

In `_MessageBubble` widget:
```dart
if (message.type == MessageType.system) {
  return _SystemMessageBubble(message: message, onTap: onTapSystemMessage);
}
```

Render: centered, gray, no bubble, lock/shield icon. Like WhatsApp's "Messages are end-to-end encrypted" banners.

### Safety Number Verification Screen

**New file**: `lib/features/chat/widgets/safety_number_screen.dart`

Full-screen or modal bottom sheet showing:
1. 60-digit safety number in 12x5 grid
2. Both peers' individual fingerprints
3. QR code of safety number (for in-person scanning)
4. Instructions: "Compare this number with [PeerName]..."
5. "Mark as Verified" button
6. "Copy" button

Accessed from:
- Key-change banner "Verify" button
- Existing "Verify Connection Security" section
- Chat overflow menu: "View safety number"

### Update _FingerprintVerificationSection

Show combined safety number instead of/in addition to individual fingerprints. Show "Safety number changed" warning if applicable.

**Widget Tests**:
```dart
group('KeyChangeBanner', () {
  test('shows when peer has unacknowledged key change', () {
    // Setup: peer with keyChangeAcknowledged = false
    // Build widget, verify banner visible
  });

  test('hidden when already acknowledged', () {
    // Setup: peer with keyChangeAcknowledged = true
    // Build widget, verify banner NOT visible
  });

  test('Verify button opens safety number screen', () {
    // Tap verify, verify navigator pushed SafetyNumberScreen
  });

  test('OK button acknowledges and hides banner', () {
    // Tap OK, verify acknowledgeKeyChange called, banner hidden
  });
});

group('SafetyNumberScreen', () {
  test('displays 60-digit number correctly', () {
    // Provide keys, verify 60 digits shown in grid
  });

  test('copy button copies to clipboard', () {
    // Tap copy, verify clipboard contains safety number
  });
});

group('System message rendering', () {
  test('MessageType.system renders centered without bubble', () {
    // Build message list with system message
    // Verify: centered text, no bubble background
  });
});
```

---

## Step 7: Cross-Client Implementation

### Web Client

**File**: `packages/web-client/src/lib/crypto.ts`

Add `computeSafetyNumber()` matching the Dart implementation. Update `FingerprintDisplay.tsx` to show combined safety number.

Store peer public keys in localStorage. On handshake, compare against stored key. Show banner in `ChatView.tsx` if key changed.

### Headless Client

**File**: `packages/headless-client/zajel/client.py`

Add key rotation detection in `_on_message_channel_data` handshake processing:
```python
if msg["type"] == "handshake":
    stored = self._storage.get_peer(peer_id)
    if stored and stored.public_key != peer_pub_key:
        logger.warning("Key rotation detected for %s", peer_id)
        await self._events.emit("key_changed", peer_id, stored.public_key, peer_pub_key)
```

Add `previous_public_key` and `key_rotated_at` columns to `peers` table in `peer_storage.py`.

### Cross-Client Safety Number Match Test

```dart
// Integration test: Dart and TypeScript compute same safety number
test('Dart and TypeScript safety numbers match for same keys', () {
  final dartNumber = cryptoService.computeSafetyNumber(keyA, keyB);
  // Compare with known TS output for same keys
  expect(dartNumber, equals(expectedNumber));
});
```

---

## Implementation Sequence

| Step | Description | Files |
|------|-------------|-------|
| 1 | Add `system` to `MessageType` | `message.dart` |
| 2 | Add new fields to `TrustedPeer` model | `trusted_peers_storage.dart` |
| 3 | Add new storage methods | `trusted_peers_storage.dart`, `trusted_peers_storage_impl.dart` |
| 4 | Add `computeSafetyNumber()` to CryptoService | `crypto_service.dart` |
| 5 | Add `onHandshakeComplete` callback to WebRTCService | `webrtc_service.dart` |
| 6 | Add `_checkKeyRotation` and key-change stream | `connection_manager.dart` |
| 7 | Add key-change providers | `app_providers.dart` |
| 8 | Listen for key changes, insert system messages | `main.dart` |
| 9 | Build `_KeyChangeBanner` widget | `chat_screen.dart` |
| 10 | Build `SafetyNumberScreen` widget | new: `safety_number_screen.dart` |
| 11 | Build `_SystemMessageBubble` rendering | `chat_screen.dart` |
| 12 | Update `_FingerprintVerificationSection` | `chat_screen.dart` |
| 13 | Add safety number to web client crypto | `crypto.ts` |
| 14 | Add key change detection to web client | `webrtc.ts`, `ChatView.tsx` |
| 15 | Add key change detection to headless client | `client.py`, `peer_storage.py` |
| 16 | Write tests | multiple test files |

---

## Security Considerations

| Aspect | Design Decision |
|--------|----------------|
| TOFU baseline | First key trusted implicitly. Warnings are informational, not blocking |
| No key pinning enforcement | Unlike Signal -- auto-accepts new key. Advisory warning only |
| Key change reasons | Normal: reinstall, new device, corruption. Warning should not be alarmist |
| No server involvement | Safety number computed locally. Server never sees public keys |
| MITM during reconnection | Attacker could substitute key. Safety number alerts users to verify OOB |

**Total new tests**: ~30 test cases across unit, widget, and integration tests
