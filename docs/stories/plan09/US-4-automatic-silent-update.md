# US-4: Automatic Silent Update

## Description

As a desktop user who opted into automatic updates, I want the app to update itself when idle so that I always run the latest version without manual intervention.

When automatic updates are enabled and a verified update has been staged (downloaded + SHA-256 verified), the app should detect an idle state -- no active VoIP calls, no file transfers in progress, and the user has been inactive for a configurable period -- and then either apply the update immediately (if safe) or queue it for application on the next restart.

This story builds on US-2 (Background Update Download) and US-3 (User-Confirmed Update Install). Where US-3 requires explicit user action to trigger the updater, US-4 removes that manual step for users who opt in, while preserving all safety guarantees.

---

## Acceptance Criteria

### Core Behavior

1. **AC-1**: A new toggle "Install updates automatically (when idle)" appears in Settings > Updates on desktop platforms only (Windows, macOS, Linux). The toggle is disabled by default.
2. **AC-2**: The toggle is only interactive when "Download updates in background" is also enabled. If background download is disabled, the auto-install toggle is grayed out with explanatory text.
3. **AC-3**: When auto-install is enabled and the update state machine reaches READY (verified staged download), the app begins monitoring for idle conditions.
4. **AC-4**: The app considers itself "idle" when ALL of the following are true simultaneously:
   - No active VoIP call (VoIPService `state == CallState.idle`)
   - No file transfers in progress (FileReceiveService `activeTransfers` is empty with no `receiving` status entries)
   - No outbound file sends in progress (no pending chunked sends on any WebRTC file data channel)
   - The user has not interacted with the app (keyboard, mouse, touch) for at least 5 minutes
   - The app window is not focused (AppLifecycleState is `inactive`, `hidden`, or `paused`) OR the idle timer has reached 15 minutes regardless of focus state
5. **AC-5**: When idle conditions are met, the app shows a system notification: "Zajel is updating to version X.Y.Z. The app will restart shortly." The notification appears at least 10 seconds before the updater launches.
6. **AC-6**: After the 10-second grace period, the app writes the update manifest (including `app_pid`), launches the updater binary, and exits gracefully.
7. **AC-7**: If the user interacts with the app (brings it to foreground, moves mouse, types, starts a call, initiates a file transfer) during the 10-second grace period, the auto-install is aborted and deferred. The app shows a brief snackbar: "Update deferred -- will install when you're idle again."
8. **AC-8**: If the user starts an operation (call, file transfer) after idle detection began but before the grace period, auto-install is aborted immediately with no restart.
9. **AC-9**: On the next app restart (manual quit and relaunch), if a verified staged update exists and auto-install is enabled, the app applies the update during shutdown without requiring idle detection ("install on restart" path).
10. **AC-10**: The auto-install preference is persisted via SharedPreferences under the key `autoInstallUpdates` (boolean, default `false`).

### Safety Guards

11. **AC-11**: The updater is NEVER launched while a VoIP call is active (`VoIPService.hasActiveCall == true`), regardless of idle timer state.
12. **AC-12**: The updater is NEVER launched while any file transfer has `status == FileTransferStatus.receiving`.
13. **AC-13**: The updater is NEVER launched if the network connection is detected as metered (on platforms that support metered detection -- primarily Windows). On platforms without metered detection APIs (most Linux desktops, macOS), this check is skipped.
14. **AC-14**: If the update state machine transitions to FAILED at any point, the idle monitoring stops and does not resume until a new READY state is reached.
15. **AC-15**: Auto-install is disabled for store-managed installations (MSIX, Snap, Flatpak, Mac App Store) as detected by `UpdatePackageDetector.supportsAutoUpdate()`.

### User Transparency

