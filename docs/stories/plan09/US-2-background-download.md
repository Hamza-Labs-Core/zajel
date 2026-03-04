# US-2: Background Update Download

## Description

As a desktop user with auto-download enabled, I want the app to download updates in the background so the update is ready to install when I choose.

After the existing `VersionCheckService` determines that an update is available (`updateAvailable` or `updateRequired`), the app should silently begin downloading the appropriate platform artifact from GitHub Releases. The download must be chunked, resumable, and report progress via Riverpod state. When the download completes and passes SHA-256 verification, a subtle badge or indicator appears in the UI signaling that the update is ready. The user is never blocked or interrupted during the download.

---

## Acceptance Criteria

1. **AC-1: Automatic download trigger** -- When `VersionCheckService.checkVersion()` returns `updateAvailable` or `updateRequired` on app start, and the user has "Download updates in background" enabled (SharedPreferences), the download begins without user interaction.

2. **AC-2: Correct artifact selection** -- The service selects the platform-appropriate artifact: `zajel-{version}-windows.zip` on Windows, `zajel-{version}-macos.dmg` on macOS, `zajel-{version}-linux.tar.gz` on Linux.

3. **AC-3: Chunked streaming download** -- The download uses `http.Client().send()` with a `StreamedResponse` to receive the file in chunks, writing each chunk to disk incrementally (not buffered in memory).

4. **AC-4: Progress reporting** -- A Riverpod `StateNotifier` exposes `UpdateDownloadState` containing: download status (idle/downloading/verifying/ready/failed), bytes downloaded, total bytes, and a progress fraction (0.0-1.0). UI components can watch this provider to display progress.

5. **AC-5: Resumable downloads** -- If the download is interrupted (network loss, app restart), the service detects the existing `.partial` file and its byte count, then resumes using an HTTP `Range: bytes={offset}-` header. The service checks the server's `Accept-Ranges` and `ETag` headers to confirm the resource has not changed.

6. **AC-6: SHA-256 verification** -- After download completes, the service fetches `checksums.txt` from the same GitHub Release, parses it for the artifact's expected hash, then computes a streaming SHA-256 hash of the downloaded file. If the hash matches, the download transitions to `ready`. If it mismatches, the `.partial` file is deleted and the state transitions to `failed`.

