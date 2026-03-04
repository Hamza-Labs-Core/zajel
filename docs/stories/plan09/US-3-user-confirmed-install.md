# US-3: User-Confirmed Update Install

## Description

As a desktop user, when an update has been downloaded and verified, I want to click "Install Update" and have the app seamlessly update and relaunch, with total downtime under 10 seconds.

The current update flow in Zajel opens an external URL via `url_launcher` (see `UpdatePromptDialog` and `ForceUpdateDialog` in `packages/app/lib/features/attestation/widgets/`). This story replaces that browser-redirect flow on desktop platforms with an in-process update that writes a JSON manifest, launches an external Go updater binary, exits the app gracefully, and relaunches the new version -- all triggered by a single button click.

---

## Acceptance Criteria

1. **Single-click install**: When the update state is `READY` (download verified), clicking "Install Update" in either the Settings screen, the `UpdatePromptDialog`, or the `UpdateReadyBanner` triggers the full install sequence with no further user interaction required.

2. **Manifest written correctly**: Before launching the updater, the app writes a `manifest.json` file to the staging directory containing all fields defined in the IPC schema (schema_version, app_pid, app_version_current, app_version_target, install_dir, staging_dir, backup_dir, app_executable, platform, checksum_sha256, timestamp). The file is valid JSON and readable by the Go updater.

