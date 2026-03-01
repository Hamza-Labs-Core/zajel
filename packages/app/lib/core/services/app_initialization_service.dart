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
  final Future<DiscoveredServer?> Function() selectServer;
  final String Function(DiscoveredServer server) getWebSocketUrl;
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
    required this.selectServer,
    required this.getWebSocketUrl,
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
    try {
      logger.info(_tag, 'Auto-connecting to signaling server...');
      setDisplayStateConnecting();

      String serverUrl;

      if (Environment.hasDirectSignalingUrl) {
        serverUrl = Environment.signalingUrl;
        logger.info(_tag, 'Using direct signaling URL: $serverUrl');
      } else {
        final selectedServer = await selectServer();
        if (selectedServer == null) {
          logger.warning(_tag, 'No servers available from discovery');
          setDisplayStateDisconnected();
          return;
        }
        setSelectedServer(selectedServer);
        logger.info(_tag,
            'Selected server: ${selectedServer.region} - ${selectedServer.endpoint}');
        serverUrl = getWebSocketUrl(selectedServer);
      }

      logger.debug(_tag, 'Connecting to WebSocket URL: $serverUrl');

      final result = await connectToSignaling(serverUrl);
      logger.info(_tag,
          'Connected to signaling with pairing code: ${result.pairingCode}');
      setPairingCode(result.pairingCode);
      setSignalingClient(result.signalingClient);
      setSignalingConnected(true);
      setDisplayStateConnected();

      await reconnectTrustedPeers();
    } catch (e, stack) {
      logger.error(_tag, 'Failed to auto-connect to signaling', e, stack);
      setDisplayStateDisconnected();
    }
  }

  /// Set up signaling auto-reconnect with exponential backoff.
  ///
  /// [isDisposed] callback checks whether the widget is disposed.
  /// Returns the stream subscription (caller is responsible for cancelling).
  StreamSubscription? setupSignalingReconnect({
    required bool Function() isDisposed,
  }) {
    final stream = getConnectionStateStream();
    if (stream == null) return null;

    bool isReconnecting = false;

    return stream.listen((state) async {
      if (state == SignalingConnectionState.disconnected ||
          state == SignalingConnectionState.failed) {
        setSignalingConnected(false);
        setDisplayStateDisconnected();

        if (isReconnecting || isDisposed()) return;
        isReconnecting = true;

        var delay = const Duration(seconds: 3);
        const maxDelay = Duration(seconds: 60);
        const maxRetries = 5;

        for (var attempt = 1; attempt <= maxRetries; attempt++) {
          if (isDisposed()) break;
          logger.info(_tag,
              'Signaling reconnect attempt $attempt/$maxRetries in ${delay.inSeconds}s');
          setDisplayStateConnecting();

          await Future<void>.delayed(delay);
          if (isDisposed()) break;

          try {
            await connectSignaling();
            logger.info(_tag, 'Signaling reconnected on attempt $attempt');
            isReconnecting = false;
            return;
          } catch (e) {
            logger.warning(_tag, 'Reconnect attempt $attempt failed: $e');
          }

          delay = Duration(
            seconds: (delay.inSeconds * 2).clamp(0, maxDelay.inSeconds),
          );
        }

        logger.error(
            _tag, 'Signaling reconnect failed after $maxRetries attempts');
        setDisplayStateDisconnected();
        isReconnecting = false;
      }
    });
  }
}
