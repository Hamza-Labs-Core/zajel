import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app_router.dart';
import 'core/config/environment.dart';
import 'core/logging/logger_service.dart';
import 'core/models/models.dart';
import 'core/providers/app_providers.dart';
import 'shared/theme/app_theme.dart';

const bool _isE2eTest = bool.fromEnvironment('E2E_TEST');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Force semantics tree so UiAutomator2 can see Flutter widgets in E2E tests
  if (_isE2eTest) {
    SemanticsBinding.instance.ensureSemantics();
  }

  // Initialize logger first
  await logger.initialize();
  logger.info('Main', 'App starting...');

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

class _ZajelAppState extends ConsumerState<ZajelApp> with WidgetsBindingObserver {
  bool _initialized = false;
  StreamSubscription? _fileStartSubscription;
  StreamSubscription? _fileChunkSubscription;
  StreamSubscription? _fileCompleteSubscription;
  StreamSubscription<(String, String)>? _pairRequestSubscription;
  bool _disposed = false;

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

      logger.info('ZajelApp', 'Initializing connection manager...');
      final connectionManager = ref.read(connectionManagerProvider);
      await connectionManager.initialize();

      // Set up file transfer listeners
      _setupFileTransferListeners();

      // Set up pair request listener for incoming connection requests
      _setupPairRequestListener();

      // Auto-connect to signaling server
      await _connectToSignaling(connectionManager);

      logger.info('ZajelApp', 'Initialization complete');
    } catch (e, stack) {
      logger.error('ZajelApp', 'Initialization failed', e, stack);
    }

    if (mounted) {
      setState(() => _initialized = true);
    }
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
        logger.info(
            'ZajelApp', 'Selected server: ${selectedServer.region} - ${selectedServer.endpoint}');

        // Get the WebSocket URL for the selected server
        serverUrl = discoveryService.getWebSocketUrl(selectedServer);
      }

      logger.debug('ZajelApp', 'Connecting to WebSocket URL: $serverUrl');

      final code = await connectionManager.connect(serverUrl: serverUrl);
      logger.info('ZajelApp', 'Connected to signaling with pairing code: $code');
      ref.read(pairingCodeProvider.notifier).state = code;
      ref.read(signalingClientProvider.notifier).state = connectionManager.signalingClient;
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
    _fileCompleteSubscription = connectionManager.fileCompletes.listen((event) async {
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
      final (fromCode, fromPublicKey) = event;
      logger.info('ZajelApp', 'Showing pair request dialog for $fromCode');
      _showPairRequestDialog(fromCode, fromPublicKey);
    });
  }

  Future<void> _showPairRequestDialog(String fromCode, String fromPublicKey) async {
    final context = rootNavigatorKey.currentContext;
    if (context == null) {
      logger.warning('ZajelApp', 'No context available to show pair request dialog');
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

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);

    _fileStartSubscription?.cancel();
    _fileChunkSubscription?.cancel();
    _fileCompleteSubscription?.cancel();
    _pairRequestSubscription?.cancel();

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
      themeMode: ThemeMode.system,
      routerConfig: appRouter,
    );
  }
}
