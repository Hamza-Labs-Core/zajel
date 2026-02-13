import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/attestation/models/session_token.dart';

void main() {
  group('SessionToken', () {
    group('fromJson', () {
      test('parses complete JSON', () {
        final futureTime =
            DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch;
        final token = SessionToken.fromJson({
          'token': 'abc123',
          'expires_at': futureTime,
          'device_id': 'device-001',
        });

        expect(token.token, 'abc123');
        expect(token.deviceId, 'device-001');
        expect(token.isExpired, isFalse);
      });

      test('handles missing fields', () {
        final token = SessionToken.fromJson({});

        expect(token.token, '');
        expect(token.deviceId, '');
      });
    });

    group('toJson', () {
      test('serializes correctly', () {
        final expiresAt = DateTime.utc(2026, 6, 1);
        final token = SessionToken(
          token: 'tok123',
          expiresAt: expiresAt,
          deviceId: 'dev-1',
        );

        final json = token.toJson();
        expect(json['token'], 'tok123');
        expect(json['expires_at'], expiresAt.millisecondsSinceEpoch);
        expect(json['device_id'], 'dev-1');
      });

      test('round-trips correctly', () {
        final original = SessionToken(
          token: 'roundtrip',
          expiresAt: DateTime.utc(2026, 12, 31),
          deviceId: 'device-rt',
        );

        final json = original.toJson();
        final restored = SessionToken.fromJson(json);

        expect(restored.token, original.token);
        expect(restored.deviceId, original.deviceId);
        expect(
          restored.expiresAt.millisecondsSinceEpoch,
          original.expiresAt.millisecondsSinceEpoch,
        );
      });
    });

    group('isExpired', () {
      test('returns false for future expiration', () {
        final token = SessionToken(
          token: 'valid',
          expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
          deviceId: 'dev',
        );
        expect(token.isExpired, isFalse);
      });

      test('returns true for past expiration', () {
        final token = SessionToken(
          token: 'expired',
          expiresAt: DateTime.now().toUtc().subtract(const Duration(hours: 1)),
          deviceId: 'dev',
        );
        expect(token.isExpired, isTrue);
      });
    });

    group('isValid', () {
      test('returns true for non-expired token with content', () {
        final token = SessionToken(
          token: 'valid-token',
          expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
          deviceId: 'dev',
        );
        expect(token.isValid, isTrue);
      });

      test('returns false for expired token', () {
        final token = SessionToken(
          token: 'expired-token',
          expiresAt: DateTime.now().toUtc().subtract(const Duration(hours: 1)),
          deviceId: 'dev',
        );
        expect(token.isValid, isFalse);
      });

      test('returns false for empty token string', () {
        final token = SessionToken(
          token: '',
          expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
          deviceId: 'dev',
        );
        expect(token.isValid, isFalse);
      });
    });

    group('timeRemaining', () {
      test('returns positive duration for future expiration', () {
        final token = SessionToken(
          token: 'tok',
          expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 30)),
          deviceId: 'dev',
        );
        expect(token.timeRemaining.inMinutes, greaterThan(25));
      });

      test('returns negative duration for past expiration', () {
        final token = SessionToken(
          token: 'tok',
          expiresAt:
              DateTime.now().toUtc().subtract(const Duration(minutes: 30)),
          deviceId: 'dev',
        );
        expect(token.timeRemaining.isNegative, isTrue);
      });
    });

    test('toString includes relevant info', () {
      final token = SessionToken(
        token: 'tok',
        expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
        deviceId: 'my-device',
      );
      final str = token.toString();
      expect(str, contains('my-device'));
    });
  });
}
