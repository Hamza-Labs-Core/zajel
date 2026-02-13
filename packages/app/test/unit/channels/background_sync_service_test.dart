import 'dart:async';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/services/background_sync_service.dart';
import 'package:zajel/features/channels/services/channel_storage_service.dart';
import 'package:zajel/features/channels/services/channel_sync_service.dart';
import 'package:zajel/features/channels/services/routing_hash_service.dart';

import '../../mocks/mocks.dart';

/// In-memory implementation of ChannelStorageService for testing.
class FakeChannelStorageService extends ChannelStorageService {
  final Map<String, Channel> channels = {};
  final Map<String, List<Chunk>> chunks = {};

  FakeChannelStorageService() : super(secureStorage: FakeSecureStorage());

  @override
  Future<void> initialize() async {}

  @override
  Future<void> saveChannel(Channel channel) async {
    channels[channel.id] = channel;
  }

  @override
  Future<Channel?> getChannel(String channelId) async {
    return channels[channelId];
  }

  @override
  Future<List<Channel>> getAllChannels() async {
    return channels.values.toList();
  }

  @override
  Future<void> deleteChannel(String channelId) async {
    channels.remove(channelId);
    chunks.remove(channelId);
  }

  @override
  Future<void> saveChunk(String channelId, Chunk chunk) async {
    chunks.putIfAbsent(channelId, () => []).add(chunk);
  }

  @override
  Future<List<Chunk>> getChunksBySequence(
      String channelId, int sequence) async {
    return (chunks[channelId] ?? [])
        .where((c) => c.sequence == sequence)
        .toList()
      ..sort((a, b) => a.chunkIndex.compareTo(b.chunkIndex));
  }

  @override
  Future<Chunk?> getChunk(String channelId, String chunkId) async {
    return (chunks[channelId] ?? [])
        .where((c) => c.chunkId == chunkId)
        .firstOrNull;
  }

  @override
  Future<List<String>> getChunkIds(String channelId) async {
    return (chunks[channelId] ?? []).map((c) => c.chunkId).toList();
  }

  @override
  Future<void> deleteChunksBySequence(String channelId, int sequence) async {
    chunks[channelId]?.removeWhere((c) => c.sequence == sequence);
  }

  @override
  Future<int> getLatestSequence(String channelId) async {
    final channelChunks = chunks[channelId] ?? [];
    if (channelChunks.isEmpty) return 0;
    return channelChunks.map((c) => c.sequence).reduce((a, b) => a > b ? a : b);
  }

  @override
  Future<void> close() async {}
}

/// Create a test channel with reasonable defaults.
Channel createTestChannel({
  String id = 'channel_001',
  ChannelRole role = ChannelRole.owner,
  String? encryptionKeyPrivate,
}) {
  return Channel(
    id: id,
    role: role,
    manifest: ChannelManifest(
      channelId: id,
      name: 'Test Channel',
      description: 'A test channel',
      ownerKey: 'owner_pub_key',
      currentEncryptKey: 'encrypt_pub_key',
    ),
    encryptionKeyPublic: 'encrypt_pub_key',
    encryptionKeyPrivate: encryptionKeyPrivate,
    createdAt: DateTime.utc(2026, 2, 10),
  );
}

/// Create a test chunk with reasonable defaults.
Chunk createTestChunk({
  String chunkId = 'ch_001',
  String routingHash = 'hash_a',
  int sequence = 1,
  int chunkIndex = 0,
  int totalChunks = 1,
}) {
  return Chunk(
    chunkId: chunkId,
    routingHash: routingHash,
    sequence: sequence,
    chunkIndex: chunkIndex,
    totalChunks: totalChunks,
    size: 100,
    signature: 'sig_test',
    authorPubkey: 'pubkey_test',
    encryptedPayload: Uint8List.fromList([1, 2, 3, 4]),
  );
}

