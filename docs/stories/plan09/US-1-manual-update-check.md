# US-1: Manual Update Check (Desktop)

## Description

As a desktop user, I want to check for updates from Settings so I can stay on the latest version.

When I open Settings, I see an "Updates" section (visible only on desktop platforms: Windows, macOS, Linux). This section shows my current version and provides a "Check Now" button. When I press "Check Now", the app queries the GitHub Releases API for the latest release and shows me one of three outcomes: I am already up to date, an update is available (with version details), or the check failed (with a retry option).

This story builds on the existing `VersionCheckService` / `VersionPolicy` infrastructure, which checks the bootstrap server's `/attest/versions` endpoint. The new capability adds a **second check** that queries GitHub Releases directly for artifact-level details (download URLs, version tags, release notes). The bootstrap check tells us _whether_ to update; the GitHub Releases check tells us _what_ is available to download.

---

## Acceptance Criteria

1. **Desktop-only visibility**: The "Updates" section appears in Settings only when `Platform.isWindows || Platform.isMacOS || Platform.isLinux`. It is never shown on Android or iOS.

2. **Current version display**: The section always shows the current app version (from `Environment.version` / `Environment.fullVersion`).

3. **"Check Now" button**: Pressing the button initiates a version check. While checking, the button is replaced by a `CircularProgressIndicator` and the text "Checking for updates...".

4. **Up-to-date result**: When the current version is equal to or greater than the latest GitHub release tag, the UI shows a green checkmark icon and the text "You're up to date" with a subtitle showing when the last check was performed (e.g., "Last checked: just now").

5. **Update available result**: When a newer version exists on GitHub Releases, the UI shows:
   - The available version number (e.g., "Version 1.2.0 available")
   - A brief summary from the release body (first 200 characters, stripped of markdown)
   - The release publication date
   - No download/install button yet (out of scope for US-1; that is US-2/US-3)

6. **Error result**: When the check fails (network error, GitHub API rate limit, timeout), the UI shows:
   - A red/warning icon
   - A message: "Could not check for updates"
   - A subtitle with the specific error (e.g., "Network error", "Rate limited - try again in X minutes")
   - A "Retry" button

7. **Rate limit awareness**: The service respects GitHub's unauthenticated rate limit of 60 requests/hour. It uses ETags for conditional requests (304 Not Modified responses do not count against the rate limit). If a 403 with `X-RateLimit-Remaining: 0` is received, the service caches the reset time and prevents further requests until that time.

8. **Response caching**: Successful GitHub API responses are cached in memory for 1 hour. Within that window, "Check Now" returns the cached result immediately (no network request). The UI indicates this is a cached result by showing the original check timestamp in the "Last checked" subtitle.

9. **Store-distributed builds excluded**: On desktop builds distributed via MSIX (Windows Store), Mac App Store, Snap, or Flatpak, the "Updates" section shows "Updates are managed by your system's app store" instead of the check button, with the current version still displayed.

10. **Logging**: All check attempts, results, and errors are logged via `LoggerService` with the tag `UpdateCheck`.

---

## Technical Context

### What Exists Today

