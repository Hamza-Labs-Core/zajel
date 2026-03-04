# US-5: Rollback on Bad Update

## Description

As a desktop user, if an update fails to apply or the updated app crashes repeatedly on startup, I want automatic recovery to the previous working version so that I am never left with an unusable application.

The rollback system operates at three layers: the Go updater creates a backup before replacing files and can restore it on copy failure; the Dart app verifies successful launch after an update and triggers rollback if the new version crashes repeatedly; and a lock file mechanism detects interrupted operations caused by power loss or system crash.

## Dependencies

- **US-3 (User-Confirmed Update Install)** must be complete. US-5 builds on the updater binary, manifest format, staging directory, and file replacement logic established in US-3.
- The Go updater binary at `packages/app/updater/` must implement the full update sequence (manifest parsing, PID waiting, file copy) before rollback logic is added.
- The `update-result.json` format and updater exit codes defined in plan section 4.3 must be implemented.

---

## Acceptance Criteria

### AC-1: Backup creation before file replacement
- Before the updater replaces any files in the install directory, it creates a complete copy of the current installation in the backup directory.
- The backup directory path is specified in `manifest.json` as `backup_dir`.
- If backup creation fails (disk full, permissions error), the updater exits with code 4 and does not modify the install directory.
- The backup includes all files and subdirectories from `install_dir` (binary, DLLs/shared objects, `data/` directory, etc.).

### AC-2: Rollback on file copy failure
- If any file copy operation fails during the staging-to-install replacement step, the updater automatically restores the entire backup directory to the install directory.
- On successful rollback, the updater exits with code 6 and writes `update-result.json` with `"status": "rolled_back"`.
- On failed rollback, the updater exits with code 7 and writes `update-result.json` with `"status": "rollback_failed"`.

### AC-3: Rollback on app launch failure
- After replacing files, the updater attempts to launch the new app executable.
- If the process fails to start (e.g., missing DLL, exec format error), the updater rolls back to the backup and exits with code 8.

### AC-4: App launch verification with crash counter
- After a successful update, the updater writes `update-result.json` with `"status": "pending_verification"`.
- On each app launch, the Dart app checks `update-result.json`. If status is `pending_verification`, it increments an `update_launch_attempt` counter in SharedPreferences.
- After the app completes core initialization successfully (crypto, storage, connection manager), it resets `update_launch_attempt` to 0 and writes `"status": "verified"` to `update-result.json`.

### AC-5: Automatic rollback on repeated crash
- If the app detects `update_launch_attempt >= 2` AND `update-result.json` status is `pending_verification`, the app triggers a rollback.
- Rollback is triggered by re-launching the updater binary with a `--rollback` flag.
- The updater in rollback mode restores the backup directory to the install directory and relaunches the old version.

### AC-6: User notification after rollback
- When the app starts after a rollback, it reads `update-result.json` with `"status": "rolled_back"`.
- The app displays a non-blocking SnackBar notification: "Update to version X.Y.Z was rolled back due to startup failures. You are running version A.B.C."
- After displaying the notification, the app clears the rollback status.

### AC-7: Power loss recovery via lock file
- The updater writes `update-in-progress.lock` to the backup directory before starting any file replacement operations.
- The lock file contains the manifest JSON (so recovery can proceed without the original manifest).
- The updater deletes the lock file after all operations complete (success or rollback).
- On next app or updater start, if `update-in-progress.lock` exists, an auto-rollback is triggered from the backup directory.

### AC-8: Cleanup after successful verification
- Once the app writes `"status": "verified"` to `update-result.json`, the backup directory is scheduled for deletion.
- Cleanup runs asynchronously and does not block the app.
- If cleanup fails (e.g., file locked), it is retried on the next app launch.

---

## Technical Context

### What exists today

**App initialization flow** (`packages/app/lib/main.dart`):
1. `main()` calls `WidgetsFlutterBinding.ensureInitialized()`, initializes sqflite FFI for desktop, initializes the logger, obtains `SharedPreferences`, and calls `runApp()`.
2. `_ZajelAppState.initState()` calls `_initialize()`, which runs `_initService.initializeCore()` (crypto, storage, connection manager, notifications).
3. If `initializeCore()` fails, the app shows a static error screen with "Failed to initialize app. Please restart or reinstall."
4. On success, the app transitions to the router-based UI.

