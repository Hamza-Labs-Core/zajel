import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/meeting_point_service.dart';

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
        final pointsTomorrow =
            service.deriveDailyPointsForDate(keyA, keyB, tomorrow);

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

    group('sortKeys', () {
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

      final pointsBefore =
          service.deriveDailyPointsForDate(keyA, keyB, beforeMidnight);
      final pointsAfter =
          service.deriveDailyPointsForDate(keyA, keyB, afterMidnight);

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

    test('hourly tokens at hour boundary', () {
      final secret = Uint8List.fromList(List.generate(32, (i) => i));

      // Just before hour change
      final before = DateTime.utc(2024, 1, 15, 10, 59, 59);
      // Just after hour change
      final after = DateTime.utc(2024, 1, 15, 11, 0, 0);

      final tokensBefore = service.deriveHourlyTokensForTime(secret, before);
      final tokensAfter = service.deriveHourlyTokensForTime(secret, after);

      // Before's "next" should equal after's "current"
      expect(tokensBefore[2], equals(tokensAfter[1]));
    });

    test('tokens across day boundary', () {
      final secret = Uint8List.fromList(List.generate(32, (i) => i));

      // 23:00 on Jan 15
      final beforeMidnight = DateTime.utc(2024, 1, 15, 23, 0);
      // 00:00 on Jan 16
      final afterMidnight = DateTime.utc(2024, 1, 16, 0, 0);

      final tokensBefore =
          service.deriveHourlyTokensForTime(secret, beforeMidnight);
      final tokensAfter =
          service.deriveHourlyTokensForTime(secret, afterMidnight);

      // Before's "next" should equal after's "current"
      expect(tokensBefore[2], equals(tokensAfter[1]));
    });
  });

  group('MeetingPointService deriveDailyPointsFromIds', () {
    late MeetingPointService service;

    setUp(() {
      service = MeetingPointService();
    });

    test('should return 3 points (yesterday, today, tomorrow)', () {
      final points = service.deriveDailyPointsFromIds('abc123def456ab01', 'ff00ee11dd22cc33');
      expect(points.length, 3);
      expect(points.every((p) => p.startsWith('day_')), true);
    });

    test('should return same points regardless of ID order', () {
      final points1 = service.deriveDailyPointsFromIds('idA', 'idB');
      final points2 = service.deriveDailyPointsFromIds('idB', 'idA');
      expect(points1, equals(points2));
    });

    test('should return different points for different ID pairs', () {
      final pointsAB = service.deriveDailyPointsFromIds('idA', 'idB');
      final pointsAC = service.deriveDailyPointsFromIds('idA', 'idC');
      expect(pointsAB, isNot(equals(pointsAC)));
    });

    test('should produce deterministic output', () {
      final points1 = service.deriveDailyPointsFromIds('myId', 'peerId');
      final points2 = service.deriveDailyPointsFromIds('myId', 'peerId');
      expect(points1, equals(points2));
    });

    test('should return different points on different days', () {
      final today = DateTime.utc(2026, 2, 18);
      final tomorrow = DateTime.utc(2026, 2, 19);

      final pointsToday = service.deriveDailyPointsFromIdsForDate('a', 'b', today);
      final pointsTomorrow = service.deriveDailyPointsFromIdsForDate('a', 'b', tomorrow);

      // Today's "today" point should equal tomorrow's "yesterday" point
      expect(pointsToday[1], equals(pointsTomorrow[0]));
    });

    test('should differ from pubkey-based points for same peer relationship', () {
      // StableId-based and pubkey-based points should NOT collide
      final keyA = Uint8List.fromList(List.generate(32, (i) => i));
      final keyB = Uint8List.fromList(List.generate(32, (i) => i + 100));
      final date = DateTime.utc(2026, 2, 18);

      final pubkeyPoints = service.deriveDailyPointsForDate(keyA, keyB, date);
      final stableIdPoints = service.deriveDailyPointsFromIdsForDate(
          'abc123', 'def456', date);

      expect(pubkeyPoints, isNot(equals(stableIdPoints)));
    });

    test('should produce tokens of expected length', () {
      final points = service.deriveDailyPointsFromIds('testId1', 'testId2');
      for (final point in points) {
        expect(point.length, greaterThan(20));
        expect(point.length, lessThan(30));
      }
    });

    test('getMeetingPointsFromIds combines daily + hourly', () {
      final secret = Uint8List.fromList(List.generate(32, (i) => i * 3));
      final mp = service.getMeetingPointsFromIds(
        myStableId: 'alice123',
        peerStableId: 'bob456',
        sharedSecret: secret,
      );
      expect(mp.dailyPoints.length, 3);
      expect(mp.hourlyTokens.length, 3);
      expect(mp.all.length, 6);
    });

    test('getMeetingPointsFromIds with no shared secret has empty hourly', () {
      final mp = service.getMeetingPointsFromIds(
        myStableId: 'alice123',
        peerStableId: 'bob456',
      );
      expect(mp.dailyPoints.length, 3);
      expect(mp.hourlyTokens, isEmpty);
    });

    test('cross-client: matches Python implementation for known inputs', () {
      // Reference values computed by Python headless client:
      // ids sorted: ['abc123def456ab01', 'ff00ee11dd22cc33']
      // hash_input = ids[0].encode() + ids[1].encode() + 'zajel:daily:YYYY-MM-DD'.encode()
      final date = DateTime.utc(2026, 2, 18);
      final points = service.deriveDailyPointsFromIdsForDate(
        'abc123def456ab01',
        'ff00ee11dd22cc33',
        date,
      );

      expect(points[0], 'day_G_F73XDi8LCI3RzZLAC3LY'); // yesterday 2026-02-17
      expect(points[1], 'day_YgtUz6-JOPCoVxUJxbpWZP');  // today 2026-02-18
      expect(points[2], 'day_j10jaAgvCBpAniDcXQCWHH');  // tomorrow 2026-02-19
    });

    test('cross-client: order-independent (reversed IDs same result)', () {
      final date = DateTime.utc(2026, 2, 18);
      final points1 = service.deriveDailyPointsFromIdsForDate(
        'abc123def456ab01', 'ff00ee11dd22cc33', date);
      final points2 = service.deriveDailyPointsFromIdsForDate(
        'ff00ee11dd22cc33', 'abc123def456ab01', date);
      expect(points1, equals(points2));
    });
  });
}