7. **AC-7: Staging directory** -- Downloaded artifacts are stored in a platform-specific staging directory:
   - Windows: `%LOCALAPPDATA%\Zajel\update-staging\`
   - macOS: `~/Library/Application Support/com.zajel.zajel/update-staging/`
   - Linux: `~/.local/share/zajel/update-staging/`

8. **AC-8: Stale download cleanup** -- On app start, if a staged download exists for a version that is no longer the latest (or the app has already been updated past it), the staging directory is deleted.

9. **AC-9: Existing staged download detection** -- On app start, if a completed and verified download already exists in the staging directory for the target version, the service skips downloading and immediately transitions to `ready`.

10. **AC-10: Subtle ready indicator** -- When the state is `ready`, a subtle badge or banner appears in the UI (e.g., a dot on the Settings icon, a thin banner at the top). The indicator is non-intrusive and does not block any user action.

11. **AC-11: Store/package detection bypass** -- If `UpdatePackageDetector.supportsAutoUpdate()` returns false (MSIX, Snap, Flatpak, Mac App Store), the download service is never activated. No background download occurs.

12. **AC-12: HTTPS only** -- All downloads use HTTPS. No HTTP fallback. The service rejects any non-HTTPS URL.

13. **AC-13: No download on metered connections** -- If a metered/pay-per-use connection is detected (where the platform supports detection), the download does not start automatically. The user can still trigger a manual download.

---

## Technical Context

### What exists today

**VersionCheckService** (`lib/features/attestation/services/version_check_service.dart`):
- Fetches version policy from `GET /attest/versions` on the bootstrap server via `AttestationClient`.
- Returns a `VersionStatus` enum: `upToDate`, `updateAvailable`, `updateRequired`, `blocked`.
- Caches the `VersionPolicy` (contains `minimumVersion`, `recommendedVersion`, `blockedVersions`).
- Called during `AttestationInitializer.initialize()` on app start.

**AttestationInitializer** (`lib/features/attestation/attestation_initializer.dart`):
- Orchestrates startup: version check, attestation registration, anti-tamper checks.
- On `updateAvailable`: shows a dismissable `UpdatePromptDialog` that currently only opens a URL via `url_launcher`.
- On `updateRequired`/`blocked`: shows a blocking `ForceUpdateDialog` that also only opens a URL.

**Riverpod patterns**:
- `app_providers.dart` is a barrel file re-exporting domain-specific provider files.
- Providers use `Provider`, `StateProvider`, `StateNotifierProvider`, `StreamProvider`, and `FutureProvider`.
- `SharedPreferences` is injected via `sharedPreferencesProvider` (overridden at app init with the real instance).
- Settings use `StateNotifierProvider` pattern with SharedPreferences persistence (see `AutoDeleteSettingsNotifier`, `ThemeModeNotifier`).
- Disposable resources call `ref.onDispose()`.

**HTTP client**:
- The app uses the `http` package (not dio). `AttestationClient` wraps `http.Client` with injectable constructor parameter.
- Requests use `.timeout()` for deadline enforcement.
- No existing download-to-file infrastructure.

**Platform paths**:
- `path_provider` package is used throughout: `getApplicationDocumentsDirectory()` for files, `getApplicationSupportDirectory()` for logs.
- File receive service (`FileReceiveService`) writes to `getApplicationDocumentsDirectory()/Zajel/`.
- The `crypto` package (v3.0.5) is already a dependency and provides `sha256`.

**Environment** (`lib/core/config/environment.dart`):
- Compile-time constants via `--dart-define`.
- `Environment.version` / `Environment.fullVersion` for current app version.
- `Environment.isE2eTest` for test mode detection.

### What needs to change

1. **New service**: `UpdateDownloadService` in `lib/features/updater/services/`.
2. **New models**: `UpdateDownloadState`, `UpdateArtifact` in `lib/features/updater/models/`.
3. **New providers**: `updateDownloadServiceProvider`, `updateDownloadStateProvider`, `updateSettingsProvider` in `lib/features/updater/providers/`.
4. **Modified initializer**: `AttestationInitializer` triggers the download service after version check returns `updateAvailable`/`updateRequired` (for desktop only).
5. **New helper**: `UpdatePackageDetector` in `lib/features/updater/services/` to detect MSIX/Snap/Flatpak/MAS.
6. **UI additions**: Subtle ready badge (separate story concern, but this story provides the state).

---

## Implementation Details

### 1. UpdateDownloadService

New file: `lib/features/updater/services/update_download_service.dart`

```dart
class UpdateDownloadService {
  final http.Client _client;
  final Directory _stagingBaseDir;

  // Constructor accepts injectable client and staging dir for testing
  UpdateDownloadService({
    required http.Client client,
    required Directory stagingBaseDir,
  }) : _client = client, _stagingBaseDir = stagingBaseDir;

  /// Download the artifact for the given version and platform.
  /// Emits progress updates via the provided callback.
  /// Supports resumption from a .partial file.
  Future<File> download({
    required UpdateArtifact artifact,
    required void Function(int received, int total) onProgress,
    CancellationToken? cancellationToken,
  }) async { ... }

  /// Verify the downloaded file against a SHA-256 checksum.
  Future<bool> verifyChecksum(File file, String expectedSha256) async { ... }

  /// Clean up stale staging directories.
  Future<void> cleanupStaleDownloads(String currentVersion, String targetVersion) async { ... }

