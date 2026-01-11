# Issue #18: Resource Leaks in Dart - Research Document

## Executive Summary

This research document analyzes the current state of StreamSubscription lifecycle management in the Zajel messaging app's Dart/Flutter codebase. The investigation reveals that significant improvements have already been implemented, including a `SubscriptionManager` mixin pattern. However, some potential issues remain that warrant attention.

---

## Part 1: Current Subscription Locations

### All StreamSubscription Declarations Found

| File | Variable Name | Line | Type | Status |
|------|--------------|------|------|--------|
| `signaling_client.dart` | `_subscription` | 76 | `StreamSubscription?` | Properly managed |
| `connection_manager.dart` | `_signalingSubscription` | 95 | `StreamSubscription?` | Properly managed |
| `connection_manager.dart` | `_signalingEventsSubscription` | 102 | `StreamSubscription?` | Properly managed |
| `peer_reconnection_service.dart` | `_signalingSubscription` | 32 | `StreamSubscription?` | Properly managed |
| `peer_reconnection_service.dart` | (tracked via mixin) | 69 | Tracked | Uses `track()` pattern |
| `subscription_manager.dart` | `_subscriptions` | 28 | `List<StreamSubscription>` | Mixin utility |
| `main.dart` | `_fileStartSubscription` | 42 | `StreamSubscription?` | Properly managed |
| `main.dart` | `_fileChunkSubscription` | 43 | `StreamSubscription?` | Properly managed |
| `main.dart` | `_fileCompleteSubscription` | 44 | `StreamSubscription?` | Properly managed |

### All `.listen()` Calls Found

| File | Line | Cancellation Location | Risk |
|------|------|----------------------|------|
| `main.dart:105` | `fileStarts.listen()` | `dispose():155` | LOW |
| `main.dart:117` | `fileChunks.listen()` | `dispose():156` | LOW |
| `main.dart:123` | `fileCompletes.listen()` | `dispose():157` | LOW |
| `connection_manager.dart:174` | `messages.listen()` | `dispose():321`, `enableExternalConnections():157` | LOW |
| `connection_manager.dart:180` | `signalingEvents.listen()` | `dispose():319`, `enableExternalConnections():159` | LOW |
| `signaling_client.dart:116` | `_channel!.stream.listen()` | `_cleanupConnection():155` | LOW |
| `peer_reconnection_service.dart:69` | `onIntroduction.listen()` | `cancelAllSubscriptions()` via mixin | LOW |
| `peer_reconnection_service.dart:101` | `messages.listen()` | `disconnect():122` | LOW |

---

## Part 2: Leak Risk Analysis

### LOW RISK - Well Managed

#### 1. SignalingClient (signaling_client.dart)

**Resources:**
- `_channel` (WebSocketChannel) - Lines 75, 112, 159
- `_subscription` (StreamSubscription) - Lines 76, 116, 155
- `_messageController` (StreamController) - Lines 77-78, 217
- `_connectionStateController` (StreamController) - Lines 79-80, 218
- `_heartbeatTimer` (Timer) - Lines 83, 332, 340

**Analysis:** All resources are properly cleaned up in `_cleanupConnection()` and `dispose()`. The cleanup is called from both `disconnect()` and error handlers.

**Code Pattern (Good):**
```dart
Future<void> _cleanupConnection() async {
  _stopHeartbeat();
  _isConnected = false;

  final subscription = _subscription;  // Capture before nullifying
  _subscription = null;
  await subscription?.cancel();

  final channel = _channel;
  _channel = null;
  await channel?.sink.close();
}
```

#### 2. ConnectionManager (connection_manager.dart)

**Resources:**
- `_signalingSubscription` (StreamSubscription) - Lines 95, 174, 157, 200, 321
- `_signalingEventsSubscription` (StreamSubscription) - Lines 102, 180, 159, 198, 319
- Six StreamControllers - Lines 85-93, closed in `dispose()` 333-338

