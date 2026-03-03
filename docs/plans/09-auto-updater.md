# Plan 09: Desktop Auto-Update Package — Revised Architecture

## 1. Current State Analysis

**App structure per platform:**

- **Windows**: Flutter builds to `build/windows/x64/runner/Release/` producing `zajel.exe` plus DLLs (`flutter_windows.dll`, plugin DLLs, OpenSSL DLLs), a `data/` subdirectory (ICU data, flutter_assets, AOT library). Release artifacts: ZIP of the entire Release directory, plus optional MSIX package. Code signing via signtool on `zajel.exe`.

- **macOS**: Builds to `build/macos/Build/Products/Release/zajel.app` (standard `.app` bundle). Distributed as DMG (fallback to ZIP). App sandbox enabled. Bundle ID: `com.zajel.zajel`.

- **Linux**: Builds to `build/linux/x64/release/bundle/` containing the `zajel` binary, `lib/` (shared objects), and `data/` (ICU, flutter_assets, AOT). Distributed as tarball (`zajel-linux.tar.gz`).

**Existing update infrastructure:**

- `VersionCheckService` already fetches version policy from `GET /attest/versions` on the bootstrap server (Cloudflare Worker backed by `AttestationRegistryDO` Durable Object).
- `VersionPolicy` model has `minimumVersion`, `recommendedVersion`, `blockedVersions`, `sunsetDates`.
- `VersionStatus` enum: `upToDate`, `updateAvailable`, `updateRequired`, `blocked`.
- `AttestationInitializer` shows `UpdatePromptDialog` (dismissable) for `updateAvailable` and `ForceUpdateDialog` (blocking) for `updateRequired`/`blocked`.
- Current update flow simply opens a URL via `url_launcher`. There is no in-app download or self-update mechanism.
- GitHub Releases publish versioned artifacts: `zajel-{version}-windows.zip`, `zajel-{version}-macos.dmg`, `zajel-{version}-linux.tar.gz`.

---

## 2. Updater Binary: Language Choice

**Recommendation: Go**

| Criterion | Go | Rust | C/C++ | Shell Scripts |
|---|---|---|---|---|
| Cross-compilation | Excellent. `GOOS=windows/darwin/linux GOARCH=amd64/arm64` from any host | Good with `cross`/`cargo-zigbuild` but more setup | Poor. Separate toolchains per platform | N/A (not cross-platform) |
| Binary size | ~2-4 MB static | ~1-2 MB stripped | ~50 KB | N/A |
| Filesystem operations | Standard library `os`, `io` packages | Standard library | Platform-specific APIs | Good but fragile |
| Process management | `os/exec`, `syscall` packages | `std::process` | `CreateProcess`/`fork+exec` | `kill`, `start` |
| Error handling | Explicit, simple | Result types, more complex | Manual | Crude |
| Build system integration | `go build` — single command, no dependencies | `cargo build` — needs Rust toolchain | CMake/MSVC/GCC — complex | N/A |
| Static linking | Default behavior | Default behavior | Possible but painful | N/A |
| CI complexity | Minimal. Single `go build` line. | Moderate. Needs `rustup` + target setup. | High. Needs per-platform compilers. | N/A |
| Developer accessibility | Widely known, easy to maintain | Steeper learning curve | Error-prone | Too fragile for production |

Go wins on the combination of cross-compilation simplicity, static binary output, excellent standard library for filesystem/process operations, and low CI overhead. The ~3 MB binary size is acceptable for an updater that ships alongside a ~50 MB Flutter app.

---

## 3. Architecture Overview

```
+-------------------------------------------+
|            Zajel Flutter App               |
|                                            |
|  +-----------+  +----------------------+  |
|  | Version   |  | Update Download      |  |
|  | Check     |  | Service              |  |
|  | Service   |  | (background HTTP)    |  |
|  +-----+-----+  +----------+-----------+  |
|        |                    |              |
|        v                    v              |
|  +-----+--------------------+----------+  |
|  |     Update Orchestrator              |  |
|  |  - check for updates                |  |
|  |  - download to staging              |  |
|  |  - verify integrity (SHA-256)       |  |
|  |  - write manifest.json              |  |
|  |  - launch updater binary            |  |
|  +-----+-------------------------------+  |
|        |                                   |
+--------|-----------------------------------+
         |  (launches process, exits)
         v
+-------------------------------------------+
|         Zajel Updater Binary (Go)          |
|                                            |
|  1. Parse manifest.json / CLI args         |
|  2. Wait for app PID to exit               |
|  3. Backup current installation            |
|  4. Extract staged update to install dir   |
|  5. Verify extracted files                 |
|  6. Launch new app                         |
|  7. Exit (or rollback on failure)          |
+-------------------------------------------+
```

