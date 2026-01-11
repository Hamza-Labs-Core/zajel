# Issue #18: Resource Leaks in Dart

## Summary

This document analyzes potential resource leaks in the networking layer, specifically focusing on WebSocket and Signaling subscriptions that may not be properly cleaned up.

## Files Analyzed

- `/home/meywd/zajel/packages/app/lib/core/network/signaling_client.dart`
- `/home/meywd/zajel/packages/app/lib/core/network/connection_manager.dart`
- `/home/meywd/zajel/packages/app/lib/core/network/webrtc_service.dart`
- `/home/meywd/zajel/packages/app/lib/core/network/peer_reconnection_service.dart`
- `/home/meywd/zajel/packages/app/lib/core/network/relay_client.dart`

---

## Resource Allocation Inventory

### 1. SignalingClient (signaling_client.dart)

| Resource | Type | Line | Allocation Point | Cleanup Location |
|----------|------|------|-----------------|------------------|
| `_channel` | `WebSocketChannel?` | 22 | `connect()` line 59 | `_cleanupConnection()` line 106 |
| `_subscription` | `StreamSubscription?` | 23 | `connect()` line 63 | `_cleanupConnection()` line 102 |
| `_messageController` | `StreamController<SignalingMessage>` | 24-25 | Constructor | `dispose()` line 164 |
| `_connectionStateController` | `StreamController<SignalingConnectionState>` | 26-27 | Constructor | `dispose()` line 165 |
| `_heartbeatTimer` | `Timer?` | 30 | `_startHeartbeat()` line 276 | `_stopHeartbeat()` line 284 |

**Cleanup Status**: GOOD - All resources properly cleaned up in `dispose()` and `_cleanupConnection()`.

### 2. ConnectionManager (connection_manager.dart)

| Resource | Type | Line | Allocation Point | Cleanup Location |
|----------|------|------|-----------------|------------------|
| `_signalingClient` | `SignalingClient?` | 22 | `enableExternalConnections()` line 94 | `dispose()` line 216 |
| `_signalingSubscription` | `StreamSubscription?` | 36 | `enableExternalConnections()` line 100 | `dispose()` line 212, `enableExternalConnections()` line 89, `disableExternalConnections()` line 111 |
| `_peersController` | `StreamController<List<Peer>>` | 26 | Constructor | `dispose()` line 217 |
| `_messagesController` | `StreamController<(String, String)>` | 27-28 | Constructor | `dispose()` line 218 |
| `_fileChunksController` | `StreamController<...>` | 29-30 | Constructor | `dispose()` line 219 |
| `_fileStartController` | `StreamController<...>` | 31-32 | Constructor | `dispose()` line 220 |
| `_fileCompleteController` | `StreamController<...>` | 33-34 | Constructor | `dispose()` line 221 |
| `_pairRequestController` | `StreamController<(String, String)>` | 77-78 | Constructor | `dispose()` line 222 |

**Cleanup Status**: GOOD - Properly handles re-connection scenario by canceling existing subscription before creating new one.

### 3. WebRTCService (webrtc_service.dart)

| Resource | Type | Line | Allocation Point | Cleanup Location |
|----------|------|------|-----------------|------------------|
| `_connections` | `Map<String, _PeerConnection>` | 44 | `_createConnection()` line 261 | `closeConnection()` lines 227-233, `dispose()` lines 237-241 |
| `RTCPeerConnection` (per peer) | Native | 259 | `createPeerConnection()` | `closeConnection()` line 232 |
| `RTCDataChannel` (message) | Native | 313-318 | `createDataChannel()` | `closeConnection()` line 230 |
| `RTCDataChannel` (file) | Native | 323-328 | `createDataChannel()` | `closeConnection()` line 231 |

**Cleanup Status**: GOOD - `closeConnection()` properly closes all resources and `dispose()` iterates all connections.

### 4. PeerReconnectionService (peer_reconnection_service.dart)

