import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Full-screen blocking dialog shown when the app version is too old or blocked.
///
/// This dialog cannot be dismissed — the user must update the app to continue.
/// It covers the entire screen with no back button or dismiss gesture.
class ForceUpdateDialog extends StatelessWidget {
  /// Optional URL to the app store or download page.
  final String? updateUrl;

  /// The minimum required version.
  final String? requiredVersion;

  /// Whether this is due to a blocked version (vs. below minimum).
  final bool isBlocked;

  const ForceUpdateDialog({
    super.key,
    this.updateUrl,
    this.requiredVersion,
    this.isBlocked = false,
  });

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  isBlocked ? Icons.block : Icons.system_update,
                  size: 80,
                  color: isBlocked ? Colors.red : Colors.orange,
                ),
                const SizedBox(height: 24),
                Text(
                  isBlocked ? 'Version Blocked' : 'Update Required',
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 16),
                Text(
                  isBlocked
                      ? 'This version of Zajel has been blocked due to a '
                          'security issue. Please update to continue using the app.'
                      : 'Your version of Zajel is too old to connect. '
                          'Please update to version ${requiredVersion ?? "the latest"} '
                          'or later to continue.',
                  style: Theme.of(context).textTheme.bodyLarge,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 32),
                if (updateUrl != null)
                  FilledButton.icon(
                    onPressed: () => _openUpdateUrl(context),
                    icon: const Icon(Icons.open_in_new),
                    label: const Text('Update Now'),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(200, 48),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _openUpdateUrl(BuildContext context) async {
    if (updateUrl == null) return;
    final uri = Uri.parse(updateUrl!);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }
}
