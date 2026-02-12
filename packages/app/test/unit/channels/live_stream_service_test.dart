import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/live_stream.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';
import 'package:zajel/features/channels/services/channel_service.dart';
import 'package:zajel/features/channels/services/live_stream_service.dart';

import 'channel_service_test.dart';

void main() {
  late ChannelCryptoService cryptoService;
  late FakeChannelStorageService storageService;
  late ChannelService channelService;
  late LiveStreamService liveStreamService;

  setUp(() {
    cryptoService = ChannelCryptoService();
    storageService = FakeChannelStorageService();
    channelService = ChannelService(
      cryptoService: cryptoService,
      storageService: storageService,
    );
    liveStreamService = LiveStreamService(
      cryptoService: cryptoService,
      channelService: channelService,
    );
  });

  group('LiveStreamMetadata model', () {
    test('toJson and fromJson roundtrip', () {
      final meta = LiveStreamMetadata(
        streamId: 'stream_abc',
        channelId: 'ch_xyz',
        title: 'Test Stream',
        state: LiveStreamState.live,
        startedAt: DateTime.utc(2026, 2, 10, 12, 0),
        viewerCount: 42,
        frameCount: 100,
      );

      final json = meta.toJson();
      final restored = LiveStreamMetadata.fromJson(json);

      expect(restored.streamId, 'stream_abc');
      expect(restored.channelId, 'ch_xyz');
      expect(restored.title, 'Test Stream');
      expect(restored.state, LiveStreamState.live);
      expect(restored.viewerCount, 42);
      expect(restored.frameCount, 100);
      expect(restored.endedAt, isNull);
    });

    test('toJson and fromJson with endedAt', () {
      final meta = LiveStreamMetadata(
        streamId: 'stream_abc',
        channelId: 'ch_xyz',
        title: 'Ended Stream',
        state: LiveStreamState.ended,
        startedAt: DateTime.utc(2026, 2, 10, 12, 0),
        endedAt: DateTime.utc(2026, 2, 10, 13, 0),
      );

      final json = meta.toJson();
      final restored = LiveStreamMetadata.fromJson(json);

      expect(restored.state, LiveStreamState.ended);
      expect(restored.endedAt, DateTime.utc(2026, 2, 10, 13, 0));
    });

    test('copyWith creates modified copy', () {
      final meta = LiveStreamMetadata(
        streamId: 'stream_abc',
        channelId: 'ch_xyz',
        title: 'Original',
        state: LiveStreamState.live,
        startedAt: DateTime.utc(2026, 2, 10),
      );

      final modified = meta.copyWith(
        viewerCount: 10,
        state: LiveStreamState.ended,
      );

      expect(modified.viewerCount, 10);
      expect(modified.state, LiveStreamState.ended);
      expect(modified.title, 'Original'); // Unchanged
    });
  });

  group('LiveStreamFrame model', () {
    test('toJson and fromJson roundtrip', () {
      final frame = LiveStreamFrame(
        streamId: 'stream_abc',
        frameIndex: 42,
        encryptedData: Uint8List.fromList([10, 20, 30, 40, 50]),
        signature: base64Encode([1, 2, 3]),
        authorPubkey: base64Encode([4, 5, 6]),
        timestampMs: 5000,
      );

      final json = frame.toJson();
      final restored = LiveStreamFrame.fromJson(json);

      expect(restored.streamId, 'stream_abc');
      expect(restored.frameIndex, 42);
      expect(restored.encryptedData, Uint8List.fromList([10, 20, 30, 40, 50]));
      expect(restored.timestampMs, 5000);
    });
  });

  group('LiveStreamService - starting streams', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Stream Channel',
      );
      liveStreamService.setSender((_) {});
    });

    test('startStream creates a live stream', () {
      final meta = liveStreamService.startStream(
        channel: ownerChannel,
        title: 'My First Stream',
      );

      expect(meta.streamId, startsWith('stream_'));
      expect(meta.channelId, ownerChannel.id);
      expect(meta.title, 'My First Stream');
      expect(meta.state, LiveStreamState.live);
      expect(meta.viewerCount, 0);
      expect(meta.frameCount, 0);

      expect(liveStreamService.activeStream, isNotNull);
    });

    test('startStream rejects non-owner', () async {
      final sub = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      expect(
        () => liveStreamService.startStream(
          channel: sub,
          title: 'Illegal Stream',
        ),
        throwsA(isA<LiveStreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });

    test('startStream rejects when stream already active', () {
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'First Stream',
      );

      expect(
        () => liveStreamService.startStream(
          channel: ownerChannel,
          title: 'Second Stream',
        ),
        throwsA(isA<LiveStreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('already active'),
        )),
      );
    });

    test('startStream sends stream-start via WebSocket', () {
      final sentMessages = <Map<String, dynamic>>[];
      liveStreamService.setSender((msg) => sentMessages.add(msg));

      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'WS Test',
      );

      expect(sentMessages, hasLength(1));
      expect(sentMessages.first['type'], 'stream-start');
      expect(sentMessages.first['channelId'], ownerChannel.id);
      expect(sentMessages.first['title'], 'WS Test');
    });

    test('startStream invokes state change callback', () {
      LiveStreamMetadata? received;
      liveStreamService.onStateChange = (meta) => received = meta;

      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'Callback Test',
      );

      expect(received, isNotNull);
      expect(received!.state, LiveStreamState.live);
    });
  });

  group('LiveStreamService - sending frames', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Frame Channel',
      );
      liveStreamService.setSender((_) {});
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'Frame Test',
      );
    });

    test('sendFrame encrypts and sends a frame', () async {
      final sentMessages = <Map<String, dynamic>>[];
      liveStreamService.setSender((msg) => sentMessages.add(msg));

      final frameData = Uint8List.fromList(utf8.encode('audio data'));
      final frame = await liveStreamService.sendFrame(
        data: frameData,
        channel: ownerChannel,
      );

      expect(frame.frameIndex, 0);
      expect(frame.encryptedData, isNotEmpty);
      expect(frame.signature, isNotEmpty);
      expect(frame.authorPubkey, ownerChannel.manifest.ownerKey);
      expect(frame.timestampMs, greaterThanOrEqualTo(0));

      // Check WebSocket message
      expect(sentMessages, hasLength(1));
      expect(sentMessages.first['type'], 'stream-frame');
    });

    test('sendFrame increments frame count', () async {
      await liveStreamService.sendFrame(
        data: Uint8List.fromList([1, 2, 3]),
        channel: ownerChannel,
      );
      await liveStreamService.sendFrame(
        data: Uint8List.fromList([4, 5, 6]),
        channel: ownerChannel,
      );

      expect(liveStreamService.activeStream!.frameCount, 2);
    });

    test('sendFrame records frames for VOD conversion', () async {
      await liveStreamService.sendFrame(
        data: Uint8List.fromList([1, 2, 3]),
        channel: ownerChannel,
      );

      expect(liveStreamService.recordedFrameCount, 1);
    });

    test('sendFrame rejects when no active stream', () async {
      liveStreamService.endStream();

      expect(
        () => liveStreamService.sendFrame(
          data: Uint8List.fromList([1, 2, 3]),
          channel: ownerChannel,
        ),
        throwsA(isA<LiveStreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('No active'),
        )),
      );
    });
  });

  group('LiveStreamService - ending streams', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'End Stream Channel',
      );
      liveStreamService.setSender((_) {});
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'End Test',
      );
    });

    test('endStream sets state to ended', () {
      final meta = liveStreamService.endStream();

      expect(meta.state, LiveStreamState.ended);
      expect(meta.endedAt, isNotNull);
    });

    test('endStream sends stream-end via WebSocket', () {
      final sentMessages = <Map<String, dynamic>>[];
      liveStreamService.setSender((msg) => sentMessages.add(msg));

      liveStreamService.endStream();

      expect(sentMessages, hasLength(1));
      expect(sentMessages.first['type'], 'stream-end');
    });

    test('endStream invokes state change callback', () {
      LiveStreamMetadata? received;
      liveStreamService.onStateChange = (meta) => received = meta;

      liveStreamService.endStream();

      expect(received, isNotNull);
      expect(received!.state, LiveStreamState.ended);
    });

    test('endStream rejects when no active stream', () {
      liveStreamService.endStream();

      expect(
        () => liveStreamService.endStream(),
        throwsA(isA<LiveStreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('No active'),
        )),
      );
    });
  });

  group('LiveStreamService - subscriber side', () {
    test('handleStreamStart sets up active stream', () {
      LiveStreamMetadata? received;
      liveStreamService.onStateChange = (meta) => received = meta;

      liveStreamService.handleStreamStart({
        'streamId': 'stream_xyz',
        'channelId': 'ch_1',
        'title': 'Incoming Stream',
      });

      expect(liveStreamService.activeStream, isNotNull);
      expect(liveStreamService.activeStream!.streamId, 'stream_xyz');
      expect(liveStreamService.activeStream!.state, LiveStreamState.live);
      expect(received, isNotNull);
    });

    test('handleStreamFrame invokes callback', () {
      LiveStreamFrame? received;
      liveStreamService.onFrame = (frame) => received = frame;

      liveStreamService.handleStreamFrame({
        'frame': {
          'stream_id': 'stream_xyz',
          'frame_index': 5,
          'encrypted_data': base64Encode([1, 2, 3]),
          'signature': base64Encode([4, 5, 6]),
          'author_pubkey': base64Encode([7, 8, 9]),
          'timestamp_ms': 1000,
        },
      });

      expect(received, isNotNull);
      expect(received!.frameIndex, 5);
      expect(received!.timestampMs, 1000);
    });

    test('handleStreamFrame silently drops malformed frames', () {
      LiveStreamFrame? received;
      liveStreamService.onFrame = (frame) => received = frame;

      liveStreamService.handleStreamFrame({
        'frame': 'not a map',
      });

      expect(received, isNull);
    });

    test('handleStreamEnd sets state to ended', () {
      liveStreamService.handleStreamStart({
        'streamId': 'stream_xyz',
        'channelId': 'ch_1',
        'title': 'Ending Stream',
      });

      LiveStreamMetadata? received;
      liveStreamService.onStateChange = (meta) => received = meta;

      liveStreamService.handleStreamEnd({
        'streamId': 'stream_xyz',
        'channelId': 'ch_1',
      });

      expect(liveStreamService.activeStream!.state, LiveStreamState.ended);
      expect(received, isNotNull);
      expect(received!.state, LiveStreamState.ended);
    });

    test('updateViewerCount updates active stream', () {
      liveStreamService.handleStreamStart({
        'streamId': 'stream_xyz',
        'channelId': 'ch_1',
      });

      liveStreamService.updateViewerCount(25);

      expect(liveStreamService.activeStream!.viewerCount, 25);
    });
  });

  group('LiveStreamService - VOD conversion', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'VOD Channel',
      );
      liveStreamService.setSender((_) {});
    });

    test('convertToVod produces chunks from recorded frames', () async {
      // Start a stream and send some frames
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'VOD Test',
      );

      for (var i = 0; i < 3; i++) {
        await liveStreamService.sendFrame(
          data: Uint8List.fromList(utf8.encode('frame $i data')),
          channel: ownerChannel,
        );
      }

      // End the stream
      liveStreamService.endStream();

      // Convert to VOD
      final chunks = await liveStreamService.convertToVod(
        channel: ownerChannel,
        startSequence: 100,
        routingHash: 'rh_vod',
      );

      expect(chunks, isNotEmpty);
    });

    test('convertToVod rejects when stream not ended', () async {
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'Not Ended',
      );

      expect(
        () => liveStreamService.convertToVod(
          channel: ownerChannel,
          startSequence: 1,
          routingHash: 'rh',
        ),
        throwsA(isA<LiveStreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('not ended'),
        )),
      );
    });

    test('convertToVod rejects when no recorded frames', () async {
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'No Frames',
      );
      liveStreamService.endStream();

      expect(
        () => liveStreamService.convertToVod(
          channel: ownerChannel,
          startSequence: 1,
          routingHash: 'rh',
        ),
        throwsA(isA<LiveStreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('no recorded frames'),
        )),
      );
    });

    test('convertToVod rejects non-owner', () async {
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'Owner Only',
      );
      await liveStreamService.sendFrame(
        data: Uint8List.fromList([1, 2, 3]),
        channel: ownerChannel,
      );
      liveStreamService.endStream();

      final sub = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      expect(
        () => liveStreamService.convertToVod(
          channel: sub,
          startSequence: 1,
          routingHash: 'rh',
        ),
        throwsA(isA<LiveStreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });
  });

  group('LiveStreamService - utility methods', () {
    test('getLocalFrameIndices returns correct indices', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'Index Channel',
      );
      liveStreamService.setSender((_) {});
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'Index Test',
      );

      await liveStreamService.sendFrame(
        data: Uint8List.fromList([1]),
        channel: ownerChannel,
      );
      await liveStreamService.sendFrame(
        data: Uint8List.fromList([2]),
        channel: ownerChannel,
      );

      final indices = liveStreamService.getLocalFrameIndices();
      expect(indices, [0, 1]);
    });

    test('clearRecordedFrames empties the buffer', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'Clear Frames',
      );
      liveStreamService.setSender((_) {});
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'Clear Test',
      );

      await liveStreamService.sendFrame(
        data: Uint8List.fromList([1]),
        channel: ownerChannel,
      );

      expect(liveStreamService.recordedFrameCount, 1);
      liveStreamService.clearRecordedFrames();
      expect(liveStreamService.recordedFrameCount, 0);
    });

    test('reset clears everything', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'Reset Channel',
      );
      liveStreamService.setSender((_) {});
      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'Reset Test',
      );

      liveStreamService.reset();

      expect(liveStreamService.activeStream, isNull);
      expect(liveStreamService.recordedFrameCount, 0);
    });

    test('can start new stream after previous one ended', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'Multi Stream',
      );
      liveStreamService.setSender((_) {});

      liveStreamService.startStream(
        channel: ownerChannel,
        title: 'First',
      );
      liveStreamService.endStream();

      // Should succeed
      final meta = liveStreamService.startStream(
        channel: ownerChannel,
        title: 'Second',
      );
      expect(meta.title, 'Second');
      expect(meta.state, LiveStreamState.live);
    });
  });
}