---

## 4. Detailed Component Design

### 4.1 Update Discovery & Version Policy Extension

**Recommendation**: Use GitHub Releases API directly for artifact discovery. The bootstrap server's `VersionPolicy` already handles version gating (minimum, recommended, blocked). Adding artifact URLs to the bootstrap server duplicates information already available from GitHub and creates a maintenance burden.

The flow becomes:
1. App checks `GET /attest/versions` on bootstrap (existing) to know if an update is needed.
2. If `updateAvailable` or `updateRequired`, app queries GitHub Releases API for the latest release to get download URLs and checksums.
3. Checksums are published as a `checksums.txt` file attached to each GitHub release (computed in CI).

### 4.2 Update Download Service (Dart, in-app)

New Dart service: `lib/features/updater/services/update_download_service.dart`

Responsibilities:
- Download the platform-appropriate artifact from GitHub Releases
- Stream download to a staging directory using chunked HTTP
- Report progress (bytes downloaded / total bytes) via a Riverpod provider
- Verify SHA-256 checksum after download
- Support background pre-download
- Support resumable downloads (HTTP Range header)
- Clean up stale staged downloads on app start

**Staging directory location** (per platform):
- **Windows**: `%LOCALAPPDATA%\Zajel\update-staging\`
- **macOS**: `~/Library/Application Support/com.zajel.zajel/update-staging/`
- **Linux**: `~/.local/share/zajel/update-staging/`

**Staged artifact layout** after download and extraction:
```
update-staging/
  manifest.json          # Written by app, read by updater
  zajel-1.2.0-windows/   # Extracted artifact contents
    zajel.exe
    flutter_windows.dll
    data/
    ...
```

### 4.3 Update Manifest (IPC Protocol)

The app writes a JSON manifest that the updater reads. This is preferred over command-line args alone because paths may contain spaces/quotes/unicode, the manifest can contain structured data, and the updater can re-read it on crash recovery.

**`manifest.json` schema:**

```json
{
  "schema_version": 1,
  "app_pid": 12345,
  "app_version_current": "1.0.0",
  "app_version_target": "1.2.0",
  "install_dir": "C:\\Users\\user\\AppData\\Local\\Zajel\\app",
  "staging_dir": "C:\\Users\\user\\AppData\\Local\\Zajel\\update-staging\\zajel-1.2.0-windows",
  "backup_dir": "C:\\Users\\user\\AppData\\Local\\Zajel\\update-backup",
  "app_executable": "zajel.exe",
  "platform": "windows",
  "checksum_sha256": "abc123...",
  "timestamp": "2026-03-02T12:00:00Z"
}
```

**Updater invocation (CLI):**
```
zajel-updater --manifest /path/to/manifest.json --pid 12345
```

**Updater exit codes:**
| Code | Meaning |
|------|---------|
| 0 | Success — new app launched |
| 1 | Generic failure |
| 2 | Manifest parse error |
| 3 | App process did not exit in time |
| 4 | Backup creation failed |
| 5 | File copy failed |
| 6 | Rollback completed (update failed, restored backup) |
| 7 | Rollback failed (critical — user needs manual intervention) |
| 8 | New app failed to launch |

### 4.4 Updater Binary Design (Go)

**Source location**: `packages/app/updater/`

**Structure:**
```
packages/app/updater/
  main.go
  manifest.go      # Manifest parsing
  process.go       # PID waiting, app launching
  fileops.go       # Backup, copy, rollback
  fileops_test.go
  platform_windows.go  # Windows-specific (file locking checks)
  platform_darwin.go   # macOS-specific (.app bundle handling)
  platform_linux.go    # Linux-specific (AppImage, tarball)
  go.mod
  go.sum
```

**Update sequence:**

```
START
  |
  v
