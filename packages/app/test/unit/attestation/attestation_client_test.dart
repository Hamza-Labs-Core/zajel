import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
import 'package:zajel/features/attestation/models/build_token.dart';
import 'package:zajel/features/attestation/services/attestation_client.dart';

void main() {
  group('AttestationClient', () {
    group('register', () {
      test('returns session token on successful registration', () async {
        final futureMs =
            DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch;
        final mockClient = http_testing.MockClient((request) async {
          expect(request.url.path, '/attest/register');
          expect(request.method, 'POST');

          final body = jsonDecode(request.body) as Map<String, dynamic>;
          expect(body['device_id'], 'test-device');
          expect(body['build_token'], isNotNull);

          return http.Response(
            jsonEncode({
              'session_token': {
                'token': 'session-abc',
                'expires_at': futureMs,
                'device_id': 'test-device',
              }
            }),
            200,
          );
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        const buildToken = BuildToken(
          version: '1.0.0',
          platform: 'linux',
          buildHash: 'hash',
          timestamp: 12345,
          signature: 'sig',
        );

        final token = await client.register(
          buildToken: buildToken,
          deviceId: 'test-device',
        );

        expect(token, isNotNull);
        expect(token!.token, 'session-abc');
        expect(token.deviceId, 'test-device');

        client.dispose();
      });

      test('returns null on server error', () async {
        final mockClient = http_testing.MockClient((request) async {
          return http.Response('Server Error', 500);
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        const buildToken = BuildToken(
          version: '1.0.0',
          platform: 'linux',
          buildHash: 'hash',
          timestamp: 12345,
          signature: 'sig',
        );

        final token = await client.register(
          buildToken: buildToken,
          deviceId: 'test-device',
        );

        expect(token, isNull);
        client.dispose();
      });

      test('returns null on network error', () async {
        final mockClient = http_testing.MockClient((request) async {
          throw Exception('Network error');
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        const buildToken = BuildToken(
          version: '1.0.0',
          platform: 'linux',
          buildHash: 'hash',
          timestamp: 12345,
          signature: 'sig',
        );

        final token = await client.register(
          buildToken: buildToken,
          deviceId: 'test-device',
        );

        expect(token, isNull);
        client.dispose();
      });
    });

    group('requestChallenge', () {
      test('returns challenge on success', () async {
        final mockClient = http_testing.MockClient((request) async {
          expect(request.url.path, '/attest/challenge');
          return http.Response(
            jsonEncode({
              'nonce': 'random-nonce-123',
              'regions': [
                {'offset': 1000, 'length': 4096},
                {'offset': 50000, 'length': 2048},
              ],
            }),
            200,
          );
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        final challenge = await client.requestChallenge(
          deviceId: 'dev-1',
          buildVersion: '1.0.0',
        );

        expect(challenge, isNotNull);
        expect(challenge!.nonce, 'random-nonce-123');
        expect(challenge.regions, hasLength(2));
        expect(challenge.regions[0].offset, 1000);
        expect(challenge.regions[0].length, 4096);
        expect(challenge.regions[1].offset, 50000);
        expect(challenge.regions[1].length, 2048);

        client.dispose();
      });

      test('returns null on server error', () async {
        final mockClient = http_testing.MockClient((request) async {
          return http.Response('Not Found', 404);
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        final challenge = await client.requestChallenge(
          deviceId: 'dev-1',
          buildVersion: '1.0.0',
        );

        expect(challenge, isNull);
        client.dispose();
      });
    });

    group('submitResponse', () {
      test('returns session token on valid response', () async {
        final futureMs =
            DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch;
        final mockClient = http_testing.MockClient((request) async {
          expect(request.url.path, '/attest/verify');
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          expect(body['nonce'], 'test-nonce');
          expect(body['device_id'], 'dev-1');

          return http.Response(
            jsonEncode({
              'valid': true,
              'session_token': {
                'token': 'verified-token',
                'expires_at': futureMs,
                'device_id': 'dev-1',
              }
            }),
            200,
          );
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        final token = await client.submitResponse(
          deviceId: 'dev-1',
          nonce: 'test-nonce',
          responses: [
            const ChallengeResponse(regionIndex: 0, hmac: 'hmac1'),
            const ChallengeResponse(regionIndex: 1, hmac: 'hmac2'),
          ],
        );

        expect(token, isNotNull);
        expect(token!.token, 'verified-token');
        client.dispose();
      });

      test('returns null when verification fails', () async {
        final mockClient = http_testing.MockClient((request) async {
          return http.Response(
            jsonEncode({'valid': false}),
            200,
          );
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        final token = await client.submitResponse(
          deviceId: 'dev-1',
          nonce: 'test-nonce',
          responses: [],
        );

        expect(token, isNull);
        client.dispose();
      });
    });

    group('fetchVersionPolicy', () {
      test('returns version policy on success', () async {
        final mockClient = http_testing.MockClient((request) async {
          expect(request.url.path, '/attest/versions');
          expect(request.method, 'GET');

          return http.Response(
            jsonEncode({
              'minimum_version': '1.2.0',
              'recommended_version': '1.3.0',
              'blocked_versions': ['1.1.0'],
              'sunset_date': {'1.2.0': '2026-06-01'},
            }),
            200,
          );
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        final policy = await client.fetchVersionPolicy();

        expect(policy, isNotNull);
        expect(policy!.minimumVersion, '1.2.0');
        expect(policy.recommendedVersion, '1.3.0');
        expect(policy.blockedVersions, ['1.1.0']);

        client.dispose();
      });

      test('returns null on error', () async {
        final mockClient = http_testing.MockClient((request) async {
          return http.Response('Error', 500);
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        final policy = await client.fetchVersionPolicy();
        expect(policy, isNull);
        client.dispose();
      });

      test('returns null on network error', () async {
        final mockClient = http_testing.MockClient((request) async {
          throw Exception('Connection refused');
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );

        final policy = await client.fetchVersionPolicy();
        expect(policy, isNull);
        client.dispose();
      });
    });
  });

  group('AttestationChallenge', () {
    test('fromJson parses correctly', () {
      final challenge = AttestationChallenge.fromJson({
        'nonce': 'abc',
        'regions': [
          {'offset': 100, 'length': 200},
        ],
      });

      expect(challenge.nonce, 'abc');
      expect(challenge.regions, hasLength(1));
      expect(challenge.regions[0].offset, 100);
      expect(challenge.regions[0].length, 200);
    });

    test('fromJson handles missing fields', () {
      final challenge = AttestationChallenge.fromJson({});
      expect(challenge.nonce, '');
      expect(challenge.regions, isEmpty);
    });
  });

  group('ChallengeRegion', () {
    test('fromJson parses correctly', () {
      final region = ChallengeRegion.fromJson({
        'offset': 4096,
        'length': 2048,
      });
      expect(region.offset, 4096);
      expect(region.length, 2048);
    });

    test('fromJson handles missing fields', () {
      final region = ChallengeRegion.fromJson({});
      expect(region.offset, 0);
      expect(region.length, 0);
    });
  });

  group('ChallengeResponse', () {
    test('toJson serializes correctly', () {
      const response = ChallengeResponse(regionIndex: 2, hmac: 'abcdef');
      final json = response.toJson();
      expect(json['region_index'], 2);
      expect(json['hmac'], 'abcdef');
    });
  });
}
