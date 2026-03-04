import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/models/update_result.dart';

void main() {
  group('UpdateResult', () {
    /// Creates a valid JSON map for an UpdateResult.
    Map<String, dynamic> validJson({
      int schemaVersion = 1,
      String status = 'pending_verification',
      int exitCode = 0,
      String previousVersion = '1.0.0',
      String targetVersion = '1.2.0',
      String timestamp = '2026-03-01T12:00:00.000Z',
      String? errorMessage,
      String? backupDir,
      String? installDir,
      String? updaterVersion,
    }) {
      return {
        'schema_version': schemaVersion,
        'status': status,
        'exit_code': exitCode,
        'previous_version': previousVersion,
        'target_version': targetVersion,
        'timestamp': timestamp,
        if (errorMessage != null) 'error_message': errorMessage,
        if (backupDir != null) 'backup_dir': backupDir,
        if (installDir != null) 'install_dir': installDir,
        if (updaterVersion != null) 'updater_version': updaterVersion,
      };
    }

    group('fromJson', () {
      test('parses all required fields correctly', () {
        final result = UpdateResult.fromJson(validJson());

        expect(result.schemaVersion, 1);
        expect(result.status, 'pending_verification');
        expect(result.exitCode, 0);
        expect(result.previousVersion, '1.0.0');
        expect(result.targetVersion, '1.2.0');
        expect(result.timestamp, DateTime.utc(2026, 3, 1, 12, 0, 0));
        expect(result.errorMessage, isNull);
        expect(result.backupDir, isNull);
        expect(result.installDir, isNull);
        expect(result.updaterVersion, isNull);
      });

      test('parses all optional fields correctly', () {
        final result = UpdateResult.fromJson(validJson(
          errorMessage: 'Something went wrong',
          backupDir: '/tmp/backup',
          installDir: '/opt/zajel',
          updaterVersion: '0.1.0',
        ));

        expect(result.errorMessage, 'Something went wrong');
        expect(result.backupDir, '/tmp/backup');
        expect(result.installDir, '/opt/zajel');
        expect(result.updaterVersion, '0.1.0');
      });

      test('defaults schemaVersion to 1 when missing', () {
        final json = validJson();
        json.remove('schema_version');
        final result = UpdateResult.fromJson(json);

        expect(result.schemaVersion, 1);
      });

      test('throws FormatException when status is missing', () {
        final json = validJson();
        json.remove('status');

        expect(
          () => UpdateResult.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('status'),
          )),
        );
      });

      test('throws FormatException when status is empty', () {
        expect(
          () => UpdateResult.fromJson(validJson(status: '')),
          throwsA(isA<FormatException>()),
        );
      });

      test('throws FormatException when exit_code is missing', () {
        final json = validJson();
        json.remove('exit_code');

        expect(
          () => UpdateResult.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('exit_code'),
          )),
        );
      });

      test('throws FormatException when previous_version is missing', () {
        final json = validJson();
        json.remove('previous_version');

        expect(
          () => UpdateResult.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('previous_version'),
          )),
        );
      });

      test('throws FormatException when target_version is missing', () {
        final json = validJson();
        json.remove('target_version');

        expect(
          () => UpdateResult.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('target_version'),
          )),
        );
      });

      test('throws FormatException when timestamp is missing', () {
        final json = validJson();
        json.remove('timestamp');

        expect(
          () => UpdateResult.fromJson(json),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('timestamp'),
          )),
        );
      });

      test('throws FormatException when timestamp is unparseable', () {
        expect(
          () => UpdateResult.fromJson(validJson(timestamp: 'not-a-date')),
          throwsA(isA<FormatException>().having(
            (e) => e.message,
            'message',
            contains('timestamp'),
          )),
        );
      });

      test('parses various valid status values', () {
        for (final status in [
          'pending_verification',
          'verified',
          'rolled_back',
          'rollback_failed',
          'failed',
          'interrupted_recovery',
          'acknowledged',
        ]) {
          final result = UpdateResult.fromJson(validJson(status: status));
          expect(result.status, status);
        }
      });
    });

    group('toJson', () {
      test('serializes required fields correctly', () {
        final result = UpdateResult.fromJson(validJson());
        final json = result.toJson();

        expect(json['schema_version'], 1);
        expect(json['status'], 'pending_verification');
        expect(json['exit_code'], 0);
        expect(json['previous_version'], '1.0.0');
        expect(json['target_version'], '1.2.0');
        expect(json['timestamp'], '2026-03-01T12:00:00.000Z');
      });

      test('omits null optional fields', () {
        final result = UpdateResult.fromJson(validJson());
        final json = result.toJson();

        expect(json.containsKey('error_message'), isFalse);
        expect(json.containsKey('backup_dir'), isFalse);
        expect(json.containsKey('install_dir'), isFalse);
        expect(json.containsKey('updater_version'), isFalse);
      });

      test('includes non-null optional fields', () {
        final result = UpdateResult.fromJson(validJson(
          errorMessage: 'Error occurred',
          backupDir: '/tmp/backup',
          installDir: '/opt/zajel',
          updaterVersion: '0.1.0',
        ));
        final json = result.toJson();

        expect(json['error_message'], 'Error occurred');
        expect(json['backup_dir'], '/tmp/backup');
        expect(json['install_dir'], '/opt/zajel');
        expect(json['updater_version'], '0.1.0');
      });

      test('roundtrip: fromJson -> toJson -> fromJson preserves data', () {
        final original = UpdateResult.fromJson(validJson(
          errorMessage: 'Test error',
          backupDir: '/backup',
          installDir: '/install',
          updaterVersion: '0.2.0',
        ));

        final json = original.toJson();
        final roundtripped = UpdateResult.fromJson(json);

        expect(roundtripped.schemaVersion, original.schemaVersion);
        expect(roundtripped.status, original.status);
        expect(roundtripped.exitCode, original.exitCode);
        expect(roundtripped.previousVersion, original.previousVersion);
        expect(roundtripped.targetVersion, original.targetVersion);
        expect(roundtripped.timestamp, original.timestamp);
        expect(roundtripped.errorMessage, original.errorMessage);
        expect(roundtripped.backupDir, original.backupDir);
        expect(roundtripped.installDir, original.installDir);
        expect(roundtripped.updaterVersion, original.updaterVersion);
      });
    });

    group('fromFile', () {
      late Directory tempDir;

      setUp(() {
        tempDir = Directory.systemTemp.createTempSync('update_result_test_');
      });

      tearDown(() {
        if (tempDir.existsSync()) {
          tempDir.deleteSync(recursive: true);
        }
      });

      test('reads valid JSON file', () {
        final path = '${tempDir.path}/result.json';
        final encoder = const JsonEncoder.withIndent('  ');
        File(path).writeAsStringSync(encoder.convert(validJson()));

        final result = UpdateResult.fromFile(path);

        expect(result, isNotNull);
        expect(result!.status, 'pending_verification');
        expect(result.previousVersion, '1.0.0');
        expect(result.targetVersion, '1.2.0');
      });

      test('returns null for missing file', () {
        final result =
            UpdateResult.fromFile('${tempDir.path}/nonexistent.json');
        expect(result, isNull);
      });

      test('returns null for corrupt JSON', () {
        final path = '${tempDir.path}/corrupt.json';
        File(path).writeAsStringSync('not valid json {{{');

        final result = UpdateResult.fromFile(path);
        expect(result, isNull);
      });

      test('returns null for valid JSON with missing required fields', () {
        final path = '${tempDir.path}/incomplete.json';
        File(path).writeAsStringSync('{"status": "verified"}');

        final result = UpdateResult.fromFile(path);
        expect(result, isNull);
      });

      test('returns null for empty file', () {
        final path = '${tempDir.path}/empty.json';
        File(path).writeAsStringSync('');

        final result = UpdateResult.fromFile(path);
        expect(result, isNull);
      });
    });

    group('writeToFile', () {
      late Directory tempDir;

      setUp(() {
        tempDir = Directory.systemTemp.createTempSync('update_result_write_');
      });

      tearDown(() {
        if (tempDir.existsSync()) {
          tempDir.deleteSync(recursive: true);
        }
      });

      test('writes JSON to file and can be read back', () {
        final result = UpdateResult.fromJson(validJson(
          errorMessage: 'Test write',
        ));
        final path = '${tempDir.path}/output.json';

        result.writeToFile(path);

        final readBack = UpdateResult.fromFile(path);
        expect(readBack, isNotNull);
        expect(readBack!.status, result.status);
        expect(readBack.exitCode, result.exitCode);
        expect(readBack.errorMessage, result.errorMessage);
      });

      test('creates parent directories if needed', () {
        final result = UpdateResult.fromJson(validJson());
        final path = '${tempDir.path}/nested/deep/result.json';

        result.writeToFile(path);

        expect(File(path).existsSync(), isTrue);
      });
    });

    group('copyWith', () {
      test('creates copy with replaced fields', () {
        final original = UpdateResult.fromJson(validJson());
        final copy = original.copyWith(
          status: 'verified',
          exitCode: 1,
        );

        expect(copy.status, 'verified');
        expect(copy.exitCode, 1);
        // Unchanged fields preserved
        expect(copy.previousVersion, original.previousVersion);
        expect(copy.targetVersion, original.targetVersion);
      });

      test('can set optional fields to null', () {
        final original = UpdateResult.fromJson(validJson(
          errorMessage: 'Error',
        ));
        expect(original.errorMessage, isNotNull);

        final copy = original.copyWith(
          errorMessage: () => null,
        );
        expect(copy.errorMessage, isNull);
      });

      test('preserves original when no changes specified', () {
        final original = UpdateResult.fromJson(validJson());
        final copy = original.copyWith();

        expect(copy.status, original.status);
        expect(copy.exitCode, original.exitCode);
        expect(copy.previousVersion, original.previousVersion);
        expect(copy.targetVersion, original.targetVersion);
        expect(copy.timestamp, original.timestamp);
      });
    });

    group('equality', () {
      test('equal results are equal', () {
        final a = UpdateResult.fromJson(validJson());
        final b = UpdateResult.fromJson(validJson());

        expect(a, b);
        expect(a.hashCode, b.hashCode);
      });

      test('results with different status are not equal', () {
        final a =
            UpdateResult.fromJson(validJson(status: 'pending_verification'));
        final b = UpdateResult.fromJson(validJson(status: 'verified'));

        expect(a, isNot(b));
      });

      test('results with different exit codes are not equal', () {
        final a = UpdateResult.fromJson(validJson(exitCode: 0));
        final b = UpdateResult.fromJson(validJson(exitCode: 1));

        expect(a, isNot(b));
      });
    });

    group('toString', () {
      test('includes key information', () {
        final result = UpdateResult.fromJson(validJson());
        final str = result.toString();

        expect(str, contains('pending_verification'));
        expect(str, contains('0')); // exitCode
        expect(str, contains('1.0.0'));
        expect(str, contains('1.2.0'));
      });
    });
  });
}