Parse manifest.json + CLI args
  |
  v
Validate: staging_dir exists, files present, checksums match
  |
  v
Wait for app PID to exit (poll, max 30 seconds)
  |-- timeout --> Send SIGTERM/TerminateProcess, wait 10s more
  |-- still running --> Exit code 3 (failure)
  |
  v
Create backup: copy install_dir -> backup_dir
  |-- failure --> Exit code 4
  |
  v
Replace files: copy staging_dir -> install_dir
  |-- failure --> ROLLBACK (restore backup_dir -> install_dir)
  |              Exit code 6 (rollback success) or 7 (rollback failure)
  |
  v
Launch new app executable from install_dir
  |-- failure --> ROLLBACK, Exit code 8
  |
  v
Clean up: delete staging_dir, mark update complete
Write update-result.json (exit code, timestamp, version)
  |
  v
Exit code 0
```

**Platform-specific behaviors:**

**Windows:**
- Files are locked while the app runs. Updater MUST wait for full process exit before any file operations.
- Use `windows.WaitForSingleObject` on the process handle for efficient PID waiting.
- After app exits, DLLs may still be briefly locked. Retry file operations with exponential backoff (100ms-5s).
- MSIX installs: detect via `WindowsApps` in executable path. Defer to Windows Store updates.

**macOS:**
- `.app` bundles: macOS caches running binary in memory, but updater still waits for exit for safety.
- Replace operation: atomic rename preferred (`mv zajel.app zajel.app.bak && mv staged/zajel.app zajel.app`).
- Run `xattr -rd com.apple.quarantine` on extracted `.app` bundle to clear Gatekeeper quarantine.
- App Store distribution: detect via `_MASReceipt/receipt` file; disable auto-update.

**Linux:**
- Tarball installs: directory swap.
- AppImage: single file replacement. Detect via `$APPIMAGE` environment variable.
- Run `chmod +x` on new binary after extraction.
- Snaps/Flatpaks: detect via `$SNAP` / `$FLATPAK_ID`; defer to store updates.

### 4.5 Install Directory Detection

- **Windows**: `Platform.resolvedExecutable` -> parent directory
- **macOS**: `Platform.resolvedExecutable` -> `zajel.app`'s parent
- **Linux**: `Platform.resolvedExecutable` -> parent (tarball) or AppImage file itself

### 4.6 Pre-Download Flow

When auto-update is enabled:
1. On app start, after `VersionCheckService` returns `updateAvailable`, check for existing staged download.
2. If not present, begin background download. Progress stored in Riverpod `StateNotifier`.
3. On completion: verify SHA-256, extract to staging, write manifest (except `app_pid`), show subtle notification.
4. When user confirms: fill in `app_pid`, launch updater, app exits gracefully.
5. Auto-install mode: launch immediately if user not in active call/transfer.

### 4.7 Rollback Mechanism

**Layer 1: Updater backup/restore**
Before replacing files, updater copies install_dir to backup_dir. On failure, restores from backup.

**Layer 2: App launch verification**
Updater writes `update-result.json` with `"status": "pending_verification"`.

On first launch of new version:
- Increment `update_launch_attempt` in SharedPreferences
- After successful init, set to 0 and write `"status": "verified"`
- If `update_launch_attempt >= 2` and status is `pending_verification`, trigger rollback

**Power loss recovery:**
Updater writes `update-in-progress.lock` during copy, deletes on completion. On next launch, if lock exists, auto-rollback.

### 4.8 Updater Binary Location

The updater must NOT be inside the install directory that gets replaced. Fixed external location:
- **Windows**: `%LOCALAPPDATA%\Zajel\updater\zajel-updater.exe`
- **macOS**: `~/Library/Application Support/com.zajel.zajel/updater/zajel-updater`
- **Linux**: `~/.local/share/zajel/updater/zajel-updater`

App copies updater from staged download to this location before launching it.

### 4.9 Updater Self-Update

Each release includes the updater binary. When preparing an update:
1. Extract new release to staging
2. Copy new `zajel-updater` from staging to external location (overwriting old)
3. Launch updated updater

### 4.10 Package Format Detection

```dart
class UpdatePackageDetector {
  static bool isMsix() => Platform.isWindows &&
    Platform.resolvedExecutable.contains('WindowsApps');

