import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
import 'package:zajel/features/attestation/models/build_token.dart';
import 'package:zajel/features/attestation/services/attestation_client.dart';
import 'package:zajel/features/attestation/services/attestation_service.dart';

import '../../mocks/mocks.dart';

void main() {
  group('AttestationService', () {
    late FakeSecureStorage secureStorage;

    setUp(() {
      secureStorage = FakeSecureStorage();
    });

    AttestationService _createService({
      required http_testing.MockClient httpClient,
    }) {
      final client = AttestationClient(
        bootstrapUrl: 'https://bootstrap.example.com',
        client: httpClient,
      );
      return AttestationService(
        client: client,
        secureStorage: secureStorage,
        deviceId: 'test-device',
      );
    }

    group('initialize', () {
      test('loads valid token from storage', () async {
        final futureTime =
            DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch;
        await secureStorage.write(
          key: 'attestation_session_token',
          value: jsonEncode({
            'token': 'stored-token',
            'expires_at': futureTime,
            'device_id': 'test-device',
          }),
        );

        final service = _createService(
          httpClient:
              http_testing.MockClient((req) async => http.Response('', 500)),
        );

        final token = await service.initialize();

        expect(token, isNotNull);
        expect(token!.token, 'stored-token');
        expect(service.hasValidToken, isTrue);
      });

      test('skips expired token and attempts registration', () async {
        final pastTime = DateTime.now()
            .subtract(const Duration(hours: 1))
            .millisecondsSinceEpoch;
        await secureStorage.write(
          key: 'attestation_session_token',
          value: jsonEncode({
            'token': 'expired-token',
            'expires_at': pastTime,
            'device_id': 'test-device',
          }),
        );

        // Registration will fail because there's no build token
        final service = _createService(
          httpClient:
              http_testing.MockClient((req) async => http.Response('', 500)),
        );

        final token = await service.initialize();

        // No build token configured, so registration fails
        expect(token, isNull);
        expect(service.hasValidToken, isFalse);
      });
    });

    group('registerWithToken', () {
      test('stores token on successful registration', () async {
        final futureMs =
            DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch;
        final service = _createService(
          httpClient: http_testing.MockClient((request) async {
            return http.Response(
              jsonEncode({
                'session_token': {
                  'token': 'new-token',
                  'expires_at': futureMs,
                  'device_id': 'test-device',
                }
              }),
              200,
            );
          }),
        );

        const buildToken = BuildToken(
          version: '1.0.0',
          platform: 'linux',
          buildHash: 'hash',
          timestamp: 12345,
          signature: 'sig',
        );

        final token = await service.registerWithToken(buildToken);

        expect(token, isNotNull);
        expect(token!.token, 'new-token');
        expect(service.hasValidToken, isTrue);
        expect(service.currentToken!.token, 'new-token');

        // Verify it was stored in secure storage
        final stored =
            await secureStorage.read(key: 'attestation_session_token');
        expect(stored, isNotNull);
        final storedJson = jsonDecode(stored!) as Map<String, dynamic>;
        expect(storedJson['token'], 'new-token');
      });

      test('returns null on registration failure', () async {
        final service = _createService(
          httpClient: http_testing.MockClient((request) async {
            return http.Response('Unauthorized', 401);
          }),
        );

        const buildToken = BuildToken(
          version: '1.0.0',
          platform: 'linux',
          buildHash: 'hash',
          timestamp: 12345,
          signature: 'sig',
        );

        final token = await service.registerWithToken(buildToken);

        expect(token, isNull);
        expect(service.hasValidToken, isFalse);
      });
    });

    group('clearToken', () {
      test('clears cached and stored token', () async {
        final futureMs =
            DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch;
        final service = _createService(
          httpClient: http_testing.MockClient((request) async {
            return http.Response(
              jsonEncode({
                'session_token': {
                  'token': 'to-clear',
                  'expires_at': futureMs,
                  'device_id': 'test-device',
                }
              }),
              200,
            );
          }),
        );

        const buildToken = BuildToken(
          version: '1.0.0',
          platform: 'linux',
          buildHash: 'hash',
          timestamp: 12345,
          signature: 'sig',
        );

        await service.registerWithToken(buildToken);
        expect(service.hasValidToken, isTrue);

        await service.clearToken();
        expect(service.hasValidToken, isFalse);
        expect(service.currentToken, isNull);

        final stored =
            await secureStorage.read(key: 'attestation_session_token');
        expect(stored, isNull);
      });
    });

    group('currentToken', () {
      test('returns null when no token cached', () {
        final service = _createService(
          httpClient:
              http_testing.MockClient((req) async => http.Response('', 500)),
        );
        expect(service.currentToken, isNull);
        expect(service.hasValidToken, isFalse);
      });
    });
  });
}
