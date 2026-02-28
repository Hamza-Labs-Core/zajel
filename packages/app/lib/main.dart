import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'app_router.dart';
import 'core/config/environment.dart';
import 'core/logging/logger_service.dart';
import 'core/models/models.dart';
import 'core/network/connection_manager.dart' show ConnectionManager;
import 'core/notifications/call_foreground_service.dart';
import 'core/providers/app_providers.dart';
import 'core/services/auto_delete_service.dart';
import 'core/services/file_transfer_listener.dart';
import 'core/services/notification_listener_service.dart';
import 'core/services/pair_request_handler.dart';
import 'core/services/signaling_reconnect_service.dart';
import 'core/services/voip_call_handler.dart';
import 'core/storage/file_receive_service.dart' show FileTransfer;
import 'features/channels/providers/channel_providers.dart';
import 'features/chat/services/typing_indicator_service.dart';
import 'features/groups/providers/group_providers.dart';
import 'core/utils/identity_utils.dart';
import 'shared/theme/app_theme.dart';

const bool _isE2eTest = bool.fromEnvironment('E2E_TEST');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Guard: E2E_TEST must never leak into release builds
  Environment.assertNoE2eTestInRelease();

  // Force semantics tree so UiAutomator2/AT-SPI/UIA can see widgets in E2E tests
  if (_isE2eTest) {
    SemanticsBinding.instance.ensureSemantics();
  }

  // Initialize sqflite FFI for desktop platforms (Linux, Windows, macOS).
  // Without this, openDatabase throws "databaseFactory not initialized".
  if (Platform.isLinux || Platform.isWindows || Platform.isMacOS) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  }

  // Initialize logger first
  await logger.initialize();
  logger.info('Main', 'App starting on ${Platform.operatingSystem}...');

  // Windows-specific: catch and log platform initialization errors that
  // could cause a black screen (ANGLE/DirectX context failures)
  if (Platform.isWindows) {
    FlutterError.onError = (details) {
      logger.error('FlutterError', details.exceptionAsString(),
          details.exception, details.stack);
      FlutterError.presentError(details);
    };
    PlatformDispatcher.instance.onError = (error, stack) {
      logger.error('PlatformError', 'Unhandled platform error', error, stack);
      return true;
    };
  }

  // Initialize shared preferences
  final prefs = await SharedPreferences.getInstance();

  runApp(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
      ],
      child: const ZajelApp(),
    ),
  );
}

class ZajelApp extends ConsumerStatefulWidget {
  const ZajelApp({super.key});

  @override
  ConsumerState<ZajelApp> createState() => _ZajelAppState();
}

