import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/attestation/models/build_token.dart';

void main() {
  group('BuildToken', () {
    group('fromJson', () {
      test('creates token from complete JSON', () {
        final token = BuildToken.fromJson({
          'version': '1.2.0',
          'platform': 'android',
          'build_hash': 'abc123def456',
          'timestamp': 1700000000000,
          'signature': 'sig123base64==',
        });

        expect(token.version, '1.2.0');
        expect(token.platform, 'android');
        expect(token.buildHash, 'abc123def456');
        expect(token.timestamp, 1700000000000);
        expect(token.signature, 'sig123base64==');
      });

      test('handles missing fields with defaults', () {
        final token = BuildToken.fromJson({});

        expect(token.version, '');
        expect(token.platform, '');
        expect(token.buildHash, '');
        expect(token.timestamp, 0);
        expect(token.signature, '');
      });
    });

    group('toJson', () {
      test('serializes to JSON correctly', () {
        const token = BuildToken(
          version: '1.0.0',
          platform: 'linux',
          buildHash: 'hash123',
          timestamp: 1700000000000,
          signature: 'sig456',
        );

        final json = token.toJson();
        expect(json['version'], '1.0.0');
        expect(json['platform'], 'linux');
        expect(json['build_hash'], 'hash123');
        expect(json['timestamp'], 1700000000000);
        expect(json['signature'], 'sig456');
      });
    });

    group('fromBase64', () {
      test('parses valid base64-encoded JSON', () {
        const original = BuildToken(
          version: '2.0.0',
          platform: 'ios',
          buildHash: 'ioshash',
          timestamp: 1700000000000,
          signature: 'iossig',
        );

        final encoded = original.toBase64();
        final parsed = BuildToken.fromBase64(encoded);

        expect(parsed, isNotNull);
        expect(parsed!.version, '2.0.0');
        expect(parsed.platform, 'ios');
        expect(parsed.buildHash, 'ioshash');
      });

      test('returns null for empty string', () {
        expect(BuildToken.fromBase64(''), isNull);
      });

      test('returns null for invalid base64', () {
        expect(BuildToken.fromBase64('not-valid-base64!!!'), isNull);
      });

      test('returns null for valid base64 but invalid JSON', () {
        final notJson = base64Encode(utf8.encode('not json'));
        expect(BuildToken.fromBase64(notJson), isNull);
      });
    });

    group('toBase64', () {
      test('round-trips correctly', () {
        const token = BuildToken(
          version: '1.0.0',
          platform: 'android',
          buildHash: 'hash',
          timestamp: 123456,
          signature: 'sig',
        );

        final encoded = token.toBase64();
        final decoded = BuildToken.fromBase64(encoded);

        expect(decoded, isNotNull);
        expect(decoded!.version, token.version);
        expect(decoded.platform, token.platform);
        expect(decoded.buildHash, token.buildHash);
        expect(decoded.timestamp, token.timestamp);
        expect(decoded.signature, token.signature);
      });
    });

    group('isValid', () {
      test('returns true when all fields are populated', () {
        const token = BuildToken(
          version: '1.0.0',
          platform: 'android',
          buildHash: 'hash',
          timestamp: 1,
          signature: 'sig',
        );
        expect(token.isValid, isTrue);
      });

      test('returns false when version is empty', () {
        const token = BuildToken(
          version: '',
          platform: 'android',
          buildHash: 'hash',
          timestamp: 1,
          signature: 'sig',
        );
        expect(token.isValid, isFalse);
      });

      test('returns false when platform is empty', () {
        const token = BuildToken(
          version: '1.0.0',
          platform: '',
          buildHash: 'hash',
          timestamp: 1,
          signature: 'sig',
        );
        expect(token.isValid, isFalse);
      });

      test('returns false when buildHash is empty', () {
        const token = BuildToken(
          version: '1.0.0',
          platform: 'android',
          buildHash: '',
          timestamp: 1,
          signature: 'sig',
        );
        expect(token.isValid, isFalse);
      });

      test('returns false when timestamp is zero', () {
        const token = BuildToken(
          version: '1.0.0',
          platform: 'android',
          buildHash: 'hash',
          timestamp: 0,
          signature: 'sig',
        );
        expect(token.isValid, isFalse);
      });

      test('returns false when signature is empty', () {
        const token = BuildToken(
          version: '1.0.0',
          platform: 'android',
          buildHash: 'hash',
          timestamp: 1,
          signature: '',
        );
        expect(token.isValid, isFalse);
      });
    });

    test('toString includes version and platform', () {
      const token = BuildToken(
        version: '1.0.0',
        platform: 'linux',
        buildHash: 'hash',
        timestamp: 12345,
        signature: 'sig',
      );
      final str = token.toString();
      expect(str, contains('1.0.0'));
      expect(str, contains('linux'));
    });
  });
}
