# Issue #12: Race Condition in Callback Management - Research Document

## Executive Summary

This research document examines the race condition issue in the Zajel codebase's callback management, analyzes the current implementation, identifies remaining vulnerabilities, documents solutions from other messaging applications, and provides recommended fixes based on industry best practices.

**Key Finding**: The codebase has already implemented Solution 2 (Stream-Based Signaling Events) from the original issue document, which significantly reduces race condition risks. However, some edge cases remain that should be addressed.

---

## 1. Current Implementation Analysis

### 1.1 Stream-Based Signaling Events (Implemented)

The `WebRTCService` now uses a stream-based approach instead of the vulnerable callback pattern:

**File**: `/home/meywd/zajel/packages/app/lib/core/network/webrtc_service.dart`

```dart
/// Signaling event for stream-based signaling message delivery.
/// This replaces the callback-based approach to avoid race conditions
/// when multiple connections are attempted simultaneously.
class SignalingEvent {
  final String peerId;
  final Map<String, dynamic> message;

  SignalingEvent({required this.peerId, required this.message});
}

// Stream-based signaling events to avoid race conditions
// when multiple connections are attempted simultaneously.
// Uses a broadcast stream so multiple listeners can subscribe.
final _signalingController = StreamController<SignalingEvent>.broadcast();

/// Stream of signaling events (ICE candidates, etc.) for all peers.
Stream<SignalingEvent> get signalingEvents => _signalingController.stream;
```

**ICE Candidate Handler** (lines 296-312):
```dart
connection.pc.onIceCandidate = (candidate) {
  if (candidate.candidate != null) {
    final message = {
      'type': 'ice_candidate',
      'candidate': candidate.candidate,
      'sdpMid': candidate.sdpMid,
      'sdpMLineIndex': candidate.sdpMLineIndex,
    };

    // Emit to stream (preferred approach - no race conditions)
    _signalingController.add(SignalingEvent(peerId: peerId, message: message));

    // Also call deprecated callback for backward compatibility
    // ignore: deprecated_member_use_from_same_package
    onSignalingMessage?.call(peerId, message);
  }
};
```

### 1.2 ConnectionManager Subscription Pattern

**File**: `/home/meywd/zajel/packages/app/lib/core/network/connection_manager.dart`

The `ConnectionManager` now subscribes to the signaling events stream once per connection session:

```dart
/// Subscription to WebRTC signaling events (ICE candidates, etc.).
/// Uses stream-based approach to avoid race conditions when multiple
/// connections are attempted simultaneously. This replaces the previous
/// callback-based approach (`onSignalingMessage`) that was vulnerable
/// to being overwritten by each new connection.
StreamSubscription? _signalingEventsSubscription;
```

**Subscription Setup** (lines 180-188 in `enableExternalConnections`):
```dart
_signalingEventsSubscription = _webrtcService.signalingEvents.listen((event) {
  // Check if we're still connected before sending
  final state = _signalingState;
  if (state is! SignalingConnected || !state.client.isConnected) return;

  if (event.message['type'] == 'ice_candidate') {
    state.client.sendIceCandidate(event.peerId, event.message);
  }
});
```

### 1.3 Sealed Class for State Management

The codebase uses Dart's sealed classes for type-safe state handling:

```dart
/// Sealed class representing the signaling connection state.
///
/// Using a sealed class ensures exhaustive pattern matching and
/// eliminates the need for unsafe null assertions.
sealed class SignalingState {}

/// Signaling is disconnected - no client available.
class SignalingDisconnected extends SignalingState {}

/// Signaling is connected with an active client and pairing code.
class SignalingConnected extends SignalingState {
  final SignalingClient client;
  final String pairingCode;

  SignalingConnected({required this.client, required this.pairingCode});
}
```

### 1.4 Client Reference Capture Pattern

The code captures client references before async operations to prevent stale references:

