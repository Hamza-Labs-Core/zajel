import 'dart:async';

import '../config/environment.dart';
import '../logging/logger_service.dart';
import '../network/server_discovery_service.dart' show DiscoveredServer;
import '../network/signaling_client.dart' show SignalingConnectionState;
import '../storage/trusted_peers_storage.dart' show TrustedPeer;

/// Result of a signaling connection attempt.
class SignalingConnectResult {
  final String pairingCode;
  final dynamic signalingClient;

  SignalingConnectResult({
    required this.pairingCode,
    required this.signalingClient,
  });
}

/// Encapsulates the app's core initialization sequence.
///
/// Uses closure-based DI so that Riverpod `ref.read()` stays in main.dart.
/// Each dependency is injected as a callback, keeping this class testable
/// without any Riverpod dependency.
class AppInitializationService {
  static const _tag = 'AppInitializationService';

  // --- Secure storage ---
  final Future<void> Function() initializeSecureStorage;

  // --- Core service accessors (closures over ref.read) ---
  final Future<void> Function() initializeCrypto;
  final Future<void> Function() initializeMessageStorage;
  final Future<void> Function() initializeChannelStorage;
  final Future<void> Function() initializeGroupStorage;
  final Future<List<TrustedPeer>> Function() getAllTrustedPeers;
  final void Function(Map<String, String> aliases) setPeerAliases;
  final Future<void> Function() initializeConnectionManager;
  final Future<void> Function() initializeDeviceLinkService;
  final Future<void> Function() initializeNotifications;
  final Future<void> Function() requestNotificationPermission;

  // --- Signaling connection ---
  final Future<SignalingConnectResult> Function(String serverUrl)
      connectToSignaling;

  /// Returns the ordered list of candidate servers to try. The caller
  /// will attempt each in order and take the first that successfully
  /// establishes a signaling connection. Filtering by skip list and
  /// region preference happens inside this closure, not here.
  final Future<List<DiscoveredServer>> Function() selectServerCandidates;

  final String Function(DiscoveredServer server) getWebSocketUrl;

  /// Called when a specific endpoint's connection attempt fails, so the
  /// shared skip list can avoid that endpoint on subsequent calls.
  final void Function(String endpoint) recordConnectionFailure;

  final Future<void> Function() reconnectTrustedPeers;

  // --- State setters (closures over ref.read(...).state = ...) ---
  final void Function(String code) setPairingCode;
  final void Function(dynamic client) setSignalingClient;
  final void Function(bool connected) setSignalingConnected;
  final void Function(DiscoveredServer server) setSelectedServer;

  // --- Signaling display state ---
  final void Function() setDisplayStateConnecting;
  final void Function() setDisplayStateConnected;
  final void Function() setDisplayStateDisconnected;

  // --- Signaling reconnect ---
  final Stream<SignalingConnectionState>? Function() getConnectionStateStream;

  AppInitializationService({
    required this.initializeSecureStorage,
    required this.initializeCrypto,
    required this.initializeMessageStorage,
    required this.initializeChannelStorage,
    required this.initializeGroupStorage,
    required this.getAllTrustedPeers,
    required this.setPeerAliases,
    required this.initializeConnectionManager,
    required this.initializeDeviceLinkService,
    required this.initializeNotifications,
    required this.requestNotificationPermission,
    required this.connectToSignaling,
    required this.selectServerCandidates,
    required this.getWebSocketUrl,
    required this.recordConnectionFailure,
    required this.reconnectTrustedPeers,
    required this.setPairingCode,
    required this.setSignalingClient,
    required this.setSignalingConnected,
    required this.setSelectedServer,
    required this.setDisplayStateConnecting,
    required this.setDisplayStateConnected,
    required this.setDisplayStateDisconnected,
    required this.getConnectionStateStream,
  });

  /// Run the core initialization sequence (everything except signaling).
  ///
  /// Returns true if initialization succeeded, false otherwise.
  Future<bool> initializeCore() async {
    try {
      logger.info(_tag, 'Initializing secure storage...');
      await initializeSecureStorage();

      logger.info(_tag, 'Initializing crypto service...');
      await initializeCrypto();

      logger.info(_tag, 'Initializing message storage...');
      await initializeMessageStorage();

      logger.info(_tag, 'Initializing channel storage...');
      await initializeChannelStorage();

      logger.info(_tag, 'Initializing group storage...');
      await initializeGroupStorage();

      // Load peer aliases from TrustedPeersStorage
      final allPeers = await getAllTrustedPeers();
      final aliases = <String, String>{};
      for (final tp in allPeers) {
        if (tp.alias != null) {
          aliases[tp.id] = tp.alias!;
        }
      }
      setPeerAliases(aliases);

      logger.info(_tag, 'Initializing connection manager...');
      await initializeConnectionManager();

      logger.info(_tag, 'Initializing device link service...');
      await initializeDeviceLinkService();

      // Initialize notification service
      await initializeNotifications();
      await requestNotificationPermission();

      logger.info(_tag, 'Core initialization complete');
      return true;
    } catch (e, stack) {
      logger.error(_tag, 'Initialization failed', e, stack);
      return false;
    }
  }