**SharedPreferences usage patterns** (`packages/app/lib/core/providers/preferences_providers.dart`):
- `sharedPreferencesProvider` is a Riverpod `Provider<SharedPreferences>` overridden in `ProviderScope` with the actual instance.
- Settings like `themeMode`, `hasSeenOnboarding`, `username`, `privacyScreenEnabled`, `autoDeleteEnabled` follow a consistent pattern: read on provider creation, write via notifier methods.
- All keys are string constants defined in their respective notifier classes.

**Error handling and user notifications**:
- Startup errors set `_initError` string, rendering a full-screen error widget with an icon and message.
- Runtime notifications use `ScaffoldMessenger.of(context).showSnackBar()` with `SnackBar` widgets (see `settings_screen.dart` for examples: "Keys regenerated", "All data cleared", "Logs cleared").
- The app has no existing crash counter or launch verification mechanism.

**Version and environment** (`packages/app/lib/core/config/environment.dart`):
- `Environment.version` and `Environment.fullVersion` provide the current app version at compile time.
- Platform detection uses `dart:io` `Platform.isWindows`, `Platform.isLinux`, `Platform.isMacOS`.

**Updater binary and exit codes** (plan section 4.3-4.4):
- The Go updater will be at `packages/app/updater/`.
- Exit codes: 0=success, 1=generic failure, 2=manifest parse error, 3=PID timeout, 4=backup failed, 5=copy failed, 6=rollback completed, 7=rollback failed, 8=launch failed.
- The updater reads `manifest.json` from the staging directory and is invoked with `--manifest` and `--pid` CLI args.

**Updater binary location** (plan section 4.8):
- Windows: `%LOCALAPPDATA%\Zajel\updater\zajel-updater.exe`
- macOS: `~/Library/Application Support/com.zajel.zajel/updater/zajel-updater`
- Linux: `~/.local/share/zajel/updater/zajel-updater`

### What needs to change

1. **Go updater (`packages/app/updater/`)**: Add backup/restore logic in `fileops.go`, lock file management, `--rollback` mode, and `update-result.json` writing.
2. **Dart app (`main.dart`)**: Add launch verification check early in `main()`, before `runApp()`. This must happen before any UI framework initialization that could crash.
3. **New Dart service**: `UpdateVerificationService` to manage `update-result.json` reading/writing and SharedPreferences launch counter.
4. **New Dart provider**: `updateRollbackStatusProvider` to expose rollback notification state to the UI.
5. **UI layer**: Add rollback notification SnackBar in the main app widget, triggered by rollback status.

---

## Implementation Details

### Layer 1: Updater Backup/Restore (Go side)

#### File: `packages/app/updater/fileops.go`

**Backup creation**:
```go
func createBackup(installDir, backupDir string) error {
    // 1. Remove any existing backup directory
    // 2. Create backup directory
    // 3. Recursively copy installDir -> backupDir
    //    - Preserve file permissions
    //    - Use buffered I/O (32KB buffer)
    //    - Verify byte count after each file copy
    // 4. Return error if any file fails to copy
}
```

Key implementation notes:
- On Windows, `os.Rename` is NOT atomic for cross-device moves and does NOT replace existing directories. Use recursive copy with `os.Create` + `io.Copy`.
- On macOS, `.app` bundles are directories. Copy the entire bundle recursively (do not use `os.Rename` on the bundle; internal symlinks must be preserved).
- On Linux, copy the entire `bundle/` directory.
- Set file permissions after copy: use `os.Chmod` to match source permissions. On Linux, ensure `chmod +x` on the main binary.

**Rollback (restore from backup)**:
```go
func rollback(installDir, backupDir string) error {
    // 1. Verify backupDir exists and is non-empty
    // 2. Remove current installDir contents
    //    - On Windows: retry with exponential backoff if files locked
    // 3. Copy backupDir -> installDir
    // 4. Verify critical files exist (app executable at minimum)
    // 5. Return error if restore fails
}
```

