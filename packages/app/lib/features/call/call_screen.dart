import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../core/media/media_service.dart';
import '../../core/models/media_device.dart';
import '../../core/network/voip_service.dart';

/// Full-screen call interface for VoIP calls.
///
/// Displays:
/// - Remote video (full screen) or avatar placeholder
/// - Local video preview (corner)
/// - Call state indicator (calling, connecting, connected with duration)
/// - Call controls (mute, video toggle, camera switch, hangup)
class CallScreen extends StatefulWidget {
  /// The VoIP service managing the call.
  final VoIPService voipService;

  /// The media service managing local media tracks.
  final MediaService mediaService;

  /// Display name of the remote peer.
  final String peerName;

  /// Whether video should be enabled initially.
  final bool initialVideoOn;

  const CallScreen({
    super.key,
    required this.voipService,
    required this.mediaService,
    required this.peerName,
    this.initialVideoOn = false,
  });

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  final _localRenderer = RTCVideoRenderer();
  final _remoteRenderer = RTCVideoRenderer();

  bool _isMuted = false;
  late bool _isVideoOn = widget.initialVideoOn;
  Duration _duration = Duration.zero;
  Timer? _durationTimer;
  bool _renderersInitialized = false;

  StreamSubscription<CallState>? _stateSubscription;
  StreamSubscription<MediaStream>? _remoteStreamSubscription;

  @override
  void initState() {
    super.initState();
    _initRenderers();
    _setupListeners();
  }

  Future<void> _initRenderers() async {
    await _localRenderer.initialize();
    await _remoteRenderer.initialize();

    // Set local stream if available
    if (widget.mediaService.localStream != null) {
      _localRenderer.srcObject = widget.mediaService.localStream;
    }

    if (mounted) {
      setState(() {
        _renderersInitialized = true;
      });
    }
  }

  void _setupListeners() {
    _stateSubscription = widget.voipService.onStateChange.listen((state) {
      if (state == CallState.connected) {
        _startDurationTimer();
      } else if (state == CallState.ended) {
        // Pop the screen when call ends
        if (mounted) {
          Navigator.of(context).pop();
        }
      }
      if (mounted) {
        setState(() {});
      }
    });

    _remoteStreamSubscription =
        widget.voipService.onRemoteStream.listen((stream) {
      _remoteRenderer.srcObject = stream;
      if (mounted) {
        setState(() {});
      }
    });

    // Update local stream when it becomes available
    widget.voipService.addListener(_onVoipServiceUpdate);
  }

  void _onVoipServiceUpdate() {
    if (_renderersInitialized &&
        widget.mediaService.localStream != null &&
        _localRenderer.srcObject == null) {
      _localRenderer.srcObject = widget.mediaService.localStream;
      if (mounted) {
        setState(() {});
      }
    }
  }

  void _startDurationTimer() {
    _durationTimer?.cancel();
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) {
        setState(() {
          _duration += const Duration(seconds: 1);
        });
      }
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
      body: SafeArea(
        child: Stack(
          children: [
            // Remote video (full screen) or placeholder
            if (_remoteRenderer.srcObject != null)
              RTCVideoView(
                _remoteRenderer,
                objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
              )
            else
              // Placeholder when no remote video
              _buildAvatarPlaceholder(),

            // Local video (corner preview)
            if (_renderersInitialized &&
                _localRenderer.srcObject != null &&
                _isVideoOn)
              Positioned(
                top: 16,
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
              child: _buildStatusOverlay(state),
            ),

            // Controls
            Positioned(
              bottom: 48,
              left: 0,
              right: 0,
              child: _buildControls(),
            ),

            // Back button
            Positioned(
              top: 8,
              left: 8,
              child: IconButton(
                icon: const Icon(Icons.arrow_back, color: Colors.white),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildAvatarPlaceholder() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          CircleAvatar(
            radius: 64,
            backgroundColor: Colors.grey.shade800,
            child: Text(
              _getInitial(widget.peerName),
              style: const TextStyle(fontSize: 48, color: Colors.white),
            ),
          ),
          const SizedBox(height: 24),
          Text(
            widget.peerName,
            style: const TextStyle(color: Colors.white, fontSize: 24),
          ),
        ],
      ),
    );
  }

  Widget _buildStatusOverlay(CallState state) {
    String statusText;
    switch (state) {
      case CallState.outgoing:
        statusText = 'Calling...';
      case CallState.incoming:
        statusText = 'Incoming call...';
      case CallState.connecting:
        statusText = 'Connecting...';
      case CallState.connected:
        statusText = _formatDuration(_duration);
      case CallState.ended:
        statusText = 'Call ended';
      case CallState.idle:
        statusText = '';
    }

    return Column(
      children: [
        Text(
          statusText,
          style: const TextStyle(color: Colors.white70, fontSize: 18),
        ),
      ],
    );
  }

  Widget _buildControls() {
    return Row(
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

        // Settings
        _ControlButton(
          icon: Icons.settings,
          label: 'Devices',
          onPressed: () => _showDeviceSettings(),
        ),

        // Hangup
        _ControlButton(
          icon: Icons.call_end,
          label: 'End',
          color: Colors.red,
          onPressed: () => widget.voipService.hangup(),
        ),
      ],
    );
  }

