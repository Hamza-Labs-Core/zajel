import 'dart:async';

import 'package:uuid/uuid.dart';

import '../logging/logger_service.dart';
import '../models/models.dart';

/// Listens to incoming messages and file completions to show notifications.
///
/// Uses closure-based DI for testability -- Riverpod stays in main.dart.
class NotificationListenerService {
  final Stream<(String, String)> messages;
  final Stream<(String, String)> fileCompletes;

  final void Function(String peerId, Message message) addMessage;
  final String Function(String peerId) resolvePeerName;
  final NotificationSettings Function() getNotificationSettings;
  final ({String? fileName})? Function(String fileId) getFileTransfer;

  final void Function({
    required String peerId,
    required String peerName,
    required String content,
    required NotificationSettings settings,
  }) showMessageNotification;

  final void Function({
    required String peerId,
    required String peerName,
    required String fileName,
    required NotificationSettings settings,
  }) showFileNotification;

  StreamSubscription? _messageSubscription;
  StreamSubscription? _fileCompleteSubscription;

  NotificationListenerService({
    required this.messages,
    required this.fileCompletes,
    required this.addMessage,
    required this.resolvePeerName,
    required this.getNotificationSettings,
    required this.getFileTransfer,
    required this.showMessageNotification,
    required this.showFileNotification,
  });

  /// Start listening to message and file events.
  void listen() {
    _messageSubscription = messages.listen((event) {
      final (peerId, message) = event;

      final msg = Message(
        localId: const Uuid().v4(),
        peerId: peerId,
        content: message,
        timestamp: DateTime.now(),
        isOutgoing: false,
        status: MessageStatus.delivered,
      );
      addMessage(peerId, msg);

      final settings = getNotificationSettings();
      final peerName = resolvePeerName(peerId);

      showMessageNotification(
        peerId: peerId,
        peerName: peerName,
        content: message,
        settings: settings,
      );
    });

    _fileCompleteSubscription = fileCompletes.listen((event) {
      final (peerId, fileId) = event;
      final settings = getNotificationSettings();
      final transfer = getFileTransfer(fileId);
      final peerName = resolvePeerName(peerId);

      showFileNotification(
        peerId: peerId,
        peerName: peerName,
        fileName: transfer?.fileName ?? 'File',
        settings: settings,
      );
    });

    logger.info(
        'NotificationListenerService', 'Notification listeners started');
  }

  /// Cancel all subscriptions.
  void dispose() {
    _messageSubscription?.cancel();
    _fileCompleteSubscription?.cancel();
  }
}