```dart
Future<void> _startWebRTCConnection(String peerCode, String peerPublicKey, bool isInitiator) async {
  // Pattern 1: Capture signaling client before async operations (HIGH risk fix)
  final state = _signalingState;
  if (state is! SignalingConnected || !state.client.isConnected) {
    _updatePeerState(peerCode, PeerConnectionState.failed);
    return;
  }
  final client = state.client;

  // ... async operations ...

  // Re-verify client is still connected after async operation
  if (client.isConnected) {
    client.sendOffer(peerCode, offer);
  } else {
    _updatePeerState(peerCode, PeerConnectionState.failed);
  }
}
```

---

## 2. Remaining Race Condition Scenarios

### 2.1 Rapid Reconnection Timing

**Scenario**:
1. User is connected, `_signalingEventsSubscription` is active
2. `disableExternalConnections()` is called
3. User immediately calls `enableExternalConnections()` again
4. Events from the old WebRTC connections may still be in flight

**Current Mitigation**:
```dart
Future<String> enableExternalConnections({...}) async {
  // Cancel existing subscriptions to prevent leaks if called multiple times
  await _signalingSubscription?.cancel();
  _signalingSubscription = null;
  await _signalingEventsSubscription?.cancel();
  _signalingEventsSubscription = null;
  // ...
}
```

**Remaining Risk**: The `await` on subscription cancellation may not block until all pending events are processed. Events that were already dispatched but not yet handled could reference stale state.

### 2.2 Connection State Checks During Async Operations

**Scenario**:
1. `handleOffer` is processing an incoming SDP offer
2. User calls `disableExternalConnections()` during the `await _webrtcService.handleOffer()` call
3. After the await completes, the code tries to send an answer using a now-disconnected client

**Current Mitigation**:
```dart
case SignalingOffer(from: final from, payload: final payload):
  final signalingState = _signalingState;
  if (signalingState is! SignalingConnected) {
    return;  // Connection was closed
  }
  final client = signalingState.client;

  // ... async operation ...

  // Check if client is still valid after async operation
  if (client.isConnected) {
    client.sendAnswer(from, answer);
  }
```

**Assessment**: This is properly handled by capturing the client reference and checking `isConnected` after async operations.

### 2.3 Multiple Simultaneous Peer Connections

**Scenario**:
1. User initiates connection to Peer A and Peer B simultaneously
2. Both connections generate ICE candidates concurrently
3. Events are emitted to the stream from both connections

**Assessment**: The stream-based approach handles this correctly. Each `SignalingEvent` contains the `peerId`, so events are properly routed. This is a significant improvement over the callback approach.

### 2.4 Broadcast Stream Late Subscription

**Scenario**:
1. ICE candidates are generated before `_signalingEventsSubscription` is set up
2. These early events are lost because broadcast streams don't buffer

**Current Mitigation**: The subscription is set up before `client.connect()` returns, which should happen before any ICE candidates are generated.

**Remaining Risk**: If `createOffer()` is called before the stream subscription is fully active, early ICE candidates could be lost.

---

## 3. Dart Stream Subscription Best Practices

### 3.1 Stream Types and Race Conditions

