# US-6: MSIX/Store Users See Store Update Prompt

## Description

As a Windows MSIX user (or Mac App Store, Snap, or Flatpak user), I should not see the in-app auto-updater. The auto-update infrastructure (background download, staging, updater binary) is designed for "loose" installs distributed via GitHub Releases (Windows ZIP, macOS DMG, Linux tarball, AppImage). Store-managed packages already have their own update mechanisms, and attempting an in-app self-update would either fail (sandboxed file system) or conflict with the store's version tracking.

Instead, when the version policy indicates an update is required or available, these users should be redirected to the appropriate store to update.

---

## Acceptance Criteria

1. **Auto-update UI hidden for store installs**: The "Updates" section in Settings (check for updates, background download, auto-install toggles, install button) is completely hidden when the app is running from a store-managed package (MSIX, Mac App Store, Snap, Flatpak).

2. **Force update dialog shows store button**: When `VersionStatus` is `updateRequired` or `blocked`, the `ForceUpdateDialog` displays a platform-appropriate "Update via [Store Name]" button instead of the standard "Download and Install" button. The button opens the correct store listing for Zajel.

3. **Update prompt dialog shows store link**: When `VersionStatus` is `updateAvailable`, the `UpdatePromptDialog` shows a "View in [Store Name]" button that opens the store listing, rather than the in-app download/install flow.

4. **Detection is accurate**: The `UpdatePackageDetector` correctly identifies:
   - Windows MSIX (including sideloaded MSIX)
   - macOS App Store builds
   - Linux Snap packages
   - Linux Flatpak packages
   - Linux AppImage (supports auto-update, but via single-file replacement, not the standard updater flow -- see Out of Scope)

5. **Loose installs see auto-updater**: Windows ZIP, macOS DMG, and Linux tarball installs are correctly identified as supporting in-app auto-update. The standard update UI and flows apply.

6. **Store links open correctly**: Tapping the store button launches the correct store page:
   - Microsoft Store opens to the Zajel product page
   - Mac App Store opens to the Zajel listing
   - Snap Store opens to the Zajel snap page
   - Flathub opens to the Zajel Flatpak page

7. **Graceful fallback**: If the store deep link fails to open (e.g., store app not installed, protocol handler missing), fall back to opening the store's web URL in the default browser.

8. **Detection result is cached**: `UpdatePackageDetector` runs once at startup and caches the result. It does not perform file I/O or environment lookups on every access.

---

## Technical Context

### What Exists Today

**Version check infrastructure** (fully implemented):
- `VersionCheckService` (`lib/features/attestation/services/version_check_service.dart`) fetches version policy from `GET /attest/versions` on the bootstrap server.
- `VersionPolicy` model (`lib/features/attestation/models/version_policy.dart`) contains `minimumVersion`, `recommendedVersion`, `blockedVersions`, `sunsetDates`.
- `VersionStatus` enum: `upToDate`, `updateAvailable`, `updateRequired`, `blocked`.

**Dialog system** (fully implemented):
- `AttestationInitializer` (`lib/features/attestation/attestation_initializer.dart`) orchestrates version check on startup. On `updateAvailable`, shows `UpdatePromptDialog` (dismissable). On `updateRequired`/`blocked`, shows `ForceUpdateDialog` (blocking, replaces entire navigation stack).
- `ForceUpdateDialog` (`lib/features/attestation/widgets/force_update_dialog.dart`) is a full-screen blocking `Scaffold` wrapped in `PopScope(canPop: false)`. It accepts an optional `updateUrl` and opens it via `url_launcher`. Currently no `updateUrl` is passed from `AttestationInitializer`.
- `UpdatePromptDialog` (`lib/features/attestation/widgets/update_prompt_dialog.dart`) is an `AlertDialog` with "Later" and optional "Update" buttons. Also accepts `updateUrl` and opens via `url_launcher`. Currently no `updateUrl` is passed.

**Settings screen** (`lib/features/settings/settings_screen.dart`):
- Has sections: Profile, Appearance, Notifications, Audio & Video, Privacy & Security, External Connections, Debugging, About, Help & Info.
- No "Updates" section exists yet (planned by US-1 in the auto-updater plan).
- Already uses `Platform.isWindows`, `Platform.isLinux`, `Platform.isMacOS` for platform-specific behavior (e.g., log export).
- Has a `_isDesktop` getter for platform checks.