| Resource | Type | Line | Allocation Point | Cleanup Location |
|----------|------|------|-----------------|------------------|
| `_signalingClient` | `SignalingClient?` | 30 | `connect()` line 84 | `disconnect()` line 123 |
| `_signalingSubscription` | `StreamSubscription?` | 31 | `connect()` line 99 | `disconnect()` line 120 |
| `_registrationTimer` | `Timer?` | 32 | `connect()` line 106 | `disconnect()` line 117 |
| `_peerFoundController` | `StreamController<PeerFoundEvent>` | 36 | Constructor | `dispose()` line 371 |
| `_connectionRequestController` | `StreamController<ConnectionRequestEvent>` | 37 | Constructor | `dispose()` line 372 |
| `_statusController` | `StreamController<ReconnectionStatus>` | 38 | Constructor | `dispose()` line 373 |
| **LEAK: Relay listener** | `StreamSubscription` | 67 | `_setupRelayListeners()` | **NOT CANCELLED** |

**Cleanup Status**: LEAK FOUND - See Issue #1 below.

### 5. RelayClient (relay_client.dart)

| Resource | Type | Line | Allocation Point | Cleanup Location |
|----------|------|------|-----------------|------------------|
| `_relayConnections` | `Map<String, RelayConnection>` | 30 | Runtime | `dispose()` line 473 |
| `_loadReportTimer` | `Timer?` | 54 | `startPeriodicLoadReporting()` line 371 | `dispose()` line 464, `stopPeriodicLoadReporting()` line 376 |
| `_introductionController` | `StreamController<IntroductionEvent>` | 57-58 | Constructor | `dispose()` line 465 |
| `_introductionErrorController` | `StreamController<IntroductionErrorEvent>` | 59-60 | Constructor | `dispose()` line 466 |
| `_stateController` | `StreamController<RelayStateEvent>` | 61 | Constructor | `dispose()` line 467 |
| `_loadChangeController` | `StreamController<LoadChangeEvent>` | 62 | Constructor | `dispose()` line 468 |

**Cleanup Status**: GOOD - All resources properly cleaned up.

---

## Missing Cleanup Analysis

### Issue #1: Untracked StreamSubscription in PeerReconnectionService (CRITICAL)

**Location**: `/home/meywd/zajel/packages/app/lib/core/network/peer_reconnection_service.dart` lines 65-74

**Problem**: The `_setupRelayListeners()` method creates a StreamSubscription by calling `.listen()` on `_relayClient.onIntroduction`, but this subscription is never stored or cancelled.

```dart
void _setupRelayListeners() {
  // Listen for introductions from other peers through relays
  _relayClient.onIntroduction.listen((event) {  // <-- Subscription not stored!
    _connectionRequestController.add(ConnectionRequestEvent(
      peerId: event.fromSourceId,
      relayId: event.relayId,
      encryptedPayload: event.payload,
      timestamp: DateTime.now(),
    ));
  });
}
```

**Impact**:
- Memory leak: The subscription keeps a reference to the callback and the service
- Zombie listeners: If `PeerReconnectionService` is disposed but `RelayClient` continues to emit events, the callback still runs
- Potential state corruption: Events processed after disposal could add to a closed `StreamController`

### Issue #2: SignalingClient Not Disposed in ConnectionManager.disableExternalConnections()

**Location**: `/home/meywd/zajel/packages/app/lib/core/network/connection_manager.dart` lines 109-116

**Problem**: The `disableExternalConnections()` method calls `_signalingClient?.disconnect()` but does not call `_signalingClient?.dispose()`. This leaves the internal StreamControllers (`_messageController` and `_connectionStateController`) open.

```dart
Future<void> disableExternalConnections() async {
  await _signalingClient?.disconnect();  // Good: closes WebSocket
  await _signalingSubscription?.cancel(); // Good: cancels subscription
  _signalingSubscription = null;
  _signalingClient = null;  // But StreamControllers inside are never closed!
  _externalPairingCode = null;
  _signalingCallbackConfigured = false;
}
```

**Impact**:
- Minor memory leak: StreamControllers remain in memory until GC
- Best practice violation: Should always close StreamControllers when done

