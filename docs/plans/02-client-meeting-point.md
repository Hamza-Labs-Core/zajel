# Client Implementation Plan: Meeting Point Service

## Overview
Implement the meeting point derivation service that computes deterministic meeting points from:
1. Public keys (daily meeting points)
2. Shared secrets (hourly tokens)

## Architecture

```
MeetingPointService
├── deriveDailyPoints(myPubkey, theirPubkey) → List<String>
├── deriveHourlyTokens(sharedSecret) → List<String>
└── Private helpers
    ├── _sortKeys(a, b) → (first, second)
    ├── _formatDate(date) → String
    └── _hashToToken(bytes, prefix) → String
```

## TDD Test Cases

### 1. Daily Meeting Point Tests

```dart
// test/core/network/meeting_point_service_test.dart

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/meeting_point_service.dart';
import 'dart:typed_data';

void main() {
  group('MeetingPointService', () {
    late MeetingPointService service;

    setUp(() {
      service = MeetingPointService();
    });

    group('deriveDailyPoints', () {
      test('should return 3 points (yesterday, today, tomorrow)', () {
        final myKey = Uint8List.fromList(List.generate(32, (i) => i));
        final theirKey = Uint8List.fromList(List.generate(32, (i) => i + 100));

        final points = service.deriveDailyPoints(myKey, theirKey);

        expect(points.length, 3);
        expect(points.every((p) => p.startsWith('day_')), true);
      });

      test('should return same points regardless of key order', () {
        final keyA = Uint8List.fromList(List.generate(32, (i) => i));
        final keyB = Uint8List.fromList(List.generate(32, (i) => i + 100));

        final points1 = service.deriveDailyPoints(keyA, keyB);
        final points2 = service.deriveDailyPoints(keyB, keyA);

        expect(points1, equals(points2));
      });

      test('should return different points for different key pairs', () {
        final keyA = Uint8List.fromList(List.generate(32, (i) => i));
        final keyB = Uint8List.fromList(List.generate(32, (i) => i + 100));
        final keyC = Uint8List.fromList(List.generate(32, (i) => i + 200));

        final pointsAB = service.deriveDailyPoints(keyA, keyB);
        final pointsAC = service.deriveDailyPoints(keyA, keyC);

        expect(pointsAB, isNot(equals(pointsAC)));
      });

      test('should return different points on different days', () {
        final keyA = Uint8List.fromList(List.generate(32, (i) => i));
        final keyB = Uint8List.fromList(List.generate(32, (i) => i + 100));

        // Mock different dates
        final today = DateTime.utc(2024, 1, 15);
        final tomorrow = DateTime.utc(2024, 1, 16);

        final pointsToday = service.deriveDailyPointsForDate(keyA, keyB, today);
        final pointsTomorrow = service.deriveDailyPointsForDate(keyA, keyB, tomorrow);

        // Today's "today" point should equal tomorrow's "yesterday" point
        expect(pointsToday[1], equals(pointsTomorrow[0]));
      });

      test('should produce deterministic output', () {
        final keyA = Uint8List.fromList(List.generate(32, (i) => i));
        final keyB = Uint8List.fromList(List.generate(32, (i) => i + 100));

        final points1 = service.deriveDailyPoints(keyA, keyB);
        final points2 = service.deriveDailyPoints(keyA, keyB);

        expect(points1, equals(points2));
      });

      test('should produce tokens of expected length', () {
        final keyA = Uint8List.fromList(List.generate(32, (i) => i));
        final keyB = Uint8List.fromList(List.generate(32, (i) => i + 100));

        final points = service.deriveDailyPoints(keyA, keyB);

        for (final point in points) {
          expect(point.length, greaterThan(20));
          expect(point.length, lessThan(30));
        }
      });
    });

    group('deriveHourlyTokens', () {
      test('should return 3 tokens (prev, current, next hour)', () {
        final secret = Uint8List.fromList(List.generate(32, (i) => i * 2));

        final tokens = service.deriveHourlyTokens(secret);

        expect(tokens.length, 3);
        expect(tokens.every((t) => t.startsWith('hr_')), true);
      });

      test('should return same tokens for same secret in same hour', () {
        final secret = Uint8List.fromList(List.generate(32, (i) => i * 2));

        final tokens1 = service.deriveHourlyTokens(secret);
        final tokens2 = service.deriveHourlyTokens(secret);

        expect(tokens1, equals(tokens2));
      });

      test('should return different tokens for different secrets', () {
        final secret1 = Uint8List.fromList(List.generate(32, (i) => i));
        final secret2 = Uint8List.fromList(List.generate(32, (i) => i + 50));

        final tokens1 = service.deriveHourlyTokens(secret1);
        final tokens2 = service.deriveHourlyTokens(secret2);

        expect(tokens1, isNot(equals(tokens2)));
      });

      test('should have overlap for consecutive hours', () {
        final secret = Uint8List.fromList(List.generate(32, (i) => i * 2));

        final hour1 = DateTime.utc(2024, 1, 15, 10);
        final hour2 = DateTime.utc(2024, 1, 15, 11);

        final tokens1 = service.deriveHourlyTokensForTime(secret, hour1);
        final tokens2 = service.deriveHourlyTokensForTime(secret, hour2);

        // tokens1's "next" should equal tokens2's "current"
        expect(tokens1[2], equals(tokens2[1]));
        // tokens1's "current" should equal tokens2's "prev"
        expect(tokens1[1], equals(tokens2[0]));
      });
    });

    group('_sortKeys', () {
      test('should sort keys deterministically', () {
        final keyA = Uint8List.fromList([1, 2, 3, 4]);
        final keyB = Uint8List.fromList([5, 6, 7, 8]);

        final sorted1 = service.sortKeys(keyA, keyB);
        final sorted2 = service.sortKeys(keyB, keyA);

        expect(sorted1, equals(sorted2));
      });

      test('should handle keys with same prefix', () {
        final keyA = Uint8List.fromList([1, 2, 3, 4]);
        final keyB = Uint8List.fromList([1, 2, 3, 5]);

        final sorted = service.sortKeys(keyA, keyB);

        expect(sorted.$1, equals(keyA)); // 4 < 5
        expect(sorted.$2, equals(keyB));
      });
    });
  });
}
```

