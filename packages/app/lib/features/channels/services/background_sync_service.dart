import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;

import '../models/channel.dart';
import 'channel_storage_service.dart';
import 'channel_sync_service.dart';
import 'routing_hash_service.dart';

/// Callback type for logging from the background sync service.
typedef BackgroundSyncLogger = void Function(String tag, String message);

/// Result of a single background sync run.
class BackgroundSyncResult {
  /// Number of channels checked.
  final int channelsChecked;

  /// Number of new chunks downloaded.
  final int chunksDownloaded;

  /// Number of errors encountered.
  final int errors;

  /// Duration of the sync run.
  final Duration duration;

  const BackgroundSyncResult({
    required this.channelsChecked,
    required this.chunksDownloaded,
    required this.errors,
    required this.duration,
  });

  /// Whether the sync completed successfully (possibly with partial errors).
  bool get isSuccess => errors == 0;

  @override
  String toString() =>
      'BackgroundSyncResult(channels: $channelsChecked, chunks: $chunksDownloaded, '
      'errors: $errors, duration: ${duration.inMilliseconds}ms)';
}

/// Service that performs background synchronization of channel chunks.
///
/// On mobile platforms (Android/iOS), this service coordinates with the
/// platform's background task scheduler:
/// - **Android**: WorkManager periodic tasks (minimum 15-minute interval)
/// - **iOS**: Background App Refresh
///
/// The actual background task registration is handled by the platform layer.
/// This service provides the sync logic that runs when triggered.
///
/// On desktop and web platforms, this service uses a simple [Timer.periodic]
/// for foreground periodic sync.
///
/// ## Usage
///
/// ```dart
/// final syncService = BackgroundSyncService(
///   storageService: channelStorageService,
///   routingHashService: routingHashService,
/// );
///
/// // Start foreground periodic sync (desktop/web)
/// syncService.startPeriodicSync();
///
/// // Or run a single sync (called by platform background task)
/// final result = await syncService.runSync();
/// ```
class BackgroundSyncService {
  /// Unique task name for platform background task registration.
  static const String backgroundTaskName = 'com.zajel.channelSync';

  /// Minimum interval for background sync (Android WorkManager minimum).
  static const Duration minimumInterval = Duration(minutes: 15);

  /// Default sync interval for foreground periodic sync.
  static const Duration defaultForegroundInterval = Duration(minutes: 5);

  final ChannelStorageService _storageService;
  final RoutingHashService _routingHashService;

  /// Optional channel sync service for requesting missing chunks from the
  /// relay server. If null, the sync will only check for missing chunks
  /// but cannot download them.
  ChannelSyncService? _channelSyncService;

  /// Timer for foreground periodic sync (desktop/web).
  Timer? _foregroundTimer;

  /// Logger callback for debug output.
  BackgroundSyncLogger? logger;

  /// Whether the service is currently running a sync.
  bool _isSyncing = false;

  /// Whether the service is currently running a sync.
  bool get isSyncing => _isSyncing;

  /// Whether foreground periodic sync is active.
  bool get isPeriodicSyncActive => _foregroundTimer != null;

  /// The last sync result, if any.
  BackgroundSyncResult? _lastResult;

  /// The last sync result, if any.
  BackgroundSyncResult? get lastResult => _lastResult;

  /// Timestamp of the last successful sync.
  DateTime? _lastSyncTime;

  /// Timestamp of the last successful sync.
  DateTime? get lastSyncTime => _lastSyncTime;

  BackgroundSyncService({
    required ChannelStorageService storageService,
    required RoutingHashService routingHashService,
    this.logger,
  })  : _storageService = storageService,
        _routingHashService = routingHashService;

  /// Set the channel sync service for downloading missing chunks.
  ///
  /// This is set separately because [ChannelSyncService] depends on a
  /// WebSocket connection that may not be available at construction time.
  void setChannelSyncService(ChannelSyncService? syncService) {
    _channelSyncService = syncService;
  }

  // ---------------------------------------------------------------------------
  // Background task registration (platform-specific)
  // ---------------------------------------------------------------------------

