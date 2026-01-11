# Issue #12: Race Condition in Callback Management

## Summary

The `onSignalingMessage` callback in `WebRTCService` is a single callback that could potentially be overwritten if not managed correctly. While the current implementation has a safeguard (`_signalingCallbackConfigured` flag), there are still potential race conditions and architectural concerns that should be addressed.

## Current Implementation Analysis

### Files Involved

1. **`/home/meywd/zajel/packages/app/lib/core/network/connection_manager.dart`**
2. **`/home/meywd/zajel/packages/app/lib/core/network/signaling_client.dart`**
3. **`/home/meywd/zajel/packages/app/lib/core/network/webrtc_service.dart`**

### How Callbacks Work Currently

#### WebRTCService (lines 47-52)

The `WebRTCService` uses a single callback pattern for signaling messages:

```dart
// Active connections
final Map<String, _PeerConnection> _connections = {};

// Callbacks
OnMessageCallback? onMessage;
OnFileChunkCallback? onFileChunk;
OnFileStartCallback? onFileStart;
OnFileCompleteCallback? onFileComplete;
OnConnectionStateCallback? onConnectionStateChange;
OnSignalingMessageCallback? onSignalingMessage;  // Single callback for ALL peers
```

#### WebRTCService ICE Candidate Handler (lines 272-282)

When ICE candidates are generated, the single `onSignalingMessage` callback is invoked with the `peerId`:

```dart
connection.pc.onIceCandidate = (candidate) {
  if (candidate.candidate != null) {
    onSignalingMessage?.call(peerId, {
      'type': 'ice_candidate',
      'candidate': candidate.candidate,
      'sdpMid': candidate.sdpMid,
      'sdpMLineIndex': candidate.sdpMLineIndex,
    });
  }
};
```

#### ConnectionManager Configuration (lines 168-181)

The `ConnectionManager` configures the callback once using a flag:

```dart
/// Configure the signaling callback once to handle all peers.
/// This avoids race conditions from overwriting the callback per-peer.
void _configureSignalingCallback() {
  if (_signalingCallbackConfigured) return;
  _signalingCallbackConfigured = true;

  _webrtcService.onSignalingMessage = (targetPeerId, message) {
    if (_signalingClient == null || !_signalingClient!.isConnected) return;

    if (message['type'] == 'ice_candidate') {
      _signalingClient!.sendIceCandidate(targetPeerId, message);
    }
  };
}
```

### Current Safeguard

The code already has a safeguard to prevent overwriting:
- `_signalingCallbackConfigured` boolean flag (line 37)
- Checked at lines 171-172 before setting the callback
- Reset to `false` in `disableExternalConnections()` (line 115) and `dispose()` (line 214)

## Race Condition Scenario Description

### Scenario 1: Rapid Reconnection

1. User connects to Peer A, callback is configured
2. Connection fails, `disableExternalConnections()` is called, flag is reset
3. User quickly reconnects to Peer A and Peer B simultaneously
4. Two `_startWebRTCConnection` calls race to `_configureSignalingCallback`
5. First one sets the callback, second is blocked (safe)
6. **Potential issue**: If the first connection fails mid-setup, the callback may reference stale state

### Scenario 2: State Inconsistency During Disposal

1. Multiple peers connected (Peer A, Peer B, Peer C)
2. `dispose()` is called
3. `_signalingCallbackConfigured` is reset to `false`
4. `_webrtcService.dispose()` is called asynchronously
5. **Potential issue**: ICE candidates from ongoing connections may still invoke the callback which now references a disposed `_signalingClient`

### Scenario 3: Signaling Client Replacement

1. User is connected to peers via signaling server A
2. User calls `enableExternalConnections()` with a different server URL
3. New `SignalingClient` is created
4. The `onSignalingMessage` callback still references the old signaling flow
5. **Potential issue**: Callback check `_signalingClient!.isConnected` may pass but messages go to wrong server

