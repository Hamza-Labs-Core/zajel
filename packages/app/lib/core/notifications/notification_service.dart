import 'dart:io';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../logging/logger_service.dart';
import '../models/notification_settings.dart';

/// Handles local notifications across all platforms.
class NotificationService {
  static const _tag = 'NotificationService';

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  final void Function(String? payload)? onNotificationTap;
  bool _initialized = false;

  NotificationService({this.onNotificationTap});

  bool get isInitialized => _initialized;

  Future<void> initialize() async {
    if (_initialized) return;

    const androidSettings =
        AndroidInitializationSettings('@mipmap/ic_launcher');
    const darwinSettings = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
    const linuxSettings =
        LinuxInitializationSettings(defaultActionName: 'Open');

    const initSettings = InitializationSettings(
      android: androidSettings,
      iOS: darwinSettings,
      macOS: darwinSettings,
      linux: linuxSettings,
    );

    await _plugin.initialize(
      initSettings,
      onDidReceiveNotificationResponse: (response) {
        onNotificationTap?.call(response.payload);
      },
    );

    _initialized = true;
    logger.info(_tag, 'Notification service initialized');
  }

  Future<bool> requestPermission() async {
    if (Platform.isAndroid) {
      final android = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      final granted = await android?.requestNotificationsPermission();
      return granted ?? false;
    }
    if (Platform.isIOS || Platform.isMacOS) {
      final darwin = _plugin.resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin>();
      final granted = await darwin?.requestPermissions(
        alert: true,
        badge: true,
        sound: true,
      );
      return granted ?? false;
    }
    // Linux/Windows don't need explicit permission
    return true;
  }

  /// Show a message notification if settings allow.
  Future<void> showMessageNotification({
    required String peerId,
    required String peerName,
    required String content,
    required NotificationSettings settings,
  }) async {
    if (!_initialized) return;
    if (!settings.shouldNotify(peerId)) return;
    if (!settings.messageNotifications) return;

    final body = settings.previewEnabled ? content : 'New message';

    await _plugin.show(
      peerId.hashCode,
      peerName,
      body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          'messages',
          'Messages',
          channelDescription: 'New message notifications',
          importance: Importance.high,
          priority: Priority.high,
          playSound: settings.soundEnabled,
        ),
        linux: const LinuxNotificationDetails(),
      ),
      payload: 'chat:$peerId',
    );
  }

  /// Show an incoming call notification.
  Future<void> showCallNotification({
    required String peerId,
    required String peerName,
    required bool withVideo,
    required NotificationSettings settings,
  }) async {
    if (!_initialized) return;
    if (!settings.shouldNotify(peerId)) return;
    if (!settings.callNotifications) return;

    final callType = withVideo ? 'Video' : 'Voice';

    await _plugin.show(
      peerId.hashCode + 1000,
      'Incoming $callType Call',
      peerName,
      NotificationDetails(
        android: AndroidNotificationDetails(
          'calls',
          'Calls',
          channelDescription: 'Incoming call notifications',
          importance: Importance.max,
          priority: Priority.max,
          playSound: settings.soundEnabled,
          fullScreenIntent: true,
          category: AndroidNotificationCategory.call,
        ),
        linux: const LinuxNotificationDetails(),
      ),
      payload: 'call:$peerId',
    );
  }

  /// Show peer online/offline notification.
  Future<void> showPeerStatusNotification({
    required String peerName,
    required bool connected,
    required NotificationSettings settings,
  }) async {
    if (!_initialized) return;
    if (settings.isDndActive) return;
    if (!settings.peerStatusNotifications) return;

    final status = connected ? 'is now online' : 'went offline';

    await _plugin.show(
      peerName.hashCode + 2000,
      peerName,
      status,
      NotificationDetails(
        android: AndroidNotificationDetails(
          'peer_status',
          'Peer Status',
          channelDescription: 'Peer online/offline notifications',
          importance: Importance.low,
          priority: Priority.low,
          playSound: false,
        ),
        linux: const LinuxNotificationDetails(),
      ),
    );
  }

  /// Show file received notification.
  Future<void> showFileNotification({
    required String peerId,
    required String peerName,
    required String fileName,
    required NotificationSettings settings,
  }) async {
    if (!_initialized) return;
    if (!settings.shouldNotify(peerId)) return;
    if (!settings.fileReceivedNotifications) return;

    await _plugin.show(
      peerId.hashCode + 3000,
      'File from $peerName',
      fileName,
      NotificationDetails(
        android: AndroidNotificationDetails(
          'files',
          'Files',
          channelDescription: 'File transfer notifications',
          importance: Importance.defaultImportance,
          priority: Priority.defaultPriority,
          playSound: settings.soundEnabled,
        ),
        linux: const LinuxNotificationDetails(),
      ),
      payload: 'file:$peerId',
    );
  }

  /// Cancel a specific notification.
  Future<void> cancel(int id) async {
    await _plugin.cancel(id);
  }

  /// Cancel all notifications.
  Future<void> cancelAll() async {
    await _plugin.cancelAll();
  }
}