### Issue #3: WebRTC Callback Not Cleared in ConnectionManager.dispose()

**Location**: `/home/meywd/zajel/packages/app/lib/core/network/connection_manager.dart` line 174

**Problem**: The `_webrtcService.onSignalingMessage` callback is set in `_configureSignalingCallback()` but never cleared. While `_signalingCallbackConfigured` is set to `false`, the callback itself remains.

```dart
void _configureSignalingCallback() {
  if (_signalingCallbackConfigured) return;
  _signalingCallbackConfigured = true;

  _webrtcService.onSignalingMessage = (targetPeerId, message) {
    if (_signalingClient == null || !_signalingClient!.isConnected) return;
    // ...
  };
}
```

**Impact**:
- Low severity: The callback checks for null `_signalingClient`, so it's functionally safe
- Code smell: Callback closure retains reference to disposed ConnectionManager

### Issue #4: RelayClient.dispose() Uses Sync close() for Async Stream Controllers

**Location**: `/home/meywd/zajel/packages/app/lib/core/network/relay_client.dart` lines 463-476

**Problem**: The `dispose()` method is synchronous but calls `close()` on StreamControllers. While this works, it's inconsistent with the rest of the codebase that uses async disposal.

```dart
void dispose() {  // <-- Not async
  _loadReportTimer?.cancel();
  _introductionController.close();  // These return Futures
  _introductionErrorController.close();
  _stateController.close();
  _loadChangeController.close();

  for (final relayId in _relayConnections.keys.toList()) {
    _webrtcService.closeConnection(relayId);  // This returns Future too
  }
  // ...
}
```

**Impact**:
- Potential race condition: If caller awaits dispose, they'll continue before cleanup completes
- Inconsistency: Other services use `Future<void> dispose() async`

---

## Proposed Fixes

### Fix #1: Store and Cancel Relay Subscription in PeerReconnectionService

```dart
class PeerReconnectionService {
  // ... existing fields ...

  StreamSubscription? _relaySubscription;  // Add this field

  // ... constructor ...

  void _setupRelayListeners() {
    // Cancel any existing subscription first
    _relaySubscription?.cancel();

    // Store the subscription
    _relaySubscription = _relayClient.onIntroduction.listen((event) {
      _connectionRequestController.add(ConnectionRequestEvent(
        peerId: event.fromSourceId,
        relayId: event.relayId,
        encryptedPayload: event.payload,
        timestamp: DateTime.now(),
      ));
    });
  }

  Future<void> dispose() async {
    await disconnect();
    await _relaySubscription?.cancel();  // Add this line
    _relaySubscription = null;
    await _peerFoundController.close();
    await _connectionRequestController.close();
    await _statusController.close();
  }
}
```

### Fix #2: Dispose SignalingClient in ConnectionManager.disableExternalConnections()

```dart
Future<void> disableExternalConnections() async {
  await _signalingSubscription?.cancel();
  _signalingSubscription = null;

  // Dispose properly instead of just disconnecting
  await _signalingClient?.dispose();
  _signalingClient = null;

  _externalPairingCode = null;
  _signalingCallbackConfigured = false;
}
```

### Fix #3: Clear WebRTC Callback in ConnectionManager.dispose()

```dart
Future<void> dispose() async {
  await _signalingSubscription?.cancel();
  _signalingSubscription = null;
  _signalingCallbackConfigured = false;

  // Clear the callback to release closure references
  _webrtcService.onSignalingMessage = null;

  await _webrtcService.dispose();
  await _signalingClient?.dispose();

  await _peersController.close();
  await _messagesController.close();
  await _fileChunksController.close();
  await _fileStartController.close();
  await _fileCompleteController.close();
  await _pairRequestController.close();
}
```

### Fix #4: Make RelayClient.dispose() Async

