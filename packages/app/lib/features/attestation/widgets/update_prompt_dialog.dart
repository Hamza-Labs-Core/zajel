import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/widgets/app_toast.dart';

/// Dismissable dialog suggesting the user update the app.
///
/// Shown when the app version is below the recommended version but
/// above the minimum. The user can dismiss this and continue using
/// the app normally.
///
/// The dialog adapts its behavior based on the install type:
/// - **Store-managed** (MSIX, Mac App Store, Snap, Flatpak): shows
///   "View in [Store Name]" button that opens the store listing.
/// - **Desktop loose install**: shows "Update" button (same as mobile).
/// - **Mobile** (existing behavior): shows "Update" button with URL.
class UpdatePromptDialog extends StatelessWidget {
  /// Optional URL to the app store or download page.
  final String? updateUrl;

  /// The recommended version.
  final String? recommendedVersion;

  /// Whether this install is managed by a platform store.
  final bool isStoreManaged;

  /// Display name of the store (e.g., "Microsoft Store").
  final String? storeName;

  /// Deep-link URI to open the store listing.
  final String? storeDeepLink;

  /// Fallback web URL when the deep link fails.
  final String? storeWebUrl;

  const UpdatePromptDialog({
    super.key,
    this.updateUrl,
    this.recommendedVersion,
    this.isStoreManaged = false,
    this.storeName,
    this.storeDeepLink,
    this.storeWebUrl,
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
        if (isStoreManaged && storeDeepLink != null)
          FilledButton(
            onPressed: () async {
              await _openStoreLink(context);
              if (context.mounted) {
                Navigator.of(context).pop(true);
              }
            },
            child: Text('View in ${storeName ?? "Store"}'),
          )
        else if (updateUrl != null)
          FilledButton(
            onPressed: () async {
              final uri = Uri.tryParse(updateUrl!);
              if (uri == null) {
                if (context.mounted) {
                  showAppToast(
                    context,
                    'Invalid update URL.',
                    duration: const Duration(seconds: 3),
                    kind: AppToastKind.error,
                  );
                }
                return;
              }
              try {
                if (await canLaunchUrl(uri)) {
                  await launchUrl(uri, mode: LaunchMode.externalApplication);
                }
              } catch (e) {
                if (context.mounted) {
                  showAppToast(
                    context,
                    'Failed to open URL: $e',
                    duration: const Duration(seconds: 3),
                    kind: AppToastKind.error,
                  );
                }
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

  Future<void> _openStoreLink(BuildContext context) async {
    if (storeDeepLink != null) {
      final deepUri = Uri.tryParse(storeDeepLink!);
      if (deepUri != null && await canLaunchUrl(deepUri)) {
        await launchUrl(deepUri, mode: LaunchMode.externalApplication);
        return;
      }
    }
    // Fall back to web URL
    if (storeWebUrl != null) {
      final webUri = Uri.tryParse(storeWebUrl!);
      if (webUri != null && await canLaunchUrl(webUri)) {
        await launchUrl(webUri, mode: LaunchMode.externalApplication);
        return;
      }
    }
    if (context.mounted) {
      showAppToast(
        context,
        'Could not open store. Please update manually from '
        '${storeName ?? "the store"}.',
        duration: const Duration(seconds: 3),
        kind: AppToastKind.warning,
      );
    }
  }
}
