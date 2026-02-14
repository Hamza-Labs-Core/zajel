import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Dismissable dialog suggesting the user update the app.
///
/// Shown when the app version is below the recommended version but
/// above the minimum. The user can dismiss this and continue using
/// the app normally.
class UpdatePromptDialog extends StatelessWidget {
  /// Optional URL to the app store or download page.
  final String? updateUrl;

  /// The recommended version.
  final String? recommendedVersion;

  const UpdatePromptDialog({
    super.key,
    this.updateUrl,
    this.recommendedVersion,
  });

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      icon: const Icon(
        Icons.system_update,
        size: 48,
        color: Colors.blue,
      ),
      title: const Text('Update Available'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'A new version of Zajel '
            '${recommendedVersion != null ? '($recommendedVersion) ' : ''}'
            'is available. Update for the best experience.',
            textAlign: TextAlign.center,
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Later'),
        ),
        if (updateUrl != null)
          FilledButton(
            onPressed: () async {
              final uri = Uri.parse(updateUrl!);
              if (await canLaunchUrl(uri)) {
                await launchUrl(uri, mode: LaunchMode.externalApplication);
              }
              if (context.mounted) {
                Navigator.of(context).pop(true);
              }
            },
            child: const Text('Update'),
          ),
      ],
    );
  }
}