  void dispose() => _client.close();
}
```

**Download flow (inside `download()`):**

1. Create staging directory: `_stagingBaseDir/zajel-{version}-{platform}/`.
2. Determine the local file path: `staging/{artifactFilename}.partial`.
3. Check if `.partial` file exists. If so, get its byte length for resumption offset.
4. Send an HTTP HEAD request to the artifact URL to retrieve `Content-Length`, `Accept-Ranges`, and `ETag`.
5. If resuming and `Accept-Ranges: bytes` is present and ETag matches the stored ETag, set `Range: bytes={offset}-` header.
6. If resuming but the server does not support ranges or the ETag changed, delete the `.partial` file and start fresh.
7. Create a streamed GET request with appropriate headers.
8. Open the `.partial` file in append mode (or create mode if starting fresh).
9. Listen to the response stream. For each chunk:
   - Write the chunk to the file sink.
   - Increment the bytes-received counter.
   - Call `onProgress(received, total)`.
   - Check `cancellationToken` for cancellation.
10. When the stream completes, flush and close the file sink.
11. Rename `.partial` to the final artifact filename (removing the `.partial` suffix).
12. Save the ETag to a `.etag` sidecar file for future resumption validation.

**Key implementation notes:**
- Use `http.Request('GET', uri)` + `_client.send(request)` to get a `StreamedResponse` with access to the byte stream.
- Total bytes = `response.contentLength` from the initial HEAD request (or from `Content-Length` in the GET response).
- Response status 200 means full content; 206 means partial content (resumed).
- Write chunks to an `IOSink` from `file.openWrite(mode: FileMode.append)` to avoid memory accumulation.

### 2. Staging Directory Management

New file: `lib/features/updater/services/staging_directory_service.dart`

```dart
class StagingDirectoryService {
  /// Get the platform-specific staging base directory.
  static Future<Directory> getStagingBaseDir() async {
    if (Platform.isWindows) {
      // %LOCALAPPDATA%\Zajel\update-staging\
      final localAppData = Platform.environment['LOCALAPPDATA']!;
      return Directory('$localAppData\\Zajel\\update-staging');
    } else if (Platform.isMacOS) {
      // ~/Library/Application Support/com.zajel.zajel/update-staging/
      final appSupport = await getApplicationSupportDirectory();
      return Directory('${appSupport.path}/update-staging');
    } else {
      // ~/.local/share/zajel/update-staging/
      final xdgData = Platform.environment['XDG_DATA_HOME']
          ?? '${Platform.environment['HOME']}/.local/share';
      return Directory('$xdgData/zajel/update-staging');
    }
  }
}
```

On macOS, `getApplicationSupportDirectory()` from `path_provider` already returns `~/Library/Application Support/com.zajel.zajel` (matching the bundle ID), so we append `update-staging` to it. On Windows and Linux, we construct the path directly from environment variables to match the plan's specified locations exactly.

The staging directory contains:
```
update-staging/
  zajel-1.2.0-windows.zip           # Downloaded artifact
  zajel-1.2.0-windows.zip.etag      # ETag for resumption validation
  checksums.txt                       # Fetched from GitHub Release
  manifest.json                       # Written later by UpdateOrchestrator (US-3)
```

### 3. SHA-256 Verification Flow

The `crypto` package (already a dependency at v3.0.5) provides `sha256`.

```dart
import 'package:crypto/crypto.dart';

Future<bool> verifyChecksum(File file, String expectedSha256) async {
  final output = AccumulatorSink<Digest>();
  final input = sha256.startChunkedConversion(output);

  final stream = file.openRead();
  await for (final chunk in stream) {
    input.add(chunk);
  }
  input.close();

  final digest = output.events.single;
  return digest.toString() == expectedSha256.toLowerCase();
}
```

The `checksums.txt` file format (generated by CI) is one line per artifact:
```
abc123def456...  zajel-1.2.0-windows.zip
789abc012def...  zajel-1.2.0-macos.dmg
345678901234...  zajel-1.2.0-linux.tar.gz
```

The service fetches `checksums.txt` from the GitHub Release assets, parses it to find the line matching the downloaded artifact filename, and extracts the expected hash.

### 4. Riverpod State Management

New file: `lib/features/updater/models/update_download_state.dart`

```dart
enum DownloadStatus { idle, downloading, verifying, ready, failed }

class UpdateDownloadState {
  final DownloadStatus status;
  final String? targetVersion;
  final int bytesDownloaded;
  final int totalBytes;
  final String? errorMessage;
  final int retryCount;

  const UpdateDownloadState({
    this.status = DownloadStatus.idle,
    this.targetVersion,
    this.bytesDownloaded = 0,
    this.totalBytes = 0,
    this.errorMessage,
    this.retryCount = 0,
  });

  double get progress => totalBytes > 0 ? bytesDownloaded / totalBytes : 0.0;

  UpdateDownloadState copyWith({ ... });
}
```

New file: `lib/features/updater/models/update_artifact.dart`

```dart
class UpdateArtifact {
  final String version;
  final String downloadUrl;       // browser_download_url from GitHub API
  final String fileName;          // e.g., zajel-1.2.0-windows.zip
  final String? checksumsUrl;     // URL to checksums.txt asset
  final int? sizeBytes;           // Content-Length from release metadata

