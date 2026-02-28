import 'dart:async';

import 'package:flutter/material.dart';

import '../logging/logger_service.dart';
import '../media/media_service.dart';
import '../network/voip_service.dart';
import '../notifications/call_foreground_service.dart';
import '../notifications/notification_service.dart';
import '../models/notification_settings.dart';
import '../../features/call/call_screen.dart';
import '../../features/call/incoming_call_dialog.dart';

/// Handles VoIP call state changes, incoming call dialogs, and
/// call screen navigation.
///
/// Designed to be driven by a Riverpod listener in the host widget:
/// the host calls [onVoipServiceChanged] when the VoIP provider emits,
/// and this handler manages the rest.
class VoipCallHandler {
  final GlobalKey<NavigatorState> _navigatorKey;
  final CallForegroundService _callForegroundService;
  final String Function(String peerId) _resolvePeerName;
  final NotificationService Function() _getNotificationService;
  final NotificationSettings Function() _getNotificationSettings;
  final VoIPService? Function() _getVoipService;
  final MediaService Function() _getMediaService;

  StreamSubscription<CallState>? _callStateSubscription;
  bool _isIncomingCallDialogOpen = false;

  VoipCallHandler({
    required GlobalKey<NavigatorState> navigatorKey,
    required CallForegroundService callForegroundService,
    required String Function(String peerId) resolvePeerName,
    required NotificationService Function() getNotificationService,
    required NotificationSettings Function() getNotificationSettings,
    required VoIPService? Function() getVoipService,
    required MediaService Function() getMediaService,
  })  : _navigatorKey = navigatorKey,
        _callForegroundService = callForegroundService,
        _resolvePeerName = resolvePeerName,
        _getNotificationService = getNotificationService,
        _getNotificationSettings = getNotificationSettings,
        _getVoipService = getVoipService,
        _getMediaService = getMediaService;

  /// Called when the VoIP service provider emits a new value.
  /// Pass null when the service is unavailable.
  void onVoipServiceChanged(VoIPService? voipService) {
    _callStateSubscription?.cancel();
    _callStateSubscription = null;

    if (voipService != null) {
      _callStateSubscription = voipService.onStateChange.listen((state) {
        _handleCallState(voipService, state);
      });
    }
  }

  void _handleCallState(VoIPService voipService, CallState state) {
    if (state == CallState.incoming) {
      logger.info('VoipCallHandler', 'Incoming call detected');
      _showIncomingCallDialog();

      // Show call notification
      final call = voipService.currentCall;
      if (call != null) {
        final callerName = _resolvePeerName(call.peerId);
        final settings = _getNotificationSettings();
        _getNotificationService().showCallNotification(
          peerId: call.peerId,
          peerName: callerName,
          withVideo: call.withVideo,
          settings: settings,
        );
      }
    } else if (_isIncomingCallDialogOpen &&
        (state == CallState.ended ||
            state == CallState.connecting ||
            state == CallState.idle)) {
      _dismissIncomingCallDialog();
    }

    // Manage call foreground service
    if (state == CallState.connected) {
      final call = voipService.currentCall;
      if (call != null) {
        _callForegroundService.start(
          peerName: call.peerId,
          withVideo: call.withVideo,
        );
      }
    } else if (state == CallState.ended || state == CallState.idle) {
      _callForegroundService.stop();
    }
  }

  void _dismissIncomingCallDialog() {
    if (!_isIncomingCallDialogOpen) return;
    final context = _navigatorKey.currentContext;
    if (context != null) {
      Navigator.of(context).pop();
    }
    _isIncomingCallDialogOpen = false;
  }

  void _showIncomingCallDialog() {
    final context = _navigatorKey.currentContext;
    if (context == null) {
      logger.warning('VoipCallHandler', 'No context for incoming call dialog');
      return;
    }

    final voipService = _getVoipService();
    final mediaService = _getMediaService();

    if (voipService == null || voipService.currentCall == null) {
      logger.warning('VoipCallHandler', 'VoIP service or current call is null');
      return;
    }

    final call = voipService.currentCall!;
    final callerName = _resolvePeerName(call.peerId);

    _isIncomingCallDialogOpen = true;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => IncomingCallDialog(
        callerName: callerName,
        callId: call.callId,
        withVideo: call.withVideo,
        onAccept: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.acceptCall(call.callId, false);
          _navigateToCallScreen(voipService, mediaService, callerName,
              withVideo: false);
        },
        onAcceptWithVideo: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.acceptCall(call.callId, true);
          _navigateToCallScreen(voipService, mediaService, callerName,
              withVideo: true);
        },
        onReject: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.rejectCall(call.callId);
        },
      ),
    );
  }

  void _navigateToCallScreen(
    VoIPService voipService,
    MediaService mediaService,
    String peerName, {
    bool withVideo = false,
  }) {
    final context = _navigatorKey.currentContext;
    if (context == null) {
      logger.warning(
          'VoipCallHandler', 'No context for call screen navigation');
      return;
    }

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CallScreen(
          voipService: voipService,
          mediaService: mediaService,
          peerName: peerName,
          initialVideoOn: withVideo,
        ),
      ),
    );
  }

  void dispose() {
    _callStateSubscription?.cancel();
  }
}
