import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/upstream_message.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';
import 'package:zajel/features/channels/services/channel_service.dart';
import 'package:zajel/features/channels/services/upstream_service.dart';

import 'channel_service_test.dart';

void main() {
  late ChannelCryptoService cryptoService;
  late FakeChannelStorageService storageService;
  late ChannelService channelService;
  late UpstreamService upstreamService;

  setUp(() {
    cryptoService = ChannelCryptoService();
    storageService = FakeChannelStorageService();
    channelService = ChannelService(
      cryptoService: cryptoService,
      storageService: storageService,
    );
    upstreamService = UpstreamService();
  });

  group('UpstreamPayload', () {
    test('toBytes and fromBytes roundtrip for reply', () {
      final payload = UpstreamPayload(
        type: UpstreamMessageType.reply,
        content: 'Great post!',
        replyTo: 'msg_42',
        timestamp: DateTime.utc(2026, 2, 10, 12, 0),
      );

      final bytes = payload.toBytes();
      final restored = UpstreamPayload.fromBytes(bytes);

      expect(restored.type, UpstreamMessageType.reply);
      expect(restored.content, 'Great post!');
      expect(restored.replyTo, 'msg_42');
      expect(restored.pollId, isNull);
      expect(restored.voteOptionIndex, isNull);
    });

    test('toBytes and fromBytes roundtrip for vote', () {
      final payload = UpstreamPayload(
        type: UpstreamMessageType.vote,
        content: '',
        pollId: 'poll_abc',
        voteOptionIndex: 2,
        timestamp: DateTime.utc(2026, 2, 10, 12, 0),
      );

      final bytes = payload.toBytes();
      final restored = UpstreamPayload.fromBytes(bytes);

      expect(restored.type, UpstreamMessageType.vote);
      expect(restored.pollId, 'poll_abc');
      expect(restored.voteOptionIndex, 2);
    });

    test('toBytes and fromBytes roundtrip for reaction', () {
      final payload = UpstreamPayload(
        type: UpstreamMessageType.reaction,
        content: 'thumbs_up',
        replyTo: 'msg_99',
        timestamp: DateTime.utc(2026, 2, 10, 12, 0),
      );

      final bytes = payload.toBytes();
      final restored = UpstreamPayload.fromBytes(bytes);

      expect(restored.type, UpstreamMessageType.reaction);
      expect(restored.content, 'thumbs_up');
      expect(restored.replyTo, 'msg_99');
    });

    test('fromBytes throws on invalid data', () {
      expect(
        () => UpstreamPayload.fromBytes(Uint8List.fromList([0, 1, 2])),
        throwsFormatException,
      );
    });
  });

  group('UpstreamMessage', () {
    test('toJson and fromJson roundtrip', () {
      final msg = UpstreamMessage(
        id: 'up_abc12345',
        channelId: 'ch_xyz',
        type: UpstreamMessageType.reply,
        encryptedPayload: Uint8List.fromList([10, 20, 30]),
        signature: base64Encode([1, 2, 3]),
        senderEphemeralKey: base64Encode([4, 5, 6]),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final json = msg.toJson();
      final restored = UpstreamMessage.fromJson(json);

      expect(restored.id, 'up_abc12345');
      expect(restored.channelId, 'ch_xyz');
      expect(restored.type, UpstreamMessageType.reply);
      expect(restored.encryptedPayload, Uint8List.fromList([10, 20, 30]));
    });
  });

  group('ReplyThread', () {
    test('addReply adds and sorts by timestamp', () {
      final thread = const ReplyThread(parentMessageId: 'msg_1');

      final reply1 = UpstreamPayload(
        type: UpstreamMessageType.reply,
        content: 'Second',
        replyTo: 'msg_1',
        timestamp: DateTime.utc(2026, 2, 10, 12, 0),
      );
      final reply2 = UpstreamPayload(
        type: UpstreamMessageType.reply,
        content: 'First',
        replyTo: 'msg_1',
        timestamp: DateTime.utc(2026, 2, 10, 11, 0),
      );

      final updated = thread.addReply(reply1).addReply(reply2);

      expect(updated.replyCount, 2);
      expect(updated.replies.first.content, 'First');
      expect(updated.replies.last.content, 'Second');
    });
  });

  group('UpstreamService - sending', () {
    late Channel ownerChannel;
    late Channel subscriberChannel;
    late List<Map<String, dynamic>> sentMessages;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Upstream Test',
      );

      subscriberChannel = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      sentMessages = [];
      upstreamService.setSender((msg) => sentMessages.add(msg));
    });

    test('sendReply sends an upstream-message', () async {
      final result = await upstreamService.sendReply(
        channel: subscriberChannel,
        replyTo: 'msg_42',
        content: 'Nice post!',
      );

      expect(result.id, startsWith('up_'));
      expect(result.channelId, subscriberChannel.id);
      expect(result.type, UpstreamMessageType.reply);
      expect(result.encryptedPayload, isNotEmpty);
      expect(result.signature, isNotEmpty);

      expect(sentMessages, hasLength(1));
      expect(sentMessages.first['type'], 'upstream-message');
      expect(sentMessages.first['channelId'], subscriberChannel.id);
    });

    test('sendVote sends a vote upstream', () async {
      final result = await upstreamService.sendVote(
        channel: subscriberChannel,
        pollId: 'poll_abc',
        optionIndex: 1,
      );

      expect(result.type, UpstreamMessageType.vote);
      expect(sentMessages, hasLength(1));
    });

    test('sendReaction sends a reaction upstream', () async {
      final result = await upstreamService.sendReaction(
        channel: subscriberChannel,
        replyTo: 'msg_99',
        reaction: 'thumbs_up',
      );

      expect(result.type, UpstreamMessageType.reaction);
      expect(sentMessages, hasLength(1));
    });

    test('rejects reply when replies are disabled', () async {
      final restrictedChannel = await channelService.createChannel(
        name: 'No Replies',
        rules: const ChannelRules(repliesEnabled: false),
      );
      final sub = await channelService.subscribe(
        manifest: restrictedChannel.manifest,
        encryptionPrivateKey: restrictedChannel.encryptionKeyPrivate!,
      );

      expect(
        () => upstreamService.sendReply(
          channel: sub,
          replyTo: 'msg_1',
          content: 'Hello',
        ),
        throwsA(isA<UpstreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('disabled'),
        )),
      );
    });

    test('rejects vote when polls are disabled', () async {
      final restrictedChannel = await channelService.createChannel(
        name: 'No Polls',
        rules: const ChannelRules(pollsEnabled: false),
      );
      final sub = await channelService.subscribe(
        manifest: restrictedChannel.manifest,
        encryptionPrivateKey: restrictedChannel.encryptionKeyPrivate!,
      );

      expect(
        () => upstreamService.sendVote(
          channel: sub,
          pollId: 'poll_1',
          optionIndex: 0,
        ),
        throwsA(isA<UpstreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('disabled'),
        )),
      );
    });

    test('rejects oversized upstream message', () async {
      final channel = await channelService.createChannel(
        name: 'Size Limit',
        rules: const ChannelRules(maxUpstreamSize: 50),
      );
      final sub = await channelService.subscribe(
        manifest: channel.manifest,
        encryptionPrivateKey: channel.encryptionKeyPrivate!,
      );

      expect(
        () => upstreamService.sendReply(
          channel: sub,
          replyTo: 'msg_1',
          content: 'A' * 200, // Will exceed 50 bytes after serialization
        ),
        throwsA(isA<UpstreamServiceException>().having(
          (e) => e.message,
          'message',
          contains('too large'),
        )),
      );
    });
  });

  group('UpstreamService - message queuing', () {
    test('queues messages when sender is not set', () async {
      // Do NOT set a sender
      final ownerChannel = await channelService.createChannel(
        name: 'Queue Test',
      );
      final subscriberChannel = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      await upstreamService.sendReply(
        channel: subscriberChannel,
        replyTo: 'msg_1',
        content: 'Queued!',
      );

      expect(upstreamService.pendingMessageCount, 1);

      // Now set sender and messages should flush
      final sentMessages = <Map<String, dynamic>>[];
      upstreamService.setSender((msg) => sentMessages.add(msg));

      expect(upstreamService.pendingMessageCount, 0);
      expect(sentMessages, hasLength(1));
    });

    test('respects max pending messages limit', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'Queue Limit',
      );
      final sub = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      // Send more than the limit
      for (var i = 0; i < UpstreamService.maxPendingMessages + 10; i++) {
        await upstreamService.sendReply(
          channel: sub,
          replyTo: 'msg_$i',
          content: 'Msg $i',
        );
      }

      expect(
        upstreamService.pendingMessageCount,
        UpstreamService.maxPendingMessages,
      );
    });
  });

  group('UpstreamService - encrypt/decrypt roundtrip', () {
    test('owner can decrypt subscriber upstream message', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'E2E Test',
      );
      final subscriberChannel = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      String? capturedEphemeralKey;
      UpstreamMessage? capturedMessage;

      upstreamService.setSender((msg) {
        capturedEphemeralKey = msg['ephemeralPublicKey'] as String?;
        final messageJson = msg['message'] as Map<String, dynamic>;
        capturedMessage = UpstreamMessage.fromJson(messageJson);
      });

      await upstreamService.sendReply(
        channel: subscriberChannel,
        replyTo: 'msg_42',
        content: 'Decryptable reply',
      );

      expect(capturedMessage, isNotNull);
      expect(capturedEphemeralKey, isNotNull);

      // Owner decrypts the message
      final decrypted = await upstreamService.decryptUpstreamMessage(
        message: capturedMessage!,
        encryptionPrivateKeyBase64: ownerChannel.encryptionKeyPrivate!,
        ephemeralPublicKeyBase64: capturedEphemeralKey!,
      );

      expect(decrypted.type, UpstreamMessageType.reply);
      expect(decrypted.content, 'Decryptable reply');
      expect(decrypted.replyTo, 'msg_42');
    });

    test('owner can decrypt vote upstream message', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'Vote E2E',
      );
      final subscriberChannel = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      String? capturedEphemeralKey;
      UpstreamMessage? capturedMessage;

      upstreamService.setSender((msg) {
        capturedEphemeralKey = msg['ephemeralPublicKey'] as String?;
        final messageJson = msg['message'] as Map<String, dynamic>;
        capturedMessage = UpstreamMessage.fromJson(messageJson);
      });

      await upstreamService.sendVote(
        channel: subscriberChannel,
        pollId: 'poll_xyz',
        optionIndex: 3,
      );

      final decrypted = await upstreamService.decryptUpstreamMessage(
        message: capturedMessage!,
        encryptionPrivateKeyBase64: ownerChannel.encryptionKeyPrivate!,
        ephemeralPublicKeyBase64: capturedEphemeralKey!,
      );

      expect(decrypted.type, UpstreamMessageType.vote);
      expect(decrypted.pollId, 'poll_xyz');
      expect(decrypted.voteOptionIndex, 3);
    });

    test('decryption with wrong key fails', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'Wrong Key',
      );
      final subscriberChannel = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      String? capturedEphemeralKey;
      UpstreamMessage? capturedMessage;

      upstreamService.setSender((msg) {
        capturedEphemeralKey = msg['ephemeralPublicKey'] as String?;
        final messageJson = msg['message'] as Map<String, dynamic>;
        capturedMessage = UpstreamMessage.fromJson(messageJson);
      });

      await upstreamService.sendReply(
        channel: subscriberChannel,
        replyTo: 'msg_1',
        content: 'Secret',
      );

      // Try to decrypt with a different channel's key
      final otherChannel = await channelService.createChannel(
        name: 'Other',
      );

      expect(
        () => upstreamService.decryptUpstreamMessage(
          message: capturedMessage!,
          encryptionPrivateKeyBase64: otherChannel.encryptionKeyPrivate!,
          ephemeralPublicKeyBase64: capturedEphemeralKey!,
        ),
        throwsA(isA<UpstreamServiceException>()),
      );
    });
  });

  group('UpstreamService - reply threading', () {
    test('groupRepliesIntoThreads groups by parent message', () {
      final payloads = [
        UpstreamPayload(
          type: UpstreamMessageType.reply,
          content: 'Reply 1 to msg_1',
          replyTo: 'msg_1',
          timestamp: DateTime.utc(2026, 2, 10, 12, 0),
        ),
        UpstreamPayload(
          type: UpstreamMessageType.reply,
          content: 'Reply 2 to msg_1',
          replyTo: 'msg_1',
          timestamp: DateTime.utc(2026, 2, 10, 13, 0),
        ),
        UpstreamPayload(
          type: UpstreamMessageType.reply,
          content: 'Reply to msg_2',
          replyTo: 'msg_2',
          timestamp: DateTime.utc(2026, 2, 10, 14, 0),
        ),
        // Non-reply should be excluded
        UpstreamPayload(
          type: UpstreamMessageType.reaction,
          content: 'heart',
          replyTo: 'msg_1',
          timestamp: DateTime.utc(2026, 2, 10, 15, 0),
        ),
      ];

      final threads = upstreamService.groupRepliesIntoThreads(payloads);

      expect(threads, hasLength(2));
      expect(threads['msg_1']!.replyCount, 2);
      expect(threads['msg_2']!.replyCount, 1);
      expect(threads['msg_1']!.replies.first.content, 'Reply 1 to msg_1');
    });

    test('empty input produces empty threads', () {
      final threads = upstreamService.groupRepliesIntoThreads([]);
      expect(threads, isEmpty);
    });
  });

  group('UpstreamService - incoming message handling', () {
    test('handleIncomingMessage invokes callback', () {
      UpstreamMessage? received;
      upstreamService.onUpstreamMessage = (msg) => received = msg;

      final msg = UpstreamMessage(
        id: 'up_test',
        channelId: 'ch_1',
        type: UpstreamMessageType.reply,
        encryptedPayload: Uint8List.fromList([1, 2, 3]),
        signature: base64Encode([4, 5, 6]),
        senderEphemeralKey: base64Encode([7, 8, 9]),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      upstreamService.handleIncomingMessage({
        'message': msg.toJson(),
      });

      expect(received, isNotNull);
      expect(received!.id, 'up_test');
    });

    test('handleIncomingMessage silently drops malformed data', () {
      UpstreamMessage? received;
      upstreamService.onUpstreamMessage = (msg) => received = msg;

      // Send malformed data
      upstreamService.handleIncomingMessage({
        'message': 'not a map',
      });

      expect(received, isNull);
    });
  });
}
