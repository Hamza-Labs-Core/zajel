# US-7: Force Update Triggers Desktop Auto-Update

## Description

When a desktop user's app version is below the minimum required version (or is explicitly blocked), the existing `ForceUpdateDialog` currently only offers an "Update Now" button that opens an external URL via `url_launcher`. This story replaces that behavior on non-store desktop installs with a one-click "Download and Install" flow that downloads the update, verifies it, and launches the updater binary -- all from within the blocking dialog. Store-based desktop installs (MSIX, Snap, Flatpak, Mac App Store) show a "Update via [Store Name]" button instead. Mobile behavior is preserved unchanged.

## Acceptance Criteria

### Desktop (non-store installs: ZIP/tarball/DMG/AppImage)
- [ ] `ForceUpdateDialog` shows a "Download and Install" button instead of the current "Update Now" external link button.
- [ ] Clicking "Download and Install" begins an in-app download of the platform-appropriate artifact from GitHub Releases.
- [ ] The dialog displays inline download progress (percentage and bytes) replacing the button area during download.
- [ ] After download completes, the dialog shows a "Verifying..." state while SHA-256 checksum verification runs.
- [ ] After verification succeeds, the dialog shows "Installing..." and the updater binary is launched.
- [ ] The app exits gracefully after launching the updater. The updater replaces files and relaunches the new version.
- [ ] The entire flow (blocked -> downloading -> verifying -> installing -> app relaunched) is a single uninterrupted user interaction from the force update dialog.
- [ ] The dialog cannot be dismissed at any point (existing `PopScope(canPop: false)` behavior preserved).
- [ ] If download fails, the dialog shows an error message with a "Retry" button and a "Download Manually" fallback link.
- [ ] If checksum verification fails, the dialog shows an error with "Retry" (re-downloads) and "Download Manually" fallback.
- [ ] If the updater binary is not found or fails to launch, the dialog shows an error with "Download Manually" fallback.

### Desktop (store installs: MSIX, Snap, Flatpak, Mac App Store)
- [ ] `ForceUpdateDialog` shows "Update via Microsoft Store" (MSIX), "Update via Snap Store" (Snap), "Update via Flathub" (Flatpak), or "Update via App Store" (Mac App Store) button.
- [ ] Clicking the store button opens the appropriate store page via `url_launcher`.
- [ ] The in-app download/install flow is NOT shown for store installs.

### Mobile (iOS/Android)
- [ ] Existing behavior is unchanged: "Update Now" button opens the app store URL via `url_launcher`.

### Blocked vs. updateRequired distinction
- [ ] When `VersionStatus.blocked` (version in `blockedVersions` list), the dialog title says "Version Blocked", the icon is red, and the message references a security issue.
- [ ] When `VersionStatus.updateRequired` (version below `minimumVersion`), the dialog title says "Update Required", the icon is orange, and the message references minimum version.
- [ ] Both statuses trigger the same download-and-install flow on desktop; only the messaging differs.

### Sunset date awareness
- [ ] If the current version has a `sunsetDate` entry in the policy and the date has not yet passed, the dialog shows the sunset date: "This version will stop working on [date]. Update now to avoid interruption."
- [ ] If the sunset date has passed, the version is treated as `updateRequired`.

---

## Technical Context

### What exists today

**`ForceUpdateDialog`** (`packages/app/lib/features/attestation/widgets/force_update_dialog.dart`):
- A `StatelessWidget` wrapped in `PopScope(canPop: false)` with a `Scaffold` body.
- Accepts `updateUrl` (optional String), `requiredVersion` (optional String), and `isBlocked` (bool).
- Shows an icon (block or system_update), a title, a descriptive message, and a single `FilledButton.icon` labeled "Update Now" that calls `launchUrl()` to open `updateUrl` in an external browser.
- No concept of download progress, inline states, or platform-aware behavior.

**`UpdatePromptDialog`** (`packages/app/lib/features/attestation/widgets/update_prompt_dialog.dart`):
- A dismissable `AlertDialog` for the `updateAvailable` case (below recommended, above minimum).
- Has "Later" and "Update" buttons. "Update" opens a URL via `url_launcher` and pops the dialog.
- Not modified by this story (US-8 will handle adding auto-update to this dialog).

