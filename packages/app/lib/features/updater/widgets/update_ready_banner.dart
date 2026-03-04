import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/update_state.dart';
import '../providers/update_providers.dart';

/// A subtle, non-intrusive banner shown when an update is downloaded and ready.
///
/// Displays "Version X.Y.Z ready to install" with [Install] and [Dismiss]
/// actions. Only visible when the update state is [UpdateStatus.ready].
///
/// The banner uses a thin Material Design banner style at the top of the
/// content area. It does not block user interaction and can be dismissed.
///
/// The [onInstall] callback should trigger the update install flow
/// (write manifest, launch updater, exit app). This is handled by US-3.
class UpdateReadyBanner extends ConsumerWidget {
  /// Called when the user taps the "Install" action.
  final VoidCallback? onInstall;

  const UpdateReadyBanner({
    super.key,
    this.onInstall,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final updateState = ref.watch(updateStateProvider);
    final dismissed = ref.watch(updateBannerDismissedProvider);

    if (updateState.status != UpdateStatus.ready || dismissed) {
      return const SizedBox.shrink();
    }

    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final version = updateState.availableVersion ?? 'unknown';

    return Material(
      elevation: 1,
      color: colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Icon(
              Icons.system_update,
              size: 20,
              color: colorScheme.onPrimaryContainer,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'Version $version ready to install',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colorScheme.onPrimaryContainer,
                ),
              ),
            ),
            if (onInstall != null)
              TextButton(
                onPressed: onInstall,
                child: Text(
                  'Install',
                  style: TextStyle(
                    color: colorScheme.primary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            IconButton(
              icon: Icon(
                Icons.close,
                size: 18,
                color: colorScheme.onPrimaryContainer,
              ),
              onPressed: () {
                ref.read(updateBannerDismissedProvider.notifier).state = true;
              },
              tooltip: 'Dismiss',
              constraints: const BoxConstraints(
                minWidth: 32,
                minHeight: 32,
              ),
              padding: EdgeInsets.zero,
            ),
          ],
        ),
      ),
    );
  }
}

/// A smaller indicator suitable for an app bar or settings icon badge.
///
/// Shows a small colored dot when an update is ready.
class UpdateReadyDot extends ConsumerWidget {
  /// Size of the dot indicator.
  final double size;

  const UpdateReadyDot({
    super.key,
    this.size = 8,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final updateState = ref.watch(updateStateProvider);
    final dismissed = ref.watch(updateBannerDismissedProvider);

    if (updateState.status != UpdateStatus.ready || dismissed) {
      return const SizedBox.shrink();
    }

    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.primary,
        shape: BoxShape.circle,
      ),
    );
  }
}
