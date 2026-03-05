# US-1.3: Diagnostics Opt-In Setting

## Story

As a Zajel user, I want to opt in/out of diagnostics collection in the app settings, so that I control whether my app sends telemetry.

## Acceptance Criteria

- A toggle switch is visible in the Settings screen under a "Diagnostics" or "Privacy & Security" section.
- The toggle label clearly states what it controls: "Send anonymous diagnostics" with a subtitle explaining what data is collected.
- Default is OFF in production builds (`Environment.isProduction == true`).
- Default is ON in QA builds (`Environment.isQA == true`).
- Default is ON in dev builds (`Environment.isDev == true`).
- When toggled OFF, no HTTP requests are made to the diagnostics endpoint -- not even heartbeats.
- When toggled ON, diagnostics collection and heartbeat sending resume immediately.
- The setting is persisted across app restarts via `SharedPreferences`.
- The setting is exposed as a Riverpod provider that other services can watch reactively.
- Tapping an "info" icon or "Learn more" link shows a brief explanation of what data is collected and what is not (no PII, no IP logging, anonymous session hash, etc.).

## Technical Design

### Architecture

This story adds a user-facing setting to the Flutter app that gates all diagnostics telemetry. The `DiagnosticsService` (created in later stories US-1.4, US-1.5, or as part of Epic 1 Flutter integration) watches this provider and short-circuits all collection and upload when disabled.

```
Settings Screen
    |
    v
diagnosticsEnabledProvider (SharedPreferences-backed)
    |
    v
DiagnosticsService.initialize()
    +--> if disabled: no-op (no timers, no HTTP, no error hooking)
    +--> if enabled: start error tracking, heartbeat timer, report batching
```

The setting integrates with the existing Riverpod provider architecture used throughout the app (e.g., `privacyScreenProvider`, `autoDeleteSettingsProvider` in `settings_providers.dart`).

### Implementation Details

**Provider** follows the exact pattern of `PrivacyScreenNotifier` in `packages/app/lib/core/providers/settings_providers.dart`: a `StateNotifierProvider<DiagnosticsEnabledNotifier, bool>` backed by a `SharedPreferences` key. The notifier reads the initial value from prefs on construction and writes back on toggle.

**Default value logic:**
```dart
static bool _defaultValue() {
  // QA and dev builds default to ON
  if (Environment.isQA || Environment.isDev) return true;
  // Production defaults to OFF
  return false;
}
```

The notifier constructor checks `prefs.getBool(_key)`. If `null` (never set by user), it falls back to `_defaultValue()`. If the user has explicitly toggled, the stored value takes precedence.

**Settings UI** adds a new section to `settings_screen.dart` in the "Privacy & Security" section, between the existing "Privacy Screen" toggle and "Blocked Users". The toggle follows the same `SwitchListTile` pattern as the privacy screen toggle.

**Info dialog** is a simple `AlertDialog` triggered by an info icon on the tile. Text explains: "Zajel collects anonymous, non-identifying crash reports and performance metrics to improve the app. No personal data, IP addresses, or message content is ever collected. A random session ID is generated on each app launch and cannot be linked to you."

**Reactive gating:** The `DiagnosticsService` (future stories) will use `ref.watch(diagnosticsEnabledProvider)` to conditionally start/stop its timers. When disabled, it will:
- Cancel any pending upload timers.
- Unregister `FlutterError.onError` overrides.
- Stop the heartbeat timer.
- Not make any HTTP requests.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/app/lib/core/providers/settings_providers.dart` | Modify | Add `diagnosticsEnabledProvider` and `DiagnosticsEnabledNotifier` |
| `packages/app/lib/features/settings/settings_screen.dart` | Modify | Add diagnostics toggle in Privacy & Security section |
| `packages/app/test/core/providers/diagnostics_enabled_test.dart` | Create | Unit tests for the provider |
| `packages/app/test/features/settings/settings_screen_test.dart` | Modify | Add test for diagnostics toggle visibility and behavior |

### Data Models / Schemas

**SharedPreferences key:**

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `diagnosticsEnabled` | `bool` | `false` (prod) / `true` (QA/dev) | Whether diagnostics collection is active |

**Provider definition:**

```dart
final diagnosticsEnabledProvider =
    StateNotifierProvider<DiagnosticsEnabledNotifier, bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return DiagnosticsEnabledNotifier(prefs);
});