  const UpdateArtifact({ ... });
}
```

New file: `lib/features/updater/providers/update_providers.dart`

```dart
/// User preference: auto-download updates in background.
final autoDownloadUpdatesProvider =
    StateNotifierProvider<AutoDownloadNotifier, bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return AutoDownloadNotifier(prefs);
});

class AutoDownloadNotifier extends StateNotifier<bool> {
  final SharedPreferences _prefs;
  static const _key = 'autoDownloadUpdates';

  AutoDownloadNotifier(this._prefs)
      : super(_prefs.getBool(_key) ?? true); // enabled by default on desktop

  Future<void> setEnabled(bool enabled) async {
    state = enabled;
    await _prefs.setBool(_key, enabled);
  }
}

/// The download state, managed by UpdateDownloadNotifier.
final updateDownloadStateProvider =
    StateNotifierProvider<UpdateDownloadNotifier, UpdateDownloadState>((ref) {
  return UpdateDownloadNotifier(ref);
});

/// The download service instance.
final updateDownloadServiceProvider = Provider<UpdateDownloadService>((ref) {
  final client = http.Client();
  // stagingBaseDir resolved asynchronously at init time, see note below
  ref.onDispose(() => client.close());
  return UpdateDownloadService(client: client, stagingBaseDir: ...);
});
```

Because `getStagingBaseDir()` is asynchronous (it calls `getApplicationSupportDirectory()` on macOS), the provider should use a `FutureProvider` for the staging directory, with the `UpdateDownloadService` depending on it. Alternatively, resolve the staging directory during `AttestationInitializer.initialize()` and pass it into the provider container override, similar to how `sharedPreferencesProvider` is overridden at startup.

**UpdateDownloadNotifier** (in the same file or a separate file):

```dart
class UpdateDownloadNotifier extends StateNotifier<UpdateDownloadState> {
  final Ref _ref;

  UpdateDownloadNotifier(this._ref) : super(const UpdateDownloadState());

  Future<void> startDownload(UpdateArtifact artifact) async {
    state = state.copyWith(
      status: DownloadStatus.downloading,
      targetVersion: artifact.version,
      bytesDownloaded: 0,
      totalBytes: artifact.sizeBytes ?? 0,
    );

    try {
      final service = _ref.read(updateDownloadServiceProvider);
      final file = await service.download(
        artifact: artifact,
        onProgress: (received, total) {
          state = state.copyWith(
            bytesDownloaded: received,
            totalBytes: total,
          );
        },
      );

      // Transition to verifying
      state = state.copyWith(status: DownloadStatus.verifying);

      final checksumOk = await service.verifyChecksum(file, artifact.expectedSha256);
      if (checksumOk) {
        state = state.copyWith(status: DownloadStatus.ready);
      } else {
        await file.delete();
        state = state.copyWith(
          status: DownloadStatus.failed,
          errorMessage: 'Checksum verification failed',
        );
      }
    } catch (e) {
      state = state.copyWith(
        status: DownloadStatus.failed,
        errorMessage: e.toString(),
      );
    }
  }

  void reset() => state = const UpdateDownloadState();
}
```

### 5. Stale Download Cleanup

On app start, after `VersionCheckService` runs and the target version is known:

1. List all subdirectories in the staging base directory.
2. For each subdirectory, extract the version from the directory name (e.g., `zajel-1.1.0-windows` -> `1.1.0`).
3. If the version is less than or equal to the current app version, or if the version does not match the target version from the version policy, delete the entire subdirectory.
4. If a `.partial` file exists for the correct target version, preserve it for resumption.

This runs before `startDownload()` and is synchronous in terms of flow (awaited, but non-blocking to the user since the app is already usable).

### 6. GitHub Releases API Integration

New file: `lib/features/updater/services/update_check_service.dart`

This is distinct from `VersionCheckService` (which queries the bootstrap server). This service queries the GitHub Releases API.

```dart
class GitHubReleaseService {
  static const _repoOwner = 'your-org';  // configured via Environment
  static const _repoName = 'zajel';

  final http.Client _client;

