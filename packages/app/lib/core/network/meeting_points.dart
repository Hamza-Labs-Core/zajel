import 'package:equatable/equatable.dart';

/// Container for all meeting points for a peer relationship.
///
/// Meeting points allow two peers to find each other on the signaling server
/// without revealing their relationship to the server (beyond the meeting point itself).
class MeetingPoints extends Equatable {
  /// Daily meeting points derived from both peers' public keys.
  ///
  /// Contains 3 points: yesterday, today, tomorrow (UTC).
  /// These provide a 3-day window for peers to find each other.
  final List<String> dailyPoints;

  /// Hourly tokens derived from shared secret.
  ///
  /// Contains 3 tokens: previous hour, current hour, next hour (UTC).
  /// These provide more frequent rotation for better privacy during live matching.
  final List<String> hourlyTokens;

  const MeetingPoints({
    required this.dailyPoints,
    required this.hourlyTokens,
  });

  /// Empty meeting points (no peer relationship).
  const MeetingPoints.empty()
      : dailyPoints = const [],
        hourlyTokens = const [];

  /// All points combined (for registration with signaling server).
  List<String> get all => [...dailyPoints, ...hourlyTokens];

  /// Whether this contains any meeting points.
  bool get isEmpty => dailyPoints.isEmpty && hourlyTokens.isEmpty;

  /// Whether this contains meeting points.
  bool get isNotEmpty => !isEmpty;

  /// Get yesterday's daily point.
  String? get yesterdayPoint => dailyPoints.isNotEmpty ? dailyPoints[0] : null;

  /// Get today's daily point.
  String? get todayPoint => dailyPoints.length > 1 ? dailyPoints[1] : null;

  /// Get tomorrow's daily point.
  String? get tomorrowPoint => dailyPoints.length > 2 ? dailyPoints[2] : null;

  /// Get previous hour's token.
  String? get previousHourToken =>
      hourlyTokens.isNotEmpty ? hourlyTokens[0] : null;

  /// Get current hour's token.
  String? get currentHourToken =>
      hourlyTokens.length > 1 ? hourlyTokens[1] : null;

  /// Get next hour's token.
  String? get nextHourToken => hourlyTokens.length > 2 ? hourlyTokens[2] : null;

  @override
  List<Object?> get props => [dailyPoints, hourlyTokens];

  @override
  String toString() =>
      'MeetingPoints(daily: $dailyPoints, hourly: $hourlyTokens)';
}

/// Result of checking for a peer match at a meeting point.
class MeetingPointMatch extends Equatable {
  /// The peer ID that was matched.
  final String peerId;

  /// The meeting point where the match occurred.
  final String meetingPoint;

  /// Whether this was a daily point or hourly token match.
  final MeetingPointType type;

  /// Timestamp of the match.
  final DateTime matchedAt;

  const MeetingPointMatch({
    required this.peerId,
    required this.meetingPoint,
    required this.type,
    required this.matchedAt,
  });

  @override
  List<Object?> get props => [peerId, meetingPoint, type, matchedAt];

  @override
  String toString() =>
      'MeetingPointMatch(peerId: $peerId, point: $meetingPoint, type: $type)';
}

/// Type of meeting point.
enum MeetingPointType {
  /// Daily meeting point derived from public keys.
  daily,

  /// Hourly token derived from shared secret.
  hourly,
}
