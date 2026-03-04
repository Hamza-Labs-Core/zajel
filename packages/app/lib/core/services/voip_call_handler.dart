import 'dart:async';

import 'package:flutter/material.dart';

import '../logging/logger_service.dart';
import '../media/media_service.dart';
import '../network/voip_service.dart';
import '../notifications/call_foreground_service.dart';
import '../../features/call/call_screen.dart';
import '../../features/call/incoming_call_dialog.dart';

/// Handles VoIP call state changes, showing incoming call dialogs and
/// managing the call foreground service.
///
/// Uses closure-based DI for testability -- Riverpod stays in main.dart.
class VoipCallHandler {
  final BuildContext? Function() getContext;
  final VoIPService? Function() getVoipService;
  final MediaService Function() getMediaService;
  final String Function(String peerId) resolvePeerName;
  final void Function({
    required String peerId,
    required String peerName,
    required bool withVideo,
  }) showCallNotification;

  final CallForegroundService _callForegroundService;
  StreamSubscription<CallState>? _callStateSubscription;
  bool _isIncomingCallDialogOpen = false;

  VoipCallHandler({
    required this.getContext,
    required this.getVoipService,
    required this.getMediaService,
    required this.resolvePeerName,
    required this.showCallNotification,
    CallForegroundService? callForegroundService,
  }) : _callForegroundService =
            callForegroundService ?? CallForegroundService();

  /// Whether an incoming call dialog is currently showing.
  bool get isIncomingCallDialogOpen => _isIncomingCallDialogOpen;

  /// Subscribe to a VoIP service's state changes.
  ///
  /// Cancels previous subscription if any.
  void subscribeToService(VoIPService? service) {
    _callStateSubscription?.cancel();
    _callStateSubscription = null;

    if (service == null) return;

    _callStateSubscription = service.onStateChange.listen((state) {
      if (state == CallState.incoming) {
        logger.info(
            'VoipCallHandler', 'Incoming call detected, showing dialog');
        _showIncomingCallDialog(service);

        final call = service.currentCall;
        if (call != null) {
          final callerName = resolvePeerName(call.peerId);
          showCallNotification(
            peerId: call.peerId,
            peerName: callerName,
            withVideo: call.withVideo,
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
        final call = service.currentCall;
        if (call != null) {
          _callForegroundService.start(
            peerName: call.peerId,
            withVideo: call.withVideo,
          );
        }
      } else if (state == CallState.ended || state == CallState.idle) {
        _callForegroundService.stop();
      }
    });
  }

  void _dismissIncomingCallDialog() {
    if (!_isIncomingCallDialogOpen) return;
    final context = getContext();
    if (context != null) {
      Navigator.of(context).pop();
    }
    _isIncomingCallDialogOpen = false;
  }

  void _showIncomingCallDialog(VoIPService voipService) {
    final context = getContext();
    if (context == null) {
      logger.warning('VoipCallHandler',
          'No context available to show incoming call dialog');
      return;
    }

    if (voipService.currentCall == null) {
      logger.warning('VoipCallHandler', 'VoIP service current call is null');
      return;
    }

    final call = voipService.currentCall!;
    final mediaService = getMediaService();
    final callerName = resolvePeerName(call.peerId);

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
    final context = getContext();
    if (context == null) {
      logger.warning(
          'VoipCallHandler', 'No context available to navigate to call screen');
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

  /// Cancel all subscriptions.
  void dispose() {
    _callStateSubscription?.cancel();
    _callStateSubscription = null;
  }
}
