# Task 09: Flutter VoIP Service

## Status: NOT STARTED
## Depends On: 07_FLUTTER_MEDIA, 08_FLUTTER_SIGNALING

## Owner Files (Only edit these)
- `packages/app/lib/core/network/voip_service.dart` (create new)

## Task Description
Create the VoIPService that orchestrates calls in Flutter.

## Requirements

### 1. Create `voip_service.dart`

```dart
import 'dart:async';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';
import '../media/media_service.dart';
import 'signaling_client.dart';

enum CallState { idle, outgoing, incoming, connecting, connected, ended }

class CallInfo {
  final String callId;
  final String peerId;
  final bool withVideo;
  CallState state;
  DateTime? startTime;
  MediaStream? remoteStream;

  CallInfo({
    required this.callId,
    required this.peerId,
    required this.withVideo,
    this.state = CallState.idle,
    this.startTime,
    this.remoteStream,
  });
}

class VoIPService extends ChangeNotifier {
  final MediaService _mediaService;
  final SignalingClient _signaling;

  RTCPeerConnection? _peerConnection;
  CallInfo? _currentCall;
  Timer? _ringingTimeout;

  final _stateController = StreamController<CallState>.broadcast();
  final _remoteStreamController = StreamController<MediaStream>.broadcast();

  Stream<CallState> get onStateChange => _stateController.stream;
  Stream<MediaStream> get onRemoteStream => _remoteStreamController.stream;

  VoIPService(this._mediaService, this._signaling) {
    _setupSignalingHandlers();
  }

  CallInfo? get currentCall => _currentCall;
  CallState get state => _currentCall?.state ?? CallState.idle;

  /// Start an outgoing call
  Future<String> startCall(String peerId, bool withVideo) async {
    final callId = const Uuid().v4();

    _currentCall = CallInfo(
      callId: callId,
      peerId: peerId,
      withVideo: withVideo,
      state: CallState.outgoing,
    );
    _notifyState(CallState.outgoing);

    // Get media
    final localStream = await _mediaService.requestMedia(withVideo);

    // Create peer connection
    _peerConnection = await _createPeerConnection();

    // Add tracks
    localStream.getTracks().forEach((track) {
      _peerConnection!.addTrack(track, localStream);
    });

    // Create offer
    final offer = await _peerConnection!.createOffer();
    await _peerConnection!.setLocalDescription(offer);

    // Send offer
    _signaling.sendCallOffer(callId, peerId, offer.sdp!, withVideo);

    // Start ringing timeout
    _ringingTimeout = Timer(const Duration(seconds: 60), () {
      if (_currentCall?.state == CallState.outgoing) {
        hangup();
      }
    });

    return callId;
  }

  /// Accept an incoming call
  Future<void> acceptCall(String callId, bool withVideo) async {
    if (_currentCall?.callId != callId) return;

    _currentCall!.state = CallState.connecting;
    _notifyState(CallState.connecting);

    // Get media
    final localStream = await _mediaService.requestMedia(withVideo);

    // Add tracks
    localStream.getTracks().forEach((track) {
      _peerConnection!.addTrack(track, localStream);
    });

    // Create answer
    final answer = await _peerConnection!.createAnswer();
    await _peerConnection!.setLocalDescription(answer);

    // Send answer
    _signaling.sendCallAnswer(callId, _currentCall!.peerId, answer.sdp!);
  }

  /// Reject an incoming call
  void rejectCall(String callId, {String? reason}) {
    if (_currentCall?.callId != callId) return;

    _signaling.sendCallReject(callId, _currentCall!.peerId, reason: reason ?? 'declined');
    _cleanup();
  }

  /// End the current call
  void hangup() {
    if (_currentCall == null) return;

    _signaling.sendCallHangup(_currentCall!.callId, _currentCall!.peerId);
    _cleanup();
  }

  /// Toggle mute
  bool toggleMute() => _mediaService.toggleMute();

  /// Toggle video
  bool toggleVideo() => _mediaService.toggleVideo();

  /// Switch camera
  Future<void> switchCamera() => _mediaService.switchCamera();

  Future<RTCPeerConnection> _createPeerConnection() async {
    final config = {
      'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
      ],
    };

    final pc = await createPeerConnection(config);

    pc.onIceCandidate = (candidate) {
      if (_currentCall != null) {
        _signaling.sendCallIce(
          _currentCall!.callId,
          _currentCall!.peerId,
          candidate,
        );
      }
    };

    pc.onTrack = (event) {
      if (event.streams.isNotEmpty) {
        _currentCall?.remoteStream = event.streams[0];
        _remoteStreamController.add(event.streams[0]);
      }
    };

    pc.onConnectionState = (state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _currentCall?.state = CallState.connected;
        _currentCall?.startTime = DateTime.now();
        _notifyState(CallState.connected);
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
                 state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        hangup();
      }
    };

    return pc;
  }

  void _setupSignalingHandlers() {
    _signaling.onCallOffer.listen(_handleOffer);
    _signaling.onCallAnswer.listen(_handleAnswer);
    _signaling.onCallReject.listen(_handleReject);
    _signaling.onCallHangup.listen(_handleHangup);
    _signaling.onCallIce.listen(_handleIce);
  }

  Future<void> _handleOffer(CallOfferMessage msg) async {
    if (_currentCall != null) {
      // Already in a call, reject
      _signaling.sendCallReject(msg.callId, msg.targetId, reason: 'busy');
      return;
    }

    _peerConnection = await _createPeerConnection();
    await _peerConnection!.setRemoteDescription(
      RTCSessionDescription(msg.sdp, 'offer'),
    );

    _currentCall = CallInfo(
      callId: msg.callId,
      peerId: msg.targetId,
      withVideo: msg.withVideo,
      state: CallState.incoming,
    );
    _notifyState(CallState.incoming);
  }

  Future<void> _handleAnswer(CallAnswerMessage msg) async {
    if (_currentCall?.callId != msg.callId) return;

    _ringingTimeout?.cancel();
    await _peerConnection!.setRemoteDescription(
      RTCSessionDescription(msg.sdp, 'answer'),
    );
  }

  void _handleReject(CallRejectMessage msg) {
    if (_currentCall?.callId != msg.callId) return;
    _cleanup();
  }

  void _handleHangup(CallHangupMessage msg) {
    if (_currentCall?.callId != msg.callId) return;
    _cleanup();
  }

  Future<void> _handleIce(CallIceMessage msg) async {
    if (_currentCall?.callId != msg.callId) return;

    final candidate = RTCIceCandidate.fromMap(jsonDecode(msg.candidate));
    await _peerConnection?.addCandidate(candidate);
  }

  void _cleanup() {
    _ringingTimeout?.cancel();
    _peerConnection?.close();
    _peerConnection = null;
    _mediaService.stopAllTracks();
    _currentCall?.state = CallState.ended;
    _notifyState(CallState.ended);
    _currentCall = null;
  }

  void _notifyState(CallState state) {
    _stateController.add(state);
    notifyListeners();
  }

  @override
  void dispose() {
    _cleanup();
    _stateController.close();
    _remoteStreamController.close();
    super.dispose();
  }
}
```

## Acceptance Criteria
- [ ] VoIPService class created
- [ ] Can start outgoing calls
- [ ] Can receive incoming calls
- [ ] Can accept/reject calls
- [ ] Can hangup calls
- [ ] ICE candidates exchanged
- [ ] Remote stream available
- [ ] Proper cleanup
- [ ] Ringing timeout
- [ ] Unit tests

## Notes
- Extends ChangeNotifier for Flutter state management
- Mirrors web VoIPService API
- UI (Task 10) will use this