**No package format detection exists**: There is no `UpdatePackageDetector` or any code that checks whether the app is running from MSIX, Snap, Flatpak, AppImage, or Mac App Store. The `Platform.resolvedExecutable` is only used in `BinaryReaderDesktop` for binary attestation.

### What Needs to Change

1. **New class**: `UpdatePackageDetector` in `lib/features/updater/services/update_package_detector.dart`
2. **New provider**: `updatePackageDetectorProvider` in `lib/features/updater/providers/update_providers.dart`
3. **Modified**: `ForceUpdateDialog` -- accept and display store-specific update button
4. **Modified**: `UpdatePromptDialog` -- accept and display store-specific link
5. **Modified**: `AttestationInitializer` -- pass store URL to dialogs based on package format
6. **Modified**: `settings_screen.dart` -- conditionally hide Updates section (when it is added by US-1)

---

## Implementation Details

### 1. `UpdatePackageDetector` Class

**File**: `lib/features/updater/services/update_package_detector.dart`

```dart
import 'dart:io';

/// Detected distribution format for the running application.
enum DistributionFormat {
  /// Windows ZIP / loose executable (supports in-app auto-update)
  windowsZip,
  /// Windows MSIX package (store-managed or sideloaded)
  windowsMsix,
  /// macOS DMG / direct download (supports in-app auto-update)
  macosDmg,
  /// macOS App Store build
  macosAppStore,
  /// Linux tarball / loose binary (supports in-app auto-update)
  linuxTarball,
  /// Linux AppImage (single-file replacement)
  linuxAppImage,
  /// Linux Snap package (store-managed)
  linuxSnap,
  /// Linux Flatpak package (store-managed)
  linuxFlatpak,
  /// Unknown or unsupported platform
  unknown,
}

/// Detects the packaging format of the running application.
///
/// Used to determine whether the in-app auto-updater should be active
/// or whether the user should be redirected to a platform store.
///
/// Detection runs once and caches the result. All detection methods
/// are synchronous except [isMacAppStore] which checks for a receipt file.
class UpdatePackageDetector {
  DistributionFormat? _cached;

  /// Detect the distribution format. Result is cached after first call.
  DistributionFormat detect() {
    if (_cached != null) return _cached!;
    _cached = _detectInternal();
    return _cached!;
  }

  /// Whether this install supports in-app auto-update.
  ///
  /// Returns false for store-managed packages (MSIX, Mac App Store,
  /// Snap, Flatpak) where the store handles updates.
  bool supportsAutoUpdate() {
    final format = detect();
    switch (format) {
      case DistributionFormat.windowsZip:
      case DistributionFormat.macosDmg:
      case DistributionFormat.linuxTarball:
      case DistributionFormat.linuxAppImage:
        return true;
      case DistributionFormat.windowsMsix:
      case DistributionFormat.macosAppStore:
      case DistributionFormat.linuxSnap:
      case DistributionFormat.linuxFlatpak:
      case DistributionFormat.unknown:
        return false;
    }
  }

  /// Whether this install is managed by a platform store.
  bool isStoreManagedInstall() => !supportsAutoUpdate();

  /// Get the store name for display in UI.
  /// Returns null if not a store-managed install.
  String? storeName() {
    switch (detect()) {
      case DistributionFormat.windowsMsix:
        return 'Microsoft Store';
      case DistributionFormat.macosAppStore:
        return 'Mac App Store';
      case DistributionFormat.linuxSnap:
        return 'Snap Store';
      case DistributionFormat.linuxFlatpak:
        return 'Flathub';
      default:
        return null;
    }
  }

  /// Get the deep-link URI to open the store listing for Zajel.
  /// Returns null if not a store-managed install.
  ///
  /// Store IDs are placeholder constants that must be replaced with
  /// actual store listing IDs once the app is published to each store.
  String? storeDeepLink() {
    switch (detect()) {
      case DistributionFormat.windowsMsix:
        // TODO: Replace with actual Microsoft Store Product ID
        return 'ms-windows-store://pdp/?ProductId=ZAJEL_STORE_ID';
      case DistributionFormat.macosAppStore:
        // TODO: Replace with actual Mac App Store numeric ID
        return 'macappstores://itunes.apple.com/app/zajel/idZAJEL_APP_ID?mt=12';
      case DistributionFormat.linuxSnap:
        return 'snap://zajel';
      case DistributionFormat.linuxFlatpak:
        // Flathub has no registered URI scheme; use web URL
        // TODO: Replace with actual Flatpak app ID
        return 'https://flathub.org/apps/com.zajel.Zajel';
      default:
        return null;
    }
  }

  /// Fallback web URL for the store listing (when deep link fails).
  String? storeWebUrl() {
    switch (detect()) {
      case DistributionFormat.windowsMsix:
        // TODO: Replace with actual Store web URL
        return 'https://apps.microsoft.com/detail/ZAJEL_STORE_ID';
      case DistributionFormat.macosAppStore:
        // TODO: Replace with actual Mac App Store URL
        return 'https://apps.apple.com/app/zajel/idZAJEL_APP_ID';
      case DistributionFormat.linuxSnap:
        return 'https://snapcraft.io/zajel';
      case DistributionFormat.linuxFlatpak:
        return 'https://flathub.org/apps/com.zajel.Zajel';
      default:
        return null;
    }
  }

  DistributionFormat _detectInternal() {
    if (Platform.isWindows) {
      return _detectWindows();
    } else if (Platform.isMacOS) {
      return _detectMacOS();
    } else if (Platform.isLinux) {
      return _detectLinux();
    }
    return DistributionFormat.unknown;
  }

  /// Detect Windows package format.
  ///
  /// MSIX-installed apps run from a virtualized path under
  /// `C:\Program Files\WindowsApps\<PackageFamilyName>\`.
  /// Check if the resolved executable path contains `WindowsApps`.
  DistributionFormat _detectWindows() {
    final exePath = Platform.resolvedExecutable;
    if (exePath.contains(r'WindowsApps')) {
      return DistributionFormat.windowsMsix;
    }
    return DistributionFormat.windowsZip;
  }

  /// Detect macOS package format.
  ///
  /// Mac App Store builds contain a receipt file at
  /// `<AppBundle>/Contents/_MASReceipt/receipt`.
  DistributionFormat _detectMacOS() {
    final exePath = Platform.resolvedExecutable;
    // resolvedExecutable is like:
    //   /Applications/Zajel.app/Contents/MacOS/zajel
    // Walk up to the .app bundle root.
    final appBundlePath = _findAppBundlePath(exePath);
    if (appBundlePath != null) {
      final receiptFile = File(
        '$appBundlePath/Contents/_MASReceipt/receipt',
      );
      if (receiptFile.existsSync()) {
        return DistributionFormat.macosAppStore;
      }
    }
    return DistributionFormat.macosDmg;
  }

  /// Detect Linux package format.
  ///
  /// Check environment variables set by each packaging system:
  /// - `$SNAP` for Snap packages
  /// - `$FLATPAK_ID` for Flatpak packages
  /// - `$APPIMAGE` for AppImage
  DistributionFormat _detectLinux() {
    final env = Platform.environment;
    if (env.containsKey('SNAP')) {
      return DistributionFormat.linuxSnap;
    }
    if (env.containsKey('FLATPAK_ID')) {
      return DistributionFormat.linuxFlatpak;
    }
    if (env.containsKey('APPIMAGE')) {
      return DistributionFormat.linuxAppImage;
    }
    return DistributionFormat.linuxTarball;
  }

  /// Walk up the path to find the `.app` bundle root.
  /// Returns null if no `.app` directory is found.
  static String? _findAppBundlePath(String exePath) {
    final parts = exePath.split('/');
    for (var i = parts.length - 1; i >= 0; i--) {
      if (parts[i].endsWith('.app')) {
        return parts.sublist(0, i + 1).join('/');
      }
    }
    return null;
  }
}
```

