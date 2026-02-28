import 'dart:async';

import '../logging/logger_service.dart';
import '../network/signaling_client.dart' show SignalingConnectionState;

/// Manages automatic signaling server reconnection with exponential backoff.
///
/// Listens to the signaling client's connection state stream and triggers
/// reconnection attempts when the connection drops. Uses callbacks for
/// the actual connection logic and UI state updates so this service
/// remains independent of Riverpod.
class SignalingReconnectService {
  final Future<void> Function() _connect;
  final void Function(bool connected) _setConnected;
  final void Function(String displayState) _setDisplayState;

  StreamSubscription? _subscription;
  bool _isReconnecting = false;
  bool _disposed = false;

  static const int _maxRetries = 5;
  static const Duration _initialDelay = Duration(seconds: 3);
  static const Duration _maxDelay = Duration(seconds: 60);

  SignalingReconnectService({
    required Future<void> Function() connect,
    required void Function(bool connected) setConnected,
    required void Function(String displayState) setDisplayState,
  })  : _connect = connect,
        _setConnected = setConnected,
        _setDisplayState = setDisplayState;

  void start(Stream<SignalingConnectionState> connectionState) {
    _subscription?.cancel();
    _subscription = connectionState.listen((state) async {
      if (state == SignalingConnectionState.disconnected ||
          state == SignalingConnectionState.failed) {
        _setConnected(false);
        _setDisplayState('disconnected');

        if (_isReconnecting || _disposed) return;
        _isReconnecting = true;

        // Exponential backoff: 3s, 6s, 12s, 24s, 48s (capped at 60s)
        var delay = _initialDelay;

        for (var attempt = 1; attempt <= _maxRetries; attempt++) {
          if (_disposed) break;
          logger.info('SignalingReconnect',
              'Reconnect attempt $attempt/$_maxRetries in ${delay.inSeconds}s');
          _setDisplayState('connecting');

          await Future<void>.delayed(delay);
          if (_disposed) break;

          try {
            await _connect();
            logger.info(
                'SignalingReconnect', 'Reconnected on attempt $attempt');
            _isReconnecting = false;
            return;
          } catch (e) {
            logger.warning('SignalingReconnect', 'Attempt $attempt failed: $e');
          }

          delay = Duration(
            seconds: (delay.inSeconds * 2).clamp(0, _maxDelay.inSeconds),
          );
        }

        logger.error('SignalingReconnect',
            'Reconnect failed after $_maxRetries attempts');
        _setDisplayState('disconnected');
        _isReconnecting = false;
      }
    });
  }

  void dispose() {
    _disposed = true;
    _subscription?.cancel();
  }
}