class _ZajelAppState extends ConsumerState<ZajelApp>
    with WidgetsBindingObserver {
  bool _initialized = false;
  FileTransferListener? _fileTransferListener;
  PairRequestHandler? _pairRequestHandler;
  NotificationListenerService? _notificationListenerService;
  SignalingReconnectService? _signalingReconnectService;
  VoipCallHandler? _voipCallHandler;
  AutoDeleteService? _autoDeleteService;
  bool _disposed = false;
  bool _showPrivacyScreen = false;
  ConnectionManager? _connectionManager;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initialize();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Clean up native resources when app is detached (closing)
    if (state == AppLifecycleState.detached && !_disposed) {
      _disposed = true;
      _disposeServicesSync();
    }

    // Track foreground state for notification suppression
    ref.read(appInForegroundProvider.notifier).state =
        state == AppLifecycleState.resumed;

    // Privacy screen: obscure app content when backgrounded.
    // On mobile: inactive/paused when app goes to background or task switcher.
    // On desktop: hidden when minimized, inactive when losing focus.
    final privacyEnabled = ref.read(privacyScreenProvider);
    if (privacyEnabled) {
      if (state == AppLifecycleState.inactive ||
          state == AppLifecycleState.paused ||
          state == AppLifecycleState.hidden) {
        if (mounted && !_showPrivacyScreen) {
          setState(() => _showPrivacyScreen = true);
        }
      } else if (state == AppLifecycleState.resumed) {
        if (mounted && _showPrivacyScreen) {
          setState(() => _showPrivacyScreen = false);
        }
      }
    }
  }

  void _disposeServicesSync() {
    logger.info('ZajelApp', 'Disposing services...');
    try {
      // Use cached reference — ref.read() throws StateError if called after
      // the widget is disposed (e.g. between integration test runs).
      _connectionManager?.dispose();
      logger.info('ZajelApp', 'Services disposed');
    } catch (e) {
      logger.error('ZajelApp', 'Error during shutdown', e);
    }
    // Dispose logger last
    logger.dispose();
  }

  Future<void> _initialize() async {
    final sw = Stopwatch()..start();
    try {
      logger.info('ZajelApp', 'Initializing crypto service...');
      final cryptoService = ref.read(cryptoServiceProvider);
      await cryptoService.initialize();
      logger.info('ZajelApp',
          'Crypto service initialized (${sw.elapsedMilliseconds}ms)');

      logger.info('ZajelApp', 'Initializing message storage...');
      final messageStorage = ref.read(messageStorageProvider);
      await messageStorage.initialize();
      logger.info('ZajelApp',
          'Message storage initialized (${sw.elapsedMilliseconds}ms)');

      logger.info('ZajelApp', 'Initializing channel storage...');
      final channelStorage = ref.read(channelStorageServiceProvider);
      await channelStorage.initialize();

      logger.info('ZajelApp', 'Initializing group storage...');
      final groupStorage = ref.read(groupStorageServiceProvider);
      await groupStorage.initialize();

      // Load peer aliases from TrustedPeersStorage
      final trustedPeers = ref.read(trustedPeersStorageProvider);
      final allPeers = await trustedPeers.getAllPeers();
      final aliases = <String, String>{};
      for (final tp in allPeers) {
        if (tp.alias != null) {
          aliases[tp.id] = tp.alias!;
        }
      }
      ref.read(peerAliasesProvider.notifier).state = aliases;

      logger.info(
          'ZajelApp', 'Storage initialized (${sw.elapsedMilliseconds}ms)');

      logger.info('ZajelApp', 'Initializing connection manager...');
      _connectionManager = ref.read(connectionManagerProvider);
      await _connectionManager!.initialize();
      logger.info('ZajelApp',
          'Connection manager initialized (${sw.elapsedMilliseconds}ms)');

      logger.info('ZajelApp', 'Initializing device link service...');
      final deviceLinkService = ref.read(deviceLinkServiceProvider);
      await deviceLinkService.initialize();

      // Start group invitation/message listener so ginv:/grp: messages
      // arriving over the broadcast stream are processed (not silently lost).
      ref.read(groupInvitationServiceProvider);

      // Start typing indicator listener
      ref.read(typingIndicatorServiceProvider);

      // Start read receipt service so rcpt: messages are processed and
      // outgoing message statuses are updated from delivered -> read.
      ref.read(readReceiptServiceProvider);

      // Set up file transfer listeners
      _fileTransferListener = FileTransferListener(
        connectionManager: _connectionManager!,
        fileReceiveService: ref.read(fileReceiveServiceProvider),
        onFileReceived: _handleFileReceived,
      )..start();

      // Set up pair/link request listeners
      _pairRequestHandler = PairRequestHandler(
        connectionManager: _connectionManager!,
        navigatorKey: rootNavigatorKey,
      )..start();

      // Initialize notification service.
      // Timeout guards protect against D-Bus hangs on headless Linux (no
      // notification daemon → flutter_local_notifications_linux blocks on
      // D-Bus call that never returns).
      final notificationService = ref.read(notificationServiceProvider);
      await notificationService.initialize().timeout(
        const Duration(seconds: 10),
        onTimeout: () {
          logger.warning(
              'ZajelApp', 'Notification init timed out (10s) — skipping');
        },
      );
      await notificationService.requestPermission().timeout(
        const Duration(seconds: 5),
        onTimeout: () async {
          logger.warning(
              'ZajelApp', 'Notification permission timed out — skipping');
          return false;
        },
      );

      // Set up notification listeners for messages, files, and peer status
      _notificationListenerService = NotificationListenerService(
        connectionManager: _connectionManager!,
        notificationService: notificationService,
        persistMessage: (peerId, msg) {
          ref.read(chatMessagesProvider(peerId).notifier).addMessage(msg);
        },
        shouldSuppressNotification: (peerId) {
          final inForeground = ref.read(appInForegroundProvider);
          final activeScreen = ref.read(activeScreenProvider);
          return inForeground &&
              activeScreen.type == 'chat' &&
              activeScreen.id == peerId;
        },
        resolvePeerName: (peerId) => _resolvePeerName(peerId),
        getNotificationSettings: () => ref.read(notificationSettingsProvider),
      )..start();

      ref.listenManual(peersProvider, (previous, next) {
        next.whenData((peers) {
          _notificationListenerService?.handlePeersUpdate(peers);
        });
      });

      // Set up VoIP call listener for incoming calls from any screen
      _voipCallHandler = VoipCallHandler(
        navigatorKey: rootNavigatorKey,
        callForegroundService: CallForegroundService(),
        resolvePeerName: _resolvePeerName,
        getNotificationService: () => ref.read(notificationServiceProvider),
        getNotificationSettings: () => ref.read(notificationSettingsProvider),
        getVoipService: () => ref.read(voipServiceProvider),
        getMediaService: () => ref.read(mediaServiceProvider),
      );
      ref.listenManual(voipServiceProvider, (previous, next) {
        _voipCallHandler?.onVoipServiceChanged(next);
      });

      // Start auto-delete cleanup service
      _autoDeleteService = AutoDeleteService(
        getSettings: () => ref.read(autoDeleteSettingsProvider),
        getStorage: () => ref.read(messageStorageProvider),
      )..start();

      // Enable Android FLAG_SECURE if privacy screen is on
      _syncAndroidSecureFlag();

      logger.info('ZajelApp',
          'Core initialization complete (${sw.elapsedMilliseconds}ms)');
    } catch (e, stack) {
      logger.error('ZajelApp', 'Initialization failed — app in degraded state',
          e, stack);
    }

    // Show the home screen immediately — signaling connects in the background.
    // This prevents the app from being stuck on the loading screen if the
    // signaling server is unreachable (WebSocket TCP timeout is ~75 seconds).
    if (mounted) {
      setState(() => _initialized = true);
    }

    // Auto-connect to signaling server (non-blocking).
    // _connectionManager may be null if initialization failed early (e.g.
    // secure storage unavailable on headless CI). Skip signaling in that case.
    if (_connectionManager == null) {
      logger.warning('ZajelApp',
          'Skipping signaling — connection manager not initialized');
      return;
    }
    if (!mounted) return;
    try {
      await _connectToSignaling(_connectionManager!);
      if (!mounted) return;
      logger.info('ZajelApp', 'Signaling connection complete');
    } catch (e, stack) {
      if (!mounted) return;
      logger.error('ZajelApp', 'Signaling connection failed', e, stack);
    }

    // Set up auto-reconnect on disconnect (even if initial connection failed)
    _startSignalingReconnect();
  }

  void _startSignalingReconnect() {
    if (!mounted) return;
    final signalingClient = ref.read(signalingClientProvider);
    if (signalingClient == null) return;

    _signalingReconnectService?.dispose();
    _signalingReconnectService = SignalingReconnectService(
      connect: () => _connectToSignaling(_connectionManager!),
      setConnected: (connected) {
        if (!mounted) return;
        ref.read(signalingConnectedProvider.notifier).state = connected;
      },
      setDisplayState: (state) {
        if (!mounted) return;
        final displayState = switch (state) {
          'connecting' => SignalingDisplayState.connecting,
          'connected' => SignalingDisplayState.connected,
          _ => SignalingDisplayState.disconnected,
        };
        ref.read(signalingDisplayStateProvider.notifier).state = displayState;
      },
    )..start(signalingClient.connectionState);
  }

  Future<void> _connectToSignaling(ConnectionManager connectionManager) async {
    try {
      logger.info('ZajelApp', 'Auto-connecting to signaling server...');
      if (!mounted) return;
      ref.read(signalingDisplayStateProvider.notifier).state =
          SignalingDisplayState.connecting;

      String serverUrl;
      final useDiscovery = !Environment.hasDirectSignalingUrl;

      // If a direct signaling URL is provided (e.g. E2E tests), use it
      // directly and skip server discovery.
      if (!useDiscovery) {
        serverUrl = Environment.signalingUrl;
        logger.info('ZajelApp', 'Using direct signaling URL: $serverUrl');
      } else {
        // Discover and select a VPS server
        final discoveryService = ref.read(serverDiscoveryServiceProvider);
        final selectedServer = await discoveryService.selectServer();
        if (!mounted) return;

        if (selectedServer == null) {
          logger.warning('ZajelApp', 'No servers available from discovery');
          ref.read(signalingDisplayStateProvider.notifier).state =
              SignalingDisplayState.disconnected;
          return;
        }

        // Store the selected server
        ref.read(selectedServerProvider.notifier).state = selectedServer;
        logger.info('ZajelApp',
            'Selected server: ${selectedServer.region} - ${selectedServer.endpoint}');

        // Get the WebSocket URL for the selected server
        serverUrl = discoveryService.getWebSocketUrl(selectedServer);
      }

      logger.debug('ZajelApp', 'Connecting to WebSocket URL: $serverUrl');

      final code = await connectionManager.connect(serverUrl: serverUrl);
      if (!mounted) return;
      logger.info(
          'ZajelApp', 'Connected to signaling with pairing code: $code');
      ref.read(pairingCodeProvider.notifier).state = code;
      ref.read(signalingClientProvider.notifier).state =
          connectionManager.signalingClient;
      ref.read(signalingConnectedProvider.notifier).state = true;
      ref.read(signalingDisplayStateProvider.notifier).state =
          SignalingDisplayState.connected;

      // Connect to all other discovered servers for cross-server rendezvous
      if (useDiscovery) {
        try {
          if (!mounted) return;
          final discoveryService = ref.read(serverDiscoveryServiceProvider);
          final allServers = await discoveryService.fetchServers();
          if (!mounted) return;
          final allUrls = allServers
              .map((s) => discoveryService.getWebSocketUrl(s))
              .toList();
          await connectionManager.connectToAdditionalServers(allUrls);
        } catch (e) {
          logger.warning(
              'ZajelApp', 'Failed to connect to additional servers: $e');
        }
      }

      // Register meeting points for trusted peer reconnection
      if (!mounted) return;
      await connectionManager.reconnectTrustedPeers();
    } catch (e, stack) {
      logger.error('ZajelApp', 'Failed to auto-connect to signaling', e, stack);
      if (mounted) {
        ref.read(signalingDisplayStateProvider.notifier).state =
            SignalingDisplayState.disconnected;
      }
    }
  }

  /// Resolve a peer ID to a display name using aliases and peer list.
  String _resolvePeerName(String peerId) {
    String name = peerId;
    final aliases = ref.read(peerAliasesProvider);
    final peersAsync = ref.read(peersProvider);
    peersAsync.whenData((peers) {
      final peer = peers.where((p) => p.id == peerId).firstOrNull;
      if (peer != null) {
        name = resolvePeerDisplayName(peer, alias: aliases[peer.id]);
      }
    });
    return name;
  }

  void _handleFileReceived(
      String peerId, String fileId, String savedPath, FileTransfer transfer) {
    if (_disposed) return;

    // Add received file message to chat
    ref.read(chatMessagesProvider(peerId).notifier).addMessage(
          Message(
            localId: fileId,
            peerId: peerId,
            content: 'Received file: ${transfer.fileName}',
            type: MessageType.file,
            timestamp: DateTime.now(),
            isOutgoing: false,
            status: MessageStatus.delivered,
            attachmentPath: savedPath,
            attachmentName: transfer.fileName,
            attachmentSize: transfer.totalSize,
          ),
        );

    // Show notification after file is confirmed saved to disk
    final notificationService = ref.read(notificationServiceProvider);
    final settings = ref.read(notificationSettingsProvider);
    notificationService.showFileNotification(
      peerId: peerId,
      peerName: _resolvePeerName(peerId),
      fileName: transfer.fileName,
      settings: settings,
    );
  }

  static const _privacyChannel = MethodChannel('com.zajel.zajel/privacy');

  Future<void> _syncAndroidSecureFlag() async {
    if (!Platform.isAndroid && !Platform.isWindows) return;
    // Never set FLAG_SECURE in E2E mode — it blocks Appium screenshots
    if (_isE2eTest) return;
    try {
      final enabled = ref.read(privacyScreenProvider);
      if (enabled) {
        await _privacyChannel.invokeMethod('enableSecureScreen');
      } else {
        await _privacyChannel.invokeMethod('disableSecureScreen');
      }
    } catch (e) {
      logger.warning('ZajelApp', 'Failed to set secure screen flag: $e');
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);

    _autoDeleteService?.dispose();
    _fileTransferListener?.dispose();
    _notificationListenerService?.dispose();
    _signalingReconnectService?.dispose();
    _pairRequestHandler?.dispose();
    _voipCallHandler?.dispose();

    // Dispose native resources if not already done
    if (!_disposed) {
      _disposed = true;
      _disposeServicesSync();
    }

    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_initialized) {
      return const MaterialApp(
        home: Scaffold(
          body: Center(child: CircularProgressIndicator()),
        ),
      );
    }

    final app = MaterialApp.router(
      title: 'Zajel',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ref.watch(themeModeProvider),
      routerConfig: appRouter,
    );

    if (!_showPrivacyScreen) return app;

    // Overlay the app with a privacy screen when backgrounded.
    // Directionality is required because the Stack is above MaterialApp.
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Stack(
        children: [
          app,
          const _PrivacyOverlay(),
        ],
      ),
    );
  }
}

class _PrivacyOverlay extends StatelessWidget {
  const _PrivacyOverlay();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        backgroundColor: const Color(0xFF1A1A2E),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.lock_outline,
                size: 64,
                color: Colors.white.withValues(alpha: 0.7),
              ),
              const SizedBox(height: 16),
              Text(
                'Zajel',
                style: TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                  color: Colors.white.withValues(alpha: 0.8),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
