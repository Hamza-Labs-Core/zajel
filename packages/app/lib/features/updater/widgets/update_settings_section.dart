import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/environment.dart';
import '../../../core/logging/logger_service.dart';
import '../models/update_check_result.dart';
import '../models/update_state.dart';
import '../providers/auto_update_providers.dart';
import '../providers/update_providers.dart';
import '../services/updater_launcher.dart';

/// Settings section for checking and displaying update status.
///
/// Visible only on desktop platforms (Windows, macOS, Linux).
/// When the app is store-managed, shows a simple message directing
/// the user to their app store. Otherwise, provides a "Check Now"
/// button and displays the result.
class UpdateSettingsSection extends ConsumerWidget {
  const UpdateSettingsSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final supportsAutoUpdate = ref.watch(supportsAutoUpdateProvider);
    final checkResult = ref.watch(updateCheckResultProvider);
    final isChecking = ref.watch(updateCheckInProgressProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Text(
            'Updates',
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: Theme.of(context).colorScheme.primary,
                  fontWeight: FontWeight.w600,
                ),
          ),
        ),
        Card(
          child: Column(
            children: [
              if (!supportsAutoUpdate)
                _buildStoreManaged(context, ref)
              else if (isChecking)
                _buildChecking(context)
              else if (checkResult == null)
                _buildIdle(context, ref)
              else if (checkResult is UpdateCheckUpToDate)
                _buildUpToDate(context, ref, checkResult)
              else if (checkResult is UpdateCheckAvailable)
                _buildUpdateAvailable(context, ref, checkResult)
              else if (checkResult is UpdateCheckError)
                _buildError(context, ref, checkResult),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildStoreManaged(BuildContext context, WidgetRef ref) {
    final storeName = ref.watch(storeNameProvider) ?? 'your app store';
    final currentVersion = _currentVersion;

    return ListTile(
      leading: const Icon(Icons.store, color: Colors.grey),
      title: Text('Managed by $storeName'),
      subtitle: Text('Current version: $currentVersion'),
    );
  }

  Widget _buildIdle(BuildContext context, WidgetRef ref) {
    final currentVersion = _currentVersion;

    return ListTile(
      leading: const Icon(Icons.info_outline, color: Colors.grey),
      title: Text('Version $currentVersion'),
      subtitle: const Text('No update check performed yet'),
      trailing: OutlinedButton(
        onPressed: () => _checkForUpdate(ref),
        child: const Text('Check Now'),
      ),
    );
  }

  Widget _buildChecking(BuildContext context) {
    return const ListTile(
      leading: SizedBox(
        width: 24,
        height: 24,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
      title: Text('Checking for updates...'),
    );
  }

  Widget _buildUpToDate(
    BuildContext context,
    WidgetRef ref,
    UpdateCheckUpToDate result,
  ) {
    final relativeTime = _formatRelativeTime(result.checkedAt);

    return ListTile(
      leading: Icon(Icons.check_circle, color: Colors.green.shade700),
      title: const Text("You're up to date"),
      subtitle: Text(
        'Version ${result.currentVersion}\nLast checked: $relativeTime',
      ),
      isThreeLine: true,
      trailing: OutlinedButton(
        onPressed: () => _checkForUpdate(ref),
        child: const Text('Check Now'),
      ),
    );
  }

  Widget _buildUpdateAvailable(
    BuildContext context,
    WidgetRef ref,
    UpdateCheckAvailable result,
  ) {
    final dateStr = _formatDate(result.publishedAt);
    final notes =
        result.releaseNotes.isNotEmpty ? '\n${result.releaseNotes}' : '';
    final updateState = ref.watch(updateStateProvider);
    final isDownloading = updateState.status == UpdateStatus.downloading;
    final isVerifying = updateState.status == UpdateStatus.verifying;
    final isReady = updateState.status == UpdateStatus.ready;

    return ListTile(
      leading: Icon(
        isReady ? Icons.check_circle : Icons.system_update,
        color: isReady
            ? Colors.green.shade700
            : Theme.of(context).colorScheme.primary,
      ),
      title: Text(
        isReady
            ? 'Version ${result.latestVersion} ready to install'
            : 'Version ${result.latestVersion} available',
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Released $dateStr$notes'),
          if (isDownloading) ...[
            const SizedBox(height: 8),
            LinearProgressIndicator(
              value: (updateState.downloadProgress ?? 0),
              minHeight: 4,
            ),
            const SizedBox(height: 4),
            Text(
              'Downloading... ${((updateState.downloadProgress ?? 0) * 100).toInt()}%',
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
          ],
          if (isVerifying) ...[
            const SizedBox(height: 8),
            const LinearProgressIndicator(minHeight: 4),
            const SizedBox(height: 4),
            Text(
              'Verifying integrity...',
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
          ],
        ],
      ),
      isThreeLine: true,
      trailing: isDownloading || isVerifying
          ? const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : isReady
              ? FilledButton.icon(
                  onPressed: () => _launchInstall(context, ref, result),
                  icon: const Icon(Icons.restart_alt),
                  label: const Text('Install & Restart'),
                )
              : FilledButton(
                  onPressed: () => _downloadUpdate(ref),
                  child: const Text('Update Now'),
                ),
    );
  }

  Future<void> _downloadUpdate(WidgetRef ref) async {
    try {
      final releaseService = ref.read(githubReleaseServiceProvider);
      final release = releaseService.cachedRelease;
      if (release == null) {
        // No cached release — re-check first
        await _checkForUpdate(ref);
        return;
      }

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
    } catch (e) {
      logger.error('UpdateSettings', 'Failed to start download', e);
    }
  }

  Future<void> _launchInstall(
    BuildContext context,
    WidgetRef ref,
    UpdateCheckAvailable result,
  ) async {
    final orchestrator = ref.read(updateOrchestratorProvider);
    final launcher = ref.read(updaterLauncherProvider);
    final checksum = orchestrator.verifiedChecksum;

    if (checksum == null) {
      logger.error('UpdateSettings', 'No verified checksum available');
      return;
    }

    final platformName = Platform.isWindows
        ? 'windows'
        : Platform.isMacOS
            ? 'macos'
            : 'linux';

    // Resolve the staging directory for this version
    final stagingBaseDir = await orchestrator.getStagingDir();
    final stagingDir =
        '$stagingBaseDir/zajel-${result.latestVersion}-$platformName';

    try {
      final launched = await launcher.launchUpdate(
        targetVersion: result.latestVersion,
        currentVersion: _currentVersion,
        stagingDir: stagingDir,
        checksumSha256: checksum,
      );

      if (launched) {
        logger.info('UpdateSettings', 'Updater launched, exiting app');
        exit(0);
      }
    } on UpdaterBinaryNotFoundException catch (e) {
      logger.error('UpdateSettings', 'Updater binary not found', e);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Update failed: ${e.message}')),
        );
      }
    } catch (e) {
      logger.error('UpdateSettings', 'Failed to launch updater', e);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Update failed: $e')),
        );
      }
    }
  }

  Widget _buildError(
    BuildContext context,
    WidgetRef ref,
    UpdateCheckError result,
  ) {
    final isDisabled = result.isRateLimited &&
        result.rateLimitResetsAt != null &&
        DateTime.now().isBefore(result.rateLimitResetsAt!);

    String subtitle = result.message;
    if (result.isRateLimited && result.rateLimitResetsAt != null) {
      final remaining = result.rateLimitResetsAt!.difference(DateTime.now());
      if (remaining.isNegative) {
        // Rate limit has expired
      } else {
        subtitle = 'Rate limited - try again in ${remaining.inMinutes} minutes';
      }
    }

    return ListTile(
      leading: Icon(Icons.error_outline, color: Colors.orange.shade700),
      title: const Text('Could not check for updates'),
      subtitle: Text(subtitle),
      trailing: OutlinedButton(
        onPressed: isDisabled ? null : () => _checkForUpdate(ref),
        child: const Text('Retry'),
      ),
    );
  }

  Future<void> _checkForUpdate(WidgetRef ref) async {
    // Prevent concurrent checks
    if (ref.read(updateCheckInProgressProvider)) return;

    ref.read(updateCheckInProgressProvider.notifier).state = true;

    try {
      final service = ref.read(githubReleaseServiceProvider);
      final currentVersion = Environment.version;
      final result = await service.checkForUpdate(currentVersion);

      ref.read(updateCheckResultProvider.notifier).state = result;
    } catch (e) {
      logger.error('UpdateCheck', 'Unexpected error in UI check handler', e);
      ref.read(updateCheckResultProvider.notifier).state = UpdateCheckError(
        message: 'Could not check for updates',
        checkedAt: DateTime.now(),
      );
    } finally {
      ref.read(updateCheckInProgressProvider.notifier).state = false;
    }
  }

  String get _currentVersion {
    final version = Environment.version;
    return version.isNotEmpty ? version : 'dev';
  }

  /// Format a [DateTime] as a human-readable relative time string.
  static String _formatRelativeTime(DateTime dateTime) {
    final now = DateTime.now();
    final difference = now.difference(dateTime);

    if (difference.inMinutes < 1) {
      return 'just now';
    } else if (difference.inMinutes < 60) {
      final minutes = difference.inMinutes;
      return '$minutes ${minutes == 1 ? 'minute' : 'minutes'} ago';
    } else if (difference.inHours < 24) {
      final hours = difference.inHours;
      return '$hours ${hours == 1 ? 'hour' : 'hours'} ago';
    } else {
      return _formatDate(dateTime);
    }
  }

  /// Format a date as "Mar 3, 2026".
  static String _formatDate(DateTime dateTime) {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${months[dateTime.month - 1]} ${dateTime.day}, ${dateTime.year}';
  }
}
