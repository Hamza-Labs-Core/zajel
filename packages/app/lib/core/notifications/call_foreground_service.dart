import 'dart:io';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../logging/logger_service.dart';

/// Manages an ongoing foreground notification during active calls.
///
/// On Android, this keeps the app alive in the background when a call is active.
/// On other platforms, this is a no-op.
class CallForegroundService {
  static const _tag = 'CallForegroundService';
  static const _notificationId = 9999;
  static const _channelId = 'ongoing_call';

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _isActive = false;

  bool get isActive => _isActive;

  /// Show ongoing call notification (Android only).
  Future<void> start({required String peerName, bool withVideo = false}) async {
    if (!Platform.isAndroid) return;
    if (_isActive) return;

    final callType = withVideo ? 'Video call' : 'Voice call';

    await _plugin.show(
      _notificationId,
      '$callType with $peerName',
      'Tap to return to call',
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'Ongoing Call',
          channelDescription: 'Shown during active calls',
          importance: Importance.low,
          priority: Priority.low,
          ongoing: true,
          autoCancel: false,
          category: AndroidNotificationCategory.call,
          playSound: false,
        ),
      ),
      payload: 'call:active',
    );

    _isActive = true;
    logger.info(_tag, 'Foreground service started for call with $peerName');
  }

  /// Stop ongoing call notification.
  Future<void> stop() async {
    if (!_isActive) return;

    await _plugin.cancel(_notificationId);
    _isActive = false;
    logger.info(_tag, 'Foreground service stopped');
  }
}
