import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../models/update_check_result.dart';
import '../models/update_state.dart';
import '../services/github_release_service.dart';
import '../services/update_download_service.dart';
import '../services/update_orchestrator.dart';
import '../services/update_package_detector.dart';
import 'auto_update_providers.dart';

/// Provider for the GitHub release service.
///
/// Watches [includePrereleasesProvider] and syncs the preference to the service.
/// Manages lifecycle via [ref.onDispose] to close the HTTP client.
final githubReleaseServiceProvider = Provider<GitHubReleaseService>((ref) {
  final service = GitHubReleaseService();
  final includePrerelease = ref.watch(includePrereleasesProvider);
  service.includePrerelease = includePrerelease;
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for the update package detector (singleton, cached).
///
/// Uses the existing [UpdatePackageDetector] with platform defaults.
final updatePackageDetectorProvider = Provider<UpdatePackageDetector>((ref) {
  return UpdatePackageDetector();
});

/// Provider for whether the platform supports auto-update.
///
/// Returns false for store-managed installs (MSIX, Snap, Flatpak, Mac App Store).
final supportsAutoUpdateProvider = Provider<bool>((ref) {
  final detector = ref.watch(updatePackageDetectorProvider);
  return detector.supportsAutoUpdate();
});

/// Provider for the store name, if the app is store-managed.
///
/// Returns null if the app supports auto-update.
final storeNameProvider = Provider<String?>((ref) {
  final detector = ref.watch(updatePackageDetectorProvider);
  return detector.storeName();
});

/// Provider for the latest manual update check result.
///
/// This is a [StateProvider] so it persists across Settings screen visits.
final updateCheckResultProvider =
    StateProvider<UpdateCheckResult?>((ref) => null);

/// Provider that indicates if an update check is currently in progress.
final updateCheckInProgressProvider = StateProvider<bool>((ref) => false);

// ── Update Download Service ──────────────────────────────

/// Provides the [UpdateDownloadService] instance.
///
/// The HTTP client is created once and disposed when the provider is disposed.
/// Cleanup is delegated to [UpdateDownloadService.dispose] which owns the client.
final updateDownloadServiceProvider = Provider<UpdateDownloadService>((ref) {
  final client = http.Client();
  final service = UpdateDownloadService(client: client);
  ref.onDispose(() => service.dispose());
  return service;
});

// ── Update Orchestrator ──────────────────────────────────

/// Provides the [UpdateOrchestrator] that coordinates the update lifecycle.
///
/// Depends on [updateDownloadServiceProvider] and [updatePackageDetectorProvider].
final updateOrchestratorProvider = Provider<UpdateOrchestrator>((ref) {
  final downloadService = ref.watch(updateDownloadServiceProvider);
  final packageDetector = ref.watch(updatePackageDetectorProvider);

  final orchestrator = UpdateOrchestrator(
    downloadService: downloadService,
    packageDetector: packageDetector,
  );

  ref.onDispose(() => orchestrator.dispose());
  return orchestrator;
});

// ── Update State ─────────────────────────────────────────

/// Provides the current [UpdateState] from the orchestrator reactively.
///
/// UI widgets watch this provider to react to state changes
/// (e.g., show progress, display ready banner, show error).
///
/// Watches the orchestrator's [stateStream] so that every state transition
/// triggers a rebuild. Returns [UpdateState.initial()] until the orchestrator
/// emits its first state.
final updateStateProvider = Provider<UpdateState>((ref) {
  final orchestrator = ref.watch(updateOrchestratorProvider);

  // Subscribe to the stream so this provider rebuilds on every state change.
  final streamSub = orchestrator.stateStream.listen((newState) {
    // Invalidate self so consumers get the latest state.
    ref.invalidateSelf();
  });
  ref.onDispose(streamSub.cancel);

  return orchestrator.state;
});

/// Stream of [UpdateState] changes from the orchestrator.
///
/// Use this when you need to listen to state transitions rather than
/// just reading the current state.
final updateStateStreamProvider = StreamProvider<UpdateState>((ref) {
  final orchestrator = ref.watch(updateOrchestratorProvider);
  return orchestrator.stateStream;
});

// ── Banner Dismissed State ───────────────────────────────

/// Whether the user has dismissed the update-ready banner in this session.
///
/// Resets when the app restarts or when a new update becomes available.
/// This is session-only state (not persisted).
final updateBannerDismissedProvider = StateProvider<bool>((ref) => false);