class DiagnosticsEnabledNotifier extends StateNotifier<bool> {
  final SharedPreferences _prefs;
  static const _key = 'diagnosticsEnabled';

  DiagnosticsEnabledNotifier(this._prefs)
      : super(_prefs.getBool(_key) ?? _defaultValue());

  static bool _defaultValue() {
    if (Environment.isQA || Environment.isDev) return true;
    return false;
  }

  Future<void> setEnabled(bool enabled) async {
    state = enabled;
    await _prefs.setBool(_key, enabled);
  }
}
```

### API Endpoints

Not applicable -- this story is entirely client-side.

## Dependencies

- No dependency on other US-1.x stories for the setting itself; however, the setting only becomes functional once `DiagnosticsService` is implemented (US-1.4/US-1.5/Flutter SDK integration in Phase 1).
- **Internal dependencies:**
  - `packages/app/lib/core/config/environment.dart` -- for `Environment.isQA`, `Environment.isProduction`, `Environment.isDev`
  - `packages/app/lib/core/providers/preferences_providers.dart` -- for `sharedPreferencesProvider`
  - `packages/app/lib/core/providers/settings_providers.dart` -- existing settings pattern to follow
- **External dependencies:**
  - `shared_preferences` package (already in pubspec.yaml)
  - `flutter_riverpod` package (already in pubspec.yaml)

## Testing Strategy

- **Unit tests (`diagnostics_enabled_test.dart`):**
  - Default value is `false` when `Environment.isProduction` is true and pref is unset.
  - Default value is `true` when `Environment.isQA` is true and pref is unset.
  - Explicit user preference (`true` or `false`) overrides the environment default.
  - Calling `setEnabled(true)` updates state and persists to SharedPreferences.
  - Calling `setEnabled(false)` updates state and persists to SharedPreferences.
  - State change is observable by listeners (Riverpod reactivity).
- **Widget tests (`settings_screen_test.dart`):**
  - The diagnostics toggle is visible in the settings screen.
  - Toggling the switch calls `setEnabled` on the notifier.
  - The subtitle text includes "anonymous" and "diagnostics".
  - The info dialog is shown when the info icon is tapped.
  - The info dialog text mentions "no personal data" and "anonymous session ID".

## Technical Notes

**Codebase patterns to follow:**
- The provider follows the identical pattern of `PrivacyScreenNotifier` in `settings_providers.dart` -- a `StateNotifierProvider<T, bool>` with a `SharedPreferences` backing store. The constructor reads from prefs, and `setEnabled` writes to prefs and updates state.
- The settings screen UI follows the same `SwitchListTile` pattern used for the privacy screen toggle: `secondary` icon, `title`, `subtitle`, `value` bound to provider, `onChanged` calls notifier.
- The info dialog follows the same `AlertDialog` pattern used in `_showRegenerateKeysDialog` and `_showClearDataDialog`.

**External best practices applied:**
- Telemetry defaults to OFF in production, following the opt-in model championed by privacy-by-design frameworks (GDPR Article 25). Ubuntu 25.10 also adopted strict opt-in for its telemetry system.
- The toggle text uses plain language ("Send anonymous diagnostics") rather than technical jargon, per GDPR transparency requirements.
- The info dialog explicitly states what is NOT collected (no PII, no IP, no message content), which aligns with the OpenTelemetry project's recommendation to clearly document sensitive data handling.

**Gotchas:**
- `Environment.isQA` and `Environment.isProduction` are compile-time constants via `--dart-define`. In tests, these cannot be overridden at runtime. The test strategy should mock the `SharedPreferences` with a preset value rather than trying to change the `Environment` constants.
- The provider must be declared in `settings_providers.dart` (not a new file) so it is exported through the existing `app_providers.dart` barrel file.
- When the toggle is turned OFF mid-session, the `DiagnosticsService` must cancel in-flight uploads gracefully (do not abort an HTTP request that is already sending -- let it complete, then stop scheduling new ones).

## Estimation

**S (Small)** -- This story adds a single Riverpod provider (following an existing pattern verbatim) and a single `SwitchListTile` to an existing screen. The info dialog is a few lines of static text. No networking, no storage integration, no complex logic.