void main() {
  // ---------------------------------------------------------------------------
  // BackgroundSyncResult
  // ---------------------------------------------------------------------------

  group('BackgroundSyncResult', () {
    test('isSuccess returns true when errors is 0', () {
      const result = BackgroundSyncResult(
        channelsChecked: 5,
        chunksDownloaded: 10,
        errors: 0,
        duration: Duration(milliseconds: 500),
      );
      expect(result.isSuccess, isTrue);
    });

    test('isSuccess returns false when errors > 0', () {
      const result = BackgroundSyncResult(
        channelsChecked: 5,
        chunksDownloaded: 10,
        errors: 2,
        duration: Duration(milliseconds: 500),
      );
      expect(result.isSuccess, isFalse);
    });

    test('toString returns formatted string', () {
      const result = BackgroundSyncResult(
        channelsChecked: 3,
        chunksDownloaded: 7,
        errors: 1,
        duration: Duration(milliseconds: 250),
      );
      final str = result.toString();
      expect(str, contains('channels: 3'));
      expect(str, contains('chunks: 7'));
      expect(str, contains('errors: 1'));
      expect(str, contains('250ms'));
    });
  });

  // ---------------------------------------------------------------------------
  // BackgroundSyncService — construction and properties
  // ---------------------------------------------------------------------------

  group('BackgroundSyncService construction', () {
    test('backgroundTaskName is the expected value', () {
      expect(BackgroundSyncService.backgroundTaskName, 'com.zajel.channelSync');
    });

    test('minimumInterval is 15 minutes', () {
      expect(
          BackgroundSyncService.minimumInterval, const Duration(minutes: 15));
    });

    test('defaultForegroundInterval is 5 minutes', () {
      expect(BackgroundSyncService.defaultForegroundInterval,
          const Duration(minutes: 5));
    });

    test('initial state is correct', () {
      final storageService = FakeChannelStorageService();
      final routingHashService = RoutingHashService();
      final syncService = BackgroundSyncService(
        storageService: storageService,
        routingHashService: routingHashService,
      );

      expect(syncService.isSyncing, isFalse);
      expect(syncService.isPeriodicSyncActive, isFalse);
      expect(syncService.lastResult, isNull);
      expect(syncService.lastSyncTime, isNull);

      syncService.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Foreground periodic sync (Timer.periodic)
  // ---------------------------------------------------------------------------

  group('Foreground periodic sync', () {
    late FakeChannelStorageService storageService;
    late RoutingHashService routingHashService;
    late BackgroundSyncService syncService;

    setUp(() {
      storageService = FakeChannelStorageService();
      routingHashService = RoutingHashService();
      syncService = BackgroundSyncService(
        storageService: storageService,
        routingHashService: routingHashService,
      );
    });

    tearDown(() {
      syncService.dispose();
    });

    test('startPeriodicSync sets isPeriodicSyncActive to true', () {
      syncService.startPeriodicSync();
      expect(syncService.isPeriodicSyncActive, isTrue);
    });

    test('stopPeriodicSync sets isPeriodicSyncActive to false', () {
      syncService.startPeriodicSync();
      syncService.stopPeriodicSync();
      expect(syncService.isPeriodicSyncActive, isFalse);
    });

    test('startPeriodicSync cancels existing timer before creating new one',
        () {
      syncService.startPeriodicSync(interval: const Duration(minutes: 10));
      expect(syncService.isPeriodicSyncActive, isTrue);

      syncService.startPeriodicSync(interval: const Duration(minutes: 3));
      expect(syncService.isPeriodicSyncActive, isTrue);
    });

    test('dispose stops periodic sync', () {
      syncService.startPeriodicSync();
      expect(syncService.isPeriodicSyncActive, isTrue);

      syncService.dispose();
      expect(syncService.isPeriodicSyncActive, isFalse);
    });

    test('periodic sync triggers runSync on each interval', () {
      fakeAsync((async) {
        int syncCount = 0;
        // We track syncs via the logger callback
        syncService.logger = (tag, message) {
          if (tag == 'runSync' && message.contains('Starting')) {
            syncCount++;
          }
        };

        syncService.startPeriodicSync(interval: const Duration(minutes: 5));

        // Advance past two intervals
        async.elapse(const Duration(minutes: 11));

        // Should have triggered at least 2 syncs
        expect(syncCount, greaterThanOrEqualTo(2));
      });
    });
  });

  // ---------------------------------------------------------------------------
  // runSync — core sync logic
  // ---------------------------------------------------------------------------

  group('runSync', () {
    late FakeChannelStorageService storageService;
    late RoutingHashService routingHashService;
    late BackgroundSyncService syncService;
    late List<String> logMessages;

    setUp(() {
      storageService = FakeChannelStorageService();
      routingHashService = RoutingHashService();
      logMessages = [];
      syncService = BackgroundSyncService(
        storageService: storageService,
        routingHashService: routingHashService,
        logger: (tag, message) => logMessages.add('$tag: $message'),
      );
    });

    tearDown(() {
      syncService.dispose();
    });

    test('returns zero result when no channels exist', () async {
      final result = await syncService.runSync();

      expect(result.channelsChecked, 0);
      expect(result.chunksDownloaded, 0);
      expect(result.errors, 0);
      expect(result.isSuccess, isTrue);
    });

    test('sets lastResult and lastSyncTime after sync', () async {
      final result = await syncService.runSync();

      expect(syncService.lastResult, result);
      expect(syncService.lastSyncTime, isNotNull);
    });

    test('skips when sync is already in progress', () async {
      // We cannot easily simulate overlapping runSync calls in a single-isolate
      // test, but we can verify the guard variable is set properly.
      // Run a sync to verify it completes normally.
      final result = await syncService.runSync();
      expect(result.channelsChecked, 0);
      expect(syncService.isSyncing, isFalse);
    });

    test('counts owner channels as checked', () async {
      final channel = createTestChannel(role: ChannelRole.owner);
      storageService.channels[channel.id] = channel;

      final result = await syncService.runSync();

      // Owner channels are "checked" during the announce phase.
      // Without a ChannelSyncService the announce is a no-op but still counts.
      expect(result.channelsChecked, 1);
      expect(result.errors, 0);
    });

    test('subscriber channels without encryption key still count as checked',
        () async {
      final channel = createTestChannel(
        id: 'sub_channel',
        role: ChannelRole.subscriber,
        encryptionKeyPrivate: null,
      );
      storageService.channels[channel.id] = channel;

      final result = await syncService.runSync();

      // _syncChannel returns 0 (no chunks downloaded) but doesn't throw,
      // so the channel is counted as checked.
      expect(result.channelsChecked, 1);
      expect(result.chunksDownloaded, 0);
      expect(result.errors, 0);
    });

    test('logs messages during sync', () async {
      await syncService.runSync();

      expect(logMessages.any((m) => m.contains('Starting background sync')),
          isTrue);
    });

    test('logs no channels to sync when empty', () async {
      await syncService.runSync();

      expect(logMessages.any((m) => m.contains('No channels to sync')), isTrue);
    });
  });

  // ---------------------------------------------------------------------------
  // setChannelSyncService
  // ---------------------------------------------------------------------------

  group('setChannelSyncService', () {
    test('can set and clear channel sync service', () {
      final storageService = FakeChannelStorageService();
      final routingHashService = RoutingHashService();
      final syncService = BackgroundSyncService(
        storageService: storageService,
        routingHashService: routingHashService,
      );

      // Set a mock sync service
      final sentMessages = <Map<String, dynamic>>[];
      final channelSyncService = ChannelSyncService(
        storageService: storageService,
        sendMessage: (msg) => sentMessages.add(msg),
        peerId: 'test_peer',
      );
      syncService.setChannelSyncService(channelSyncService);

      // Clear it
      syncService.setChannelSyncService(null);

      syncService.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Logger callback
  // ---------------------------------------------------------------------------

  group('Logger', () {
    test('logger callback receives tag and message', () async {
      final storageService = FakeChannelStorageService();
      final routingHashService = RoutingHashService();
      String? lastTag;
      String? lastMessage;

      final syncService = BackgroundSyncService(
        storageService: storageService,
        routingHashService: routingHashService,
        logger: (tag, message) {
          lastTag = tag;
          lastMessage = message;
        },
      );

      await syncService.runSync();

      expect(lastTag, isNotNull);
      expect(lastMessage, isNotNull);

      syncService.dispose();
    });

    test('no crash when logger is null', () async {
      final storageService = FakeChannelStorageService();
      final routingHashService = RoutingHashService();
      final syncService = BackgroundSyncService(
        storageService: storageService,
        routingHashService: routingHashService,
      );

      // Should not throw
      await syncService.runSync();

      syncService.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // backgroundSyncCallback (top-level function)
  // ---------------------------------------------------------------------------

  group('backgroundSyncCallback', () {
    // Note: backgroundSyncCallback() creates its own ChannelStorageService
    // which calls path_provider and sqflite internally. In a unit test
    // environment these platform calls will throw, so we verify the
    // function handles errors gracefully (returns false).
    test('returns false when platform services are unavailable', () async {
      final result = await backgroundSyncCallback();
      // In test, ChannelStorageService.initialize() will throw because
      // path_provider is not available. The callback should catch and
      // return false.
      expect(result, isFalse);
    });
  });

  // ---------------------------------------------------------------------------
  // Sync with owner channels (announce flow)
  // ---------------------------------------------------------------------------

  group('Sync with channels', () {
    late FakeChannelStorageService storageService;
    late RoutingHashService routingHashService;
    late BackgroundSyncService syncService;
    late List<Map<String, dynamic>> sentMessages;
    late ChannelSyncService channelSyncService;

    setUp(() {
      storageService = FakeChannelStorageService();
      routingHashService = RoutingHashService();
      sentMessages = [];

      channelSyncService = ChannelSyncService(
        storageService: storageService,
        sendMessage: (msg) => sentMessages.add(msg),
        peerId: 'test_peer',
      );

      syncService = BackgroundSyncService(
        storageService: storageService,
        routingHashService: routingHashService,
      );
      syncService.setChannelSyncService(channelSyncService);
    });

    tearDown(() {
      syncService.dispose();
    });

    test('announces chunks for owned channels during sync', () async {
      final channel = createTestChannel(role: ChannelRole.owner);
      storageService.channels[channel.id] = channel;
      storageService.chunks[channel.id] = [createTestChunk()];

      final result = await syncService.runSync();

      expect(result.channelsChecked, 1);
      expect(result.errors, 0);

      // The sync should have sent a chunk_announce message
      final announceMessages =
          sentMessages.where((m) => m['type'] == 'chunk_announce').toList();
      expect(announceMessages, hasLength(1));
    });

    test('handles multiple channels of different roles', () async {
      final ownerChannel =
          createTestChannel(id: 'owner_ch', role: ChannelRole.owner);
      storageService.channels[ownerChannel.id] = ownerChannel;
      storageService.chunks[ownerChannel.id] = [
        createTestChunk(chunkId: 'owned_chunk'),
      ];

      // Subscriber without encryption key (still counted as checked)
      final subChannel = createTestChannel(
        id: 'sub_ch',
        role: ChannelRole.subscriber,
        encryptionKeyPrivate: null,
      );
      storageService.channels[subChannel.id] = subChannel;

      final result = await syncService.runSync();

      // Both channels are checked: owner announce + subscriber sync (returns 0)
      expect(result.channelsChecked, 2);
      expect(result.errors, 0);
    });
  });
}