### Scenario 4: Flag Reset Timing (Current Code Weakness)

Looking at `disableExternalConnections()` (lines 109-116):

```dart
Future<void> disableExternalConnections() async {
  await _signalingClient?.disconnect();
  await _signalingSubscription?.cancel();
  _signalingSubscription = null;
  _signalingClient = null;
  _externalPairingCode = null;
  _signalingCallbackConfigured = false;  // Reset AFTER client is nullified
}
```

The callback might fire between `_signalingClient = null` and the callback being cleared, causing a null pointer access (though the null check in the callback prevents a crash).

## Proposed Solutions

### Solution 1: Map of Callbacks by PeerId (Recommended)

Replace the single callback with a per-peer callback map in `WebRTCService`:

```dart
// In webrtc_service.dart

/// Callback type for per-peer signaling
typedef OnPeerSignalingCallback = void Function(Map<String, dynamic> message);

/// Per-peer signaling callbacks
final Map<String, OnPeerSignalingCallback> _signalingCallbacks = {};

/// Register a signaling callback for a specific peer
void registerSignalingCallback(String peerId, OnPeerSignalingCallback callback) {
  _signalingCallbacks[peerId] = callback;
}

/// Unregister a signaling callback for a specific peer
void unregisterSignalingCallback(String peerId) {
  _signalingCallbacks.remove(peerId);
}

// Update ICE candidate handler in _setupConnectionHandlers:
connection.pc.onIceCandidate = (candidate) {
  if (candidate.candidate != null) {
    final callback = _signalingCallbacks[peerId];
    callback?.call({
      'type': 'ice_candidate',
      'candidate': candidate.candidate,
      'sdpMid': candidate.sdpMid,
      'sdpMLineIndex': candidate.sdpMLineIndex,
    });
  }
};
```

In `ConnectionManager`:

```dart
Future<void> _startWebRTCConnection(String peerCode, String peerPublicKey, bool isInitiator) async {
  _cryptoService.setPeerPublicKey(peerCode, peerPublicKey);

  // Register per-peer callback
  _webrtcService.registerSignalingCallback(peerCode, (message) {
    if (_signalingClient == null || !_signalingClient!.isConnected) return;
    if (message['type'] == 'ice_candidate') {
      _signalingClient!.sendIceCandidate(peerCode, message);
    }
  });

  if (isInitiator) {
    final offer = await _webrtcService.createOffer(peerCode);
    _signalingClient!.sendOffer(peerCode, offer);
  }
}

// Clean up when disconnecting a peer
Future<void> disconnectPeer(String peerId) async {
  _webrtcService.unregisterSignalingCallback(peerId);
  await _webrtcService.closeConnection(peerId);
  _updatePeerState(peerId, PeerConnectionState.disconnected);
}
```

### Solution 2: Stream-Based Signaling Events

Use a stream instead of callbacks for better lifecycle management:

```dart
// In webrtc_service.dart

/// Stream controller for signaling messages
final _signalingController = StreamController<(String peerId, Map<String, dynamic> message)>.broadcast();

/// Stream of signaling messages (peerId, message)
Stream<(String, Map<String, dynamic>)> get signalingMessages => _signalingController.stream;

// Update ICE candidate handler:
connection.pc.onIceCandidate = (candidate) {
  if (candidate.candidate != null) {
    _signalingController.add((peerId, {
      'type': 'ice_candidate',
      'candidate': candidate.candidate,
      'sdpMid': candidate.sdpMid,
      'sdpMLineIndex': candidate.sdpMLineIndex,
    }));
  }
};

// In dispose:
Future<void> dispose() async {
  for (final peerId in _connections.keys.toList()) {
    await closeConnection(peerId);
  }
  await _signalingController.close();
}
```

In `ConnectionManager`:

