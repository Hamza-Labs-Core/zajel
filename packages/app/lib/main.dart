import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:toastification/toastification.dart';

import 'app_router.dart';
import 'core/config/environment.dart';
import 'core/logging/logger_service.dart';
import 'core/models/models.dart';
import 'core/providers/app_providers.dart';
import 'core/services/app_initialization_service.dart';
import 'core/services/file_transfer_listener.dart';
import 'core/services/group_invite_handler.dart';
import 'core/services/link_request_handler.dart';
import 'core/services/notification_listener_service.dart';
import 'core/services/pair_request_handler.dart';
import 'core/services/voip_call_handler.dart';
import 'features/channels/providers/channel_providers.dart';
import 'features/updater/providers/auto_update_providers.dart';
import 'features/groups/providers/group_providers.dart';
import 'features/updater/models/update_check_result.dart';
import 'features/updater/models/update_state.dart';
import 'features/updater/services/update_rollback_service.dart';
import 'features/updater/services/updater_launcher.dart';
import 'shared/theme/app_theme.dart';

const bool _isE2eTest = bool.fromEnvironment('E2E_TEST');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Guard: E2E_TEST must never leak into production release builds
  Environment.assertNoE2eTestInRelease();

  if (_isE2eTest) {
    SemanticsBinding.instance.ensureSemantics();
  }

  // Initialize sqflite FFI for desktop platforms (Windows, Linux, macOS).
  // On Android/iOS sqflite uses native platform channels and doesn't need this.
  if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
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

  // Desktop auto-updater: check for pending rollback before starting UI
  if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
    try {
      final launcher = UpdaterLauncher();
      final rollbackAction = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      if (rollbackAction == RollbackAction.rollback ||
          rollbackAction == RollbackAction.powerLossRecovery) {
        logger.warning('Main', 'Triggering rollback: $rollbackAction');
        final launched = await launcher.launchRollback();
        if (launched) {
          exit(0);
        }
        // If rollback launch failed, fall through to normal startup
        logger.error(
            'Main', 'Rollback launch failed — continuing normal startup');
      }
    } catch (e, stack) {
      logger.error('Main', 'Rollback check failed — continuing normal startup',
          e, stack);
    }
  }

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
  String? _initError;

  late final AppInitializationService _initService;
  late final FileTransferListener _fileTransferListener;
  late final PairRequestHandler _pairRequestHandler;
  late final LinkRequestHandler _linkRequestHandler;
  late final GroupInviteHandler _groupInviteHandler;
  late final NotificationListenerService _notificationListener;
  late final VoipCallHandler _voipCallHandler;
  void Function()? _cancelSignalingReconnect;
  ProviderSubscription? _peerStatusSubscription;
  ProviderSubscription? _voipSubscription;
  ProviderSubscription? _updateStateSubscription;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _buildServices();
    _initialize();

    // Register keyboard handler for idle detection on desktop
    if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
      HardwareKeyboard.instance.addHandler(_onKeyEventForIdleDetector);
    }
  }

  bool _onKeyEventForIdleDetector(KeyEvent event) {
    ref.read(idleDetectorProvider).onUserActivity();
    return false; // Don't consume the event
  }

  void _buildServices() {
    _initService = AppInitializationService(
      initializeSecureStorage: () =>
          ref.read(cachedSecureStorageProvider).initialize(),
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
      selectServerCandidates: () =>
          ref.read(serverDiscoveryServiceProvider).selectServerCandidates(),
      getWebSocketUrl: (server) =>
          ref.read(serverDiscoveryServiceProvider).getWebSocketUrl(server),
      recordConnectionFailure: (endpoint) =>
          ref.read(serverSkipListProvider).add(endpoint),
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

    final invitationService = ref.read(groupInvitationServiceProvider);
    _groupInviteHandler = GroupInviteHandler(
      pendingInvites: invitationService.pendingInvites,
      acceptInvitation: invitationService.acceptInvitation,
      declineInvitation: invitationService.declineInvitation,
      getContext: () => rootNavigatorKey.currentContext,
      notifyInvite: (invite) async {
        final settings = ref.read(notificationSettingsProvider);
        await ref.read(notificationServiceProvider).showGroupInviteNotification(
              inviteId: invite.groupId,
              groupName: invite.groupName,
              inviterPeerId: invite.fromPeerId,
              settings: settings,
            );
      },
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
    if (peersAsync case AsyncData(:final value)) {
      final peer = value.where((p) => p.id == peerId).firstOrNull;
      if (peer != null) peerName = peer.displayName;
    }
    return peerName;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Clean up native resources when app is detached (closing)
    if (state == AppLifecycleState.detached && !_disposed) {
      _disposed = true;
      _disposeServicesSync();
    }

    if (!mounted) return;

    // The integration_test binding (Linux E2E Shelf-server flow) re-emits
    // platform lifecycle messages during pump-cycles, sometimes after the
    // root element has entered the deactivated lifecycle stage but before
    // dispose() runs — `mounted` is still true at that point but
    // `ref.read` performs an InheritedWidget ancestor lookup that asserts
    // the element is *active*, raising "Looking up a deactivated widget's
    // ancestor is unsafe." That assertion (in debug builds, which
    // integration_test uses) aborts the pump loop, the widget tree never
    // progresses past the loading screen, and every Shelf UI-finding test
    // times out. Catch the assertion and treat it as a no-op: there's no
    // observable state to update if the element is already on its way
    // out.
    try {
      ref.read(appInForegroundProvider.notifier).state =
          state == AppLifecycleState.resumed;

      // Privacy screen: obscure app content when backgrounded.
      // On mobile: inactive/paused when backgrounded or in task switcher.
      // On desktop: hidden when minimized, inactive when losing focus.
      final privacyEnabled = ref.read(privacyScreenProvider);
      if (privacyEnabled) {
        if (state == AppLifecycleState.inactive ||
            state == AppLifecycleState.paused ||
            state == AppLifecycleState.hidden) {
          if (!_showPrivacyScreen) {
            setState(() => _showPrivacyScreen = true);
          }
        } else if (state == AppLifecycleState.resumed) {
          if (_showPrivacyScreen) {
            setState(() => _showPrivacyScreen = false);
          }
        }
      }
    } on FlutterError catch (e) {
      // Swallow ancestor-lookup-on-deactivated-element assertions only;
      // any other framework error should still surface.
      if (!e.message.contains('deactivated widget')) rethrow;
      logger.warning(
          'ZajelApp', 'Skipping lifecycle state update on deactivated element');
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
    final coreOk = await _initService.initializeCore();
    if (!coreOk) {
      // DB or crypto failed — app cannot function without core services.
      if (mounted) {
        setState(() => _initError = 'Failed to initialize app. '
            'Please restart or reinstall.');
      }
      return;
    }

    // Desktop auto-updater: mark update as verified after successful core init
    if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
      try {
        final prefs = ref.read(sharedPreferencesProvider);
        final launcher = UpdaterLauncher();
        await UpdateRollbackService.markVerified(
          prefs: prefs,
          launcher: launcher,
        );
      } catch (e) {
        logger.warning('ZajelApp', 'Update verification check failed: $e');
      }
    }

    _fileTransferListener.listen();
    _pairRequestHandler.listen();
    _linkRequestHandler.listen();
    _groupInviteHandler.listen();
    _notificationListener.listen();

    // Eagerly start channel sync so chunk_announce/chunk_data messages
    // are processed from app startup.
    ref.read(channelSyncServiceProvider);
    ref.read(backgroundSyncServiceProvider);

    // Eagerly start diagnostics service (heartbeats + error reports).
    // The provider handles start/stop based on user opt-in preference.
    ref.read(diagnosticsServiceProvider);

    // Eagerly start log upload service (deduped log streaming to diagnostics-cf).
    // Also gated on the same diagnostics opt-in preference.
    ref.read(logUploadServiceProvider);

    _setupPeerStatusNotifications();
    _setupVoipCallListener();
    unawaited(_syncAndroidSecureFlag());

    if (mounted) {
      setState(() => _initialized = true);
    }

    // Desktop: check for rollback notification after UI is ready
    if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
      _checkRollbackNotification();
    }

    try {
      await _initService.connectSignaling();
      logger.info('ZajelApp', 'Signaling connection complete');
    } catch (e, stack) {
      logger.error('ZajelApp', 'Signaling connection failed', e, stack);
    }

    _cancelSignalingReconnect = _initService.setupSignalingReconnect(
      isDisposed: () => _disposed,
    );

    // Desktop: wire auto-update service and background update check
    if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
      _setupAutoUpdateService();
      unawaited(_startBackgroundUpdateCheck());
    }
  }

  void _setupPeerStatusNotifications() {
    final notificationService = ref.read(notificationServiceProvider);
    final knownStates = <String, PeerConnectionState>{};

    _peerStatusSubscription = ref.listenManual(peersProvider, (previous, next) {
      if (next case AsyncData(:final value)) {
        for (final peer in value) {
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
      }
    });
  }

  void _setupVoipCallListener() {
    _voipSubscription = ref.listenManual(voipServiceProvider, (previous, next) {
      _voipCallHandler.subscribeToService(next);
    });
  }

  void _setupAutoUpdateService() {
    // Eagerly create the auto-update service
    final autoUpdateService = ref.read(autoUpdateServiceProvider);

    // Listen to update state changes to drive the auto-update service
    _updateStateSubscription =
        ref.listenManual(updateStateProvider, (previous, next) {
      if (next.status == UpdateStatus.ready) {
        autoUpdateService.onUpdateReady();
      } else {
        autoUpdateService.onUpdateNotReady();
      }
    });

    // Listen to auto-install preference changes
    ref.listenManual(autoInstallUpdatesProvider, (previous, next) {
      autoUpdateService.setEnabled(next);
    });
  }

  Future<void> _startBackgroundUpdateCheck() async {
    try {
      final supportsAutoUpdate = ref.read(supportsAutoUpdateProvider);
      final backgroundEnabled = ref.read(backgroundDownloadEnabledProvider);
      if (!supportsAutoUpdate || !backgroundEnabled) return;

      final releaseService = ref.read(githubReleaseServiceProvider);
      final result = await releaseService.checkForUpdate(Environment.version);
      if (result is! UpdateCheckAvailable) return;

      final release = releaseService.cachedRelease;
      if (release == null) return;

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

      logger.info('ZajelApp', 'Background update check complete');
    } catch (e) {
      logger.warning('ZajelApp', 'Background update check failed: $e');
    }
  }

  void _checkRollbackNotification() {
    final launcher = UpdaterLauncher();
    final result = UpdateRollbackService.getRollbackResult(launcher: launcher);
    if (result == null) return;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = rootNavigatorKey.currentContext;
      if (ctx == null) return;
      final messenger = ScaffoldMessenger.maybeOf(ctx);
      if (messenger == null) return;

      final wasInterrupted = result.status == 'interrupted_recovery';
      // Intentionally not migrated — special pump-callback path
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            wasInterrupted
                ? 'An interrupted update was detected and rolled back to '
                    'version ${result.previousVersion}.'
                : 'Update to version ${result.targetVersion} was rolled back '
                    'to version ${result.previousVersion}.',
          ),
          duration: const Duration(seconds: 8),
          action: SnackBarAction(
            label: 'Dismiss',
            onPressed: () {},
          ),
        ),
      );

      UpdateRollbackService.clearRollbackFlag(launcher: launcher);
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

    if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
      HardwareKeyboard.instance.removeHandler(_onKeyEventForIdleDetector);
    }

    _fileTransferListener.dispose();
    _pairRequestHandler.dispose();
    _linkRequestHandler.dispose();
    _groupInviteHandler.dispose();
    _notificationListener.dispose();
    _voipCallHandler.dispose();
    _cancelSignalingReconnect?.call();
    _peerStatusSubscription?.close();
    _voipSubscription?.close();
    _updateStateSubscription?.close();

    if (!_disposed) {
      _disposed = true;
      _disposeServicesSync();
    }

    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_initError != null) {
      return MaterialApp(
        home: Scaffold(
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.error_outline, size: 64, color: Colors.red),
                  const SizedBox(height: 16),
                  Text(
                    _initError!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 16),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }

    if (!_initialized) {
      return const MaterialApp(
        home: Scaffold(
          body: Center(child: CircularProgressIndicator()),
        ),
      );
    }

    final materialApp = MaterialApp.router(
      title: 'Zajel',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ref.watch(themeModeProvider),
      routerConfig: appRouter,
      // ToastificationWrapper hosts the Overlay that toastification.show
      // pushes into. Wrapping inside MaterialApp.router via `builder` makes
      // the wrapper a descendant of the Navigator so toasts render above
      // routed pages.
      builder: (context, child) =>
          ToastificationWrapper(child: child ?? const SizedBox.shrink()),
    );

    // Wrap with Listener on desktop to feed pointer events to IdleDetector
    final app = (Platform.isWindows || Platform.isLinux || Platform.isMacOS)
        ? Listener(
            onPointerDown: (_) =>
                ref.read(idleDetectorProvider).onUserActivity(),
            onPointerMove: (_) =>
                ref.read(idleDetectorProvider).onUserActivity(),
            child: materialApp,
          )
        : materialApp;

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