  Future<UpdateArtifact?> fetchLatestArtifact(String targetVersion) async {
    // GET https://api.github.com/repos/{owner}/{repo}/releases/tags/v{version}
    // Parse response JSON for assets array
    // Find the asset matching the current platform filename
    // Find the checksums.txt asset
    // Return UpdateArtifact with downloadUrl, checksumsUrl, sizeBytes
  }
}
```

The GitHub API is rate-limited at 60 requests/hour for unauthenticated access. The service should cache the release metadata for 1 hour in SharedPreferences to avoid repeated calls.

Platform artifact filename selection:
```dart
String _artifactFileName(String version) {
  if (Platform.isWindows) return 'zajel-$version-windows.zip';
  if (Platform.isMacOS) return 'zajel-$version-macos.dmg';
  if (Platform.isLinux) return 'zajel-$version-linux.tar.gz';
  throw UnsupportedError('Unsupported platform');
}
```

---

## Download State Machine

```
                   +--------+
        +--------->|  IDLE  |<---------+
        |          +---+----+          |
        |              |               |
        |   (version check detects     |
        |    update + auto-download    |
        |    enabled + not metered)    |
        |              |               |
        |          +---v----------+    |
        |          | DOWNLOADING  |    |
        |          | bytesDown: N |    |
        |          | totalBytes:M |    |
        |          +---+----------+    |
        |              |               |
        |       (stream complete)      |
        |              |               |
        |          +---v----------+    |
        |          |  VERIFYING   |    |
        |          |  (SHA-256)   |    |
        |          +---+----------+    |
        |              |               |
        |     +--------+--------+      |
        |     |                 |      |
        | (match)          (mismatch)  |
        |     |                 |      |
        |  +--v-----+    +-----v---+  |
        |  | READY   |    | FAILED  +--+
        |  +--+------+    | (retry  |
        |     |           |  count) |
        |     |           +---------+
        |  (app restart       |
        |   with newer        |
        |   version)          |
        +---------------------+