  /// Connect to the signaling server, handling server discovery.
  ///
  /// Updates provider state as connection progresses.
  Future<void> connectSignaling() async {
    if (Environment.isIntegrationTest) {
      logger.info(_tag, 'Skipping signaling connection (INTEGRATION_TEST)');
      return;
    }
    setDisplayStateConnecting();

    // Direct-URL override (used in E2E tests and pinned deploys).
    // No failover here because there is only one URL to try.
    if (Environment.hasDirectSignalingUrl) {
      final serverUrl = Environment.signalingUrl;
      logger.info(_tag, 'Using direct signaling URL: $serverUrl');
      try {
        final result = await connectToSignaling(serverUrl);
        setPairingCode(result.pairingCode);
        setSignalingClient(result.signalingClient);
        setSignalingConnected(true);
        setDisplayStateConnected();
        await reconnectTrustedPeers();
      } catch (e, stack) {
        logger.error(
            _tag, 'Failed to connect to direct signaling URL', e, stack);
        setDisplayStateDisconnected();
      }
      return;
    }

    final List<DiscoveredServer> candidates;
    try {
      candidates = await selectServerCandidates();
    } catch (e, stack) {
      logger.error(_tag, 'Server discovery failed', e, stack);
      setDisplayStateDisconnected();
      return;
    }

    if (candidates.isEmpty) {
      logger.warning(_tag, 'No servers available from discovery');
      setDisplayStateDisconnected();
      return;
    }

    // Try candidates in order until one connects. Each failed endpoint
    // is recorded so sibling connection sites (pairing redirects,
    // reconnect loop, federation) skip it for the next ~5 minutes.
    for (final server in candidates) {
      setSelectedServer(server);
      final serverUrl = getWebSocketUrl(server);
      logger.info(_tag, 'Trying server ${server.region} - ${server.endpoint}');
      try {
        final result = await connectToSignaling(serverUrl);
        logger.info(_tag,
            'Connected to ${server.endpoint} (pairing code: ${result.pairingCode})');
        setPairingCode(result.pairingCode);
        setSignalingClient(result.signalingClient);
        setSignalingConnected(true);
        setDisplayStateConnected();
        await reconnectTrustedPeers();
        return;
      } catch (e) {
        logger.warning(_tag,
            'Connect attempt to ${server.endpoint} failed: $e — skipping and trying next');
        recordConnectionFailure(server.endpoint);
      }
    }

    logger.error(_tag, 'All ${candidates.length} candidate servers failed');
    setDisplayStateDisconnected();
  }

  /// Set up signaling auto-reconnect with exponential backoff.
  ///
  /// Listens to the current signaling client's connection state stream.
  /// On disconnect/failure, retries indefinitely with capped exponential
  /// backoff. After a successful reconnect, re-subscribes to the NEW
  /// client's stream so subsequent disconnects are also detected.
  ///
  /// [isDisposed] callback checks whether the widget is disposed.
  /// Returns a function that cancels the reconnect listener.
  void Function()? setupSignalingReconnect({
    required bool Function() isDisposed,
  }) {
    // Check if there's a stream available at setup time.
    // If not, there's no client to listen to.
    final initialStream = getConnectionStateStream();
    if (initialStream == null) return null;

    StreamSubscription? currentSub;
    bool isReconnecting = false;

    void listenToCurrentClient() {
      currentSub?.cancel();
      final stream = getConnectionStateStream();
      if (stream == null) return;

      currentSub = stream.listen((state) async {
        if (state == SignalingConnectionState.disconnected ||
            state == SignalingConnectionState.failed) {
          setSignalingConnected(false);
          setDisplayStateDisconnected();

          if (isReconnecting || isDisposed()) return;
          isReconnecting = true;

          var delay = const Duration(seconds: 3);
          const maxDelay = Duration(seconds: 120);
          var attempt = 0;

          while (!isDisposed()) {
            attempt++;
            logger.info(_tag,
                'Signaling reconnect attempt $attempt in ${delay.inSeconds}s');
            setDisplayStateConnecting();

            await Future<void>.delayed(delay);
            if (isDisposed()) break;

            try {
              await connectSignaling();
              logger.info(_tag, 'Signaling reconnected on attempt $attempt');
              isReconnecting = false;
              // Re-subscribe to the NEW client's stream so future
              // disconnects are detected.
              listenToCurrentClient();
              return;
            } catch (e) {
              logger.warning(_tag, 'Reconnect attempt $attempt failed: $e');
            }

            delay = Duration(
              seconds: (delay.inSeconds * 2).clamp(1, maxDelay.inSeconds),
            );
          }

          isReconnecting = false;
        }
      });
    }

    listenToCurrentClient();

    // Return a cancel function instead of StreamSubscription since the
    // subscription is replaced on each successful reconnect.
    return () {
      currentSub?.cancel();
      currentSub = null;
    };
  }
}
