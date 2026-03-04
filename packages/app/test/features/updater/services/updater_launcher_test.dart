import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/services/updater_launcher.dart';

void main() {
  group('UpdaterLauncher path resolution', () {
    test('getUpdaterPath returns Windows path', () {
      final launcher = UpdaterLauncher(
        isWindows: true,
        isMacOS: false,
        isLinux: false,
        environment: {'LOCALAPPDATA': r'C:\Users\test\AppData\Local'},
        resolvedExecutable: r'C:\Program Files\Zajel\zajel.exe',
      );

      expect(
        launcher.getUpdaterPath(),
        r'C:\Users\test\AppData\Local\Zajel\updater\zajel-updater.exe',
      );
    });

    test('getUpdaterPath returns macOS path', () {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: true,
        isLinux: false,
        environment: {'HOME': '/Users/testuser'},
        resolvedExecutable: '/Applications/zajel.app/Contents/MacOS/zajel',
      );

      expect(
        launcher.getUpdaterPath(),
        '/Users/testuser/Library/Application Support/'
        'com.zajel.zajel/updater/zajel-updater',
      );
    });

    test('getUpdaterPath returns Linux path', () {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
      );

      expect(
        launcher.getUpdaterPath(),
        '/home/testuser/.local/share/zajel/updater/zajel-updater',
      );
    });

    test('getInstallDir returns parent directory on Linux', () {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/bundle/zajel',
      );

      expect(launcher.getInstallDir(), '/opt/zajel/bundle');
    });

    test('getInstallDir returns parent directory on Windows', () {
      final launcher = UpdaterLauncher(
        isWindows: true,
        isMacOS: false,
        isLinux: false,
        environment: {'LOCALAPPDATA': r'C:\Users\test\AppData\Local'},
        resolvedExecutable: r'C:\Program Files\Zajel\zajel.exe',
      );

      // File.parent on the platform will resolve this
      final expected = File(r'C:\Program Files\Zajel\zajel.exe').parent.path;
      expect(launcher.getInstallDir(), expected);
    });

    test('getInstallDir navigates up to .app parent on macOS', () {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: true,
        isLinux: false,
        environment: {'HOME': '/Users/testuser'},
        resolvedExecutable: '/Applications/zajel.app/Contents/MacOS/zajel',
      );

      expect(launcher.getInstallDir(), '/Applications');
    });

    test('getBackupDir returns correct path per platform', () {
      final linuxLauncher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
      );

      expect(
        linuxLauncher.getBackupDir(),
        '/home/testuser/.local/share/zajel/update-backup',
      );
    });

    test('getManifestPath returns correct path', () {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
      );

      expect(
        launcher.getManifestPath(),
        '/home/testuser/.local/share/zajel/updater/manifest.json',
      );
    });

    test('getResultPath returns correct path', () {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
      );

      expect(
        launcher.getResultPath(),
        '/home/testuser/.local/share/zajel/updater/update-result.json',
      );
    });

    test('getLockFilePath returns correct path', () {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
      );

      expect(
        launcher.getLockFilePath(),
        '/home/testuser/.local/share/zajel/update-backup/'
        'update-in-progress.lock',
      );
    });
  });

  group('UpdaterLauncher deployUpdater', () {
    test('copies updater binary from staging root', () async {
      final copiedFiles = <String, String>{};
      final createdDirs = <String>[];
      final chmodCalls = <List<String>>[];
      final existingFiles = <String>{
        '/staging/zajel-updater',
      };

      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        fileExists: (p) => existingFiles.contains(p),
        copyFile: (src, dst) => copiedFiles[src] = dst,
        createDirectoryRecursive: (p) => createdDirs.add(p),
        runProcess: (exe, args) async {
          if (exe == 'chmod') chmodCalls.add(args);
          return ProcessResult(0, 0, '', '');
        },
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          throw UnimplementedError();
        },
      );

      await launcher.deployUpdater('/staging');

      expect(copiedFiles['/staging/zajel-updater'],
          '/home/testuser/.local/share/zajel/updater/zajel-updater');
      expect(
          createdDirs, contains('/home/testuser/.local/share/zajel/updater'));
      expect(chmodCalls, hasLength(1));
      expect(chmodCalls[0],
          ['+x', '/home/testuser/.local/share/zajel/updater/zajel-updater']);
    });

    test('copies updater binary from updater subdirectory', () async {
      final copiedFiles = <String, String>{};
      final existingFiles = <String>{
        '/staging/updater/zajel-updater',
      };

      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        fileExists: (p) => existingFiles.contains(p),
        copyFile: (src, dst) => copiedFiles[src] = dst,
        createDirectoryRecursive: (_) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          throw UnimplementedError();
        },
      );

      await launcher.deployUpdater('/staging');

      expect(copiedFiles['/staging/updater/zajel-updater'],
          '/home/testuser/.local/share/zajel/updater/zajel-updater');
    });

    test('throws UpdaterBinaryNotFoundException when binary missing', () async {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        fileExists: (_) => false,
        copyFile: (src, dst) {},
        createDirectoryRecursive: (_) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          throw UnimplementedError();
        },
      );

      expect(
        () => launcher.deployUpdater('/staging'),
        throwsA(isA<UpdaterBinaryNotFoundException>()),
      );
    });

    test('throws UpdaterCopyException when copy fails', () async {
      final existingFiles = <String>{'/staging/zajel-updater'};

      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        fileExists: (p) => existingFiles.contains(p),
        copyFile: (src, dst) => throw const FileSystemException('disk full'),
        createDirectoryRecursive: (_) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          throw UnimplementedError();
        },
      );

      expect(
        () => launcher.deployUpdater('/staging'),
        throwsA(isA<UpdaterCopyException>()),
      );
    });

    test('deploys .exe on Windows', () async {
      final copiedFiles = <String, String>{};
      final existingFiles = <String>{
        r'/staging\zajel-updater.exe',
      };

      final launcher = UpdaterLauncher(
        isWindows: true,
        isMacOS: false,
        isLinux: false,
        environment: {'LOCALAPPDATA': r'C:\Users\test\AppData\Local'},
        resolvedExecutable: r'C:\Program Files\Zajel\zajel.exe',
        fileExists: (p) => existingFiles.contains(p),
        copyFile: (src, dst) => copiedFiles[src] = dst,
        createDirectoryRecursive: (_) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          throw UnimplementedError();
        },
      );

      await launcher.deployUpdater('/staging');

      expect(copiedFiles.values.first,
          r'C:\Users\test\AppData\Local\Zajel\updater\zajel-updater.exe');
    });
  });

  group('UpdaterLauncher launchUpdate', () {
    test('writes manifest and launches updater as detached process', () async {
      final existingFiles = <String>{};
      final writtenFiles = <String, String>{};
      final startedProcesses = <(String, List<String>, ProcessStartMode)>[];

      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        getPid: () => 12345,
        fileExists: (p) {
          // After deployUpdater copies it, the file should exist
          if (p.endsWith('zajel-updater') &&
              p.contains('.local/share/zajel/updater')) {
            return existingFiles.contains(p);
          }
          // Staging has the updater binary
          return p == '/staging/zajel-updater';
        },
        copyFile: (src, dst) {
          existingFiles.add(dst);
        },
        createDirectoryRecursive: (_) {},
        writeFileString: (path, content) {
          writtenFiles[path] = content;
        },
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          startedProcesses.add((exe, args, mode));
          return _FakeProcess();
        },
      );

      final result = await launcher.launchUpdate(
        targetVersion: '2.0.0',
        currentVersion: '1.0.0',
        stagingDir: '/staging',
        checksumSha256: 'abc123',
      );

      expect(result, isTrue);

      // Verify manifest was written
      final manifestPath =
          '/home/testuser/.local/share/zajel/updater/manifest.json';
      expect(writtenFiles, contains(manifestPath));

      // Verify manifest content
      final manifestJson =
          jsonDecode(writtenFiles[manifestPath]!) as Map<String, dynamic>;
      expect(manifestJson['app_pid'], 12345);
      expect(manifestJson['app_version_current'], '1.0.0');
      expect(manifestJson['app_version_target'], '2.0.0');
      expect(manifestJson['checksum_sha256'], 'abc123');
      expect(manifestJson['platform'], 'linux');

      // Verify updater was launched as detached process
      expect(startedProcesses, hasLength(1));
      final (exe, args, mode) = startedProcesses[0];
      expect(exe, contains('zajel-updater'));
      expect(args, containsAll(['--manifest', manifestPath]));
      expect(args, containsAll(['--pid', '12345']));
      expect(mode, ProcessStartMode.detached);
    });

    test('throws ManifestWriteException when file write fails', () async {
      final existingFiles = <String>{};

      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        getPid: () => 12345,
        fileExists: (p) {
          if (p == '/staging/zajel-updater') return true;
          return existingFiles.contains(p);
        },
        copyFile: (src, dst) {
          existingFiles.add(dst);
        },
        createDirectoryRecursive: (_) {},
        writeFileString: (path, content) {
          throw const FileSystemException('permission denied');
        },
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          return _FakeProcess();
        },
      );

      expect(
        () => launcher.launchUpdate(
          targetVersion: '2.0.0',
          currentVersion: '1.0.0',
          stagingDir: '/staging',
          checksumSha256: 'abc123',
        ),
        throwsA(isA<ManifestWriteException>()),
      );
    });

    test('throws UpdaterLaunchException when Process.start fails', () async {
      final existingFiles = <String>{};

      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        getPid: () => 12345,
        fileExists: (p) {
          if (p == '/staging/zajel-updater') return true;
          return existingFiles.contains(p);
        },
        copyFile: (src, dst) {
          existingFiles.add(dst);
        },
        createDirectoryRecursive: (_) {},
        writeFileString: (path, content) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          throw const ProcessException(
              'zajel-updater', [], 'blocked by antivirus');
        },
      );

      expect(
        () => launcher.launchUpdate(
          targetVersion: '2.0.0',
          currentVersion: '1.0.0',
          stagingDir: '/staging',
          checksumSha256: 'abc123',
        ),
        throwsA(isA<UpdaterLaunchException>()),
      );
    });
  });

  group('UpdaterLauncher launchRollback', () {
    test('launches updater with --rollback flag', () async {
      final startedProcesses = <(String, List<String>, ProcessStartMode)>[];

      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        fileExists: (_) => true,
        copyFile: (src, dst) {},
        createDirectoryRecursive: (_) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          startedProcesses.add((exe, args, mode));
          return _FakeProcess();
        },
      );

      final result = await launcher.launchRollback();
      expect(result, isTrue);

      expect(startedProcesses, hasLength(1));
      final (exe, args, mode) = startedProcesses[0];
      expect(exe, contains('zajel-updater'));
      expect(args, contains('--rollback'));
      expect(args, contains('--manifest'));
      expect(mode, ProcessStartMode.detached);
    });

    test('returns false when updater binary not found', () async {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        fileExists: (_) => false,
        copyFile: (src, dst) {},
        createDirectoryRecursive: (_) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          return _FakeProcess();
        },
      );

      final result = await launcher.launchRollback();
      expect(result, isFalse);
    });

    test('returns false when manifest not found', () async {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        fileExists: (p) => p.endsWith('zajel-updater'),
        copyFile: (src, dst) {},
        createDirectoryRecursive: (_) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          return _FakeProcess();
        },
      );

      final result = await launcher.launchRollback();
      expect(result, isFalse);
    });

    test('returns false when Process.start fails', () async {
      final launcher = UpdaterLauncher(
        isWindows: false,
        isMacOS: false,
        isLinux: true,
        environment: {'HOME': '/home/testuser'},
        resolvedExecutable: '/opt/zajel/zajel',
        fileExists: (_) => true,
        copyFile: (src, dst) {},
        createDirectoryRecursive: (_) {},
        runProcess: (exe, args) async => ProcessResult(0, 0, '', ''),
        startProcess: (exe, args, {mode = ProcessStartMode.normal}) async {
          throw const ProcessException('test', [], 'launch failed');
        },
      );

      final result = await launcher.launchRollback();
      expect(result, isFalse);
    });
  });
}

/// Minimal fake Process for testing.
class _FakeProcess implements Process {
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) => true;

  @override
  Future<int> get exitCode => Future.value(0);

  @override
  int get pid => 99999;

  @override
  Stream<List<int>> get stderr => const Stream.empty();

  @override
  Stream<List<int>> get stdout => const Stream.empty();

  @override
  IOSink get stdin => throw UnimplementedError();
}
