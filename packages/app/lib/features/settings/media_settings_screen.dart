import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../core/models/media_device.dart';
import '../../core/providers/app_providers.dart';

/// Screen for configuring audio and video device settings.
class MediaSettingsScreen extends ConsumerStatefulWidget {
  const MediaSettingsScreen({super.key});

  @override
  ConsumerState<MediaSettingsScreen> createState() =>
      _MediaSettingsScreenState();
}

class _MediaSettingsScreenState extends ConsumerState<MediaSettingsScreen> {
  List<MediaDevice> _audioInputs = [];
  List<MediaDevice> _audioOutputs = [];
  List<MediaDevice> _videoInputs = [];
  bool _loading = true;

  // Camera preview
  RTCVideoRenderer? _previewRenderer;
  MediaStream? _previewStream;
  bool _previewActive = false;

  @override
  void initState() {
    super.initState();
    _loadDevices();
  }

  Future<void> _loadDevices() async {
    final mediaService = ref.read(mediaServiceProvider);
    final results = await Future.wait([
      mediaService.getAudioInputs(),
      mediaService.getAudioOutputs(),
      mediaService.getVideoInputs(),
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

  Future<void> _startPreview() async {
    if (_previewActive) return;

    try {
      _previewRenderer = RTCVideoRenderer();
      await _previewRenderer!.initialize();

      final mediaService = ref.read(mediaServiceProvider);
      final videoId = mediaService.selectedVideoInputId;

      final constraints = <String, dynamic>{
        'audio': false,
        'video': {
          'width': {'ideal': 640},
          'height': {'ideal': 480},
          if (videoId != null) 'deviceId': {'exact': videoId},
        },
      };

      _previewStream = await navigator.mediaDevices.getUserMedia(constraints);
      _previewRenderer!.srcObject = _previewStream;

      if (mounted) {
        setState(() {
          _previewActive = true;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _previewActive = false;
        });
      }
    }
  }

  Future<void> _stopPreview() async {
    if (!_previewActive) return;

    if (_previewStream != null) {
      for (final track in _previewStream!.getTracks()) {
        await track.stop();
      }
      await _previewStream!.dispose();
      _previewStream = null;
    }

    _previewRenderer?.srcObject = null;
    await _previewRenderer?.dispose();
    _previewRenderer = null;

    if (mounted) {
      setState(() {
        _previewActive = false;
      });
    }
  }

  @override
  void dispose() {
    _stopPreview();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final mediaService = ref.watch(mediaServiceProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Audio & Video'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _buildSection(
                  context,
                  title: 'Microphone',
                  icon: Icons.mic,
                  children: [
                    if (_audioInputs.isEmpty)
                      const ListTile(
                        title: Text('No microphones detected'),
                        subtitle: Text('Connect a microphone and refresh'),
                      )
                    else
                      _buildDeviceDropdown(
                        devices: _audioInputs,
                        selectedId: mediaService.selectedAudioInputId,
                        onChanged: (id) async {
                          await mediaService.selectAudioInput(id);
                          setState(() {});
                        },
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                _buildSection(
                  context,
                  title: 'Speaker',
                  icon: Icons.volume_up,
                  children: [
                    if (_audioOutputs.isEmpty)
                      const ListTile(
                        title: Text('No speakers detected'),
                        subtitle: Text('Connect a speaker and refresh'),
                      )
                    else
                      _buildDeviceDropdown(
                        devices: _audioOutputs,
                        selectedId: mediaService.selectedAudioOutputId,
                        onChanged: (id) async {
                          await mediaService.selectAudioOutput(id);
                          setState(() {});
                        },
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                _buildSection(
                  context,
                  title: 'Camera',
                  icon: Icons.videocam,
                  children: [
                    if (_videoInputs.isEmpty)
                      const ListTile(
                        leading: Icon(Icons.videocam_off, color: Colors.grey),
                        title: Text('No camera detected'),
                        subtitle:
                            Text('Connect a camera to enable video calls'),
                      )
                    else ...[
                      _buildDeviceDropdown(
                        devices: _videoInputs,
                        selectedId: mediaService.selectedVideoInputId,
                        onChanged: (id) async {
                          await mediaService.selectVideoInput(id);
                          // Restart preview with new camera
                          if (_previewActive) {
                            await _stopPreview();
                            await _startPreview();
                          }
                          setState(() {});
                        },
                      ),
                      const SizedBox(height: 8),
                      _buildCameraPreview(),
                    ],
                  ],
                ),
                const SizedBox(height: 16),
                _buildSection(
                  context,
                  title: 'Audio Processing',
                  icon: Icons.tune,
                  children: [
                    SwitchListTile(
                      title: const Text('Noise Suppression'),
                      subtitle:
                          const Text('Reduce background noise during calls'),
                      value: mediaService.noiseSuppression,
                      onChanged: (val) async {
                        await mediaService.setNoiseSuppression(val);
                        setState(() {});
                      },
                    ),
                    SwitchListTile(
                      title: const Text('Echo Cancellation'),
                      subtitle: const Text('Prevent echo from your speakers'),
                      value: mediaService.echoCancellation,
                      onChanged: (val) async {
                        await mediaService.setEchoCancellation(val);
                        setState(() {});
                      },
                    ),
                    SwitchListTile(
                      title: const Text('Auto Gain Control'),
                      subtitle:
                          const Text('Automatically adjust microphone volume'),
                      value: mediaService.autoGainControl,
                      onChanged: (val) async {
                        await mediaService.setAutoGainControl(val);
                        setState(() {});
                      },
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                _buildSection(
                  context,
                  title: 'Background Blur',
                  icon: Icons.blur_on,
                  children: [
                    SwitchListTile(
                      title: const Text('Background Blur'),
                      subtitle: Text(
                        ref.read(backgroundBlurProvider).isModelAvailable
                            ? 'Blur your background during video calls'
                            : 'Requires ML model (not yet installed)',
                      ),
                      value: ref.read(backgroundBlurProvider).enabled,
                      onChanged: (val) async {
                        await ref.read(backgroundBlurProvider).setEnabled(val);
                        setState(() {});
                      },
                    ),
                    if (ref.read(backgroundBlurProvider).enabled)
                      ListTile(
                        title: const Text('Blur Strength'),
                        subtitle: Slider(
                          value: ref.read(backgroundBlurProvider).strength,
                          min: 0.0,
                          max: 1.0,
                          divisions: 10,
                          label:
                              '${(ref.read(backgroundBlurProvider).strength * 100).round()}%',
                          onChanged: (val) async {
                            await ref
                                .read(backgroundBlurProvider)
                                .setStrength(val);
                            setState(() {});
                          },
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                Center(
                  child: TextButton.icon(
                    icon: const Icon(Icons.refresh),
                    label: const Text('Refresh Devices'),
                    onPressed: () {
                      setState(() => _loading = true);
                      _loadDevices();
                    },
                  ),
                ),
              ],
            ),
    );
  }

  Widget _buildSection(
    BuildContext context, {
    required String title,
    required IconData icon,
    required List<Widget> children,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: [
              Icon(icon,
                  size: 18, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 8),
              Text(
                title,
                style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      color: Theme.of(context).colorScheme.primary,
                      fontWeight: FontWeight.w600,
                    ),
              ),
            ],
          ),
        ),
        Card(
          child: Column(children: children),
        ),
      ],
    );
  }

  Widget _buildDeviceDropdown({
    required List<MediaDevice> devices,
    required String? selectedId,
    required Future<void> Function(String?) onChanged,
  }) {
    // Ensure selectedId matches an available device, or fall back to null (default)
    final validId =
        devices.any((d) => d.deviceId == selectedId) ? selectedId : null;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: DropdownButtonFormField<String?>(
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
                child: Text(
                  d.label,
                  overflow: TextOverflow.ellipsis,
                ),
              )),
        ],
        onChanged: (val) => onChanged(val),
      ),
    );
  }

  Widget _buildCameraPreview() {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          if (_previewActive && _previewRenderer != null)
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: SizedBox(
                height: 200,
                width: double.infinity,
                child: RTCVideoView(
                  _previewRenderer!,
                  mirror: true,
                  objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
                ),
              ),
            )
          else
            Container(
              height: 200,
              width: double.infinity,
              decoration: BoxDecoration(
                color: Colors.black12,
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.videocam_off, size: 48, color: Colors.grey),
                    SizedBox(height: 8),
                    Text('Camera preview off',
                        style: TextStyle(color: Colors.grey)),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 8),
          FilledButton.tonalIcon(
            icon: Icon(_previewActive ? Icons.stop : Icons.play_arrow),
            label: Text(_previewActive ? 'Stop Preview' : 'Test Camera'),
            onPressed: () {
              if (_previewActive) {
                _stopPreview();
              } else {
                _startPreview();
              }
            },
          ),
        ],
      ),
    );
  }
}