**update-result.json writing**:
```go
type UpdateResult struct {
    Status         string `json:"status"`
    ExitCode       int    `json:"exit_code"`
    PreviousVersion string `json:"previous_version"`
    TargetVersion  string `json:"target_version"`
    Timestamp      string `json:"timestamp"`
    ErrorMessage   string `json:"error_message,omitempty"`
}
```

Status values:
- `"pending_verification"` -- update applied, awaiting app launch confirmation
- `"verified"` -- app launched successfully after update
- `"rolled_back"` -- rollback completed (by updater or by app-triggered rollback)
- `"rollback_failed"` -- rollback attempted but failed
- `"interrupted_recovery"` -- recovered from lock file (power loss)

The file is written to the same parent directory as the updater binary:
- Windows: `%LOCALAPPDATA%\Zajel\updater\update-result.json`
- macOS: `~/Library/Application Support/com.zajel.zajel/updater/update-result.json`
- Linux: `~/.local/share/zajel/updater/update-result.json`

#### File: `packages/app/updater/main.go`

Add `--rollback` flag handling:
```go
rollbackMode := flag.Bool("rollback", false, "Restore backup and relaunch previous version")
```

When `--rollback` is true:
1. Parse manifest to get `install_dir`, `backup_dir`, `app_executable`.
2. Verify backup directory exists.
3. Restore backup to install directory.
4. Write `update-result.json` with `"status": "rolled_back"`.
5. Launch the restored app executable.
6. Exit with code 0 on success, code 7 on failure.

#### Updated main sequence (normal mode):

```
Parse manifest
Wait for PID exit
Write update-in-progress.lock        <-- NEW
Create backup: install_dir -> backup_dir
Replace files: staging_dir -> install_dir
  |-- failure --> rollback, delete lock, exit 6/7
Delete update-in-progress.lock       <-- NEW
Write update-result.json (status: pending_verification)
Launch new app
  |-- failure --> rollback, exit 8
Clean up staging_dir
Exit 0
```

### Layer 2: App Launch Verification (Dart side)

#### File: `packages/app/lib/features/updater/services/update_verification_service.dart`

```dart
class UpdateVerificationService {
  static const _launchAttemptKey = 'update_launch_attempt';
  static const _tag = 'UpdateVerification';

  final SharedPreferences _prefs;

  UpdateVerificationService(this._prefs);

  /// Check update status on app launch. Called from main() before runApp().
  ///
  /// Returns a [RollbackAction] if rollback is needed, or null to proceed.
  Future<RollbackAction?> checkOnLaunch() async {
    final resultFile = _getUpdateResultFile();
    if (resultFile == null || !resultFile.existsSync()) return null;

    final result = _parseUpdateResult(resultFile);
    if (result == null) return null;

    // Check for lock file (power loss recovery)
    final lockFile = _getLockFile();
    if (lockFile != null && lockFile.existsSync()) {
      logger.warning(_tag, 'Lock file found — interrupted update detected');
      return RollbackAction(
        reason: RollbackReason.interruptedUpdate,
        targetVersion: result.targetVersion,
        previousVersion: result.previousVersion,
      );
    }

    switch (result.status) {
      case 'pending_verification':
        return _handlePendingVerification(result);
      case 'rolled_back':
      case 'interrupted_recovery':
        // Will show notification after app starts
        return null;
      case 'rollback_failed':
        // Critical — log and let the app try to start anyway
        logger.error(_tag, 'Previous rollback failed: ${result.errorMessage}');
        return null;
      default:
        return null;
    }
  }

  Future<RollbackAction?> _handlePendingVerification(UpdateResult result) async {
    final attempts = _prefs.getInt(_launchAttemptKey) ?? 0;
    final newAttempts = attempts + 1;
    await _prefs.setInt(_launchAttemptKey, newAttempts);

    logger.info(_tag, 'Launch attempt $newAttempts for version ${result.targetVersion}');

    if (newAttempts >= 2) {
      logger.error(_tag,
        'Version ${result.targetVersion} failed $newAttempts launch attempts — triggering rollback');
      return RollbackAction(
        reason: RollbackReason.repeatedCrash,
        targetVersion: result.targetVersion,
        previousVersion: result.previousVersion,
      );
    }

    // First attempt — proceed with launch, will verify after init
    return null;
  }

  /// Called after successful core initialization.
  /// Marks the update as verified and resets the launch counter.
  Future<void> markVerified() async {
    final resultFile = _getUpdateResultFile();
    if (resultFile == null) return;
    if (!resultFile.existsSync()) return;

    final result = _parseUpdateResult(resultFile);
    if (result == null) return;
    if (result.status != 'pending_verification') return;

    // Update succeeded
    await _prefs.setInt(_launchAttemptKey, 0);
    _writeUpdateResult(resultFile, result.copyWith(status: 'verified'));

    logger.info(_tag, 'Update to ${result.targetVersion} verified successfully');

    // Schedule backup cleanup
    _scheduleBackupCleanup(result);
  }

  // ... file path resolution, parsing, etc.
}
```