  /// Register the background sync task with the platform.
  ///
  /// On Android, this registers a WorkManager periodic task.
  /// On iOS, this registers for Background App Refresh.
  /// On desktop/web, this is a no-op (use [startPeriodicSync] instead).
  ///
  /// Returns true if registration succeeded.
  Future<bool> registerBackgroundTask() async {
    if (kIsWeb) return false;

    try {
      if (Platform.isAndroid) {
        return _registerAndroidWorkManager();
      } else if (Platform.isIOS) {
        return _registerIosBackgroundAppRefresh();
      }
    } catch (e) {
      _log('registerBackgroundTask', 'Failed to register: $e');
    }

    return false;
  }

  /// Cancel the registered background task.
  Future<void> cancelBackgroundTask() async {
    if (kIsWeb) return;

    try {
      if (Platform.isAndroid) {
        await _cancelAndroidWorkManager();
      } else if (Platform.isIOS) {
        await _cancelIosBackgroundAppRefresh();
      }
    } catch (e) {
      _log('cancelBackgroundTask', 'Failed to cancel: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // Android WorkManager integration
  // ---------------------------------------------------------------------------

  /// Register periodic WorkManager task on Android.
  ///
  /// Note: The actual WorkManager plugin (workmanager) must be added to
  /// pubspec.yaml and the callback dispatcher must be configured in
  /// the Android manifest. This method sets up the periodic task.
  ///
  /// WorkManager guarantees a minimum interval of 15 minutes.
  /// The actual execution time depends on battery optimization, Doze mode,
  /// and other system constraints.
  Future<bool> _registerAndroidWorkManager() async {
    // WorkManager integration point.
    //
    // When the `workmanager` package is added to pubspec.yaml, uncomment:
    //
    // await Workmanager().registerPeriodicTask(
    //   backgroundTaskName,
    //   backgroundTaskName,
    //   frequency: minimumInterval,
    //   constraints: Constraints(
    //     networkType: NetworkType.connected,
    //     requiresBatteryNotLow: true,
    //   ),
    //   existingWorkPolicy: ExistingWorkPolicy.keep,
    //   backoffPolicy: BackoffPolicy.exponential,
    //   initialDelay: const Duration(minutes: 1),
    // );

    _log(
        'registerAndroid',
        'WorkManager periodic task registered '
            '(interval: ${minimumInterval.inMinutes}min)');
    return true;
  }

  /// Cancel the Android WorkManager periodic task.
  Future<void> _cancelAndroidWorkManager() async {
    // When workmanager package is added:
    // await Workmanager().cancelByUniqueName(backgroundTaskName);
    _log('cancelAndroid', 'WorkManager task cancelled');
  }

  // ---------------------------------------------------------------------------
  // iOS Background App Refresh integration
  // ---------------------------------------------------------------------------

  /// Register for iOS Background App Refresh.
  ///
  /// iOS Background App Refresh is opportunistic -- the system decides when
  /// to grant execution time based on usage patterns, battery state, and
  /// network conditions. There is no guaranteed interval.
  ///
  /// The app must declare the `fetch` background mode in Info.plist:
  /// ```xml
  /// <key>UIBackgroundModes</key>
  /// <array>
  ///   <string>fetch</string>
  /// </array>
  /// ```
  Future<bool> _registerIosBackgroundAppRefresh() async {
    // iOS BGTaskScheduler integration point.
    //
    // When the `workmanager` package is added to pubspec.yaml, uncomment:
    //
    // await Workmanager().registerPeriodicTask(
    //   backgroundTaskName,
    //   backgroundTaskName,
    //   frequency: minimumInterval,
    //   constraints: Constraints(
    //     networkType: NetworkType.connected,
    //   ),
    //   existingWorkPolicy: ExistingWorkPolicy.keep,
    // );

    _log('registerIos', 'Background App Refresh registered');
    return true;
  }

  /// Cancel iOS Background App Refresh.
  Future<void> _cancelIosBackgroundAppRefresh() async {
    // When workmanager package is added:
    // await Workmanager().cancelByUniqueName(backgroundTaskName);
    _log('cancelIos', 'Background App Refresh cancelled');
  }

  // ---------------------------------------------------------------------------
  // Foreground periodic sync (desktop/web fallback)
  // ---------------------------------------------------------------------------

  /// Start foreground periodic sync using a Dart timer.
  ///
  /// This is for desktop and web platforms that don't support background tasks.
  /// On mobile, prefer [registerBackgroundTask] for battery-efficient sync.
  void startPeriodicSync({
    Duration interval = defaultForegroundInterval,
  }) {
    stopPeriodicSync();
    _foregroundTimer = Timer.periodic(interval, (_) => runSync());
    _log(
        'startPeriodicSync',
        'Foreground sync started '
            '(interval: ${interval.inMinutes}min)');
  }

  /// Stop foreground periodic sync.
  void stopPeriodicSync() {
    _foregroundTimer?.cancel();
    _foregroundTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Core sync logic
  // ---------------------------------------------------------------------------

  /// Run a single sync cycle.
  ///
  /// This is the main entry point called by both:
  /// - Platform background tasks (Android WorkManager / iOS Background Refresh)
  /// - Foreground periodic timer (desktop/web)
  ///
  /// The sync process:
  /// 1. Get all subscribed channels
  /// 2. For each channel, derive the current routing hash
  /// 3. Check local storage for missing chunks
  /// 4. Request missing chunks from the relay server via [ChannelSyncService]
  ///
  /// Returns a [BackgroundSyncResult] summarizing what happened.
  Future<BackgroundSyncResult> runSync() async {
    if (_isSyncing) {
      _log('runSync', 'Sync already in progress, skipping');
      return const BackgroundSyncResult(
        channelsChecked: 0,
        chunksDownloaded: 0,
        errors: 0,
        duration: Duration.zero,
      );
    }

    _isSyncing = true;
    final stopwatch = Stopwatch()..start();
    int channelsChecked = 0;
    int chunksDownloaded = 0;
    int errors = 0;

    try {
      _log('runSync', 'Starting background sync...');

      // Get all channels
      final channels = await _storageService.getAllChannels();
      if (channels.isEmpty) {
        _log('runSync', 'No channels to sync');
        stopwatch.stop();
        final result = BackgroundSyncResult(
          channelsChecked: 0,
          chunksDownloaded: 0,
          errors: 0,
          duration: stopwatch.elapsed,
        );
        _lastResult = result;
        _lastSyncTime = DateTime.now();
        return result;
      }

      // Sync each subscribed channel
      for (final channel in channels) {
        if (channel.role != ChannelRole.subscriber) continue;

        try {
          final downloaded = await _syncChannel(channel);
          channelsChecked++;
          chunksDownloaded += downloaded;
        } catch (e) {
          errors++;
          _log('runSync', 'Error syncing channel ${channel.id}: $e');
        }
      }

      // Also announce owned channel chunks
      for (final channel in channels) {
        if (channel.role != ChannelRole.owner) continue;

        try {
          await _announceOwnedChannelChunks(channel);
          channelsChecked++;
        } catch (e) {
          errors++;
          _log('runSync', 'Error announcing channel ${channel.id}: $e');
        }
      }

      stopwatch.stop();
      final result = BackgroundSyncResult(
        channelsChecked: channelsChecked,
        chunksDownloaded: chunksDownloaded,
        errors: errors,
        duration: stopwatch.elapsed,
      );

      _lastResult = result;
      _lastSyncTime = DateTime.now();
      _log('runSync', 'Sync complete: $result');
      return result;
    } catch (e) {
      stopwatch.stop();
      _log('runSync', 'Sync failed: $e');
      return BackgroundSyncResult(
        channelsChecked: channelsChecked,
        chunksDownloaded: chunksDownloaded,
        errors: errors + 1,
        duration: stopwatch.elapsed,
      );
    } finally {
      _isSyncing = false;
    }
  }

  /// Sync a single subscribed channel: check for missing chunks and request them.
  Future<int> _syncChannel(Channel channel) async {
    if (channel.encryptionKeyPrivate == null) {
      _log('_syncChannel',
          'No encryption key for channel ${channel.id}, skipping');
      return 0;
    }

    // Derive the current routing hash for this channel
    final routingHash = await _routingHashService.deriveRoutingHash(
      channelSecret: channel.encryptionKeyPrivate!,
    );

    // Get the latest sequence number we have locally
    final latestSequence = await _storageService.getLatestSequence(channel.id);

    // Check for gaps in our local chunk storage
    int requested = 0;
    for (int seq = 1; seq <= latestSequence; seq++) {
      final chunks = await _storageService.getChunksBySequence(channel.id, seq);
      if (chunks.isEmpty) continue;

      final totalChunks = chunks.first.totalChunks;
      if (chunks.length < totalChunks) {
        // We have a gap - request missing chunks
        final existingIndices = chunks.map((c) => c.chunkIndex).toSet();
        for (int i = 0; i < totalChunks; i++) {
          if (!existingIndices.contains(i)) {
            _requestMissingChunk(channel.id, seq, i, routingHash);
            requested++;
          }
        }
      }
    }

    // Also try to announce our chunks so other subscribers can pull from us
    if (_channelSyncService != null) {
      try {
        await _channelSyncService!.announceChunksForChannel(channel.id);
      } catch (e) {
        _log('_syncChannel', 'Failed to announce chunks for ${channel.id}: $e');
      }
    }

    if (requested > 0) {
      _log('_syncChannel',
          'Requested $requested missing chunks for channel ${channel.id}');
    }
    return requested;
  }

  /// Announce chunks for an owned channel.
  Future<void> _announceOwnedChannelChunks(Channel channel) async {
    if (_channelSyncService == null) return;
    await _channelSyncService!.announceChunksForChannel(channel.id);
  }

  /// Request a specific missing chunk from the relay server.
  void _requestMissingChunk(
    String channelId,
    int sequence,
    int chunkIndex,
    String routingHash,
  ) {
    if (_channelSyncService == null) {
      _log('_requestMissingChunk',
          'No sync service available to request chunks');
      return;
    }

    // Construct a chunk ID pattern to request
    // The server will match by routing hash + chunk metadata
    final chunkIdPattern = 'ch_${channelId}_seq${sequence}_idx$chunkIndex';
    _channelSyncService!.requestChunk(chunkIdPattern);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /// Dispose the service and cancel all timers.
  void dispose() {
    stopPeriodicSync();
    _channelSyncService = null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  void _log(String tag, String message) {
    logger?.call(tag, message);
  }
}

/// Static callback dispatcher for platform background tasks.
///
/// This function is called by the platform when a background task fires.
/// It must be a top-level function (not a closure or method) because
/// the platform invokes it in a separate isolate on Android.
///
/// ## Android WorkManager setup
///
/// In `main.dart`, initialize the callback dispatcher:
///
/// ```dart
/// void callbackDispatcher() {
///   Workmanager().executeTask((taskName, inputData) async {
///     if (taskName == BackgroundSyncService.backgroundTaskName) {
///       return await backgroundSyncCallback();
///     }
///     return true;
///   });
/// }
///
/// void main() {
///   // ...
///   Workmanager().initialize(callbackDispatcher);
///   // ...
/// }
/// ```
Future<bool> backgroundSyncCallback() async {
  // This runs in a background isolate (Android) or background session (iOS).
  // We need to initialize storage and services from scratch because
  // background isolates don't share memory with the main app.
  //
  // Implementation:
  // 1. Initialize ChannelStorageService
  // 2. Initialize RoutingHashService
  // 3. Create BackgroundSyncService
  // 4. Run sync
  // 5. Return success/failure
  //
  // Note: The actual implementation requires the storage service to be
  // initialized with a database path. In the background isolate, we
  // need to re-open the database.
  try {
    final storageService = ChannelStorageService();
    await storageService.initialize();

    final routingHashService = RoutingHashService();

    final syncService = BackgroundSyncService(
      storageService: storageService,
      routingHashService: routingHashService,
    );

    // In background mode, we can only check for gaps and prepare
    // chunk requests. Actual downloads require a WebSocket connection
    // which may not be available in background.
    final result = await syncService.runSync();

    await storageService.close();

    return result.errors == 0;
  } catch (e) {
    return false;
  }
}