```dart
/// Dispose resources.
Future<void> dispose() async {
  _loadReportTimer?.cancel();
  _loadReportTimer = null;

  await _introductionController.close();
  await _introductionErrorController.close();
  await _stateController.close();
  await _loadChangeController.close();

  for (final relayId in _relayConnections.keys.toList()) {
    await _webrtcService.closeConnection(relayId);
  }
  _relayConnections.clear();
  _sourceIdToPeerId.clear();
  _peerIdToSourceId.clear();
}
```

---

## Testing Strategy

### Unit Tests

#### Test 1: Verify PeerReconnectionService Subscription Cleanup

```dart
test('dispose cancels relay subscription', () async {
  final mockRelayClient = MockRelayClient();
  final introductionController = StreamController<IntroductionEvent>.broadcast();

  when(() => mockRelayClient.onIntroduction)
      .thenAnswer((_) => introductionController.stream);

  final service = PeerReconnectionService(
    cryptoService: mockCrypto,
    trustedPeers: mockStorage,
    meetingPointService: mockMeetingPoint,
    relayClient: mockRelayClient,
  );

  await service.dispose();

  // After dispose, adding to stream should not trigger any callbacks
  // If subscription wasn't cancelled, this would cause issues with closed controller
  expect(service.onConnectionRequest.isBroadcast, isTrue);

  // The stream should be closed
  await expectLater(
    service.onConnectionRequest,
    emitsDone,
  );

  introductionController.close();
});
```

#### Test 2: Verify SignalingClient Disposal on Disable

```dart
test('disableExternalConnections disposes SignalingClient', () async {
  final connectionManager = ConnectionManager(
    cryptoService: mockCrypto,
    webrtcService: mockWebRTC,
  );

  await connectionManager.enableExternalConnections(
    serverUrl: 'wss://test.example.com',
  );

  // Track if dispose was called
  var disposeCallCount = 0;
  // ... mock setup to track dispose calls

  await connectionManager.disableExternalConnections();

  expect(disposeCallCount, equals(1));
});
```

#### Test 3: Memory Leak Detection Test

```dart
test('no memory leaks after multiple enable/disable cycles', () async {
  final connectionManager = ConnectionManager(
    cryptoService: mockCrypto,
    webrtcService: mockWebRTC,
  );

  // Perform multiple cycles
  for (var i = 0; i < 100; i++) {
    await connectionManager.enableExternalConnections(
      serverUrl: 'wss://test.example.com',
    );
    await connectionManager.disableExternalConnections();
  }

  await connectionManager.dispose();

  // If leaking subscriptions, this would fail or cause issues
  // In actual test, use memory profiler to verify
});
```

### Integration Tests

#### Test 4: Reconnection Service Lifecycle

```dart
testWidgets('PeerReconnectionService handles full lifecycle', (tester) async {
  // Create real instances
  final service = PeerReconnectionService(/* real deps */);

  // Connect and use
  await service.connect('wss://test.example.com');
  await pumpAndSettle(tester);

  // Verify streams are active
  expect(service.isConnected, isTrue);

  // Disconnect
  await service.disconnect();

  // Reconnect
  await service.connect('wss://test.example.com');

  // Dispose
  await service.dispose();

  // Verify no zombie listeners by checking no errors when relay emits
});
```

### Manual Testing Checklist

1. [ ] Enable external connections, connect to peer, disable - verify no memory growth
2. [ ] Repeatedly enable/disable external connections (10+ times) - check for memory leaks
3. [ ] Kill app during active connection - verify graceful cleanup on restart
4. [ ] Force disconnect from signaling server - verify cleanup happens
5. [ ] Use DevTools memory profiler to verify StreamController instances are released

---

## Dart Best Practices for Resource Management

### 1. Always Store StreamSubscriptions

```dart
// BAD
stream.listen(callback);

// GOOD
StreamSubscription? _subscription;
_subscription = stream.listen(callback);
// Later: await _subscription?.cancel();
```

### 2. Use `unawaited()` for Fire-and-Forget Operations

```dart
// If you intentionally don't await a Future, make it explicit
import 'dart:async';

unawaited(someOperation());
```

### 3. Implement Disposable Pattern Consistently