| Component | File | Role |
|---|---|---|
| `VersionCheckService` | `lib/features/attestation/services/version_check_service.dart` | Fetches `VersionPolicy` from bootstrap `GET /attest/versions`; returns `VersionStatus` enum (`upToDate`, `updateAvailable`, `updateRequired`, `blocked`). |
| `VersionPolicy` model | `lib/features/attestation/models/version_policy.dart` | Contains `minimumVersion`, `recommendedVersion`, `blockedVersions`, `sunsetDates`. |
| `VersionStatus` enum | Same file as `VersionPolicy` | Four states: `upToDate`, `updateAvailable`, `updateRequired`, `blocked`. |
| `AttestationClient` | `lib/features/attestation/services/attestation_client.dart` | HTTP client wrapping `package:http`; has `fetchVersionPolicy()`. |
| `AttestationInitializer` | `lib/features/attestation/attestation_initializer.dart` | On app start: runs version check, shows `UpdatePromptDialog` or `ForceUpdateDialog`. |
| `UpdatePromptDialog` | `lib/features/attestation/widgets/update_prompt_dialog.dart` | Dismissable dialog with "Later" and "Update" buttons. Currently opens a URL via `url_launcher`. No `updateUrl` is actually passed (always null). |
| `ForceUpdateDialog` | `lib/features/attestation/widgets/force_update_dialog.dart` | Blocking full-screen dialog. Same URL issue. |
| `settings_screen.dart` | `lib/features/settings/settings_screen.dart` | Full settings page with sections: Profile, Appearance, Notifications, Audio & Video, Privacy & Security, External Connections, Debugging, About, Help & Info. No "Updates" section exists. Has `_isDesktop` getter already. |
| `app_providers.dart` | `lib/core/providers/app_providers.dart` | Barrel file re-exporting all provider modules. |
| `attestation_providers.dart` | `lib/features/attestation/providers/attestation_providers.dart` | Riverpod providers: `versionCheckServiceProvider`, `versionCheckProvider` (StateProvider), `versionPolicyProvider` (StateProvider). |
| `Environment` | `lib/core/config/environment.dart` | Compile-time constants via `--dart-define`. Exposes `version`, `fullVersion`, `buildNumber`. |
| Release workflow | `.github/workflows/release.yml` | Builds artifacts named `zajel-{VERSION}-{platform}.{ext}` and creates a GitHub Release via `softprops/action-gh-release`. |

### What Needs to Change

The existing `VersionCheckService` checks the **bootstrap server** for version policy (minimum/recommended versions). This story adds a **new service** (`GitHubReleaseService`) that queries the **GitHub Releases API** for the latest published release. These are complementary:

- Bootstrap version policy = "should you update?" (governance)
- GitHub Releases API = "what's the latest version and where to get it?" (discovery)

For US-1, only the GitHub Releases query is needed for the Settings UI. The bootstrap check continues to run at app startup as before (unchanged).

---

## Implementation Details

### New Files

#### 1. `lib/features/updater/models/github_release.dart`

Model for a GitHub release.

```dart
class GitHubRelease {
  /// Tag name, e.g., "v1.2.0"
  final String tagName;

  /// Semver version extracted from tag (strips leading "v")
  String get version => tagName.startsWith('v') ? tagName.substring(1) : tagName;

  /// Release title
  final String name;

  /// Release body (markdown)
  final String body;

  /// Whether this is a prerelease
  final bool prerelease;

  /// Whether this is a draft
  final bool draft;

  /// Publication timestamp
  final DateTime publishedAt;

  /// HTML URL for the release page
  final String htmlUrl;

  /// List of attached assets
  final List<GitHubReleaseAsset> assets;

  const GitHubRelease({ ... });

  factory GitHubRelease.fromJson(Map<String, dynamic> json);
}

class GitHubReleaseAsset {
  final String name;
  final String browserDownloadUrl;
  final int size;
  final String contentType;

  const GitHubReleaseAsset({ ... });

  factory GitHubReleaseAsset.fromJson(Map<String, dynamic> json);
}
```

#### 2. `lib/features/updater/models/update_check_result.dart`

Sealed class representing the outcome of a manual update check.

```dart
sealed class UpdateCheckResult {}

class UpdateCheckUpToDate extends UpdateCheckResult {
  final String currentVersion;
  final DateTime checkedAt;
}

class UpdateCheckAvailable extends UpdateCheckResult {
  final String currentVersion;
  final String latestVersion;
  final String releaseName;
  final String releaseNotes;  // First ~200 chars, markdown stripped
  final DateTime publishedAt;
  final String releaseUrl;
  final DateTime checkedAt;
}

class UpdateCheckError extends UpdateCheckResult {
  final String message;
  final bool isRateLimited;
  final DateTime? rateLimitResetsAt;
  final DateTime checkedAt;
}
```

