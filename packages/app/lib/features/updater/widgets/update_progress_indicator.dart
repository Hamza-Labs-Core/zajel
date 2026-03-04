import 'package:flutter/material.dart';

import '../models/update_state.dart';

/// Reusable widget for showing inline update download/verify/install progress.
///
/// Used inside [ForceUpdateDialog] to display state transitions during
/// the force-update download flow on desktop non-store installs.
class UpdateProgressIndicator extends StatelessWidget {
  /// Current update status.
  final UpdateStatus status;

  /// Download progress as a fraction from 0.0 to 1.0.
  /// Only meaningful when [status] is [UpdateStatus.downloading].
  final double? progress;

  /// Human-readable error message when [status] is [UpdateStatus.failed].
  final String? errorMessage;

  /// Called when the user taps "Retry" after an error.
  final VoidCallback? onRetry;

  /// Called when the user taps "Cancel" (only shown during downloading).
  final VoidCallback? onCancel;

  /// Version string being downloaded (e.g., "1.2.0").
  final String? version;

  const UpdateProgressIndicator({
    super.key,
    required this.status,
    this.progress,
    this.errorMessage,
    this.onRetry,
    this.onCancel,
    this.version,
  });

  @override
  Widget build(BuildContext context) {
    switch (status) {
      case UpdateStatus.downloading:
        return _buildDownloading(context);
      case UpdateStatus.verifying:
        return _buildVerifying(context);
      case UpdateStatus.launchingUpdater:
        return _buildInstalling(context);
      case UpdateStatus.failed:
        return _buildFailed(context);
      case UpdateStatus.idle:
      case UpdateStatus.checking:
      case UpdateStatus.ready:
        return const SizedBox.shrink();
    }
  }

  Widget _buildDownloading(BuildContext context) {
    final percentage =
        progress != null ? (progress! * 100).toStringAsFixed(0) : '0';
    final versionText = version != null ? ' $version' : '';

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          label: 'Downloading update, $percentage percent complete',
          child: LinearProgressIndicator(
            value: progress,
            minHeight: 8,
            borderRadius: BorderRadius.circular(4),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          'Downloading$versionText... $percentage%',
          style: Theme.of(context).textTheme.bodyMedium,
          textAlign: TextAlign.center,
        ),
      ],
    );
  }

  Widget _buildVerifying(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(
          width: 32,
          height: 32,
          child: CircularProgressIndicator(strokeWidth: 3),
        ),
        const SizedBox(height: 12),
        Text(
          'Verifying...',
          style: Theme.of(context).textTheme.bodyMedium,
          textAlign: TextAlign.center,
        ),
      ],
    );
  }

  Widget _buildInstalling(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(
          width: 32,
          height: 32,
          child: CircularProgressIndicator(strokeWidth: 3),
        ),
        const SizedBox(height: 12),
        Text(
          'Installing...',
          style: Theme.of(context).textTheme.bodyMedium,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 4),
        Text(
          'The app will restart momentarily.',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }

  Widget _buildFailed(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          Icons.error_outline,
          size: 40,
          color: Theme.of(context).colorScheme.error,
        ),
        const SizedBox(height: 12),
        Text(
          errorMessage ?? 'An error occurred during the update.',
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.error,
              ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        if (onRetry != null)
          FilledButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
      ],
    );
  }
}