```dart
StreamSubscription? _signalingMessageSubscription;

Future<String> enableExternalConnections({
  required String serverUrl,
  String? pairingCode,
}) async {
  // ... existing code ...

  // Subscribe to signaling messages once
  _signalingMessageSubscription = _webrtcService.signalingMessages.listen((record) {
    final (peerId, message) = record;
    if (_signalingClient == null || !_signalingClient!.isConnected) return;
    if (message['type'] == 'ice_candidate') {
      _signalingClient!.sendIceCandidate(peerId, message);
    }
  });

  // ... rest of code ...
}

Future<void> disableExternalConnections() async {
  await _signalingMessageSubscription?.cancel();
  _signalingMessageSubscription = null;
  // ... rest of cleanup ...
}
```

### Solution 3: Synchronization Token Pattern

Add a version/token to validate callback context:

```dart
// In connection_manager.dart

int _callbackVersion = 0;

void _configureSignalingCallback() {
  if (_signalingCallbackConfigured) return;
  _signalingCallbackConfigured = true;

  final capturedVersion = ++_callbackVersion;
  final capturedClient = _signalingClient;

  _webrtcService.onSignalingMessage = (targetPeerId, message) {
    // Validate callback is still relevant
    if (capturedVersion != _callbackVersion) return;
    if (capturedClient == null || !capturedClient.isConnected) return;

    if (message['type'] == 'ice_candidate') {
      capturedClient.sendIceCandidate(targetPeerId, message);
    }
  };
}

Future<void> disableExternalConnections() async {
  _callbackVersion++; // Invalidate existing callbacks
  await _signalingClient?.disconnect();
  // ... rest of cleanup ...
}
```

## Recommended Approach

**Solution 1 (Map of Callbacks by PeerId)** is recommended because:

1. **Explicit cleanup**: Each peer connection has its own callback that can be explicitly cleaned up
2. **No shared state race**: Callbacks don't share state that could become stale
3. **Better debugging**: Can easily track which peers have active callbacks
4. **Consistent with existing patterns**: The code already uses `Map<String, _PeerConnection>` for connection management
5. **Minimal refactoring**: Only requires changes to callback registration, not the overall architecture

## Testing Recommendations

### Unit Tests

1. **Test callback isolation**:
   ```dart
   test('each peer gets its own callback', () async {
     final manager = ConnectionManager(...);
     await manager.enableExternalConnections(serverUrl: 'ws://test');

     // Connect two peers simultaneously
     await Future.wait([
       manager.connectToExternalPeer('PEER_A'),
       manager.connectToExternalPeer('PEER_B'),
     ]);

     // Verify each peer has independent callback
     // Check that ICE candidates from PEER_A go to PEER_A target
     // Check that ICE candidates from PEER_B go to PEER_B target
   });
   ```

2. **Test cleanup on disconnect**:
   ```dart
   test('callback is removed when peer disconnects', () async {
     final manager = ConnectionManager(...);
     await manager.connectToExternalPeer('PEER_A');
     await manager.disconnectPeer('PEER_A');

     // Verify callback map no longer contains PEER_A
   });
   ```

3. **Test rapid reconnection**:
   ```dart
   test('handles rapid reconnection without callback leak', () async {
     final manager = ConnectionManager(...);

     for (int i = 0; i < 10; i++) {
       await manager.enableExternalConnections(serverUrl: 'ws://test');
       await manager.connectToExternalPeer('PEER_A');
       await manager.disableExternalConnections();
     }

     // Verify no memory leaks or stale callbacks
   });
   ```

### Integration Tests

1. **Multi-peer scenario**:
   - Connect to 3+ peers simultaneously
   - Exchange messages with all peers
   - Disconnect one peer while others remain connected
   - Verify remaining connections work correctly

2. **Server switchover**:
   - Connect to peers via server A
   - Disable external connections
   - Enable external connections with server B
   - Verify old callbacks don't fire

3. **Stress test**:
   - Rapidly connect/disconnect peers
   - Monitor for callback leaks using a callback counter
   - Verify callback count matches active peer count

### Manual Testing Checklist

