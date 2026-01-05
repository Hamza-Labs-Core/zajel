import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app_router.dart';
import 'core/models/models.dart';
import 'core/providers/app_providers.dart';
import 'shared/theme/app_theme.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

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

class _ZajelAppState extends ConsumerState<ZajelApp> {
  bool _initialized = false;
  StreamSubscription? _fileStartSubscription;
  StreamSubscription? _fileChunkSubscription;
  StreamSubscription? _fileCompleteSubscription;

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  Future<void> _initialize() async {
    try {
      final cryptoService = ref.read(cryptoServiceProvider);
      await cryptoService.initialize();

      final connectionManager = ref.read(connectionManagerProvider);
      await connectionManager.initialize();

      // Set up file transfer listeners
      _setupFileTransferListeners();
    } catch (e, stack) {
      print('Init error: $e\n$stack');
    }

    if (mounted) {
      setState(() => _initialized = true);
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
    _fileStartSubscription?.cancel();
    _fileChunkSubscription?.cancel();
    _fileCompleteSubscription?.cancel();
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