**`AttestationInitializer`** (`packages/app/lib/features/attestation/attestation_initializer.dart`):
- `_runVersionCheck()` calls `versionCheckService.checkVersion()` and switches on the `VersionStatus` enum.
- For `updateRequired`: calls `_showForceUpdate()` with `requiredVersion` from cached policy.
- For `blocked`: calls `_showForceUpdate()` with `isBlocked: true`.
- `_showForceUpdate()` pushes `ForceUpdateDialog` via `Navigator.of(context).pushAndRemoveUntil()` -- replaces entire navigation stack.
- Does not currently pass any download service, orchestrator, or package detector to the dialog.

**`VersionCheckService`** (`packages/app/lib/features/attestation/services/version_check_service.dart`):
- Fetches `VersionPolicy` from `GET /attest/versions` on the bootstrap server via `AttestationClient`.
- `evaluateVersion()` checks blockedVersions first (exact string match), then minimumVersion (semver comparison), then recommendedVersion.
- Fails open: returns `upToDate` if policy fetch fails.

**`VersionPolicy`** (`packages/app/lib/features/attestation/models/version_policy.dart`):
- Fields: `minimumVersion`, `recommendedVersion`, `blockedVersions` (List<String>), `sunsetDates` (Map<String, String>).
- `sunsetDates` maps version strings to ISO date strings but is not currently used by any UI code.

**`Environment`** (`packages/app/lib/core/config/environment.dart`):
- `Environment.version` and `Environment.fullVersion` provide the current app version.
- No platform detection helpers exist here (use `dart:io` `Platform` class directly).

### What does NOT exist yet (dependencies from other stories)

The following components are defined in the plan (sections 4.2, 4.3, 4.4, 4.10) but do not exist in the codebase yet. They must be implemented by prerequisite stories before this story can be completed:

- **`UpdateDownloadService`** (US-2): Downloads platform-appropriate artifacts from GitHub Releases with chunked HTTP, progress reporting via Riverpod, SHA-256 verification, and resumable downloads.
- **`UpdateOrchestrator`** (US-3): State machine managing the update lifecycle (IDLE -> CHECKING -> DOWNLOADING -> VERIFYING -> READY -> LAUNCHING_UPDATER). Coordinates between version check, download, verification, manifest writing, and updater launch.
- **`UpdatePackageDetector`** (US-6): Detects the install type -- `isMsix()`, `isSnap()`, `isFlatpak()`, `isMacAppStore()`, `isAppImage()`, `supportsAutoUpdate()`.
- **`UpdaterLauncher`** (US-3): Writes `manifest.json` and launches the Go updater binary.
- **`UpdateManifest`** model: Schema for IPC between app and updater binary.
- **`UpdateState`** model: Enum/sealed class for the update state machine states.
- **Riverpod providers** for update state, download progress, etc. (in `lib/features/updater/providers/update_providers.dart`).

---

## Implementation Details

### 1. Convert `ForceUpdateDialog` to a `StatefulWidget` (or `ConsumerStatefulWidget`)

The current `StatelessWidget` cannot manage download state transitions. Convert it to a `ConsumerStatefulWidget` so it can:
- Read `UpdateOrchestrator` state via Riverpod.
- Read `UpdateDownloadService` progress via Riverpod.
- Read `UpdatePackageDetector` to determine the install type.
- Manage local UI state for error messages and retry logic.

### 2. Add platform-aware button rendering

```
if (mobile) -> "Update Now" button opening store URL (existing behavior)
if (desktop && store install) -> "Update via [Store Name]" button opening store URL
if (desktop && non-store) -> "Download and Install" button triggering in-app flow
```

Use `UpdatePackageDetector` to determine the install type. Inject it via a Riverpod provider (from US-6).

Platform detection logic:
```dart
import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;

bool get _isDesktop => !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);
bool get _isMobile => !kIsWeb && (Platform.isAndroid || Platform.iOS);
```

Store name mapping:
```dart
String? _storeName(UpdatePackageDetector detector) {
  if (detector.isMsix()) return 'Microsoft Store';
  if (detector.isSnap()) return 'Snap Store';
  if (detector.isFlatpak()) return 'Flathub';
  if (detector.isMacAppStore()) return 'App Store';
  return null; // non-store install
}
```

### 3. Dialog state transitions (non-store desktop)

