import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';

import '../constants.dart';
import '../logging/logger_service.dart';
import '../media/media_service.dart';
import 'signaling_client.dart';

/// Represents the current state of a VoIP call.
enum CallState {
  /// No active call.
  idle,

  /// Outgoing call waiting for answer.
  outgoing,

  /// Incoming call waiting for user to accept/reject.
  incoming,

  /// Call accepted, connecting WebRTC.
  connecting,

  /// Call connected and active.
  connected,

  /// Call ended.
  ended,
}

/// Information about the current call.
class CallInfo {
  /// Unique identifier for this call.
  final String callId;

  /// The peer ID (pairing code) of the remote party.
  final String peerId;

  /// Whether this is a video call.
  final bool withVideo;

  /// Current state of the call.
  CallState state;

  /// Time when the call was connected.
  DateTime? startTime;

  /// The remote media stream.
  MediaStream? remoteStream;

  /// Creates a new CallInfo instance.
  CallInfo({
    required this.callId,
    required this.peerId,
    required this.withVideo,
    this.state = CallState.idle,
    this.startTime,
    this.remoteStream,
  });

  /// Returns the duration of the call if connected.
  Duration? get duration {
    if (startTime == null) return null;
    return DateTime.now().difference(startTime!);
  }

  @override
  String toString() {
    return 'CallInfo(callId: $callId, peerId: $peerId, '
        'withVideo: $withVideo, state: $state)';
  }
}

/// Exception thrown when a call operation fails.
class CallException implements Exception {
  /// The error message.
  final String message;

  /// Creates a new call exception.
  const CallException(this.message);

  @override
  String toString() => 'CallException: $message';
}

/// Service for managing VoIP calls.
///
/// This service orchestrates MediaService and SignalingClient to provide
/// a complete call experience including:
/// - Starting outgoing calls
/// - Receiving incoming calls
/// - Accepting/rejecting calls
/// - Hanging up calls
/// - Media controls (mute, video toggle, camera switch)
///
/// ## Usage
///
/// ```dart
/// final voipService = VoIPService(mediaService, signalingClient);
///
/// // Listen for state changes
/// voipService.onStateChange.listen((state) {
///   if (state == CallState.incoming) {
///     // Show incoming call UI
///   }
/// });
///
/// // Start a call
/// final callId = await voipService.startCall('PEER123', true);
///
/// // Accept an incoming call
/// await voipService.acceptCall(callId, true);
///
/// // End the call
/// voipService.hangup();
/// ```
class VoIPService extends ChangeNotifier {
  static const String _tag = 'VoIPService';

  final MediaService _mediaService;
  final SignalingClient _signaling;
  final List<Map<String, dynamic>>? _iceServers;
  final bool _forceRelay;

  RTCPeerConnection? _peerConnection;
  CallInfo? _currentCall;
  Timer? _ringingTimeout;
  Timer? _reconnectionTimeout;

  // Guard against double cleanup
  bool _isCleaningUp = false;

  // Track whether remote description has been set (getRemoteDescription()
  // returns a Future, so comparing it to null doesn't work for checking).
  bool _remoteDescriptionSet = false;

  // ICE candidates received before remote description is set
  final List<RTCIceCandidate> _pendingIceCandidates = [];

  // Subscription management
  final List<StreamSubscription> _subscriptions = [];

  final _stateController = StreamController<CallState>.broadcast();
  final _remoteStreamController = StreamController<MediaStream>.broadcast();

  /// Stream of call state changes.
  Stream<CallState> get onStateChange => _stateController.stream;

  /// Stream of remote media streams.
  Stream<MediaStream> get onRemoteStream => _remoteStreamController.stream;

  /// Creates a new VoIPService instance.
  ///
  /// [mediaService] - Service for managing local media tracks.
  /// [signalingClient] - Client for signaling message exchange.
  /// [forceRelay] - If true, force all traffic through TURN relay (for E2E tests).
  VoIPService(this._mediaService, this._signaling,
      {List<Map<String, dynamic>>? iceServers, bool forceRelay = false})
      : _iceServers = iceServers,
        _forceRelay = forceRelay {
    _setupSignalingHandlers();
  }