#### Rollback trigger mechanism

When `checkOnLaunch()` returns a `RollbackAction`, the app (in `main()`) does the following:

```dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // ... existing init ...

  final prefs = await SharedPreferences.getInstance();

  // NEW: Check update verification status before proceeding
  if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
    final verificationService = UpdateVerificationService(prefs);
    final rollbackAction = await verificationService.checkOnLaunch();

    if (rollbackAction != null) {
      logger.warning('Main', 'Triggering rollback: ${rollbackAction.reason}');
      await _triggerRollback(rollbackAction);
      // _triggerRollback launches the updater and exits the app.
      // If we reach here, the rollback launch failed.
      // Fall through to show the app with an error.
    }
  }

  runApp(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
      ],
      child: const ZajelApp(),
    ),
  );
}

Future<void> _triggerRollback(RollbackAction action) async {
  final updaterPath = _getUpdaterPath();
  final manifestPath = _getManifestPath();

  if (updaterPath == null || !File(updaterPath).existsSync()) {
    logger.error('Main', 'Updater binary not found at $updaterPath — cannot rollback');
    return; // Fall through to normal startup
  }

  try {
    await Process.start(
      updaterPath,
      ['--rollback', '--manifest', manifestPath],
      mode: ProcessStartMode.detached,
    );
    // Give the updater a moment to start, then exit
    exit(0);
  } catch (e) {
    logger.error('Main', 'Failed to launch updater for rollback', e);
    // Fall through to normal startup — user may see errors but app tries to run
  }
}
```

#### Verification call site in ZajelApp

The `markVerified()` call is placed after `initializeCore()` succeeds in `_ZajelAppState._initialize()`:

```dart
Future<void> _initialize() async {
  final coreOk = await _initService.initializeCore();
  if (!coreOk) {
    if (mounted) {
      setState(() => _initError = 'Failed to initialize app. '
          'Please restart or reinstall.');
    }
    return;
  }

  // NEW: Mark update as verified after successful core init
  if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
    final prefs = ref.read(sharedPreferencesProvider);
    final verificationService = UpdateVerificationService(prefs);
    await verificationService.markVerified();
  }

  // ... rest of initialization ...
}
```

#### "Update rolled back" notification

After app initialization completes, check for rollback status and show a notification:

```dart
// In _ZajelAppState._initialize(), after setState(_initialized = true):
if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
  _checkRollbackNotification();
}
```

```dart
void _checkRollbackNotification() {
  final prefs = ref.read(sharedPreferencesProvider);
  final verificationService = UpdateVerificationService(prefs);
  final notification = verificationService.consumeRollbackNotification();

  if (notification != null) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final context = rootNavigatorKey.currentContext;
      if (context != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Update to version ${notification.targetVersion} was rolled back '
              'due to startup failures. You are running version '
              '${Environment.fullVersion}.',
            ),
            duration: const Duration(seconds: 8),
            action: SnackBarAction(
              label: 'Dismiss',
              onPressed: () {},
            ),
          ),
        );
      }
    });
  }
}
```

The `consumeRollbackNotification()` method reads `update-result.json`, checks for `"status": "rolled_back"` or `"interrupted_recovery"`, returns the notification data, and then updates the status to `"acknowledged"` so it is not shown again.

### Layer 3: Power Loss Recovery

#### Lock file: `update-in-progress.lock`

**Location**: Written to `backup_dir` (same parent as the backup). This ensures the lock file survives even if the install directory is partially destroyed.