### 2. Edge Case Tests

```dart
// test/core/network/meeting_point_edge_cases_test.dart

void main() {
  group('MeetingPointService Edge Cases', () {
    late MeetingPointService service;

    setUp(() {
      service = MeetingPointService();
    });

    test('should handle timezone edge case (midnight UTC)', () {
      final keyA = Uint8List.fromList(List.generate(32, (i) => i));
      final keyB = Uint8List.fromList(List.generate(32, (i) => i + 100));

      // Just before midnight
      final beforeMidnight = DateTime.utc(2024, 1, 15, 23, 59);
      // Just after midnight
      final afterMidnight = DateTime.utc(2024, 1, 16, 0, 1);

      final pointsBefore = service.deriveDailyPointsForDate(keyA, keyB, beforeMidnight);
      final pointsAfter = service.deriveDailyPointsForDate(keyA, keyB, afterMidnight);

      // Should have overlap (Jan 15's tomorrow = Jan 16's today)
      expect(pointsBefore[2], equals(pointsAfter[1]));
    });

    test('should handle DST transition', () {
      // This test ensures UTC is used internally
      final keyA = Uint8List.fromList(List.generate(32, (i) => i));
      final keyB = Uint8List.fromList(List.generate(32, (i) => i + 100));

      // During DST transition (US spring forward)
      final dstDay = DateTime.utc(2024, 3, 10, 12, 0);

      final points = service.deriveDailyPointsForDate(keyA, keyB, dstDay);

      expect(points.length, 3);
      expect(points.every((p) => p.isNotEmpty), true);
    });

    test('should handle identical keys gracefully', () {
      final key = Uint8List.fromList(List.generate(32, (i) => i));

      // Same key twice - edge case, shouldn't happen in practice
      final points = service.deriveDailyPoints(key, key);

      // Should still produce valid points
      expect(points.length, 3);
    });

    test('should handle empty-ish keys', () {
      final zeroKey = Uint8List(32); // All zeros
      final otherKey = Uint8List.fromList(List.generate(32, (i) => i + 1));

      final points = service.deriveDailyPoints(zeroKey, otherKey);

      expect(points.length, 3);
      expect(points.every((p) => p.startsWith('day_')), true);
    });
  });
}
```

