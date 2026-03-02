import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/connection_manager.dart';
import '../../../core/providers/app_providers.dart';

/// Service that manages typing indicator state for P2P chats.
///
/// Listens to `connectionManager.typingEvents` for incoming `typ:start`
/// messages. Maintains a map of which peers are currently typing, with
/// auto-expiry after 5 seconds of inactivity. Provides debounced outbound
/// typing notifications (at most once per 3 seconds per peer).
class TypingIndicatorService {
  final ConnectionManager _connectionManager;

  /// Current typing state per peer: peerId -> isTyping.
  final _typingState = <String, bool>{};

  /// Broadcast stream of typing state snapshots.
  final _typingController = StreamController<Map<String, bool>>.broadcast();

  /// Timers that auto-expire typing state after 5 seconds of no events.
  final _expiryTimers = <String, Timer>{};

  /// Timestamp of the last outbound typing message sent per peer.
  final _lastSentAt = <String, DateTime>{};

  StreamSubscription<(String, String)>? _sub;

  TypingIndicatorService({required ConnectionManager connectionManager})
      : _connectionManager = connectionManager;

  /// Stream of typing state maps. Each emission is the full current state.
  Stream<Map<String, bool>> get typingStates => _typingController.stream;

  /// Check if a specific peer is currently typing.
  bool isTyping(String peerId) => _typingState[peerId] ?? false;

  /// Start listening for incoming typing events.
  void start() {
    _sub = _connectionManager.typingEvents.listen((event) {
      final (peerId, payload) = event;
      if (payload == 'start') {
        _setTyping(peerId, true);
      }
    });
  }

  /// Send a typing indicator to a peer (debounced: at most once per 3 seconds).
  void sendTyping(String peerId) {
    final now = DateTime.now();
    final lastSent = _lastSentAt[peerId];
    if (lastSent != null && now.difference(lastSent).inMilliseconds < 3000) {
      return; // Debounce: skip if sent less than 3 seconds ago
    }
    _lastSentAt[peerId] = now;
    _connectionManager.sendMessage(peerId, 'typ:start');
  }

  void _setTyping(String peerId, bool typing) {
    // Cancel any existing expiry timer for this peer
    _expiryTimers[peerId]?.cancel();

    if (typing) {
      _typingState[peerId] = true;
      _typingController.add(Map.unmodifiable(_typingState));

      // Auto-expire after 5 seconds of no new typing events
      _expiryTimers[peerId] = Timer(const Duration(seconds: 5), () {
        _typingState[peerId] = false;
        _typingController.add(Map.unmodifiable(_typingState));
        _expiryTimers.remove(peerId);
      });
    } else {
      _typingState[peerId] = false;
      _typingController.add(Map.unmodifiable(_typingState));
      _expiryTimers.remove(peerId);
    }
  }

  /// Clean up all resources.
  void dispose() {
    _sub?.cancel();
    for (final timer in _expiryTimers.values) {
      timer.cancel();
    }
    _expiryTimers.clear();
    _typingState.clear();
    _typingController.close();
  }
}

// ---------------------------------------------------------------------------
// Riverpod Providers
// ---------------------------------------------------------------------------

/// Singleton provider for the TypingIndicatorService.
final typingIndicatorServiceProvider = Provider<TypingIndicatorService>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  final service = TypingIndicatorService(connectionManager: connectionManager);
  service.start();
  ref.onDispose(() => service.dispose());
  return service;
});

/// Per-peer typing state as a stream.
///
/// Usage: `ref.watch(isTypingProvider(peerId))` returns an `AsyncValue<bool>`.
final isTypingProvider = StreamProvider.family<bool, String>((ref, peerId) {
  final service = ref.watch(typingIndicatorServiceProvider);
  return service.typingStates.map((states) => states[peerId] ?? false);
});