**Contents** (JSON):
```json
{
  "phase": "replacing",
  "manifest": { ... full manifest ... },
  "timestamp": "2026-03-03T12:00:00Z",
  "updater_pid": 54321
}
```

Phase values:
- `"backing_up"` -- currently copying install_dir to backup_dir
- `"replacing"` -- currently copying staging_dir to install_dir
- `"launching"` -- about to launch the new app

**Updater lock file lifecycle**:
```
1. Before backup:   write lock (phase: "backing_up")
2. After backup:    update lock (phase: "replacing")
3. After replace:   update lock (phase: "launching")
4. After launch:    delete lock
5. On error:        rollback, then delete lock
```

**Recovery logic** (in updater `main.go`):

On startup, before parsing any `--manifest` args, the updater checks for the lock file:

```go
func checkLockFile() (*LockFileData, error) {
    lockPath := filepath.Join(getBackupDir(), "update-in-progress.lock")
    if _, err := os.Stat(lockPath); os.IsNotExist(err) {
        return nil, nil // No lock file, proceed normally
    }
    data, err := os.ReadFile(lockPath)
    if err != nil {
        return nil, fmt.Errorf("lock file exists but unreadable: %w", err)
    }
    var lock LockFileData
    if err := json.Unmarshal(data, &lock); err != nil {
        return nil, fmt.Errorf("lock file corrupt: %w", err)
    }
    return &lock, nil
}
```

Recovery behavior by phase:
- `"backing_up"`: Backup may be incomplete. Delete partial backup directory. The install directory is still intact. Write `update-result.json` with `"status": "interrupted_recovery"`. Delete lock. Exit 1.
- `"replacing"`: Install directory may be partially overwritten. Restore from backup (if backup exists and appears complete). Write `update-result.json` with `"status": "interrupted_recovery"`. Delete lock. Relaunch old app.
- `"launching"`: Files are replaced but app did not launch. The replacement was complete. Delete lock. Write `update-result.json` with `"status": "pending_verification"`. Launch new app normally.

**Dart-side lock file detection**:

The `UpdateVerificationService.checkOnLaunch()` method also checks for the lock file (see Layer 2 above). If the lock file exists and the updater is not running, the app triggers the updater in `--rollback` mode. If the updater binary itself is missing (e.g., it was in the install directory that got corrupted), the app logs the error and starts normally, hoping its own files are intact enough to function.

---

## Rollback State Machine

```
                              APP LAUNCHES
                                  |
                                  v
                     +---------------------------+
                     | Read update-result.json   |
                     | Check lock file           |
                     +---------------------------+
                                  |
                 +----------------+----------------+
                 |                |                 |
          (no result file)  (lock file        (status:
           or status:        exists)          pending_verification)
           verified/                               |
           acknowledged)                           v
                 |                          +-----------+
                 v                          | Increment |
           NORMAL LAUNCH                    | attempt   |
                                            | counter   |
                                            +-----------+
                                                  |
                                         +--------+--------+
                                         |                  |
                                    (attempt < 2)      (attempt >= 2)
                                         |                  |
                                         v                  v
                                   NORMAL LAUNCH     TRIGGER ROLLBACK
                                         |                  |
                                         v                  v
                                  +-------------+    Launch updater
                                  | Core init   |    --rollback
                                  +-------------+        |
                                         |               v
                                  +------+------+   App exits(0)
                                  |             |        |
                             (success)     (crash)       v
                                  |             |   Updater restores
                                  v             v   backup, writes
                           markVerified()   Counter   result.json
                           counter = 0      stays     (rolled_back),
                           status:          at 1      relaunches old
                           "verified"       Next         |
                           Schedule         launch       v
                           backup           will      Old version
                           cleanup          trigger   starts, reads
                                            rollback  "rolled_back",
                                                      shows SnackBar
```

---

## Edge Cases

### E1: Backup directory missing when rollback is needed
- **Scenario**: The backup directory was deleted or never created, but a rollback is triggered.
- **Handling**: The updater checks for backup directory existence before attempting rollback. If missing, it exits with code 7 (`rollback_failed`) and writes `update-result.json` with `"status": "rollback_failed"` and an `error_message` explaining the backup is missing.
- **App behavior**: On next launch, the app detects `rollback_failed`, logs the error, and shows a SnackBar: "Update failed and could not be rolled back. The app may not work correctly. Please reinstall from [download URL]."

