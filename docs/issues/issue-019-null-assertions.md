# Issue #19: Unsafe Null Assertions in connection_manager.dart

## Overview

This document analyzes the non-null assertions (`!`) used in `/home/meywd/zajel/packages/app/lib/core/network/connection_manager.dart` and proposes safer alternatives to prevent potential runtime crashes.

## All Non-Null Assertions Found

| Line | Expression | Context |
|------|------------|---------|
| 96 | `_externalPairingCode!` | Passed to SignalingClient constructor |
| 101 | `_signalingClient!.messages` | Accessing messages stream |
| 103 | `_signalingClient!.connect()` | Calling connect method |
| 105 | `_externalPairingCode!` | Return value |
| 121 | `_signalingClient!.isConnected` | Guard check (after null check) |
| 137 | `_signalingClient!.requestPairing()` | Calling requestPairing |
| 163 | `_signalingClient!.sendOffer()` | Sending WebRTC offer |
| 175 | `_signalingClient!.isConnected` | Guard check (after null check) |
| 178 | `_signalingClient!.sendIceCandidate()` | Sending ICE candidate |
| 307 | `_signalingClient!.sendAnswer()` | Sending WebRTC answer |
| 334 | `_peers[peerId]!.copyWith()` | Updating peer state |

---

## Detailed Risk Analysis

### Lines 96, 101, 103, 105 - `enableExternalConnections` method

```dart
Future<String> enableExternalConnections({
  required String serverUrl,
  String? pairingCode,
}) async {
  await _signalingSubscription?.cancel();
  _signalingSubscription = null;

  _externalPairingCode = pairingCode ?? _generatePairingCode();  // Line 92

  _signalingClient = SignalingClient(
    serverUrl: serverUrl,
    pairingCode: _externalPairingCode!,  // Line 96
    publicKey: _cryptoService.publicKeyBase64,
  );

  _signalingSubscription =
      _signalingClient!.messages.listen(_handleSignalingMessage);  // Line 101

  await _signalingClient!.connect();  // Line 103

  return _externalPairingCode!;  // Line 105
}
```

**Risk Level: LOW**

**Analysis:** These assertions are safe because:
- Line 92 always sets `_externalPairingCode` to a non-null value (either the provided code or a generated one)
- Line 94 always creates a new `SignalingClient` instance
- Lines 96, 101, 103, 105 are executed immediately after assignment in the same synchronous flow

**Why it's still problematic:**
- Code readability and maintainability suffer
- Future refactoring could introduce bugs
- Violates defensive programming principles

---

### Line 121 - `connectToExternalPeer` guard check

```dart
if (_signalingClient == null || !_signalingClient!.isConnected) {
  throw ConnectionException('Not connected to signaling server');
}
```

**Risk Level: LOW (but poor pattern)**

**Analysis:** This is safe because Dart's short-circuit evaluation ensures `_signalingClient!.isConnected` is only evaluated if `_signalingClient != null`.

**Why it's still problematic:**
- Pattern is confusing to readers
- Dart provides better ways to handle this

---

### Line 137 - `connectToExternalPeer` requestPairing

```dart
_signalingClient!.requestPairing(pairingCode);
```

**Risk Level: MEDIUM**

**Analysis:** This assertion is placed after the guard at line 121. However:
- Between line 121 and line 137, code modifies `_peers` and calls `_notifyPeersChanged()`
- If `_notifyPeersChanged()` triggers async code that modifies `_signalingClient`, this could crash
- In concurrent environments, another async operation could set `_signalingClient = null`

---

### Line 163 - `_startWebRTCConnection` sendOffer

```dart
if (isInitiator) {
  final offer = await _webrtcService.createOffer(peerCode);
  _signalingClient!.sendOffer(peerCode, offer);  // Line 163
}
```

**Risk Level: HIGH**

**Analysis:** This is dangerous because:
- `createOffer()` is async and could take time
- During this await, `disableExternalConnections()` could be called, setting `_signalingClient = null`
- No guard check before using `_signalingClient!`
- Could cause runtime crash: `Null check operator used on a null value`

---

### Lines 175, 178 - `_configureSignalingCallback` callback

```dart
_webrtcService.onSignalingMessage = (targetPeerId, message) {
  if (_signalingClient == null || !_signalingClient!.isConnected) return;  // Line 175

  if (message['type'] == 'ice_candidate') {
    _signalingClient!.sendIceCandidate(targetPeerId, message);  // Line 178
  }
};
```

