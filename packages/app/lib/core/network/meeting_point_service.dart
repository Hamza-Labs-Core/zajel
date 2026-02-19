import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

import 'meeting_points.dart';

/// Service for deriving deterministic meeting points between two peers.
///
/// Meeting points allow two peers to find each other on the signaling server
/// without revealing their relationship to the server (beyond the meeting point itself).
///
/// The service derives:
/// - Daily meeting points from two public keys (3-day window)
/// - Hourly tokens from shared secrets (3-hour window)
class MeetingPointService {
  /// Derive daily meeting points from two public keys.
  ///
  /// Returns 3 points: yesterday, today, tomorrow (UTC).
  /// Both peers compute the same points regardless of who calls first.
  List<String> deriveDailyPoints(
      Uint8List myPublicKey, Uint8List theirPublicKey) {
    return deriveDailyPointsForDate(
        myPublicKey, theirPublicKey, DateTime.now().toUtc());
  }

  /// Derive daily meeting points for a specific date (for testing).
  List<String> deriveDailyPointsForDate(
    Uint8List myPublicKey,
    Uint8List theirPublicKey,
    DateTime date,
  ) {
    // Sort keys to ensure same order regardless of who computes
    final sorted = sortKeys(myPublicKey, theirPublicKey);
    final points = <String>[];

    // Generate for yesterday, today, tomorrow
    for (var dayOffset = -1; dayOffset <= 1; dayOffset++) {
      final targetDate = date.add(Duration(days: dayOffset));
      final dateStr = _formatDate(targetDate);

      // Concatenate: sorted_key_1 || sorted_key_2 || "zajel:daily:" || date
      final input = Uint8List.fromList([
        ...sorted.$1,
        ...sorted.$2,
        ...utf8.encode('zajel:daily:$dateStr'),
      ]);

      final hash = _sha256Hash(input);
      points.add('day_${_hashToToken(hash)}');
    }

    return points;
  }

  /// Derive hourly tokens from a shared secret.
  ///
  /// Returns 3 tokens: previous hour, current hour, next hour (UTC).
  /// More frequent rotation for better privacy, used for live matching.
  List<String> deriveHourlyTokens(Uint8List sharedSecret) {
    return deriveHourlyTokensForTime(sharedSecret, DateTime.now().toUtc());
  }

  /// Derive hourly tokens for a specific time (for testing).
  List<String> deriveHourlyTokensForTime(
      Uint8List sharedSecret, DateTime time) {
    final currentHour =
        DateTime.utc(time.year, time.month, time.day, time.hour);
    final tokens = <String>[];

    for (var hourOffset = -1; hourOffset <= 1; hourOffset++) {
      final targetHour = currentHour.add(Duration(hours: hourOffset));
      // Format: "2024-01-15T10" (hour precision)
      final hourStr = targetHour.toIso8601String().substring(0, 13);

      // HMAC with shared secret
      final hash =
          _hmacSha256(sharedSecret, utf8.encode('zajel:hourly:$hourStr'));

      tokens.add('hr_${_hashToToken(hash)}');
    }

    return tokens;
  }

  /// Derive daily meeting points from two stable IDs.
  ///
  /// Unlike [deriveDailyPoints] which uses public key bytes, this uses
  /// persistent stable IDs that survive key rotation. Both peers compute
  /// the same points regardless of who calls first.
  List<String> deriveDailyPointsFromIds(
      String myStableId, String peerStableId) {
    return deriveDailyPointsFromIdsForDate(
        myStableId, peerStableId, DateTime.now().toUtc());
  }

  /// Derive daily meeting points from stable IDs for a specific date (for testing).
  List<String> deriveDailyPointsFromIdsForDate(
    String myStableId,
    String peerStableId,
    DateTime date,
  ) {
    // Sort IDs lexicographically so both sides get same result
    final sorted = [myStableId, peerStableId]..sort();
    final points = <String>[];

    for (var dayOffset = -1; dayOffset <= 1; dayOffset++) {
      final targetDate = date.add(Duration(days: dayOffset));
      final dateStr = _formatDate(targetDate);

      // Concatenate: sorted_id_1 || sorted_id_2 || "zajel:daily:" || date
      final input = Uint8List.fromList([
        ...utf8.encode(sorted[0]),
        ...utf8.encode(sorted[1]),
        ...utf8.encode('zajel:daily:$dateStr'),
      ]);

      final hash = _sha256Hash(input);
      points.add('day_${_hashToToken(hash)}');
    }

    return points;
  }