The dialog renders different content based on the current `ForceUpdatePhase`:

```dart
enum ForceUpdatePhase {
  /// Initial state -- shows "Download and Install" button.
  blocked,

  /// Download in progress -- shows progress bar and percentage.
  downloading,

  /// Verifying checksum -- shows indeterminate spinner.
  verifying,

  /// Launching updater and exiting -- shows "Installing..." message.
  installing,

  /// An error occurred -- shows error message with retry/fallback.
  error,
}
```

**Phase: `blocked`** (initial)
- Icon, title, and message as today.
- "Download and Install" `FilledButton.icon` with `Icons.download` icon.
- Below the button: text showing the target version and approximate download size (if known from GitHub Releases API metadata).

**Phase: `downloading`**
- Title changes to "Downloading Update..."
- `LinearProgressIndicator` with determinate value (0.0 to 1.0).
- Text below showing: "[X] MB / [Y] MB ([Z]%)"
- No cancel button (this is a force update -- the user cannot proceed without updating).

**Phase: `verifying`**
- Title changes to "Verifying Update..."
- `CircularProgressIndicator` (indeterminate).
- Text: "Checking file integrity..."

**Phase: `installing`**
- Title changes to "Installing Update..."
- `CircularProgressIndicator` (indeterminate).
- Text: "The app will restart momentarily."
- At this point the updater binary has been launched and the app is about to exit.

**Phase: `error`**
- Title stays as "Update Required" or "Version Blocked" (matches original).
- Error icon and red-tinted error message describing what went wrong.
- Two buttons:
  - "Retry" (`FilledButton`) -- restarts the download from scratch (or from resumption point if `UpdateDownloadService` supports it).
  - "Download Manually" (`TextButton`) -- opens the GitHub Releases URL in an external browser as a fallback. This ensures the user always has a way to update even if the in-app flow fails.

### 4. Modified `ForceUpdateDialog` constructor

```dart
class ForceUpdateDialog extends ConsumerStatefulWidget {
  final String? requiredVersion;
  final bool isBlocked;
  // Removed: updateUrl (no longer needed as primary action)
  // Added: fallbackUrl for "Download Manually" fallback
  final String? fallbackUrl;

  const ForceUpdateDialog({
    super.key,
    this.requiredVersion,
    this.isBlocked = false,
    this.fallbackUrl,
  });

  @override
  ConsumerState<ForceUpdateDialog> createState() => _ForceUpdateDialogState();
}
```

### 5. Download and install flow (step by step)

1. User sees `ForceUpdateDialog` in `blocked` phase.
2. User taps "Download and Install".
3. Dialog transitions to `downloading` phase.
4. Dialog calls `UpdateOrchestrator.startForceUpdate()` (a new method on the orchestrator, or reuses `startDownload()` with a force flag).
5. `UpdateOrchestrator` queries the GitHub Releases API for the latest release matching the target platform.
6. `UpdateDownloadService` begins chunked HTTP download to the staging directory.
7. Dialog reads progress from the `updateDownloadProgressProvider` (Riverpod) and updates the `LinearProgressIndicator`.
8. Download completes. `UpdateOrchestrator` transitions to VERIFYING state.
9. Dialog transitions to `verifying` phase.
10. `UpdateDownloadService` computes SHA-256 of the downloaded artifact and compares against `checksums.txt` from the GitHub Release.
11. Verification succeeds. `UpdateOrchestrator` transitions to READY, then immediately to LAUNCHING_UPDATER (no user confirmation needed for force updates).
12. Dialog transitions to `installing` phase.
13. `UpdateOrchestrator` writes `manifest.json` (with `app_pid`, install paths, checksums), copies the updater binary to the external location, and launches the updater process.
14. App exits gracefully (`exit(0)` or `SystemNavigator.pop()`).
15. Updater binary takes over: waits for PID exit, backs up current install, replaces files, launches new app, exits.

### 6. Changes to `AttestationInitializer`

`_showForceUpdate()` must be updated to pass additional information to the dialog:

```dart
static void _showForceUpdate(
  BuildContext context, {
  String? requiredVersion,
  bool isBlocked = false,
}) {
  Navigator.of(context).pushAndRemoveUntil(
    MaterialPageRoute(
      builder: (_) => ForceUpdateDialog(
        requiredVersion: requiredVersion,
        isBlocked: isBlocked,
        // fallbackUrl constructed from GitHub repo URL + latest release
        fallbackUrl: 'https://github.com/user/zajel/releases/latest',
      ),
    ),
    (_) => false,
  );
}
```