  static bool isSnap() => Platform.environment.containsKey('SNAP');
  static bool isFlatpak() => Platform.environment.containsKey('FLATPAK_ID');

  static bool isMacAppStore() => Platform.isMacOS &&
    File('${_appBundlePath()}/Contents/_MASReceipt/receipt').existsSync();

  static bool isAppImage() => Platform.environment.containsKey('APPIMAGE');

  static bool supportsAutoUpdate() =>
    !isMsix() && !isSnap() && !isFlatpak() && !isMacAppStore();
}
```

### 4.11 CI Build Pipeline Changes

**New job: `build-updater`** (ubuntu-latest, cross-compiles for all platforms)

```yaml
build-updater:
  runs-on: ubuntu-latest
  needs: [check-changes, test]
  if: needs.check-changes.outputs.app_changed == 'true'
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.22'
    - name: Build updater (all platforms)
      working-directory: packages/app/updater
      run: |
        GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o ../../../artifacts/updater/windows/zajel-updater.exe .
        GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -o ../../../artifacts/updater/macos-x64/zajel-updater .
        GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o ../../../artifacts/updater/macos-arm64/zajel-updater .
        GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../../../artifacts/updater/linux/zajel-updater .
    - uses: actions/upload-artifact@v4
      with:
        name: updater-binaries
        path: artifacts/updater/
```

Modified platform build jobs include updater binary in app package. Release job generates `checksums.txt` attached to GitHub Release.

### 4.12 Settings UI Changes

New section in `settings_screen.dart` (desktop only):

```
Updates
  [x] Check for updates automatically
  [x] Download updates in background
  [ ] Install updates automatically (when idle)

  Current version: 1.0.0
  Latest version: 1.2.0 (ready to install)
  [Install Update] button
```

---

## 5. Complete Update Lifecycle (State Machine)

```
                    +--------+
                    |  IDLE  |<-----------------------------------+
                    +---+----+                                    |
                        |                                         |
                  (timer/manual check)                           |
                        |                                         |
                    +---v--------+                                |
                    | CHECKING   |                                |
                    +---+--------+                                |
                        |                                         |
              +---------+---------+                               |
              |                   |                               |
         (up to date)      (update available)                    |
              |                   |                               |
              v                   v                               |
          +---+----+     +-------+--------+                      |
          |  IDLE  |     | DOWNLOADING    |                      |
          +--------+     | (progress %)   |                      |
                         +-------+--------+                      |
                                 |                               |
                           (download done)                       |
                                 |                               |
                         +-------v--------+                      |
                         |   VERIFYING    |                      |
                         | (SHA-256)      |                      |
                         +-------+--------+                      |
                                 |                               |
                    +------------+-----------+                   |
                    |                        |                   |
              (checksum OK)           (checksum fail)           |
                    |                        |                   |
                    v                        v                   |
           +--------+------+         +------+------+            |
           | READY         |         | FAILED      +------------+
           | (user prompt) |         | (retry)     |
           +--------+------+         +-------------+
                    |
          (user confirms / auto-install)
                    |
           +--------v-------+
           | LAUNCHING      |
           | UPDATER        |
           +--------+-------+
                    |
              (app exits)
                    |
           [Updater takes over]