#### Detection Method Details

| Format | Detection Method | Reliability |
|---|---|---|
| **Windows MSIX** | `Platform.resolvedExecutable` contains `WindowsApps` | High. All MSIX installs (Store and sideloaded) run from `C:\Program Files\WindowsApps\`. No false positives from ZIP installs. |
| **Mac App Store** | Receipt file exists at `<bundle>/Contents/_MASReceipt/receipt` | High. Apple places this file in all App Store-distributed builds. Not present in DMG/ZIP installs. Validated by Apple's own documentation. |
| **Snap** | `$SNAP` environment variable is set | High. Snapd always sets this. Never set outside snap confinement. |
| **Flatpak** | `$FLATPAK_ID` environment variable is set | High. Flatpak runtime always sets this. Never set outside Flatpak sandbox. |
| **AppImage** | `$APPIMAGE` environment variable is set | High. AppImage runtime sets this to the full path of the `.AppImage` file. |
| **Loose / ZIP / DMG / tarball** | None of the above conditions match | Default fallback. |

### 2. `supportsAutoUpdate()` as the Gate

The `supportsAutoUpdate()` method is the single boolean gate used throughout the codebase to decide whether the in-app auto-updater is active:

- **Settings screen**: Only show "Updates" section when `supportsAutoUpdate()` is true.
- **Pre-download flow**: Only start background downloads when `supportsAutoUpdate()` is true.
- **Update orchestrator**: Skip update staging and updater launch when `supportsAutoUpdate()` is false.
- **Dialogs**: Use `isStoreManagedInstall()` to switch between "Download & Install" and "Update via Store" buttons.

### 3. Modified `ForceUpdateDialog`

Add new parameters to support store-specific messaging:

```dart
class ForceUpdateDialog extends StatelessWidget {
  final String? updateUrl;
  final String? requiredVersion;
  final bool isBlocked;
  // New parameters:
  final bool isStoreManaged;
  final String? storeName;      // e.g., "Microsoft Store"
  final String? storeDeepLink;  // e.g., "ms-windows-store://pdp/?ProductId=..."
  final String? storeWebUrl;    // Fallback web URL