The dialog itself reads `UpdatePackageDetector` and `UpdateOrchestrator` from Riverpod providers, so `AttestationInitializer` does not need to inject them directly.

### 7. Integration with UpdateOrchestrator

Add a `startForceUpdate()` method to `UpdateOrchestrator` (or a parameter on the existing flow) that:
- Skips the "wait for user confirmation" step (goes straight from READY to LAUNCHING_UPDATER).
- Reports errors back to the dialog via state rather than showing a separate notification.
- Does not respect "auto-download" or "auto-install" preferences (force update always proceeds).

The orchestrator's state should be observable via a Riverpod provider:

```dart
final updateStateProvider = StateNotifierProvider<UpdateOrchestrator, UpdateState>(...);
```

The `ForceUpdateDialog` maps `UpdateState` to `ForceUpdatePhase`:
- `UpdateState.idle` / `UpdateState.checking` -> `ForceUpdatePhase.blocked`
- `UpdateState.downloading` -> `ForceUpdatePhase.downloading`
- `UpdateState.verifying` -> `ForceUpdatePhase.verifying`
- `UpdateState.ready` / `UpdateState.launchingUpdater` -> `ForceUpdatePhase.installing`
- `UpdateState.failed` -> `ForceUpdatePhase.error`

### 8. Download progress provider

The download progress should be exposed as a separate provider for granular rebuilds:

```dart
/// Provider for download progress (0.0 to 1.0) and bytes info.
final updateDownloadProgressProvider = StateProvider<DownloadProgress>((ref) =>
  const DownloadProgress(bytesReceived: 0, bytesTotal: 0, fraction: 0.0));
```

The dialog reads this with `ref.watch(updateDownloadProgressProvider)` inside a `Consumer` widget wrapping only the progress bar area, to avoid rebuilding the entire dialog on each progress tick.

---

## Distinction Between `updateRequired`, `blocked`, and `sunsetDates`

| Status | Trigger | Dialog Title | Icon Color | Message Emphasis | Update Flow |
|--------|---------|-------------|-----------|-----------------|-------------|
| `updateRequired` | `currentVersion < minimumVersion` | "Update Required" | Orange | "Your version is too old to connect" | Same download-and-install flow |
| `blocked` | `currentVersion in blockedVersions` | "Version Blocked" | Red | "This version has been blocked due to a security issue" | Same download-and-install flow |
| Sunset (pending) | `sunsetDates[currentVersion]` exists and date is in the future | "Update Required" | Orange | "This version will stop working on [date]" | Same download-and-install flow, but the version check logic must evaluate sunset dates |
| Sunset (expired) | `sunsetDates[currentVersion]` exists and date has passed | Treated as `updateRequired` | Orange | Same as `updateRequired` | Same |

**Note**: `sunsetDates` evaluation requires a change to `VersionCheckService.evaluateVersion()` to check whether the current version has a sunset date that has passed. If so, return `updateRequired` even if the version is above `minimumVersion`. This is a minor extension to the existing logic.

---

## Edge Cases

### Download fails during force update
- Network drops mid-download: `UpdateDownloadService` detects the HTTP stream error and reports failure to the orchestrator.
- Dialog transitions to `error` phase with message: "Download failed. Check your internet connection and try again."
- "Retry" button resumes download from last byte if the server supports HTTP Range headers; otherwise restarts from scratch.
- "Download Manually" button opens `fallbackUrl` in external browser.

### Checksum verification fails
- Dialog shows: "The downloaded file could not be verified. It may be corrupted."
- "Retry" deletes the staged artifact and re-downloads.
- "Download Manually" fallback available.

### GitHub Releases API unavailable
- If the GitHub API returns an error or times out, the orchestrator cannot determine the download URL.
- Dialog shows: "Could not reach the update server. Please try again later."
- "Retry" button re-queries the GitHub Releases API.
- "Download Manually" button opens the fallback URL (which is the GitHub Releases page, so the user can manually download).

### Updater binary not found
- The updater binary should be bundled with the app. If it is missing from the expected external location and cannot be copied from the staged download, the dialog shows: "Update installation component is missing."
- "Download Manually" is the only fallback in this case.