### E2: Rollback itself fails (disk full, permissions)
- **Scenario**: During rollback, restoring files from backup to install directory fails partway through.
- **Handling**: The updater exits with code 7. The `update-result.json` includes the specific error message. The install directory is in an inconsistent state.
- **App behavior**: Same as E1. The app attempts to start anyway. If it works, good. If not, the user needs to reinstall manually.

### E3: Disk full during backup creation
- **Scenario**: There is not enough disk space to create a full backup before replacing files.
- **Handling**: The updater detects the write error during backup, removes the partial backup directory, exits with code 4, and does NOT modify the install directory. The app is untouched.
- **App behavior**: The app continues to run its current version. The updater writes `update-result.json` with `"status": "backup_failed"`, which the app can detect to show "Update failed: not enough disk space".

### E4: Permissions error during file replacement
- **Scenario**: The updater cannot write to the install directory (e.g., read-only filesystem, UAC issue on Windows).
- **Handling**: Treated as a copy failure. Rollback from backup is attempted. If rollback also fails due to permissions, exit code 7.
- **App behavior**: Same as E2.

### E5: App crashes during verification but not because of the update
- **Scenario**: The user's system crashes (BSOD, kernel panic) during the first launch of a new version, and it is not the app's fault.
- **Handling**: The crash counter increments to 1. On the next launch (attempt 2), the app triggers rollback. This is a false positive but is the safe choice.
- **Mitigation**: The threshold of 2 crashes provides one retry. Most hardware crashes do not repeat immediately. If the user wants the update again, they can re-trigger it from Settings.

### E6: User force-kills the app during first verified launch
- **Scenario**: The user closes the app (kill process, Task Manager) before `markVerified()` is called.
- **Handling**: The launch counter is at 1 and status is still `pending_verification`. On the next launch, the counter increments to 2, triggering rollback. Same false positive risk as E5.
- **Mitigation**: Call `markVerified()` as early as possible after core init succeeds, before signaling connection or UI rendering. This minimizes the window.

### E7: Updater binary is missing or corrupt when rollback is needed
- **Scenario**: The updater binary at the external location is missing or corrupt.
- **Handling**: `_triggerRollback()` in `main.dart` checks for the updater file's existence before launching. If missing, it logs the error and falls through to normal app startup.
- **App behavior**: The app tries to start with whatever files are on disk. May work, may fail. The user sees the error screen if core init fails.

### E8: Multiple rapid launches
- **Scenario**: The user launches the app rapidly multiple times while it is still starting.
- **Handling**: The first launch writes the counter. If the first process is still running when a second starts, both will increment. This could cause premature rollback (counter reaches 2).
- **Mitigation**: This is acceptable behavior -- the worst case is an unnecessary rollback of a working update, which the user can re-apply.

### E9: update-result.json is corrupt or missing
- **Scenario**: The file is unreadable JSON or was deleted externally.
- **Handling**: The verification service catches JSON parse errors and treats a missing/corrupt file as "no update in progress". Normal launch proceeds.

### E10: Lock file exists but backup directory is incomplete
- **Scenario**: Power loss during the `backing_up` phase. Backup is partial, install directory is intact.
- **Handling**: The updater detects `phase: "backing_up"`, removes the partial backup, deletes the lock file, and exits. The app is unmodified.

### E11: Lock file exists but updater is still running
- **Scenario**: The app starts while the updater is still performing the update (e.g., updater is slow or PID wait is long).
- **Handling**: Before triggering rollback from a lock file, check if the updater PID (stored in the lock file) is still running. If so, do not rollback -- the updater is still working. Log a warning and proceed with a delayed retry or let the updater finish.

---

## Error Handling Summary