#### 3. `lib/features/updater/services/github_release_service.dart`

Service that queries the GitHub Releases API.

```dart
class GitHubReleaseService {
  static const _tag = 'UpdateCheck';

  /// GitHub owner/repo for release lookups.
  static const owner = 'Hamza-Labs-Core';
  static const repo = 'zajel';

  /// Cache duration for successful responses.
  static const cacheDuration = Duration(hours: 1);

  final http.Client _client;

  // ETag caching
  String? _lastETag;
  GitHubRelease? _cachedRelease;
  DateTime? _lastCheckedAt;

  // Rate limit tracking
  DateTime? _rateLimitResetsAt;

  GitHubReleaseService({http.Client? client})
      : _client = client ?? http.Client();

  /// Fetch the latest non-prerelease, non-draft release.
  ///
  /// Uses conditional requests (If-None-Match with ETag) to avoid
  /// counting against rate limits when the release hasn't changed.
  ///
  /// Returns a cached result if checked within [cacheDuration].
  Future<GitHubRelease> fetchLatestRelease();

  /// Check if an update is available by comparing [currentVersion]
  /// against the latest GitHub release.
  Future<UpdateCheckResult> checkForUpdate(String currentVersion);

  void dispose();
}
```

Key implementation details:
- **Endpoint**: `GET https://api.github.com/repos/Hamza-Labs-Core/zajel/releases/latest`
- **Headers**: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: Zajel-Desktop-Updater`
- **ETag caching**: Store `ETag` from response, send `If-None-Match` on subsequent requests. On `304 Not Modified`, return cached release.
- **Rate limit handling**: Check `X-RateLimit-Remaining` header. If `0`, parse `X-RateLimit-Reset` (Unix epoch) and store it. Block requests until that time.
- **Timeout**: 15 seconds per request.
- **Version comparison**: Reuse `VersionCheckService._compareVersions` logic (extract it to a shared utility or make it public).

#### 4. `lib/features/updater/services/update_package_detector.dart`

Detects whether the current installation supports self-update or is managed by a store.

```dart
class UpdatePackageDetector {
  static bool isMsix() =>
      Platform.isWindows && Platform.resolvedExecutable.contains('WindowsApps');

  static bool isSnap() => Platform.environment.containsKey('SNAP');

  static bool isFlatpak() => Platform.environment.containsKey('FLATPAK_ID');

  static bool isMacAppStore() =>
      Platform.isMacOS &&
      File('${_appBundlePath()}/Contents/_MASReceipt/receipt').existsSync();

  static bool isAppImage() => Platform.environment.containsKey('APPIMAGE');

  /// Returns true if the app can self-update (not managed by a store).
  static bool supportsAutoUpdate() =>
      !isMsix() && !isSnap() && !isFlatpak() && !isMacAppStore();

