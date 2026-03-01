import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
import 'package:zajel/features/attestation/models/version_policy.dart';
import 'package:zajel/features/attestation/services/attestation_client.dart';
import 'package:zajel/features/attestation/services/version_check_service.dart';

void main() {
  group('VersionCheckService', () {
    group('evaluateVersion', () {
      test('returns upToDate when version meets recommended', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '1.5.0',
        );

        expect(
          VersionCheckService.evaluateVersion('1.5.0', policy),
          VersionStatus.upToDate,
        );
        expect(
          VersionCheckService.evaluateVersion('2.0.0', policy),
          VersionStatus.upToDate,
        );
      });

      test('returns updateAvailable when below recommended but above minimum',
          () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '1.5.0',
        );

        expect(
          VersionCheckService.evaluateVersion('1.2.0', policy),
          VersionStatus.updateAvailable,
        );
      });

      test('returns updateRequired when below minimum', () {
        const policy = VersionPolicy(
          minimumVersion: '2.0.0',
          recommendedVersion: '2.5.0',
        );

        expect(
          VersionCheckService.evaluateVersion('1.9.9', policy),
          VersionStatus.updateRequired,
        );
      });

      test('returns blocked when version is in blocked list', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '1.5.0',
          blockedVersions: ['1.3.0', '1.3.1'],
        );

        expect(
          VersionCheckService.evaluateVersion('1.3.0', policy),
          VersionStatus.blocked,
        );
        expect(
          VersionCheckService.evaluateVersion('1.3.1', policy),
          VersionStatus.blocked,
        );
      });

      test('blocked takes precedence over other checks', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '1.5.0',
          blockedVersions: ['1.5.0'], // The recommended version is blocked
        );

        expect(
          VersionCheckService.evaluateVersion('1.5.0', policy),
          VersionStatus.blocked,
        );
      });

      test('handles versions with only major.minor', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0',
          recommendedVersion: '2.0',
        );

        expect(
          VersionCheckService.evaluateVersion('1.5', policy),
          VersionStatus.updateAvailable,
        );
      });

      test('handles versions with pre-release tags', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '2.0.0',
        );

        // "1.5.0-beta" should be treated as "1.5.0"
        expect(
          VersionCheckService.evaluateVersion('1.5.0-beta', policy),
          VersionStatus.updateAvailable,
        );
      });

      test('handles versions with build metadata', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '2.0.0',
        );

        // "1.5.0+123" should be treated as "1.5.0"
        expect(
          VersionCheckService.evaluateVersion('1.5.0+123', policy),
          VersionStatus.updateAvailable,
        );
      });

      test('equal to minimum version passes', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '2.0.0',
        );

        expect(
          VersionCheckService.evaluateVersion('1.0.0', policy),
          VersionStatus.updateAvailable,
        );
      });

      test('equal to recommended version is upToDate', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '1.0.0',
        );

        expect(
          VersionCheckService.evaluateVersion('1.0.0', policy),
          VersionStatus.upToDate,
        );
      });

      test('handles 0.0.0 default policy', () {
        const policy = VersionPolicy();

        expect(
          VersionCheckService.evaluateVersion('0.0.1', policy),
          VersionStatus.upToDate,
        );
      });
    });

    group('checkVersion', () {
      test('returns upToDate when policy cannot be fetched', () async {
        final mockClient = http_testing.MockClient((request) async {
          return http.Response('Error', 500);
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );
        final service = VersionCheckService(client: client);

        final status = await service.checkVersion();
        expect(status, VersionStatus.upToDate);

        client.dispose();
      });

      test('caches policy after fetch', () async {
        final mockClient = http_testing.MockClient((request) async {
          return http.Response(
            jsonEncode({
              'minimum_version': '1.0.0',
              'recommended_version': '2.0.0',
              'blocked_versions': [],
            }),
            200,
          );
        });

        final client = AttestationClient(
          bootstrapUrl: 'https://bootstrap.example.com',
          client: mockClient,
        );
        final service = VersionCheckService(client: client);

        await service.checkVersion();
        expect(service.cachedPolicy, isNotNull);
        expect(service.cachedPolicy!.minimumVersion, '1.0.0');

        client.dispose();
      });
    });

    group('version comparison edge cases', () {
      test('major version difference', () {
        const policy = VersionPolicy(
          minimumVersion: '2.0.0',
          recommendedVersion: '3.0.0',
        );

        expect(
          VersionCheckService.evaluateVersion('1.99.99', policy),
          VersionStatus.updateRequired,
        );
      });

      test('minor version difference', () {
        const policy = VersionPolicy(
          minimumVersion: '1.2.0',
          recommendedVersion: '1.5.0',
        );

        expect(
          VersionCheckService.evaluateVersion('1.1.99', policy),
          VersionStatus.updateRequired,
        );
      });

      test('patch version difference', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.5',
          recommendedVersion: '1.0.10',
        );

        expect(
          VersionCheckService.evaluateVersion('1.0.4', policy),
          VersionStatus.updateRequired,
        );
        expect(
          VersionCheckService.evaluateVersion('1.0.7', policy),
          VersionStatus.updateAvailable,
        );
        expect(
          VersionCheckService.evaluateVersion('1.0.10', policy),
          VersionStatus.upToDate,
        );
      });

      test('handles invalid version strings gracefully', () {
        const policy = VersionPolicy(
          minimumVersion: '1.0.0',
          recommendedVersion: '2.0.0',
        );

        // Empty or garbage versions treated as 0.0.0
        expect(
          VersionCheckService.evaluateVersion('', policy),
          VersionStatus.updateRequired,
        );
        expect(
          VersionCheckService.evaluateVersion('dev', policy),
          VersionStatus.updateRequired,
        );
      });
    });
  });
}