  // ...

  @override
  Widget build(BuildContext context) {
    // ... existing layout ...

    // Replace the existing button with conditional logic:
    if (isStoreManaged && storeDeepLink != null) {
      // Show "Update via Microsoft Store" button
      FilledButton.icon(
        onPressed: () => _openStoreLink(context),
        icon: const Icon(Icons.store),
        label: Text('Update via $storeName'),
        style: FilledButton.styleFrom(
          minimumSize: const Size(200, 48),
        ),
      );
    } else if (updateUrl != null) {
      // Show standard "Update Now" / "Download and Install" button
      // (for loose installs, this will be handled by the auto-updater in US-7)
      FilledButton.icon(
        onPressed: () => _openUpdateUrl(context),
        icon: const Icon(Icons.open_in_new),
        label: const Text('Update Now'),
        style: FilledButton.styleFrom(
          minimumSize: const Size(200, 48),
        ),
      );
    }
  }

  Future<void> _openStoreLink(BuildContext context) async {
    // Try deep link first, fall back to web URL
    final deepUri = Uri.parse(storeDeepLink!);
    if (await canLaunchUrl(deepUri)) {
      await launchUrl(deepUri, mode: LaunchMode.externalApplication);
    } else if (storeWebUrl != null) {
      final webUri = Uri.parse(storeWebUrl!);
      if (await canLaunchUrl(webUri)) {
        await launchUrl(webUri, mode: LaunchMode.externalApplication);
      }
    }
  }
}
```

### 4. Modified `UpdatePromptDialog`

Same pattern -- add store-aware parameters:

```dart
class UpdatePromptDialog extends StatelessWidget {
  final String? updateUrl;
  final String? recommendedVersion;
  // New parameters:
  final bool isStoreManaged;
  final String? storeName;
  final String? storeDeepLink;
  final String? storeWebUrl;

  // In actions list:
  if (isStoreManaged && storeDeepLink != null)
    FilledButton(
      onPressed: () async {
        await _openStoreLink(context);
        if (context.mounted) Navigator.of(context).pop(true);
      },
      child: Text('View in $storeName'),
    )
  else if (updateUrl != null)
    FilledButton(
      onPressed: () async { /* existing URL launch logic */ },
      child: const Text('Update'),
    ),
}
```

### 5. Modified `AttestationInitializer`

The initializer needs to read the package detector and pass store information to dialogs:

```dart
static void _showUpdatePrompt(BuildContext context, VersionPolicy? policy) {
  final detector = UpdatePackageDetector(); // or read from provider
  showDialog(
    context: context,
    barrierDismissible: true,
    builder: (_) => UpdatePromptDialog(
      recommendedVersion: policy?.recommendedVersion,
      isStoreManaged: detector.isStoreManagedInstall(),
      storeName: detector.storeName(),
      storeDeepLink: detector.storeDeepLink(),
      storeWebUrl: detector.storeWebUrl(),
    ),
  );
}