From [Dart documentation](https://dart.dev/libraries/async/using-streams):

**Single-Subscription Streams**: Allow only one listener at a time. Once a listener is attached, no other listener can be added until the first one is canceled.

**Broadcast Streams**: Allow multiple listeners simultaneously. Suitable for scenarios where multiple parts of an application need to react to the same data.

**Key Insight**: The codebase correctly uses `StreamController<SignalingEvent>.broadcast()` because signaling events may need to be consumed by multiple components in the future.

### 3.2 Concurrency and Isolates

From [Dart concurrency documentation](https://dart.dev/language/concurrency):

> "No shared state between isolates means concurrency complexities like mutexes or locks and data races won't occur in Dart. That said, isolates don't prevent race conditions altogether."

Race conditions in Dart primarily occur due to:
- Async gaps (awaits) where state can change
- Callback ordering issues
- Stream event interleaving

### 3.3 Bloc Pattern Event Transformers

From [Very Good Ventures blog](https://www.verygood.ventures/blog/how-to-use-bloc-with-streams-and-concurrency):

The `restartable()` event transformer cancels any previous event still running when a new one is added, ensuring only one event handler is ever active at once. This is applicable to signaling scenarios where only the latest connection attempt matters.

### 3.4 Memory Management

From [Flutter best practices](https://medium.com/@alaxhenry0121/understanding-streamsubscription-in-dart-and-flutter-best-practices-and-memory-management-0293789d078a):

> "Canceling a stream subscription frees up resources and prevents memory leaks in your application."

The current implementation properly cancels subscriptions in `dispose()`:
```dart
Future<void> dispose() async {
  await _signalingEventsSubscription?.cancel();
  _signalingEventsSubscription = null;
  // ...
}
```

---

## 4. State Machine Patterns for Connection Management

### 4.1 Finite State Machine Libraries

Several Dart/Flutter packages implement FSM patterns:

1. **[statemachine package](https://pub.dev/packages/statemachine)**: Simple, powerful state machine framework supporting transitions triggered by streams or futures.

2. **[state_machine package](https://pub.dev/packages/state_machine)**: Allows defining legal state transitions and listening to state entrances, departures, and transitions.

3. **[Bloc-based State Machines](https://github.com/felangel/bloc/issues/3246)**: Proposal to add StateMachine as a sub-class of BlocBase.

### 4.2 Connection State Machine Design

From the current `PeerConnectionState` enum:
```dart
enum PeerConnectionState {
  disconnected,
  discovering,
  connecting,
  handshaking,
  connected,
  failed,
}
```

**Valid Transitions**:
```
disconnected -> discovering -> connecting -> handshaking -> connected
                      |              |            |
                      v              v            v
                   failed         failed       failed
                      |              |            |
                      v              v            v
                   disconnected  disconnected  disconnected
```

### 4.3 State Machine Benefits for Race Conditions

From [Jawahar.tech blog](https://jawahar.tech/blog/finite-state-machine-flutter):

> "State machines capture all the states, events and transitions between them. Using state machines makes it easier to find impossible states and spot undesirable transitions."

A state machine would prevent:
- Sending messages when disconnected
- Starting handshake before connection is established
- Processing ICE candidates after connection is closed

---

## 5. Solutions from Other Messaging Applications

### 5.1 Signal: Explicit Dependency Injection

From [Signal Android PR #13820](https://github.com/signalapp/Signal-Android/pull/13820):

**The Problem**: During network resets, `SignalWebSocket` was recreated. If the old `IncomingMessageObserver` was still terminating asynchronously, it could accidentally reference and manipulate the **new** `SignalWebSocket`.

**The Solution**: Signal now passes `SignalWebSocket` as a constructor parameter to `IncomingMessageObserver`, ensuring each observer is explicitly tied to a specific WebSocket instance.

**Pattern Applied in Zajel**: The current implementation captures the client reference before async operations, which is similar to Signal's approach.

### 5.2 Signal: ICE Forking

From [Signal blog](https://signal.org/blog/ice-forking/):

Signal's multi-device calling requires sharing ICE parameters and candidates across all possible ICE connections. They contributed an upstream patch to WebRTC for complete ICE forking support.

**Key Insight**: ICE candidate handling requires careful coordination when multiple connections share state.

### 5.3 Telegram: Session vs Connection Separation

From [Telegram MTProto documentation](https://core.telegram.org/mtproto/description):

> "Sessions are attached to the client device, not to connections. Several connections to a server may be open; messages may be sent in either direction through any of the connections."

**Application to Zajel**: Consider separating the logical "peer session" from the physical WebRTC connection. This would allow:
- Cleaner reconnection handling
- State preservation across connection attempts
- Better queue management for offline messages

### 5.4 Matrix Element: Event Stream with State

From [Matrix Android SDK](https://github.com/matrix-org/matrix-android-sdk):

Matrix SDK callbacks receive both the event AND the room state at the time of the event. This prevents race conditions where the current state doesn't match the event context.

**Application to Zajel**: Include connection state in `SignalingEvent`:
```dart
class SignalingEvent {
  final String peerId;
  final Map<String, dynamic> message;
  final PeerConnectionState connectionState; // Add state context

  SignalingEvent({...});
}
```

### 5.5 WebRTC ICE Restart Best Practices

From [MDN RTCPeerConnection.restartIce()](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce):

> "After `restartIce()` returns, the offer returned by the next call to `createOffer()` is automatically configured to trigger ICE restart."

ICE restart is necessary when:
- Network changes (WiFi to mobile)
- Connection goes to `disconnected` state
- Connection goes to `failed` state

From [ICE Restarts article](https://medium.com/@fippo/ice-restarts-5d759caceda6):

> "ICE restarts reestablish the connection in about two-thirds of the cases. In about 85% of unsuccessful ICE restarts, no new answer is received from the peer, which probably means they are not connected to the signaling server anymore."

---

## 6. Identified Race Condition Scenarios in Current Implementation

### 6.1 HIGH RISK: Stream Subscription Timing

**Location**: `ConnectionManager.enableExternalConnections()` lines 180-192

**Scenario**: There's a window between WebRTC connection creation and stream subscription setup where ICE candidates could be generated but not captured.

**Current Code Flow**:
```dart
// 1. Cancel old subscriptions
await _signalingEventsSubscription?.cancel();

// 2. Set up new subscription
_signalingEventsSubscription = _webrtcService.signalingEvents.listen((event) {
  // handle event
});

// 3. Connect (may trigger ICE gathering)
await client.connect();
```

**Risk**: If `client.connect()` triggers ICE gathering synchronously (unlikely but possible), events could be missed.

**Mitigation**: Subscription is set up before `connect()`, so this should be safe.

### 6.2 MEDIUM RISK: Async Operation Interleaving

**Location**: `ConnectionManager._handleSignalingMessage()` - SignalingOffer case

**Scenario**: Multiple offers arriving simultaneously could interleave their async processing.

**Current Code**:
```dart
case SignalingOffer(...):
  final client = signalingState.client;
  // ... create peer ...
  final answer = await _webrtcService.handleOffer(from, payload);  // ASYNC GAP
  if (client.isConnected) {
    client.sendAnswer(from, answer);
  }
```

**Risk**: During the `await`, another offer could arrive, or connection state could change.

**Mitigation**: Client reference is captured before await, and `isConnected` is checked after.

### 6.3 MEDIUM RISK: Deprecated Callback Still Active

**Location**: `WebRTCService._setupConnectionHandlers()` line 311

**Current Code**:
```dart
// Also call deprecated callback for backward compatibility
// ignore: deprecated_member_use_from_same_package
onSignalingMessage?.call(peerId, message);
```

**Risk**: The deprecated callback could still be set by legacy code, creating dual event delivery and potential inconsistencies.

**Recommendation**: Remove deprecated callback entirely after confirming no code uses it.

### 6.4 LOW RISK: Peer State Update Race

**Location**: `ConnectionManager._updatePeerState()`

**Current Code**:
```dart
void _updatePeerState(String peerId, PeerConnectionState state) {
  final peer = _peers[peerId];
  if (peer != null) {
    _peers[peerId] = peer.copyWith(
      connectionState: state,
      lastSeen: DateTime.now(),
    );
    _notifyPeersChanged();
    // ...
  }
}
```

**Risk**: Multiple concurrent state updates could overwrite each other.

**Mitigation**: Dart's single-threaded nature prevents true concurrent writes, but async gaps could still cause out-of-order updates.

---

## 7. Recommended Fixes

### 7.1 Add Connection Generation Token (Priority: HIGH)

Implement a generation token to invalidate stale event handlers:

```dart
class ConnectionManager {
  int _connectionGeneration = 0;

  Future<String> enableExternalConnections({...}) async {
    final currentGeneration = ++_connectionGeneration;

    _signalingEventsSubscription = _webrtcService.signalingEvents.listen((event) {
      // Validate this subscription is still for the current generation
      if (_connectionGeneration != currentGeneration) return;

      final state = _signalingState;
      if (state is! SignalingConnected || !state.client.isConnected) return;

      if (event.message['type'] == 'ice_candidate') {
        state.client.sendIceCandidate(event.peerId, event.message);
      }
    });
  }
}
```

### 7.2 Remove Deprecated Callback (Priority: MEDIUM)

Remove the deprecated `onSignalingMessage` callback from `WebRTCService`:

```dart
// Remove this line from _setupConnectionHandlers():
// ignore: deprecated_member_use_from_same_package
// onSignalingMessage?.call(peerId, message);

// Remove the deprecated field:
// @Deprecated('Use signalingEvents stream instead to avoid race conditions')
// OnSignalingMessageCallback? onSignalingMessage;
```

### 7.3 Add State Context to SignalingEvent (Priority: LOW)

Include connection state in signaling events for better context:

```dart
class SignalingEvent {
  final String peerId;
  final Map<String, dynamic> message;
  final PeerConnectionState? connectionState;
  final DateTime timestamp;

  SignalingEvent({
    required this.peerId,
    required this.message,
    this.connectionState,
    DateTime? timestamp,
  }) : timestamp = timestamp ?? DateTime.now();
}
```

### 7.4 Implement State Machine for Connection Lifecycle (Priority: LOW)

Create a formal state machine for connection transitions:

```dart
class ConnectionStateMachine {
  PeerConnectionState _state = PeerConnectionState.disconnected;

  /// Returns true if transition is allowed
  bool transition(PeerConnectionState newState) {
    if (!_isValidTransition(_state, newState)) {
      return false;
    }
    _state = newState;
    return true;
  }

  bool _isValidTransition(PeerConnectionState from, PeerConnectionState to) {
    return switch ((from, to)) {
      (PeerConnectionState.disconnected, PeerConnectionState.discovering) => true,
      (PeerConnectionState.discovering, PeerConnectionState.connecting) => true,
      (PeerConnectionState.connecting, PeerConnectionState.handshaking) => true,
      (PeerConnectionState.handshaking, PeerConnectionState.connected) => true,
      (_, PeerConnectionState.failed) => true,
      (_, PeerConnectionState.disconnected) => true,
      _ => false,
    };
  }
}
```

### 7.5 Use SubscriptionManager Mixin (Priority: LOW)

The codebase already has a `SubscriptionManager` mixin. Consider using it in `ConnectionManager`:

```dart
class ConnectionManager with SubscriptionManager {
  Future<String> enableExternalConnections({...}) async {
    // Use track() for automatic cleanup
    track(_webrtcService.signalingEvents.listen((event) {
      // ...
    }));
  }

  Future<void> dispose() async {
    await cancelAllSubscriptions();
    // ...
  }
}
```

---

## 8. Testing Recommendations

### 8.1 Unit Tests for Race Conditions

```dart
test('handles rapid reconnection without stale event delivery', () async {
  final manager = ConnectionManager(...);
  final events = <SignalingEvent>[];

  // Connect first time
  await manager.enableExternalConnections(serverUrl: 'ws://test1');

  // Immediately reconnect (simulates rapid reconnection)
  await manager.enableExternalConnections(serverUrl: 'ws://test2');

  // Simulate ICE candidate from first connection
  // Verify it's not processed (stale)
  // ...
});
```

### 8.2 Integration Tests for Multi-Peer Scenarios

```dart
test('correctly routes ICE candidates for concurrent connections', () async {
  final manager = ConnectionManager(...);

  // Connect to two peers simultaneously
  await Future.wait([
    manager.connectToExternalPeer('PEER_A'),
    manager.connectToExternalPeer('PEER_B'),
  ]);

  // Verify ICE candidates from PEER_A go to PEER_A
  // Verify ICE candidates from PEER_B go to PEER_B
  // ...
});
```

### 8.3 Stress Tests for Subscription Cleanup

```dart
test('no memory leak after repeated connect/disconnect cycles', () async {
  final manager = ConnectionManager(...);

  for (int i = 0; i < 100; i++) {
    await manager.enableExternalConnections(serverUrl: 'ws://test');
    await manager.connectToExternalPeer('PEER_$i');
    await manager.disableExternalConnections();
  }

  // Verify no subscription leaks
  // Verify memory usage is stable
});
```

---

## 9. Conclusion

The current implementation has successfully migrated from a callback-based approach to a stream-based approach, which significantly reduces race condition risks. The key improvements are:

1. **Stream-based signaling events**: Eliminates callback overwriting race condition
2. **Sealed class for state**: Type-safe state handling with exhaustive pattern matching
3. **Client reference capture**: Prevents stale reference access after async operations
4. **Subscription cleanup**: Proper cancellation in `dispose()` and `disableExternalConnections()`

Remaining improvements to consider:
1. Add generation token for connection sessions
2. Remove deprecated callback
3. Consider formal state machine for connection lifecycle
4. Use `SubscriptionManager` mixin for centralized subscription management

---

## 10. References

### Dart/Flutter
- [Dart Streams Documentation](https://dart.dev/libraries/async/using-streams)
- [Dart Concurrency](https://dart.dev/language/concurrency)
- [Bloc with Streams and Concurrency](https://www.verygood.ventures/blog/how-to-use-bloc-with-streams-and-concurrency)
- [StreamSubscription Best Practices](https://medium.com/@alaxhenry0121/understanding-streamsubscription-in-dart-and-flutter-best-practices-and-memory-management-0293789d078a)
- [Race Conditions in Flutter](https://medium.com/@dev.h.majid/understanding-race-conditions-in-flutter-and-dart-and-how-to-solve-them-d94976f6bd0a)
- [Async Misuse in Flutter](https://dcm.dev/blog/2025/05/28/hidden-cost-async-misuse-flutter-fix)

### State Machine Patterns
- [statemachine package](https://pub.dev/packages/statemachine)
- [Finite State Machine in Flutter](https://jawahar.tech/blog/finite-state-machine-flutter)
- [State Machines and Statecharts in Dart](https://www.sandromaglione.com/articles/how-to-implement-state-machines-and-statecharts-in-dart-and-flutter)
- [BLoC State Machine Proposal](https://github.com/felangel/bloc/issues/3246)

### Messaging Applications
- [Signal Android PR #13820 - WebSocket Race Condition Fix](https://github.com/signalapp/Signal-Android/pull/13820)
- [Signal ICE Forking](https://signal.org/blog/ice-forking/)
- [Signal WebRTC Fork](https://github.com/signalapp/webrtc)
- [Telegram MTProto Protocol](https://core.telegram.org/mtproto)
- [Matrix Android SDK](https://github.com/matrix-org/matrix-android-sdk)
- [Matrix Rust SDK VoIP Issue](https://github.com/matrix-org/matrix-rust-sdk/issues/3295)
- [Element Call](https://github.com/element-hq/element-call)

### WebRTC
- [RTCPeerConnection.restartIce()](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce)
- [WebRTC Peer Connections](https://webrtc.org/getting-started/peer-connections)
- [ICE Restarts](https://medium.com/@fippo/ice-restarts-5d759caceda6)
- [WebRTC Session Lifetime](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Session_lifetime)
- [Anatomy of a WebRTC Connection](https://www.webrtc-developers.com/anatomy-of-a-webrtc-connection/)

---

*Document created: January 2026*
*Last updated: January 2026*
