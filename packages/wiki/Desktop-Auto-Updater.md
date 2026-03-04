# Desktop Auto-Updater

The desktop auto-updater gives Windows, macOS, and Linux users seamless, in-app software updates. The app downloads new releases in the background, verifies their integrity, and then hands off to a small external Go binary that replaces the installation files and relaunches the app. The entire cycle is crash-safe: three independent layers ensure the previous version is restored automatically if anything goes wrong.

This page documents every component of the auto-updater: the state machine, the Go binary, the Dart orchestration layer, rollback mechanics, security controls, package-format detection, and the UI surfaces.

---

## Table of Contents

1. [Design Rationale](#1-design-rationale)
2. [Component Map](#2-component-map)
3. [Update Lifecycle State Machine](#3-update-lifecycle-state-machine)
4. [GitHub Releases API Client](#4-github-releases-api-client)
5. [Download Service](#5-download-service)
6. [Update Orchestrator](#6-update-orchestrator)
7. [Package Format Detection](#7-package-format-detection)
8. [Go Updater Binary](#8-go-updater-binary)
9. [Manifest IPC Protocol](#9-manifest-ipc-protocol)
10. [Rollback Mechanism](#10-rollback-mechanism)
11. [Idle Detection and Auto-Install](#11-idle-detection-and-auto-install)
12. [Security Model](#12-security-model)
13. [Platform-Specific Behaviour](#13-platform-specific-behaviour)
14. [Riverpod Providers](#14-riverpod-providers)
15. [UI Components](#15-ui-components)
16. [File Locations on Disk](#16-file-locations-on-disk)
17. [CI Build Pipeline](#17-ci-build-pipeline)
18. [Code Index](#18-code-index)

---

## 1. Design Rationale

The existing version check (`VersionCheckService` and `AttestationInitializer`) already determined whether an update was needed, but the only action available was opening a browser URL. Plan 09 adds an end-to-end self-update pipeline:

- **Why a separate Go binary?** The updater must replace the running app's files while the app is not running. If the updater were a Dart isolate inside the Flutter process it would be killed along with the app before it could perform any file operations. A Go binary cross-compiles from a single host to all three desktop targets (`GOOS=windows|darwin|linux GOARCH=amd64|arm64`) with a single `go build` command, produces a self-contained static binary (~3 MB), and has an excellent standard library for file system and process management.

- **Why JSON manifest IPC?** Paths on all three platforms can contain spaces, Unicode characters, and platform-specific separators. A manifest file avoids shell-quoting hazards, carries structured data, and lets the updater re-read it after a crash or power loss without re-invoking the app.

- **Why not modify the bootstrap server?** The bootstrap server's `VersionPolicy` already handles version gating (minimum, recommended, blocked versions). Download URLs and checksums for each release are already published in GitHub Releases. Adding them to the bootstrap server would duplicate information and create a maintenance burden.

---

## 2. Component Map

```
packages/app/
  lib/features/updater/
    models/
      github_release.dart          GitHubRelease + GitHubReleaseAsset models
      update_artifact.dart         Backward-compatible re-export shim
      update_check_result.dart     Sealed result type for update checks
      update_manifest.dart         UpdateManifest (Dart side of IPC contract)
      update_result.dart           UpdateResult (written by Go, read by Dart)
      update_state.dart            UpdateStatus enum + UpdateState immutable record
    services/
      auto_update_service.dart     Idle-condition coordinator for auto-install
      github_release_service.dart  GitHub Releases API client (ETag caching)
      idle_detector.dart           5-min idle timer + 10-s grace period
      update_download_service.dart Chunked HTTPS download + SHA-256 verify
      update_orchestrator.dart     State machine coordinator
      update_package_detector.dart PackageFormat detection (MSIX/Snap/Flatpak/...)
      update_rollback_service.dart App-side crash counter + rollback trigger
      updater_launcher.dart        Manifest writer + Go binary launcher
    providers/
      auto_update_providers.dart   autoInstallUpdatesProvider, idleDetectorProvider
      update_providers.dart        updateStateProvider, updateOrchestratorProvider
    widgets/
      auto_update_settings.dart    "Install automatically when idle" toggle
      update_progress_indicator.dart Downloading/Verifying/Installing progress widget
      update_ready_banner.dart     Non-intrusive ready banner + UpdateReadyDot
      update_settings_section.dart Settings > Updates section

  updater/                         Go updater binary source
    main.go                        Entry point, update sequence, rollback sequence
    manifest.go                    Manifest struct, ParseManifest, path validation
    process.go                     WaitForExit, LaunchApp, detachProcess
    fileops.go                     CreateBackup, ReplaceFiles, Rollback, lock file
    result.go                      UpdateResult struct, WriteResult
    platform_windows.go            WaitForSingleObject, retry copy, TerminateProcess
    platform_darwin.go             kill(0) check, SIGTERM, quarantine clearing
    platform_linux.go              /proc/<pid>/comm, chmod +x shared objects
    fileops_test.go                File operation unit tests
    manifest_test.go               Manifest parsing and validation tests
    process_test.go                Process wait logic tests
    main_test.go                   Integration-level tests for update/rollback sequences
    go.mod
    go.sum
```

---

## 3. Update Lifecycle State Machine

The `UpdateOrchestrator` drives the update lifecycle as an explicit state machine. Every state transition produces a new immutable `UpdateState` value and broadcasts it on a stream that Riverpod providers subscribe to.

```
               +--------+
               |  IDLE  |<-------------------------------------+
               +---+----+                                      |
                   |                                           |
         (timer / manual check)                                |
                   |                                           |
               +---v---------+                                 |
               |  CHECKING   |                                 |
               +---+---------+                                 |
                   |                                           |
       +-----------+-----------+                               |
       |                       |                               |
  (up to date)        (update available)                      |
       |                       |                               |
       v                       v                               |
  +----+---+         +---------+---------+                     |
  |  IDLE  |         |   DOWNLOADING     |                     |
  +--------+         |   (progress 0-1)  |                     |
                     +---------+---------+                     |
                               |                               |
                         (download done)                       |
                               |                               |
                     +---------v---------+                     |
                     |    VERIFYING      |                     |
                     |    (SHA-256)      |                     |
                     +---------+---------+                     |
                               |                               |
                 +-------------+-------------+                 |
                 |                           |                 |
          (checksum OK)              (checksum fail)           |
                 |                           |                 |
          +------+------+           +--------+------+          |
          |    READY    |           |    FAILED     +---------+
          | (user / auto|           |  (retry avail)|
          |  install)   |           +---------------+
          +------+------+
                 |
       (user confirms OR auto-install conditions met)
                 |
          +------v-----------+
          | LAUNCHING_UPDATER|
          +------+-----------+
                 |
           (app exits, Go binary takes over)
```

### UpdateStatus enum

Defined in `/home/meywd/zajel-plan09/packages/app/lib/features/updater/models/update_state.dart`:

| Status | Meaning |
|--------|---------|
| `idle` | No active update work. Waiting for next check or user action. |
| `checking` | Querying GitHub Releases API and comparing versions. |
| `downloading` | Streaming the platform artifact. `downloadProgress` (0.0–1.0) is set. |
| `verifying` | Computing and comparing SHA-256 checksum. |
| `ready` | Download verified and staged. Awaiting user confirmation or auto-install trigger. |
| `launchingUpdater` | Writing manifest and launching the external Go binary. |
| `failed` | An error occurred. `errorMessage` explains why. Retry is possible. |

### UpdateState record

`UpdateState` is an immutable value class. Fields meaningful in each status:

| Field | Relevant in |
|-------|------------|
| `downloadProgress` (0.0–1.0) | `downloading` |
| `availableVersion` | `downloading`, `verifying`, `ready`, `launchingUpdater`, `failed` |
| `releaseNotes` (markdown, truncated ~200 chars) | `downloading`, `verifying`, `ready` |
| `releaseDate` | `downloading`, `verifying`, `ready` |
| `errorMessage` | `failed` |
| `lastChecked` | `idle`, `checking`, `failed` |

---

## 4. GitHub Releases API Client

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/services/github_release_service.dart`

`GitHubReleaseService` queries `https://api.github.com/repos/Hamza-Labs-Core/zajel/releases/latest`.

### ETag Caching and Rate Limiting

The service sends an `If-None-Match` header on every request after the first successful fetch. When GitHub responds with `304 Not Modified`, the cached `GitHubRelease` is returned and the response counts against the rate limit only minimally. The service tracks the `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers. If the remaining count reaches zero, subsequent calls throw `RateLimitException` immediately without issuing an HTTP request.

In-memory cache duration is one hour. Within that window, `checkForUpdate()` returns the cached release without a network call.

### Version Comparison

`compareVersions(a, b)` parses semver strings into `[major, minor, patch]` integer tuples. Leading `v` prefixes, pre-release suffixes (`-beta`), and build metadata (`+42`) are stripped before comparison. The comparison returns negative, zero, or positive, matching standard sorting semantics.

### Asset Selection

`GitHubRelease.getAssetForPlatform(platform)` searches the release's asset list for a file ending in:

| Platform | Suffix(es) checked |
|----------|--------------------|
| `windows` | `-windows.zip` |
| `macos` | `-macos.dmg`, `-macos.zip` |
| `linux` | `-linux.tar.gz` |

### Checksum Resolution

Each release attaches a `checksums.txt` asset. The format is one entry per line: `<sha256hex>  <filename>`. `getChecksumForAsset(name)` parses this file to extract the expected hash for the chosen artifact.

---

## 5. Download Service

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/services/update_download_service.dart`

`UpdateDownloadService` handles HTTP I/O and checksum verification. It does not manage state; that is the orchestrator's responsibility.

### Resumable Downloads

The service writes to a `.partial` file alongside the destination. Before starting a download it issues a `HEAD` request to determine:

1. Total file size (for progress reporting).
2. Whether the server advertises `Accept-Ranges: bytes`.
3. The server's `ETag`.

If a `.partial` file already exists and a stored `.etag` file matches the server's ETag, the service sends `Range: bytes=<offset>-` and appends to the partial file. If the ETag has changed or the server returns `200` instead of `206`, the partial file is deleted and the download restarts from byte zero.

On completion the `.partial` file is atomically renamed to the final destination, and the `.etag` file is deleted.

### SHA-256 Verification

`verifyChecksum(filePath, expectedSha256)` streams the file through the `sha256` chunked conversion sink from the `crypto` Dart package. No full-file buffering is required. The computed hex digest is compared case-insensitively against the expected value.

### Cancellation

`CancellationToken` is a simple flag object. The download loop checks `isCancelled` between chunks and throws `DownloadCancelledException` to abort cleanly.

### Archive Extraction

`extractArchive(archivePath, extractDir)` uses platform-native tools:

| Archive type | Tool |
|-------------|------|
| `.zip` (Windows) | `tar -xf` (built-in on Windows 10+) |
| `.zip` (other) | `unzip -o` |
| `.tar.gz` / `.tgz` | `tar -xzf` |
| `.dmg` (macOS) | `hdiutil attach` + `cp -R` + `hdiutil detach` |

### Stale Download Cleanup

`cleanupStaleDownloads(stagingBaseDir, targetVersion)` deletes staging subdirectories for versions other than `targetVersion`, and removes orphaned `.partial` files older than seven days. Called at app start after the version check.

---

## 6. Update Orchestrator

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/services/update_orchestrator.dart`

`UpdateOrchestrator` is the state machine coordinator. It holds the current `UpdateState`, exposes it via `stateStream`, and delegates I/O to `UpdateDownloadService`.

### `checkAndPrepare(release, platformName)`

The public entry point for starting an update. Guards:

1. Calls `UpdatePackageDetector.supportsAutoUpdate()`. If false (MSIX, Snap, Flatpak, Mac App Store), returns immediately.
2. Checks that no download or verification is already in progress.
3. Checks that this version is not already staged and verified (`ready` state).

If all guards pass, calls `downloadUpdate()`.

### `downloadUpdate(release, platformName)`

A concurrency guard (`_isDownloading` flag) prevents overlapping downloads. The internal flow:

1. Resolve the platform asset from the release.
2. Resolve the staging base directory (platform-specific; injected for testability).
3. Check whether the artifact file already exists in staging. If so, verify its checksum. If the checksum passes, transition directly to `ready`. If it fails, delete the stale file and re-download.
4. Transition to `downloading`, stream the artifact, update progress on every chunk.
5. Transition to `verifying`, compute SHA-256 against the checksum from `checksums.txt`.
6. On success, transition to `ready`. On any failure, transition to `failed`.

### Staging Directory Structure

```
update-staging/
  zajel-1.2.0-windows/
    zajel-1.2.0-windows.zip      Downloaded artifact
    zajel-1.2.0-windows.zip.partial   Active partial download (if in progress)
    zajel-1.2.0-windows.zip.etag      Saved ETag for resume validation
```

The version directory name is always `zajel-<version>-<platform>`.

---

## 7. Package Format Detection

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/services/update_package_detector.dart`

`UpdatePackageDetector` runs once and caches the result. All detection is synchronous.

### Detection Logic

**Windows — MSIX detection:**
The app executable path on an MSIX install runs from a virtualized `C:\Program Files\WindowsApps\<PackageFamilyName>\` directory. Presence of the string `"WindowsApps"` in `Platform.resolvedExecutable` identifies an MSIX install.

**macOS — Mac App Store detection:**
App Store builds contain a receipt file at `<AppBundle>/Contents/_MASReceipt/receipt`. The detector walks up the executable path to find the `.app` bundle root and checks for that file.

**Linux — Environment variable detection (order matters):**

| Check | Variable | Detected format |
|-------|----------|-----------------|
| 1st | `$SNAP` | Snap |
| 2nd | `$FLATPAK_ID` | Flatpak |
| 3rd | `$APPIMAGE` | AppImage |
| Fallback | — | Loose install |

### `supportsAutoUpdate()` Decision

| Format | Auto-update supported |
|--------|----------------------|
| `loose` | Yes |
| `appImage` | Yes (single-file replacement) |
| `msix` | No — update via Microsoft Store |
| `macAppStore` | No — update via Mac App Store |
| `snap` | No — update via Snap Store |
| `flatpak` | No — update via Flathub |

When `isStoreManaged()` returns true, `storeName()` provides the display name and `storeDeepLink()` / `storeWebUrl()` provide the store URL for UI display.

---

## 8. Go Updater Binary

**Source:** `/home/meywd/zajel-plan09/packages/app/updater/`

The updater is a standalone Go binary that runs after the Flutter app has exited. It reads the manifest written by the app, replaces the installation directory with the staged files, and relaunches the new app.

### Why the Binary Must Be External

The updater replaces every file inside the installation directory. If the updater binary were inside that directory it would be deleted during the replacement, making the operation impossible on Windows (where open files are locked) and fragile on other platforms. The updater lives in a separate per-user data directory that is never replaced.

### Binary Locations

| Platform | Path |
|----------|------|
| Windows | `%LOCALAPPDATA%\Zajel\updater\zajel-updater.exe` |
| macOS | `~/Library/Application Support/com.zajel.zajel/updater/zajel-updater` |
| Linux | `~/.local/share/zajel/updater/zajel-updater` |

The app copies the updater binary from the staged release before launching it. This is also how the updater self-updates: each release artifact includes the new updater binary.

### Entry Point (`main.go`)

```
zajel-updater --manifest <path> [--pid <pid>] [--rollback]
```

| Flag | Description |
|------|-------------|
| `--manifest` | Required. Path to `manifest.json`. |
| `--pid` | Optional. PID of the app to wait for. Falls back to `app_pid` in the manifest. |
| `--rollback` | Run in rollback mode: restore backup and relaunch the old version. |

### Update Sequence (normal mode)

```
1. Parse and validate manifest.json
2. Validate paths: staging dir exists and is non-empty,
                   install dir exists, backup parent is writable
3. WaitForExit(appPID, 30s)
   -- if timeout: TerminateProcess/SIGTERM + 10s grace
   -- if still running: exit code 3
4. Write update-in-progress.lock (contains full manifest JSON)
5. CreateBackup: copy install_dir -> backup_dir
   -- if fails: remove lock, exit code 4
6. ReplaceFiles: clear install_dir, copy staging_dir -> install_dir
   -- if fails: Rollback(backup_dir -> install_dir)
              exit code 6 (rollback success) or 7 (rollback failed)
7. postCopyPlatform() (quarantine clearing on macOS, chmod +x on Linux)
8. RemoveLockFile
9. LaunchApp(install_dir/app_executable) as detached process
   -- if fails: Rollback, exit code 8
10. Write update-result.json (status: pending_verification)
11. CleanupStaging (best effort)
12. Exit code 0
```

### Rollback Sequence (`--rollback` mode)

```
1. Parse manifest.json
2. Verify backup_dir exists and is non-empty
3. Rollback(backup_dir -> install_dir)
   -- if fails: exit code 7
4. RemoveLockFile (if present)
5. Write update-result.json (status: rolled_back)
6. LaunchApp (restored version)
7. Exit code 0
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success — new app launched |
| 1 | Generic failure |
| 2 | Manifest parse or validation error |
| 3 | App process did not exit within timeout |
| 4 | Backup creation failed |
| 5 | File copy failed (unused directly; triggers rollback first) |
| 6 | Rollback completed (update failed, old version restored) |
| 7 | Rollback failed (critical — backup and install may be inconsistent) |
| 8 | New app failed to launch after successful file replacement |

### `WaitForExit` (`process.go`)

Polls `isProcessRunning(pid)` at 500 ms intervals up to the timeout (default 30 s). On timeout, calls `terminateProcess(pid)`, then waits an additional 10 seconds before giving up.

The function logs the process name at the start of the wait as a best-effort sanity check. On Linux this reads `/proc/<pid>/comm`. On macOS it calls `ps`. On Windows it calls `tasklist`.

### `CreateBackup` and `ReplaceFiles` (`fileops.go`)

Both operations use `copyDir`, which recursively copies directory trees preserving file permissions. A 32 KB buffer is used for file copy operations.

**Symlink handling:** `copyDir` resolves each symlink and checks whether the resolved target falls within the source tree root using `isWithinDir`. Symlinks that escape the source tree are skipped with a warning log and not copied to the destination. This prevents an attacker-controlled release artifact from planting symlinks that escape the installation directory.

`ReplaceFiles` deletes the contents of `install_dir` (not the directory itself) before copying from staging. Files that existed in the old version but not in the new one are removed.

---

## 9. Manifest IPC Protocol

The manifest is the sole communication channel between the Flutter app and the Go updater binary. The app writes it; the Go binary reads it.

**Manifest file path:** `<updater_dir>/manifest.json`

### Schema (version 1)

```json
{
  "schema_version": 1,
  "app_pid": 12345,
  "app_version_current": "1.0.0",
  "app_version_target": "1.2.0",
  "install_dir": "C:\\Users\\user\\AppData\\Local\\Programs\\Zajel",
  "staging_dir": "C:\\Users\\user\\AppData\\Local\\Zajel\\update-staging\\zajel-1.2.0-windows",
  "backup_dir": "C:\\Users\\user\\AppData\\Local\\Zajel\\update-backup",
  "app_executable": "zajel.exe",
  "platform": "windows",
  "checksum_sha256": "abc123...",
  "timestamp": "2026-03-02T12:00:00Z"
}
```

Both Dart (`UpdateManifest`) and Go (`Manifest`) validate all fields independently. Neither side trusts the other's validation.

**Path validation (Go side):** All three directory paths (`install_dir`, `staging_dir`, `backup_dir`) must be absolute and must not contain `..` components. The check is performed on the raw path string before `filepath.Clean`, to prevent traversal components from being resolved away silently. This is enforced in `manifest.go:validatePath()`.

**Platform values:** The `platform` field must be one of `"windows"`, `"darwin"`, or `"linux"`. The Go binary treats `"darwin"` as the canonical macOS platform string (matching `GOOS`). The Dart app writes `"macos"`.

> Note: In the current implementation, the Dart side writes `"macos"` and the Go side accepts `"darwin"`. The Go `validate()` function accepts both. This is a known minor inconsistency that does not affect operation.

---

## 10. Rollback Mechanism

The updater provides three independent layers of rollback protection, each addressing a different failure mode.

### Layer 1 — Go Updater Backup / Restore

Before touching any files in the installation directory, the updater copies the entire installation directory to `backup_dir`. If the file copy fails, or if the new app fails to launch, `Rollback()` copies `backup_dir` back to `install_dir`. The updater then writes `update-result.json` with `status: "rolled_back"` or `status: "rollback_failed"` and attempts to launch the restored version.

### Layer 2 — Crash Counter (App-Side)

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/services/update_rollback_service.dart`

`UpdateRollbackService.checkOnStartup()` is called early in app startup, before `runApp`. It checks:

1. `update-result.json` exists with `status: "pending_verification"`.
2. Reads the `update_launch_attempt` counter from SharedPreferences.
3. Increments and persists the counter.
4. If the counter reaches 2 (two failed launch attempts), returns `RollbackAction.rollback`.

When the app starts successfully, `markVerified()` is called after initialization completes. It resets the counter to zero and updates the result file status to `"verified"`. It also schedules asynchronous cleanup of the backup directory.

The `RollbackAction` enum drives the startup flow:

| Action | Meaning |
|--------|---------|
| `none` | No pending update. Normal startup. |
| `verifying` | First launch after update. Continue normally; call `markVerified()` after init. |
| `rollback` | Two failed attempts. Call `UpdaterLauncher.launchRollback()`, then exit. |
| `powerLossRecovery` | Lock file found. Call `launchRollback()`, then exit. |

### Layer 3 — Power-Loss Lock File

Before replacing any files, the Go updater writes `update-in-progress.lock` to the backup directory. The lock file contains the full manifest JSON in case the manifest file itself becomes inaccessible. The lock file is deleted after the replacement succeeds.

On app startup, `UpdateRollbackService.checkOnStartup()` checks for the lock file before checking `update-result.json`. If the lock file is present, it means the updater was killed mid-operation (power loss, forced kill, OS crash). The app returns `powerLossRecovery` and invokes the updater in rollback mode.

### Result File Lifecycle

`update-result.json` is written by the Go updater and updated by the Dart app:

| Status | Written by | Meaning |
|--------|-----------|---------|
| `pending_verification` | Go updater (exit 0) | Update applied, awaiting first successful launch. |
| `verified` | Dart app (after init) | New version launched and initialized successfully. |
| `rolled_back` | Go updater (exit 6) | Rollback completed by the updater. |
| `interrupted_recovery` | Go updater (rollback mode) | Recovered from lock file (power loss). |
| `rollback_failed` | Go updater (exit 7) | Rollback attempted but failed. Manual intervention needed. |
| `failed` | Go updater | Update failed before any file operations. |
| `acknowledged` | Dart app | User has dismissed the rollback notification. |

---

## 11. Idle Detection and Auto-Install

The auto-install feature allows an update to be applied silently when the user is not actively using the app. Three conditions must all be met simultaneously:

1. **Idle timer:** No pointer or keyboard activity for 5 minutes (`IdleDetector.idleThreshold`).
2. **No active VoIP call:** Checked via injected `hasActiveCall` callback.
3. **No active file transfer:** Checked via injected `hasActiveTransfer` callback.

### IdleDetector

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/services/idle_detector.dart`

`IdleDetector` extends `ChangeNotifier`. The root widget should wrap itself in a `Listener` that calls `onUserActivity()` on pointer events, and register a `HardwareKeyboard` handler for key events.

- `startMonitoring()` — activates the idle timer. Call when an update reaches `ready` and auto-install is enabled.
- `stopMonitoring()` — deactivates the timer and cancels any grace period. Call when auto-install is disabled or the update state leaves `ready`.
- `onUserActivity()` — resets the idle timer and cancels any in-progress grace period.

### Grace Period

When all conditions are first met, `startGracePeriod(onGraceComplete)` starts a 10-second countdown. If the user interacts during the countdown, `onUserActivity()` cancels the grace period. If conditions remain met when the timer fires, `onGraceComplete` is called and the update is launched.

### AutoUpdateService

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/services/auto_update_service.dart`

`AutoUpdateService` wires `IdleDetector` to the update launch flow:

- `setEnabled(true/false)` — toggles auto-install. When disabled, stops monitoring.
- `onUpdateReady()` — called by the orchestrator when state reaches `ready`. Starts monitoring if enabled.
- `onUpdateNotReady()` — stops monitoring when the update leaves `ready`.

Conditions are re-checked both when idle state changes and after the grace period completes, to guard against race conditions (a call starting during the grace period).

### User Preferences

| Provider | Key | Default |
|----------|-----|---------|
| `autoInstallUpdatesProvider` | `autoInstallUpdates` | `false` (opt-in) |
| `backgroundDownloadEnabledProvider` | `backgroundDownloadEnabled` | `true` (enabled by default) |

Both preferences are persisted to SharedPreferences.

---

## 12. Security Model

### HTTPS-Only Downloads

`UpdateDownloadService.downloadArtifact()` parses the URL and rejects any scheme other than `https` with `InsecureUrlException`. This check occurs before any network I/O. The same check applies in `fetchChecksums()`. There is no HTTP fallback.

### SHA-256 Integrity Verification

Every artifact is verified against the SHA-256 hash in `checksums.txt` before being considered ready to install. If the checksum is unavailable (the `checksums.txt` asset is missing from the release), the download is rejected outright. A corrupted or tampered artifact is detected and discarded; the orchestrator transitions to `failed`.

### Path Traversal Protection (Go Side)

The Go manifest parser (`manifest.go:validatePath`) rejects any path that:
- Is not absolute.
- Contains a `..` component when split by the platform separator.

The check operates on the raw path string rather than the cleaned path. `filepath.Clean` would resolve `..` away and hide the traversal, so it is explicitly not called before this check.

### Symlink Escape Detection (Go Side)

`fileops.go:copyDir` resolves every symlink in the source tree and checks whether the resolved target is within the source root using `isWithinDir`. Any symlink that resolves to a path outside the source tree is skipped and a warning is logged. This prevents a malicious release artifact from planting a symlink like `../../etc/passwd` that would be followed during installation.

### No Privilege Escalation

The updater never requests elevated privileges. The app is installed in user-writable locations (`%LOCALAPPDATA%`, `~/Library/Application Support`, `~/.local/share`). The updater operates entirely within directories the user already owns.

### Code Signing

The updater binary and the new app binary are both code-signed by the CI pipeline. The updater is copied from the signed release artifact, so the chain of trust is maintained.

### Process Identity Validation

Before waiting for exit, `WaitForExit` logs the process name associated with the PID as a best-effort sanity check. On Linux, process name is read from `/proc/<pid>/comm`. On macOS, it is queried via `ps`. On Windows, it is queried via `tasklist`. Mismatches are logged but do not abort the update.

---

## 13. Platform-Specific Behaviour

### Windows (`platform_windows.go`)

**PID waiting:** `waitForPIDPlatform` calls `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, pid)` followed by `WaitForSingleObject(handle, timeoutMs)`. This is an efficient kernel-level wait rather than a polling loop.

**File locking:** Windows locks open files. The updater waits for full process exit before touching any files. Even after exit, DLLs may remain briefly locked. `copyFilePlatform` wraps `copyFileDefault` with up to five retries and exponential backoff starting at 100 ms (100 ms, 200 ms, 400 ms, 800 ms, 1600 ms).

**Process termination:** Uses `TerminateProcess` (Win32) via `syscall.TerminateProcess`.

**Detached launch:** `detachProcessPlatform` sets `CreationFlags: CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS` on the new process's `SysProcAttr`.

**MSIX detection (Dart side):** If `Platform.resolvedExecutable` contains `"WindowsApps"`, the install is MSIX-managed. The in-app updater is disabled; the force-update dialog directs the user to the Microsoft Store.

### macOS (`platform_darwin.go`)

**PID checking:** Uses `kill(pid, 0)`. Returns true if the process exists (including `EPERM`, which means the process exists but the caller lacks permission to signal it).

**Process termination:** Sends `SIGTERM`.

**Quarantine clearing:** After all files are copied, `postCopyPlatform` runs `xattr -rd com.apple.quarantine` on every `.app` bundle in the installation directory. This prevents macOS Gatekeeper from displaying the "downloaded from the internet" warning dialog when the new version launches.

The Dart `UpdaterLauncher.deployUpdater()` also runs `xattr -rd com.apple.quarantine` on the updater binary itself after copying it to the external directory.

**App Store detection (Dart side):** If `<AppBundle>/Contents/_MASReceipt/receipt` exists, the install is Mac App Store managed. The in-app updater is disabled.

**Install directory detection:** On macOS, `getInstallDir()` walks up from `Platform.resolvedExecutable` (which is inside `zajel.app/Contents/MacOS/zajel`) to find the `.app` bundle root's parent directory.

### Linux (`platform_linux.go`)

**PID checking:** Uses `kill(pid, 0)`, same as macOS.

**Process termination:** Sends `SIGTERM`.

**Executable permissions:** After copying files, `postCopyPlatform` calls `chmod +x` on the main executable and on every file in the `lib/` subdirectory (shared objects). Permissions are set by adding `0o111` to the existing mode bits.

**Snap/Flatpak detection (Dart side):** Checked via `$SNAP` and `$FLATPAK_ID` environment variables respectively. These packaging systems handle updates through their own store mechanisms.

**AppImage detection (Dart side):** Checked via `$APPIMAGE`. AppImage supports auto-update via single-file replacement; `supportsAutoUpdate()` returns `true` for AppImage installs.

---

## 14. Riverpod Providers

### `update_providers.dart`

| Provider | Type | Description |
|----------|------|-------------|
| `githubReleaseServiceProvider` | `Provider<GitHubReleaseService>` | Singleton HTTP client for GitHub API. Disposes the client on provider disposal. |
| `updatePackageDetectorProvider` | `Provider<UpdatePackageDetector>` | Cached package format detector. |
| `supportsAutoUpdateProvider` | `Provider<bool>` | True if the current install supports in-app updates. |
| `storeNameProvider` | `Provider<String?>` | Display name of the managing store, or null. |
| `updateCheckResultProvider` | `StateProvider<UpdateCheckResult?>` | Latest manual check result (persists across Settings screen visits). |
| `updateCheckInProgressProvider` | `StateProvider<bool>` | True while a manual check is in progress. |
| `updateDownloadServiceProvider` | `Provider<UpdateDownloadService>` | Chunked download + verification service. |
| `updateOrchestratorProvider` | `Provider<UpdateOrchestrator>` | State machine coordinator. |
| `updateStateProvider` | `Provider<UpdateState>` | Current update state; invalidated on every state transition. |
| `updateStateStreamProvider` | `StreamProvider<UpdateState>` | Stream of state changes for transition listeners. |
| `updateBannerDismissedProvider` | `StateProvider<bool>` | Session-only banner dismissed flag. |

### `auto_update_providers.dart`

| Provider | Type | Description |
|----------|------|-------------|
| `autoInstallUpdatesProvider` | `StateNotifierProvider<AutoInstallUpdatesNotifier, bool>` | User preference for auto-install. Persisted to SharedPreferences. |
| `backgroundDownloadEnabledProvider` | `StateNotifierProvider<BackgroundDownloadSettingsNotifier, bool>` | User preference for background download. Persisted. Default true. |
| `idleDetectorProvider` | `ChangeNotifierProvider<IdleDetector>` | Idle timer and grace period controller. |

---

## 15. UI Components

### Update Settings Section

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/widgets/update_settings_section.dart`

`UpdateSettingsSection` is a `ConsumerWidget` placed in `Settings > Updates`. It is only rendered on desktop platforms. Its appearance adapts to the current update state:

| State | Display |
|-------|---------|
| Store-managed install | "Managed by [Store Name]" with current version |
| Checking in progress | Spinner + "Checking for updates..." |
| No check yet | Version number + "Check Now" button |
| Up to date | Green check + version + last-checked timestamp + "Check Now" |
| Update available | Update icon + available version + release date + notes + "Check Now" |
| Error | Orange warning + message + "Retry" (disabled if rate-limited) |

The "Check Now" button calls `GitHubReleaseService.checkForUpdate()` and stores the result in `updateCheckResultProvider`. Rate-limited states disable the button and show the time until the limit resets.

### Update Ready Banner

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/widgets/update_ready_banner.dart`

`UpdateReadyBanner` is a thin material banner rendered at the top of the content area when `updateStateProvider.status == UpdateStatus.ready` and the user has not dismissed it (`updateBannerDismissedProvider == false`).

- Shows "Version X.Y.Z ready to install".
- "Install" action calls the `onInstall` callback (provided by the parent widget to trigger the full launch flow).
- Close button sets `updateBannerDismissedProvider` to true for the session.

`UpdateReadyDot` is a smaller companion widget: an 8-pixel colored circle suitable for use as an app bar badge or settings icon indicator.

### Update Progress Indicator

**File:** `/home/meywd/zajel-plan09/packages/app/lib/features/updater/widgets/update_progress_indicator.dart`

`UpdateProgressIndicator` is a stateless widget used inside the `ForceUpdateDialog` to show the current phase of a forced update download. It adapts to the `UpdateStatus`:

| Status | Display |
|--------|---------|
| `downloading` | Linear progress bar + "Downloading X.Y.Z... N%" with Cancel option |
| `verifying` | Circular spinner + "Verifying..." |
| `launchingUpdater` | Circular spinner + "Installing..." + "The app will restart momentarily." |
| `failed` | Error icon + message + "Retry" button (if `onRetry` provided) |
| Other | Empty (`SizedBox.shrink()`) |

The downloading progress bar includes a `Semantics` label for screen reader compatibility: "Downloading update, N percent complete."

---

## 16. File Locations on Disk

### Staging Directory

Downloaded artifacts are staged here before extraction and installation.

| Platform | Path |
|----------|------|
| Windows | `%LOCALAPPDATA%\Zajel\update-staging\zajel-<version>-windows\` |
| macOS | `~/Library/Application Support/com.zajel.zajel/update-staging/zajel-<version>-macos/` |
| Linux | `~/.local/share/zajel/update-staging/zajel-<version>-linux/` |

### Updater Directory

The Go binary and its associated files live here. This directory is never replaced during an update.

| Platform | Path |
|----------|------|
| Windows | `%LOCALAPPDATA%\Zajel\updater\` |
| macOS | `~/Library/Application Support/com.zajel.zajel/updater/` |
| Linux | `~/.local/share/zajel/updater/` |

Files in this directory:

| File | Description |
|------|-------------|
| `zajel-updater` / `zajel-updater.exe` | Go updater binary |
| `manifest.json` | Written by Dart before launch; read by Go |
| `update-result.json` | Written by Go; read by Dart on next startup |

### Backup Directory

Holds a copy of the old installation during the file replacement window.

| Platform | Path |
|----------|------|
| Windows | `%LOCALAPPDATA%\Zajel\update-backup\` |
| macOS | `~/Library/Application Support/com.zajel.zajel/update-backup/` |
| Linux | `~/.local/share/zajel/update-backup\` |

Files in this directory during an active update:

| File | Description |
|------|-------------|
| `update-in-progress.lock` | Written before file replacement; deleted on success |
| (all app files) | Copy of the old installation for rollback |

---

## 17. CI Build Pipeline

A `build-updater` job cross-compiles the Go binary for all desktop platforms from a single `ubuntu-latest` runner:

```yaml
build-updater:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/setup-go@v5
      with:
        go-version: '1.22'
    - name: Build updater (all platforms)
      working-directory: packages/app/updater
      run: |
        GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" \
          -o ../../../artifacts/updater/windows/zajel-updater.exe .
        GOOS=darwin  GOARCH=amd64 go build -ldflags="-s -w" \
          -o ../../../artifacts/updater/macos-x64/zajel-updater .
        GOOS=darwin  GOARCH=arm64 go build -ldflags="-s -w" \
          -o ../../../artifacts/updater/macos-arm64/zajel-updater .
        GOOS=linux   GOARCH=amd64 go build -ldflags="-s -w" \
          -o ../../../artifacts/updater/linux/zajel-updater .
```

The platform build jobs for Windows, macOS, and Linux each bundle the appropriate updater binary inside the release artifact (ZIP, DMG, or tar.gz). The release job generates a `checksums.txt` file using `sha256sum` and attaches it to the GitHub Release alongside all platform artifacts.

Asset naming convention:

| Platform | Artifact filename |
|----------|-----------------|
| Windows | `zajel-<version>-windows.zip` |
| macOS | `zajel-<version>-macos.dmg` |
| Linux | `zajel-<version>-linux.tar.gz` |
| Checksums | `checksums.txt` |

---

## 18. Code Index

| Component | File |
|-----------|------|
| Update state enum + immutable record | `packages/app/lib/features/updater/models/update_state.dart` |
| Manifest model (Dart) | `packages/app/lib/features/updater/models/update_manifest.dart` |
| Update result model | `packages/app/lib/features/updater/models/update_result.dart` |
| GitHub release model | `packages/app/lib/features/updater/models/github_release.dart` |
| Update check result (sealed) | `packages/app/lib/features/updater/models/update_check_result.dart` |
| GitHub Releases API client | `packages/app/lib/features/updater/services/github_release_service.dart` |
| Chunked download + verification | `packages/app/lib/features/updater/services/update_download_service.dart` |
| State machine coordinator | `packages/app/lib/features/updater/services/update_orchestrator.dart` |
| Package format detector | `packages/app/lib/features/updater/services/update_package_detector.dart` |
| Manifest writer + binary launcher | `packages/app/lib/features/updater/services/updater_launcher.dart` |
| Crash counter + rollback trigger | `packages/app/lib/features/updater/services/update_rollback_service.dart` |
| Idle timer + grace period | `packages/app/lib/features/updater/services/idle_detector.dart` |
| Auto-install coordinator | `packages/app/lib/features/updater/services/auto_update_service.dart` |
| Core Riverpod providers | `packages/app/lib/features/updater/providers/update_providers.dart` |
| Auto-install preferences | `packages/app/lib/features/updater/providers/auto_update_providers.dart` |
| Settings section widget | `packages/app/lib/features/updater/widgets/update_settings_section.dart` |
| Ready banner + dot widget | `packages/app/lib/features/updater/widgets/update_ready_banner.dart` |
| Progress indicator widget | `packages/app/lib/features/updater/widgets/update_progress_indicator.dart` |
| Go updater entry point | `packages/app/updater/main.go` |
| Manifest parsing + path validation | `packages/app/updater/manifest.go` |
| Process wait + launch | `packages/app/updater/process.go` |
| Backup, replace, rollback, lock file | `packages/app/updater/fileops.go` |
| Update result struct + writer | `packages/app/updater/result.go` |
| Windows platform specifics | `packages/app/updater/platform_windows.go` |
| macOS platform specifics | `packages/app/updater/platform_darwin.go` |
| Linux platform specifics | `packages/app/updater/platform_linux.go` |