16. **AC-16**: When auto-install is enabled and an update is staged, the Settings > Updates section shows: "Update X.Y.Z ready -- will install when idle."
17. **AC-17**: After a successful silent update and app relaunch, a snackbar or banner on the home screen shows: "Zajel updated to version X.Y.Z" for 10 seconds.
18. **AC-18**: If auto-install was attempted but the updater failed (rollback occurred), the app shows a persistent banner: "Update to X.Y.Z failed. You can try again from Settings > Updates."

---

## Technical Context

### What Exists Today

- **VersionCheckService** (`lib/features/attestation/`) checks the bootstrap server for version policy. Returns `VersionStatus.updateAvailable` or `VersionStatus.updateRequired`.
- **AttestationInitializer** shows `UpdatePromptDialog` (dismissable) or `ForceUpdateDialog` (blocking) based on version status. Currently only opens a URL via `url_launcher` -- no in-app download or self-update.
- **SharedPreferences** pattern is well-established. Settings are stored via `StateNotifierProvider` backed by `SharedPreferences` (see `AutoDeleteSettingsNotifier`, `PrivacyScreenNotifier`, `ThemeModeNotifier` in `settings_providers.dart` and `preferences_providers.dart`).
- **App lifecycle tracking** exists in `main.dart`: `_ZajelAppState` extends `WidgetsBindingObserver` and updates `appInForegroundProvider` on `didChangeAppLifecycleState`. States tracked: `resumed`, `inactive`, `paused`, `hidden`, `detached`.
- **VoIPService** (`core/network/voip_service.dart`) exposes `hasActiveCall` (bool) and `state` (CallState enum: `idle`, `outgoing`, `incoming`, `connecting`, `connected`, `ended`).
- **FileReceiveService** (`core/storage/file_receive_service.dart`) tracks in-progress transfers via `_activeTransfers` map. Exposes `activeTransfers` (list) and `transferUpdates` (stream). Each `FileTransfer` has a `status` field (`receiving`, `complete`, `failed`).
- **WebRTCService** (`core/network/webrtc_service.dart`) maintains `_connections` map of active WebRTC peer connections. No public getter for connection count exists -- one must be added.
- **ConnectionManager** (`core/network/connection_manager.dart`) exposes `currentPeers` (List<Peer>) where each `Peer` has a `connectionState` (enum: `disconnected`, `discovering`, `connecting`, `handshaking`, `connected`, `failed`).
- **Riverpod providers** for all of the above are defined in `core/providers/` (barrel-exported via `app_providers.dart`).
- **settings_screen.dart** uses a `_buildSection()` helper pattern with `Card` widgets containing `ListTile` and `SwitchListTile` items. Desktop detection uses `Platform.isWindows || Platform.isLinux || Platform.isMacOS`.

### What Needs to Change