```

**Transitions:**
- `IDLE -> DOWNLOADING`: Triggered by version check result + auto-download preference + not a store install + not on metered connection.
- `DOWNLOADING -> VERIFYING`: All bytes received, stream closed.
- `DOWNLOADING -> FAILED`: Network error, HTTP error status, timeout, disk write error.
- `VERIFYING -> READY`: SHA-256 matches.
- `VERIFYING -> FAILED`: SHA-256 mismatch.
- `FAILED -> DOWNLOADING`: Automatic retry (up to 3 attempts with exponential backoff: 30s, 2min, 10min). Retry uses resumption if `.partial` file exists.
- `FAILED -> IDLE`: Retry count exhausted. User can trigger manual retry from Settings.
- `READY -> IDLE`: On app restart if the staged version is stale.
- Any state -> `IDLE`: User disables auto-download in settings.

---

## Edge Cases

### Network drop mid-download
- The `StreamedResponse` stream emits an error or closes unexpectedly.
- The service catches the error, keeps the `.partial` file on disk, transitions to `FAILED`.
- On retry (automatic or manual), the service detects the `.partial` file and resumes via HTTP Range.

### Disk space insufficient
- Before starting the download, check available disk space using `dart:io` `FileStat` and the `Content-Length` from the HEAD request.
- If free space is less than 2x the artifact size (to account for extraction in US-3), do not start the download. Transition to `FAILED` with a descriptive error message ("Insufficient disk space").
- Note: Dart's `dart:io` does not provide a direct free-space API. Use `Process.run('df', ...)` on macOS/Linux, or `Process.run('wmic', ['logicaldisk', ...])` on Windows to check free space. Wrap in a helper with graceful fallback (proceed with download if the check fails).

### Metered connections
- On Windows: `connectivity_plus` can detect metered status. If metered, skip automatic download but allow manual trigger.
- On macOS/Linux: Metered detection is unreliable. Default to allowing the download. Document this limitation.
- The preference "Download updates in background" serves as a user-level override. If disabled, no automatic download regardless of connection type.

### Corrupted partial download
- If the `.partial` file exists but is corrupted (e.g., power loss during write), the resumed download will fail SHA-256 verification.
- On verification failure, delete the entire `.partial` file and retry from scratch (byte 0). This counts as one retry attempt.

### GitHub API unavailable
- If the GitHub Releases API returns an error or times out (15s), transition to `FAILED` with "Could not reach update server".
- The version check (bootstrap) may succeed while the artifact fetch (GitHub) fails. Handle independently.

### ETag changed between resume attempts
- If the server returns a different ETag than the stored one (indicating the release asset was re-uploaded), the `.partial` file is invalid.
- Delete the `.partial` file and restart the download from byte 0.

### Multiple app instances
- Use a `.lock` file in the staging directory to prevent concurrent downloads from multiple app instances.
- If the lock file exists and the PID in it is still running, skip the download in this instance.
- If the PID is dead, remove the stale lock and proceed.

### App closed during download
- The download is in-process (no background isolate). When the app closes, the stream stops and the `.partial` file remains on disk.
- On next app start, the download resumes from the `.partial` file.

### GitHub Release has no checksums.txt
- If `checksums.txt` is not found in the release assets, treat the download as unverifiable.
- Transition to `FAILED` with "Integrity check unavailable". Do not proceed to `READY` without verification.
- This forces CI to always publish `checksums.txt`. Any release missing it is considered broken.

---

## Error Handling Strategy

| Error | Handling | User Impact |
|---|---|---|
| Network timeout (connect) | Retry with backoff, max 3 attempts | None unless all retries fail; then badge shows error in Settings |
| Network error mid-download | Keep `.partial`, retry with resume | None; download continues on next attempt |
| HTTP 404 (artifact not found) | Fail immediately, no retry | Error in Settings: "Update package not found" |
| HTTP 403/429 (rate limited) | Retry after `Retry-After` header value or 1 hour | None; silent delay |
| HTTP 5xx (server error) | Retry with backoff, max 3 attempts | None unless persistent |
| Disk full | Fail immediately, no retry | Error in Settings: "Insufficient disk space" |
| SHA-256 mismatch | Delete `.partial`, retry from scratch (counts as 1 attempt) | None unless all retries fail |
| `checksums.txt` missing | Fail immediately | Error in Settings: "Cannot verify update integrity" |
| File system permission error | Fail immediately | Error in Settings: "Cannot write to staging directory" |
| GitHub API parsing error | Fail immediately | Error in Settings: "Update information unavailable" |

All errors are logged via `LoggerService` with tag `'UpdateDownload'`. No errors are surfaced as dialogs or popups -- they are only visible in Settings > Updates and in log files.

---

## Dependencies

### Upstream (must exist before this story)
- **US-1 (Manual Update Check)**: Provides `GitHubReleaseService` for querying GitHub Releases API and the `UpdateArtifact` model. If US-1 is not yet implemented, this story must include that service.
- **CI: checksums.txt generation**: The release workflow must produce a `checksums.txt` file attached to each GitHub Release. Without this, verification cannot pass.
- **`UpdatePackageDetector`**: Needed to determine if auto-update is supported. May be implemented as part of this story or as a shared foundation story.

### Downstream (depends on this story)
- **US-3 (User-Confirmed Install)**: Reads the staged download and launches the updater binary.
- **US-4 (Automatic Silent Update)**: Watches the `ready` state to trigger auto-install.

### Package dependencies (already in pubspec.yaml)
- `http: ^1.2.0` -- Streamed HTTP downloads.
- `crypto: ^3.0.5` -- SHA-256 hashing.
- `path_provider: ^2.1.5` -- Platform directory resolution (macOS).
- `shared_preferences: ^2.5.3` -- Persisting auto-download preference and GitHub API cache.
- `flutter_riverpod: ^2.6.1` -- State management.

### No new package dependencies required
The `http` package's `StreamedResponse` provides chunked download with progress tracking. There is no need to add `dio` or `background_downloader`. Keeping the dependency footprint minimal is consistent with the project's existing approach.

---

## Testing Strategy

### Unit Tests

**File: `test/unit/updater/update_download_service_test.dart`**

1. **Successful full download**: Mock `http.Client` returns a `StreamedResponse` with status 200 and a byte stream. Assert that the file is written to the correct path, bytes match, and the `.partial` file is renamed.
2. **Resumable download**: Create a `.partial` file with N bytes. Mock client returns 206 with remaining bytes. Assert the `Range` header is sent and the final file contains all bytes.
3. **ETag validation on resume**: Create `.partial` + `.etag` files. Mock HEAD returns a different ETag. Assert the `.partial` file is deleted and download restarts from 0.
4. **Server does not support Range**: Mock HEAD response without `Accept-Ranges`. Assert the `.partial` file is deleted and full download starts.
5. **Network error mid-stream**: Mock stream that emits an error after N bytes. Assert state transitions to `FAILED` and `.partial` file has N bytes.
6. **SHA-256 verification pass**: Write a file with known content. Assert `verifyChecksum` returns true for the correct hash.
7. **SHA-256 verification fail**: Assert `verifyChecksum` returns false for an incorrect hash.
8. **Checksums.txt parsing**: Test parsing of the `checksums.txt` format: `{hash}  {filename}` with various whitespace patterns.
9. **Stale download cleanup**: Create staging dirs for versions 1.0.0 and 1.1.0. Current version is 1.1.0, target is 1.2.0. Assert 1.0.0 and 1.1.0 dirs are deleted.
10. **Existing complete download detected**: Create a staging dir with the target artifact (no `.partial` suffix). Assert the service skips download and returns `ready`.

**File: `test/unit/updater/update_download_state_test.dart`**

11. **Progress calculation**: `UpdateDownloadState(bytesDownloaded: 50, totalBytes: 100).progress` == 0.5.
12. **Zero total bytes**: `progress` returns 0.0 when `totalBytes` is 0 (avoids division by zero).

**File: `test/unit/updater/update_package_detector_test.dart`**

13. **MSIX detection**: Test with a path containing `WindowsApps`.
14. **Snap detection**: Test with `SNAP` environment variable set.
15. **Flatpak detection**: Test with `FLATPAK_ID` environment variable set.
16. **Mac App Store detection**: Test with receipt file present.
17. **Normal install**: Test that `supportsAutoUpdate()` returns true for standard paths.

**File: `test/unit/updater/update_providers_test.dart`**

18. **AutoDownloadNotifier persistence**: Set enabled/disabled, create new notifier with same SharedPreferences, assert value persisted.
19. **UpdateDownloadNotifier state transitions**: Mock the service, call `startDownload()`, assert state transitions through `downloading -> verifying -> ready`.
20. **UpdateDownloadNotifier failure**: Mock service to throw, assert state transitions to `failed` with error message.

### Integration Tests (manual, per-platform)

- Start the app with a version below recommended. Verify download starts in background.
- Kill the app mid-download. Restart. Verify download resumes (check `.partial` file size increases, not restarting from 0).
- Disconnect network mid-download. Reconnect. Verify retry occurs.
- Tamper with the downloaded artifact. Verify SHA-256 check fails and download retries.
- Run on MSIX/Snap install. Verify no background download occurs.

### Test utilities

Use `http_testing.MockClient` (already used in `version_check_service_test.dart`) for mocking HTTP responses. Use `dart:io`'s `Directory.systemTemp.createTempSync()` for staging directory isolation in tests.

---

## Out of Scope

- **Extraction of downloaded artifact** -- US-3 handles extracting ZIP/DMG/tarball to the staging directory.
- **Writing `manifest.json`** -- US-3 writes the manifest before launching the updater.
- **Launching the updater binary** -- US-3 handles updater invocation.
- **UI for download progress display** -- A separate UI task. This story provides the Riverpod state; the UI consumes it.
- **Auto-install when idle** -- US-4 handles the automatic install trigger.
- **Updater binary (Go)** -- Separate story for the Go binary implementation.
- **CI pipeline changes** -- Separate story for `build-updater` job and `checksums.txt` generation.
- **Periodic re-checking for new versions** -- US-1 handles periodic/manual version checks. This story only reacts to the result.
- **Download progress notification (OS-level)** -- Desktop notifications for download progress are out of scope. Only in-app state.
- **Concurrent/parallel chunk downloads** -- Single-stream sequential download is sufficient. Parallel chunks add complexity with minimal benefit for typical update sizes (~50 MB).

---

## File Organization

```
packages/app/lib/features/updater/
  models/
    update_download_state.dart     # DownloadStatus enum, UpdateDownloadState
    update_artifact.dart           # UpdateArtifact model
  services/
    update_download_service.dart   # Chunked download, resume, verify
    staging_directory_service.dart # Platform-specific staging paths
    github_release_service.dart    # GitHub Releases API client
    update_package_detector.dart   # MSIX/Snap/Flatpak/MAS detection
  providers/
    update_providers.dart          # Riverpod providers and notifiers

packages/app/test/unit/updater/
    update_download_service_test.dart
    update_download_state_test.dart
    update_package_detector_test.dart
    update_providers_test.dart
```