### User closes the app during download
- The app is in a force-update state, so the user cannot navigate away from the dialog.
- The user can still kill the process (Task Manager, `kill`, force quit). On next launch, `VersionCheckService` will re-evaluate and show the force update dialog again.
- `UpdateDownloadService` should clean up partial downloads on next app start (stale staging cleanup, per plan section 4.2).

### Network unavailable at app start
- `VersionCheckService` fails open (returns `upToDate`) if it cannot fetch the policy.
- The force update dialog is NOT shown. The app proceeds normally.
- This is the existing behavior and is acceptable: without network, the user cannot message anyone anyway, and the next successful version check will trigger the dialog.

### App is already on the latest version but is blocked
- A specific version can be in `blockedVersions` even if it equals or exceeds `recommendedVersion`.
- The dialog must still show and the download flow must still work.
- The downloaded version from GitHub Releases will be whatever the latest release is. If that version is also blocked (misconfiguration), the user will see the force update dialog again after restart. This is a server-side policy issue, not an app issue.

### Multiple rapid retries
- Debounce the "Retry" button: disable it for 2 seconds after each tap to prevent hammering the GitHub API or download server.
- The orchestrator should ignore `startForceUpdate()` calls if already in `downloading` or `verifying` state.

### Disk space insufficient
- `UpdateDownloadService` should check available disk space before downloading (platform-specific APIs or estimate from Content-Length header).
- If insufficient, dialog shows: "Not enough disk space to download the update. Free up [X] MB and try again."

---

## Error Handling

All errors surface in the `ForceUpdateDialog` as the `error` phase. The error message is human-readable and does not expose stack traces or technical details. Errors are logged via `logger.error()` for diagnostics.

| Error Scenario | User-Facing Message | Actions Available |
|---|---|---|
| Network timeout during GitHub API call | "Could not reach the update server." | Retry, Download Manually |
| Network drop during download | "Download interrupted. Check your connection." | Retry, Download Manually |
| HTTP 404 (release artifact not found) | "Update package not found for your platform." | Download Manually |
| HTTP 403 (rate limited) | "Too many requests. Please wait a moment." | Retry (with backoff), Download Manually |
| SHA-256 mismatch | "Downloaded file could not be verified." | Retry, Download Manually |
| Disk full | "Not enough disk space ([X] MB needed)." | Download Manually |
| Updater binary missing | "Update component is missing." | Download Manually |
| Updater binary fails to launch | "Could not start the update installer." | Download Manually |
| Staging directory not writable | "Cannot write to update directory." | Download Manually |

The "Download Manually" fallback always opens the GitHub Releases page for the latest release, where the user can download the artifact and install it themselves. This ensures there is always a path forward even if the auto-update mechanism is completely broken.

---

## Dependencies

| Dependency | Story | What It Provides |
|---|---|---|
| `UpdateDownloadService` | US-2 | Chunked HTTP download with progress, SHA-256 verification, staging directory management |
| `UpdateOrchestrator` | US-3 | State machine, manifest writing, updater launching, lifecycle coordination |
| `UpdaterLauncher` | US-3 | Process launching for the Go updater binary |
| `UpdatePackageDetector` | US-6 | `isMsix()`, `isSnap()`, `isFlatpak()`, `isMacAppStore()`, `supportsAutoUpdate()` |
| Go updater binary | US-3/Phase 1 | The actual binary that performs file replacement and app relaunch |
| CI checksums | US-2/Phase 2 | `checksums.txt` attached to GitHub Releases for verification |
| Riverpod providers | US-2/US-3 | `updateStateProvider`, `updateDownloadProgressProvider` |

All dependencies must be complete and tested before this story can be implemented. The implementation sequence in the plan (section 9) places this story in Phase 5 (UI), after Phases 1-4 establish the foundation, CI pipeline, download/verify, and updater integration.

---

## Testing Strategy

### Unit tests