- [ ] Connect two devices, verify ICE candidates route correctly
- [ ] With two devices connected, connect a third device
- [ ] Disconnect one device, verify others continue working
- [ ] Force-close app during connection, reconnect, verify clean state
- [ ] Switch WiFi networks mid-connection, verify reconnection works

## Implementation Priority

1. **High**: Implement Solution 1 (Map of Callbacks by PeerId)
2. **Medium**: Add unit tests for callback isolation
3. **Medium**: Add integration tests for multi-peer scenarios
4. **Low**: Consider Solution 2 (Streams) for future architectural improvements

## Related Files to Update

- `/home/meywd/zajel/packages/app/lib/core/network/webrtc_service.dart`
- `/home/meywd/zajel/packages/app/lib/core/network/connection_manager.dart`
- Add tests in `/home/meywd/zajel/packages/app/test/core/network/`

## Conclusion

The current implementation has a basic safeguard against callback overwriting via the `_signalingCallbackConfigured` flag. However, this flag-based approach has edge cases around disposal timing and signaling client replacement. Moving to a per-peer callback map (Solution 1) would provide stronger guarantees and better align with the existing per-peer connection management pattern in the codebase.

---

## Research: How Other Apps Solve This

This section documents how major messaging applications handle callback/event management to avoid race conditions in their mobile clients.

### 1. Signal Android/iOS

#### WebSocket Architecture

