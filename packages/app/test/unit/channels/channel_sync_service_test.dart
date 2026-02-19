import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:fake_async/fake_async.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/services/channel_sync_service.dart';
import 'package:zajel/features/channels/services/channel_storage_service.dart';

import '../../mocks/mocks.dart';

/// In-memory implementation of ChannelStorageService for testing.
class FakeChannelStorageService extends ChannelStorageService {
  final Map<String, Channel> _channels = {};
  final Map<String, List<Chunk>> _chunks = {};

  FakeChannelStorageService() : super(secureStorage: FakeSecureStorage());

  @override
  Future<void> initialize() async {}

  @override
  Future<void> saveChannel(Channel channel) async {
    _channels[channel.id] = channel;
  }

  @override
  Future<Channel?> getChannel(String channelId) async {
    return _channels[channelId];
  }

  @override
  Future<List<Channel>> getAllChannels() async {
    return _channels.values.toList();
  }

  @override
  Future<void> deleteChannel(String channelId) async {
    _channels.remove(channelId);
    _chunks.remove(channelId);
  }

  @override
  Future<void> saveChunk(String channelId, Chunk chunk) async {
    _chunks.putIfAbsent(channelId, () => []).add(chunk);
  }

  @override
  Future<List<Chunk>> getChunksBySequence(
      String channelId, int sequence) async {
    return (_chunks[channelId] ?? [])
        .where((c) => c.sequence == sequence)
        .toList()
      ..sort((a, b) => a.chunkIndex.compareTo(b.chunkIndex));
  }

  @override
  Future<Chunk?> getChunk(String channelId, String chunkId) async {
    return (_chunks[channelId] ?? [])
        .where((c) => c.chunkId == chunkId)
        .firstOrNull;
  }

  @override
  Future<List<String>> getChunkIds(String channelId) async {
    return (_chunks[channelId] ?? []).map((c) => c.chunkId).toList();
  }

  @override
  Future<void> deleteChunksBySequence(String channelId, int sequence) async {
    _chunks[channelId]?.removeWhere((c) => c.sequence == sequence);
  }

  @override
  Future<int> getLatestSequence(String channelId) async {
    final chunks = _chunks[channelId] ?? [];
    if (chunks.isEmpty) return 0;
    return chunks.map((c) => c.sequence).reduce((a, b) => a > b ? a : b);
  }

