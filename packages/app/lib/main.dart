import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app_router.dart';
import 'core/config/environment.dart';
import 'core/logging/logger_service.dart';
import 'core/models/models.dart';
import 'core/providers/app_providers.dart';
import 'core/services/app_initialization_service.dart';
import 'core/services/file_transfer_listener.dart';
import 'core/services/link_request_handler.dart';
import 'core/services/notification_listener_service.dart';
import 'core/services/pair_request_handler.dart';
import 'core/services/voip_call_handler.dart';
import 'features/channels/providers/channel_providers.dart';
import 'features/groups/providers/group_providers.dart';
import 'shared/theme/app_theme.dart';

const bool _isE2eTest = bool.fromEnvironment('E2E_TEST');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Guard: E2E_TEST must never leak into production release builds
  Environment.assertNoE2eTestInRelease();

  if (_isE2eTest) {
    SemanticsBinding.instance.ensureSemantics();
  }

  await logger.initialize();
  logger.info('Main', 'App starting on ${Platform.operatingSystem}...');

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
  bool _disposed = false;
  bool _showPrivacyScreen = false;

  late final AppInitializationService _initService;
  late final FileTransferListener _fileTransferListener;
  late final PairRequestHandler _pairRequestHandler;
  late final LinkRequestHandler _linkRequestHandler;
  late final NotificationListenerService _notificationListener;
  late final VoipCallHandler _voipCallHandler;
  StreamSubscription? _signalingReconnectSubscription;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _buildServices();
    _initialize();
  }

  void _buildServices() {
    _initService = AppInitializationService(
      initializeCrypto: () => ref.read(cryptoServiceProvider).initialize(),
      initializeMessageStorage: () =>
          ref.read(messageStorageProvider).initialize(),
      initializeChannelStorage: () =>
          ref.read(channelStorageServiceProvider).initialize(),
      initializeGroupStorage: () =>
          ref.read(groupStorageServiceProvider).initialize(),
      getAllTrustedPeers: () =>
          ref.read(trustedPeersStorageProvider).getAllPeers(),
      setPeerAliases: (aliases) =>
          ref.read(peerAliasesProvider.notifier).state = aliases,
      initializeConnectionManager: () =>
          ref.read(connectionManagerProvider).initialize(),
      initializeDeviceLinkService: () =>
          ref.read(deviceLinkServiceProvider).initialize(),
      initializeNotifications: () =>
          ref.read(notificationServiceProvider).initialize(),
      requestNotificationPermission: () =>
          ref.read(notificationServiceProvider).requestPermission(),
      connectToSignaling: (serverUrl) async {
        final cm = ref.read(connectionManagerProvider);
        final code = await cm.connect(serverUrl: serverUrl);
        return SignalingConnectResult(
          pairingCode: code,
          signalingClient: cm.signalingClient,
        );
      },
      selectServer: () =>
          ref.read(serverDiscoveryServiceProvider).selectServer(),
      getWebSocketUrl: (server) =>
          ref.read(serverDiscoveryServiceProvider).getWebSocketUrl(server),
      reconnectTrustedPeers: () =>
          ref.read(connectionManagerProvider).reconnectTrustedPeers(),
      setPairingCode: (code) =>
          ref.read(pairingCodeProvider.notifier).state = code,
      setSignalingClient: (client) =>
          ref.read(signalingClientProvider.notifier).state = client,
      setSignalingConnected: (connected) =>
          ref.read(signalingConnectedProvider.notifier).state = connected,
      setSelectedServer: (server) =>
          ref.read(selectedServerProvider.notifier).state = server,
      setDisplayStateConnecting: () => ref
          .read(signalingDisplayStateProvider.notifier)
          .state = SignalingDisplayState.connecting,
      setDisplayStateConnected: () => ref
          .read(signalingDisplayStateProvider.notifier)
          .state = SignalingDisplayState.connected,
      setDisplayStateDisconnected: () => ref
          .read(signalingDisplayStateProvider.notifier)
          .state = SignalingDisplayState.disconnected,
      getConnectionStateStream: () =>
          ref.read(signalingClientProvider)?.connectionState,
    );

    final cm = ref.read(connectionManagerProvider);

    _fileTransferListener = FileTransferListener(
      fileStarts: cm.fileStarts,
      fileChunks: cm.fileChunks,
      fileCompletes: cm.fileCompletes,
      startTransfer: ({
        required peerId,
        required fileId,
        required fileName,
        required totalSize,
        required totalChunks,
      }) =>
          ref.read(fileReceiveServiceProvider).startTransfer(
                peerId: peerId,
                fileId: fileId,
                fileName: fileName,
                totalSize: totalSize,
                totalChunks: totalChunks,
              ),
      addChunk: (fileId, index, chunk) =>
          ref.read(fileReceiveServiceProvider).addChunk(fileId, index, chunk),
      completeTransfer: (fileId) =>
          ref.read(fileReceiveServiceProvider).completeTransfer(fileId),
      getTransfer: (fileId) {
        final transfer =
            ref.read(fileReceiveServiceProvider).getTransfer(fileId);
        if (transfer == null) return null;
        return (fileName: transfer.fileName, totalSize: transfer.totalSize);
      },
      addMessage: (peerId, message) =>
          ref.read(chatMessagesProvider(peerId).notifier).addMessage(message),
    );

    _pairRequestHandler = PairRequestHandler(
      pairRequests: cm.pairRequests,
      respondToPairRequest: (code, {required accept}) => ref
          .read(connectionManagerProvider)
          .respondToPairRequest(code, accept: accept),
      getContext: () => rootNavigatorKey.currentContext,
    );

    _linkRequestHandler = LinkRequestHandler(
      linkRequests: cm.linkRequests,
      respondToLinkRequest: (code, {required accept, deviceId}) =>
          ref.read(connectionManagerProvider).respondToLinkRequest(
                code,
                accept: accept,
                deviceId: deviceId,
              ),
      getContext: () => rootNavigatorKey.currentContext,
    );

    _notificationListener = NotificationListenerService(
      messages: cm.peerMessages,
      fileCompletes: cm.fileCompletes,
      addMessage: (peerId, message) =>
          ref.read(chatMessagesProvider(peerId).notifier).addMessage(message),
      resolvePeerName: (peerId) => _resolvePeerName(peerId),
      getNotificationSettings: () => ref.read(notificationSettingsProvider),
      getFileTransfer: (fileId) {
        final t = ref.read(fileReceiveServiceProvider).getTransfer(fileId);
        if (t == null) return null;
        return (fileName: t.fileName);
      },
      showMessageNotification: ({
        required peerId,
        required peerName,
        required content,
        required settings,
      }) =>
          ref.read(notificationServiceProvider).showMessageNotification(
                peerId: peerId,
                peerName: peerName,
                content: content,
                settings: settings,
              ),
      showFileNotification: ({
        required peerId,
        required peerName,
        required fileName,
        required settings,
      }) =>
          ref.read(notificationServiceProvider).showFileNotification(
                peerId: peerId,
                peerName: peerName,
                fileName: fileName,
                settings: settings,
              ),
    );

    _voipCallHandler = VoipCallHandler(
      getContext: () => rootNavigatorKey.currentContext,
      getVoipService: () => ref.read(voipServiceProvider),
      getMediaService: () => ref.read(mediaServiceProvider),
      resolvePeerName: (peerId) => _resolvePeerName(peerId),
      showCallNotification: ({
        required peerId,
        required peerName,
        required withVideo,
      }) {
        final settings = ref.read(notificationSettingsProvider);
        ref.read(notificationServiceProvider).showCallNotification(
              peerId: peerId,
              peerName: peerName,
              withVideo: withVideo,
              settings: settings,
            );
      },
    );
  }

  String _resolvePeerName(String peerId) {
    String peerName = peerId;
    final peersAsync = ref.read(peersProvider);
    peersAsync.whenData((peers) {
      final peer = peers.where((p) => p.id == peerId).firstOrNull;
      if (peer != null) peerName = peer.displayName;
    });
    return peerName;
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
      ref.read(connectionManagerProvider).dispose();
      logger.info('ZajelApp', 'Services disposed');
    } catch (e) {
      logger.error('ZajelApp', 'Error during shutdown', e);
    }
    logger.dispose();
  }

  Future<void> _initialize() async {
    await _initService.initializeCore();

    _fileTransferListener.listen();
    _pairRequestHandler.listen();
    _linkRequestHandler.listen();
    _notificationListener.listen();
    _setupPeerStatusNotifications();
    _setupVoipCallListener();
    _syncAndroidSecureFlag();

    if (mounted) {
      setState(() => _initialized = true);
    }

    try {
      await _initService.connectSignaling();
      logger.info('ZajelApp', 'Signaling connection complete');
    } catch (e, stack) {
      logger.error('ZajelApp', 'Signaling connection failed', e, stack);
    }

    _signalingReconnectSubscription = _initService.setupSignalingReconnect(
      isDisposed: () => _disposed,
    );
  }

  void _setupPeerStatusNotifications() {
    final notificationService = ref.read(notificationServiceProvider);
    final knownStates = <String, PeerConnectionState>{};

    ref.listenManual(peersProvider, (previous, next) {
      next.whenData((peers) {
        for (final peer in peers) {
          final prev = knownStates[peer.id];
          final curr = peer.connectionState;
          knownStates[peer.id] = curr;
          if (prev == null) continue;

          final wasOnline = prev == PeerConnectionState.connected;
          final isOnline = curr == PeerConnectionState.connected;
          if (wasOnline != isOnline) {
            final settings = ref.read(notificationSettingsProvider);
            notificationService.showPeerStatusNotification(
              peerName: peer.displayName,
              connected: isOnline,
              settings: settings,
            );
          }
        }
      });
    });
  }

  void _setupVoipCallListener() {
    ref.listenManual(voipServiceProvider, (previous, next) {
      _voipCallHandler.subscribeToService(next);
    });
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

    _fileTransferListener.dispose();
    _pairRequestHandler.dispose();
    _linkRequestHandler.dispose();
    _notificationListener.dispose();
    _voipCallHandler.dispose();
    _signalingReconnectSubscription?.cancel();

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