  /// Returns true if running on a desktop platform.
  static bool isDesktop() =>
      Platform.isWindows || Platform.isMacOS || Platform.isLinux;
}
```

#### 5. `lib/features/updater/providers/update_providers.dart`

Riverpod providers for the update check feature.

```dart
/// Provider for the GitHub release service.
final githubReleaseServiceProvider = Provider<GitHubReleaseService>((ref) {
  final service = GitHubReleaseService();
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for the latest manual update check result.
/// This is a StateProvider so it persists across Settings screen visits.
final updateCheckResultProvider = StateProvider<UpdateCheckResult?>((ref) => null);

/// Provider that indicates if an update check is currently in progress.
final updateCheckInProgressProvider = StateProvider<bool>((ref) => false);

/// Provider for whether the platform supports auto-update.
final supportsAutoUpdateProvider = Provider<bool>((ref) {
  return UpdatePackageDetector.supportsAutoUpdate();
});
```

#### 6. `lib/features/updater/widgets/update_settings_section.dart`

The widget that renders the "Updates" section in Settings.

```dart
class UpdateSettingsSection extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final supportsAutoUpdate = ref.watch(supportsAutoUpdateProvider);
    final checkResult = ref.watch(updateCheckResultProvider);
    final isChecking = ref.watch(updateCheckInProgressProvider);

    if (!supportsAutoUpdate) {
      return _buildStoreManaged(context);
    }

    return _buildSection(context, ref, checkResult, isChecking);
  }
}
```

States rendered:
- **Idle (no check performed yet)**: Current version, "Check Now" button.
- **Checking**: Current version, `CircularProgressIndicator` with "Checking for updates...".
- **Up to date**: Green `Icons.check_circle` icon, "You're up to date", "Last checked: ..." subtitle, "Check Now" button.
- **Update available**: Blue `Icons.system_update` icon, "Version X.Y.Z available", release summary subtitle, release date, "Check Now" button (no install button in US-1).
- **Error**: Orange/red `Icons.error_outline` icon, "Could not check for updates", error detail subtitle, "Retry" button.
- **Store-managed**: `Icons.store` icon, "Updates are managed by your system's app store", current version subtitle.

### Modified Files

#### 1. `lib/features/settings/settings_screen.dart`

Add the "Updates" section between "Appearance" and "Notifications" (desktop only).

```dart
// In the build() method's ListView children, after _buildAppearanceSection:
if (_isDesktop) ...[
  const SizedBox(height: 24),
  const UpdateSettingsSection(),
],
```

Import `UpdateSettingsSection` and wire it in. The `_isDesktop` getter already exists in the file.

#### 2. `lib/core/providers/app_providers.dart`

No direct changes needed. The new `update_providers.dart` will be a standalone import. If the barrel pattern is desired, add:

```dart
export '../features/updater/providers/update_providers.dart';
```

However, per the existing code comment ("For new code, prefer importing the specific domain file directly"), a direct import in `settings_screen.dart` is preferred.

#### 3. Version comparison utility extraction

The private `_compareVersions` and `_parseVersion` methods in `VersionCheckService` should be extracted to a shared utility so `GitHubReleaseService` can reuse them. Options:
- Make them public static on `VersionCheckService` (simplest, smallest diff)
- Extract to `lib/core/utils/version_utils.dart` (cleaner long-term)

Recommended: Make them public static methods on `VersionCheckService` for now (rename `_compareVersions` to `compareVersions` and `_parseVersion` to `parseVersion`). This is a non-breaking change since they are already static.

---

## External API Interactions

### GitHub Releases API

**Endpoint**: `GET https://api.github.com/repos/Hamza-Labs-Core/zajel/releases/latest`

**Request headers**:
```
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
User-Agent: Zajel-Desktop-Updater/1.0
If-None-Match: "<etag-from-previous-response>"   # conditional request
```

**Success response** (200):
```json
{
  "tag_name": "v1.2.0",
  "name": "Zajel v1.2.0",
  "body": "## What's Changed\n- Added feature X\n- Fixed bug Y\n...",
  "prerelease": false,
  "draft": false,
  "published_at": "2026-03-01T12:00:00Z",
  "html_url": "https://github.com/Hamza-Labs-Core/zajel/releases/tag/v1.2.0",
  "assets": [
    {
      "name": "zajel-1.2.0-windows.zip",
      "browser_download_url": "https://github.com/.../zajel-1.2.0-windows.zip",
      "size": 52428800,
      "content_type": "application/zip"
    },
    {
      "name": "zajel-1.2.0-macos.dmg",
      "browser_download_url": "...",
      "size": 61000000,
      "content_type": "application/x-apple-diskimage"
    },
    {
      "name": "zajel-1.2.0-linux.tar.gz",
      "browser_download_url": "...",
      "size": 48000000,
      "content_type": "application/gzip"
    }
  ]
}
```