static void _showForceUpdate(
  BuildContext context, {
  String? requiredVersion,
  bool isBlocked = false,
}) {
  final detector = UpdatePackageDetector();
  Navigator.of(context).pushAndRemoveUntil(
    MaterialPageRoute(
      builder: (_) => ForceUpdateDialog(
        requiredVersion: requiredVersion,
        isBlocked: isBlocked,
        isStoreManaged: detector.isStoreManagedInstall(),
        storeName: detector.storeName(),
        storeDeepLink: detector.storeDeepLink(),
        storeWebUrl: detector.storeWebUrl(),
      ),
    ),
    (_) => false,
  );
}
```

### 6. Settings Screen -- Hide Updates Section

When the "Updates" section is added by US-1, it should be conditionally rendered:

```dart
// In settings_screen.dart build method:
final detector = ref.watch(updatePackageDetectorProvider);
final showUpdatesSection = _isDesktop && detector.supportsAutoUpdate();

if (showUpdatesSection) ...[
  const SizedBox(height: 24),
  _buildUpdatesSection(context),
],
```

For store-managed installs, optionally show a read-only info tile:

```dart
if (_isDesktop && !detector.supportsAutoUpdate()) ...[
  const SizedBox(height: 24),
  _buildSection(
    context,
    title: 'Updates',
    children: [
      ListTile(
        leading: const Icon(Icons.store),
        title: Text('Managed by ${detector.storeName()}'),
        subtitle: const Text('Updates are handled by your platform store'),
      ),
    ],
  ),
],
```

### 7. Platform-Specific Store Deep Links

| Platform | Deep Link URI | Fallback Web URL |
|---|---|---|
| **Microsoft Store** | `ms-windows-store://pdp/?ProductId={PRODUCT_ID}` | `https://apps.microsoft.com/detail/{PRODUCT_ID}` |
| **Mac App Store** | `macappstores://itunes.apple.com/app/zajel/id{APP_ID}?mt=12` | `https://apps.apple.com/app/zajel/id{APP_ID}` |
| **Snap Store** | `snap://zajel` | `https://snapcraft.io/zajel` |
| **Flathub** | N/A (no registered URI scheme) | `https://flathub.org/apps/{APP_ID}` |

Notes:
- Microsoft Store Product ID (e.g., `9WZDNCRFHVJL`) is assigned when the app is published to Partner Center. This is a placeholder until publishing.
- Mac App Store numeric ID is assigned when the app listing is created in App Store Connect. Placeholder until publishing.
- The `snap://` protocol opens the Snap Store GUI if installed. Falls back to the web URL.
- Flatpak has no desktop URI scheme handler. Always opens the Flathub web URL.

### 8. Riverpod Provider

**File**: `lib/features/updater/providers/update_providers.dart`

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/update_package_detector.dart';

/// Provides the singleton UpdatePackageDetector instance.
///
/// The detector runs detection once and caches the result,
/// so this provider is safe to read from multiple widgets.
final updatePackageDetectorProvider = Provider<UpdatePackageDetector>((ref) {
  return UpdatePackageDetector();
});

/// Convenience provider for the detected distribution format.
final distributionFormatProvider = Provider<DistributionFormat>((ref) {
  return ref.watch(updatePackageDetectorProvider).detect();
});