  /// The current call information, or null if no call is active.
  CallInfo? get currentCall => _currentCall;

  /// The current call state.
  CallState get state => _currentCall?.state ?? CallState.idle;

  /// Whether there is an active call.
  bool get hasActiveCall =>
      _currentCall != null && _currentCall!.state != CallState.ended;

  /// Whether audio is currently muted.
  bool get isAudioMuted => _mediaService.isAudioMuted;

  /// Whether video is currently disabled.
  bool get isVideoMuted => _mediaService.isVideoMuted;

  /// The local media stream.
  MediaStream? get localStream => _mediaService.localStream;

  /// Start an outgoing call.
  ///
  /// [peerId] - The pairing code of the peer to call.
  /// [withVideo] - Whether to include video.
  ///
  /// Returns the call ID for tracking.
  ///
  /// Throws [CallException] if already in a call.
  Future<String> startCall(String peerId, bool withVideo) async {
    if (_currentCall != null && _currentCall!.state != CallState.ended) {
      throw const CallException('Already in a call');
    }

    final callId = const Uuid().v4();
    logger.info(
        _tag, 'Starting call $callId to peer $peerId (video: $withVideo)');

    _currentCall = CallInfo(
      callId: callId,
      peerId: peerId,
      withVideo: withVideo,
      state: CallState.outgoing,
    );
    _notifyState(CallState.outgoing);

    try {
      // Get local media
      final localStream = await _mediaService.requestMedia(withVideo);

      // Create peer connection
      _peerConnection = await _createPeerConnection();

      // Add tracks to peer connection
      for (final track in localStream.getTracks()) {
        await _peerConnection!.addTrack(track, localStream);
      }

      // Create and set local offer
      final offer = await _peerConnection!.createOffer();
      await _peerConnection!.setLocalDescription(offer);

      // Send offer via signaling
      _signaling.sendCallOffer(callId, peerId, offer.sdp!, withVideo);

      // Start ringing timeout
      _startRingingTimeout();

      return callId;
    } catch (e) {
      logger.error(_tag, 'Failed to start call', e);
      await _cleanup();
      rethrow;
    }
  }

  /// Accept an incoming call.
  ///
  /// [callId] - The call ID to accept.
  /// [withVideo] - Whether to include video in the answer.
  ///
  /// Throws [CallException] if no matching incoming call exists.
  Future<void> acceptCall(String callId, bool withVideo) async {
    if (_currentCall?.callId != callId) {
      throw const CallException('No matching incoming call');
    }

    if (_currentCall!.state != CallState.incoming) {
      throw CallException(
          'Call is not in incoming state: ${_currentCall!.state}');
    }

    logger.info(_tag, 'Accepting call $callId (video: $withVideo)');

    _currentCall!.state = CallState.connecting;
    _notifyState(CallState.connecting);

    try {
      // Get local media
      final localStream = await _mediaService.requestMedia(withVideo);

      // Add tracks to peer connection
      for (final track in localStream.getTracks()) {
        await _peerConnection!.addTrack(track, localStream);
      }

      // Process any pending ICE candidates now that tracks are added
      await _processPendingIceCandidates();

      // Create and set local answer
      final answer = await _peerConnection!.createAnswer();
      await _peerConnection!.setLocalDescription(answer);

      // Send answer via signaling
      _signaling.sendCallAnswer(callId, _currentCall!.peerId, answer.sdp!);
    } catch (e) {
      logger.error(_tag, 'Failed to accept call', e);
      await _cleanup();
      rethrow;
    }
  }

  /// Reject an incoming call.
  ///
  /// [callId] - The call ID to reject.
  /// [reason] - Optional reason for rejection.
  void rejectCall(String callId, {String? reason}) {
    if (_currentCall?.callId != callId) {
      logger.warning(_tag, 'No matching call to reject: $callId');
      return;
    }

    logger.info(
        _tag, 'Rejecting call $callId (reason: ${reason ?? 'declined'})');

    _signaling.sendCallReject(
      callId,
      _currentCall!.peerId,
      reason: reason ?? 'declined',
    );

    _cleanup();
  }