| Layer | Error | Response | User Impact |
|-------|-------|----------|-------------|
| Go: backup | Disk full | Exit code 4, no file changes | Update fails cleanly, app unchanged |
| Go: backup | Permission denied | Exit code 4, no file changes | Update fails cleanly, app unchanged |
| Go: replace | Any file copy error | Rollback from backup | App restored to previous version |
| Go: replace | Rollback also fails | Exit code 7, write result.json | Manual reinstall needed |
| Go: launch | Exec error | Rollback from backup | App restored to previous version |
| Go: lock | Lock file found on start | Phase-dependent recovery | Automatic recovery |
| Dart: verify | Counter >= 2 | Launch updater --rollback | Auto-restore, user notified |
| Dart: verify | Updater missing | Fall through to normal start | Best-effort, may fail |
| Dart: verify | result.json corrupt | Ignore, proceed normally | No impact |
| Dart: notify | rolled_back status | Show SnackBar | User informed |
| Dart: notify | rollback_failed status | Show SnackBar with reinstall hint | User needs to act |
| Dart: cleanup | Backup delete fails | Retry on next launch | Disk space not freed immediately |

---

## update-result.json Schema

```json
{
  "schema_version": 1,
  "status": "pending_verification",
  "exit_code": 0,
  "previous_version": "1.0.0",
  "target_version": "1.2.0",
  "timestamp": "2026-03-03T12:00:00Z",
  "error_message": "",
  "backup_dir": "/home/user/.local/share/zajel/update-backup",
  "install_dir": "/home/user/.local/share/zajel/app",
  "updater_version": "1.0.0"
}
```

---

## Testing Strategy

### Go unit tests (`packages/app/updater/fileops_test.go`)

**Backup tests**:
- `TestCreateBackup_CopiesAllFiles`: Create a temp install dir with files and subdirs. Run backup. Verify all files exist in backup with same contents and permissions.
- `TestCreateBackup_DiskFull`: Use a mock filesystem or small tmpfs to trigger write failure. Verify backup is cleaned up and error returned.
- `TestCreateBackup_SourceEmpty`: Verify backup of an empty directory succeeds (empty backup dir created).
- `TestCreateBackup_OverwritesExistingBackup`: If backup dir already exists from a previous update, it is removed before creating the new backup.
- `TestCreateBackup_PreservesSymlinks` (Linux/macOS): Verify symlinks in the install dir are preserved in backup.

**Rollback tests**:
- `TestRollback_RestoresFiles`: Create backup, modify install dir, rollback. Verify install dir matches original backup.
- `TestRollback_BackupMissing`: Attempt rollback with no backup dir. Verify error returned.
- `TestRollback_BackupEmpty`: Attempt rollback with empty backup dir. Verify error returned.
- `TestRollback_PartialRestore`: Simulate write failure during restore (e.g., make install dir read-only midway). Verify error returned and exit code 7.
- `TestRollback_VerifiesCriticalFile`: After restore, verify the main executable exists. If missing from backup, return error.

**Lock file tests**:
- `TestLockFile_WriteAndDelete`: Write lock, verify it exists, delete it, verify gone.
- `TestLockFile_RecoveryFromBackingUp`: Write lock with `phase: "backing_up"`. Run recovery. Verify partial backup removed, lock deleted, install dir untouched.
- `TestLockFile_RecoveryFromReplacing`: Write lock with `phase: "replacing"`. Create backup dir. Run recovery. Verify install dir restored from backup, lock deleted.
- `TestLockFile_RecoveryFromLaunching`: Write lock with `phase: "launching"`. Run recovery. Verify lock deleted, result.json set to `pending_verification`.
- `TestLockFile_CorruptJSON`: Write garbage to lock file. Verify recovery handles parse error gracefully.

**update-result.json tests**:
- `TestWriteUpdateResult_AllStatuses`: Write each status value. Read back and verify.
- `TestWriteUpdateResult_AtomicWrite`: Verify the file is written atomically (write to temp file, rename).

**Rollback mode tests** (`packages/app/updater/main_test.go`):
- `TestRollbackMode_RestoresAndRelaunches`: Full integration test with `--rollback` flag. Verify backup restored, result.json written, app executable "launched" (mock the launch).
- `TestRollbackMode_NoBackup`: Run with `--rollback` when no backup exists. Verify exit code 7.

### Dart unit tests (`packages/app/test/features/updater/`)