  Future<void> _showDeviceSettings() async {
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (context) => _InCallDeviceSheet(
        mediaService: widget.mediaService,
      ),
    );
  }

  String _getInitial(String name) {
    if (name.isEmpty) return '?';
    return name[0].toUpperCase();
  }

  @override
  void dispose() {
    _durationTimer?.cancel();
    _stateSubscription?.cancel();
    _remoteStreamSubscription?.cancel();
    widget.voipService.removeListener(_onVoipServiceUpdate);
    _localRenderer.dispose();
    _remoteRenderer.dispose();
    super.dispose();
  }
}

/// A circular control button for call actions.
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
          heroTag: 'control_$label',
          tooltip: label,
          backgroundColor:
              color ?? (isActive ? Colors.white24 : Colors.white10),
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

/// Bottom sheet for switching devices during an active call.
class _InCallDeviceSheet extends StatefulWidget {
  final MediaService mediaService;

  const _InCallDeviceSheet({required this.mediaService});

  @override
  State<_InCallDeviceSheet> createState() => _InCallDeviceSheetState();
}

class _InCallDeviceSheetState extends State<_InCallDeviceSheet> {
  List<MediaDevice> _audioInputs = [];
  List<MediaDevice> _audioOutputs = [];
  List<MediaDevice> _videoInputs = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadDevices();
  }

  Future<void> _loadDevices() async {
    final results = await Future.wait([
      widget.mediaService.getAudioInputs(),
      widget.mediaService.getAudioOutputs(),
      widget.mediaService.getVideoInputs(),
    ]);
    if (mounted) {
      setState(() {
        _audioInputs = results[0];
        _audioOutputs = results[1];
        _videoInputs = results[2];
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.5,
      minChildSize: 0.3,
      maxChildSize: 0.8,
      expand: false,
      builder: (context, scrollController) => Column(
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                const Icon(Icons.settings),
                const SizedBox(width: 12),
                const Expanded(
                  child: Text(
                    'Device Settings',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          if (_loading)
            const Expanded(child: Center(child: CircularProgressIndicator()))
          else
            Expanded(
              child: ListView(
                controller: scrollController,
                padding: const EdgeInsets.all(16),
                children: [
                  if (_audioInputs.isNotEmpty) ...[
                    _sectionHeader('Microphone'),
                    _deviceDropdown(
                      _audioInputs,
                      widget.mediaService.selectedAudioInputId,
                      (id) async {
                        await widget.mediaService.selectAudioInput(id);
                        setState(() {});
                      },
                    ),
                    const SizedBox(height: 16),
                  ],
                  if (_audioOutputs.isNotEmpty) ...[
                    _sectionHeader('Speaker'),
                    _deviceDropdown(
                      _audioOutputs,
                      widget.mediaService.selectedAudioOutputId,
                      (id) async {
                        await widget.mediaService.selectAudioOutput(id);
                        setState(() {});
                      },
                    ),
                    const SizedBox(height: 16),
                  ],
                  if (_videoInputs.isNotEmpty) ...[
                    _sectionHeader('Camera'),
                    _deviceDropdown(
                      _videoInputs,
                      widget.mediaService.selectedVideoInputId,
                      (id) async {
                        await widget.mediaService.selectVideoInput(id);
                        setState(() {});
                      },
                    ),
                    const SizedBox(height: 16),
                  ],
                  _sectionHeader('Audio Processing'),
                  SwitchListTile(
                    title: const Text('Noise Suppression'),
                    value: widget.mediaService.noiseSuppression,
                    onChanged: (val) async {
                      await widget.mediaService.setNoiseSuppression(val);
                      setState(() {});
                    },
                  ),
                  SwitchListTile(
                    title: const Text('Echo Cancellation'),
                    value: widget.mediaService.echoCancellation,
                    onChanged: (val) async {
                      await widget.mediaService.setEchoCancellation(val);
                      setState(() {});
                    },
                  ),
                  SwitchListTile(
                    title: const Text('Auto Gain'),
                    value: widget.mediaService.autoGainControl,
                    onChanged: (val) async {
                      await widget.mediaService.setAutoGainControl(val);
                      setState(() {});
                    },
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Note: Device and processing changes take effect on the next call.',
                    style: TextStyle(
                      fontSize: 12,
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _sectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        title,
        style: TextStyle(
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.primary,
        ),
      ),
    );
  }

  Widget _deviceDropdown(
    List<MediaDevice> devices,
    String? selectedId,
    Future<void> Function(String?) onChanged,
  ) {
    final validId =
        devices.any((d) => d.deviceId == selectedId) ? selectedId : null;

    return DropdownButtonFormField<String?>(
      value: validId,
      decoration: const InputDecoration(
        border: OutlineInputBorder(),
        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      ),
      isExpanded: true,
      items: [
        const DropdownMenuItem(
          value: null,
          child: Text('System Default'),
        ),
        ...devices.map((d) => DropdownMenuItem(
              value: d.deviceId,
              child: Text(d.label, overflow: TextOverflow.ellipsis),
            )),
      ],
      onChanged: (val) => onChanged(val),
    );
  }
}