**Analysis:** Excellent pattern - subscriptions are cancelled before creating new ones in `enableExternalConnections()`, preventing leaks on reconnection.

**Code Pattern (Good):**
```dart
Future<String> enableExternalConnections({...}) async {
  // Cancel existing subscriptions to prevent leaks if called multiple times
  await _signalingSubscription?.cancel();
  _signalingSubscription = null;
  await _signalingEventsSubscription?.cancel();
  _signalingEventsSubscription = null;
  // ... then create new subscriptions
}
```

#### 3. PeerReconnectionService (peer_reconnection_service.dart)

**Resources:**
- `_signalingSubscription` (StreamSubscription) - Lines 32, 101, 122
- `_registrationTimer` (Timer) - Lines 33, 107, 119
- Three StreamControllers - Lines 37-39, closed in `dispose()` 374-376
- Tracked subscription via mixin - Line 69

**Analysis:** Uses the `SubscriptionManager` mixin properly. The relay listener subscription is tracked using `track()`, which is cancelled via `cancelAllSubscriptions()` in `dispose()`.

**Code Pattern (Good):**
```dart
class PeerReconnectionService with SubscriptionManager {
  void _setupRelayListeners() {
    // Use track() to ensure the subscription is cancelled on dispose
    track(_relayClient.onIntroduction.listen((event) {
      // ... handler code
    }));
  }

  Future<void> dispose() async {
    await disconnect();
    await cancelAllSubscriptions();  // Mixin method cancels tracked subscriptions
    // ... close controllers
  }
}
```

#### 4. WebRTCService (webrtc_service.dart)

**Resources:**
- `_connections` (Map of peer connections) - Lines 55, disposed in `dispose()` 260-264
- `_signalingController` (StreamController) - Lines 60, 264

**Analysis:** Properly iterates all connections and closes them. StreamController is closed.

#### 5. RelayClient (relay_client.dart)

**Resources:**
- `_loadReportTimer` (Timer) - Lines 54, 370, 376, 464
- Four StreamControllers - Lines 57-62, closed in `dispose()` 467-470
- `_relayConnections` (Map) - Lines 31, cleared in `dispose()` 475

**Analysis:** All resources properly cleaned up. Timer is cancelled, controllers are closed.

#### 6. RendezvousService (rendezvous_service.dart)

**Resources:**
- `_peerFoundController` (StreamController) - Lines 28, 239
- `_deadDropController` (StreamController) - Lines 29, 240

**Analysis:** Both controllers properly closed in `dispose()`.

#### 7. Main App (_ZajelAppState in main.dart)

**Resources:**
- Three file transfer subscriptions - Lines 42-44, cancelled in `dispose()` 155-157
- `WidgetsBindingObserver` - Removed in `dispose()` line 153

**Analysis:** Properly managed with lifecycle awareness.

---

### MEDIUM RISK - Potential Improvements

#### 1. Chat Screen Message Listener (chat_screen.dart)

**Location:** Line 36 - `ref.listenManual(messagesStreamProvider, ...)`

**Issue:** The `ref.listenManual()` returns a `ProviderSubscription` but it's not stored or cancelled.

**Current Code:**
```dart
void _listenToMessages() {
  ref.listenManual(messagesStreamProvider, (previous, next) {
    // ... handler
  });
}
```

**Risk Level:** MEDIUM - Riverpod's `ref.listenManual()` should auto-dispose when the ConsumerState is disposed, but explicit cleanup would be safer.

**Recommended Fix:**
```dart
ProviderSubscription? _messagesSubscription;

void _listenToMessages() {
  _messagesSubscription = ref.listenManual(messagesStreamProvider, (previous, next) {
    // ... handler
  });
}

@override
void dispose() {
  _messagesSubscription?.close();
  _messageController.dispose();
  _scrollController.dispose();
  super.dispose();
}
```

