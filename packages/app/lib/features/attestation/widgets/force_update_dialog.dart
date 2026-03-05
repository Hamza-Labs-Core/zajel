import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/environment.dart';
import '../../../core/logging/logger_service.dart';
import '../../updater/models/update_check_result.dart';
import '../../updater/models/update_state.dart';
import '../../updater/providers/auto_update_providers.dart';
import '../../updater/providers/update_providers.dart';
import '../../updater/widgets/update_progress_indicator.dart';

/// Full-screen blocking dialog shown when the app version is too old or blocked.
///
/// This dialog cannot be dismissed -- the user must update the app to continue.
/// It covers the entire screen with no back button or dismiss gesture.
///
/// The dialog adapts its behavior based on the install type:
/// - **Store-managed** (MSIX, Mac App Store, Snap, Flatpak): shows a
///   "Update via [Store Name]" button that opens the store listing.
/// - **Desktop loose install** (ZIP, DMG, tarball, AppImage): shows a
///   "Download and Install" button that triggers the in-app update flow
///   with inline progress.
/// - **Mobile** (existing behavior): shows "Update Now" opening a URL.
class ForceUpdateDialog extends ConsumerStatefulWidget {
  /// Optional URL to the app store or download page (mobile fallback).
  final String? updateUrl;

  /// The minimum required version.
  final String? requiredVersion;

  /// Whether this is due to a blocked version (vs. below minimum).
  final bool isBlocked;

  /// Whether this install is managed by a platform store.
  final bool isStoreManaged;

  /// Display name of the store (e.g., "Microsoft Store").
  final String? storeName;

  /// Deep-link URI to open the store listing.
  final String? storeDeepLink;

  /// Fallback web URL when the deep link fails.
  final String? storeWebUrl;

  const ForceUpdateDialog({
    super.key,
    this.updateUrl,
    this.requiredVersion,
    this.isBlocked = false,
    this.isStoreManaged = false,
    this.storeName,
    this.storeDeepLink,
    this.storeWebUrl,
  });

  @override
  ConsumerState<ForceUpdateDialog> createState() => _ForceUpdateDialogState();
}

class _ForceUpdateDialogState extends ConsumerState<ForceUpdateDialog> {
  bool _isDownloading = false;
  bool _launchingUpdater = false;
  String? _localErrorMessage;

  bool get _isDesktop =>
      !kIsWeb &&
      (Theme.of(context).platform == TargetPlatform.windows ||
          Theme.of(context).platform == TargetPlatform.macOS ||
          Theme.of(context).platform == TargetPlatform.linux);

  bool get _supportsAutoUpdate {
    try {
      return ref.read(supportsAutoUpdateProvider);
    } catch (_) {
      return false;
    }
  }

  UpdateStatus _effectiveStatus(UpdateState updateState) {
    if (updateState.status != UpdateStatus.idle) {
      return updateState.status;
    }
    if (_localErrorMessage != null) {
      return UpdateStatus.failed;
    }
    return UpdateStatus.idle;
  }

  String? get _fallbackUrl => _supportsAutoUpdate
      ? 'https://github.com/Hamza-Labs-Core/zajel/releases/latest'
      : null;