**Not Modified response** (304): Empty body. Use cached data.

**Rate limited response** (403):
```
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1709500800
```

**Relevant response headers for all responses**:
```
ETag: "abc123..."
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1709500800
```

### Artifact Naming Convention

From the release workflow (`.github/workflows/release.yml`), artifacts are named:
- `zajel-{VERSION}-android.apk`
- `zajel-{VERSION}-android.aab`
- `zajel-{VERSION}-ios.ipa`
- `zajel-{VERSION}-macos.dmg` (or `.zip` fallback)
- `zajel-{VERSION}-windows.zip` (and optionally `.msix`)
- `zajel-{VERSION}-linux.tar.gz`

The platform suffix allows `GitHubReleaseService` to find the correct asset for the current platform.

---

## UI/UX Specifications

### Section Layout

The "Updates" section follows the existing `_buildSection()` pattern used throughout `settings_screen.dart` (title text + Card wrapping ListTiles).

```
+--------------------------------------------------+
| Updates                                           |
| +----------------------------------------------+ |
| | [icon]  Current version: 1.0.0               | |
| |         [Check Now]                           | |
| +----------------------------------------------+ |
+--------------------------------------------------+
```

### State: Idle (first visit, no check yet)

```
+----------------------------------------------+
| (i)  Version 1.0.0                           |
|      No update check performed yet            |
|                          [ Check Now ]        |
+----------------------------------------------+
```

- Icon: `Icons.info_outline` (grey)
- Primary text: "Version {currentVersion}"
- Subtitle: "No update check performed yet"
- Trailing: `OutlinedButton` "Check Now"

### State: Checking

```
+----------------------------------------------+
| [spinner]  Checking for updates...            |
|                                               |
+----------------------------------------------+
```

- Leading: `SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))`
- Primary text: "Checking for updates..."
- No button (disabled state)

### State: Up to Date

```
+----------------------------------------------+
| [green check]  You're up to date             |
|                Version 1.0.0                  |
|                Last checked: just now         |
|                          [ Check Now ]        |
+----------------------------------------------+
```

- Icon: `Icons.check_circle` (green)
- Primary text: "You're up to date"
- Subtitle: "Version {currentVersion}\nLast checked: {relative time}"
- Trailing: `OutlinedButton` "Check Now"

### State: Update Available

```
+----------------------------------------------+
| [blue update]  Version 1.2.0 available       |
|                Released Mar 1, 2026           |
|                Added feature X, fixed bug Y...|
|                          [ Check Now ]        |
+----------------------------------------------+
```

- Icon: `Icons.system_update` (blue/primary color)
- Primary text: "Version {latestVersion} available"
- Subtitle: "Released {date}\n{truncated release notes}"
- Trailing: `OutlinedButton` "Check Now"
- Note: No "Download" or "Install" button in this story.

### State: Error

```
+----------------------------------------------+
| [warning]  Could not check for updates       |
|            Network error                      |
|                            [ Retry ]          |
+----------------------------------------------+
```

- Icon: `Icons.error_outline` (orange/warning)
- Primary text: "Could not check for updates"
- Subtitle: error detail string
- Trailing: `OutlinedButton` "Retry"

### State: Store Managed

```
+----------------------------------------------+
| [store]  Managed by your app store            |
|          Current version: 1.0.0               |
+----------------------------------------------+
```

- Icon: `Icons.store` (grey)
- Primary text: "Managed by your app store"
- Subtitle: "Current version: {currentVersion}"
- No button

### Relative Time Formatting

The "Last checked" timestamp uses simple relative formatting:
- Under 1 minute: "just now"
- 1-59 minutes: "X minutes ago"
- 1-23 hours: "X hours ago"
- 1+ days: formatted date (e.g., "Mar 3, 2026")

This is implemented as a simple utility function, not a third-party package.

---

## Edge Cases and Error Handling

