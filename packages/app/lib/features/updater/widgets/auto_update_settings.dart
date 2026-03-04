import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/auto_update_providers.dart';
import '../providers/update_providers.dart';
import '../services/update_package_detector.dart';

/// Settings toggles for the auto-update feature.
///
/// Displays two switches:
/// - "Download updates in background" (default ON)
/// - "Install updates automatically (when idle)" (default OFF)
///
/// The "Install automatically" toggle is only interactive when background
/// download is also enabled. If background download is disabled, the
/// auto-install toggle is grayed out with explanatory text.
///
/// Only shown on desktop platforms (Windows, macOS, Linux) that support
/// auto-update (i.e., not store-managed installs like MSIX, Snap, Flatpak,
/// or Mac App Store).
class AutoUpdateSettings extends ConsumerWidget {
  /// Optional override for the package detector (used in tests).
  final UpdatePackageDetector? packageDetector;

  const AutoUpdateSettings({super.key, this.packageDetector});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Only show on desktop platforms
    if (!_isDesktop) return const SizedBox.shrink();

    // Only show for installs that support auto-update
    final UpdatePackageDetector detector =
        packageDetector ?? ref.watch(updatePackageDetectorProvider);
    if (!detector.supportsAutoUpdate()) return const SizedBox.shrink();

    final backgroundDownloadEnabled =
        ref.watch(backgroundDownloadEnabledProvider);
    final autoInstallEnabled = ref.watch(autoInstallUpdatesProvider);

    return Column(
      children: [
        SwitchListTile(
          secondary: const Icon(Icons.download),
          title: const Text('Download updates in background'),
          subtitle: const Text(
            'Automatically download new versions when available',
          ),
          value: backgroundDownloadEnabled,
          onChanged: (value) {
            ref
                .read(backgroundDownloadEnabledProvider.notifier)
                .setEnabled(value);
            // If disabling background download, also disable auto-install
            if (!value) {
              ref.read(autoInstallUpdatesProvider.notifier).setEnabled(false);
            }
          },
        ),
        SwitchListTile(
          secondary: const Icon(Icons.update),
          title: const Text('Install updates automatically'),
          subtitle: Text(
            backgroundDownloadEnabled
                ? 'Updates install when you\'re not in a call or transferring files'
                : 'Enable background downloads to use this feature',
          ),
          value: autoInstallEnabled && backgroundDownloadEnabled,
          onChanged: backgroundDownloadEnabled
              ? (value) {
                  ref
                      .read(autoInstallUpdatesProvider.notifier)
                      .setEnabled(value);
                }
              : null,
        ),
      ],
    );
  }

  static bool get _isDesktop =>
      Platform.isWindows || Platform.isLinux || Platform.isMacOS;
}