  /// End the current call.
  void hangup() {
    if (_currentCall == null) {
      logger.warning(_tag, 'No active call to hangup');
      return;
    }

    logger.info(_tag, 'Hanging up call ${_currentCall!.callId}');

    _signaling.sendCallHangup(_currentCall!.callId, _currentCall!.peerId);
    _cleanup();
  }

  /// Check if media controls are allowed in the current call state.
  ///
  /// Media controls are only valid during outgoing, connecting, or connected states
  /// where local media has been acquired.
  bool _isMediaControlAllowed() {
    if (_currentCall == null) {
      return false;
    }
    return _currentCall!.state == CallState.outgoing ||
        _currentCall!.state == CallState.connecting ||
        _currentCall!.state == CallState.connected;
  }

  /// Toggle audio mute state.
  ///
  /// Returns the new mute state (true = muted).
  /// If no active call exists or call is in invalid state, returns current state
  /// without making changes.
  bool toggleMute() {
    if (!_isMediaControlAllowed()) {
      logger.warning(
          _tag,
          'Cannot toggle mute: no active call or invalid state '
          '(hasCall: ${_currentCall != null}, state: ${_currentCall?.state})');
      return _mediaService.isAudioMuted;
    }
    final muted = _mediaService.toggleMute();
    notifyListeners();
    return muted;
  }

  /// Toggle video on/off.
  ///
  /// Returns the new video state (true = video on).
  /// If no active call exists or call is in invalid state, returns current state
  /// without making changes.
  bool toggleVideo() {
    if (!_isMediaControlAllowed()) {
      logger.warning(
          _tag,
          'Cannot toggle video: no active call or invalid state '
          '(hasCall: ${_currentCall != null}, state: ${_currentCall?.state})');
      return !_mediaService.isVideoMuted;
    }
    final videoOn = _mediaService.toggleVideo();
    notifyListeners();
    return videoOn;
  }

  /// Switch between front and back cameras.
  Future<void> switchCamera() async {
    await _mediaService.switchCamera();
  }

  /// Create and configure a new RTCPeerConnection.
  Future<RTCPeerConnection> _createPeerConnection() async {
    final config = <String, dynamic>{
      'iceServers': _iceServers ?? WebRTCConstants.defaultIceServers,
    };
    if (_forceRelay) {
      config['iceTransportPolicy'] = 'relay';
    }

    final pc = await createPeerConnection(config);
    logger.debug(_tag, 'Created peer connection');

    // Handle ICE candidates
    pc.onIceCandidate = (candidate) {
      if (_currentCall != null && candidate.candidate != null) {
        final candidateJson = jsonEncode({
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        });

        _signaling.sendCallIce(
          _currentCall!.callId,
          _currentCall!.peerId,
          candidateJson,
        );
      }
    };

    // Handle remote tracks
    pc.onTrack = (event) {
      logger.info(_tag, 'Received remote track: ${event.track.kind}');
      // Capture reference locally to avoid null race
      final call = _currentCall;
      if (call != null && event.streams.isNotEmpty) {
        call.remoteStream = event.streams[0];
        _remoteStreamController.add(event.streams[0]);
        notifyListeners();
      }
    };

    // Handle connection state changes
    pc.onConnectionState = (state) {
      logger.info(_tag, 'Connection state changed: $state');

      switch (state) {
        case RTCPeerConnectionState.RTCPeerConnectionStateConnected:
          _ringingTimeout?.cancel();
          _reconnectionTimeout?.cancel();
          _currentCall?.state = CallState.connected;
          _currentCall?.startTime = DateTime.now();
          _notifyState(CallState.connected);

        case RTCPeerConnectionState.RTCPeerConnectionStateFailed:
          logger.error(_tag, 'Peer connection failed');
          hangup();

        case RTCPeerConnectionState.RTCPeerConnectionStateDisconnected:
          logger.warning(_tag, 'Peer connection disconnected');
          // Cancel any existing reconnection timer
          _reconnectionTimeout?.cancel();
          // Capture current call ID to validate in callback
          final disconnectedCallId = _currentCall?.callId;
          // Give some time for reconnection before hanging up
          _reconnectionTimeout = Timer(CallConstants.reconnectionTimeout, () {
            // Only hangup if this is still the same call and still disconnected
            if (_currentCall?.callId == disconnectedCallId &&
                _peerConnection?.connectionState ==
                    RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
              hangup();
            }
          });

        case RTCPeerConnectionState.RTCPeerConnectionStateClosed:
          logger.info(_tag, 'Peer connection closed');
          _cleanup();

        default:
          break;
      }
    };

    // Handle ICE connection state for additional monitoring
    pc.onIceConnectionState = (state) {
      logger.debug(_tag, 'ICE connection state: $state');
    };

    return pc;
  }