1. **Empty version string**: If `Environment.version` is empty (dev build), display "dev" as the current version. The check still proceeds; comparison treats empty/dev as `0.0.0`, so any release will show as "available".

2. **GitHub API returns a prerelease as latest**: The `/releases/latest` endpoint already excludes prereleases and drafts. No special handling needed.

3. **Repository is private or not found (404)**: Treat as an error. Display "Repository not accessible" in the error subtitle.

4. **Network timeout**: Use a 15-second timeout. Display "Request timed out" on `TimeoutException`.

5. **Rate limit exceeded (403 with X-RateLimit-Remaining: 0)**: Parse `X-RateLimit-Reset` header, store the reset time. Return `UpdateCheckError` with `isRateLimited: true` and `rateLimitResetsAt`. The UI shows "Rate limited - try again in X minutes". The "Check Now" / "Retry" button is disabled until the reset time passes.

6. **Malformed JSON response**: Catch `FormatException`, return error result "Invalid response from server".

7. **User spams "Check Now"**: While a check is in progress (`updateCheckInProgressProvider` is true), the button is disabled. Within the 1-hour cache window, the button returns the cached result instantly (no spinner flash).

8. **App version has build metadata**: `Environment.fullVersion` may be `1.0.0+42`. Strip build metadata (`+42`) before comparison, consistent with existing `VersionCheckService._parseVersion` behavior.

9. **No internet connection**: The `http.Client` throws a `SocketException`. Catch it and display "No internet connection".

10. **GitHub API response missing expected fields**: Use defensive parsing with fallback defaults. `tagName` is required; if missing, treat as error.

11. **Release has no assets**: Still show "Version X.Y.Z available". The assets list is informational for US-1 (only used in US-2 for download).

12. **Settings screen disposed during check**: Use `ref.read` pattern and check `mounted` before updating state. Since Riverpod providers live outside the widget lifecycle, the provider state update is safe even if the widget is disposed.

---

## Dependencies

### This Story Depends On

- **Existing infrastructure**: `VersionCheckService`, `VersionPolicy`, `VersionStatus`, `Environment`, `LoggerService`, `settings_screen.dart` -- all exist and are stable.
- **`package:http`**: Already a dependency of the app (used by `AttestationClient`).
- **GitHub Releases**: The repository `Hamza-Labs-Core/zajel` must have at least one published release. For development/testing, the service must handle the case where no releases exist (404 from `/releases/latest`).

### Stories That Depend On This

- **US-2 (Background Update Download)**: Uses `GitHubReleaseService` to get download URLs and asset metadata. The `GitHubRelease.assets` list provides the `browserDownloadUrl` for each platform artifact.
- **US-3 (User-Confirmed Update Install)**: The "Install Update" button in the Settings section (added in US-3) is placed next to the update-available state introduced here.
- **US-7 (Force Update Triggers Desktop Auto-Update)**: Uses `GitHubReleaseService` to resolve download URLs when the force update dialog offers in-app download.

---

## Testing Strategy

### Unit Tests

**File**: `test/unit/updater/github_release_service_test.dart`