1. **ForceUpdateDialog widget tests** (Flutter `testWidgets`):
   - Verify that on non-store desktop platform, "Download and Install" button is rendered (not "Update Now").
   - Verify that on MSIX install, "Update via Microsoft Store" button is rendered.
   - Verify that on Snap install, "Update via Snap Store" button is rendered.
   - Verify that on Flatpak install, "Update via Flathub" button is rendered.
   - Verify that on Mac App Store install, "Update via App Store" button is rendered.
   - Verify that on mobile platform, "Update Now" button is rendered (existing behavior).
   - Verify `isBlocked=true` shows "Version Blocked" title and red icon.
   - Verify `isBlocked=false` shows "Update Required" title and orange icon.
   - Verify `PopScope` prevents back navigation.

2. **ForceUpdateDialog state transition tests**:
   - Mock `UpdateOrchestrator` state transitions and verify the dialog renders the correct phase (downloading, verifying, installing, error).
   - Verify progress bar updates when `updateDownloadProgressProvider` changes.
   - Verify error phase shows both "Retry" and "Download Manually" buttons.
   - Verify "Retry" button calls `startForceUpdate()` on the orchestrator.
   - Verify "Download Manually" button calls `launchUrl()` with the fallback URL.

3. **AttestationInitializer tests**:
   - Verify `_showForceUpdate()` passes `fallbackUrl` to the dialog.
   - Existing tests for version check routing remain valid.

4. **VersionCheckService sunset date tests**:
   - Verify that a version with an expired sunset date returns `updateRequired`.
   - Verify that a version with a future sunset date returns `updateAvailable` (or whichever status is appropriate given the other fields).

### Integration tests

5. **Force update flow integration** (with mocked HTTP):
   - Mock `VersionCheckService` to return `updateRequired`.
   - Mock `UpdateOrchestrator` to simulate the full flow (downloading -> verifying -> ready -> launching).
   - Verify the dialog transitions through all phases without error.
   - Verify that at the `installing` phase, `UpdaterLauncher.launch()` is called.

6. **Error recovery integration**:
   - Mock download failure mid-stream and verify error phase.
   - Mock checksum mismatch and verify error phase.
   - Verify retry triggers a new download attempt.

### Manual testing (per platform)

7. **Windows (ZIP install)**: Set `minimumVersion` above current version on bootstrap server. Verify force update dialog, download, verify, updater launch, and app restart with new version.
8. **Windows (MSIX install)**: Verify dialog shows "Update via Microsoft Store" button, not the download flow.
9. **macOS (DMG install)**: Same as Windows ZIP but on macOS.
10. **macOS (App Store)**: Verify dialog shows "Update via App Store".
11. **Linux (tarball install)**: Same as Windows ZIP but on Linux.
12. **Linux (Snap/Flatpak)**: Verify store buttons.
13. **Error scenarios**: Disconnect network during download, verify retry flow. Remove updater binary, verify "Download Manually" fallback.

### Accessibility testing

14. Verify all dialog states have appropriate semantics labels for screen readers.
15. Verify progress bar has accessible value description (e.g., "Downloading update, 45 percent complete").
16. Verify error messages are announced by screen readers.

---

## Out of Scope

- **Modifying `UpdatePromptDialog`**: The optional update dialog (for `updateAvailable` status) is covered by a separate story (US-8). This story only modifies `ForceUpdateDialog`.
- **Background pre-download for force updates**: Force updates are blocking and immediate. There is no pre-download phase because the user cannot use the app until the update is installed.
- **Auto-install without user action**: Force updates require the user to tap "Download and Install" once. Automatic silent updates are covered by US-4.
- **Updater binary implementation**: The Go updater binary itself is implemented in US-3 / Phase 1. This story only integrates with it from the dialog UI.
- **CI pipeline changes**: The `build-updater` CI job and `checksums.txt` generation are implemented in Phase 2. This story assumes those artifacts are available.
- **Settings UI for update preferences**: The "Updates" section in Settings is covered by US-1 and the plan's section 4.12. This story does not add or modify Settings.
- **Rollback detection or recovery UI**: Covered by US-5.
- **Mobile in-app updates**: Android and iOS have their own in-app update mechanisms (Google Play In-App Updates, iOS App Store). Those are separate from the desktop auto-updater and are not part of Plan 09.
- **Web platform**: The web client does not have an updater. It always loads the latest version from the server.
- **Sunset date countdown notifications**: Showing a countdown before the sunset date (e.g., "3 days until this version stops working") is a nice-to-have that can be added later. This story only handles the case where the sunset date has already passed (treated as `updateRequired`).