```

---

## 6. Security Considerations

1. **Download integrity**: SHA-256 checksums verified before extraction. Future: Ed25519 signature on checksum file.
2. **HTTPS only**: All downloads via HTTPS. No HTTP fallback.
3. **No elevation**: Updater never requires admin/root. App installed in user-writable locations.
4. **Process validation**: Updater validates PID belongs to `zajel` before termination.
5. **Manifest integrity**: Written by app to staging directory with same security posture.
6. **Code signing continuity**: Updater binary and new app binary are code-signed by CI.

---

## 7. User Stories

**US-1: Manual Update Check (Desktop)**
As a desktop user, I want to check for updates from Settings so I can stay on the latest version.
- Acceptance: Settings > Updates > "Check Now" queries GitHub Releases API and shows result.

**US-2: Background Update Download**
As a desktop user with auto-download enabled, I want the app to download updates in the background so the update is ready when I want it.
- Acceptance: After version check detects update, download begins silently. Subtle badge appears when ready.

**US-3: User-Confirmed Update Install**
As a desktop user, when an update is ready, I want to click "Install Update" and have the app seamlessly update and relaunch.
- Acceptance: Click -> manifest -> updater -> exit -> replace -> launch. Downtime under 10 seconds.

**US-4: Automatic Silent Update**
As a desktop user who opted into automatic updates, I want the app to update itself when idle.
- Acceptance: When no active calls/transfers and update verified, updater launches at next restart or idle period.

**US-5: Rollback on Bad Update**
As a desktop user, if an update fails to start, I want automatic recovery to the previous version.
- Acceptance: If new version crashes 2+ times during startup, rollback triggers. User sees "Update rolled back" message.

**US-6: MSIX/Store Users See Store Update Prompt**
As a Windows MSIX user, I should not see the in-app updater.
- Acceptance: Auto-update UI hidden. Force update dialog shows "Update via Microsoft Store" button.

**US-7: Force Update Triggers Desktop Auto-Update**
As a desktop user whose version is below minimum, the force update dialog should offer one-click in-app update.
- Acceptance: ForceUpdateDialog shows "Download and Install" button (desktop) or store link (mobile/MSIX).

---

## 8. File Organization

**New files:**
```
packages/app/updater/                    # Go updater binary source
  go.mod
  go.sum
  main.go
  manifest.go
  process.go
  fileops.go
  fileops_test.go
  platform_windows.go
  platform_darwin.go
  platform_linux.go

packages/app/lib/features/updater/      # Dart update orchestration
  models/
    update_manifest.dart
    update_state.dart
    update_artifact.dart
  services/
    update_check_service.dart
    update_download_service.dart
    update_orchestrator.dart
    update_package_detector.dart
    updater_launcher.dart
  providers/
    update_providers.dart
  widgets/
    update_settings_section.dart
    update_ready_banner.dart
    update_progress_dialog.dart
```

**Modified files:**
```
packages/app/lib/features/attestation/widgets/update_prompt_dialog.dart
packages/app/lib/features/attestation/widgets/force_update_dialog.dart
packages/app/lib/features/attestation/attestation_initializer.dart
packages/app/lib/features/settings/settings_screen.dart
packages/app/lib/core/providers/app_providers.dart
.github/workflows/release.yml
```

---

## 9. Implementation Sequence

**Phase 1: Foundation** (no user-visible changes)
1. Create Go updater project with manifest parsing and file operations
2. Write comprehensive Go tests
3. Create `UpdatePackageDetector` in Dart
4. Create `UpdateManifest` and `UpdateState` models

**Phase 2: CI Pipeline**
5. Add `build-updater` job to `release.yml`
6. Modify platform build jobs to bundle updater binary
7. Add `checksums.txt` generation

**Phase 3: Download & Verify**
8. Create `UpdateCheckService` (GitHub Releases API client)
9. Create `UpdateDownloadService` (chunked download with progress)
10. Create `UpdateOrchestrator` (state machine)
11. Create Riverpod providers

**Phase 4: Updater Integration**
12. Create `UpdaterLauncher`
13. Implement Go updater full lifecycle
14. Manual testing per platform

**Phase 5: UI**
15. Add Updates section to Settings
16. Modify dialogs for desktop
17. Add update-ready banner
18. Add rollback detection to startup

**Phase 6: Polish**
19. Auto-download preference
20. Auto-install with idle detection
21. Stale staging cleanup
22. Platform-specific testing

---

## 10. Risks and Mitigations

| Challenge | Risk | Mitigation |
|---|---|---|
| Windows file locking | High | Updater retries with backoff; verifies PID exit before file ops |
| macOS Gatekeeper quarantine | Medium | Updater runs `xattr -rd com.apple.quarantine` on extracted files |
| macOS App Sandbox (App Store) | High | Detect via receipt file; disable auto-update |
| Large download on metered connection | Medium | Respect OS metered connection APIs; show download size |
| Antivirus blocking updater | Medium | Code-sign the updater binary |
| Power loss during update | Low | Lock file + backup dir enables recovery |
| Updater binary corrupt | Very Low | Verify checksum before extraction |
| GitHub API rate limiting | Low | 60 req/hr unauthenticated; cache for 1 hour |
| Partial download (network drop) | Medium | HTTP Range resumption; `.partial` suffix |
