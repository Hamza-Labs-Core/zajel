import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import 'app_router.dart';
import 'core/config/environment.dart';
import 'core/logging/logger_service.dart';
import 'core/media/media_service.dart';
import 'core/models/models.dart';
import 'core/network/signaling_client.dart' show SignalingConnectionState;
import 'core/network/voip_service.dart';
import 'core/notifications/call_foreground_service.dart';
import 'core/providers/app_providers.dart';
import 'features/call/call_screen.dart';
import 'features/call/incoming_call_dialog.dart';
import 'features/channels/providers/channel_providers.dart';
import 'features/groups/providers/group_providers.dart';
import 'shared/theme/app_theme.dart';

const bool _isE2eTest = bool.fromEnvironment('E2E_TEST');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Force semantics tree so UiAutomator2/AT-SPI/UIA can see widgets in E2E tests
  if (_isE2eTest) {
    SemanticsBinding.instance.ensureSemantics();
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
  StreamSubscription? _fileStartSubscription;
  StreamSubscription? _fileChunkSubscription;
  StreamSubscription? _fileCompleteSubscription;
  StreamSubscription<(String, String, String?)>? _pairRequestSubscription;
  StreamSubscription<(String, String, String)>? _linkRequestSubscription;
  StreamSubscription<CallState>? _voipCallStateSubscription;
  bool _disposed = false;
  bool _isIncomingCallDialogOpen = false;
  bool _isReconnecting = false;
  final _callForegroundService = CallForegroundService();

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
  }

  void _disposeServicesSync() {
    logger.info('ZajelApp', 'Disposing services...');
    try {
      final connectionManager = ref.read(connectionManagerProvider);
      // Fire and forget - we're shutting down anyway
      connectionManager.dispose();
      logger.info('ZajelApp', 'Services disposed');
    } catch (e) {
      logger.error('ZajelApp', 'Error during shutdown', e);
    }
    // Dispose logger last
    logger.dispose();
  }

  Future<void> _initialize() async {
    try {
      logger.info('ZajelApp', 'Initializing crypto service...');
      final cryptoService = ref.read(cryptoServiceProvider);
      await cryptoService.initialize();

      logger.info('ZajelApp', 'Initializing message storage...');
      final messageStorage = ref.read(messageStorageProvider);
      await messageStorage.initialize();

      // Auto-delete old messages on startup if the setting is enabled
      if (ref.read(autoDeleteMessagesProvider)) {
        final cutoff = DateTime.now().subtract(const Duration(hours: 24));
        final deleted = await messageStorage.deleteMessagesOlderThan(cutoff);
        if (deleted > 0) {
          logger.info(
              'ZajelApp', 'Auto-deleted $deleted messages older than 24h');
        }
      }

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

      logger.info('ZajelApp', 'Initializing connection manager...');
      final connectionManager = ref.read(connectionManagerProvider);
      await connectionManager.initialize();

      logger.info('ZajelApp', 'Initializing device link service...');
      final deviceLinkService = ref.read(deviceLinkServiceProvider);
      await deviceLinkService.initialize();

      // Set up file transfer listeners
      _setupFileTransferListeners();

      // Set up pair request listener for incoming connection requests
      _setupPairRequestListener();

      // Set up link request listener for incoming web client link requests
      _setupLinkRequestListener();

      // Initialize notification service
      final notificationService = ref.read(notificationServiceProvider);
      await notificationService.initialize();
      await notificationService.requestPermission();

      // Set up notification listeners for messages, files, and peer status
      _setupNotificationListeners();
      _setupPeerStatusNotifications();

      // Set up VoIP call listener for incoming calls from any screen
      _setupVoipCallListener();

      logger.info('ZajelApp', 'Core initialization complete');
    } catch (e, stack) {
      logger.error('ZajelApp', 'Initialization failed', e, stack);
    }

    // Show the home screen immediately — signaling connects in the background.
    // This prevents the app from being stuck on the loading screen if the
    // signaling server is unreachable (WebSocket TCP timeout is ~75 seconds).
    if (mounted) {
      setState(() => _initialized = true);
    }

    // Auto-connect to signaling server (non-blocking)
    try {
      final connectionManager = ref.read(connectionManagerProvider);
      await _connectToSignaling(connectionManager);
      logger.info('ZajelApp', 'Signaling connection complete');

      // Set up auto-reconnect on disconnect
      _setupSignalingReconnect(connectionManager);
    } catch (e, stack) {
      logger.error('ZajelApp', 'Signaling connection failed', e, stack);
      // Even on initial failure, try to reconnect
      final connectionManager = ref.read(connectionManagerProvider);
      _setupSignalingReconnect(connectionManager);
    }
  }

  void _setupSignalingReconnect(dynamic connectionManager) {
    final signalingClient = ref.read(signalingClientProvider);
    if (signalingClient == null) return;

    signalingClient.connectionState.listen((state) async {
      if (state == SignalingConnectionState.disconnected ||
          state == SignalingConnectionState.failed) {
        ref.read(signalingConnectedProvider.notifier).state = false;
        ref.read(signalingDisplayStateProvider.notifier).state =
            SignalingDisplayState.disconnected;

        if (_isReconnecting || _disposed) return;
        _isReconnecting = true;

        // Exponential backoff: 3s, 6s, 12s, 24s, 48s (capped at 60s)
        var delay = const Duration(seconds: 3);
        const maxDelay = Duration(seconds: 60);
        const maxRetries = 5;

        for (var attempt = 1; attempt <= maxRetries; attempt++) {
          if (_disposed) break;
          logger.info('ZajelApp',
              'Signaling reconnect attempt $attempt/$maxRetries in ${delay.inSeconds}s');
          ref.read(signalingDisplayStateProvider.notifier).state =
              SignalingDisplayState.connecting;

          await Future<void>.delayed(delay);
          if (_disposed) break;

          try {
            await _connectToSignaling(connectionManager);
            logger.info(
                'ZajelApp', 'Signaling reconnected on attempt $attempt');
            _isReconnecting = false;
            return;
          } catch (e) {
            logger.warning('ZajelApp', 'Reconnect attempt $attempt failed: $e');
          }

          delay = Duration(
            seconds: (delay.inSeconds * 2).clamp(0, maxDelay.inSeconds),
          );
        }

        logger.error('ZajelApp',
            'Signaling reconnect failed after $maxRetries attempts');
        ref.read(signalingDisplayStateProvider.notifier).state =
            SignalingDisplayState.disconnected;
        _isReconnecting = false;
      }
    });
  }

  Future<void> _connectToSignaling(dynamic connectionManager) async {
    try {
      logger.info('ZajelApp', 'Auto-connecting to signaling server...');
      ref.read(signalingDisplayStateProvider.notifier).state =
          SignalingDisplayState.connecting;

      String serverUrl;

      // If a direct signaling URL is provided (e.g. E2E tests), use it
      // directly and skip server discovery.
      if (Environment.hasDirectSignalingUrl) {
        serverUrl = Environment.signalingUrl;
        logger.info('ZajelApp', 'Using direct signaling URL: $serverUrl');
      } else {
        // Discover and select a VPS server
        final discoveryService = ref.read(serverDiscoveryServiceProvider);
        final selectedServer = await discoveryService.selectServer();

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
      logger.info(
          'ZajelApp', 'Connected to signaling with pairing code: $code');
      ref.read(pairingCodeProvider.notifier).state = code;
      ref.read(signalingClientProvider.notifier).state =
          connectionManager.signalingClient;
      ref.read(signalingConnectedProvider.notifier).state = true;
      ref.read(signalingDisplayStateProvider.notifier).state =
          SignalingDisplayState.connected;

      // Register meeting points for trusted peer reconnection
      await connectionManager.reconnectTrustedPeers();
    } catch (e, stack) {
      logger.error('ZajelApp', 'Failed to auto-connect to signaling', e, stack);
      ref.read(signalingDisplayStateProvider.notifier).state =
          SignalingDisplayState.disconnected;
    }
  }

  void _setupFileTransferListeners() {
    final connectionManager = ref.read(connectionManagerProvider);
    final fileReceiveService = ref.read(fileReceiveServiceProvider);

    // Listen for file transfer starts
    _fileStartSubscription = connectionManager.fileStarts.listen((event) {
      final (peerId, fileId, fileName, totalSize, totalChunks) = event;
      fileReceiveService.startTransfer(
        peerId: peerId,
        fileId: fileId,
        fileName: fileName,
        totalSize: totalSize,
        totalChunks: totalChunks,
      );
    });

    // Listen for file chunks
    _fileChunkSubscription = connectionManager.fileChunks.listen((event) {
      final (_, fileId, chunk, index, _) = event;
      fileReceiveService.addChunk(fileId, index, chunk);
    });

    // Listen for file transfer completions
    _fileCompleteSubscription =
        connectionManager.fileCompletes.listen((event) async {
      final (peerId, fileId) = event;
      final savedPath = await fileReceiveService.completeTransfer(fileId);

      if (savedPath != null) {
        // Get transfer info for the message
        final transfer = fileReceiveService.getTransfer(fileId);
        if (transfer != null) {
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
        }
      }
    });
  }

  void _setupPairRequestListener() {
    final connectionManager = ref.read(connectionManagerProvider);

    _pairRequestSubscription = connectionManager.pairRequests.listen((event) {
      final (fromCode, fromPublicKey, proposedName) = event;
      logger.info('ZajelApp', 'Showing pair request dialog for $fromCode');
      _showPairRequestDialog(fromCode, fromPublicKey,
          proposedName: proposedName);
    });
  }

  Future<void> _showPairRequestDialog(String fromCode, String fromPublicKey,
      {String? proposedName}) async {
    final context = rootNavigatorKey.currentContext;
    if (context == null) {
      logger.warning(
          'ZajelApp', 'No context available to show pair request dialog');
      return;
    }

    final accepted = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.person_add, color: Colors.blue),
            SizedBox(width: 8),
            Text('Connection Request'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (proposedName != null)
              Text('$proposedName (code: $fromCode) wants to connect.')
            else
              Text('Device with code $fromCode wants to connect.'),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Device Code',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  Text(
                    fromCode,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.orange.shade200),
              ),
              child: const Row(
                children: [
                  Icon(Icons.warning_amber, color: Colors.orange, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Only accept if you know this device.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Decline'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Accept'),
          ),
        ],
      ),
    );

    // Respond to the pair request
    final connectionManager = ref.read(connectionManagerProvider);
    connectionManager.respondToPairRequest(fromCode, accept: accepted == true);

    if (accepted == true) {
      logger.info('ZajelApp', 'Pair request from $fromCode accepted');
    } else {
      logger.info('ZajelApp', 'Pair request from $fromCode declined');
    }
  }

  void _setupLinkRequestListener() {
    final connectionManager = ref.read(connectionManagerProvider);

    _linkRequestSubscription = connectionManager.linkRequests.listen((event) {
      final (linkCode, publicKey, deviceName) = event;
      logger.info('ZajelApp',
          'Showing link request dialog for $linkCode from $deviceName');
      _showLinkRequestDialog(linkCode, publicKey, deviceName);
    });
  }

  Future<void> _showLinkRequestDialog(
    String linkCode,
    String publicKey,
    String deviceName,
  ) async {
    final context = rootNavigatorKey.currentContext;
    if (context == null) {
      logger.warning(
          'ZajelApp', 'No context available to show link request dialog');
      return;
    }

    // Generate fingerprint for verification (first 32 chars, grouped by 4)
    final truncated =
        publicKey.length > 32 ? publicKey.substring(0, 32) : publicKey;
    final fingerprint = truncated
        .replaceAllMapped(
          RegExp(r'.{4}'),
          (match) => '${match.group(0)} ',
        )
        .trim();

    final approved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.computer, color: Colors.blue),
            SizedBox(width: 8),
            Text('Link Request'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('$deviceName wants to link with this device.'),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Link Code',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  Text(
                    linkCode,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Key Fingerprint',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  Text(
                    fingerprint,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 10,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.orange.shade200),
              ),
              child: const Row(
                children: [
                  Icon(Icons.warning_amber, color: Colors.orange, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Only approve if you initiated this link request.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Reject'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Approve'),
          ),
        ],
      ),
    );

    // Respond to the link request
    final connectionManager = ref.read(connectionManagerProvider);
    connectionManager.respondToLinkRequest(
      linkCode,
      accept: approved == true,
      deviceId: approved == true ? 'link_$linkCode' : null,
    );

    if (approved == true) {
      logger.info('ZajelApp', 'Link request from $deviceName approved');
    } else {
      logger.info('ZajelApp', 'Link request from $deviceName rejected');
    }
  }

  void _setupNotificationListeners() {
    final connectionManager = ref.read(connectionManagerProvider);
    final notificationService = ref.read(notificationServiceProvider);

    // Global message listener: persist to DB immediately, then notify
    connectionManager.messages.listen((event) {
      final (peerId, message) = event;

      // Persist incoming message to DB immediately (prevents message drops)
      final msg = Message(
        localId: const Uuid().v4(),
        peerId: peerId,
        content: message,
        timestamp: DateTime.now(),
        isOutgoing: false,
        status: MessageStatus.delivered,
      );
      ref.read(chatMessagesProvider(peerId).notifier).addMessage(msg);

      // Show notification
      final settings = ref.read(notificationSettingsProvider);
      String peerName = peerId;
      final peersAsync = ref.read(peersProvider);
      peersAsync.whenData((peers) {
        final peer = peers.where((p) => p.id == peerId).firstOrNull;
        if (peer != null) peerName = peer.displayName;
      });

      notificationService.showMessageNotification(
        peerId: peerId,
        peerName: peerName,
        content: message,
        settings: settings,
      );
    });

    // Notify on file received
    connectionManager.fileCompletes.listen((event) {
      final (peerId, fileId) = event;
      final settings = ref.read(notificationSettingsProvider);
      final fileReceiveService = ref.read(fileReceiveServiceProvider);
      final transfer = fileReceiveService.getTransfer(fileId);

      String peerName = peerId;
      final peersAsync = ref.read(peersProvider);
      peersAsync.whenData((peers) {
        final peer = peers.where((p) => p.id == peerId).firstOrNull;
        if (peer != null) peerName = peer.displayName;
      });

      notificationService.showFileNotification(
        peerId: peerId,
        peerName: peerName,
        fileName: transfer?.fileName ?? 'File',
        settings: settings,
      );
    });
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

          // Only notify on transitions, not on initial load
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
    // Listen for VoIP service changes (becomes available after signaling connects)
    // We use ref.listen to reactively subscribe when voipService becomes available
    ref.listenManual(voipServiceProvider, (previous, next) {
      // Cancel previous subscription if voipService changed
      _voipCallStateSubscription?.cancel();
      _voipCallStateSubscription = null;

      if (next != null) {
        _voipCallStateSubscription = next.onStateChange.listen((state) {
          if (state == CallState.incoming) {
            logger.info('ZajelApp', 'Incoming call detected, showing dialog');
            _showIncomingCallDialog();
            // Show call notification
            final call = next.currentCall;
            if (call != null) {
              final settings = ref.read(notificationSettingsProvider);
              String callerName = call.peerId;
              final peersAsync = ref.read(peersProvider);
              peersAsync.whenData((peers) {
                final peer =
                    peers.where((p) => p.id == call.peerId).firstOrNull;
                if (peer != null) callerName = peer.displayName;
              });
              final notificationService = ref.read(notificationServiceProvider);
              notificationService.showCallNotification(
                peerId: call.peerId,
                peerName: callerName,
                withVideo: call.withVideo,
                settings: settings,
              );
            }
          } else if (_isIncomingCallDialogOpen &&
              (state == CallState.ended ||
                  state == CallState.connecting ||
                  state == CallState.idle)) {
            _dismissIncomingCallDialog();
          }

          // Manage call foreground service
          if (state == CallState.connected) {
            final call = next.currentCall;
            if (call != null) {
              _callForegroundService.start(
                peerName: call.peerId,
                withVideo: call.withVideo,
              );
            }
          } else if (state == CallState.ended || state == CallState.idle) {
            _callForegroundService.stop();
          }
        });
      }
    });
  }

  void _dismissIncomingCallDialog() {
    if (!_isIncomingCallDialogOpen) return;
    final context = rootNavigatorKey.currentContext;
    if (context != null) {
      Navigator.of(context).pop();
    }
    _isIncomingCallDialogOpen = false;
  }

  void _showIncomingCallDialog() {
    final context = rootNavigatorKey.currentContext;
    if (context == null) {
      logger.warning(
          'ZajelApp', 'No context available to show incoming call dialog');
      return;
    }

    final voipService = ref.read(voipServiceProvider);
    final mediaService = ref.read(mediaServiceProvider);

    if (voipService == null || voipService.currentCall == null) {
      logger.warning('ZajelApp', 'VoIP service or current call is null');
      return;
    }

    final call = voipService.currentCall!;

    // Try to get caller name from peers list
    final peersAsync = ref.read(peersProvider);
    String callerName = call.peerId;
    peersAsync.whenData((peers) {
      final peer = peers.where((p) => p.id == call.peerId).firstOrNull;
      if (peer != null) {
        callerName = peer.displayName;
      }
    });

    _isIncomingCallDialogOpen = true;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => IncomingCallDialog(
        callerName: callerName,
        callId: call.callId,
        withVideo: call.withVideo,
        onAccept: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.acceptCall(call.callId, false);
          _navigateToCallScreen(voipService, mediaService, callerName,
              withVideo: false);
        },
        onAcceptWithVideo: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.acceptCall(call.callId, true);
          _navigateToCallScreen(voipService, mediaService, callerName,
              withVideo: true);
        },
        onReject: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.rejectCall(call.callId);
        },
      ),
    );
  }

  void _navigateToCallScreen(
    VoIPService voipService,
    MediaService mediaService,
    String peerName, {
    bool withVideo = false,
  }) {
    final context = rootNavigatorKey.currentContext;
    if (context == null) {
      logger.warning(
          'ZajelApp', 'No context available to navigate to call screen');
      return;
    }

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CallScreen(
          voipService: voipService,
          mediaService: mediaService,
          peerName: peerName,
          initialVideoOn: withVideo,
        ),
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);

    _fileStartSubscription?.cancel();
    _fileChunkSubscription?.cancel();
    _fileCompleteSubscription?.cancel();
    _pairRequestSubscription?.cancel();
    _linkRequestSubscription?.cancel();
    _voipCallStateSubscription?.cancel();

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

    return MaterialApp.router(
      title: 'Zajel',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ref.watch(themeModeProvider),
      routerConfig: appRouter,
    );
  }
}