  @override
  Future<void> close() async {}
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

/// Create a test channel with reasonable defaults.
Channel createTestChannel({
  String id = 'channel_001',
  ChannelRole role = ChannelRole.owner,
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
    createdAt: DateTime.utc(2026, 2, 10),
  );
}

void main() {
  late FakeChannelStorageService storageService;
  late List<Map<String, dynamic>> sentMessages;
  late StreamController<Map<String, dynamic>> messageController;
  late ChannelSyncService syncService;

  setUp(() {
    storageService = FakeChannelStorageService();
    sentMessages = [];
    messageController = StreamController<Map<String, dynamic>>.broadcast();

    syncService = ChannelSyncService(
      storageService: storageService,
      sendMessage: (msg) => sentMessages.add(msg),
      peerId: 'test_peer',
      syncInterval: const Duration(minutes: 5),
    );
  });

  tearDown(() async {
    await syncService.dispose();
    await messageController.close();
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  group('Lifecycle', () {
    test('isRunning is false initially', () {
      expect(syncService.isRunning, isFalse);
    });

    test('start sets isRunning to true', () {
      syncService.start(messageController.stream);
      expect(syncService.isRunning, isTrue);
    });

    test('stop sets isRunning to false', () async {
      syncService.start(messageController.stream);
      await syncService.stop();
      expect(syncService.isRunning, isFalse);
    });

    test('start is idempotent', () {
      syncService.start(messageController.stream);
      syncService.start(messageController.stream);
      expect(syncService.isRunning, isTrue);
    });

    test('stop clears pending requests and announced chunks', () async {
      syncService.start(messageController.stream);
      syncService.requestChunk('ch_001');
      syncService.announceChunk(createTestChunk());

      expect(syncService.pendingRequests, isNotEmpty);
      expect(syncService.announcedChunks, isNotEmpty);

      await syncService.stop();

      expect(syncService.pendingRequests, isEmpty);
      expect(syncService.announcedChunks, isEmpty);
    });
  });

  // ---------------------------------------------------------------------------
  // Chunk announcement
  // ---------------------------------------------------------------------------

  group('Chunk announcement', () {
    test('announceChunksForChannel sends chunk_announce message', () async {
      final channel = createTestChannel();
      await storageService.saveChannel(channel);

      final chunk = createTestChunk();
      await storageService.saveChunk(channel.id, chunk);

      await syncService.announceChunksForChannel(channel.id);

      expect(sentMessages, hasLength(1));
      final msg = sentMessages.first;
      expect(msg['type'], 'chunk_announce');
      expect(msg['peerId'], 'test_peer');
      expect(msg['chunks'], isA<List>());
      expect((msg['chunks'] as List).first['chunkId'], 'ch_001');
      expect((msg['chunks'] as List).first['routingHash'], 'hash_a');
    });

    test('announceChunksForChannel does nothing for empty channel', () async {
      final channel = createTestChannel();
      await storageService.saveChannel(channel);

      await syncService.announceChunksForChannel(channel.id);

      expect(sentMessages, isEmpty);
    });

    test('announceChunksForChannel tracks announced chunk IDs', () async {
      final channel = createTestChannel();
      await storageService.saveChannel(channel);
      await storageService.saveChunk(channel.id, createTestChunk());

      await syncService.announceChunksForChannel(channel.id);

      expect(syncService.announcedChunks, contains('ch_001'));
    });

    test('syncAllChannels announces chunks for all channels', () async {
      final channel1 = createTestChannel(id: 'ch1');
      final channel2 = createTestChannel(id: 'ch2');
      await storageService.saveChannel(channel1);
      await storageService.saveChannel(channel2);

      await storageService.saveChunk('ch1', createTestChunk(chunkId: 'c1'));
      await storageService.saveChunk('ch2', createTestChunk(chunkId: 'c2'));

      await syncService.syncAllChannels();

      expect(sentMessages, hasLength(2));
    });

    test('announceChunk sends single chunk announce', () {
      final chunk = createTestChunk(chunkId: 'ch_single', routingHash: 'rh_1');
      syncService.announceChunk(chunk);

      expect(sentMessages, hasLength(1));
      final msg = sentMessages.first;
      expect(msg['type'], 'chunk_announce');
      expect((msg['chunks'] as List).first['chunkId'], 'ch_single');
    });
  });

  // ---------------------------------------------------------------------------
  // Chunk requests
  // ---------------------------------------------------------------------------

  group('Chunk requests', () {
    test('requestChunk sends chunk_request message', () {
      syncService.requestChunk('ch_001');

      expect(sentMessages, hasLength(1));
      final msg = sentMessages.first;
      expect(msg['type'], 'chunk_request');
      expect(msg['peerId'], 'test_peer');
      expect(msg['chunkId'], 'ch_001');
    });

    test('requestChunk tracks pending request', () {
      syncService.requestChunk('ch_001');
      expect(syncService.pendingRequests, contains('ch_001'));
    });

    test('requestChunks sends multiple requests', () {
      syncService.requestChunks(['ch_001', 'ch_002', 'ch_003']);

      expect(sentMessages, hasLength(3));
      expect(sentMessages.map((m) => m['chunkId']),
          containsAll(['ch_001', 'ch_002', 'ch_003']));
    });
  });

  // ---------------------------------------------------------------------------
  // Chunk push (responding to server pull requests)
  // ---------------------------------------------------------------------------

  group('Chunk push', () {
    test('pushChunk sends chunk_push message', () async {
      final channel = createTestChannel();
      await storageService.saveChannel(channel);
      await storageService.saveChunk(channel.id, createTestChunk());

      await syncService.pushChunk(channel.id, 'ch_001');

      expect(sentMessages, hasLength(1));
      final msg = sentMessages.first;
      expect(msg['type'], 'chunk_push');
      expect(msg['peerId'], 'test_peer');
      expect(msg['chunkId'], 'ch_001');
      expect(msg['channelId'], 'channel_001');
      expect(msg['data'], isA<Map<String, dynamic>>());
    });

    test('pushChunk does nothing for non-existent chunk', () async {
      await syncService.pushChunk('channel_001', 'nonexistent');
      expect(sentMessages, isEmpty);
    });

    test('findChannelForChunk returns correct channel', () async {
      final channel = createTestChannel();
      await storageService.saveChannel(channel);
      await storageService.saveChunk(channel.id, createTestChunk());

      final found = await syncService.findChannelForChunk('ch_001');
      expect(found, 'channel_001');
    });

    test('findChannelForChunk returns null for unknown chunk', () async {
      final found = await syncService.findChannelForChunk('nonexistent');
      expect(found, isNull);
    });
  });

  // ---------------------------------------------------------------------------
  // Server message handling
  // ---------------------------------------------------------------------------

  group('Server message handling', () {
    setUp(() {
      syncService.start(messageController.stream);
    });

    test('chunk_data message invokes onChunkReceived callback', () async {
      String? receivedChunkId;
      Map<String, dynamic>? receivedData;

      syncService.onChunkReceived = (chunkId, data) {
        receivedChunkId = chunkId;
        receivedData = data;
      };

      syncService.requestChunk('ch_001'); // Mark as pending

      messageController.add({
        'type': 'chunk_data',
        'chunkId': 'ch_001',
        'data': {'chunk_id': 'ch_001', 'payload': 'test'},
        'source': 'cache',
      });

      // Allow the stream event to propagate
      await Future<void>.delayed(Duration.zero);

      expect(receivedChunkId, 'ch_001');
      expect(receivedData, isNotNull);
      expect(receivedData!['chunk_id'], 'ch_001');
    });

    test('chunk_data removes from pending requests', () async {
      syncService.onChunkReceived = (_, __) {};
      syncService.requestChunk('ch_001');

      expect(syncService.pendingRequests, contains('ch_001'));

      messageController.add({
        'type': 'chunk_data',
        'chunkId': 'ch_001',
        'data': {'chunk_id': 'ch_001'},
        'source': 'relay',
      });

      await Future<void>.delayed(Duration.zero);

      expect(syncService.pendingRequests, isNot(contains('ch_001')));
    });

    test('chunk_data with JSON string data (cache path) is parsed', () async {
      String? receivedChunkId;
      Map<String, dynamic>? receivedData;

      syncService.onChunkReceived = (chunkId, data) {
        receivedChunkId = chunkId;
        receivedData = data;
      };

      syncService.requestChunk('ch_001');

      // Simulate cache-served data: data is a JSON string, not a Map
      messageController.add({
        'type': 'chunk_data',
        'chunkId': 'ch_001',
        'data': jsonEncode({'chunk_id': 'ch_001', 'payload': 'cached'}),
        'source': 'cache',
      });

      await Future<void>.delayed(Duration.zero);

      expect(receivedChunkId, 'ch_001');
      expect(receivedData, isNotNull);
      expect(receivedData!['chunk_id'], 'ch_001');
      expect(receivedData!['payload'], 'cached');
    });

    test('chunk_data with invalid JSON string is silently dropped', () async {
      bool callbackInvoked = false;
      syncService.onChunkReceived = (_, __) {
        callbackInvoked = true;
      };

      syncService.requestChunk('ch_001');

      messageController.add({
        'type': 'chunk_data',
        'chunkId': 'ch_001',
        'data': 'not-valid-json{{{',
        'source': 'cache',
      });

      await Future<void>.delayed(Duration.zero);

      expect(callbackInvoked, isFalse);
    });

    test('chunk_pull triggers pushChunk for known chunks', () async {
      final channel = createTestChannel();
      await storageService.saveChannel(channel);
      await storageService.saveChunk(channel.id, createTestChunk());

      messageController.add({
        'type': 'chunk_pull',
        'chunkId': 'ch_001',
      });

      await Future<void>.delayed(Duration.zero);

      // Give time for the async findChannelForChunk + pushChunk
      await Future<void>.delayed(const Duration(milliseconds: 50));

      final pushMessages =
          sentMessages.where((m) => m['type'] == 'chunk_push').toList();
      expect(pushMessages, hasLength(1));
      expect(pushMessages.first['chunkId'], 'ch_001');
    });

    test('chunk_available invokes onChunkAvailable callback', () async {
      String? availableChunkId;
      syncService.onChunkAvailable = (chunkId) {
        availableChunkId = chunkId;
      };

      messageController.add({
        'type': 'chunk_available',
        'chunkId': 'ch_001',
      });

      await Future<void>.delayed(Duration.zero);

      expect(availableChunkId, 'ch_001');
    });

    test('chunk_available re-requests pending chunk', () async {
      syncService.onChunkAvailable = (_) {};
      syncService.requestChunk('ch_001');
      sentMessages.clear();

      messageController.add({
        'type': 'chunk_available',
        'chunkId': 'ch_001',
      });

      await Future<void>.delayed(Duration.zero);

      final requestMessages =
          sentMessages.where((m) => m['type'] == 'chunk_request').toList();
      expect(requestMessages, hasLength(1));
      expect(requestMessages.first['chunkId'], 'ch_001');
    });

    test('chunk_not_found keeps chunk in pending requests', () async {
      syncService.requestChunk('ch_001');

      messageController.add({
        'type': 'chunk_not_found',
        'chunkId': 'ch_001',
      });

      await Future<void>.delayed(Duration.zero);

      expect(syncService.pendingRequests, contains('ch_001'));
    });

    test('unknown message types are ignored', () async {
      messageController.add({
        'type': 'unknown_type',
        'data': 'whatever',
      });

      await Future<void>.delayed(Duration.zero);
      // No errors should be thrown
    });

    test('malformed messages are handled gracefully', () async {
      messageController.add({
        'type': 'chunk_data',
        // Missing chunkId and data
      });

      await Future<void>.delayed(Duration.zero);
      // No errors should be thrown
    });
  });

  // ---------------------------------------------------------------------------
  // Periodic sync
  // ---------------------------------------------------------------------------

  group('Periodic sync', () {
    test('periodic sync triggers syncAllChannels', () async {
      fakeAsync((async) {
        final channel = createTestChannel();
        final chunk = createTestChunk();

        // These are synchronous fake operations
        storageService._channels[channel.id] = channel;
        storageService._chunks[channel.id] = [chunk];

        syncService = ChannelSyncService(
          storageService: storageService,
          sendMessage: (msg) => sentMessages.add(msg),
          peerId: 'test_peer',
          syncInterval: const Duration(minutes: 5),
        );

        final controller = StreamController<Map<String, dynamic>>.broadcast();
        syncService.start(controller.stream);

        // Advance past one sync interval
        async.elapse(const Duration(minutes: 6));

        // Should have triggered at least one sync
        final announceMessages =
            sentMessages.where((m) => m['type'] == 'chunk_announce').toList();
        expect(announceMessages, isNotEmpty);

        controller.close();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Swarm seeding flow
  // ---------------------------------------------------------------------------

  group('Swarm seeding (subscriber re-announcement)', () {
    test('full swarm flow: request -> receive -> re-announce', () async {
      syncService.start(messageController.stream);

      // Step 1: Request a chunk
      syncService.requestChunk('ch_001');
      expect(sentMessages.last['type'], 'chunk_request');

      // Step 2: Receive the chunk data from the server
      String? receivedId;
      syncService.onChunkReceived = (id, data) {
        receivedId = id;
      };

      messageController.add({
        'type': 'chunk_data',
        'chunkId': 'ch_001',
        'data': {
          'chunk_id': 'ch_001',
          'routing_hash': 'hash_a',
          'encrypted_payload': 'base64data',
        },
        'source': 'relay',
      });

      await Future<void>.delayed(Duration.zero);
      expect(receivedId, 'ch_001');

      // Step 3: After verifying and storing (done by the caller), re-announce
      // This simulates the caller handling onChunkReceived and then calling
      // announceChunk to seed the swarm.
      syncService.announceChunk(createTestChunk());

      final announceMessages =
          sentMessages.where((m) => m['type'] == 'chunk_announce').toList();
      expect(announceMessages, hasLength(1));
      expect(syncService.announcedChunks, contains('ch_001'));
    });
  });
}
