import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/logging/logger_service.dart';
import 'models/version_policy.dart';
import 'providers/attestation_providers.dart';
import 'widgets/force_update_dialog.dart';
import 'widgets/update_prompt_dialog.dart';

/// Initializes all attestation services on app startup.
///
/// This class is designed to be called from the app initialization flow
/// without modifying `main.dart` directly. Wire it in by calling
/// [AttestationInitializer.initialize] from your app's init sequence.
///
/// Initialization steps:
/// 1. Run version check — may block the app with a force update dialog.
/// 2. Run attestation registration if no valid session token exists.
/// 3. Initialize anti-tamper checks (informational only).
class AttestationInitializer {
  static const _tag = 'AttestationInit';

  /// Initialize all attestation services.
  ///
  /// Call this during app startup. If a force update is required,
  /// pass a [navigatorKey] to show the blocking dialog.
  ///
  /// Returns true if the app can proceed normally, false if a
  /// blocking update dialog was shown.
  static Future<bool> initialize(
    WidgetRef ref, {
    GlobalKey<NavigatorState>? navigatorKey,
  }) async {
    logger.info(_tag, 'Starting attestation initialization');

    // Step 1: Version check
    final canProceed = await _runVersionCheck(ref, navigatorKey: navigatorKey);
    if (!canProceed) {
      logger.info(_tag, 'Version check requires update, blocking app');
      return false;
    }

    // Step 2: Attestation registration
    await _runRegistration(ref);

    // Step 3: Anti-tamper checks
    await _runAntiTamperChecks(ref);

    logger.info(_tag, 'Attestation initialization complete');
    return true;
  }

  /// Run the version check and handle the result.
  static Future<bool> _runVersionCheck(
    WidgetRef ref, {
    GlobalKey<NavigatorState>? navigatorKey,
  }) async {
    try {
      final versionCheckService = ref.read(versionCheckServiceProvider);
      final status = await versionCheckService.checkVersion();
      ref.read(versionCheckProvider.notifier).state = status;
      ref.read(versionPolicyProvider.notifier).state =
          versionCheckService.cachedPolicy;

      switch (status) {
        case VersionStatus.upToDate:
          return true;

        case VersionStatus.updateAvailable:
          // Show non-blocking dialog
          if (navigatorKey?.currentContext != null) {
            _showUpdatePrompt(
              navigatorKey!.currentContext!,
              versionCheckService.cachedPolicy,
            );
          }
          return true;

        case VersionStatus.updateRequired:
          // Show blocking dialog
          if (navigatorKey?.currentContext != null) {
            _showForceUpdate(
              navigatorKey!.currentContext!,
              requiredVersion: versionCheckService.cachedPolicy?.minimumVersion,
            );
          }
          return false;

        case VersionStatus.blocked:
          // Show blocking dialog
          if (navigatorKey?.currentContext != null) {
            _showForceUpdate(
              navigatorKey!.currentContext!,
              isBlocked: true,
            );
          }
          return false;
      }
    } catch (e) {
      logger.error(_tag, 'Version check failed', e);
      // Fail open — let the app continue
      return true;
    }
  }

  /// Run attestation registration if needed.
  static Future<void> _runRegistration(WidgetRef ref) async {
    try {
      final attestationService = ref.read(attestationServiceProvider);
      final token = await attestationService.initialize();

      if (token != null) {
        ref.read(sessionTokenProvider.notifier).state = token;
        logger.info(_tag, 'Attestation token available');
      } else {
        logger.warning(
          _tag,
          'No attestation token available. '
          'This is expected in dev builds without BUILD_TOKEN.',
        );
      }
    } catch (e) {
      logger.error(_tag, 'Attestation registration failed', e);
    }
  }

  /// Run anti-tamper checks (informational only).
  static Future<void> _runAntiTamperChecks(WidgetRef ref) async {
    try {
      final antiTamperService = ref.read(antiTamperServiceProvider);
      final result = await antiTamperService.runChecks();
      ref.read(antiTamperResultProvider.notifier).state = result;
    } catch (e) {
      logger.error(_tag, 'Anti-tamper checks failed', e);
    }
  }

  /// Show a non-blocking update prompt.
  static void _showUpdatePrompt(BuildContext context, VersionPolicy? policy) {
    showDialog(
      context: context,
      barrierDismissible: true,
      builder: (_) => UpdatePromptDialog(
        recommendedVersion: policy?.recommendedVersion,
      ),
    );
  }

  /// Show a blocking force update dialog.
  static void _showForceUpdate(
    BuildContext context, {
    String? requiredVersion,
    bool isBlocked = false,
  }) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(
        builder: (_) => ForceUpdateDialog(
          requiredVersion: requiredVersion,
          isBlocked: isBlocked,
        ),
      ),
      (_) => false,
    );
  }
}