/// Whether the app supports in-app auto-update.
final supportsAutoUpdateProvider = Provider<bool>((ref) {
  return ref.watch(updatePackageDetectorProvider).supportsAutoUpdate();
});
```

---

## Detection Reliability and Edge Cases

### Can Detection Be Fooled?

| Scenario | Detection Result | Impact |
|---|---|---|
| **Sideloaded MSIX** (installed via `Add-AppxPackage` or App Installer, not from Store) | Detected as `windowsMsix` (path still under `WindowsApps`) | User sees "Update via Microsoft Store" but app may not be in Store. Acceptable -- sideloaded MSIX users expect store-like behavior; they can also reinstall from GitHub Releases. |
| **Dev build run from Visual Studio** on Windows | Detected as `windowsZip` (path is in project build output, not `WindowsApps`) | Correct. Developer sees auto-update UI (which will not find updates in dev mode). |
| **MSIX dev deploy from Visual Studio** | Detected as `windowsMsix` (deploys to `WindowsApps`) | Developer sees store redirect. Minor nuisance in dev; acceptable. Can be overridden via `--dart-define=FORCE_AUTO_UPDATE=true` if needed. |
| **macOS dev build** (run from Xcode or `flutter run`) | Detected as `macosDmg` (no receipt file in dev builds) | Correct. |
| **User copies app into `WindowsApps` manually** | Detected as `windowsMsix` | Extremely unlikely. Would require admin privileges and manually placing files in a protected directory. |
| **AppImage moved to `/opt/`** | Detected as `linuxAppImage` (the `$APPIMAGE` env var is set by the AppImage runtime regardless of where the file lives) | Correct. AppImage detection is based on the runtime environment variable, not file location. |
| **Snap in classic confinement** | Detected as `linuxSnap` (`$SNAP` is still set) | Correct. Classic confinement still sets snap environment variables. |
| **Running inside Docker/container** | Detected as `linuxTarball` (no store env vars set, unless the container was built from a snap/flatpak base) | Correct for typical container usage. |
| **`$SNAP` set manually by user** (e.g., in `.bashrc`) | False positive: detected as `linuxSnap` | Very unlikely in practice. Users do not arbitrarily set `$SNAP`. If they do, they presumably want snap-like behavior. |
| **macOS TestFlight build** | Receipt file may be present but in a different location. Detection may return `macosAppStore`. | Acceptable. TestFlight builds should also redirect to the App Store for updates. |

### Edge Cases Requiring Special Handling

1. **First-time detection on cold start**: Detection involves one `File.existsSync()` call on macOS and environment variable reads on other platforms. All are fast (< 1ms). No async needed.

2. **Platform.resolvedExecutable on symlinks**: `resolvedExecutable` resolves symlinks, so a symlink from `/usr/bin/zajel` to `/snap/zajel/current/bin/zajel` will resolve to the snap path. However, detection relies on `$SNAP` env var, not path, so this is a non-issue.

3. **Windows long paths**: `WindowsApps` path check uses `String.contains()`, which works regardless of path length or drive letter.

---

## Error Handling

1. **Store deep link fails**: If `canLaunchUrl()` returns false for the deep link URI, fall back to `storeWebUrl()`. If that also fails, show a `SnackBar` with the message "Could not open store. Please update manually from [store name]."

2. **Detection throws**: Wrap `_detectInternal()` in try-catch. On any exception (e.g., `FileSystemException` reading receipt file on macOS), default to `DistributionFormat.unknown`, which disables auto-update. Log the error. This is fail-safe: users can always manually download from GitHub Releases.

3. **Store not installed**: On Linux, the Snap Store GUI or GNOME Software may not be installed. The `snap://` protocol only works if a handler is registered. Fall back to the web URL `https://snapcraft.io/zajel`.

4. **url_launcher failure**: The existing `url_launcher` package is already a dependency. Use `launchUrl()` with `mode: LaunchMode.externalApplication` for all store links. This delegates to the OS to find the appropriate handler.

---

## Dependencies

**This story has no dependencies on other US stories.** It can be implemented as the very first task in the auto-updater work because:

- `UpdatePackageDetector` is self-contained (only uses `dart:io`).
- The dialog modifications are additive (new optional parameters with sensible defaults).
- The settings screen change is a conditional guard that defaults to no-op until US-1 adds the Updates section.

**Package dependencies**: None new. Uses only `dart:io` (for `Platform`, `File`) and the existing `url_launcher` package.

---

## Testing Strategy

### Unit Tests for `UpdatePackageDetector`

**File**: `test/features/updater/services/update_package_detector_test.dart`

Testing detection methods directly is difficult because they depend on `Platform.resolvedExecutable` and `Platform.environment`, which are static and cannot be mocked. Use dependency injection to make the detector testable:

```dart
class UpdatePackageDetector {
  final String resolvedExecutable;
  final Map<String, String> environment;
  final bool Function(String path) fileExists;

  UpdatePackageDetector({
    String? resolvedExecutable,
    Map<String, String>? environment,
    bool Function(String path)? fileExists,
  })  : resolvedExecutable =
            resolvedExecutable ?? Platform.resolvedExecutable,
        environment = environment ?? Platform.environment,
        fileExists = fileExists ?? ((path) => File(path).existsSync());
}
```

This allows tests to inject fake values:

