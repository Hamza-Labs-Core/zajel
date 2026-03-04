import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/models/update_manifest.dart';

void main() {
  final testTimestamp = DateTime.utc(2026, 3, 2, 12, 0, 0);

  UpdateManifest createTestManifest({
    int schemaVersion = 1,
    int appPid = 12345,
    String appVersionCurrent = '1.0.0',
    String appVersionTarget = '1.2.0',
    String installDir = '/opt/zajel/app',
    String stagingDir = '/opt/zajel/update-staging/zajel-1.2.0-linux',
    String backupDir = '/opt/zajel/update-backup',
    String appExecutable = 'zajel',
    String platform = 'linux',
    String checksumSha256 = 'abc123def456',
    DateTime? timestamp,
  }) {
    return UpdateManifest(
      schemaVersion: schemaVersion,
      appPid: appPid,
      appVersionCurrent: appVersionCurrent,
      appVersionTarget: appVersionTarget,
      installDir: installDir,
      stagingDir: stagingDir,
      backupDir: backupDir,
      appExecutable: appExecutable,
      platform: platform,
      checksumSha256: checksumSha256,
      timestamp: timestamp ?? testTimestamp,
    );
  }

  group('UpdateManifest', () {
    group('constructor', () {
      test('creates manifest with all required fields', () {
        final manifest = createTestManifest();

        expect(manifest.schemaVersion, 1);
        expect(manifest.appPid, 12345);
        expect(manifest.appVersionCurrent, '1.0.0');
        expect(manifest.appVersionTarget, '1.2.0');
        expect(manifest.installDir, '/opt/zajel/app');
        expect(
            manifest.stagingDir, '/opt/zajel/update-staging/zajel-1.2.0-linux');
        expect(manifest.backupDir, '/opt/zajel/update-backup');
        expect(manifest.appExecutable, 'zajel');
        expect(manifest.platform, 'linux');
        expect(manifest.checksumSha256, 'abc123def456');
        expect(manifest.timestamp, testTimestamp);
      });
    });

    group('toJson', () {
      test('serializes all fields correctly', () {
        final manifest = createTestManifest();
        final json = manifest.toJson();

        expect(json['schema_version'], 1);
        expect(json['app_pid'], 12345);
        expect(json['app_version_current'], '1.0.0');
        expect(json['app_version_target'], '1.2.0');
        expect(json['install_dir'], '/opt/zajel/app');
        expect(
            json['staging_dir'], '/opt/zajel/update-staging/zajel-1.2.0-linux');
        expect(json['backup_dir'], '/opt/zajel/update-backup');
        expect(json['app_executable'], 'zajel');
        expect(json['platform'], 'linux');
        expect(json['checksum_sha256'], 'abc123def456');
        expect(json['timestamp'], '2026-03-02T12:00:00.000Z');
      });

      test('timestamp is serialized in UTC ISO-8601', () {
        final localTime = DateTime(2026, 3, 2, 14, 30, 0);
        final manifest = createTestManifest(timestamp: localTime);
        final json = manifest.toJson();

        final timestampStr = json['timestamp'] as String;
        expect(timestampStr, endsWith('Z'));
        expect(DateTime.parse(timestampStr).isUtc, isTrue);
      });

      test('serializes Windows paths correctly', () {
        final manifest = createTestManifest(
          installDir: r'C:\Users\user\AppData\Local\Zajel\app',
          stagingDir:
              r'C:\Users\user\AppData\Local\Zajel\update-staging\zajel-1.2.0-windows',
          backupDir: r'C:\Users\user\AppData\Local\Zajel\update-backup',
          appExecutable: 'zajel.exe',
          platform: 'windows',
        );
        final json = manifest.toJson();

        expect(json['install_dir'], r'C:\Users\user\AppData\Local\Zajel\app');
        expect(json['app_executable'], 'zajel.exe');
        expect(json['platform'], 'windows');
      });
    });

    group('fromJson', () {
      test('parses complete JSON', () {
        final json = {
          'schema_version': 1,
          'app_pid': 12345,
          'app_version_current': '1.0.0',
          'app_version_target': '1.2.0',
          'install_dir': '/opt/zajel/app',
          'staging_dir': '/opt/zajel/update-staging/zajel-1.2.0-linux',
          'backup_dir': '/opt/zajel/update-backup',
          'app_executable': 'zajel',
          'platform': 'linux',
          'checksum_sha256': 'abc123def456',
          'timestamp': '2026-03-02T12:00:00.000Z',
        };

        final manifest = UpdateManifest.fromJson(json);

        expect(manifest.schemaVersion, 1);
        expect(manifest.appPid, 12345);
        expect(manifest.appVersionCurrent, '1.0.0');
        expect(manifest.appVersionTarget, '1.2.0');
        expect(manifest.installDir, '/opt/zajel/app');
        expect(
            manifest.stagingDir, '/opt/zajel/update-staging/zajel-1.2.0-linux');
        expect(manifest.backupDir, '/opt/zajel/update-backup');
        expect(manifest.appExecutable, 'zajel');
        expect(manifest.platform, 'linux');
        expect(manifest.checksumSha256, 'abc123def456');
        expect(manifest.timestamp, DateTime.utc(2026, 3, 2, 12, 0, 0));
      });

      test('throws FormatException for missing schema_version', () {
        final json = {
          'app_pid': 12345,
          'app_version_current': '1.0.0',
          'app_version_target': '1.2.0',
          'install_dir': '/opt/zajel/app',
          'staging_dir': '/opt/zajel/staging',
          'backup_dir': '/opt/zajel/backup',
          'app_executable': 'zajel',
          'platform': 'linux',
          'checksum_sha256': 'abc',
          'timestamp': '2026-03-02T12:00:00.000Z',
        };

        expect(
          () => UpdateManifest.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('schema_version'),
          )),
        );
      });

      test('throws FormatException for missing app_pid', () {
        final json = {
          'schema_version': 1,
          'app_version_current': '1.0.0',
          'app_version_target': '1.2.0',
          'install_dir': '/opt/zajel/app',
          'staging_dir': '/opt/zajel/staging',
          'backup_dir': '/opt/zajel/backup',
          'app_executable': 'zajel',
          'platform': 'linux',
          'checksum_sha256': 'abc',
          'timestamp': '2026-03-02T12:00:00.000Z',
        };

        expect(
          () => UpdateManifest.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('app_pid'),
          )),
        );
      });

      test('throws FormatException for empty app_version_current', () {
        final json = {
          'schema_version': 1,
          'app_pid': 12345,
          'app_version_current': '',
          'app_version_target': '1.2.0',
          'install_dir': '/opt/zajel/app',
          'staging_dir': '/opt/zajel/staging',
          'backup_dir': '/opt/zajel/backup',
          'app_executable': 'zajel',
          'platform': 'linux',
          'checksum_sha256': 'abc',
          'timestamp': '2026-03-02T12:00:00.000Z',
        };

        expect(
          () => UpdateManifest.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('app_version_current'),
          )),
        );
      });

      test('throws FormatException for invalid platform', () {
        final json = {
          'schema_version': 1,
          'app_pid': 12345,
          'app_version_current': '1.0.0',
          'app_version_target': '1.2.0',
          'install_dir': '/opt/zajel/app',
          'staging_dir': '/opt/zajel/staging',
          'backup_dir': '/opt/zajel/backup',
          'app_executable': 'zajel',
          'platform': 'android',
          'checksum_sha256': 'abc',
          'timestamp': '2026-03-02T12:00:00.000Z',
        };

        expect(
          () => UpdateManifest.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('android'),
          )),
        );
      });

      test('throws FormatException for invalid timestamp', () {
        final json = {
          'schema_version': 1,
          'app_pid': 12345,
          'app_version_current': '1.0.0',
          'app_version_target': '1.2.0',
          'install_dir': '/opt/zajel/app',
          'staging_dir': '/opt/zajel/staging',
          'backup_dir': '/opt/zajel/backup',
          'app_executable': 'zajel',
          'platform': 'linux',
          'checksum_sha256': 'abc',
          'timestamp': 'not-a-date',
        };

        expect(
          () => UpdateManifest.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('timestamp'),
          )),
        );
      });

      test('throws FormatException for missing install_dir', () {
        final json = {
          'schema_version': 1,
          'app_pid': 12345,
          'app_version_current': '1.0.0',
          'app_version_target': '1.2.0',
          'staging_dir': '/opt/zajel/staging',
          'backup_dir': '/opt/zajel/backup',
          'app_executable': 'zajel',
          'platform': 'linux',
          'checksum_sha256': 'abc',
          'timestamp': '2026-03-02T12:00:00.000Z',
        };

        expect(
          () => UpdateManifest.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('install_dir'),
          )),
        );
      });

      test('throws FormatException for missing checksum_sha256', () {
        final json = {
          'schema_version': 1,
          'app_pid': 12345,
          'app_version_current': '1.0.0',
          'app_version_target': '1.2.0',
          'install_dir': '/opt/zajel/app',
          'staging_dir': '/opt/zajel/staging',
          'backup_dir': '/opt/zajel/backup',
          'app_executable': 'zajel',
          'platform': 'linux',
          'timestamp': '2026-03-02T12:00:00.000Z',
        };

        expect(
          () => UpdateManifest.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('checksum_sha256'),
          )),
        );
      });
    });

    group('JSON round-trip', () {
      test('fromJson(toJson()) produces equal manifest', () {
        final original = createTestManifest();
        final json = original.toJson();
        final restored = UpdateManifest.fromJson(json);

        expect(restored.schemaVersion, original.schemaVersion);
        expect(restored.appPid, original.appPid);
        expect(restored.appVersionCurrent, original.appVersionCurrent);
        expect(restored.appVersionTarget, original.appVersionTarget);
        expect(restored.installDir, original.installDir);
        expect(restored.stagingDir, original.stagingDir);
        expect(restored.backupDir, original.backupDir);
        expect(restored.appExecutable, original.appExecutable);
        expect(restored.platform, original.platform);
        expect(restored.checksumSha256, original.checksumSha256);
        expect(restored, original);
      });

      test('survives JSON encode/decode cycle', () {
        final original = createTestManifest();
        final jsonString = jsonEncode(original.toJson());
        final decoded = jsonDecode(jsonString) as Map<String, dynamic>;
        final restored = UpdateManifest.fromJson(decoded);

        expect(restored, original);
      });
    });

    group('file I/O', () {
      late Directory tempDir;

      setUp(() {
        tempDir = Directory.systemTemp.createTempSync('update_manifest_test_');
      });

      tearDown(() {
        if (tempDir.existsSync()) {
          tempDir.deleteSync(recursive: true);
        }
      });

      test('writeToFile creates a valid JSON file', () {
        final manifest = createTestManifest();
        final filePath = '${tempDir.path}/manifest.json';

        manifest.writeToFile(filePath);

        final file = File(filePath);
        expect(file.existsSync(), isTrue);

        final content = file.readAsStringSync();
        final json = jsonDecode(content) as Map<String, dynamic>;
        expect(json['schema_version'], 1);
        expect(json['app_pid'], 12345);
      });

      test('writeToFile creates parent directories', () {
        final manifest = createTestManifest();
        final filePath = '${tempDir.path}/nested/dir/manifest.json';

        manifest.writeToFile(filePath);

        expect(File(filePath).existsSync(), isTrue);
      });

      test('fromFile reads a valid manifest', () {
        final original = createTestManifest();
        final filePath = '${tempDir.path}/manifest.json';
        original.writeToFile(filePath);

        final restored = UpdateManifest.fromFile(filePath);

        expect(restored, original);
      });

      test('fromFile throws on non-existent file', () {
        expect(
          () => UpdateManifest.fromFile('${tempDir.path}/nonexistent.json'),
          throwsA(isA<FileSystemException>()),
        );
      });

      test('fromFile throws on invalid JSON', () {
        final filePath = '${tempDir.path}/bad.json';
        File(filePath).writeAsStringSync('not json');

        expect(
          () => UpdateManifest.fromFile(filePath),
          throwsA(isA<FormatException>()),
        );
      });

      test('writeToFile produces formatted (pretty-printed) JSON', () {
        final manifest = createTestManifest();
        final filePath = '${tempDir.path}/manifest.json';
        manifest.writeToFile(filePath);

        final content = File(filePath).readAsStringSync();
        // Pretty-printed JSON has newlines and indentation
        expect(content, contains('\n'));
        expect(content, contains('  '));
      });
    });

    group('copyWith', () {
      test('creates copy with modified fields', () {
        final original = createTestManifest();

        final copy = original.copyWith(
          appPid: 99999,
          appVersionTarget: '2.0.0',
        );

        expect(copy.appPid, 99999);
        expect(copy.appVersionTarget, '2.0.0');
        // Unchanged fields
        expect(copy.schemaVersion, original.schemaVersion);
        expect(copy.appVersionCurrent, original.appVersionCurrent);
        expect(copy.installDir, original.installDir);
        expect(copy.platform, original.platform);
      });

      test('creates identical copy when no fields specified', () {
        final original = createTestManifest();
        final copy = original.copyWith();

        expect(copy, original);
      });
    });

    group('equality', () {
      test('equal manifests are equal', () {
        final a = createTestManifest();
        final b = createTestManifest();

        expect(a, b);
        expect(a.hashCode, b.hashCode);
      });

      test('different manifests are not equal', () {
        final a = createTestManifest(appPid: 1);
        final b = createTestManifest(appPid: 2);

        expect(a, isNot(b));
      });
    });

    group('toString', () {
      test('includes key information', () {
        final manifest = createTestManifest();
        final str = manifest.toString();

        expect(str, contains('1.0.0'));
        expect(str, contains('1.2.0'));
        expect(str, contains('linux'));
        expect(str, contains('12345'));
      });
    });
  });
}
