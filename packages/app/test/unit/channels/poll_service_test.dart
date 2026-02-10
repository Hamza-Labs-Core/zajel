import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/models/upstream_message.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';
import 'package:zajel/features/channels/services/channel_service.dart';
import 'package:zajel/features/channels/services/poll_service.dart';
import 'package:zajel/features/channels/services/upstream_service.dart';

import 'channel_service_test.dart';

void main() {
  late ChannelCryptoService cryptoService;
  late FakeChannelStorageService storageService;
  late ChannelService channelService;
  late UpstreamService upstreamService;
  late PollService pollService;

  setUp(() {
    cryptoService = ChannelCryptoService();
    storageService = FakeChannelStorageService();
    channelService = ChannelService(
      cryptoService: cryptoService,
      storageService: storageService,
    );
    upstreamService = UpstreamService(cryptoService: cryptoService);
    pollService = PollService(
      channelService: channelService,
      upstreamService: upstreamService,
    );
  });

  group('Poll model', () {
    test('toJson and fromJson roundtrip', () {
      final poll = Poll(
        pollId: 'poll_abc',
        question: 'What is your favorite color?',
        options: const [
          PollOption(index: 0, label: 'Red'),
          PollOption(index: 1, label: 'Blue'),
          PollOption(index: 2, label: 'Green'),
        ],
        allowMultiple: false,
        createdAt: DateTime.utc(2026, 2, 10),
      );

      final json = poll.toJson();
      final restored = Poll.fromJson(json);

      expect(restored.pollId, 'poll_abc');
      expect(restored.question, 'What is your favorite color?');
      expect(restored.options, hasLength(3));
      expect(restored.options[1].label, 'Blue');
      expect(restored.allowMultiple, isFalse);
    });

    test('Poll with closesAt serializes correctly', () {
      final poll = Poll(
        pollId: 'poll_xyz',
        question: 'Quick poll',
        options: const [
          PollOption(index: 0, label: 'Yes'),
          PollOption(index: 1, label: 'No'),
        ],
        createdAt: DateTime.utc(2026, 2, 10),
        closesAt: DateTime.utc(2026, 2, 11),
      );

      final json = poll.toJson();
      final restored = Poll.fromJson(json);

      expect(restored.closesAt, DateTime.utc(2026, 2, 11));
    });
  });

  group('PollResults model', () {
    test('toJson and fromJson roundtrip', () {
      final results = PollResults(
        pollId: 'poll_abc',
        voteCounts: {0: 5, 1: 3, 2: 7},
        totalVotes: 15,
        isFinal: true,
        talliedAt: DateTime.utc(2026, 2, 10, 14, 0),
      );

      final json = results.toJson();
      final restored = PollResults.fromJson(json);

      expect(restored.pollId, 'poll_abc');
      expect(restored.voteCounts[0], 5);
      expect(restored.voteCounts[1], 3);
      expect(restored.voteCounts[2], 7);
      expect(restored.totalVotes, 15);
      expect(restored.isFinal, isTrue);
    });
  });

  group('PollService - poll creation', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Poll Channel',
      );
    });

    test('createPoll creates poll and produces chunks', () async {
      final result = await pollService.createPoll(
        channel: ownerChannel,
        question: 'Favorite language?',
        optionLabels: ['Dart', 'TypeScript', 'Rust'],
        sequence: 1,
        routingHash: 'rh_test',
      );

      expect(result.poll.pollId, startsWith('poll_'));
      expect(result.poll.question, 'Favorite language?');
      expect(result.poll.options, hasLength(3));
      expect(result.chunks, isNotEmpty);
      expect(result.chunks.first.sequence, 1);
    });

    test('createPoll chunks contain valid encrypted poll data', () async {
      final result = await pollService.createPoll(
        channel: ownerChannel,
        question: 'Test poll?',
        optionLabels: ['A', 'B'],
        sequence: 1,
        routingHash: 'rh_test',
      );

      // Decrypt the chunk and verify it contains the poll
      final reassembled = channelService.reassembleChunks(result.chunks);
      final decrypted = await cryptoService.decryptPayload(
        reassembled,
        ownerChannel.encryptionKeyPrivate!,
        ownerChannel.manifest.keyEpoch,
      );

      expect(decrypted.type, ContentType.poll);
      expect(decrypted.metadata['poll_id'], result.poll.pollId);

      final pollData = jsonDecode(utf8.decode(decrypted.payload));
      final pollRestored = Poll.fromJson(pollData);
      expect(pollRestored.question, 'Test poll?');
      expect(pollRestored.options, hasLength(2));
    });

    test('createPoll rejects non-owner', () async {
      final sub = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      expect(
        () => pollService.createPoll(
          channel: sub,
          question: 'Illegal poll',
          optionLabels: ['Yes', 'No'],
          sequence: 1,
          routingHash: 'rh_test',
        ),
        throwsA(isA<PollServiceException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });

    test('createPoll rejects fewer than 2 options', () async {
      expect(
        () => pollService.createPoll(
          channel: ownerChannel,
          question: 'One option?',
          optionLabels: ['Only one'],
          sequence: 1,
          routingHash: 'rh_test',
        ),
        throwsA(isA<PollServiceException>().having(
          (e) => e.message,
          'message',
          contains('at least 2'),
        )),
      );
    });

    test('createPoll rejects when polls disabled', () async {
      final restrictedChannel = await channelService.createChannel(
        name: 'No Polls',
        rules: const ChannelRules(pollsEnabled: false),
      );

      expect(
        () => pollService.createPoll(
          channel: restrictedChannel,
          question: 'Disabled?',
          optionLabels: ['Yes', 'No'],
          sequence: 1,
          routingHash: 'rh_test',
        ),
        throwsA(isA<PollServiceException>().having(
          (e) => e.message,
          'message',
          contains('disabled'),
        )),
      );
    });
  });

  group('PollService - voting (subscriber side)', () {
    late Channel ownerChannel;
    late Channel subscriberChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Vote Channel',
      );
      subscriberChannel = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );
      // Set up sender so votes can be sent
      upstreamService.setSender((_) {});
    });

    test('castVote sends upstream vote', () async {
      final result = await pollService.castVote(
        channel: subscriberChannel,
        pollId: 'poll_abc',
        optionIndex: 1,
      );

      expect(result.type, UpstreamMessageType.vote);
      expect(result.channelId, subscriberChannel.id);
    });

    test('castVote rejects when polls disabled', () async {
      final restrictedChannel = await channelService.createChannel(
        name: 'No Polls',
        rules: const ChannelRules(pollsEnabled: false),
      );
      final sub = await channelService.subscribe(
        manifest: restrictedChannel.manifest,
        encryptionPrivateKey: restrictedChannel.encryptionKeyPrivate!,
      );

      expect(
        () => pollService.castVote(
          channel: sub,
          pollId: 'poll_1',
          optionIndex: 0,
        ),
        throwsA(isA<PollServiceException>().having(
          (e) => e.message,
          'message',
          contains('disabled'),
        )),
      );
    });
  });

  group('PollService - vote recording and tallying', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Tally Channel',
      );
    });

    test('recordVote records votes correctly', () async {
      // Create a poll first
      final result = await pollService.createPoll(
        channel: ownerChannel,
        question: 'Tally test?',
        optionLabels: ['A', 'B', 'C'],
        sequence: 1,
        routingHash: 'rh_test',
      );

      // Record votes
      expect(
        pollService.recordVote(
          pollId: result.poll.pollId,
          optionIndex: 0,
          senderKey: 'sender_1',
        ),
        isTrue,
      );
      expect(
        pollService.recordVote(
          pollId: result.poll.pollId,
          optionIndex: 1,
          senderKey: 'sender_2',
        ),
        isTrue,
      );
      expect(
        pollService.recordVote(
          pollId: result.poll.pollId,
          optionIndex: 0,
          senderKey: 'sender_3',
        ),
        isTrue,
      );

      expect(pollService.getVoteCount(result.poll.pollId), 3);
    });

    test('recordVote prevents duplicate votes from same sender', () async {
      final result = await pollService.createPoll(
        channel: ownerChannel,
        question: 'No dupes?',
        optionLabels: ['Yes', 'No'],
        sequence: 1,
        routingHash: 'rh_test',
      );

      expect(
        pollService.recordVote(
          pollId: result.poll.pollId,
          optionIndex: 0,
          senderKey: 'sender_1',
        ),
        isTrue,
      );
      expect(
        pollService.recordVote(
          pollId: result.poll.pollId,
          optionIndex: 1,
          senderKey: 'sender_1', // Same sender
        ),
        isFalse,
      );

      expect(pollService.getVoteCount(result.poll.pollId), 1);
    });

    test('recordVote returns false for unknown poll', () {
      expect(
        pollService.recordVote(
          pollId: 'nonexistent',
          optionIndex: 0,
          senderKey: 'sender_1',
        ),
        isFalse,
      );
    });

    test('tallyAndBroadcast produces correct results', () async {
      final createResult = await pollService.createPoll(
        channel: ownerChannel,
        question: 'Tally broadcast?',
        optionLabels: ['X', 'Y'],
        sequence: 1,
        routingHash: 'rh_test',
      );

      // Record votes
      pollService.recordVote(
        pollId: createResult.poll.pollId,
        optionIndex: 0,
        senderKey: 'sender_1',
      );
      pollService.recordVote(
        pollId: createResult.poll.pollId,
        optionIndex: 0,
        senderKey: 'sender_2',
      );
      pollService.recordVote(
        pollId: createResult.poll.pollId,
        optionIndex: 1,
        senderKey: 'sender_3',
      );

      final tallyResult = await pollService.tallyAndBroadcast(
        channel: ownerChannel,
        poll: createResult.poll,
        sequence: 2,
        routingHash: 'rh_test',
        isFinal: true,
      );

      expect(tallyResult.results.pollId, createResult.poll.pollId);
      expect(tallyResult.results.voteCounts[0], 2);
      expect(tallyResult.results.voteCounts[1], 1);
      expect(tallyResult.results.totalVotes, 3);
      expect(tallyResult.results.isFinal, isTrue);
      expect(tallyResult.chunks, isNotEmpty);
    });

    test('tallyAndBroadcast chunks contain decryptable results', () async {
      final createResult = await pollService.createPoll(
        channel: ownerChannel,
        question: 'Decrypt tally?',
        optionLabels: ['A', 'B'],
        sequence: 1,
        routingHash: 'rh_test',
      );

      pollService.recordVote(
        pollId: createResult.poll.pollId,
        optionIndex: 1,
        senderKey: 'sender_1',
      );

      final tallyResult = await pollService.tallyAndBroadcast(
        channel: ownerChannel,
        poll: createResult.poll,
        sequence: 2,
        routingHash: 'rh_test',
      );

      // Decrypt and verify the results
      final reassembled = channelService.reassembleChunks(tallyResult.chunks);
      final decrypted = await cryptoService.decryptPayload(
        reassembled,
        ownerChannel.encryptionKeyPrivate!,
        ownerChannel.manifest.keyEpoch,
      );

      expect(decrypted.type, ContentType.poll);
      expect(decrypted.metadata['is_results'], true);

      final resultsData = jsonDecode(utf8.decode(decrypted.payload));
      final results = PollResults.fromJson(resultsData);
      expect(results.totalVotes, 1);
      expect(results.voteCounts[1], 1);
    });

    test('tallyAndBroadcast rejects non-owner', () async {
      final sub = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      final createResult = await pollService.createPoll(
        channel: ownerChannel,
        question: 'Owner only tally?',
        optionLabels: ['Yes', 'No'],
        sequence: 1,
        routingHash: 'rh_test',
      );

      expect(
        () => pollService.tallyAndBroadcast(
          channel: sub,
          poll: createResult.poll,
          sequence: 2,
          routingHash: 'rh_test',
        ),
        throwsA(isA<PollServiceException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });
  });

  group('PollService - utility methods', () {
    test('getVoteCount returns 0 for unknown poll', () {
      expect(pollService.getVoteCount('nonexistent'), 0);
    });

    test('clearVotes removes vote data', () async {
      final ownerChannel = await channelService.createChannel(
        name: 'Clear Test',
      );
      final result = await pollService.createPoll(
        channel: ownerChannel,
        question: 'Clear?',
        optionLabels: ['Yes', 'No'],
        sequence: 1,
        routingHash: 'rh_test',
      );

      pollService.recordVote(
        pollId: result.poll.pollId,
        optionIndex: 0,
        senderKey: 'sender_1',
      );

      expect(pollService.getVoteCount(result.poll.pollId), 1);

      pollService.clearVotes(result.poll.pollId);
      expect(pollService.getVoteCount(result.poll.pollId), 0);
    });
  });
}