Signal Android uses a [three-layer network architecture](https://deepwiki.com/signalapp/Signal-Android/4.1-main-navigation-and-conversation-list):
1. **API Clients Layer**: High-level domain-specific APIs (MessageApi, ProfileApi, ArchiveApi)
2. **Transport Layer**: WebSocket and HTTP communication mechanisms
3. **Native Layer**: libsignal's Network implementation for low-level networking

Signal maintains **two WebSocket connections** with different authentication models, managed by a native Network instance from libsignal.

#### Race Condition Handling

A [critical PR (#13820)](https://github.com/signalapp/Signal-Android/pull/13820) addressed a race condition in `IncomingMessageObserver`:

**The Problem**: During network resets (`AppDependencies.resetNetwork()`), `NetworkDependenciesModule` and its `SignalWebSocket` were recreated. If the old `IncomingMessageObserver` was still terminating asynchronously, it could accidentally reference and manipulate the **new** `SignalWebSocket`, causing:
- Old observer disconnecting the new socket
- Old socket remaining connected
- Logs showing two observers running simultaneously

**The Solution**: Signal now passes `SignalWebSocket` as a **constructor parameter** to `IncomingMessageObserver`, ensuring each observer is explicitly tied to a specific WebSocket instance. This eliminates the shared mutable reference problem.

#### Key Patterns Used

1. **Explicit Dependency Injection**: WebSocket passed via constructor, not obtained from global state
2. **Observer Notification Pattern**: `IncomingMessageObserver` uses a wait/notify pattern for connection lifecycle
3. **Version Token Pattern**: Similar to our Solution 3, ensuring callbacks reference the correct generation of resources

#### libsignal Thread Safety

[libsignal's C implementation](https://github.com/signalapp/libsignal-protocol-c) requires clients to [explicitly set up locking functions](https://github.com/signalapp/libsignal):

```c
signal_context_set_locking_functions(global_context, lock_function, unlock_function);
```

This pattern acknowledges that **thread safety is a client responsibility**. The library provides hooks but doesn't impose a threading model.

**Lesson for Zajel**: Race conditions often occur at the integration layer, not in the underlying libraries. Signal's approach of explicit dependency injection rather than global singletons is directly applicable.

---

### 2. Telegram MTProto Architecture

#### Protocol Design

[Telegram's MTProto protocol](https://core.telegram.org/mtproto) is subdivided into three independent components:
1. **High-level component (API query language)**: Converts API queries/responses to binary messages
2. **Cryptographic layer**: Encrypts messages before transmission
3. **Transport component**: Handles transmission over HTTP/HTTPS/WS/WSS/TCP/UDP

#### Session vs Connection Separation

A critical architectural decision: **sessions are attached to the client device, not to connections**. From [Telegram's documentation](https://core.telegram.org/mtproto/description):

> "Each session is attached to a user key ID by which authorization is actually accomplished. Several connections to a server may be open; messages may be sent in either direction through any of the connections (a response to a query is not necessarily returned through the same connection that carried the original query)."

This separation means:
- Multiple connections can serve a single session
- Responses can arrive on different connections than requests
- Connection failures don't require session re-establishment

#### RPC Request/Response Handling

Telegram's [event dispatch system](https://sitano.github.io/2018/11/26/tg-arch-notes/) uses:
1. **Monotonically increasing message IDs**: Each RPC query has a unique ID
2. **Handler registration**: Clients register waiting handlers for specific IDs
3. **Content-related message acknowledgment**: Server resends unacknowledged messages on reconnection

```
RPC queries IDs are usual monotonically increasing sequence of natural numbers starting from 1.
```

This pattern ensures:
- No callback collisions (unique ID per request)
- Automatic retry on connection failure
- Clear ownership of response handlers

#### NotificationCenter Pattern

Telegram's Android client uses a [NotificationCenter pattern](https://codentrick.com/observer-pattern-in-mobile-eventbus-and-notificationcenter/) (similar to iOS) for internal event distribution:
- Decouples event producers from consumers
- 1-to-many notification delivery
- Components register/unregister for specific event types

**Lesson for Zajel**: The session/connection separation is valuable. Our `WebRTCService` could maintain a "logical session" abstraction independent of the underlying `RTCPeerConnection`, allowing for cleaner reconnection handling.

---

### 3. Matrix SDK (Element Android)

#### SDK Architecture

The [Matrix Android SDK2](https://github.com/matrix-org/matrix-android-sdk2) (used by Element) provides:

> "The data handler provides a layer to help manage data from the events stream. While it is possible to write an app with no data handler and manually make API calls, using one is highly recommended."

#### Event Stream Handling

The SDK uses a [streaming event model](https://github.com/matrix-org/matrix-android-sdk):

1. **Event Stream Thread**: `session.startEventStream()` starts the events thread
2. **Data Handler**: Manages state and provides room objects
3. **Callbacks**: `onLiveEvent`, `onBackEvent`, `onInitialSyncComplete`, `onLiveEventsChunkProcessed`

Key design decisions:
- **State snapshots with events**: Callbacks receive both the event AND the room state at the time of the event
- **Automatic retry**: "Any request is automatically resent until it succeeds (with a 3 minutes timeline)"
- **Listener cleanup**: "The SDK removes dataHandler listeners when logging out to avoid getting unexpected callback calls"
- **Network awareness**: "The SDK does not restart the events listener each 10 seconds if there is no available network"

#### Modern Patterns (Kotlin Coroutines + Flow)

For [modern Android development](https://developer.android.com/kotlin/flow), the recommended patterns are:

```kotlin
// StateFlow for state management
val _state = MutableStateFlow<UiState>(UiState.Loading)
val state: StateFlow<UiState> = _state.asStateFlow()

// Collecting flows with lifecycle awareness
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.state.collect { state ->
            updateUI(state)
        }
    }
}
```

**Key insight**: `StateFlow` and `SharedFlow` provide:
- Thread-safe state updates
- Automatic lifecycle management
- No callback registration/unregistration boilerplate

**Lesson for Zajel**: Matrix's approach of bundling state with events (providing context) and automatic listener cleanup on logout are directly applicable patterns.

---

### 4. WhatsApp Architecture

#### Client-Server Model

[WhatsApp's architecture](https://medium.com/@YodgorbekKomilo/the-system-design-of-whatsapp-for-android-behind-the-scenes-of-a-global-messaging-giant-c80175b18016) uses:

1. **Persistent WebSocket connections** for real-time messaging
2. **FIFO message queues** to ensure ordering
3. **Event-driven architecture** for real-time updates

#### Message Queue Pattern

From [WhatsApp's system design](https://www.cometchat.com/blog/whatsapps-architecture-and-system-design):

> "When an XMPP message is sent, it goes to WhatsApp's custom Ejabberd server... The message is saved in a Mnesia database table where it gets put into a queue."

Key patterns:
- **Queue-based delivery**: Messages queued until client reconnects
- **Acknowledgment system**: Success status sent back, server forwards to original sender
- **Automatic reconnection**: "If the WebSocket connection is interrupted, the app automatically reconnects and syncs"

#### Connection Handling

WhatsApp uses [FunXMPP](https://getstream.io/blog/whatsapp-works/), a compressed XMPP variant:
- 50-70% bandwidth reduction through binary encoding
- SSL socket connections for security
- Message queuing during disconnection

**Lesson for Zajel**: The acknowledgment pattern and queue-based delivery during disconnection could improve our reliability. Consider implementing a local queue for outbound signaling messages.

---

### 5. Flutter Best Practices

#### RxDart for Reactive Streams

[RxDart](https://maxim-gorin.medium.com/reactive-programming-with-rxdart-comprehensive-guide-1912006db5ed) provides operators that directly address race conditions:

1. **`switchMap`**: Cancels previous async operations when new ones start - prevents stale callbacks
2. **`debounce`**: Delays emission until quiet period - prevents rapid-fire events
3. **`throttle`**: Limits event rate - prevents callback flooding

```dart
// Example: Prevent stale search results
searchSubject
    .debounce(Duration(milliseconds: 300))
    .switchMap((query) => searchApi(query))
    .listen((results) => updateUI(results));
```

#### BehaviorSubject for State

[BehaviorSubject](https://hackernoon.com/flutter-state-management-with-rxdart-streams) is ideal for callback state:

> "A BehaviorSubject stores the latest value it has emitted and emits that most recent value to any new subscribers."

Benefits:
- Late subscribers get current state immediately
- No race between subscription and first value
- Clear state ownership

#### CompositeSubscription for Lifecycle

RxDart's [CompositeSubscription](https://moldstud.com/articles/p-master-rxdart-techniques-for-advanced-stream-manipulation) manages multiple subscriptions:

```dart
final subscriptions = CompositeSubscription();

// Add subscriptions
subscriptions.add(stream1.listen(...));
subscriptions.add(stream2.listen(...));

// Cancel all at once
@override
void dispose() {
    subscriptions.dispose();
    super.dispose();
}
```

#### StreamController Best Practices

From [Flutter documentation](https://api.flutter.dev/flutter/dart-async/StreamController-class.html):

1. **Broadcast streams**: For multiple listeners, use `StreamController.broadcast()`
2. **Lazy initialization**: Use `onListen` callback to start producing events only when subscribed
3. **Resource cleanup**: Use `onCancel` to clean up when no listeners remain

```dart
final controller = StreamController<SignalingMessage>.broadcast(
    onListen: () => _startWebSocket(),
    onCancel: () => _stopWebSocketIfNoListeners(),
);
```

---

### 6. WebRTC Connection Lifecycle State Machine

#### Connection States

The [WebRTC specification](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Session_lifetime) defines clear connection states:

- **new**: Connection just created, negotiation not started
- **connecting**: Negotiation in progress
- **connected**: Successfully negotiated, data channels open
- **disconnected**: One or more transports disconnected
- **failed**: One or more transports failed
- **closed**: Connection closed

#### State Machine Pattern

[Best practices](https://medium.com/@BeingOttoman/best-practices-for-closing-webrtc-peerconnections-b60616b1352) recommend:

> "Before calling `RTCPeerConnection.close()`, it's crucial to ensure that the connection is either connected or failed. Closing connections in transitional states (connecting or disconnected) can lead to issues."

This suggests implementing a **state machine** that:
1. Only allows valid state transitions
2. Buffers/queues operations during transitional states
3. Prevents operations on closed connections

#### Mobile-Specific Considerations

[Mobile edge cases](https://www.webrtc-developers.com/anatomy-of-a-webrtc-connection/) require special handling:

1. **iOS Local Network Permission**: ICE may appear to succeed but OS silently blocks traffic
2. **Android Network Transitions**: Route can become invalid during DTLS handshake
3. **ICE Restart**: Network changes trigger renegotiation while media continues

**Perfect Negotiation Pattern**: The [W3C recommends](https://w3c.github.io/webrtc-pc/) a "perfect negotiation" pattern for signaling that provides transparency and allows both sides to be offerer or answerer.

---

### 7. Connection Multiplexing Patterns

#### Single Connection, Multiple Channels

[WebSocket multiplexing](https://github.com/sockjs/websocket-multiplex) uses a message format:

```
type,topic,payload
```

Where types include:
- `sub`: Subscribe to topic
- `msg`: Message on topic
- `unsub`: Unsubscribe

Benefits:
- Logical separation of functionality
- Single TCP connection reduces overhead
- Easier connection lifecycle management

#### Pub/Sub for Scale

[Scaling recommendations](https://medium.com/@li.ying.explore/how-to-design-a-chat-system-web-server-to-support-large-scale-concurrent-websocket-connections-19d9d500ecae):

> "Consider adopting a publish-subscribe pattern, where clients subscribe to specific data streams and receive updates only when relevant data changes occur."

**Message Batching**: "Avoid sending many small messages... batch multiple messages together and send them as a single, larger message."

---

### Summary: Recommended Patterns for Zajel

Based on this research, the following patterns are most applicable to our callback race condition issue:

| Pattern | Source | Applicability |
|---------|--------|---------------|
| **Explicit Dependency Injection** | Signal | Pass WebSocket to observers via constructor, not global state |
| **Per-Request Handler Map** | Telegram | Use unique IDs for requests, map IDs to handlers |
| **Stream-Based Events** | Flutter/RxDart | Replace callbacks with broadcast streams |
| **Session/Connection Separation** | Telegram | Abstract logical session from physical connection |
| **Lifecycle-Aware Subscriptions** | Matrix/Flutter | Auto-cleanup subscriptions on dispose |
| **State Machine for Connections** | WebRTC Spec | Only allow valid state transitions |
| **Acknowledgment + Queue** | WhatsApp | Queue messages during disconnection, acknowledge delivery |
| **CompositeSubscription** | RxDart | Manage all subscriptions in one place |

### Recommended Implementation Order

1. **Immediate**: Implement per-peer callback map (Solution 1 from original analysis)
2. **Short-term**: Convert to stream-based signaling events (Solution 2)
3. **Medium-term**: Add connection state machine with valid transitions
4. **Long-term**: Consider session/connection separation for robustness

### References

- [Signal Android PR #13820 - WebSocket Race Condition Fix](https://github.com/signalapp/Signal-Android/pull/13820)
- [Telegram MTProto Protocol](https://core.telegram.org/mtproto)
- [Matrix Android SDK](https://github.com/matrix-org/matrix-android-sdk)
- [RxDart Comprehensive Guide](https://maxim-gorin.medium.com/reactive-programming-with-rxdart-comprehensive-guide-1912006db5ed)
- [WebRTC Session Lifetime](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Session_lifetime)
- [WhatsApp System Design](https://www.cometchat.com/blog/whatsapps-architecture-and-system-design)
- [Flutter StreamController](https://api.flutter.dev/flutter/dart-async/StreamController-class.html)
- [Android Kotlin Flow](https://developer.android.com/kotlin/flow)
- [Event Bus Pattern in Android](https://dev.to/mohitrajput987/event-bus-pattern-in-android-using-kotlin-flows-la)