```dart
abstract class Disposable {
  Future<void> dispose();
}

class MyService implements Disposable {
  final List<StreamSubscription> _subscriptions = [];

  void _setup() {
    _subscriptions.add(stream1.listen(handler1));
    _subscriptions.add(stream2.listen(handler2));
  }

  @override
  Future<void> dispose() async {
    for (final sub in _subscriptions) {
      await sub.cancel();
    }
    _subscriptions.clear();
  }
}
```

### 4. Use `cancelOnError: true` When Appropriate

```dart
// Stream stops on first error
_subscription = stream.listen(
  onData,
  onError: handleError,
  cancelOnError: true,  // Automatically cancels on error
);
```

### 5. Consider Using `CompositeSubscription` Pattern

```dart
class CompositeSubscription {
  final List<StreamSubscription> _subscriptions = [];

  void add(StreamSubscription subscription) {
    _subscriptions.add(subscription);
  }

  Future<void> cancel() async {
    for (final sub in _subscriptions) {
      await sub.cancel();
    }
    _subscriptions.clear();
  }
}
```

---

## Priority and Severity Assessment

| Issue | Severity | Priority | Effort |
|-------|----------|----------|--------|
| #1 Relay subscription leak | High | P1 | Low |
| #2 SignalingClient not disposed | Medium | P2 | Low |
| #3 Callback not cleared | Low | P3 | Low |
| #4 Async dispose inconsistency | Low | P3 | Low |

**Recommendation**: Fix Issue #1 immediately as it's a clear memory leak. Issues #2-4 can be addressed in a cleanup PR.

---

## Research: How Other Apps Solve This

This section documents patterns used by Signal, Telegram, and other messaging apps to prevent resource and subscription leaks, along with Flutter/Dart best practices and Android Jetpack patterns.

### 1. Signal-Android Patterns

Signal-Android uses several strategies for lifecycle-aware resource management:

#### Application-Level Lifecycle Observers
Signal's `ApplicationContext.java` uses a pattern of blocking initialization with lifecycle observers:
```java
.addBlocking("lifecycle-observer", () -> AppForegroundObserver.addListener(this))
.addBlocking("message-retriever", this::initializeMessageRetrieval)
```

#### Critical Operations Outside Lifecycle Scope
For operations that must complete regardless of UI lifecycle (like message sending), Signal recommends:
- **Unwrapping from Rx**: Instead of tying message send operations to RxJava streams that may be disposed, dispatch directly to executors
- **Using coroutine scopes**: For Kotlin, use `Dispatchers.IO` context for critical operations
- **Using dedicated executors**: `SignalExecutors.BOUNDED_IO` ensures operations complete even if the UI is destroyed

This is relevant for Zajel because WebRTC signaling messages should complete even if the user navigates away.