---

## Part 3: Disposal Patterns Already Implemented

### The SubscriptionManager Mixin (subscription_manager.dart)

The codebase already implements a robust mixin for subscription management:

```dart
mixin SubscriptionManager {
  final List<StreamSubscription<dynamic>> _subscriptions = [];

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

  int get trackedSubscriptionCount => _subscriptions.length;
}
```

**Benefits:**
- Centralized subscription tracking
- Single method to cancel all at once
- Debug helper (`trackedSubscriptionCount`)
- Already applied to `PeerReconnectionService`

### Riverpod Auto-Disposal (app_providers.dart)

The codebase uses Riverpod's `ref.onDispose()` for service cleanup:

```dart
final serverDiscoveryServiceProvider = Provider<ServerDiscoveryService>((ref) {
  final service = ServerDiscoveryService(bootstrapUrl: bootstrapUrl);
  ref.onDispose(() => service.dispose());  // Automatic cleanup
  return service;
});

final fileReceiveServiceProvider = Provider<FileReceiveService>((ref) {
  final service = FileReceiveService();
  ref.onDispose(() => service.dispose());  // Automatic cleanup
  return service;
});
```

---

## Part 4: Best Practices Research

### Industry Best Practices (2025)

Based on research from [Medium](https://medium.com/@alaxhenry0121/understanding-streamsubscription-in-dart-and-flutter-best-practices-and-memory-management-0293789d078a), [Dart.dev](https://dart.dev/libraries/async/using-streams), and [Flutter documentation](https://api.flutter.dev/flutter/dart-async/StreamSubscription-class.html):

#### 1. Always Cancel Subscriptions in Dispose

From [Flutter Memory Management Guide](https://devalflutterdev.in/blog/flutter-memory-management-guide/):
> "This isn't a 'best practice' you can safely ignore. It's a fundamental requirement. You must cancel every StreamSubscription when it's no longer needed."

#### 2. Store Subscriptions for Later Cancellation

From [Fixing Memory Leaks in Flutter](https://medium.com/@fourstrokesdigital/fixing-memory-leaks-in-long-running-flutter-apps-9a589f120b6e):
> "initState for creation, dispose for cancellation. There are no valid excuses for skipping this."

#### 3. CompositeSubscription Pattern (RxDart)

From [RxDart Documentation](https://pub.dev/documentation/rxdart/latest/rx/CompositeSubscription-class.html):

```dart
final s = CompositeSubscription();
s.add(firstStream.listen(...));
s.add(secondStream.listen(...));
s.cancel(); // cancels all
```

Key features:
- `clear()` - cancels all but allows reuse
- `dispose()` - cancels all and prevents reuse

#### 4. Riverpod's Automatic Disposal

From [Riverpod Documentation](https://riverpod.dev/):
- Use `autoDispose` modifier for providers that should clean up
- Riverpod 3.0 recommends `NotifierProvider` over legacy `StateNotifierProvider`
- `ref.onDispose()` ensures cleanup when provider is no longer in use

### Comparison with Other Apps

#### Signal-Android
- Uses application-level lifecycle observers
- Critical operations (like message sending) run outside lifecycle scope
- Uses dedicated executors for operations that must complete

#### Telegram-Android
- NotificationCenter with built-in leak detection (warns at >1000 observers)
- Thread enforcement on observer add/remove
- Explicit observer removal in fragment lifecycle

---

## Part 5: Testing Strategy for Leak Detection

### Unit Test: Subscription Cleanup Verification

```dart
test('subscription is cancelled on dispose', () async {
  final controller = StreamController<int>.broadcast();
  var eventCount = 0;

  final service = PeerReconnectionService(/* mocks */);

  // Emit before dispose
  controller.add(1);
  await Future.microtask(() {});

  // Dispose service
  await service.dispose();

  // Emit after dispose - should NOT trigger handler
  controller.add(2);
  await Future.microtask(() {});

  // Verify no additional processing
  expect(service.trackedSubscriptionCount, 0);

  await controller.close();
});
```

### Integration Test: Connection Cycle Leak Detection

```dart
test('no leaks after repeated enable/disable cycles', () async {
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
  // Use Flutter DevTools memory profiler to verify stable memory
});
```

### Tools for Detection

1. **Flutter DevTools Memory View**
   ```bash
   flutter run --profile
   # Open DevTools Memory tab
   ```

2. **leak_tracker_flutter_testing Package**
   - Automatically detects not-disposed objects
   - Detects objects disposed but not GC'd

3. **Dart Linter Rule**
   ```yaml
   # analysis_options.yaml
   linter:
     rules:
       - cancel_subscriptions
   ```

---

## Part 6: Recommendations

### Immediate Actions (Priority)

1. **Enable `cancel_subscriptions` linter rule** - Add to `analysis_options.yaml`

2. **Store Riverpod `listenManual` subscription in ChatScreen** - Explicit cleanup is safer than relying on auto-disposal

### Already Implemented (Good)

3. **SubscriptionManager mixin** - Already in use in PeerReconnectionService

4. **Proper cleanup in enableExternalConnections()** - Cancels existing before creating new

5. **Riverpod `ref.onDispose()` pattern** - Used for service providers

### Future Improvements (Nice to Have)

6. **Add subscription count monitoring in debug builds**
   ```dart
   class SubscriptionMonitor {
     static int _activeSubscriptions = 0;
     static const int _warningThreshold = 100;

     static void onSubscriptionCreated() {
       _activeSubscriptions++;
       if (_activeSubscriptions > _warningThreshold) {
         debugPrint('WARNING: Possible subscription leak');
       }
     }
   }
   ```

7. **Apply SubscriptionManager mixin to more services** - Currently only used in PeerReconnectionService

8. **Add memory leak tests to CI** - Using leak_tracker package

---

## Part 7: Summary

### Current State: GOOD

The Zajel codebase has already implemented solid subscription management patterns:

| Category | Status |
|----------|--------|
| SignalingClient | Properly managed |
| ConnectionManager | Properly managed with reconnection handling |
| PeerReconnectionService | Uses SubscriptionManager mixin |
| WebRTCService | Properly managed |
| RelayClient | Properly managed |
| RendezvousService | Properly managed |
| Main App | Properly managed with lifecycle awareness |
| Chat Screen | Medium risk - could improve explicit cleanup |

### Key Patterns in Use

1. **Capture before nullify** - Prevents null reference during async cancel
2. **Cancel before recreate** - Prevents leak on reconnection
3. **SubscriptionManager mixin** - Centralized tracking and cleanup
4. **Riverpod onDispose** - Automatic service cleanup

### Remaining Risk: LOW

The only remaining improvement opportunity is the `ref.listenManual()` call in ChatScreen, which should explicitly store and cancel the subscription for maximum safety.

---

## References

- [StreamSubscription class - Dart API](https://api.flutter.dev/flutter/dart-async/StreamSubscription-class.html)
- [Flutter Memory Management Guide 2025](https://devalflutterdev.in/blog/flutter-memory-management-guide/)
- [Fixing Memory Leaks in Long-Running Flutter Apps](https://medium.com/@fourstrokesdigital/fixing-memory-leaks-in-long-running-flutter-apps-9a589f120b6e)
- [RxDart CompositeSubscription](https://pub.dev/documentation/rxdart/latest/rx/CompositeSubscription-class.html)
- [15 Common Mistakes in Flutter Development](https://dcm.dev/blog/2025/03/24/fifteen-common-mistakes-flutter-dart-development)
- [Critical Stream Subscription Management](https://saropa-contacts.medium.com/critical-stream-subscription-management-in-flutter-with-isar-prevent-memory-leaks-and-performance-30f4847a5baa)