**Risk Level: MEDIUM**

**Analysis:**
- Line 175: Same pattern as line 121 - safe due to short-circuit evaluation
- Line 178: Potentially unsafe because between the guard check (line 175) and usage (line 178), the callback could be re-entered or another async operation could nullify `_signalingClient`

---

### Line 307 - `_handleSignalingMessage` sendAnswer

```dart
case SignalingOffer(from: final from, payload: final payload):
  // ... peer handling code ...
  _configureSignalingCallback();

  final answer = await _webrtcService.handleOffer(from, payload);  // Async!
  _signalingClient!.sendAnswer(from, answer);  // Line 307
  break;
```

**Risk Level: HIGH**

**Analysis:** This is dangerous because:
- `handleOffer()` is async
- No guard check before using `_signalingClient!`
- During the await, `disableExternalConnections()` could be called
- Could cause runtime crash

---

### Line 334 - `_updatePeerState` copyWith

```dart
void _updatePeerState(String peerId, PeerConnectionState state) {
  if (_peers.containsKey(peerId)) {
    _peers[peerId] = _peers[peerId]!.copyWith(  // Line 334
      connectionState: state,
      lastSeen: DateTime.now(),
    );
    _notifyPeersChanged();
    // ...
  }
}
```

**Risk Level: LOW**

**Analysis:** This is safe because:
- The `containsKey` check ensures the key exists
- Map access immediately follows the check in synchronous code

**Why it's still problematic:**
- Pattern is ugly and hard to read
- Dart has better idioms for this

---

## Proposed Safe Alternatives

### Pattern 1: Local Variable Capture (Recommended for async flows)

**Before (Line 163):**
```dart
if (isInitiator) {
  final offer = await _webrtcService.createOffer(peerCode);
  _signalingClient!.sendOffer(peerCode, offer);
}
```

**After:**
```dart
if (isInitiator) {
  final client = _signalingClient;
  if (client == null) {
    // Connection was closed during setup
    return;
  }

  final offer = await _webrtcService.createOffer(peerCode);

  // Re-check after await since state could have changed
  if (!client.isConnected) {
    return;
  }
  client.sendOffer(peerCode, offer);
}
```

---

### Pattern 2: Guard with Early Return (Recommended for methods)

**Before (Line 137):**
```dart
Future<void> connectToExternalPeer(String pairingCode) async {
  if (_signalingClient == null || !_signalingClient!.isConnected) {
    throw ConnectionException('Not connected to signaling server');
  }
  // ... more code ...
  _signalingClient!.requestPairing(pairingCode);
}
```

**After:**
```dart
Future<void> connectToExternalPeer(String pairingCode) async {
  final client = _signalingClient;
  if (client == null || !client.isConnected) {
    throw ConnectionException('Not connected to signaling server');
  }

  // ... more code ...
  client.requestPairing(pairingCode);
}
```

---

### Pattern 3: Null-aware operators for callbacks

**Before (Lines 175, 178):**
```dart
_webrtcService.onSignalingMessage = (targetPeerId, message) {
  if (_signalingClient == null || !_signalingClient!.isConnected) return;

  if (message['type'] == 'ice_candidate') {
    _signalingClient!.sendIceCandidate(targetPeerId, message);
  }
};
```

**After:**
```dart
_webrtcService.onSignalingMessage = (targetPeerId, message) {
  final client = _signalingClient;
  if (client == null || !client.isConnected) return;

  if (message['type'] == 'ice_candidate') {
    client.sendIceCandidate(targetPeerId, message);
  }
};
```

---

### Pattern 4: Map value extraction

**Before (Line 334):**
```dart
if (_peers.containsKey(peerId)) {
  _peers[peerId] = _peers[peerId]!.copyWith(
    connectionState: state,
    lastSeen: DateTime.now(),
  );
  _notifyPeersChanged();
}
```

**After:**
```dart
final peer = _peers[peerId];
if (peer != null) {
  _peers[peerId] = peer.copyWith(
    connectionState: state,
    lastSeen: DateTime.now(),
  );
  _notifyPeersChanged();
}
```

---

### Pattern 5: Method-scoped client capture (for `enableExternalConnections`)

