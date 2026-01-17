# Task 10: Flutter Call UI

## Status: NOT STARTED
## Depends On: 09_FLUTTER_VOIP

## Owner Files (Only edit these)
- `packages/app/lib/features/call/call_screen.dart` (create new)
- `packages/app/lib/features/call/incoming_call_dialog.dart` (create new)
- `packages/app/lib/features/chat/chat_screen.dart` (modify - add call buttons)

## Task Description
Create Flutter call UI screens and integrate with chat.

## Requirements

### 1. Create `incoming_call_dialog.dart`

```dart
import 'package:flutter/material.dart';

class IncomingCallDialog extends StatelessWidget {
  final String callerName;
  final String? callerAvatar;
  final String callId;
  final bool withVideo;
  final VoidCallback onAccept;
  final VoidCallback onAcceptWithVideo;
  final VoidCallback onReject;

  const IncomingCallDialog({
    super.key,
    required this.callerName,
    this.callerAvatar,
    required this.callId,
    required this.withVideo,
    required this.onAccept,
    required this.onAcceptWithVideo,
    required this.onReject,
  });

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Avatar
            CircleAvatar(
              radius: 48,
              backgroundImage: callerAvatar != null
                  ? NetworkImage(callerAvatar!)
                  : null,
              child: callerAvatar == null
                  ? Text(callerName[0].toUpperCase(), style: const TextStyle(fontSize: 32))
                  : null,
            ),
            const SizedBox(height: 16),

            // Caller name
            Text(
              callerName,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),

            // Call type
            Text(
              withVideo ? 'Incoming video call' : 'Incoming call',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 32),

            // Buttons
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                // Reject
                _CallButton(
                  icon: Icons.call_end,
                  color: Colors.red,
                  onPressed: onReject,
                  label: 'Decline',
                ),
                // Accept
                _CallButton(
                  icon: withVideo ? Icons.videocam : Icons.call,
                  color: Colors.green,
                  onPressed: withVideo ? onAcceptWithVideo : onAccept,
                  label: 'Accept',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _CallButton extends StatelessWidget {
  final IconData icon;
  final Color color;
  final VoidCallback onPressed;
  final String label;

  const _CallButton({
    required this.icon,
    required this.color,
    required this.onPressed,
    required this.label,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FloatingActionButton(
          heroTag: label,
          backgroundColor: color,
          onPressed: onPressed,
          child: Icon(icon, color: Colors.white),
        ),
        const SizedBox(height: 8),
        Text(label, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}
```

### 2. Create `call_screen.dart`