1. **Parses valid GitHub release JSON** -- feed a realistic JSON response, verify all fields on `GitHubRelease` are correctly populated.
2. **Handles 304 Not Modified** -- first call returns 200 with ETag, second call returns 304, verify cached release is returned.
3. **Returns cached result within cache duration** -- after a successful fetch, a second call within 1 hour returns immediately without HTTP request.
4. **Handles rate limit (403)** -- return 403 with `X-RateLimit-Remaining: 0` and `X-RateLimit-Reset` header, verify `UpdateCheckError.isRateLimited` is true and `rateLimitResetsAt` is populated.
5. **Handles network timeout** -- mock client throws `TimeoutException`, verify error result.
6. **Handles SocketException** -- mock client throws `SocketException`, verify "No internet connection" error.
7. **Handles 404** -- mock returns 404, verify error result "Repository not accessible".
8. **Handles malformed JSON** -- mock returns 200 with invalid body, verify error result.
9. **Version comparison: current == latest is up to date** -- `checkForUpdate("1.2.0")` when latest is `v1.2.0` returns `UpdateCheckUpToDate`.
10. **Version comparison: current < latest is update available** -- `checkForUpdate("1.0.0")` when latest is `v1.2.0` returns `UpdateCheckAvailable`.
11. **Version comparison: current > latest is up to date** -- `checkForUpdate("2.0.0")` when latest is `v1.2.0` returns `UpdateCheckUpToDate`.
12. **Strips "v" prefix from tag** -- `GitHubRelease` with `tagName: "v1.2.0"` has `version` of `"1.2.0"`.
13. **Sends correct request headers** -- verify `Accept`, `User-Agent`, `X-GitHub-Api-Version` headers are sent.
14. **Sends ETag in If-None-Match** -- after a 200 response with ETag, next request includes `If-None-Match`.

**File**: `test/unit/updater/update_package_detector_test.dart`

1. **Detects non-store installation as supporting auto-update** (on desktop).
2. **Tests for MSIX, Snap, Flatpak, AppImage detection** -- these require mocking `Platform.environment` and `Platform.resolvedExecutable`, which is non-trivial in Dart. Use an abstraction layer or test via integration tests.

**File**: `test/unit/updater/github_release_model_test.dart`

1. **Parses complete release JSON correctly**.
2. **Handles missing optional fields with defaults**.
3. **Parses asset list correctly**.
4. **`version` getter strips leading "v"**.

### Widget Tests

**File**: `test/widget/updater/update_settings_section_test.dart`

1. **Shows "Check Now" button in idle state** -- render widget with null `updateCheckResultProvider`, verify button text.
2. **Shows spinner during check** -- set `updateCheckInProgressProvider` to true, verify `CircularProgressIndicator` is rendered.
3. **Shows "You're up to date" on success** -- set result to `UpdateCheckUpToDate`, verify green icon and text.
4. **Shows update available details** -- set result to `UpdateCheckAvailable`, verify version, date, and summary text.
5. **Shows error with retry button** -- set result to `UpdateCheckError`, verify error text and "Retry" button.
6. **Shows store-managed message** -- mock `supportsAutoUpdateProvider` to return false, verify store message text.
7. **Check Now button triggers check** -- tap button, verify `updateCheckInProgressProvider` becomes true.
8. **Button disabled during check** -- set checking to true, verify button is not tappable.
9. **Rate limit disables button with timer** -- set error with `isRateLimited: true`, verify button is disabled.

### Integration Tests

No integration tests for US-1. The GitHub Releases API interaction is covered by unit tests with mocked HTTP client. Real API testing is deferred to CI smoke tests in a later story.

---

## Out of Scope

The following are explicitly **not** part of this story:

1. **Downloading the update** -- Covered by US-2 (Background Update Download).
2. **Installing the update** -- Covered by US-3 (User-Confirmed Update Install).
3. **Automatic/periodic background checking** -- Covered by US-2. US-1 is manual-only.
4. **"Auto-check for updates" toggle** -- The checkbox in the Settings section is part of US-2. US-1 has no toggle.
5. **"Download updates in background" toggle** -- Part of US-2.
6. **"Install updates automatically" toggle** -- Part of US-4.
7. **Update-ready banner/badge** -- Part of US-2/US-3.
8. **Modifying `UpdatePromptDialog` or `ForceUpdateDialog`** -- Covered by US-7.
9. **The Go updater binary** -- Covered by US-3.
10. **`checksums.txt` generation in CI** -- Covered by US-2 (download verification).
11. **Any mobile (Android/iOS) update prompts** -- Existing behavior via `AttestationInitializer` is unchanged.
12. **Authenticated GitHub API requests** -- The unauthenticated rate limit (60 req/hr) is sufficient for manual checks. Authentication may be added later if needed.