**Before (Lines 96-105):**
```dart
_externalPairingCode = pairingCode ?? _generatePairingCode();

_signalingClient = SignalingClient(
  serverUrl: serverUrl,
  pairingCode: _externalPairingCode!,
  publicKey: _cryptoService.publicKeyBase64,
);

_signalingSubscription =
    _signalingClient!.messages.listen(_handleSignalingMessage);

await _signalingClient!.connect();

return _externalPairingCode!;
```

**After:**
```dart
final code = pairingCode ?? _generatePairingCode();
_externalPairingCode = code;

final client = SignalingClient(
  serverUrl: serverUrl,
  pairingCode: code,
  publicKey: _cryptoService.publicKeyBase64,
);
_signalingClient = client;

_signalingSubscription = client.messages.listen(_handleSignalingMessage);

await client.connect();

return code;
```

---

### Pattern 6: Safe async handler for signaling messages

**Before (Line 307):**
```dart
case SignalingOffer(from: final from, payload: final payload):
  // ... code ...
  final answer = await _webrtcService.handleOffer(from, payload);
  _signalingClient!.sendAnswer(from, answer);
  break;
```

**After:**
```dart
case SignalingOffer(from: final from, payload: final payload):
  // Capture client reference before async operation
  final client = _signalingClient;
  if (client == null) {
    return; // Connection was closed
  }

  // ... code ...
  _configureSignalingCallback();

  final answer = await _webrtcService.handleOffer(from, payload);

  // Check if client is still valid and connected after async operation
  if (client.isConnected) {
    client.sendAnswer(from, answer);
  }
  break;
```

---

## Complete Refactored Methods

### `_startWebRTCConnection` - Full Refactor

```dart
Future<void> _startWebRTCConnection(String peerCode, String peerPublicKey, bool isInitiator) async {
  // Capture signaling client before any async operations
  final client = _signalingClient;
  if (client == null || !client.isConnected) {
    _updatePeerState(peerCode, PeerConnectionState.failed);
    return;
  }

  // Store peer's public key for handshake verification
  _cryptoService.setPeerPublicKey(peerCode, peerPublicKey);

  // Set up signaling message forwarding
  _configureSignalingCallback();

  if (isInitiator) {
    try {
      final offer = await _webrtcService.createOffer(peerCode);

      // Re-verify client is still connected after async operation
      if (client.isConnected) {
        client.sendOffer(peerCode, offer);
      } else {
        _updatePeerState(peerCode, PeerConnectionState.failed);
      }
    } catch (e) {
      _updatePeerState(peerCode, PeerConnectionState.failed);
      rethrow;
    }
  }
}
```

### `connectToExternalPeer` - Full Refactor

```dart
Future<void> connectToExternalPeer(String pairingCode) async {
  final client = _signalingClient;
  if (client == null || !client.isConnected) {
    throw ConnectionException('Not connected to signaling server');
  }

  // Create a placeholder peer (waiting for approval)
  final peer = Peer(
    id: pairingCode,
    displayName: 'Peer $pairingCode',
    connectionState: PeerConnectionState.connecting,
    lastSeen: DateTime.now(),
    isLocal: false,
  );
  _peers[pairingCode] = peer;
  _notifyPeersChanged();

  // Request pairing (peer must approve before WebRTC starts)
  client.requestPairing(pairingCode);
}
```

---

## Testing Recommendations

### Unit Tests

1. **Test null client scenarios:**
```dart
test('connectToExternalPeer throws when signaling client is null', () {
  final manager = ConnectionManager(...);
  // Don't call enableExternalConnections

  expect(
    () => manager.connectToExternalPeer('ABC123'),
    throwsA(isA<ConnectionException>()),
  );
});
```

2. **Test disconnection during async operations:**
```dart
test('sendOffer handles disconnection during createOffer', () async {
  final manager = ConnectionManager(...);
  await manager.enableExternalConnections(serverUrl: 'wss://test');

  // Start connection that will call createOffer
  final connectionFuture = manager.connectToExternalPeer('ABC123');

  // Immediately disable - simulates race condition
  await manager.disableExternalConnections();

  // Should not throw, should handle gracefully
  await connectionFuture;

  // Peer should be in failed state, not crash
  final peer = manager.currentPeers.firstWhere((p) => p.id == 'ABC123');
  expect(peer.connectionState, PeerConnectionState.failed);
});
```