```dart
group('Windows detection', () {
  test('detects MSIX when path contains WindowsApps', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable:
          r'C:\Program Files\WindowsApps\Zajel_1.0.0_x64\zajel.exe',
      environment: {},
      fileExists: (_) => false,
    );
    expect(detector.detect(), DistributionFormat.windowsMsix);
    expect(detector.supportsAutoUpdate(), isFalse);
    expect(detector.storeName(), 'Microsoft Store');
  });

  test('detects ZIP when path is normal directory', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable: r'C:\Users\user\AppData\Local\Zajel\zajel.exe',
      environment: {},
      fileExists: (_) => false,
    );
    expect(detector.detect(), DistributionFormat.windowsZip);
    expect(detector.supportsAutoUpdate(), isTrue);
    expect(detector.storeName(), isNull);
  });
});

group('macOS detection', () {
  test('detects App Store when receipt file exists', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable:
          '/Applications/Zajel.app/Contents/MacOS/zajel',
      environment: {},
      fileExists: (path) =>
          path == '/Applications/Zajel.app/Contents/_MASReceipt/receipt',
    );
    expect(detector.detect(), DistributionFormat.macosAppStore);
    expect(detector.supportsAutoUpdate(), isFalse);
  });

  test('detects DMG when no receipt file', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable:
          '/Applications/Zajel.app/Contents/MacOS/zajel',
      environment: {},
      fileExists: (_) => false,
    );
    expect(detector.detect(), DistributionFormat.macosDmg);
    expect(detector.supportsAutoUpdate(), isTrue);
  });
});

group('Linux detection', () {
  test('detects Snap when SNAP env is set', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable: '/snap/zajel/123/bin/zajel',
      environment: {'SNAP': '/snap/zajel/123'},
      fileExists: (_) => false,
    );
    expect(detector.detect(), DistributionFormat.linuxSnap);
  });

  test('detects Flatpak when FLATPAK_ID env is set', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable: '/app/bin/zajel',
      environment: {'FLATPAK_ID': 'com.zajel.Zajel'},
      fileExists: (_) => false,
    );
    expect(detector.detect(), DistributionFormat.linuxFlatpak);
  });

  test('detects AppImage when APPIMAGE env is set', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable: '/tmp/.mount_zajelXXX/usr/bin/zajel',
      environment: {'APPIMAGE': '/home/user/Zajel.AppImage'},
      fileExists: (_) => false,
    );
    expect(detector.detect(), DistributionFormat.linuxAppImage);
    expect(detector.supportsAutoUpdate(), isTrue); // AppImage supports self-update
  });

  test('detects tarball when no store env vars', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable: '/opt/zajel/zajel',
      environment: {},
      fileExists: (_) => false,
    );
    expect(detector.detect(), DistributionFormat.linuxTarball);
    expect(detector.supportsAutoUpdate(), isTrue);
  });

  test('Snap takes precedence over APPIMAGE if both set', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable: '/snap/zajel/123/bin/zajel',
      environment: {
        'SNAP': '/snap/zajel/123',
        'APPIMAGE': '/something',
      },
      fileExists: (_) => false,
    );
    expect(detector.detect(), DistributionFormat.linuxSnap);
  });
});

group('caching', () {
  test('detect() returns same result on subsequent calls', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable: r'C:\Program Files\WindowsApps\zajel.exe',
      environment: {},
      fileExists: (_) => false,
    );
    final first = detector.detect();
    final second = detector.detect();
    expect(identical(first, second), isTrue);
  });
});

group('store links', () {
  test('storeDeepLink returns correct URI for each format', () {
    // Test each store-managed format returns a non-null deep link
    // and that the URI is parseable.
  });

  test('storeWebUrl returns correct fallback URL', () {
    // Test each store-managed format returns a non-null web URL.
  });

  test('non-store formats return null for store links', () {
    final detector = UpdatePackageDetector(
      resolvedExecutable: r'C:\Users\user\zajel\zajel.exe',
      environment: {},
      fileExists: (_) => false,
    );
    expect(detector.storeDeepLink(), isNull);
    expect(detector.storeWebUrl(), isNull);
    expect(detector.storeName(), isNull);
  });
});
```

### Widget Tests for Dialog Variants

**File**: `test/features/attestation/widgets/force_update_dialog_test.dart`

