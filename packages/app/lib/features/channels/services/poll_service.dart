import 'dart:convert';
import 'dart:typed_data';

import 'package:equatable/equatable.dart';
import 'package:uuid/uuid.dart';

import '../models/channel.dart';
import '../models/chunk.dart';
import '../models/upstream_message.dart';
import 'channel_service.dart';
import 'upstream_service.dart';

/// A poll option with its label.
class PollOption extends Equatable {
  final int index;
  final String label;

  const PollOption({required this.index, required this.label});

  Map<String, dynamic> toJson() => {'index': index, 'label': label};

  factory PollOption.fromJson(Map<String, dynamic> json) {
    return PollOption(
      index: json['index'] as int,
      label: json['label'] as String,
    );
  }

  @override
  List<Object?> get props => [index, label];
}

/// A poll definition — created by the owner and broadcast as a chunk.
class Poll extends Equatable {
  /// Unique poll identifier.
  final String pollId;

  /// The question or title of the poll.
  final String question;

  /// Available options (at least 2).
  final List<PollOption> options;

  /// Whether multiple selections are allowed.
  final bool allowMultiple;

  /// When the poll was created.
  final DateTime createdAt;

  /// When the poll closes (null = never).
  final DateTime? closesAt;

  const Poll({
    required this.pollId,
    required this.question,
    required this.options,
    this.allowMultiple = false,
    required this.createdAt,
    this.closesAt,
  });

  Map<String, dynamic> toJson() => {
        'poll_id': pollId,
        'question': question,
        'options': options.map((o) => o.toJson()).toList(),
        'allow_multiple': allowMultiple,
        'created_at': createdAt.toIso8601String(),
        if (closesAt != null) 'closes_at': closesAt!.toIso8601String(),
      };

  factory Poll.fromJson(Map<String, dynamic> json) {
    return Poll(
      pollId: json['poll_id'] as String,
      question: json['question'] as String,
      options: (json['options'] as List<dynamic>)
          .map((o) => PollOption.fromJson(o as Map<String, dynamic>))
          .toList(),
      allowMultiple: json['allow_multiple'] as bool? ?? false,
      createdAt: DateTime.parse(json['created_at'] as String),
      closesAt: json['closes_at'] != null
          ? DateTime.parse(json['closes_at'] as String)
          : null,
    );
  }

  @override
  List<Object?> get props =>
      [pollId, question, options, allowMultiple, createdAt, closesAt];
}

/// Aggregated poll results — broadcast by the owner.
class PollResults extends Equatable {
  /// The poll ID these results are for.
  final String pollId;

  /// Vote counts per option index.
  final Map<int, int> voteCounts;

  /// Total number of votes cast.
  final int totalVotes;

  /// Whether these are final results (poll is closed).
  final bool isFinal;

  /// When these results were tallied.
  final DateTime talliedAt;

  const PollResults({
    required this.pollId,
    required this.voteCounts,
    required this.totalVotes,
    this.isFinal = false,
    required this.talliedAt,
  });

  Map<String, dynamic> toJson() => {
        'poll_id': pollId,
        'vote_counts': voteCounts.map((k, v) => MapEntry(k.toString(), v)),
        'total_votes': totalVotes,
        'is_final': isFinal,
        'tallied_at': talliedAt.toIso8601String(),
      };

  factory PollResults.fromJson(Map<String, dynamic> json) {
    final rawCounts = json['vote_counts'] as Map<String, dynamic>;
    return PollResults(
      pollId: json['poll_id'] as String,
      voteCounts: rawCounts.map((k, v) => MapEntry(int.parse(k), v as int)),
      totalVotes: json['total_votes'] as int,
      isFinal: json['is_final'] as bool? ?? false,
      talliedAt: DateTime.parse(json['tallied_at'] as String),
    );
  }

  @override
  List<Object?> get props =>
      [pollId, voteCounts, totalVotes, isFinal, talliedAt];
}

/// Service for poll creation, voting, and result aggregation.
///
/// Polls follow this flow:
/// 1. Owner creates a poll (broadcast as a chunk with ContentType.poll)
/// 2. Subscribers send votes upstream (encrypted, only owner sees them)
/// 3. Owner tallies votes and broadcasts results as a new chunk
/// 4. Only the owner sees individual votes; subscribers see aggregated results
class PollService {
  final ChannelService _channelService;
  final UpstreamService _upstreamService;
  final _uuid = const Uuid();

  /// In-memory vote tracking per poll (owner-side only).
  /// Key: pollId, Value: map of vote sender key -> option index.
  /// Using sender's ephemeral key as identity prevents double-voting
  /// (since we can't know the subscriber's real identity).
  final Map<String, Map<String, int>> _votesByPoll = {};

  PollService({
    required ChannelService channelService,
    required UpstreamService upstreamService,
  })  : _channelService = channelService,
        _upstreamService = upstreamService;

  // ---------------------------------------------------------------------------
  // Owner side: poll creation
  // ---------------------------------------------------------------------------