  /// Set up handlers for signaling messages.
  void _setupSignalingHandlers() {
    _subscriptions.add(_signaling.onCallOffer.listen(_handleOffer));
    _subscriptions.add(_signaling.onCallAnswer.listen(_handleAnswer));
    _subscriptions.add(_signaling.onCallReject.listen(_handleReject));
    _subscriptions.add(_signaling.onCallHangup.listen(_handleHangup));
    _subscriptions.add(_signaling.onCallIce.listen(_handleIce));
  }

  /// Handle incoming call offer.
  Future<void> _handleOffer(CallOfferMessage msg) async {
    logger.info(
        _tag, 'Received call offer: ${msg.callId} from ${msg.targetId}');

    // Check if already in a call
    if (_currentCall != null && _currentCall!.state != CallState.ended) {
      logger.info(_tag, 'Rejecting offer - already in a call');
      _signaling.sendCallReject(msg.callId, msg.targetId, reason: 'busy');
      return;
    }

    try {
      // Set _currentCall BEFORE async operations so incoming ICE candidates
      // (which arrive via the event loop during awaits) can be matched by callId.
      _currentCall = CallInfo(
        callId: msg.callId,
        peerId: msg.targetId,
        withVideo: msg.withVideo,
        state: CallState.incoming,
      );

      // Create peer connection and set remote description
      _peerConnection = await _createPeerConnection();
      await _peerConnection!.setRemoteDescription(
        RTCSessionDescription(msg.sdp, 'offer'),
      );
      _remoteDescriptionSet = true;

      // Process any ICE candidates that arrived during PC creation
      await _processPendingIceCandidates();

      _notifyState(CallState.incoming);
    } catch (e) {
      logger.error(_tag, 'Failed to handle offer', e);
      _signaling.sendCallReject(msg.callId, msg.targetId, reason: 'error');
      await _cleanup();
    }
  }

  /// Handle call answer from remote peer.
  Future<void> _handleAnswer(CallAnswerMessage msg) async {
    if (_currentCall?.callId != msg.callId) {
      logger.warning(_tag, 'Received answer for unknown call: ${msg.callId}');
      return;
    }

    logger.info(_tag, 'Received call answer for ${msg.callId}');

    _ringingTimeout?.cancel();

    try {
      await _peerConnection!.setRemoteDescription(
        RTCSessionDescription(msg.sdp, 'answer'),
      );
      _remoteDescriptionSet = true;

      // Process any pending ICE candidates
      await _processPendingIceCandidates();
    } catch (e) {
      logger.error(_tag, 'Failed to handle answer', e);
      hangup();
    }
  }

  /// Handle call rejection from remote peer.
  void _handleReject(CallRejectMessage msg) {
    if (_currentCall?.callId != msg.callId) {
      logger.warning(_tag, 'Received reject for unknown call: ${msg.callId}');
      return;
    }

    logger.info(_tag, 'Call rejected: ${msg.reason}');
    _cleanup();
  }

  /// Handle hangup from remote peer.
  void _handleHangup(CallHangupMessage msg) {
    if (_currentCall?.callId != msg.callId) {
      logger.warning(_tag, 'Received hangup for unknown call: ${msg.callId}');
      return;
    }

    logger.info(_tag, 'Remote peer hung up');
    _cleanup();
  }

