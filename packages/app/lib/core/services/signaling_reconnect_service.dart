import 'dart:async';

import '../logging/logger_service.dart';
import '../network/signaling_client.dart' show SignalingConnectionState;

/// Service that handles automatic reconnection to the signaling server
/// with exponential backoff.
///
/// Uses closure-based DI for testability -- Riverpod stays in main.dart.
class SignalingReconnectService {
  static const _tag = 'SignalingReconnectService';

  /// Maximum number of reconnection attempts before giving up.
  final int maxRetries;

  /// Initial delay between reconnection attempts.
  final Duration initialDelay;

  /// Maximum delay between reconnection attempts.
  final Duration maxDelay;

  /// Callback to connect to the signaling server.
  final Future<void> Function() connectSignaling;

  /// Callback to update UI state to "connecting".
  final void Function() setDisplayStateConnecting;

  /// Callback to update UI state to "disconnected".
  final void Function() setDisplayStateDisconnected;

  /// Callback to set signaling connected state.
  final void Function(bool connected) setSignalingConnected;

  StreamSubscription? _subscription;
  bool _isReconnecting = false;

  SignalingReconnectService({
    required this.connectSignaling,
    required this.setDisplayStateConnecting,
    required this.setDisplayStateDisconnected,
    required this.setSignalingConnected,
    this.maxRetries = 5,
    this.initialDelay = const Duration(seconds: 3),
    this.maxDelay = const Duration(seconds: 60),
  });

  /// Whether a reconnection attempt is in progress.
  bool get isReconnecting => _isReconnecting;

  /// Start listening to a signaling connection state stream.
  ///
  /// [connectionStateStream] emits signaling connection state changes.
  /// [isDisposed] callback checks whether the owning widget is disposed.
  ///
  /// Returns the stream subscription for the caller to manage.
  StreamSubscription? listen({
    required Stream<SignalingConnectionState>? connectionStateStream,
    required bool Function() isDisposed,
  }) {
    if (connectionStateStream == null) return null;

    _subscription?.cancel();
    _subscription = connectionStateStream.listen((state) async {
      if (state == SignalingConnectionState.disconnected ||
          state == SignalingConnectionState.failed) {
        setSignalingConnected(false);
        setDisplayStateDisconnected();

        if (_isReconnecting || isDisposed()) return;
        await _reconnectWithBackoff(isDisposed);
      }
    });

    return _subscription;
  }

  Future<void> _reconnectWithBackoff(bool Function() isDisposed) async {
    _isReconnecting = true;

    var delay = initialDelay;

    for (var attempt = 1; attempt <= maxRetries; attempt++) {
      if (isDisposed()) break;
      logger.info(_tag,
          'Signaling reconnect attempt $attempt/$maxRetries in ${delay.inSeconds}s');
      setDisplayStateConnecting();

      await Future<void>.delayed(delay);
      if (isDisposed()) break;

      try {
        await connectSignaling();
        logger.info(_tag, 'Signaling reconnected on attempt $attempt');
        _isReconnecting = false;
        return;
      } catch (e) {
        logger.warning(_tag, 'Reconnect attempt $attempt failed: $e');
      }

      delay = Duration(
        seconds: (delay.inSeconds * 2).clamp(0, maxDelay.inSeconds),
      );
    }

    logger.error(_tag, 'Signaling reconnect failed after $maxRetries attempts');
    setDisplayStateDisconnected();
    _isReconnecting = false;
  }

  /// Stop listening and cancel any in-progress reconnection.
  void dispose() {
    _subscription?.cancel();
    _subscription = null;
  }
}