3. **Test map access safety:**
```dart
test('_updatePeerState handles removed peer gracefully', () {
  final manager = ConnectionManager(...);

  // This should not throw even if peer doesn't exist
  manager.updatePeerState('nonexistent', PeerConnectionState.connected);
});
```

### Integration Tests

1. **Rapid connect/disconnect cycles:**
```dart
test('handles rapid connect/disconnect without crashes', () async {
  for (var i = 0; i < 100; i++) {
    final future = manager.enableExternalConnections(serverUrl: 'wss://test');
    manager.disableExternalConnections();
    await future.catchError((_) {}); // Ignore errors, just no crashes
  }
});
```

2. **Concurrent operations:**
```dart
test('handles concurrent peer connections safely', () async {
  await manager.enableExternalConnections(serverUrl: 'wss://test');

  // Start multiple connections simultaneously
  await Future.wait([
    manager.connectToExternalPeer('PEER1'),
    manager.connectToExternalPeer('PEER2'),
    manager.connectToExternalPeer('PEER3'),
  ]);

  // All should complete without null assertion errors
});
```

---

## Summary

| Line | Risk Level | Current Pattern | Recommended Fix |
|------|------------|-----------------|-----------------|
| 96 | Low | Direct assertion after assignment | Use local variable |
| 101 | Low | Direct assertion after assignment | Use local variable |
| 103 | Low | Direct assertion after assignment | Use local variable |
| 105 | Low | Direct assertion after assignment | Use local variable |
| 121 | Low | Guard with short-circuit | Capture to local variable |
| 137 | Medium | Assertion after guard (no async between) | Use captured variable from guard |
| 163 | **High** | Assertion after async operation | Capture before async, re-check after |
| 175 | Low | Guard with short-circuit | Capture to local variable |
| 178 | Medium | Assertion after guard | Use captured variable from guard |
| 307 | **High** | Assertion after async operation | Capture before async, re-check after |
| 334 | Low | Map check then access | Extract value first, null check result |

## Priority for Fixes

1. **Critical (Lines 163, 307):** Fix immediately - these can cause runtime crashes during normal operation when timing conditions align
2. **Medium (Lines 137, 178):** Fix soon - potential crashes in edge cases
3. **Low (All others):** Refactor for code quality - improve readability and maintainability

## Dart Null Safety Best Practices Reference

1. **Capture nullable values to local variables** before using them, especially across async boundaries
2. **Avoid `!` operator** unless you have compile-time certainty the value is non-null
3. **Use `?.` and `??`** for optional chaining and default values
4. **Prefer early returns** over nested null checks
5. **Map access pattern:** Use `map[key]` and check for null, rather than `containsKey` then `map[key]!`
6. **Async consideration:** Always re-check nullable state after `await` since state can change during suspension

---

## Research: How Other Apps Solve This

This section documents research findings on how production Flutter/Dart apps handle null safety to avoid crashes from unsafe null assertions.

### 1. Flutter Official Guidance

The Dart team provides comprehensive guidance on null safety best practices:

