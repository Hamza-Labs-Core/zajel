import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/attestation/models/version_policy.dart';

void main() {
  group('VersionPolicy', () {
    group('fromJson', () {
      test('parses complete JSON', () {
        final policy = VersionPolicy.fromJson({
          'minimum_version': '1.2.0',
          'recommended_version': '1.3.0',
          'blocked_versions': ['1.1.0', '1.1.1'],
          'sunset_date': {'1.2.0': '2026-06-01'},
        });

        expect(policy.minimumVersion, '1.2.0');
        expect(policy.recommendedVersion, '1.3.0');
        expect(policy.blockedVersions, ['1.1.0', '1.1.1']);
        expect(policy.sunsetDates['1.2.0'], '2026-06-01');
      });

      test('handles missing fields with defaults', () {
        final policy = VersionPolicy.fromJson({});

        expect(policy.minimumVersion, '0.0.0');
        expect(policy.recommendedVersion, '0.0.0');
        expect(policy.blockedVersions, isEmpty);
        expect(policy.sunsetDates, isEmpty);
      });
    });

    group('toJson', () {
      test('serializes correctly', () {
        const policy = VersionPolicy(
          minimumVersion: '2.0.0',
          recommendedVersion: '2.1.0',
          blockedVersions: ['1.9.0'],
          sunsetDates: {'2.0.0': '2026-12-01'},
        );

        final json = policy.toJson();
        expect(json['minimum_version'], '2.0.0');
        expect(json['recommended_version'], '2.1.0');
        expect(json['blocked_versions'], ['1.9.0']);
        expect(json['sunset_date'], {'2.0.0': '2026-12-01'});
      });
    });

    group('default constructor', () {
      test('has sensible defaults', () {
        const policy = VersionPolicy();
        expect(policy.minimumVersion, '0.0.0');
        expect(policy.recommendedVersion, '0.0.0');
        expect(policy.blockedVersions, isEmpty);
        expect(policy.sunsetDates, isEmpty);
      });
    });

    test('toString includes key info', () {
      const policy = VersionPolicy(
        minimumVersion: '1.0.0',
        recommendedVersion: '1.5.0',
        blockedVersions: ['0.9.0'],
      );
      final str = policy.toString();
      expect(str, contains('1.0.0'));
      expect(str, contains('1.5.0'));
    });
  });

  group('VersionStatus', () {
    test('has all expected values', () {
      expect(VersionStatus.values, hasLength(4));
      expect(VersionStatus.values, contains(VersionStatus.upToDate));
      expect(VersionStatus.values, contains(VersionStatus.updateAvailable));
      expect(VersionStatus.values, contains(VersionStatus.updateRequired));
      expect(VersionStatus.values, contains(VersionStatus.blocked));
    });
  });
}