1. **New preferences**: `autoInstallUpdates` (bool) and `autoCheckUpdates` (bool), `autoDownloadUpdates` (bool) added to SharedPreferences with corresponding Riverpod `StateNotifierProvider`s.
2. **New service**: `IdleDetectionService` that monitors user activity, app lifecycle, and active operations to determine idle state.
3. **New provider**: `appIdleStateProvider` that combines signals from `appInForegroundProvider`, `VoIPService.state`, `FileReceiveService.activeTransfers`, and user input timers.
4. **Update state machine integration**: The READY state (from US-2/US-3's `UpdateOrchestrator`) triggers idle monitoring when auto-install is enabled.
5. **WebRTCService**: Add a public getter `int get activeConnectionCount => _connections.length;` or `bool get hasActiveConnections => _connections.isNotEmpty;`.
6. **"Install on restart" hook**: Wire into `_ZajelAppState.didChangeAppLifecycleState` for `AppLifecycleState.detached` to check for staged updates.

---

## Implementation Details

### 1. Settings Preferences

Add to `lib/features/updater/providers/update_settings_providers.dart`:

```dart
/// Whether to automatically install updates when idle.
/// Default: false (opt-in). Only effective on desktop platforms.
final autoInstallUpdatesProvider =
    StateNotifierProvider<AutoInstallUpdatesNotifier, bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return AutoInstallUpdatesNotifier(prefs);
});

class AutoInstallUpdatesNotifier extends StateNotifier<bool> {
  final SharedPreferences _prefs;
  static const _key = 'autoInstallUpdates';

  AutoInstallUpdatesNotifier(this._prefs)
      : super(_prefs.getBool(_key) ?? false);

  Future<void> setEnabled(bool enabled) async {
    state = enabled;
    await _prefs.setBool(_key, enabled);
  }
}
```

Follow the same `StateNotifierProvider` + `SharedPreferences` pattern used by `AutoDeleteSettingsNotifier` and `PrivacyScreenNotifier`.

### 2. Idle Detection Logic

Create `lib/features/updater/services/idle_detection_service.dart`:

The service must aggregate multiple signals:

**Signal A -- User input inactivity timer:**
- Track last user interaction timestamp (keyboard, mouse move, touch).
- On Flutter desktop, use `HardwareKeyboard.instance` for keyboard events and `Listener` widget wrapping the root `MaterialApp` for pointer events.
- The idle threshold is 5 minutes (configurable via constant `kUserIdleThreshold`).

**Signal B -- App focus state:**
- Read from `appInForegroundProvider` (already tracked in `main.dart`).
- "Unfocused" means `AppLifecycleState` is `inactive`, `hidden`, or `paused`.
- Note the known Flutter desktop limitation: `didChangeAppLifecycleState` does not reliably fire on focus changes for all desktop platforms. As a fallback, the 15-minute absolute idle timer (Signal A) overrides the focus requirement.

**Signal C -- No active operations:**
- `VoIPService.hasActiveCall == false`
- `FileReceiveService.activeTransfers` has no entries with `status == FileTransferStatus.receiving`
- No outbound file sends in progress (track via a new `isSendingFile` flag on `WebRTCService` or `ConnectionManager`, set `true` during `sendFile()` and `false` on completion)

**Combined idle state:**
```
isIdle = (Signal_A >= 5min) AND Signal_C AND (Signal_B == unfocused OR Signal_A >= 15min)
```

The service should poll every 30 seconds when an update is in READY state, rather than running continuously. It subscribes to the update state provider and only activates monitoring when READY + auto-install enabled.

### 3. Auto-Install Trigger Conditions

All of the following must be true before launching the updater:

| # | Condition | Source |
|---|-----------|--------|
| 1 | Auto-install preference enabled | `autoInstallUpdatesProvider` |
| 2 | Update state is READY | `updateStateProvider` (from US-2/US-3) |
| 3 | Platform supports auto-update | `UpdatePackageDetector.supportsAutoUpdate()` |
| 4 | No active VoIP call | `voipServiceProvider?.hasActiveCall != true` |
| 5 | No file transfers receiving | `fileReceiveServiceProvider.activeTransfers` empty or all non-receiving |
| 6 | User idle >= 5 minutes | `IdleDetectionService.userIdleDuration` |
| 7 | App unfocused OR user idle >= 15 min | `appInForegroundProvider` + idle timer |
| 8 | Not on metered connection (if detectable) | Platform-specific check |
| 9 | Grace period (10s) completed without user interruption | Timer within `IdleDetectionService` |

### 4. "Install on Next Restart" Alternative Path

When auto-install is enabled and a staged update is READY, but the user is never idle long enough:

- On `AppLifecycleState.detached` (app closing), check if a verified staged update exists.
- If yes, launch the updater binary before the process fully exits.
- The updater waits for the app PID to exit (standard flow from plan section 4.4), then applies the update.
- On next launch, the user sees the updated version with a "Updated to X.Y.Z" banner.

Implementation: In `_ZajelAppState.didChangeAppLifecycleState`, when `state == AppLifecycleState.detached`:

```dart
if (state == AppLifecycleState.detached && !_disposed) {
  // Check for pending auto-install update
  final autoInstall = ref.read(autoInstallUpdatesProvider);
  final updateState = ref.read(updateStateProvider);
  if (autoInstall && updateState == UpdateState.ready) {
    // Launch updater synchronously before process exits
    ref.read(updaterLauncherProvider).launchOnShutdown();
  }
  _disposed = true;
  _disposeServicesSync();
}
```

### 5. Integration with Update State Machine (US-2/US-3)

The state machine defined in plan section 5 has these states: `IDLE -> CHECKING -> DOWNLOADING -> VERIFYING -> READY -> LAUNCHING_UPDATER`.

US-4 adds an intermediate behavior between READY and LAUNCHING_UPDATER:

```
READY
  |
  +-- (auto-install disabled) --> wait for user click (US-3)
  |
  +-- (auto-install enabled) --> WAITING_FOR_IDLE
                                    |
                                    +-- (idle detected) --> GRACE_PERIOD (10s countdown)
                                    |                          |
                                    |                          +-- (user interrupts) --> WAITING_FOR_IDLE
                                    |                          |
                                    |                          +-- (grace completes) --> LAUNCHING_UPDATER
                                    |
                                    +-- (app closing) --> LAUNCHING_UPDATER (install-on-restart)
```

New states to add to `UpdateState` enum:
- `waitingForIdle` -- update is ready, monitoring for idle conditions
- `gracePeriod` -- idle detected, 10-second countdown before launch

### 6. User Notification Before/After Silent Update

**Before (grace period):**
- Show a system-level notification (not in-app toast) using the platform notification service: "Zajel is updating to version X.Y.Z. The app will restart shortly."
- On desktop, use the existing notification infrastructure or `flutter_local_notifications` to send an OS-level notification that remains visible even if the app is unfocused.

**After (post-update relaunch):**
- On app start, read `update-result.json` written by the updater binary (plan section 4.4).
- If `status == "verified"` and `app_version_current` differs from the previous version stored in SharedPreferences (`lastKnownVersion`), show a snackbar on the home screen: "Zajel updated to version X.Y.Z".
- Persist `lastKnownVersion` after showing the message to avoid showing it again.

---

## Idle Detection Strategy

### Architecture

```
+-----------------------------------------------------+
|  IdleDetectionService                                |
|                                                      |
|  Inputs:                                             |
|    - Pointer/keyboard event stream (user activity)   |
|    - appInForegroundProvider (focus state)            |
|    - VoIPService.hasActiveCall                        |
|    - FileReceiveService.activeTransfers               |
|    - ConnectionManager.currentPeers (connected count) |
|                                                      |
|  Output:                                             |
|    - Stream<IdleState> (active / idle / deep_idle)   |
|    - IdleState.idle: >= 5 min no input + unfocused   |
|    - IdleState.deepIdle: >= 15 min no input          |
|                                                      |
|  Internal:                                           |
|    - Timer polling every 30 seconds                  |
|    - Resets on any user input event                  |
|    - Pauses when no update is in READY state         |
+-----------------------------------------------------+
```

### User Activity Detection on Desktop

Since Flutter desktop does not have a built-in "system idle" API, activity must be tracked at the application level:

1. **Pointer events**: Wrap the root widget with a `Listener(onPointerDown: ..., onPointerMove: ..., onPointerSignal: ...)` to capture all mouse/touch events. Update `_lastActivityTimestamp` on each event.

2. **Keyboard events**: Register a `HardwareKeyboard` listener via `HardwareKeyboard.instance.addHandler(...)`. Update `_lastActivityTimestamp` on each key event.

3. **Scroll events**: Captured by `Listener.onPointerSignal` (scroll events generate `PointerSignalEvent`).

4. **Limitations**: This only detects activity within the Zajel app window. If the user is active in other applications but Zajel is in the background, the idle timer will still count down. This is acceptable because the app-unfocused condition (Signal B) provides additional safety, and the 10-second grace period with user-interrupt detection catches edge cases.

### Metered Connection Detection

| Platform | Method | Reliability |
|----------|--------|-------------|
| Windows | `NetworkInformation.IsMetered` via win32 API / `connectivity_plus` plugin | High -- Windows exposes metered flag per connection |
| macOS | Not natively exposed. Could check Wi-Fi vs cellular via `NWPathMonitor` but macOS desktops rarely have cellular | Low -- skip check, always allow |
| Linux | GNOME `NetworkManager` D-Bus API exposes `Metered` property. KDE/other DEs may not. | Medium -- check if available, skip if not |

When metered detection is unavailable or the check fails, the auto-install proceeds (fail open). The download itself (US-2) is the bandwidth-intensive part; the install is local only.

---

## Edge Cases

### E-1: User starts a call during the 10-second grace period
- The grace period timer monitors `VoIPService.state` every second.
- If state changes from `idle` to any other value, abort immediately.
- Cancel the grace timer, show "Update deferred" snackbar, return to `waitingForIdle`.

### E-2: File transfer begins during idle monitoring
- The `IdleDetectionService` checks `FileReceiveService.activeTransfers` on every 30-second poll.
- If any transfer has `status == receiving`, the idle state evaluates to `active` and the auto-install is not triggered.

### E-3: Network drops during the install-on-restart path
- Not a concern: the install is entirely local (files already downloaded and staged). No network needed.

### E-4: App is force-killed during the grace period
- The updater was not yet launched, so no update occurs.
- On next app start, the staged update is still present and the flow restarts from READY.

### E-5: Multiple rapid version releases while waiting for idle
- If a newer version becomes available while waiting for idle on version X, the orchestrator should cancel the current staged update, download the newer version, re-verify, and re-enter READY. The idle detection resets for the new version.

### E-6: System goes to sleep during grace period
- On wake, `didChangeAppLifecycleState` fires `resumed`. This counts as user activity, aborting the grace period. The idle timer restarts.

### E-7: User disables auto-install while in grace period
- Changing the `autoInstallUpdatesProvider` to `false` immediately cancels any active grace period and stops idle monitoring. The update remains in READY state for manual install (US-3 flow).

### E-8: Updater binary missing or corrupt at install time
- Before launching the updater, verify the binary exists at the expected external location (section 4.8 of the plan).
- If missing, attempt to re-extract from the staged update.
- If still missing or checksum fails, transition to FAILED state, log the error, and show a notification: "Auto-update failed. Please update manually from Settings."

### E-9: Two instances of the app running
- Check for a `update-in-progress.lock` file before launching the updater. If the lock exists, another instance may be updating. Do not proceed.

---

## Error Handling

| Error | Handling |
|-------|----------|
| Idle detection timer fails to fire | Use `Timer.periodic` with a watchdog. If the timer does not fire for 2x the expected interval, recreate it. |
| `appInForegroundProvider` not updating on desktop | Known Flutter limitation. Fall back to the 15-minute absolute idle timer (Signal A override). |
| VoIPService provider is null (signaling not connected) | Treat as "no active call" -- safe to proceed. |
| FileReceiveService throws during `activeTransfers` check | Catch exception, treat as "transfers active" (fail safe -- do not install). |
| Updater launch fails (process start error) | Log error, transition to FAILED state, show notification. Do not retry automatically -- let the user trigger manually via US-3. |
| `update-result.json` indicates rollback after silent update | On next app start, show persistent banner: "Update to X.Y.Z failed and was rolled back. You are running version A.B.C." Disable auto-install for this specific version to prevent retry loops. |
| SharedPreferences write fails when persisting preference | Catch error, keep in-memory state, log warning. Retry on next app lifecycle event. |

---

## Dependencies

| Dependency | Story | What It Provides |
|------------|-------|-----------------|
| US-2 | Background Update Download | The READY state with a verified staged download. Without US-2, there is nothing to auto-install. |
| US-3 | User-Confirmed Update Install | The `UpdateOrchestrator` state machine, `UpdaterLauncher`, manifest writing, and updater binary integration. US-4 reuses all of this machinery -- it only differs in what triggers the READY -> LAUNCHING_UPDATER transition. |
| US-1 | Manual Update Check | The Settings > Updates section UI structure where the auto-install toggle will be placed. |

US-4 cannot be implemented until US-2 and US-3 are complete. US-1 should be done first for the Settings UI scaffold.

---

## Testing Strategy

### Unit Tests

1. **AutoInstallUpdatesNotifier**: Verify default is `false`, persists to SharedPreferences on toggle, loads persisted value on construction.

2. **IdleDetectionService**:
   - Verify `isIdle` returns `false` when user activity is recent (< 5 min).
   - Verify `isIdle` returns `true` when user inactive >= 5 min AND app unfocused AND no active operations.
   - Verify `isIdle` returns `true` when user inactive >= 15 min regardless of focus state (deep idle).
   - Verify `isIdle` returns `false` when a VoIP call is active, regardless of inactivity duration.
   - Verify `isIdle` returns `false` when file transfers are in `receiving` state.
   - Verify idle timer resets on simulated user input event.
   - Verify monitoring stops when update state leaves READY.
   - Verify monitoring stops when auto-install preference is toggled off.

3. **Grace period logic**:
   - Verify grace period starts after idle detected.
   - Verify grace period aborts on simulated user activity.
   - Verify grace period aborts when a VoIP call starts.
   - Verify grace period aborts when a file transfer starts.
   - Verify updater is launched after grace period completes without interruption.

4. **Install-on-restart**:
   - Verify updater is launched when `AppLifecycleState.detached` fires with a staged update and auto-install enabled.
   - Verify updater is NOT launched on detached when auto-install is disabled.
   - Verify updater is NOT launched on detached when no staged update exists.

### Integration Tests

5. **Settings UI**: Verify the auto-install toggle appears only on desktop, is disabled when auto-download is off, persists state across Settings screen rebuilds.

6. **State machine integration**: Verify the transition READY -> waitingForIdle -> gracePeriod -> launchingUpdater with mocked idle conditions.

7. **Post-update banner**: Verify "Updated to X.Y.Z" banner shows on app start when `update-result.json` contains a successful result with a version change.

### Manual Testing (per platform)

8. **Windows**: Verify idle detection while app is minimized to tray. Verify install-on-restart when closing via window X button. Verify metered connection detection blocks auto-install.

9. **macOS**: Verify idle detection when app loses focus. Verify install-on-restart from Cmd+Q. Verify Mac App Store builds do not show the toggle.

10. **Linux**: Verify idle detection under both X11 and Wayland. Verify Snap/Flatpak builds hide the toggle.

---

## Out of Scope

- **System-level idle detection** (OS screensaver state, global mouse/keyboard monitoring): Requires platform-specific native plugins and raises privacy concerns. Application-level idle detection is sufficient for this use case.
- **Scheduled update windows** (e.g., "only update between 2 AM and 5 AM"): This is a future enhancement. US-4 covers immediate idle-based installation only.
- **Delta/differential updates**: Full artifact replacement only. Differential updates are a separate optimization story.
- **Mobile platforms**: Auto-update is desktop-only. Mobile uses platform app stores.
- **Bandwidth throttling during download**: Download behavior is US-2's concern. US-4 only handles the install trigger.
- **Multi-user desktop environments**: The updater operates within the current user's install directory. System-wide installations (e.g., `/usr/bin/`) require elevated permissions and are out of scope.
- **Update channels** (beta, stable, nightly): All users receive the same release channel. Channel selection is a future feature.
- **Rollback UI**: Handled by US-5. US-4 only detects rollback via `update-result.json` and shows informational messages.
