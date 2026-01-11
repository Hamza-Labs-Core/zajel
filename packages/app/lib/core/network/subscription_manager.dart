import 'dart:async';

/// A mixin that provides centralized subscription management.
///
/// Classes that mix in this mixin can use the [track] method to register
/// stream subscriptions, and [cancelAllSubscriptions] to cancel them all
/// at once during disposal.
///
/// This pattern helps prevent resource leaks by ensuring all subscriptions
/// are properly tracked and cancelled.
///
/// Example usage:
/// ```dart
/// class MyService with SubscriptionManager {
///   void _setupListeners() {
///     track(_someStream.listen((event) {
///       // Handle event
///     }));
///   }
///
///   Future<void> dispose() async {
///     await cancelAllSubscriptions();
///     // Other cleanup...
///   }
/// }
/// ```
mixin SubscriptionManager {
  final List<StreamSubscription<dynamic>> _subscriptions = [];

  /// Track a stream subscription for later cancellation.
  ///
  /// Returns the subscription for chaining or further manipulation.
  StreamSubscription<T> track<T>(StreamSubscription<T> subscription) {
    _subscriptions.add(subscription);
    return subscription;
  }

  /// Cancel all tracked subscriptions and clear the list.
  ///
  /// This method should be called in the dispose method of the class.
  /// After calling this method, new subscriptions can still be tracked.
  Future<void> cancelAllSubscriptions() async {
    for (final sub in _subscriptions) {
      await sub.cancel();
    }
    _subscriptions.clear();
  }

  /// Number of currently tracked subscriptions.
  ///
  /// Useful for debugging and testing.
  int get trackedSubscriptionCount => _subscriptions.length;
}