**UpdateVerificationService tests**:
- `testCheckOnLaunch_NoResultFile_ReturnsNull`: No update-result.json. Verify normal launch.
- `testCheckOnLaunch_StatusVerified_ReturnsNull`: Verify normal launch when already verified.
- `testCheckOnLaunch_FirstAttempt_IncrementsCounter`: Status is `pending_verification`, counter starts at 0. Verify counter set to 1, returns null (proceed).
- `testCheckOnLaunch_SecondAttempt_ReturnsRollbackAction`: Counter was 1, incremented to 2. Verify returns `RollbackAction` with `repeatedCrash` reason.
- `testCheckOnLaunch_LockFileExists_ReturnsRollbackAction`: Lock file present. Verify returns `RollbackAction` with `interruptedUpdate` reason.
- `testMarkVerified_ResetsCounter`: After calling `markVerified()`, counter is 0 and status is `verified`.
- `testMarkVerified_NoResultFile_NoOp`: Calling `markVerified()` with no result file does nothing.
- `testConsumeRollbackNotification_RolledBack`: Status is `rolled_back`. Returns notification data. Status updated to `acknowledged`.
- `testConsumeRollbackNotification_NoRollback`: Status is `verified`. Returns null.
- `testCheckOnLaunch_CorruptResultFile_ReturnsNull`: Malformed JSON in result file. Verify graceful handling.

**Integration test (manual/CI)**:
- Simulate a bad update by deploying a version that fails `initializeCore()`.
- Launch the app twice. Verify rollback triggers on second launch.
- Verify the old version starts and shows the rollback SnackBar.

### Platform-specific manual tests

| Test | Windows | macOS | Linux |
|------|---------|-------|-------|
| Normal update + verification | X | X | X |
| Copy failure triggers rollback | X | X | X |
| Launch failure triggers rollback | X | X | X |
| 2x crash triggers app-side rollback | X | X | X |
| Rollback SnackBar shown | X | X | X |
| Lock file recovery (kill updater mid-copy) | X | X | X |
| Disk full during backup | X | X | X |
| Backup cleanup after verification | X | X | X |

---

## New Files

```
packages/app/updater/
  fileops.go                  (modify: add backup, rollback, lock file functions)
  fileops_test.go             (modify: add backup/rollback/lock tests)
  main.go                     (modify: add --rollback flag, lock file check on start)
  result.go                   (new: UpdateResult struct, read/write functions)
  result_test.go              (new: result.json tests)
  lockfile.go                 (new: lock file struct, write/read/delete)
  lockfile_test.go            (new: lock file tests)

packages/app/lib/features/updater/
  services/
    update_verification_service.dart    (new)
  models/
    update_result.dart                  (new: UpdateResult, RollbackAction, RollbackReason)
  providers/
    update_providers.dart               (modify: add verification-related providers)

packages/app/lib/main.dart              (modify: add checkOnLaunch call before runApp)

packages/app/test/features/updater/
  services/
    update_verification_service_test.dart  (new)
```

## Modified Files

```
packages/app/lib/main.dart
  - Add UpdateVerificationService.checkOnLaunch() call before runApp()
  - Add _triggerRollback() function
  - Add rollback notification check after initialization

packages/app/lib/features/updater/services/update_orchestrator.dart
  - Add backup_dir to manifest generation
  - Read update-result.json on startup for status display
```

---

## Out of Scope

- **Automatic re-download after rollback**: After a rollback, the user must manually trigger the update again. Automatic retry could cause infinite rollback loops if the update is genuinely broken.
- **Partial/differential rollback**: The rollback restores the entire previous version. There is no mechanism to restore individual files.
- **Rollback to versions older than the immediate previous**: Only one backup is maintained (the version that was replaced). Multi-version rollback is not supported.
- **Server-side rollback signaling**: The bootstrap server does not participate in rollback decisions. Rollback is entirely client-side.
- **Crash reporting/telemetry**: The rollback system does not report crash data to any server. Crash details are logged locally only.
- **Mobile platforms**: Rollback logic is desktop-only (Windows, macOS, Linux). Mobile apps use store update mechanisms.
- **Updater self-rollback**: If the updater binary itself is updated and the new updater is broken, this is not covered. The updater binary is small and simple enough that this risk is accepted.
- **User-initiated manual rollback**: There is no UI to manually trigger rollback to a previous version. Rollback is automatic only.
- **MSIX/Snap/Flatpak/App Store installs**: These package formats have their own update mechanisms. The rollback system only applies to direct installs (ZIP/tarball/DMG).