  /// Handle ICE candidate from remote peer.
  Future<void> _handleIce(CallIceMessage msg) async {
    if (_currentCall?.callId != msg.callId) {
      logger.warning(_tag, 'Received ICE for unknown call: ${msg.callId}');
      return;
    }

    try {
      final candidateJson = jsonDecode(msg.candidate) as Map<String, dynamic>;
      final candidate = RTCIceCandidate(
        candidateJson['candidate'] as String?,
        candidateJson['sdpMid'] as String?,
        candidateJson['sdpMLineIndex'] as int?,
      );

      // If remote description is not set yet, queue the candidate
      if (!_remoteDescriptionSet) {
        // Enforce queue bounds to prevent memory exhaustion
        if (_pendingIceCandidates.length >=
            CallConstants.maxPendingIceCandidates) {
          logger.warning(
              _tag,
              'ICE candidate queue full '
              '(${CallConstants.maxPendingIceCandidates}), dropping oldest candidate');
          _pendingIceCandidates.removeAt(0);
        }
        _pendingIceCandidates.add(candidate);
        logger.debug(
            _tag,
            'Queued ICE candidate '
            '(${_pendingIceCandidates.length}/${CallConstants.maxPendingIceCandidates})');
      } else {
        await _peerConnection?.addCandidate(candidate);
      }
    } catch (e) {
      logger.error(_tag, 'Failed to handle ICE candidate', e);
    }
  }

  /// Process any ICE candidates that were received before remote description was set.
  Future<void> _processPendingIceCandidates() async {
    if (_pendingIceCandidates.isEmpty) return;

    logger.debug(_tag,
        'Processing ${_pendingIceCandidates.length} pending ICE candidates');

    for (final candidate in _pendingIceCandidates) {
      try {
        await _peerConnection?.addCandidate(candidate);
      } catch (e) {
        logger.error(_tag, 'Failed to add pending ICE candidate', e);
      }
    }

    _pendingIceCandidates.clear();
  }

  /// Start the ringing timeout timer.
  void _startRingingTimeout() {
    _ringingTimeout?.cancel();
    _ringingTimeout = Timer(CallConstants.ringingTimeout, () {
      if (_currentCall?.state == CallState.outgoing) {
        logger.info(_tag, 'Ringing timeout - hanging up');
        hangup();
      }
    });
  }

  /// Clean up resources after a call ends.
  Future<void> _cleanup() async {
    // Guard against double cleanup
    if (_isCleaningUp) {
      logger.debug(_tag, 'Cleanup already in progress, skipping');
      return;
    }
    _isCleaningUp = true;

    try {
      logger.debug(_tag, 'Cleaning up call resources');

      _ringingTimeout?.cancel();
      _ringingTimeout = null;

      _reconnectionTimeout?.cancel();
      _reconnectionTimeout = null;

      // Close peer connection
      final pc = _peerConnection;
      _peerConnection = null;
      await pc?.close();

      // Stop media tracks
      await _mediaService.stopAllTracks();

      // Clear pending ICE candidates and reset remote description flag
      _pendingIceCandidates.clear();
      _remoteDescriptionSet = false;

      // Update state
      if (_currentCall != null) {
        _currentCall!.state = CallState.ended;
        _notifyState(CallState.ended);
      }

      _currentCall = null;
    } finally {
      _isCleaningUp = false;
    }
  }

  /// Notify listeners of state change.
  void _notifyState(CallState state) {
    if (_disposed || _stateController.isClosed) return;
    _stateController.add(state);
    notifyListeners();
  }

  bool _disposed = false;

  @override
  void dispose() {
    logger.info(_tag, 'Disposing VoIPService');
    _disposed = true;

    // Cancel subscriptions
    for (final sub in _subscriptions) {
      sub.cancel();
    }
    _subscriptions.clear();

    // Cleanup call resources (fire-and-forget — _disposed guard prevents state updates)
    _cleanup();

    // Close stream controllers
    _stateController.close();
    _remoteStreamController.close();

    super.dispose();
  }
}