**Key Principles from [Understanding Null Safety](https://dart.dev/null-safety/understanding-null-safety):**

1. **Copy to Local Variables**: Rather than repeatedly using `!` on fields, assign nullable values to local variables first. Flow analysis then promotes these locals to non-nullable types:
   ```dart
   var temperature = _temperature;
   if (temperature != null) {
     print('Ready to serve ' + temperature + '!');
   }
   ```

2. **Flow Analysis for Null Promotion**: Dart's control flow analysis automatically "promotes" nullable types to non-nullable ones:
   - Null checks trigger promotion: "If you check a local variable with nullable type to see if it is not null, Dart then promotes the variable to the underlying non-nullable type."
   - Reachability-based promotion: Early returns enable cleaner null handling
   - **Limitation**: "Flow-based type promotion can only apply to fields that are both private and final." Public or mutable fields require workarounds (like local variable capture).

3. **Late Initialization**: Use `late` for delayed initialization instead of making fields nullable:
   - Defers constraint enforcement to runtime
   - Combined with `final`, allows single-assignment after declaration
   - Enables lazy field initialization

4. **Null-Aware Method Chains**: Leverage `?.`, `?..`, and `?[]` operators which "short-circuit if the receiver is null" rather than forcing unsafe assertions.

**From [DCM's avoid-non-null-assertion rule](https://dcm.dev/docs/rules/common/avoid-non-null-assertion/):**
> The `!` operator should be treated as a dangerous operator and only used when we're very sure our variable will not be null. Frequent use of the bang operator can be a code smell, indicating a need to refactor code to handle nullability more gracefully.

---

### 2. Sealed Classes and Pattern Matching (Dart 3)

Dart 3 introduced powerful features that eliminate many null assertion scenarios:

**Sealed Classes for Exhaustive State Handling:**

From [Using Sealed Classes and Pattern Matching in Dart](https://medium.com/@d3xvn/using-sealed-classes-and-pattern-matching-in-dart-89c2fe22901c):

```dart
sealed class ConnectionState {}

class Disconnected extends ConnectionState {}
class Connecting extends ConnectionState {}
class Connected extends ConnectionState {
  final SignalingClient client;
  Connected(this.client);
}
class Failed extends ConnectionState {
  final String error;
  Failed(this.error);
}
```

**Exhaustive Pattern Matching:**

With sealed classes, the compiler ensures all cases are handled:

```dart
void handleConnection(ConnectionState state) {
  switch (state) {
    case Disconnected():
      print('Not connected');
    case Connecting():
      print('Connecting...');
    case Connected(client: final client):
      // client is guaranteed non-null here!
      client.sendMessage('Hello');
    case Failed(error: final error):
      print('Failed: $error');
  }
}
```

**Null-Check Patterns:**

From [Dart Language Branches](https://dart.dev/language/branches):
```dart
String? maybeString = 'nullable with base type String';
switch (maybeString) {
  case var s?:
    // 's' has type non-nullable String here
}
```

The `?` suffix in patterns matches only if the value is not null, then binds the non-null value.

**Application to Connection Manager:**

Instead of `SignalingClient?` with null assertions, use:

```dart
sealed class SignalingState {}
class SignalingDisconnected extends SignalingState {}
class SignalingConnected extends SignalingState {
  final SignalingClient client;
  final String pairingCode;
  SignalingConnected({required this.client, required this.pairingCode});
}

// Usage - no null assertions needed:
switch (_signalingState) {
  case SignalingConnected(client: final client, pairingCode: final code):
    await client.connect();
    return code;
  case SignalingDisconnected():
    throw ConnectionException('Not connected');
}
```

---

### 3. Functional Programming Patterns (fpdart)

The [fpdart](https://pub.dev/packages/fpdart) package brings functional programming patterns that eliminate null-related crashes:

**Option Type (Alternative to Nullable):**

From [Option type and Null Safety in Dart](https://www.sandromaglione.com/articles/option_type_and_null_safety_dart):

```dart
Option<SignalingClient> _signalingClient = Option.none();

// Safe access - no crash possible
_signalingClient.match(
  () => throw ConnectionException('Not connected'),
  (client) => client.sendOffer(peerCode, offer),
);

// Or with getOrElse
_signalingClient.getOrElse(() => throw ConnectionException('Not connected'))
    .sendOffer(peerCode, offer);
```

**Either Type for Error Handling:**

From [Functional Error Handling with Either and fpdart](https://codewithandrea.com/articles/functional-error-handling-either-fpdart/):

```dart
typedef ConnectionResult = Either<ConnectionError, String>;

Future<ConnectionResult> enableExternalConnections({
  required String serverUrl,
  String? pairingCode,
}) async {
  return Either.tryCatch(
    () async {
      final code = pairingCode ?? _generatePairingCode();
      final client = SignalingClient(serverUrl: serverUrl, pairingCode: code);
      await client.connect();
      return code;
    },
    (error, stackTrace) => ConnectionError.fromException(error),
  );
}
```

**Key Advantages:**
- **Compile-time safety**: Unhandled errors prevent compilation
- **Self-documenting**: Error possibilities appear in function signatures
- **No exception surprises**: All failure modes are explicit
- **Chainable operations**: `map`, `flatMap`, `fold` enable declarative pipelines

**TaskEither for Async Operations:**

```dart
TaskEither<ConnectionError, SignalingClient> connectToServer(String url) {
  return TaskEither.tryCatch(
    () async {
      final client = SignalingClient(serverUrl: url);
      await client.connect();
      return client;
    },
    (error, _) => ConnectionError.connectionFailed(error.toString()),
  );
}
```

---

### 4. State Machine Patterns

Several Flutter packages implement state machines that guarantee non-null values at the type level:

**From [statemachine package](https://pub.dev/packages/statemachine):**

> You can define transitions between states that are triggered by events. Since futures cannot be suspended or cancelled, the future continues to run even if the owning state is deactivated. Should the state be activated, and the future value is already present, then the value is immediately supplied into the callback.

**From [flutter_operations package](https://pub.dev/packages/flutter_operations):**

> A lightweight, type-safe operation state management utility that eliminates the common dance of manually juggling isLoading, error, and data fields. It leverages Dart's sealed classes and exhaustive pattern matching to make illegal states unrepresentable.

**State Machine for Connection Manager:**

```dart
import 'package:statemachine/statemachine.dart';

enum ConnectionEvent { connect, disconnect, peerConnected, peerFailed }

class ConnectionStateMachine {
  late final StateMachine<ConnectionState, ConnectionEvent> _machine;

  ConnectionStateMachine() {
    final disconnected = State<ConnectionState, ConnectionEvent>('disconnected');
    final connecting = State<ConnectionState, ConnectionEvent>('connecting');
    final connected = State<ConnectionState, ConnectionEvent>('connected');

    disconnected.onEvent(ConnectionEvent.connect, connecting);
    connecting.onFuture(_connect, connected);
    connected.onEvent(ConnectionEvent.disconnect, disconnected);

    _machine = StateMachine(disconnected);
  }

  // States guarantee what's available - no null checks needed
  void sendOffer(String peerCode, Map<String, dynamic> offer) {
    if (_machine.currentState.name == 'connected') {
      final client = _machine.data as SignalingClient; // Guaranteed non-null in this state
      client.sendOffer(peerCode, offer);
    }
  }
}
```

---

### 5. Riverpod's AsyncValue Pattern

[Riverpod](https://riverpod.dev)'s `AsyncValue` demonstrates how to represent async states without null assertions:

From [AsyncValue class documentation](https://pub.dev/documentation/riverpod/latest/riverpod/AsyncValue-class.html):

```dart
sealed class AsyncValue<T> {
  const factory AsyncValue.data(T value) = AsyncData<T>;
  const factory AsyncValue.loading() = AsyncLoading<T>;
  const factory AsyncValue.error(Object error, StackTrace stackTrace) = AsyncError<T>;
}
```

**Why This Is Better Than Nullable:**

From [Flutter Riverpod Tip: Use AsyncValue](https://codewithandrea.com/articles/flutter-use-async-value-not-future-stream-builder/):

> In Flutter's SDK, `AsyncSnapshot` has `connectionState`, `data`, `error`, and `stackTrace` - all independent of each other. The main problem is that these variables are all independent, but this is not a good representation for states that should be mutually exclusive. The AsyncValue class shows us how it's done - it uses factory constructors to define three mutually exclusive states.

**AsyncValue.guard for Safe Async:**

From [Use AsyncValue.guard rather than try/catch](https://codewithandrea.com/tips/async-value-guard-try-catch/):

```dart
Future<void> signOut() async {
  final authRepository = ref.read(authRepositoryProvider);
  state = const AsyncValue.loading();
  state = await AsyncValue.guard(authRepository.signOut);
}
```

**Application to Connection Manager:**

```dart
class ConnectionNotifier extends StateNotifier<AsyncValue<SignalingClient>> {
  ConnectionNotifier() : super(const AsyncValue.loading());

  Future<void> connect(String serverUrl) async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      final client = SignalingClient(serverUrl: serverUrl);
      await client.connect();
      return client;
    });
  }

  void sendOffer(String peerCode, Map<String, dynamic> offer) {
    state.whenData((client) {
      client.sendOffer(peerCode, offer);
    });
  }
}
```

---

### 6. WebSocket Connection Patterns

Production Flutter apps handling WebSocket connections use these patterns:

From [Building realtime apps with Flutter and WebSockets](https://ably.com/topic/websockets-flutter):

**Two-Stream Architecture:**

> Instead of overwhelming the UI layer with data responsibilities, consolidate reconnection logic to the data layer within a single class. Use two streams: an inner stream that maintains connection to the socket and an outer stream that serves as the entry point.

**Defensive Connection Checks:**

From [WebSocket Reconnection in Flutter](https://medium.com/@ilia_zadiabin/websocket-reconnection-in-flutter-35bb7ff50d0d):

> WebSocketChannel doesn't offer built-in configuration options for handling reconnection. Hence, we need to manually react to stream errors with `onError` and `onDone` callbacks.

**Production Pattern:**

```dart
class WebSocketService {
  WebSocketChannel? _channel;
  final _messageController = StreamController<Message>.broadcast();

  Stream<Message> get messages => _messageController.stream;

  Future<void> connect(String url) async {
    _channel = WebSocketChannel.connect(Uri.parse(url));

    _channel?.stream.listen(
      (data) => _messageController.add(Message.fromJson(data)),
      onError: (error) {
        _messageController.addError(error);
        _scheduleReconnect();
      },
      onDone: () {
        _scheduleReconnect();
      },
    );
  }

  void send(Message message) {
    final channel = _channel;
    if (channel == null) {
      throw ConnectionException('Not connected');
    }
    // Local variable capture - safe to use
    channel.sink.add(message.toJson());
  }
}
```

---

### 7. Summary of Recommended Patterns for This Codebase

Based on the research, here are the recommended approaches in order of implementation complexity:

| Pattern | Complexity | When to Use |
|---------|------------|-------------|
| **Local Variable Capture** | Low | Immediate fix for all `!` usages |
| **Null-Check Patterns** (`case var x?:`) | Low | Switch expressions with nullable values |
| **Sealed Classes** | Medium | Replace nullable state with type-safe states |
| **AsyncValue/Result Types** | Medium | Async operations with loading/error states |
| **fpdart Either/Option** | Medium | Functional error handling, chain operations |
| **State Machines** | High | Complex state transitions, guaranteed invariants |

**Recommended Implementation Path:**

1. **Phase 1 (Immediate)**: Apply local variable capture pattern to all `!` usages (already documented above)

2. **Phase 2 (Short-term)**: Replace `SignalingClient?` with sealed class:
   ```dart
   sealed class SignalingState {}
   class SignalingDisconnected extends SignalingState {}
   class SignalingConnected extends SignalingState {
     final SignalingClient client;
     final String pairingCode;
   }
   ```

3. **Phase 3 (Medium-term)**: Consider `AsyncValue` pattern for connection state management, especially if adopting Riverpod

4. **Phase 4 (Long-term)**: Evaluate fpdart for comprehensive functional error handling across the codebase

---

### Sources

- [Dart: Understanding Null Safety](https://dart.dev/null-safety/understanding-null-safety)
- [DCM: avoid-non-null-assertion rule](https://dcm.dev/docs/rules/common/avoid-non-null-assertion/)
- [Stop Using Null Assertions in Flutter](https://tomasrepcik.dev/blog/2025/2025-07-13-stop-using-null-assertions/)
- [Using Sealed Classes and Pattern Matching in Dart](https://medium.com/@d3xvn/using-sealed-classes-and-pattern-matching-in-dart-89c2fe22901c)
- [Dart 3: Records, Pattern Matching, Sealed Classes](https://medium.com/@dnkibere/dart-3-records-pattern-matching-sealed-classes-and-more-12a9e3a52447)
- [Functional Error Handling with Either and fpdart](https://codewithandrea.com/articles/functional-error-handling-either-fpdart/)
- [fpdart package](https://pub.dev/packages/fpdart)
- [Option type and Null Safety in Dart](https://www.sandromaglione.com/articles/option_type_and_null_safety_dart)
- [Riverpod AsyncValue class](https://pub.dev/documentation/riverpod/latest/riverpod/AsyncValue-class.html)
- [Flutter Riverpod Tip: Use AsyncValue](https://codewithandrea.com/articles/flutter-use-async-value-not-future-stream-builder/)
- [AsyncValue.guard vs try/catch](https://codewithandrea.com/tips/async-value-guard-try-catch/)
- [statemachine package](https://pub.dev/packages/statemachine)
- [flutter_operations package](https://pub.dev/packages/flutter_operations)
- [Building realtime apps with Flutter and WebSockets](https://ably.com/topic/websockets-flutter)
- [WebSocket Reconnection in Flutter](https://medium.com/@ilia_zadiabin/websocket-reconnection-in-flutter-35bb7ff50d0d)
- [Dart Language: Branches](https://dart.dev/language/branches)
- [Dart Language: Patterns](https://dart.dev/language/patterns)
