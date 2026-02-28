import 'dart:async';

import 'package:uuid/uuid.dart';

import '../models/models.dart';
import '../network/connection_manager.dart';
import '../notifications/notification_service.dart';

/// Listens for incoming messages and peer state changes, showing
/// notifications when appropriate.
///
/// Delegates to closures for Riverpod-specific state reads (foreground
/// status, active screen, peer list, aliases, notification settings)
/// so the service itself is testable without Riverpod.
class NotificationListenerService {
  final ConnectionManager _connectionManager;
  final NotificationService _notificationService;

  // Closures for Riverpod-dependent reads
  final void Function(String peerId, Message message) _persistMessage;
  final bool Function(String peerId) _shouldSuppressNotification;
  final String Function(String peerId) _resolvePeerName;
  final NotificationSettings Function() _getNotificationSettings;

  StreamSubscription? _messageSubscription;
  final _knownPeerStates = <String, PeerConnectionState>{};

  NotificationListenerService({
    required ConnectionManager connectionManager,
    required NotificationService notificationService,
    required void Function(String peerId, Message message) persistMessage,
    required bool Function(String peerId) shouldSuppressNotification,
    required String Function(String peerId) resolvePeerName,
    required NotificationSettings Function() getNotificationSettings,
  })  : _connectionManager = connectionManager,
        _notificationService = notificationService,
        _persistMessage = persistMessage,
        _shouldSuppressNotification = shouldSuppressNotification,
        _resolvePeerName = resolvePeerName,
        _getNotificationSettings = getNotificationSettings;

  void start() {
    _messageSubscription?.cancel();
    _messageSubscription = _connectionManager.peerMessages.listen((event) {
      final (peerId, message) = event;

      // Persist incoming message to DB immediately (prevents message drops)
      final msg = Message(
        localId: const Uuid().v4(),
        peerId: peerId,
        content: message,
        timestamp: DateTime.now(),
        isOutgoing: false,
        status: MessageStatus.delivered,
      );
      _persistMessage(peerId, msg);

      // Suppress notification if app is in foreground AND user is viewing
      // this specific chat.
      if (_shouldSuppressNotification(peerId)) return;

      // Show notification
      final peerName = _resolvePeerName(peerId);
      final settings = _getNotificationSettings();
      _notificationService.showMessageNotification(
        peerId: peerId,
        peerName: peerName,
        content: message,
        settings: settings,
      );
    });
  }

  /// Call this from a Riverpod listener on the peers provider to track
  /// connection state transitions and show online/offline notifications.
  void handlePeersUpdate(List<Peer> peers) {
    for (final peer in peers) {
      final prev = _knownPeerStates[peer.id];
      final curr = peer.connectionState;
      _knownPeerStates[peer.id] = curr;

      // Only notify on transitions, not on initial load
      if (prev == null) continue;

      final wasOnline = prev == PeerConnectionState.connected;
      final isOnline = curr == PeerConnectionState.connected;

      if (wasOnline != isOnline) {
        final settings = _getNotificationSettings();
        final peerName = _resolvePeerName(peer.id);
        _notificationService.showPeerStatusNotification(
          peerName: peerName,
          connected: isOnline,
          settings: settings,
        );
      }
    }
  }

  void dispose() {
    _messageSubscription?.cancel();
  }
}