```dart
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import '../../core/network/voip_service.dart';
import '../../core/media/media_service.dart';

class CallScreen extends StatefulWidget {
  final VoIPService voipService;
  final MediaService mediaService;
  final String peerName;

  const CallScreen({
    super.key,
    required this.voipService,
    required this.mediaService,
    required this.peerName,
  });

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  final _localRenderer = RTCVideoRenderer();
  final _remoteRenderer = RTCVideoRenderer();

  bool _isMuted = false;
  bool _isVideoOn = true;
  Duration _duration = Duration.zero;
  Timer? _durationTimer;

  StreamSubscription? _stateSubscription;
  StreamSubscription? _remoteStreamSubscription;

  @override
  void initState() {
    super.initState();
    _initRenderers();
    _setupListeners();
  }

  Future<void> _initRenderers() async {
    await _localRenderer.initialize();
    await _remoteRenderer.initialize();

    // Set local stream
    _localRenderer.srcObject = widget.mediaService.localStream;
  }

  void _setupListeners() {
    _stateSubscription = widget.voipService.onStateChange.listen((state) {
      if (state == CallState.connected) {
        _startDurationTimer();
      } else if (state == CallState.ended) {
        Navigator.of(context).pop();
      }
      setState(() {});
    });

    _remoteStreamSubscription = widget.voipService.onRemoteStream.listen((stream) {
      _remoteRenderer.srcObject = stream;
      setState(() {});
    });
  }

  void _startDurationTimer() {
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      setState(() {
        _duration += const Duration(seconds: 1);
      });
    });
  }

  String _formatDuration(Duration d) {
    String twoDigits(int n) => n.toString().padLeft(2, '0');
    final minutes = twoDigits(d.inMinutes.remainder(60));
    final seconds = twoDigits(d.inSeconds.remainder(60));
    if (d.inHours > 0) {
      return '${d.inHours}:$minutes:$seconds';
    }
    return '$minutes:$seconds';
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.voipService.state;

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          // Remote video (full screen)
          if (_remoteRenderer.srcObject != null)
            RTCVideoView(
              _remoteRenderer,
              objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
            )
          else
            // Placeholder when no video
            Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  CircleAvatar(
                    radius: 64,
                    child: Text(
                      widget.peerName[0].toUpperCase(),
                      style: const TextStyle(fontSize: 48),
                    ),
                  ),
                  const SizedBox(height: 24),
                  Text(
                    widget.peerName,
                    style: const TextStyle(color: Colors.white, fontSize: 24),
                  ),
                ],
              ),
            ),

          // Local video (corner preview)
          if (_localRenderer.srcObject != null && _isVideoOn)
            Positioned(
              top: 48,
              right: 16,
              child: Container(
                width: 120,
                height: 160,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.white24),
                ),
                clipBehavior: Clip.antiAlias,
                child: RTCVideoView(
                  _localRenderer,
                  mirror: true,
                  objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
                ),
              ),
            ),

          // Status overlay
          Positioned(
            top: 100,
            left: 0,
            right: 0,
            child: Column(
              children: [
                if (state == CallState.outgoing)
                  const Text(
                    'Calling...',
                    style: TextStyle(color: Colors.white70, fontSize: 18),
                  ),
                if (state == CallState.connecting)
                  const Text(
                    'Connecting...',
                    style: TextStyle(color: Colors.white70, fontSize: 18),
                  ),
                if (state == CallState.connected)
                  Text(
                    _formatDuration(_duration),
                    style: const TextStyle(color: Colors.white70, fontSize: 18),
                  ),
              ],
            ),
          ),

          // Controls
          Positioned(
            bottom: 48,
            left: 0,
            right: 0,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                // Mute button
                _ControlButton(
                  icon: _isMuted ? Icons.mic_off : Icons.mic,
                  label: _isMuted ? 'Unmute' : 'Mute',
                  isActive: !_isMuted,
                  onPressed: () {
                    setState(() {
                      _isMuted = widget.voipService.toggleMute();
                    });
                  },
                ),

                // Video button
                _ControlButton(
                  icon: _isVideoOn ? Icons.videocam : Icons.videocam_off,
                  label: _isVideoOn ? 'Video Off' : 'Video On',
                  isActive: _isVideoOn,
                  onPressed: () {
                    setState(() {
                      _isVideoOn = widget.voipService.toggleVideo();
                    });
                  },
                ),

                // Switch camera
                _ControlButton(
                  icon: Icons.switch_camera,
                  label: 'Flip',
                  onPressed: () => widget.voipService.switchCamera(),
                ),

                // Hangup
                _ControlButton(
                  icon: Icons.call_end,
                  label: 'End',
                  color: Colors.red,
                  onPressed: () => widget.voipService.hangup(),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _durationTimer?.cancel();
    _stateSubscription?.cancel();
    _remoteStreamSubscription?.cancel();
    _localRenderer.dispose();
    _remoteRenderer.dispose();
    super.dispose();
  }
}

class _ControlButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool isActive;
  final Color? color;
  final VoidCallback onPressed;

  const _ControlButton({
    required this.icon,
    required this.label,
    this.isActive = true,
    this.color,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        FloatingActionButton(
          heroTag: label,
          backgroundColor: color ?? (isActive ? Colors.white24 : Colors.white10),
          onPressed: onPressed,
          child: Icon(icon, color: Colors.white),
        ),
        const SizedBox(height: 8),
        Text(
          label,
          style: const TextStyle(color: Colors.white70, fontSize: 12),
        ),
      ],
    );
  }
}
```

### 3. Modify Chat Screen

Add call buttons to the chat screen's app bar:

```dart
// In chat_screen.dart app bar actions:

actions: [
  IconButton(
    icon: const Icon(Icons.call),
    tooltip: 'Voice call',
    onPressed: () => _startCall(withVideo: false),
  ),
  IconButton(
    icon: const Icon(Icons.videocam),
    tooltip: 'Video call',
    onPressed: () => _startCall(withVideo: true),
  ),
],

// Add method:
Future<void> _startCall({required bool withVideo}) async {
  final callId = await voipService.startCall(peerId, withVideo);

  if (mounted) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CallScreen(
          voipService: voipService,
          mediaService: mediaService,
          peerName: peerName,
        ),
      ),
    );
  }
}

// Listen for incoming calls (in initState):
voipService.onStateChange.listen((state) {
  if (state == CallState.incoming) {
    _showIncomingCallDialog();
  }
});

void _showIncomingCallDialog() {
  showDialog(
    context: context,
    barrierDismissible: false,
    builder: (_) => IncomingCallDialog(
      callerName: peerName,
      callId: voipService.currentCall!.callId,
      withVideo: voipService.currentCall!.withVideo,
      onAccept: () {
        Navigator.of(context).pop();
        voipService.acceptCall(voipService.currentCall!.callId, false);
        _navigateToCallScreen();
      },
      onAcceptWithVideo: () {
        Navigator.of(context).pop();
        voipService.acceptCall(voipService.currentCall!.callId, true);
        _navigateToCallScreen();
      },
      onReject: () {
        Navigator.of(context).pop();
        voipService.rejectCall(voipService.currentCall!.callId);
      },
    ),
  );
}
```

## Acceptance Criteria
- [ ] IncomingCallDialog shows for incoming calls
- [ ] CallScreen displays during calls
- [ ] Local video preview works
- [ ] Remote video displays
- [ ] Mute button works
- [ ] Video toggle works
- [ ] Camera switch works
- [ ] Hangup ends call
- [ ] Duration timer works
- [ ] Call buttons in chat screen
- [ ] State transitions handled
- [ ] Clean UI

## Notes
- Use flutter_webrtc's RTCVideoView for video rendering
- Test on real devices for camera/mic
- Handle permission prompts gracefully
