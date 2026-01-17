import 'package:flutter/material.dart';

/// Dialog shown when receiving an incoming call.
///
/// Displays the caller information and provides options to:
/// - Accept the call (audio only)
/// - Accept with video
/// - Reject the call
class IncomingCallDialog extends StatelessWidget {
  /// The display name of the caller.
  final String callerName;

  /// Optional avatar URL for the caller.
  final String? callerAvatar;

  /// The unique identifier for this call.
  final String callId;

  /// Whether the incoming call includes video.
  final bool withVideo;

  /// Callback when the user accepts the call (audio only).
  final VoidCallback onAccept;

  /// Callback when the user accepts the call with video.
  final VoidCallback onAcceptWithVideo;

  /// Callback when the user rejects the call.
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
              backgroundImage:
                  callerAvatar != null ? NetworkImage(callerAvatar!) : null,
              child: callerAvatar == null
                  ? Text(
                      _getInitial(callerName),
                      style: const TextStyle(fontSize: 32),
                    )
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
                // Accept with video option for video calls
                if (withVideo) ...[
                  _CallButton(
                    icon: Icons.call,
                    color: Colors.green,
                    onPressed: onAccept,
                    label: 'Audio',
                  ),
                  _CallButton(
                    icon: Icons.videocam,
                    color: Colors.green,
                    onPressed: onAcceptWithVideo,
                    label: 'Video',
                  ),
                ] else
                  // Accept for audio calls
                  _CallButton(
                    icon: Icons.call,
                    color: Colors.green,
                    onPressed: onAccept,
                    label: 'Accept',
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _getInitial(String name) {
    if (name.isEmpty) return '?';
    return name[0].toUpperCase();
  }
}

/// A circular button for call actions.
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
          heroTag: 'call_button_$label',
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
