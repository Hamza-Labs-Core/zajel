import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app_router.dart';
import 'core/logging/logger_service.dart';
import 'core/models/models.dart';
import 'core/providers/app_providers.dart';
import 'shared/theme/app_theme.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

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
      final serverUrl = discoveryService.getWebSocketUrl(selectedServer);
      logger.debug('ZajelApp', 'Connecting to WebSocket URL: $serverUrl');

      final code = await connectionManager.connect(serverUrl: serverUrl);
      logger.info('ZajelApp', 'Connected to signaling with pairing code: $code');
      ref.read(pairingCodeProvider.notifier).state = code;
      ref.read(signalingConnectedProvider.notifier).state = true;
      ref.read(signalingDisplayStateProvider.notifier).state =
          SignalingDisplayState.connected;
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

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);

    _fileStartSubscription?.cancel();
    _fileChunkSubscription?.cancel();
    _fileCompleteSubscription?.cancel();

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