3. **Updater binary copied to external location**: Before invocation, the app copies the updater binary from the staged download to a platform-specific external directory outside the install directory (Windows: `%LOCALAPPDATA%\Zajel\updater\`, macOS: `~/Library/Application Support/com.zajel.zajel/updater/`, Linux: `~/.local/share/zajel/updater/`). The copy is verified to exist and is executable.

4. **Updater launched as detached process**: The updater is started via `Process.start` with `ProcessStartMode.detached` so it survives the parent app exit. The `--manifest` and `--pid` flags are passed on the command line.

5. **Graceful app shutdown**: After launching the updater, the app performs a graceful shutdown: closes all WebRTC connections, disconnects the signaling client, flushes logs, and then calls `exit(0)`. Total shutdown time must not exceed 3 seconds.

6. **Go updater waits for app exit**: The updater polls/waits for the app PID to fully exit before performing any file operations. Maximum wait is 30 seconds. If the process has not exited after 30 seconds, the updater sends SIGTERM (Unix) or TerminateProcess (Windows) and waits 10 more seconds before failing with exit code 3.

7. **Backup before replace**: The updater creates a full copy of the current install directory in the backup directory before overwriting any files. If backup creation fails, the updater exits with code 4 and no files are modified.

8. **File replacement completes**: The updater copies all files from the staging directory to the install directory, overwriting the previous installation. On failure, it rolls back from backup (exit code 6 on rollback success, 7 on rollback failure).

9. **New app launched**: After successful replacement, the updater launches the new app executable from the install directory and then exits with code 0.

10. **Downtime under 10 seconds**: From the moment the old app window closes to the moment the new app window appears, elapsed wall-clock time is under 10 seconds on a machine with an SSD. This is measured as: app exit (~1s) + PID wait settle (~1s) + backup (~2s) + copy (~2s) + launch (~2s) = ~8s.

11. **Update result persisted**: The updater writes an `update-result.json` file to the staging parent directory containing the exit code, timestamp, previous version, new version, and status ("success", "rollback", "failed"). The new app reads this on startup to display a success toast or error message.

12. **Store-distributed builds excluded**: If the app is running as MSIX, Snap, Flatpak, or Mac App Store build (detected by `UpdatePackageDetector`), the "Install Update" button is never shown. The existing URL-based update flow is preserved for those distributions.

13. **Error feedback to user**: If the updater binary is missing, the manifest cannot be written, or the updater fails to launch, the app displays a SnackBar error message and does NOT exit. The user can retry or fall back to manual download.

---

## Technical Context

### What exists today

- **`VersionCheckService`** (`packages/app/lib/features/attestation/services/version_check_service.dart`): Fetches version policy from `GET /attest/versions` on the bootstrap server. Returns `VersionStatus` enum: `upToDate`, `updateAvailable`, `updateRequired`, `blocked`.

- **`VersionPolicy`** model (`packages/app/lib/features/attestation/models/version_policy.dart`): Contains `minimumVersion`, `recommendedVersion`, `blockedVersions`, `sunsetDates`.

- **`AttestationInitializer`** (`packages/app/lib/features/attestation/attestation_initializer.dart`): On app start, calls `_runVersionCheck()` and shows either `UpdatePromptDialog` (dismissable, for `updateAvailable`) or `ForceUpdateDialog` (blocking, for `updateRequired`/`blocked`).

- **`UpdatePromptDialog`** (`packages/app/lib/features/attestation/widgets/update_prompt_dialog.dart`): Shows "Update Available" dialog with "Later" and "Update" buttons. The "Update" button calls `launchUrl()` to open a URL in the browser. Accepts optional `updateUrl` and `recommendedVersion`.

- **`ForceUpdateDialog`** (`packages/app/lib/features/attestation/widgets/force_update_dialog.dart`): Full-screen blocking dialog with "Update Now" button that also calls `launchUrl()`. Cannot be dismissed.

- **`Environment`** class (`packages/app/lib/core/config/environment.dart`): Compile-time constants via `--dart-define`. Provides `version`, `fullVersion`, `env`, and platform detection. Uses `Platform.resolvedExecutable` elsewhere in the codebase for binary path detection (see `BinaryReaderDesktop`).

- **Graceful shutdown** in `main.dart`: `_ZajelAppState` listens for `AppLifecycleState.detached` and calls `_disposeServicesSync()` which calls `connectionManager.dispose()` (closes WebRTC, signaling, stream controllers) and `logger.dispose()`.

- **Process launching**: The codebase uses `Process.run()` for platform-specific file/directory opening (e.g., `xdg-open`, `open`, `explorer` in `settings_screen.dart` and `chat_screen.dart`). There is no existing use of `Process.start()` with `ProcessStartMode.detached`.

### What needs to change

1. **New Dart model**: `UpdateManifest` class for serializing/deserializing the manifest JSON.
2. **New Dart service**: `UpdaterLauncher` -- writes manifest, copies updater binary, launches it as detached process, initiates graceful shutdown.
3. **New Go binary**: `packages/app/updater/` -- the updater that reads the manifest, waits for PID, performs backup/replace/launch.
4. **Modified dialogs**: `UpdatePromptDialog` and `ForceUpdateDialog` gain desktop-aware paths that call `UpdaterLauncher` instead of `launchUrl()`.
5. **New startup check**: On launch, read `update-result.json` if present and show success/failure feedback.

---

## Implementation Details

### 1. Update Manifest (IPC Protocol)

The manifest is the IPC contract between the Flutter app and the Go updater. The app writes it; the updater reads it.

**File location**: `<staging_parent>/manifest.json` (e.g., `%LOCALAPPDATA%\Zajel\update-staging\manifest.json`)

**JSON schema**:

```json
{
  "schema_version": 1,
  "app_pid": 12345,
  "app_version_current": "1.0.0",
  "app_version_target": "1.2.0",
  "install_dir": "/home/user/.local/share/zajel/app",
  "staging_dir": "/home/user/.local/share/zajel/update-staging/zajel-1.2.0-linux",
  "backup_dir": "/home/user/.local/share/zajel/update-backup",
  "app_executable": "zajel",
  "platform": "linux",
  "checksum_sha256": "e3b0c44298fc1c149afbf4c8996fb924...",
  "timestamp": "2026-03-03T12:00:00Z"
}
```

**Dart model** (`packages/app/lib/features/updater/models/update_manifest.dart`):

```dart
import 'dart:convert';
import 'dart:io';

class UpdateManifest {
  static const int currentSchemaVersion = 1;

  final int schemaVersion;
  final int appPid;
  final String appVersionCurrent;
  final String appVersionTarget;
  final String installDir;
  final String stagingDir;
  final String backupDir;
  final String appExecutable;
  final String platform;
  final String checksumSha256;
  final DateTime timestamp;

  UpdateManifest({
    this.schemaVersion = currentSchemaVersion,
    required this.appPid,
    required this.appVersionCurrent,
    required this.appVersionTarget,
    required this.installDir,
    required this.stagingDir,
    required this.backupDir,
    required this.appExecutable,
    required this.platform,
    required this.checksumSha256,
    DateTime? timestamp,
  }) : timestamp = timestamp ?? DateTime.now().toUtc();

  Map<String, dynamic> toJson() => {
    'schema_version': schemaVersion,
    'app_pid': appPid,
    'app_version_current': appVersionCurrent,
    'app_version_target': appVersionTarget,
    'install_dir': installDir,
    'staging_dir': stagingDir,
    'backup_dir': backupDir,
    'app_executable': appExecutable,
    'platform': platform,
    'checksum_sha256': checksumSha256,
    'timestamp': timestamp.toIso8601String(),
  };

  Future<void> writeToFile(String path) async {
    final file = File(path);
    await file.parent.create(recursive: true);
    await file.writeAsString(
      const JsonEncoder.withIndent('  ').convert(toJson()),
    );
  }
}
```

### 2. Updater Binary Location Management

The updater binary must live OUTSIDE the install directory because it replaces that directory's contents. The app is responsible for copying the updater from the staged download to the external location before launching it.

**External updater paths**:
- **Windows**: `%LOCALAPPDATA%\Zajel\updater\zajel-updater.exe`
- **macOS**: `~/Library/Application Support/com.zajel.zajel/updater/zajel-updater`
- **Linux**: `~/.local/share/zajel/updater/zajel-updater`

**Copy strategy**:

1. Each release artifact includes the updater binary alongside the app files (placed there by CI).
2. When preparing to install, the app first checks whether the external updater location already has a binary.
3. The app copies the NEW updater from the staging directory to the external location, overwriting the old one. This ensures the updater is always from the latest release (self-update per plan section 4.9).
4. On Linux, `chmod +x` is applied to the copied binary via `Process.run('chmod', ['+x', path])`.
5. On macOS, `xattr -rd com.apple.quarantine` is run on the binary to clear Gatekeeper quarantine.

**Updater binary name within staged artifacts**:
- Windows: `zajel-updater.exe` in the root of the staged artifact directory
- macOS: `zajel-updater` in `zajel.app/Contents/Resources/` or a top-level `updater/` directory
- Linux: `zajel-updater` in the root of the staged artifact directory

### 3. UpdaterLauncher Service

**File**: `packages/app/lib/features/updater/services/updater_launcher.dart`

This is the central orchestration point that the UI calls. It coordinates manifest writing, updater copying, process launching, and app shutdown.

```dart
class UpdaterLauncher {
  static const _tag = 'UpdaterLauncher';

  final String stagingDir;
  final String installDir;
  final String targetVersion;
  final String currentVersion;
  final String checksumSha256;

  /// Perform the full update install sequence.
  ///
  /// Returns normally if the updater was launched successfully
  /// (the app will exit shortly after). Throws on any failure
  /// (the app should remain running and show an error).
  Future<void> launchUpdate() async {
    // 1. Resolve paths
    final updaterExternalPath = _getUpdaterExternalPath();
    final manifestPath = _getManifestPath();
    final backupDir = _getBackupDir();

    // 2. Copy updater binary to external location
    await _copyUpdaterBinary(updaterExternalPath);

    // 3. Write manifest with current PID
    final manifest = UpdateManifest(
      appPid: pid, // dart:io pid
      appVersionCurrent: currentVersion,
      appVersionTarget: targetVersion,
      installDir: installDir,
      stagingDir: stagingDir,
      backupDir: backupDir,
      appExecutable: _getAppExecutableName(),
      platform: _getPlatformString(),
      checksumSha256: checksumSha256,
    );
    await manifest.writeToFile(manifestPath);

    // 4. Launch updater as detached process
    await Process.start(
      updaterExternalPath,
      ['--manifest', manifestPath, '--pid', pid.toString()],
      mode: ProcessStartMode.detached,
    );

    // 5. Graceful shutdown (see next section)
    await _gracefulShutdown();
  }
}
```

**Key design decisions**:

- `Process.start` with `ProcessStartMode.detached` is used so the updater survives the parent app's exit. In detached mode, the child process has no connection to its parent and can keep running when the parent dies.
- The current process PID is obtained from `dart:io`'s top-level `pid` getter.
- The manifest path and updater binary path are derived from platform-specific application data directories.

### 4. App Graceful Shutdown Sequence

After the updater is launched as a detached process, the app must shut down cleanly so that:
- WebRTC connections are closed (peers see a clean disconnect, not a timeout)
- The signaling WebSocket is disconnected
- Database connections are flushed
- Log files are flushed and closed
- The process exits so the updater can replace files

**Shutdown sequence** (executed in `UpdaterLauncher._gracefulShutdown()`):

```
1. Close all WebRTC peer connections    (~200ms)
   - ConnectionManager.dispose()
   - Closes signaling client
   - Closes all stream controllers

2. Flush logger                         (~100ms)
   - logger.dispose()

3. Exit the process                     (~0ms)
   - exit(0)
```

This mirrors the existing `_disposeServicesSync()` method in `main.dart` (`_ZajelAppState`) which already calls `connectionManager.dispose()` and `logger.dispose()`. The difference is that `UpdaterLauncher` calls this explicitly and then calls `exit(0)` to force immediate process termination, rather than waiting for the Flutter framework's natural shutdown path.

**Timeout guard**: A `Timer` of 3 seconds is started before the shutdown sequence. If the cleanup has not completed in 3 seconds, `exit(0)` is called anyway. The updater will wait for the PID to disappear regardless.

```dart
Future<void> _gracefulShutdown() async {
  // Hard deadline: exit no matter what after 3 seconds
  Timer(const Duration(seconds: 3), () => exit(0));

  try {
    // Dispose services (mirrors main.dart _disposeServicesSync)
    await connectionManager.dispose();
    logger.dispose();
  } catch (_) {
    // Best-effort cleanup; we're exiting anyway
  }

  exit(0);
}
```

### 5. Go Updater: Full Update Sequence

**Source location**: `packages/app/updater/`

**Files**:
```
packages/app/updater/
  go.mod
  go.sum
  main.go              # Entry point, CLI arg parsing, orchestration
  manifest.go          # Manifest JSON parsing and validation
  process.go           # PID waiting, app launching
  fileops.go           # Backup, copy, rollback, cleanup
  fileops_test.go      # Tests for file operations
  process_test.go      # Tests for PID waiting
  manifest_test.go     # Tests for manifest parsing
  platform_windows.go  # Windows-specific: WaitForSingleObject, DLL retry
  platform_darwin.go   # macOS: xattr quarantine removal, .app bundle
  platform_linux.go    # Linux: chmod +x, AppImage detection
  update_result.go     # Write update-result.json
```

**Exit codes**:

| Code | Meaning |
|------|---------|
| 0 | Success -- new app launched |
| 1 | Generic failure |
| 2 | Manifest parse error |
| 3 | App process did not exit in time |
| 4 | Backup creation failed |
| 5 | File copy failed |
| 6 | Rollback completed (update failed but old version restored) |
| 7 | Rollback failed (critical -- manual intervention needed) |
| 8 | New app failed to launch |

**Detailed sequence**:

```
main() entry
  |
  v
Parse CLI flags: --manifest <path> --pid <int>
  |-- missing/invalid --> log error, exit(2)
  |
  v
Read and parse manifest.json
  |-- file not found / JSON invalid --> log error, exit(2)
  |-- schema_version != 1 --> log error, exit(2)
  |
  v
Validate paths:
  - staging_dir exists and contains files
  - install_dir exists
  - backup_dir parent is writable
  |-- any validation failure --> log error, exit(1)
  |
  v
Write update-in-progress.lock file (for power-loss recovery)
  |
  v
Wait for app PID to exit:
  - Poll every 500ms for up to 30 seconds
  - Platform-specific:
    - Linux: kill(pid, 0) returns error when process gone
    - macOS: kill(pid, 0) same as Linux
    - Windows: OpenProcess + WaitForSingleObject with timeout
  |-- PID exits --> proceed
  |-- 30s timeout --> send SIGTERM/TerminateProcess, wait 10s more
  |-- still running after 40s --> log error, exit(3)
  |
  v
Create backup: recursive copy install_dir --> backup_dir
  - Remove any existing backup_dir first
  - Copy preserving file permissions
  |-- failure --> log error, exit(4)
  |
  v
Replace files: recursive copy staging_dir --> install_dir
  - On Windows: retry each file operation up to 5 times with
    exponential backoff (100ms, 200ms, 400ms, 800ms, 1600ms)
    to handle DLL lock release lag after process exit
  - On macOS: prefer os.Rename for .app bundle if same filesystem;
    fall back to recursive copy
  - On Linux: standard recursive copy, then chmod +x on main binary
  |-- failure --> ROLLBACK
  |     |
  |     v
  |   Restore: recursive copy backup_dir --> install_dir
  |     |-- rollback succeeds --> exit(6)
  |     |-- rollback fails --> exit(7)
  |
  v
Platform-specific post-copy:
  - macOS: xattr -rd com.apple.quarantine on .app bundle
  - Linux: chmod +x on app binary and shared objects
  - Windows: no additional action needed
  |
  v
Launch new app executable from install_dir
  - Use os/exec with Cmd.Start() (do not wait)
  - Detach from parent (the updater) so app survives updater exit
  |-- launch failure --> ROLLBACK, exit(8)
  |
  v
Cleanup:
  - Delete update-in-progress.lock
  - Write update-result.json with status "success"
  - Optionally: schedule deletion of backup_dir (or leave for
    rollback story US-5)
  |
  v
exit(0)
```

### 6. Platform-Specific File Operations

#### Windows

- **DLL locking**: When a Windows process is running, its `.exe` and loaded `.dll` files are locked by the OS. The updater MUST wait for the app PID to fully exit before attempting any file operations. Even after PID exit, DLLs may remain briefly locked (up to ~2 seconds in some cases). The updater retries file copy/move operations with exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms (5 attempts total).
- **File replacement**: Use `os.Rename()` where possible (atomic on same filesystem). Fall back to copy-and-delete for cross-filesystem scenarios.
- **Path considerations**: Windows paths use backslashes and may contain spaces (e.g., `C:\Users\John Doe\AppData\Local\Zajel\`). The manifest uses the path as-is; Go's `os` package handles both separators.
- **MSIX detection**: If `Platform.resolvedExecutable` contains `WindowsApps`, the app is an MSIX install. Auto-update is disabled; the user is directed to the Microsoft Store.

#### macOS

- **`.app` bundle**: The entire `zajel.app` directory is the application. Replacement means swapping the entire bundle.
- **Atomic rename**: On macOS (same filesystem), `os.Rename("staging/zajel.app", "install/zajel.app")` is atomic via the `rename(2)` syscall. This is preferred over recursive copy.
- **Gatekeeper quarantine**: Downloaded files get a `com.apple.quarantine` extended attribute that triggers the "app downloaded from the internet" warning. The updater runs `xattr -rd com.apple.quarantine zajel.app` after extraction.
- **Code signing**: The new `.app` must be signed by the same developer identity. The updater does not re-sign; CI handles signing.
- **App Store detection**: If `zajel.app/Contents/_MASReceipt/receipt` exists, it is a Mac App Store build. Auto-update is disabled.

#### Linux

- **Binary permissions**: After copying, `chmod +x` must be applied to the main `zajel` binary and any `.so` shared objects in the `lib/` directory.
- **AppImage**: If the `$APPIMAGE` environment variable is set, the app is an AppImage. Update is a single-file replacement: copy new AppImage over old, `chmod +x`, launch. The manifest `install_dir` points to the AppImage file's directory; `app_executable` is the AppImage filename.
- **Snap/Flatpak detection**: If `$SNAP` or `$FLATPAK_ID` environment variables are present, auto-update is disabled; the user is directed to the respective package manager.
- **Directory swap**: For tarball installs, the standard backup-copy-launch sequence applies.

---

## Complete Update Timeline

The following is the wall-clock timeline from the user clicking "Install Update" to seeing the new app window:

```
T+0.0s   User clicks "Install Update"
         |
T+0.1s   App copies updater binary to external location
         |
T+0.2s   App writes manifest.json with current PID
         |
T+0.3s   App launches updater via Process.start(detached)
         |
T+0.4s   App begins graceful shutdown
         | - ConnectionManager.dispose()
         | - logger.dispose()
         |
T+1.0s   App calls exit(0) -- window disappears
         |  <-- USER SEES NO WINDOW (downtime begins) -->
         |
T+1.5s   Updater detects PID has exited
         |
T+1.5s   Updater creates backup of install directory
         |
T+3.5s   Updater copies staged files to install directory
         |  (platform-specific post-copy actions)
         |
T+5.5s   Updater launches new app executable
         |
T+7.0s   New app window appears (Flutter framework init)
         |  <-- USER SEES NEW WINDOW (downtime ends) -->
         |
T+7.5s   Updater writes update-result.json, exits
         |
T+8.0s   New app reads update-result.json, shows success toast
```

**Total downtime**: ~6 seconds on SSD (from T+1.0s to T+7.0s)

---

## Edge Cases

### Updater binary missing from staged download

The CI build bundles the updater binary into every release artifact. If it is missing (corrupted download, manual extraction error):
- **Detection**: `UpdaterLauncher` checks for the updater binary in the staging directory before attempting to copy it.
- **Behavior**: Throws an exception. The UI shows a SnackBar: "Update package is incomplete. Please re-download the update."
- **Recovery**: The user can trigger a re-download from Settings, or manually download from GitHub Releases.

### Manifest cannot be written (disk full, permissions)

- **Detection**: `manifest.writeToFile()` throws an `IOException`.
- **Behavior**: The exception propagates to the UI. SnackBar: "Could not prepare update. Check disk space and permissions."
- **Recovery**: The app does NOT exit. The user resolves the disk/permission issue and retries.

### Updater fails to launch (antivirus blocks, missing permissions)

- **Detection**: `Process.start()` throws an exception.
- **Behavior**: SnackBar: "Could not start the updater. Your antivirus may be blocking it."
- **Recovery**: The app does NOT exit. The user can whitelist the updater binary or perform a manual update.

### App does not exit in time (hung WebRTC, stuck I/O)

- **Detection**: The updater's PID wait exceeds 30 seconds.
- **Behavior**: Updater sends SIGTERM (Unix) or TerminateProcess (Windows). Waits another 10 seconds. If still running, writes `update-result.json` with exit code 3 and status "failed", then exits.
- **Recovery**: On next app launch, the app detects the failed update result and shows "Update could not be completed because the app did not shut down properly. Please try again."
- **Prevention**: The `_gracefulShutdown()` method in Dart has a 3-second hard timer that calls `exit(0)` regardless.

### Files locked after app exit (Windows DLL lock lag)

- **Detection**: `os.Rename()` or `os.Remove()` returns a "file in use" error on Windows.
- **Behavior**: Updater retries with exponential backoff (100ms base, 5 attempts, max ~3.1 seconds total wait).
- **Recovery**: If all retries fail, the updater initiates rollback from backup.

### Backup directory already exists (stale from previous failed update)

- **Detection**: `backup_dir` already exists when the updater tries to create it.
- **Behavior**: Remove the existing `backup_dir` entirely before creating the new backup. This is safe because a leftover backup means a previous update either succeeded (old backup no longer needed) or rolled back (already restored from that backup).

### Power loss during file copy

- **Detection**: On next app launch, `update-in-progress.lock` file exists in the staging parent directory.
- **Behavior**: The new app (or old app, depending on what was partially copied) detects the lock file and triggers an automatic rollback: restore from `backup_dir` to `install_dir`, delete lock file.
- **Note**: Full implementation of power-loss recovery is shared with US-5 (Rollback on Bad Update). This story ensures the lock file is written/deleted by the updater.

### Staging directory missing or empty

- **Detection**: Updater validates that `staging_dir` exists and contains files during its initial validation step.
- **Behavior**: Exit code 2 (manifest/validation error). Writes `update-result.json` with status "failed".

### New app fails to launch after replacement

- **Detection**: `exec.Command(appExecutable).Start()` returns an error in Go.
- **Behavior**: Updater initiates rollback from backup, then exits with code 8.
- **Recovery**: The old app is restored. On next launch, the user sees "Update failed. Your previous version has been restored."

### User clicks "Install Update" while in an active call or file transfer

- **Prevention**: This story does not implement activity detection (that is US-4's concern for auto-install). However, the "Install Update" button is always available -- the user explicitly chose to update, so we respect that choice even during an active call.
- **Behavior**: The graceful shutdown closes all WebRTC connections, which will end any active calls or transfers. The call/transfer will be interrupted.

---

## Error Handling and User Feedback

### Pre-launch errors (Dart side)

All errors that occur before the updater is launched are catchable in Dart. The `UpdaterLauncher.launchUpdate()` method throws typed exceptions:

| Exception | Trigger | User message |
|-----------|---------|-------------|
| `UpdaterBinaryNotFoundException` | Updater not found in staging | "Update package is incomplete. Please re-download." |
| `ManifestWriteException` | Cannot write manifest.json | "Could not prepare update. Check disk space." |
| `UpdaterLaunchException` | Process.start fails | "Could not start updater. Check antivirus settings." |
| `UpdaterCopyException` | Cannot copy updater to external dir | "Could not prepare updater. Check disk permissions." |

The UI catches these and shows a `SnackBar` with the user-facing message. The app remains running.

### Post-launch errors (Go side)

Once the updater is launched and the app exits, errors are communicated via `update-result.json`:

```json
{
  "status": "failed",
  "exit_code": 5,
  "error_message": "Failed to copy staging/flutter_windows.dll to install/flutter_windows.dll: access denied",
  "previous_version": "1.0.0",
  "target_version": "1.2.0",
  "timestamp": "2026-03-03T12:05:00Z",
  "rolled_back": true
}
```

On startup, the app checks for `update-result.json` in the staging parent directory:
- **status "success"**: Show a brief success toast ("Updated to version 1.2.0") and delete the file.
- **status "failed" with rolled_back=true**: Show "Update to 1.2.0 failed. Your previous version has been restored." and delete the file.
- **status "failed" with rolled_back=false**: Show "Update failed and could not be recovered. You may need to reinstall." This is the exit code 7 catastrophic case. Delete the file.

### Logging

- The Go updater writes a log file to the staging parent directory: `updater.log`. This captures each step with timestamps for debugging.
- The Dart app logs all pre-launch steps via the existing `LoggerService`.

---

## Dependencies

### Must be completed before this story

- **US-2 (Background Update Download)**: The download service must have already downloaded and verified the update artifact, extracted it to the staging directory, and stored the checksum. This story assumes `staging_dir` is populated and verified.
- **Plan 09, Phase 1**: The Go updater project structure, `UpdateManifest` model, and `UpdatePackageDetector` must exist.
- **Plan 09, Phase 2 (CI)**: The `build-updater` CI job must be producing updater binaries that are bundled into release artifacts.

### Used by stories after this

- **US-4 (Automatic Silent Update)**: Calls `UpdaterLauncher.launchUpdate()` with the same mechanism, triggered automatically instead of by user click.
- **US-5 (Rollback on Bad Update)**: Reads `update-result.json` and the `update-in-progress.lock` file that this story's updater writes.
- **US-7 (Force Update Triggers Desktop Auto-Update)**: Modifies `ForceUpdateDialog` to use the same `UpdaterLauncher` path on desktop.

### External dependencies

- **Go 1.22+** toolchain for building the updater binary.
- **No external Go libraries required**: The updater uses only the Go standard library (`os`, `os/exec`, `io`, `encoding/json`, `path/filepath`, `runtime`, `syscall`, `time`, `flag`, `log`, `fmt`).

---

## Testing Strategy

### Go Unit Tests

**File**: `packages/app/updater/*_test.go`

1. **manifest_test.go**:
   - Parse valid manifest JSON with all fields.
   - Reject manifest with missing required fields (`install_dir`, `staging_dir`, `app_executable`).
   - Reject manifest with unsupported `schema_version`.
   - Handle paths with spaces, unicode characters, and Windows backslashes.
   - Handle malformed JSON gracefully (exit code 2).

2. **fileops_test.go**:
   - `TestBackupCreation`: Create a temp directory with nested files, run backup, verify identical content in backup_dir.
   - `TestBackupOverwritesExisting`: Verify that an existing backup_dir is removed before new backup.
   - `TestCopyFiles`: Copy staged files to install dir, verify all files present with correct content.
   - `TestCopyFilesPreservesPermissions`: On Linux/macOS, verify file permissions are preserved.
   - `TestRollback`: After a simulated copy failure, verify rollback restores backup to install_dir.
   - `TestRollbackOnEmptyBackup`: Verify exit code 7 when backup_dir does not exist during rollback.
   - `TestCleanup`: Verify lock file is deleted and result JSON is written.

3. **process_test.go**:
   - `TestWaitForPID_AlreadyExited`: Pass a PID that does not exist; wait should return immediately.
   - `TestWaitForPID_ExitsDuringWait`: Start a subprocess, get its PID, tell it to exit after 2 seconds, verify wait detects exit.
   - `TestWaitForPID_Timeout`: Start a subprocess that sleeps forever, verify timeout behavior and SIGTERM delivery.

4. **update_result_test.go**:
   - Verify `update-result.json` is written with correct fields for success, failure, and rollback scenarios.

**Running Go tests**:
```bash
cd packages/app/updater && go test ./... -v
```

### Dart Unit Tests

**File**: `packages/app/test/features/updater/`

1. **update_manifest_test.dart**:
   - Serialize `UpdateManifest` to JSON and verify all fields.
   - Verify `writeToFile` creates the file with valid JSON.
   - Verify `schema_version` is always `1`.
   - Verify timestamp is ISO 8601 UTC.

2. **updater_launcher_test.dart**:
   - Mock `Process.start` and verify it is called with correct arguments (`--manifest`, `--pid`), correct mode (`ProcessStartMode.detached`), and correct binary path.
   - Verify manifest is written before process launch.
   - Verify updater binary is copied to external location before launch.
   - Verify exception types for each failure mode (missing binary, write failure, launch failure).
   - Verify `exit(0)` is called after successful launch (use `IOOverrides` to mock `exit`).

3. **update_package_detector_test.dart**:
   - Verify `supportsAutoUpdate()` returns false for MSIX, Snap, Flatpak, and Mac App Store environments.
   - Verify `supportsAutoUpdate()` returns true for standard Windows, macOS, and Linux installs.

4. **install_dir_detection_test.dart**:
   - Verify install directory is correctly derived from `Platform.resolvedExecutable` on each platform.
   - macOS: `resolvedExecutable` -> navigate up to `.app` parent.
   - Windows/Linux: `resolvedExecutable` -> parent directory.

**Running Dart tests**:
```bash
cd packages/app && flutter test test/features/updater/
```

### Integration Tests

These require a real filesystem and are run per-platform in CI:

1. **Manifest round-trip**: Dart writes manifest, Go updater reads it, validates fields match.
2. **Full update simulation**: Set up a fake install directory and staging directory. Run the Go updater pointing at them. Verify:
   - Backup was created.
   - Files were replaced.
   - `update-result.json` was written with status "success".
   - The "new app" (a stub binary that prints "hello") was launched.
3. **Rollback simulation**: Set up staging with a read-only file in the install directory (to force copy failure on Linux). Verify rollback restores from backup and exit code is 6.
4. **Lock file recovery**: Create an `update-in-progress.lock` file, start the app, verify it detects and handles the lock.

**Running integration tests** (per-platform):
```bash
cd packages/app/updater && go test -tags=integration ./... -v
```

---

## Out of Scope

The following items are explicitly NOT part of this story:

- **Download mechanism**: US-2 handles downloading, checksum verification, and extraction to staging. This story starts with a populated staging directory.
- **Automatic/silent installation**: US-4 handles idle detection and auto-triggering. This story requires explicit user confirmation.
- **Rollback on bad update (crash loop detection)**: US-5 handles detecting repeated crashes and triggering rollback. This story writes the `update-result.json` and lock files that US-5 reads, but does not implement crash-loop detection.
- **Settings UI for update preferences**: The "Check for updates automatically" / "Download in background" / "Install automatically" toggles are part of the Settings UI story (Plan 09, Phase 5, item 15). This story only needs the "Install Update" button to exist in the already-ready state.
- **Update discovery and version checking**: US-1 handles querying GitHub Releases API. This story assumes the target version and artifact location are already known.
- **Updater self-update logic**: While this story copies the updater binary from staging to the external location (which effectively updates it), the decision logic for when a new updater is needed vs. when the existing one suffices is not in scope.
- **Code signing of the updater binary**: Handled by CI pipeline changes (Plan 09, Phase 2).
- **Progress indication during update**: The update happens after the app exits, so there is no UI to show progress. The user sees a brief "no window" period followed by the new app appearing.
- **Mobile platforms**: This story is desktop-only (Windows, macOS, Linux). Mobile updates continue through app stores.