## Implementation

```dart
// lib/core/network/meeting_point_service.dart

import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';

/// Service for deriving deterministic meeting points between two peers.
///
/// Meeting points allow two peers to find each other on the signaling server
/// without revealing their relationship to the server (beyond the meeting point itself).
class MeetingPointService {

  /// Derive daily meeting points from two public keys.
  ///
  /// Returns 3 points: yesterday, today, tomorrow (UTC).
  /// Both peers compute the same points regardless of who calls first.
  List<String> deriveDailyPoints(Uint8List myPublicKey, Uint8List theirPublicKey) {
    return deriveDailyPointsForDate(myPublicKey, theirPublicKey, DateTime.now().toUtc());
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

      final hash = sha256.convert(input);
      points.add('day_${_hashToToken(hash.bytes)}');
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
  List<String> deriveHourlyTokensForTime(Uint8List sharedSecret, DateTime time) {
    final currentHour = DateTime.utc(time.year, time.month, time.day, time.hour);
    final tokens = <String>[];

    for (var hourOffset = -1; hourOffset <= 1; hourOffset++) {
      final targetHour = currentHour.add(Duration(hours: hourOffset));
      // Format: "2024-01-15T10" (hour precision)
      final hourStr = targetHour.toIso8601String().substring(0, 13);

      // HMAC with shared secret
      final hmac = Hmac(sha256, sharedSecret);
      final hash = hmac.convert(utf8.encode('zajel:hourly:$hourStr'));

      tokens.add('hr_${_hashToToken(hash.bytes)}');
    }

    return tokens;
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

  /// Format date as "YYYY-MM-DD" for consistent hashing.
  String _formatDate(DateTime date) {
    final y = date.year.toString();
    final m = date.month.toString().padLeft(2, '0');
    final d = date.day.toString().padLeft(2, '0');
    return '$y-$m-$d';
  }

  /// Convert hash bytes to URL-safe token string.
  String _hashToToken(List<int> bytes) {
    return base64Url.encode(bytes).substring(0, 22).replaceAll('=', '');
  }
}
```

## Integration with TrustedPeers

```dart
// lib/core/network/meeting_point_service.dart (extended)

/// Extension to work with TrustedPeersStorage
extension MeetingPointServiceExtension on MeetingPointService {

  /// Get all meeting points for a trusted peer.
  Future<MeetingPoints> getMeetingPointsForPeer(
    String peerId,
    CryptoService crypto,
    TrustedPeersStorage trustedPeers,
  ) async {
    final myPublicKey = await crypto.getPublicKeyBytes();
    final theirPublicKey = await trustedPeers.getPublicKeyBytes(peerId);
    final sharedSecret = await crypto.getSessionKeyBytes(peerId);

    if (theirPublicKey == null) {
      throw Exception('Peer $peerId not found in trusted peers');
    }

    return MeetingPoints(
      dailyPoints: deriveDailyPoints(myPublicKey, theirPublicKey),
      hourlyTokens: sharedSecret != null
          ? deriveHourlyTokens(sharedSecret)
          : [],
    );
  }
}

/// Container for all meeting points for a peer relationship.
class MeetingPoints {
  final List<String> dailyPoints;
  final List<String> hourlyTokens;

  MeetingPoints({
    required this.dailyPoints,
    required this.hourlyTokens,
  });

  /// All points combined (for registration).
  List<String> get all => [...dailyPoints, ...hourlyTokens];

  @override
  String toString() => 'MeetingPoints(daily: $dailyPoints, hourly: $hourlyTokens)';
}
```

## File Structure

```
packages/app/lib/core/network/
├── meeting_point_service.dart  # Main implementation
└── meeting_points.dart         # Data classes

packages/app/test/core/network/
├── meeting_point_service_test.dart
└── meeting_point_edge_cases_test.dart
```

## Commands

```bash
# Run tests
flutter test test/core/network/meeting_point_service_test.dart

# Run all network tests
flutter test test/core/network/

# Run with coverage
flutter test --coverage test/core/network/
```
