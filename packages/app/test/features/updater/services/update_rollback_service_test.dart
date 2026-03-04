import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/features/updater/models/update_result.dart';
import 'package:zajel/features/updater/services/update_rollback_service.dart';
import 'package:zajel/features/updater/services/updater_launcher.dart';

void main() {
  late SharedPreferences prefs;
  late Directory tempDir;
  late UpdaterLauncher launcher;
  late String updaterDir;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();

    tempDir = await Directory.systemTemp.createTemp('rollback_test_');
    updaterDir = '${tempDir.path}/updater';
    await Directory(updaterDir).create(recursive: true);

    launcher = UpdaterLauncher(
      isWindows: false,
      isMacOS: false,
      isLinux: true,
      environment: {'HOME': tempDir.path},
      resolvedExecutable: '${tempDir.path}/app/zajel',
      fileExists: (p) => File(p).existsSync(),
      copyFile: (src, dst) => File(src).copySync(dst),
      createDirectoryRecursive: (p) => Directory(p).createSync(recursive: true),
      runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
      startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
        throw UnimplementedError('Should not start process in tests');
      },
    );
  });

  tearDown(() async {
    await tempDir.delete(recursive: true);
  });

  /// Helper to write update-result.json in the updater directory.
  void writeResultFile(UpdateResult result) {
    result.writeToFile(launcher.getResultPath());
  }

  /// Helper to create a lock file.
  void createLockFile() {
    final lockPath = launcher.getLockFilePath();
    final lockFile = File(lockPath);
    lockFile.parent.createSync(recursive: true);
    lockFile.writeAsStringSync('{"phase": "replacing"}');
  }

  group('checkOnStartup', () {
    test('returns none when no result file exists', () async {
      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.none);
    });

    test('returns none when status is verified', () async {
      writeResultFile(UpdateResult(
        status: 'verified',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.none);
    });

    test('returns none when status is acknowledged', () async {
      writeResultFile(UpdateResult(
        status: 'acknowledged',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.none);
    });

    test('returns none when status is rolled_back (will show notification)',
        () async {
      writeResultFile(UpdateResult(
        status: 'rolled_back',
        exitCode: 6,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.none);
    });

    test('returns verifying on first launch attempt with pending_verification',
        () async {
      writeResultFile(UpdateResult(
        status: 'pending_verification',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.verifying);
      expect(prefs.getInt('update_launch_attempt'), 1);
    });

    test('returns rollback on second launch attempt (counter >= 2)', () async {
      // Simulate first attempt already happened
      await prefs.setInt('update_launch_attempt', 1);

      writeResultFile(UpdateResult(
        status: 'pending_verification',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.rollback);
      expect(prefs.getInt('update_launch_attempt'), 2);
    });

    test('returns rollback when counter already >= 2', () async {
      await prefs.setInt('update_launch_attempt', 5);

      writeResultFile(UpdateResult(
        status: 'pending_verification',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.rollback);
      expect(prefs.getInt('update_launch_attempt'), 6);
    });

    test('returns powerLossRecovery when lock file exists', () async {
      createLockFile();

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.powerLossRecovery);
    });

    test('lock file takes priority over result file status', () async {
      createLockFile();

      writeResultFile(UpdateResult(
        status: 'pending_verification',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      // Lock file should take priority
      expect(action, RollbackAction.powerLossRecovery);
    });

    test('returns none when result file has rollback_failed status', () async {
      writeResultFile(UpdateResult(
        status: 'rollback_failed',
        exitCode: 7,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
        errorMessage: 'Backup directory missing',
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.none);
    });

    test('returns none when result file has unknown status', () async {
      writeResultFile(UpdateResult(
        status: 'unknown_status',
        exitCode: 99,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.none);
    });

    test('handles corrupt result file gracefully', () async {
      // Write invalid JSON
      final resultPath = launcher.getResultPath();
      File(resultPath)
        ..parent.createSync(recursive: true)
        ..writeAsStringSync('not valid json {{{');

      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );

      expect(action, RollbackAction.none);
    });
  });

  group('markVerified', () {
    test('resets launch counter and updates status', () async {
      await prefs.setInt('update_launch_attempt', 1);

      writeResultFile(UpdateResult(
        status: 'pending_verification',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      await UpdateRollbackService.markVerified(
        prefs: prefs,
        launcher: launcher,
      );

      // Counter should be reset to 0
      expect(prefs.getInt('update_launch_attempt'), 0);

      // Result file should show verified status
      final result = UpdateResult.fromFile(launcher.getResultPath());
      expect(result, isNotNull);
      expect(result!.status, 'verified');
    });

    test('does nothing when no result file exists', () async {
      await prefs.setInt('update_launch_attempt', 1);

      await UpdateRollbackService.markVerified(
        prefs: prefs,
        launcher: launcher,
      );

      // Counter should NOT be reset since there's no pending verification
      expect(prefs.getInt('update_launch_attempt'), 1);
    });

    test('does nothing when status is not pending_verification', () async {
      await prefs.setInt('update_launch_attempt', 1);

      writeResultFile(UpdateResult(
        status: 'verified',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      await UpdateRollbackService.markVerified(
        prefs: prefs,
        launcher: launcher,
      );

      // Counter should NOT be reset
      expect(prefs.getInt('update_launch_attempt'), 1);
    });
  });

  group('wasRolledBack', () {
    test('returns true when status is rolled_back', () {
      writeResultFile(UpdateResult(
        status: 'rolled_back',
        exitCode: 6,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      expect(
        UpdateRollbackService.wasRolledBack(launcher: launcher),
        isTrue,
      );
    });

    test('returns true when status is interrupted_recovery', () {
      writeResultFile(UpdateResult(
        status: 'interrupted_recovery',
        exitCode: 1,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      expect(
        UpdateRollbackService.wasRolledBack(launcher: launcher),
        isTrue,
      );
    });

    test('returns false when status is verified', () {
      writeResultFile(UpdateResult(
        status: 'verified',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      expect(
        UpdateRollbackService.wasRolledBack(launcher: launcher),
        isFalse,
      );
    });

    test('returns false when no result file exists', () {
      expect(
        UpdateRollbackService.wasRolledBack(launcher: launcher),
        isFalse,
      );
    });
  });

  group('getRollbackResult', () {
    test('returns result when status is rolled_back', () {
      writeResultFile(UpdateResult(
        status: 'rolled_back',
        exitCode: 6,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      final result =
          UpdateRollbackService.getRollbackResult(launcher: launcher);
      expect(result, isNotNull);
      expect(result!.targetVersion, '1.1.0');
      expect(result.previousVersion, '1.0.0');
    });

    test('returns null when status is verified', () {
      writeResultFile(UpdateResult(
        status: 'verified',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      expect(
        UpdateRollbackService.getRollbackResult(launcher: launcher),
        isNull,
      );
    });
  });

  group('clearRollbackFlag', () {
    test('updates status to acknowledged', () async {
      writeResultFile(UpdateResult(
        status: 'rolled_back',
        exitCode: 6,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      await UpdateRollbackService.clearRollbackFlag(launcher: launcher);

      final result = UpdateResult.fromFile(launcher.getResultPath());
      expect(result, isNotNull);
      expect(result!.status, 'acknowledged');
    });

    test('does not modify non-rollback status', () async {
      writeResultFile(UpdateResult(
        status: 'verified',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      await UpdateRollbackService.clearRollbackFlag(launcher: launcher);

      // Should remain unchanged
      final result = UpdateResult.fromFile(launcher.getResultPath());
      expect(result, isNotNull);
      expect(result!.status, 'verified');
    });

    test('handles interrupted_recovery status', () async {
      writeResultFile(UpdateResult(
        status: 'interrupted_recovery',
        exitCode: 1,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      await UpdateRollbackService.clearRollbackFlag(launcher: launcher);

      final result = UpdateResult.fromFile(launcher.getResultPath());
      expect(result, isNotNull);
      expect(result!.status, 'acknowledged');
    });

    test('no-op when result file does not exist', () async {
      // Should not throw
      await UpdateRollbackService.clearRollbackFlag(launcher: launcher);
    });
  });

  group('full verification lifecycle', () {
    test('first launch: verifying -> markVerified -> verified', () async {
      writeResultFile(UpdateResult(
        status: 'pending_verification',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      // First launch
      final action = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );
      expect(action, RollbackAction.verifying);
      expect(prefs.getInt('update_launch_attempt'), 1);

      // Core init succeeds
      await UpdateRollbackService.markVerified(
        prefs: prefs,
        launcher: launcher,
      );
      expect(prefs.getInt('update_launch_attempt'), 0);

      // Verify result file
      final result = UpdateResult.fromFile(launcher.getResultPath());
      expect(result!.status, 'verified');

      // Next launch: no action needed
      final nextAction = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );
      expect(nextAction, RollbackAction.none);
    });

    test('crash on first launch, then rollback on second', () async {
      writeResultFile(UpdateResult(
        status: 'pending_verification',
        exitCode: 0,
        previousVersion: '1.0.0',
        targetVersion: '1.1.0',
        timestamp: DateTime.now().toUtc(),
      ));

      // First launch attempt
      final action1 = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );
      expect(action1, RollbackAction.verifying);
      expect(prefs.getInt('update_launch_attempt'), 1);

      // Simulate crash: markVerified is never called

      // Second launch attempt
      final action2 = await UpdateRollbackService.checkOnStartup(
        prefs: prefs,
        launcher: launcher,
      );
      expect(action2, RollbackAction.rollback);
      expect(prefs.getInt('update_launch_attempt'), 2);
    });
  });
}
