# Plan: Feature Flags via GitHub Variables

## Goal

Control which features are enabled in QA and production builds using GitHub repository variables. Features default to **enabled** — flags are used to **disable** specific features when needed (e.g., channels not ready for production, groups still in testing).

## Architecture

### GitHub Variables (Repository Settings > Variables)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `FEATURE_CHANNELS` | `true`/`false` | `true` | Channel messaging (pub/sub broadcast) |
| `FEATURE_GROUPS` | `true`/`false` | `true` | Group conversations |
| `FEATURE_VOICE_CALLS` | `true`/`false` | `true` | VoIP calling |
| `FEATURE_FILE_TRANSFER` | `true`/`false` | `true` | File sharing over WebRTC |
| `FEATURE_DEVICE_LINK` | `true`/`false` | `true` | Multi-device linking |
| `FEATURE_AUTO_UPDATE` | `true`/`false` | `true` | Desktop auto-updater |
| `FEATURE_DIAGNOSTICS` | `true`/`false` | `true` | Crash reports & heartbeats |

### Build-Time Injection

**CI workflows** (`pr-pipeline.yml`, `release.yml`) read variables and pass them as `--dart-define` flags:

```yaml
- name: Build with feature flags
  run: |
    flutter build apk --release \
      --dart-define=FEATURE_CHANNELS=${{ vars.FEATURE_CHANNELS || 'true' }} \
      --dart-define=FEATURE_GROUPS=${{ vars.FEATURE_GROUPS || 'true' }} \
      --dart-define=FEATURE_VOICE_CALLS=${{ vars.FEATURE_VOICE_CALLS || 'true' }} \
      --dart-define=FEATURE_FILE_TRANSFER=${{ vars.FEATURE_FILE_TRANSFER || 'true' }} \
      --dart-define=FEATURE_DEVICE_LINK=${{ vars.FEATURE_DEVICE_LINK || 'true' }} \
      --dart-define=FEATURE_AUTO_UPDATE=${{ vars.FEATURE_AUTO_UPDATE || 'true' }} \
      --dart-define=FEATURE_DIAGNOSTICS=${{ vars.FEATURE_DIAGNOSTICS || 'true' }}
```

The `|| 'true'` ensures features are **enabled by default** when the variable isn't set.

### App-Side: FeatureFlags Class

**File:** `packages/app/lib/core/config/feature_flags.dart`

```dart
class FeatureFlags {
  FeatureFlags._();

  static const bool channels = bool.fromEnvironment(
    'FEATURE_CHANNELS',
    defaultValue: true,
  );

  static const bool groups = bool.fromEnvironment(
    'FEATURE_GROUPS',
    defaultValue: true,
  );

  static const bool voiceCalls = bool.fromEnvironment(
    'FEATURE_VOICE_CALLS',
    defaultValue: true,
  );

  static const bool fileTransfer = bool.fromEnvironment(
    'FEATURE_FILE_TRANSFER',
    defaultValue: true,
  );

  static const bool deviceLink = bool.fromEnvironment(
    'FEATURE_DEVICE_LINK',
    defaultValue: true,
  );

  static const bool autoUpdate = bool.fromEnvironment(
    'FEATURE_AUTO_UPDATE',
    defaultValue: true,
  );

  static const bool diagnostics = bool.fromEnvironment(
    'FEATURE_DIAGNOSTICS',
    defaultValue: true,
  );
}
```

All `const` with `defaultValue: true` — tree-shaking removes dead code when a feature is disabled at compile time.

### Usage in App Code

**UI gating** — hide tabs/buttons:
```dart
if (FeatureFlags.channels) ...[
  ChannelsTab(),
],
```

**Service gating** — skip initialization:
```dart
if (FeatureFlags.diagnostics) {
  diagnosticsService.start(url: Environment.diagnosticsUrl);
}
```

**Registration gating** — don't register protocol handlers:
```dart
if (FeatureFlags.voiceCalls) {
  _registerVoIPHandlers();
}
```

### Integration Points

| Feature | UI Gate | Service Gate | Protocol Gate |
|---------|---------|--------------|---------------|
| Channels | Channel tab, new channel button | Channel subscription on connect | `channel-subscribe`, `chunk_announce` |
| Groups | Group tab, create group | Group storage init | Group invite/message handlers |
| Voice Calls | Call button, incoming call dialog | VoIP service init | `call_offer`, `call_answer` |
| File Transfer | Share button, file picker | File transfer listener | `file_offer`, file data channel |
| Device Link | Link device menu item | Device link service | `device_link_*` messages |
| Auto Update | Update settings section | Auto-update service, orchestrator | GitHub API check |
| Diagnostics | (none — invisible) | DiagnosticsService, LogUploadService | Heartbeat, error reports |

### Per-Environment Variables

GitHub supports per-environment variables. Use **environment-scoped** variables for QA vs production:

- **QA environment**: All features enabled (testing everything)
- **Production environment**: Disable unstable features

```yaml
# In workflow
environment: ${{ contains(github.ref, 'build') && 'qa' || 'production' }}
```

### File Changes

| File | Change |
|------|--------|
| `packages/app/lib/core/config/feature_flags.dart` | **New** — FeatureFlags class |
| `packages/app/lib/main.dart` | Gate service initialization |
| `packages/app/lib/features/*/` | Gate UI components |
| `.github/workflows/pr-pipeline.yml` | Pass `--dart-define=FEATURE_*` flags |
| `.github/workflows/release.yml` | Pass `--dart-define=FEATURE_*` flags |

### Testing

- Unit: `FeatureFlags` values are compile-time constants — test with `--dart-define=FEATURE_X=false`
- Integration: Build with a feature disabled, verify its tab/service is absent
- CI: Default run has all features enabled (same as current behavior)