  /// Create a poll and broadcast it as a chunk.
  ///
  /// Returns the created [Poll] object and the chunks for distribution.
  Future<({Poll poll, List<Chunk> chunks})> createPoll({
    required Channel channel,
    required String question,
    required List<String> optionLabels,
    bool allowMultiple = false,
    DateTime? closesAt,
    required int sequence,
    required String routingHash,
  }) async {
    if (channel.role != ChannelRole.owner) {
      throw PollServiceException('Only the channel owner can create polls');
    }
    if (!channel.manifest.rules.pollsEnabled) {
      throw PollServiceException('Polls are disabled for this channel');
    }
    if (optionLabels.length < 2) {
      throw PollServiceException('A poll must have at least 2 options');
    }

    final pollId = 'poll_${_uuid.v4().substring(0, 8)}';

    final poll = Poll(
      pollId: pollId,
      question: question,
      options: List.generate(
        optionLabels.length,
        (i) => PollOption(index: i, label: optionLabels[i]),
      ),
      allowMultiple: allowMultiple,
      createdAt: DateTime.now(),
      closesAt: closesAt,
    );

    // Serialize the poll as a chunk payload
    final pollJson = jsonEncode(poll.toJson());
    final payload = ChunkPayload(
      type: ContentType.poll,
      payload: Uint8List.fromList(utf8.encode(pollJson)),
      metadata: {'poll_id': pollId},
      timestamp: DateTime.now(),
    );

    final chunks = await _channelService.splitIntoChunks(
      payload: payload,
      channel: channel,
      sequence: sequence,
      routingHash: routingHash,
    );

    // Initialize vote tracking
    _votesByPoll[pollId] = {};

    return (poll: poll, chunks: chunks);
  }

  // ---------------------------------------------------------------------------
  // Subscriber side: voting
  // ---------------------------------------------------------------------------

  /// Cast a vote on a poll as a subscriber.
  ///
  /// The vote is sent upstream encrypted — only the owner can see it.
  Future<UpstreamMessage> castVote({
    required Channel channel,
    required String pollId,
    required int optionIndex,
  }) async {
    if (!channel.manifest.rules.pollsEnabled) {
      throw PollServiceException('Polls are disabled for this channel');
    }

    return _upstreamService.sendVote(
      channel: channel,
      pollId: pollId,
      optionIndex: optionIndex,
    );
  }

  // ---------------------------------------------------------------------------
  // Owner side: vote tallying
  // ---------------------------------------------------------------------------

  /// Record a vote (owner-side, called when an upstream vote is decrypted).
  ///
  /// [senderKey] is used to prevent double-voting by the same sender.
  /// Returns true if the vote was recorded (false if duplicate).
  bool recordVote({
    required String pollId,
    required int optionIndex,
    required String senderKey,
  }) {
    final votes = _votesByPoll[pollId];
    if (votes == null) return false;

    // Check for duplicate vote from this sender
    if (votes.containsKey(senderKey)) return false;

    votes[senderKey] = optionIndex;
    return true;
  }

  /// Tally votes for a poll and create broadcast-ready results.
  ///
  /// Returns the [PollResults] and chunks for distribution.
  Future<({PollResults results, List<Chunk> chunks})> tallyAndBroadcast({
    required Channel channel,
    required Poll poll,
    required int sequence,
    required String routingHash,
    bool isFinal = false,
  }) async {
    if (channel.role != ChannelRole.owner) {
      throw PollServiceException('Only the channel owner can tally votes');
    }

    final votes = _votesByPoll[poll.pollId] ?? {};

    // Count votes per option
    final voteCounts = <int, int>{};
    for (final option in poll.options) {
      voteCounts[option.index] = 0;
    }
    for (final optionIndex in votes.values) {
      voteCounts[optionIndex] = (voteCounts[optionIndex] ?? 0) + 1;
    }

    final results = PollResults(
      pollId: poll.pollId,
      voteCounts: voteCounts,
      totalVotes: votes.length,
      isFinal: isFinal,
      talliedAt: DateTime.now(),
    );

    // Broadcast results as a chunk
    final resultsJson = jsonEncode(results.toJson());
    final payload = ChunkPayload(
      type: ContentType.poll,
      payload: Uint8List.fromList(utf8.encode(resultsJson)),
      metadata: {
        'poll_id': poll.pollId,
        'is_results': true,
        'is_final': isFinal,
      },
      timestamp: DateTime.now(),
    );

    final chunks = await _channelService.splitIntoChunks(
      payload: payload,
      channel: channel,
      sequence: sequence,
      routingHash: routingHash,
    );

    return (results: results, chunks: chunks);
  }

  /// Get current vote count for a poll.
  int getVoteCount(String pollId) {
    return _votesByPoll[pollId]?.length ?? 0;
  }

  /// Get raw vote data for a poll (owner-only, for debugging).
  Map<String, int>? getVotes(String pollId) {
    return _votesByPoll[pollId];
  }

  /// Clear vote data for a poll.
  void clearVotes(String pollId) {
    _votesByPoll.remove(pollId);
  }
}

/// Exception thrown by poll service operations.
class PollServiceException implements Exception {
  final String message;
  PollServiceException(this.message);

  @override
  String toString() => 'PollServiceException: $message';
}