**Source**: [Signal-Android PR #14048](https://github.com/signalapp/Signal-Android/pull/14048)

---

### 2. Telegram-Android Patterns

Telegram uses a custom observer pattern with built-in leak detection:

#### NotificationCenter with Leak Detection
Telegram's `NotificationCenter` class includes:
```java
// Built-in memory leak detection
if (observers.size() > 1000) {
    throw new RuntimeException("Total observers more than 1000, need check for memory leak");
}
```

Key features:
- **Thread enforcement**: Both `addObserver` and `removeObserver` must be called on the MAIN thread
- **Runtime exceptions**: Throws if thread safety is violated

#### BaseFragment Observer Pattern
Fragments implement `NotificationCenter.NotificationCenterDelegate` and:
1. Register observers in `onFragmentCreate()` or similar
2. Explicitly remove each observer in `onFragmentDestroy()`

```java
// In onFragmentDestroy()
NotificationCenter.getInstance(currentAccount).removeObserver(this, NotificationCenter.notificationsSettingsUpdated);
NotificationCenter.getInstance(currentAccount).removeObserver(this, NotificationCenter.messageReceivedByAck);
// ... for each registered observer
```

**Lesson for Zajel**: Consider adding observer count monitoring to detect leaks during development.

**Sources**:
- [Telegram NotificationCenter.java](https://github.com/DrKLO/Telegram/blob/master/TMessagesProj/src/main/java/org/telegram/messenger/NotificationCenter.java)
- [Telegram BaseFragment.java](https://github.com/DrKLO/Telegram/blob/master/TMessagesProj/src/main/java/org/telegram/ui/ActionBar/BaseFragment.java)

---

### 3. Flutter/Dart Best Practices

#### 3.1 DisposeBag Pattern (Inspired by RxSwift)

The `flutter_disposebag` and `disposebag` packages provide automatic disposal:

```dart
class MyWidget extends StatefulWidget {
  @override
  _MyWidgetState createState() => _MyWidgetState();
}

class _MyWidgetState extends State<MyWidget> with DisposeBagMixin {
  @override
  void initState() {
    super.initState();

    // Subscriptions are automatically cancelled when State is disposed
    stream1.listen(handler1).disposedBy(bag);
    stream2.listen(handler2).disposedBy(bag);
    sink.disposedBy(bag);
  }
}
```

**Key Benefits**:
- Automatic cancellation tied to State lifecycle
- No manual cleanup code needed in `dispose()`
- Prevents forgetting to cancel subscriptions

**Sources**:
- [flutter_disposebag](https://github.com/Flutter-Dart-Open-Source/flutter_disposebag)
- [disposebag](https://github.com/hoc081098/disposebag)

#### 3.2 RxDart CompositeSubscription

RxDart provides `CompositeSubscription` for managing multiple subscriptions:

```dart
class MyService {
  final _subscriptions = CompositeSubscription();

  void setup() {
    _subscriptions.add(stream1.listen(handler1));
    _subscriptions.add(stream2.listen(handler2));
  }

  Future<void> dispose() async {
    await _subscriptions.dispose();
  }
}
```

**Note**: Once disposed, CompositeSubscription cannot be reused and will throw if you try to add more subscriptions.

**Source**: [RxDart CompositeSubscription](https://pub.dev/documentation/rxdart/latest/rx/CompositeSubscription-class.html)

#### 3.3 Flutter Hooks Pattern

`flutter_hooks` provides React-like hooks with automatic cleanup:

```dart
class MyWidget extends HookWidget {
  @override
  Widget build(BuildContext context) {
    useEffect(() {
      final subscription = stream.listen(print);

      // Return cleanup function - called on dispose or when deps change
      return subscription.cancel;
    }, [stream]); // Dependencies array

    return Container();
  }
}
```

**Benefits**:
- Cleanup function is automatically called when widget is disposed
- Cleanup also runs when dependencies change (before re-running effect)
- Mirrors React's useEffect pattern for familiarity

**Source**: [flutter_hooks](https://pub.dev/packages/flutter_hooks)

#### 3.4 Dart Linter Rules

Enable the `cancel_subscriptions` linter rule in `analysis_options.yaml`:

```yaml
linter:
  rules:
    - cancel_subscriptions
```

This enforces that all `StreamSubscription` instances have `cancel()` invoked.

**Source**: [Dart Linter Rules](https://dart.dev/tools/linter-rules/cancel_subscriptions)

---

### 4. Android Jetpack LifecycleOwner Patterns

Android's architecture components provide automatic lifecycle-aware disposal:

#### 4.1 LiveData Automatic Observer Removal

```kotlin
// Observer is automatically removed when lifecycle reaches DESTROYED
viewModel.data.observe(lifecycleOwner) { value ->
    // Handle value
}
```

Key behaviors:
- Observer only receives events in `STARTED` or `RESUMED` state
- Automatically removed when `LifecycleOwner` reaches `DESTROYED`
- Prevents crashes from updating stopped activities/fragments

#### 4.2 Jetpack Compose DisposableEffect

```kotlin
@Composable
fun MyComposable() {
    DisposableEffect(key1) {
        val observer = createObserver()
        lifecycleOwner.lifecycle.addObserver(observer)

        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }
}
```

**Source**: [Android Lifecycle Documentation](https://developer.android.com/topic/libraries/architecture/lifecycle)

#### 4.3 RxJava CompositeDisposable in ViewModel

```kotlin
abstract class DisposingViewModel : ViewModel() {
    private val compositeDisposable = CompositeDisposable()

    protected fun addDisposable(disposable: Disposable) {
        compositeDisposable.add(disposable)
    }

    override fun onCleared() {
        compositeDisposable.clear()
        super.onCleared()
    }
}
```

**Warning**: Even with CompositeDisposable, retained Disposable instances can leak if the lambda captures Activity references.

**Sources**:
- [ViewModel and CompositeDisposable](https://syrop.github.io/jekyll/update/2019/03/23/viewmodel-and-compositedisposable.html)
- [Disposables Can Cause Memory Leaks](https://www.zacsweers.dev/disposables-can-cause-memory-leaks/)

#### 4.4 Uber AutoDispose

Uber's AutoDispose library provides automatic RxJava stream disposal:

```java
myObservable
    .autoDispose(AndroidLifecycleScopeProvider.from(lifecycleOwner))
    .subscribe(value -> {
        // Handle value
    });
```

Features:
- Supports Flowable, Observable, Maybe, Single, Completable
- Automatically determines correct lifecycle event for disposal (e.g., ATTACH -> DETACH)
- Includes lint rules to detect missing AutoDispose usage
- Ships with both Android Lint and Error-Prone checkers

**Source**: [Uber AutoDispose](https://github.com/uber/AutoDispose)

---

### 5. iOS Swift Combine Patterns

For reference, iOS Combine provides patterns worth adapting to Dart:

#### AnyCancellable Automatic Cancellation

```swift
class MyViewModel: ObservableObject {
    private var cancellables = Set<AnyCancellable>()

    func setup() {
        publisher
            .sink { value in
                // Handle value
            }
            .store(in: &cancellables)
    }
    // When MyViewModel is deallocated, all cancellables are automatically cancelled
}
```

**Key insight**: AnyCancellable automatically calls `cancel()` when deallocated. This is the pattern that inspired `disposebag` in Dart.

**Source**: [Swift by Sundell - Combine Memory Management](https://www.swiftbysundell.com/articles/combine-self-cancellable-memory-management/)

---

### 6. Memory Leak Detection Tools

#### 6.1 Flutter DevTools Memory View

Use Flutter DevTools for profiling:

```bash
flutter run --profile
# Then open DevTools Memory tab
```

Key features:
- Live heap memory graph
- Heap snapshots for comparing memory over time
- Snapshot diffing to detect growing instance counts
- Allocation tracking

**Important**: Always profile in `--profile` mode, not debug mode.

#### 6.2 leak_tracker_flutter_testing Package

Automated leak detection in tests:

```dart
testWidgets('no memory leaks', (tester) async {
  // leak_tracker automatically detects:
  // - Not-disposed objects (StreamSubscription, AnimationController, etc.)
  // - Objects disposed but not garbage collected
  // - Objects taking too long to be garbage collected
});
```

**Source**: [leak_tracker_flutter_testing](https://api.flutter.dev/flutter/package-leak_tracker_flutter_testing_leak_tracker_flutter_testing/)

#### 6.3 DCM (Dart Code Metrics)

Static analysis tool that can detect potential memory leaks:
- Identifies unclosed StreamControllers
- Detects uncancelled StreamSubscriptions
- Finds undisposed controllers

**Source**: [DCM Blog on Memory Leaks](https://dcm.dev/blog/2024/10/21/lets-talk-about-memory-leaks-in-dart-and-flutter/)

---

### 7. Testing Strategies for Leak Detection

#### 7.1 Unit Test Pattern for Subscription Cleanup

```dart
test('subscription is cancelled on dispose', () async {
  final controller = StreamController<int>.broadcast();
  var eventCount = 0;

  final service = MyService(stream: controller.stream);
  service.onEvent.listen((_) => eventCount++);

  // Emit before dispose
  controller.add(1);
  await Future.microtask(() {});
  expect(eventCount, 1);

  // Dispose service
  await service.dispose();

  // Emit after dispose - should NOT increment
  controller.add(2);
  await Future.microtask(() {});
  expect(eventCount, 1); // Still 1, not 2

  await controller.close();
});
```

#### 7.2 Cycle Testing for Leak Detection

```dart
test('no leaks after repeated connect/disconnect cycles', () async {
  for (var i = 0; i < 100; i++) {
    final service = MyService();
    await service.connect();
    await service.disconnect();
    await service.dispose();
  }

  // Force garbage collection and check memory
  // In real tests, use DevTools memory profiler
});
```

#### 7.3 Integration Test with Memory Assertions

```dart
testWidgets('page navigation does not leak', (tester) async {
  // Navigate to page
  await tester.pumpWidget(MyApp());
  await tester.tap(find.text('Go to Details'));
  await tester.pumpAndSettle();

  // Navigate back
  await tester.tap(find.byIcon(Icons.arrow_back));
  await tester.pumpAndSettle();

  // Repeat multiple times
  for (var i = 0; i < 10; i++) {
    await tester.tap(find.text('Go to Details'));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.arrow_back));
    await tester.pumpAndSettle();
  }

  // Memory should be stable, not growing
});
```

---

### 8. Recommended Pattern for Zajel

Based on this research, here's a recommended pattern for Zajel's networking services:

#### 8.1 Create a SubscriptionManager Mixin

```dart
mixin SubscriptionManager {
  final List<StreamSubscription> _subscriptions = [];

  StreamSubscription<T> track<T>(StreamSubscription<T> subscription) {
    _subscriptions.add(subscription);
    return subscription;
  }

  Future<void> cancelAllSubscriptions() async {
    for (final sub in _subscriptions) {
      await sub.cancel();
    }
    _subscriptions.clear();
  }
}
```

#### 8.2 Apply to Services

```dart
class PeerReconnectionService with SubscriptionManager {
  void _setupRelayListeners() {
    track(_relayClient.onIntroduction.listen((event) {
      _connectionRequestController.add(ConnectionRequestEvent(
        peerId: event.fromSourceId,
        relayId: event.relayId,
        encryptedPayload: event.payload,
        timestamp: DateTime.now(),
      ));
    }));
  }

  Future<void> dispose() async {
    await disconnect();
    await cancelAllSubscriptions();
    await _peerFoundController.close();
    await _connectionRequestController.close();
    await _statusController.close();
  }
}
```

#### 8.3 Add Development-Time Leak Detection

```dart
class SubscriptionMonitor {
  static int _activeSubscriptions = 0;
  static const int _warningThreshold = 100;

  static void onSubscriptionCreated() {
    _activeSubscriptions++;
    if (_activeSubscriptions > _warningThreshold) {
      debugPrint('WARNING: $_activeSubscriptions active subscriptions - possible leak');
    }
  }

  static void onSubscriptionCancelled() {
    _activeSubscriptions--;
  }

  static int get activeCount => _activeSubscriptions;
}
```

---

### 9. Summary of Key Takeaways

| Pattern | Source | Applicability to Zajel |
|---------|--------|------------------------|
| Observer count monitoring | Telegram | Add debug-time leak detection |
| Critical ops outside lifecycle | Signal | WebRTC signaling should complete |
| DisposeBag/CompositeSubscription | RxDart/Flutter | Use for managing multiple subs |
| Lifecycle-aware observers | Android Jetpack | Consider for UI-bound streams |
| AutoDispose with lint rules | Uber | Add static analysis for leaks |
| Automatic cancellation on dealloc | iOS Combine | Inspire Dart equivalent |
| Snapshot diffing | Flutter DevTools | Use for manual testing |
| leak_tracker | Flutter | Add to widget tests |

**Priority Actions**:
1. Enable `cancel_subscriptions` linter rule
2. Implement SubscriptionManager mixin for services
3. Add leak detection monitoring in debug builds
4. Add memory leak tests using leak_tracker