  /// Get all meeting points for a peer using stable IDs.
  ///
  /// Combines stableId-based daily points and hourly tokens (from shared secret).
  MeetingPoints getMeetingPointsFromIds({
    required String myStableId,
    required String peerStableId,
    Uint8List? sharedSecret,
  }) {
    return MeetingPoints(
      dailyPoints: deriveDailyPointsFromIds(myStableId, peerStableId),
      hourlyTokens:
          sharedSecret != null ? deriveHourlyTokens(sharedSecret) : [],
    );
  }

  /// Sort two keys deterministically (lexicographic comparison).
  ///
  /// This ensures both peers compute the same meeting point regardless
  /// of which key is "mine" vs "theirs".
  (Uint8List, Uint8List) sortKeys(Uint8List a, Uint8List b) {
    for (var i = 0; i < a.length && i < b.length; i++) {
      if (a[i] < b[i]) return (a, b);
      if (a[i] > b[i]) return (b, a);
    }
    // Equal or one is prefix of other - use length as tiebreaker
    if (a.length <= b.length) return (a, b);
    return (b, a);
  }

  /// Get all meeting points for a peer.
  ///
  /// Combines daily points (from public keys) and hourly tokens (from shared secret).
  MeetingPoints getMeetingPoints({
    required Uint8List myPublicKey,
    required Uint8List theirPublicKey,
    Uint8List? sharedSecret,
  }) {
    return MeetingPoints(
      dailyPoints: deriveDailyPoints(myPublicKey, theirPublicKey),
      hourlyTokens:
          sharedSecret != null ? deriveHourlyTokens(sharedSecret) : [],
    );
  }

  /// Check if a given meeting point matches any in the provided set.
  ///
  /// Returns the match details if found, null otherwise.
  MeetingPointMatch? findMatch(
    String meetingPoint,
    MeetingPoints points,
    String peerId,
  ) {
    // Check daily points
    for (final point in points.dailyPoints) {
      if (point == meetingPoint) {
        return MeetingPointMatch(
          peerId: peerId,
          meetingPoint: meetingPoint,
          type: MeetingPointType.daily,
          matchedAt: DateTime.now().toUtc(),
        );
      }
    }

    // Check hourly tokens
    for (final token in points.hourlyTokens) {
      if (token == meetingPoint) {
        return MeetingPointMatch(
          peerId: peerId,
          meetingPoint: meetingPoint,
          type: MeetingPointType.hourly,
          matchedAt: DateTime.now().toUtc(),
        );
      }
    }

    return null;
  }

  /// Format date as "YYYY-MM-DD" for consistent hashing.
  String _formatDate(DateTime date) {
    final y = date.year.toString();
    final m = date.month.toString().padLeft(2, '0');
    final d = date.day.toString().padLeft(2, '0');
    return '$y-$m-$d';
  }

  /// Compute SHA-256 hash synchronously.
  List<int> _sha256Hash(Uint8List input) {
    // Use DartSha256 for synchronous hashing
    const algorithm = DartSha256();
    final hash = algorithm.hashSync(input);
    return hash.bytes;
  }

  /// Compute HMAC-SHA256 synchronously.
  List<int> _hmacSha256(Uint8List key, List<int> message) {
    // Use DartHmac for synchronous HMAC
    final algorithm = DartHmac(const DartSha256());
    final mac = algorithm.calculateMacSync(
      message,
      secretKeyData: SecretKeyData(key),
      nonce: const [],
    );
    return mac.bytes;
  }

  /// Convert hash bytes to URL-safe token string.
  String _hashToToken(List<int> bytes) {
    return base64Url.encode(bytes).substring(0, 22).replaceAll('=', '');
  }
}

/// Exception thrown when meeting point derivation fails.
class MeetingPointException implements Exception {
  final String message;

  MeetingPointException(this.message);

  @override
  String toString() => 'MeetingPointException: $message';
}