```dart
group('ForceUpdateDialog', () {
  testWidgets('shows store button when isStoreManaged is true', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: ForceUpdateDialog(
        requiredVersion: '2.0.0',
        isStoreManaged: true,
        storeName: 'Microsoft Store',
        storeDeepLink: 'ms-windows-store://pdp/?ProductId=TEST',
      ),
    ));
    expect(find.text('Update via Microsoft Store'), findsOneWidget);
    expect(find.byIcon(Icons.store), findsOneWidget);
    expect(find.text('Update Now'), findsNothing);
  });

  testWidgets('shows standard button when isStoreManaged is false', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: ForceUpdateDialog(
        requiredVersion: '2.0.0',
        updateUrl: 'https://github.com/...',
        isStoreManaged: false,
      ),
    ));
    expect(find.text('Update Now'), findsOneWidget);
    expect(find.text('Update via Microsoft Store'), findsNothing);
  });

  testWidgets('cannot be dismissed with back button', (tester) async {
    // Existing test -- verify PopScope(canPop: false) still works.
  });
});
```

**File**: `test/features/attestation/widgets/update_prompt_dialog_test.dart`

```dart
group('UpdatePromptDialog', () {
  testWidgets('shows store link when isStoreManaged is true', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: UpdatePromptDialog(
          recommendedVersion: '1.5.0',
          isStoreManaged: true,
          storeName: 'Snap Store',
          storeDeepLink: 'snap://zajel',
        ),
      ),
    ));
    expect(find.text('View in Snap Store'), findsOneWidget);
    expect(find.text('Update'), findsNothing);
  });

  testWidgets('shows standard update button when not store managed', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: UpdatePromptDialog(
          recommendedVersion: '1.5.0',
          updateUrl: 'https://github.com/...',
          isStoreManaged: false,
        ),
      ),
    ));
    expect(find.text('Update'), findsOneWidget);
  });

  testWidgets('Later button dismisses dialog', (tester) async {
    // Existing behavior -- verify it still works.
  });
});
```

### Provider Tests

```dart
test('updatePackageDetectorProvider provides singleton', () {
  final container = ProviderContainer();
  final a = container.read(updatePackageDetectorProvider);
  final b = container.read(updatePackageDetectorProvider);
  expect(identical(a, b), isTrue);
});
```

---

## Out of Scope

1. **AppImage self-update flow**: AppImages support delta updates via `AppImageUpdate`. This is a different mechanism from the standard updater binary (single file replacement vs. directory swap). AppImage auto-update will be handled in a separate story if needed. For now, AppImage is marked as `supportsAutoUpdate() == true` and will use the standard updater binary which replaces the single AppImage file.

2. **Publishing to stores**: Actually publishing Zajel to the Microsoft Store, Mac App Store, Snap Store, or Flathub is out of scope. This story only implements detection and redirection. Store publishing is a separate initiative.

3. **Store-specific version checking**: This story does not add store-specific update checking (e.g., querying the Microsoft Store API for the latest version). The existing `VersionCheckService` from the bootstrap server is the single source of truth for version policy across all distribution formats.

4. **In-app update download and install**: The actual auto-update download, staging, updater binary launch, and rollback are covered by US-1 through US-5 and US-7.

5. **Mobile platforms**: iOS and Android have their own store-managed update flows and are not part of the desktop auto-updater plan.

6. **Compile-time override**: A `--dart-define=FORCE_AUTO_UPDATE=true` flag to bypass store detection during development could be useful but is not required for this story. Can be added later if developers find the store redirect annoying during MSIX dev builds.

---

## Files to Create

| File | Purpose |
|---|---|
| `lib/features/updater/services/update_package_detector.dart` | `UpdatePackageDetector` class with all detection logic |
| `lib/features/updater/providers/update_providers.dart` | Riverpod providers for detector and convenience accessors |
| `test/features/updater/services/update_package_detector_test.dart` | Unit tests for all detection methods |
| `test/features/attestation/widgets/force_update_dialog_test.dart` | Widget tests for store-aware ForceUpdateDialog |
| `test/features/attestation/widgets/update_prompt_dialog_test.dart` | Widget tests for store-aware UpdatePromptDialog |

## Files to Modify

| File | Change |
|---|---|
| `lib/features/attestation/widgets/force_update_dialog.dart` | Add `isStoreManaged`, `storeName`, `storeDeepLink`, `storeWebUrl` parameters; conditional button rendering |
| `lib/features/attestation/widgets/update_prompt_dialog.dart` | Add same store-aware parameters; conditional button rendering |
| `lib/features/attestation/attestation_initializer.dart` | Read `UpdatePackageDetector` and pass store info to dialog constructors |
| `lib/features/settings/settings_screen.dart` | Guard future Updates section with `supportsAutoUpdate()` check; optional "Managed by [Store]" info tile |
