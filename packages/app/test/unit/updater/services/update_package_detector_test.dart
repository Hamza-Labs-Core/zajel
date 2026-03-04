import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/services/update_package_detector.dart';

void main() {
  group('PackageFormat', () {
    test('has all expected values', () {
      expect(PackageFormat.values, hasLength(6));
      expect(PackageFormat.values, contains(PackageFormat.loose));
      expect(PackageFormat.values, contains(PackageFormat.msix));
      expect(PackageFormat.values, contains(PackageFormat.macAppStore));
      expect(PackageFormat.values, contains(PackageFormat.snap));
      expect(PackageFormat.values, contains(PackageFormat.flatpak));
      expect(PackageFormat.values, contains(PackageFormat.appImage));
    });
  });

  group('UpdatePackageDetector', () {
    group('Windows detection', () {
      test('detects MSIX when path contains WindowsApps', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              r'C:\Program Files\WindowsApps\Zajel_1.0.0_x64\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.msix);
        expect(detector.supportsAutoUpdate(), isFalse);
        expect(detector.isStoreManaged(), isTrue);
        expect(detector.storeName(), 'Microsoft Store');
      });

      test('detects loose install when path is normal directory', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              r'C:\Users\user\AppData\Local\Zajel\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.loose);
        expect(detector.supportsAutoUpdate(), isTrue);
        expect(detector.isStoreManaged(), isFalse);
        expect(detector.storeName(), isNull);
      });

      test('detects MSIX with sideloaded path', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              r'C:\Program Files\WindowsApps\com.zajel.zajel_1.0.0.0_x64__abc123\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.msix);
      });

      test('detects loose install from dev build path', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              r'D:\Projects\zajel\build\windows\x64\runner\Release\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.loose);
      });
    });

    group('macOS detection', () {
      test('detects Mac App Store when receipt file exists', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              '/Applications/Zajel.app/Contents/MacOS/zajel',
          environment: {},
          fileExists: (path) =>
              path == '/Applications/Zajel.app/Contents/_MASReceipt/receipt',
          isWindows: false,
          isMacOS: true,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.macAppStore);
        expect(detector.supportsAutoUpdate(), isFalse);
        expect(detector.isStoreManaged(), isTrue);
        expect(detector.storeName(), 'Mac App Store');
      });

      test('detects loose install (DMG) when no receipt file', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              '/Applications/Zajel.app/Contents/MacOS/zajel',
          environment: {},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: true,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.loose);
        expect(detector.supportsAutoUpdate(), isTrue);
        expect(detector.isStoreManaged(), isFalse);
      });

      test('detects loose install when not in .app bundle', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/usr/local/bin/zajel',
          environment: {},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: true,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.loose);
      });

      test('handles nested .app bundle path', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              '/Users/user/Downloads/Zajel.app/Contents/MacOS/zajel',
          environment: {},
          fileExists: (path) =>
              path ==
              '/Users/user/Downloads/Zajel.app/Contents/_MASReceipt/receipt',
          isWindows: false,
          isMacOS: true,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.macAppStore);
      });
    });

    group('Linux detection', () {
      test('detects Snap when SNAP env is set', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
          environment: {'SNAP': '/snap/zajel/123'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.detect(), PackageFormat.snap);
        expect(detector.supportsAutoUpdate(), isFalse);
        expect(detector.isStoreManaged(), isTrue);
        expect(detector.storeName(), 'Snap Store');
      });

      test('detects Flatpak when FLATPAK_ID env is set', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/app/bin/zajel',
          environment: {'FLATPAK_ID': 'com.zajel.Zajel'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.detect(), PackageFormat.flatpak);
        expect(detector.supportsAutoUpdate(), isFalse);
        expect(detector.isStoreManaged(), isTrue);
        expect(detector.storeName(), 'Flathub');
      });

      test('detects AppImage when APPIMAGE env is set', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/tmp/.mount_zajelXXX/usr/bin/zajel',
          environment: {'APPIMAGE': '/home/user/Zajel.AppImage'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.detect(), PackageFormat.appImage);
        expect(detector.supportsAutoUpdate(), isTrue);
        expect(detector.isStoreManaged(), isFalse);
        expect(detector.storeName(), isNull);
      });

      test('detects loose install (tarball) when no store env vars', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/opt/zajel/zajel',
          environment: {},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.detect(), PackageFormat.loose);
        expect(detector.supportsAutoUpdate(), isTrue);
        expect(detector.isStoreManaged(), isFalse);
      });

      test('Snap takes precedence over APPIMAGE if both set', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
          environment: {
            'SNAP': '/snap/zajel/123',
            'APPIMAGE': '/something',
          },
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.detect(), PackageFormat.snap);
      });

      test('Snap takes precedence over Flatpak if both set', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
          environment: {
            'SNAP': '/snap/zajel/123',
            'FLATPAK_ID': 'com.zajel.Zajel',
          },
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.detect(), PackageFormat.snap);
      });

      test('Flatpak takes precedence over AppImage if both set', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/app/bin/zajel',
          environment: {
            'FLATPAK_ID': 'com.zajel.Zajel',
            'APPIMAGE': '/something',
          },
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.detect(), PackageFormat.flatpak);
      });
    });

    group('unknown platform', () {
      test('returns loose for non-desktop platform', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/some/path',
          environment: {},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: false,
        );

        expect(detector.detect(), PackageFormat.loose);
      });
    });

    group('caching', () {
      test('detect() returns same result on subsequent calls', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: r'C:\Program Files\WindowsApps\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        final first = detector.detect();
        final second = detector.detect();
        expect(identical(first, second), isTrue);
      });

      test('cached result is consistent across method calls', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
          environment: {'SNAP': '/snap/zajel/123'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        // Call detect, then all other methods that depend on it
        expect(detector.detect(), PackageFormat.snap);
        expect(detector.supportsAutoUpdate(), isFalse);
        expect(detector.isStoreManaged(), isTrue);
        expect(detector.storeName(), 'Snap Store');
        expect(detector.storeDeepLink(), 'snap://zajel');
        expect(detector.storeWebUrl(), 'https://snapcraft.io/zajel');

        // All should still be consistent
        expect(detector.detect(), PackageFormat.snap);
      });
    });

    group('store links', () {
      test('MSIX returns Microsoft Store deep link', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              r'C:\Program Files\WindowsApps\Zajel\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        final deepLink = detector.storeDeepLink();
        expect(deepLink, isNotNull);
        expect(deepLink, startsWith('ms-windows-store://'));
        expect(Uri.tryParse(deepLink!), isNotNull);
      });

      test('MSIX returns Microsoft Store web URL', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              r'C:\Program Files\WindowsApps\Zajel\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        final webUrl = detector.storeWebUrl();
        expect(webUrl, isNotNull);
        expect(webUrl, startsWith('https://apps.microsoft.com/'));
      });

      test('Mac App Store returns correct deep link', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              '/Applications/Zajel.app/Contents/MacOS/zajel',
          environment: {},
          fileExists: (path) =>
              path == '/Applications/Zajel.app/Contents/_MASReceipt/receipt',
          isWindows: false,
          isMacOS: true,
          isLinux: false,
        );

        final deepLink = detector.storeDeepLink();
        expect(deepLink, isNotNull);
        expect(deepLink, startsWith('macappstores://'));
      });

      test('Mac App Store returns correct web URL', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              '/Applications/Zajel.app/Contents/MacOS/zajel',
          environment: {},
          fileExists: (path) =>
              path == '/Applications/Zajel.app/Contents/_MASReceipt/receipt',
          isWindows: false,
          isMacOS: true,
          isLinux: false,
        );

        final webUrl = detector.storeWebUrl();
        expect(webUrl, isNotNull);
        expect(webUrl, startsWith('https://apps.apple.com/'));
      });

      test('Snap returns correct deep link', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
          environment: {'SNAP': '/snap/zajel/123'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.storeDeepLink(), 'snap://zajel');
      });

      test('Snap returns correct web URL', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
          environment: {'SNAP': '/snap/zajel/123'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.storeWebUrl(), 'https://snapcraft.io/zajel');
      });

      test('Flatpak returns Flathub URL as deep link', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/app/bin/zajel',
          environment: {'FLATPAK_ID': 'com.zajel.Zajel'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.storeDeepLink(),
            'https://flathub.org/apps/com.zajel.Zajel');
      });

      test('Flatpak returns Flathub URL as web URL', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/app/bin/zajel',
          environment: {'FLATPAK_ID': 'com.zajel.Zajel'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(
            detector.storeWebUrl(), 'https://flathub.org/apps/com.zajel.Zajel');
      });

      test('loose install returns null for all store links', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: r'C:\Users\user\zajel\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        expect(detector.storeDeepLink(), isNull);
        expect(detector.storeWebUrl(), isNull);
        expect(detector.storeName(), isNull);
      });

      test('AppImage returns null for all store links', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/tmp/.mount_zajelXXX/usr/bin/zajel',
          environment: {'APPIMAGE': '/home/user/Zajel.AppImage'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.storeDeepLink(), isNull);
        expect(detector.storeWebUrl(), isNull);
        expect(detector.storeName(), isNull);
      });

      test('all store deep links are parseable URIs', () {
        final formats = [
          (
            PackageFormat.msix,
            UpdatePackageDetector(
              resolvedExecutablePath: r'C:\Program Files\WindowsApps\zajel.exe',
              environment: {},
              fileExists: (_) => false,
              isWindows: true,
              isMacOS: false,
              isLinux: false,
            ),
          ),
          (
            PackageFormat.macAppStore,
            UpdatePackageDetector(
              resolvedExecutablePath:
                  '/Applications/Zajel.app/Contents/MacOS/zajel',
              environment: {},
              fileExists: (path) =>
                  path ==
                  '/Applications/Zajel.app/Contents/_MASReceipt/receipt',
              isWindows: false,
              isMacOS: true,
              isLinux: false,
            ),
          ),
          (
            PackageFormat.snap,
            UpdatePackageDetector(
              resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
              environment: {'SNAP': '/snap/zajel/123'},
              fileExists: (_) => false,
              isWindows: false,
              isMacOS: false,
              isLinux: true,
            ),
          ),
          (
            PackageFormat.flatpak,
            UpdatePackageDetector(
              resolvedExecutablePath: '/app/bin/zajel',
              environment: {'FLATPAK_ID': 'com.zajel.Zajel'},
              fileExists: (_) => false,
              isWindows: false,
              isMacOS: false,
              isLinux: true,
            ),
          ),
        ];

        for (final (format, detector) in formats) {
          final deepLink = detector.storeDeepLink();
          expect(deepLink, isNotNull,
              reason: '$format should have a deep link');
          expect(Uri.tryParse(deepLink!), isNotNull,
              reason: 'Deep link for $format should be a valid URI');
        }
      });
    });

    group('supportsAutoUpdate', () {
      test('loose install supports auto-update', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/opt/zajel/zajel',
          environment: {},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.supportsAutoUpdate(), isTrue);
      });

      test('AppImage supports auto-update', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/tmp/.mount_zajelXXX/usr/bin/zajel',
          environment: {'APPIMAGE': '/home/user/Zajel.AppImage'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.supportsAutoUpdate(), isTrue);
      });

      test('MSIX does not support auto-update', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: r'C:\Program Files\WindowsApps\zajel.exe',
          environment: {},
          fileExists: (_) => false,
          isWindows: true,
          isMacOS: false,
          isLinux: false,
        );

        expect(detector.supportsAutoUpdate(), isFalse);
      });

      test('Mac App Store does not support auto-update', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath:
              '/Applications/Zajel.app/Contents/MacOS/zajel',
          environment: {},
          fileExists: (path) =>
              path == '/Applications/Zajel.app/Contents/_MASReceipt/receipt',
          isWindows: false,
          isMacOS: true,
          isLinux: false,
        );

        expect(detector.supportsAutoUpdate(), isFalse);
      });

      test('Snap does not support auto-update', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
          environment: {'SNAP': '/snap/zajel/123'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.supportsAutoUpdate(), isFalse);
      });

      test('Flatpak does not support auto-update', () {
        final detector = UpdatePackageDetector(
          resolvedExecutablePath: '/app/bin/zajel',
          environment: {'FLATPAK_ID': 'com.zajel.Zajel'},
          fileExists: (_) => false,
          isWindows: false,
          isMacOS: false,
          isLinux: true,
        );

        expect(detector.supportsAutoUpdate(), isFalse);
      });
    });

    group('isStoreManaged', () {
      test('returns true for all store-managed formats', () {
        final storeDetectors = [
          UpdatePackageDetector(
            resolvedExecutablePath: r'C:\Program Files\WindowsApps\zajel.exe',
            environment: {},
            fileExists: (_) => false,
            isWindows: true,
            isMacOS: false,
            isLinux: false,
          ),
          UpdatePackageDetector(
            resolvedExecutablePath:
                '/Applications/Zajel.app/Contents/MacOS/zajel',
            environment: {},
            fileExists: (path) =>
                path == '/Applications/Zajel.app/Contents/_MASReceipt/receipt',
            isWindows: false,
            isMacOS: true,
            isLinux: false,
          ),
          UpdatePackageDetector(
            resolvedExecutablePath: '/snap/zajel/123/bin/zajel',
            environment: {'SNAP': '/snap/zajel/123'},
            fileExists: (_) => false,
            isWindows: false,
            isMacOS: false,
            isLinux: true,
          ),
          UpdatePackageDetector(
            resolvedExecutablePath: '/app/bin/zajel',
            environment: {'FLATPAK_ID': 'com.zajel.Zajel'},
            fileExists: (_) => false,
            isWindows: false,
            isMacOS: false,
            isLinux: true,
          ),
        ];

        for (final detector in storeDetectors) {
          expect(detector.isStoreManaged(), isTrue,
              reason: '${detector.detect()} should be store-managed');
        }
      });

      test('returns false for non-store formats', () {
        final nonStoreDetectors = [
          UpdatePackageDetector(
            resolvedExecutablePath: '/opt/zajel/zajel',
            environment: {},
            fileExists: (_) => false,
            isWindows: false,
            isMacOS: false,
            isLinux: true,
          ),
          UpdatePackageDetector(
            resolvedExecutablePath: '/tmp/.mount_zajelXXX/usr/bin/zajel',
            environment: {'APPIMAGE': '/home/user/Zajel.AppImage'},
            fileExists: (_) => false,
            isWindows: false,
            isMacOS: false,
            isLinux: true,
          ),
        ];

        for (final detector in nonStoreDetectors) {
          expect(detector.isStoreManaged(), isFalse,
              reason: '${detector.detect()} should not be store-managed');
        }
      });
    });
  });
}
