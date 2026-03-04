import 'dart:async';

import '../../../core/logging/logger_service.dart';
import '../../../core/network/connection_manager.dart';
import '../../../core/storage/message_storage.dart';

/// Service that handles sending and receiving read receipts.
///
/// Listens to [ConnectionManager.receiptEvents] for incoming receipts and
/// updates outgoing message statuses from `delivered` to `read`.
///
/// Protocol: `rcpt:<timestamp_ms>` marks all messages from a peer before
/// that timestamp as read.
class ReadReceiptService {
  final ConnectionManager _connectionManager;
  final MessageStorage _messageStorage;
  StreamSubscription<(String, String)>? _sub;

  /// Callback to notify the UI layer when message statuses change
  /// for a specific peer. The provider wires this up to invalidate
  /// the relevant [chatMessagesProvider].
  void Function(String peerId)? onStatusUpdated;

  ReadReceiptService({
    required ConnectionManager connectionManager,
    required MessageStorage messageStorage,
  })  : _connectionManager = connectionManager,
        _messageStorage = messageStorage;

  /// Start listening to incoming read receipt events.
  void start() {
    _sub?.cancel();
    _sub = _connectionManager.receiptEvents.listen((event) {
      final (peerId, payload) = event;
      _handleReceipt(peerId, payload);
    });
    logger.info('ReadReceiptService', 'Started listening for read receipts');
  }

  /// Send a read receipt to [peerId] marking all their messages as read up to now.
  ///
  /// This should be called when the user views a chat screen, telling the
  /// peer that their messages have been read.
  Future<void> sendReadReceipt(String peerId) async {
    try {
      final timestamp = DateTime.now().millisecondsSinceEpoch.toString();
      await _connectionManager.sendMessage(peerId, 'rcpt:$timestamp');
      logger.debug(
          'ReadReceiptService', 'Sent read receipt to $peerId at $timestamp');
    } catch (e) {
      // Non-critical — peer may be offline. Silently ignore.
      logger.debug(
          'ReadReceiptService', 'Failed to send read receipt to $peerId: $e');
    }
  }

  /// Handle an incoming read receipt from a peer.
  ///
  /// Updates all outgoing messages to that peer with status `delivered`
  /// and timestamp <= cutoff to `read`.
  Future<void> _handleReceipt(String peerId, String payload) async {
    final timestampMs = int.tryParse(payload);
    if (timestampMs == null) {
      logger.warning('ReadReceiptService',
          'Invalid receipt payload from $peerId: $payload');
      return;
    }

    final cutoff = DateTime.fromMillisecondsSinceEpoch(timestampMs);
    final updated = await _messageStorage.markMessagesAsRead(peerId, cutoff);

    if (updated > 0) {
      logger.debug('ReadReceiptService',
          'Marked $updated messages as read for $peerId (cutoff: $cutoff)');
      onStatusUpdated?.call(peerId);
    }
  }

  /// Clean up resources.
  void dispose() {
    _sub?.cancel();
    _sub = null;
    logger.info('ReadReceiptService', 'Disposed');
  }
}