  @override
  Widget build(BuildContext context) {
    // Watch update state for reactive UI updates
    final updateState = ref.watch(updateStateProvider);
    final status = _effectiveStatus(updateState);

    // If update reaches ready state, launch the updater (one-shot)
    if (updateState.status == UpdateStatus.ready && !_launchingUpdater) {
      _launchingUpdater = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _launchUpdater();
      });
    }

    return PopScope(
      canPop: false,
      child: Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _buildIcon(status),
                const SizedBox(height: 24),
                _buildTitle(context, status),
                const SizedBox(height: 16),
                _buildMessage(context, status),
                const SizedBox(height: 32),
                _buildActionArea(context, updateState, status),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildIcon(UpdateStatus status) {
    if (status == UpdateStatus.downloading ||
        status == UpdateStatus.verifying ||
        status == UpdateStatus.launchingUpdater) {
      return Icon(
        Icons.system_update,
        size: 80,
        color: Colors.blue.shade600,
      );
    }
    return Icon(
      widget.isBlocked ? Icons.block : Icons.system_update,
      size: 80,
      color: widget.isBlocked ? Colors.red : Colors.orange,
    );
  }

  Widget _buildTitle(BuildContext context, UpdateStatus status) {
    String title;
    switch (status) {
      case UpdateStatus.downloading:
        title = 'Downloading Update...';
      case UpdateStatus.verifying:
        title = 'Verifying Update...';
      case UpdateStatus.launchingUpdater:
        title = 'Installing Update...';
      default:
        title = widget.isBlocked ? 'Version Blocked' : 'Update Required';
    }

    return Text(
      title,
      style: Theme.of(context).textTheme.headlineMedium?.copyWith(
            fontWeight: FontWeight.bold,
          ),
      textAlign: TextAlign.center,
    );
  }

  Widget _buildMessage(BuildContext context, UpdateStatus status) {
    if (status == UpdateStatus.downloading ||
        status == UpdateStatus.verifying ||
        status == UpdateStatus.launchingUpdater) {
      return const SizedBox.shrink();
    }

    return Text(
      widget.isBlocked
          ? 'This version of Zajel has been blocked due to a '
              'security issue. Please update to continue using the app.'
          : 'Your version of Zajel is too old to connect. '
              'Please update to version ${widget.requiredVersion ?? "the latest"} '
              'or later to continue.',
      style: Theme.of(context).textTheme.bodyLarge,
      textAlign: TextAlign.center,
    );
  }

  Widget _buildActionArea(
    BuildContext context,
    UpdateState updateState,
    UpdateStatus status,
  ) {
    // Show progress indicator during active download/verify/install states
    if (status == UpdateStatus.downloading ||
        status == UpdateStatus.verifying ||
        status == UpdateStatus.launchingUpdater) {
      return UpdateProgressIndicator(
        status: status,
        progress: updateState.downloadProgress,
        version: updateState.availableVersion ?? widget.requiredVersion,
      );
    }

    // Show error state with retry and fallback
    if (status == UpdateStatus.failed) {
      return _buildErrorActions(context);
    }

    // Store-managed install: show store button
    if (widget.isStoreManaged && widget.storeDeepLink != null) {
      return _buildStoreButton(context);
    }

    // Desktop non-store: show download and install button
    if (_isDesktop && !widget.isStoreManaged && _supportsAutoUpdate) {
      return _buildDownloadButton(context);
    }

    // Mobile or fallback: show URL launcher button
    if (widget.updateUrl != null) {
      return _buildUrlButton(context);
    }

    return const SizedBox.shrink();
  }

  Widget _buildStoreButton(BuildContext context) {
    return FilledButton.icon(
      onPressed: () => _openStoreLink(context),
      icon: const Icon(Icons.store),
      label: Text('Update via ${widget.storeName ?? "Store"}'),
      style: FilledButton.styleFrom(
        minimumSize: const Size(200, 48),
      ),
    );
  }

  Widget _buildDownloadButton(BuildContext context) {
    return FilledButton.icon(
      onPressed: _isDownloading ? null : () => _startDownload(context),
      icon: const Icon(Icons.download),
      label: const Text('Download and Install'),
      style: FilledButton.styleFrom(
        minimumSize: const Size(200, 48),
      ),
    );
  }

  Widget _buildUrlButton(BuildContext context) {
    return FilledButton.icon(
      onPressed: () => _openUpdateUrl(context),
      icon: const Icon(Icons.open_in_new),
      label: const Text('Update Now'),
      style: FilledButton.styleFrom(
        minimumSize: const Size(200, 48),
      ),
    );
  }

  Widget _buildErrorActions(BuildContext context) {
    final updateState = ref.watch(updateStateProvider);
    final errorMsg = updateState.errorMessage ??
        _localErrorMessage ??
        'An error occurred during the update.';

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        UpdateProgressIndicator(
          status: UpdateStatus.failed,
          errorMessage: errorMsg,
          onRetry: () => _startDownload(context),
        ),
        const SizedBox(height: 12),
        if (_fallbackUrl != null)
          TextButton.icon(
            onPressed: () => _openFallbackUrl(context),
            icon: const Icon(Icons.open_in_new),
            label: const Text('Download Manually'),
          ),
      ],
    );
  }

  Future<void> _startDownload(BuildContext context) async {
    setState(() {
      _isDownloading = true;
      _localErrorMessage = null;
    });
    try {
      // 1. Check for updates via GitHub Releases
      final releaseService = ref.read(githubReleaseServiceProvider);
      final result = await releaseService.checkForUpdate(Environment.version);

      if (result is! UpdateCheckAvailable) {
        throw Exception('No update available');
      }

      final release = releaseService.cachedRelease;
      if (release == null) {
        throw Exception('Could not fetch release information');
      }

      // 2. Start download via orchestrator
      final platformName = Platform.isWindows
          ? 'windows'
          : Platform.isMacOS
              ? 'macos'
              : 'linux';

      final orchestrator = ref.read(updateOrchestratorProvider);
      await orchestrator.checkAndPrepare(
        release: release,
        platformName: platformName,
      );

      // State transitions (downloading -> verifying -> ready) are handled
      // reactively via ref.watch(updateStateProvider) in build().
      // When ready state is reached, _launchUpdater() is called.
    } catch (e) {
      logger.error('ForceUpdate', 'Download failed', e);
      if (mounted) {
        setState(() {
          _localErrorMessage = e.toString();
        });
      }
    } finally {
      if (mounted) {
        setState(() => _isDownloading = false);
      }
    }
  }

  Future<void> _launchUpdater() async {
    final updateState = ref.read(updateStateProvider);
    if (updateState.availableVersion == null) return;

    try {
      final launcher = ref.read(updaterLauncherProvider);
      final orchestrator = ref.read(updateOrchestratorProvider);
      final stagingDir = await orchestrator.getStagingDir();
      final platformName = Platform.isWindows
          ? 'windows'
          : Platform.isMacOS
              ? 'macos'
              : 'linux';
      final versionDir =
          '$stagingDir/zajel-${updateState.availableVersion}-$platformName';

      await launcher.launchUpdate(
        targetVersion: updateState.availableVersion!,
        currentVersion: Environment.version,
        stagingDir: versionDir,
        checksumSha256: orchestrator.verifiedChecksum ?? '',
      );
      exit(0);
    } catch (e) {
      logger.error('ForceUpdate', 'Failed to launch updater', e);
      if (mounted) {
        setState(() {
          _launchingUpdater = false;
          _localErrorMessage = 'Failed to launch updater: $e';
        });
      }
    }
  }

  Future<void> _openStoreLink(BuildContext ctx) async {
    if (widget.storeDeepLink != null) {
      final deepUri = Uri.tryParse(widget.storeDeepLink!);
      if (deepUri != null && await canLaunchUrl(deepUri)) {
        await launchUrl(deepUri, mode: LaunchMode.externalApplication);
        return;
      }
    }
    // Fall back to web URL
    if (widget.storeWebUrl != null) {
      final webUri = Uri.tryParse(widget.storeWebUrl!);
      if (webUri != null && await canLaunchUrl(webUri)) {
        await launchUrl(webUri, mode: LaunchMode.externalApplication);
        return;
      }
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 3),
        content: Text(
          'Could not open store. Please update manually from '
          '${widget.storeName ?? "the store"}.',
        ),
      ),
    );
  }

  Future<void> _openUpdateUrl(BuildContext context) async {
    if (widget.updateUrl == null) return;
    final uri = Uri.tryParse(widget.updateUrl!);
    if (uri == null) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            duration: Duration(seconds: 3),
            content: Text('Invalid update URL.')),
      );
      return;
    }
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      } else {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 3),
            content: Text('Could not open update URL. Please update manually.'),
          ),
        );
      }
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            duration: const Duration(seconds: 3),
            content: Text('Failed to open URL: $e')),
      );
    }
  }

  Future<void> _openFallbackUrl(BuildContext context) async {
    final url = _fallbackUrl;
    if (url == null) return;
    final uri = Uri.tryParse(url);
    if (uri == null) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            duration: Duration(seconds: 3),
            content: Text('Invalid download URL.')),
      );
      return;
    }
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      } else {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 3),
            content:
                Text('Could not open download URL. Please download manually.'),
          ),
        );
      }
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            duration: const Duration(seconds: 3),
            content: Text('Failed to open URL: $e')),
      );
    }
  }
}
