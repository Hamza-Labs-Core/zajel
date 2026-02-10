# Plan: In-App User Guide, FAQ, and First-Launch Tutorial

## Context

Zajel is a peer-to-peer encrypted messenger where identity is a locally-generated X25519 keypair stored in platform-secure storage (Keychain, EncryptedSharedPreferences, libsecret). There is no server-side account, no email/phone registration, and no recovery mechanism. This has critical consequences users must understand:

- **Uninstall = permanent identity loss.** Clearing app data or uninstalling destroys the private key. All peer trust relationships are severed. There is no "forgot password" flow.
- **Messages are local-only.** Messages are stored in a local SQLite database (`zajel_messages.db`) and are never uploaded to any server. If the database is lost, messages are gone.
- **No message relay.** Messages transit via WebRTC data channels. If the recipient is offline, the message cannot be delivered. There is no store-and-forward.
- **Pairing codes are ephemeral.** The 6-character code changes every time the app connects to the signaling server. It is not a permanent address.
- **Encryption is always on.** ChaCha20-Poly1305 AEAD with X25519 key exchange. Users cannot disable it, but they should understand what "end-to-end encrypted" actually means in a P2P context (no server ever sees plaintext).

Currently the app has **zero onboarding**, **no help/FAQ screens**, and **no warnings** about data loss on uninstall. The settings screen has an "About" section with version, source code link, and privacy policy link -- all external URLs. There is no in-app educational content.

---

## Current State (from codebase exploration)

### What exists

| Area | Status |
|------|--------|
| Onboarding / first-run flow | **None.** `main.dart` shows a loading spinner, then the home screen. No first-launch detection. |
| Settings screen | 8 sections: Profile, Appearance, Notifications, Audio & Video, Privacy & Security, External Connections, Debugging, About. No Help/FAQ section. |
| About screen | Inline in settings. Version (hardcoded "1.0.0"), source code link, privacy policy link. All `url_launcher` to GitHub. |
| Help / FAQ / Guide | **None.** No files, no widgets, no routes. |
| Markdown rendering | **Not available.** `pubspec.yaml` has no `flutter_markdown` or similar package. All text is hardcoded Flutter widgets. |
| Content assets | `assets/icons/` and `assets/images/` exist but contain only `.gitkeep` placeholders. |
| SharedPreferences | Already used for display name, theme, bootstrap URL, notification settings. Can store `hasSeenOnboarding` flag. |
| Platform detection | `Environment` class in `core/config/environment.dart` has platform checks. `dart:io` Platform used throughout. |
| Router | `go_router` with `GoRouter` + `ShellRoute`. Routes: `/`, `/chat/:peerId`, `/connect`, `/settings`, `/settings/*`, `/contacts`, `/contacts/:peerId`. |
| Theme | Material 3 via `AppTheme` with light/dark variants using `ColorScheme.fromSeed`. Cards have 0 elevation with border. |

### What is stored where

| Data | Storage | Survives uninstall? |
|------|---------|---------------------|
| Identity keypair (X25519 private key) | `flutter_secure_storage` (Keychain / Keystore / libsecret) | **No** (Android: cleared on uninstall. iOS: Keychain *may* persist but app can't access it after reinstall without same signing identity.) |
| Session keys | `flutter_secure_storage` | No |
| Trusted peers (public keys, aliases) | `flutter_secure_storage` | No |
| Messages | SQLite in app documents dir | No |
| Preferences (display name, theme, etc.) | `SharedPreferences` | No |
| Blocked peers | `SharedPreferences` | No |

---

## Content Outline

### 1. Knowledge Base Articles (in-app)

#### 1.1 How Zajel Works
- P2P architecture: messages go directly between devices via WebRTC, never through a server
- Signaling server role: only helps devices find each other (exchange WebRTC offers/answers), never sees message content
- Bootstrap server role: provides a list of available signaling servers (server discovery)
- No accounts, no phone numbers, no email -- identity is a cryptographic keypair generated on your device

#### 1.2 Your Identity
- Your identity is an X25519 keypair generated on first launch
- The private key is stored in your device's secure storage (Keychain on iOS/macOS, Keystore on Android, libsecret on Linux, DPAPI on Windows)
- **WARNING: Uninstalling the app permanently destroys your identity. There is no recovery. All your contacts will need to re-pair with you.**
- "Regenerate Keys" in settings creates a new identity (disconnects all peers)
- "Clear All Data" destroys everything: keys, messages, contacts

#### 1.3 Pairing & Connecting
- Pairing codes are temporary 6-character codes assigned when you connect to a signaling server
- Share your code or scan a QR code to connect with someone
- Once paired, devices remember each other as "trusted peers" and auto-reconnect via meeting points
- Both devices must be online simultaneously to communicate
- Web client linking: browsers link to your mobile device for secure messaging

#### 1.4 Encryption Explained (user-friendly)
- All messages are encrypted with ChaCha20-Poly1305 (a modern authenticated cipher)
- Key exchange uses X25519 (Elliptic Curve Diffie-Hellman)
- Only you and your peer have the keys -- no server, not even Zajel's developers, can read your messages
- You can verify a peer's identity by comparing key fingerprints (shown in contact details)
- Encryption is always on and cannot be disabled

#### 1.5 Data Storage
- Messages are stored locally in a SQLite database on your device
- Messages are never uploaded to any server
- If your device is lost or the app is uninstalled, messages are permanently gone
- File transfers go directly between devices; files are saved to your device's storage
- No cloud backup of any kind

#### 1.6 Platform-Specific Notes
- **Android**: Camera permission needed for QR scanning. Notification permission requested on first launch. Background connections may be affected by battery optimization -- consider disabling Doze for Zajel.
- **iOS**: Camera permission for QR scanning. Notification permission. Background app refresh affects connectivity.
- **Linux**: Uses libsecret for key storage. Desktop tray integration not available yet.
- **Windows**: Uses Windows Credential Manager (DPAPI). May see ANGLE/DirectX warnings on older hardware.
- **macOS**: Uses Keychain for key storage. Camera permission for QR scanning.
- **Web** (linked client): Runs in browser, linked to a native app instance. Cannot independently hold an identity. Limited by browser WebRTC implementation.

#### 1.7 Troubleshooting
- "Offline" status: Signaling server unreachable. Check internet. App retries with exponential backoff (3s, 6s, 12s, 24s, 48s).
- Peer shows "Offline": The other device is not connected to the signaling server. Both must be online.
- "Connection failed": WebRTC ICE negotiation failed. Usually a network/firewall issue. Try a different network.
- Messages not delivering: Recipient must be online. There is no offline message queue.
- Lost identity after reinstall: Expected behavior. You must re-pair with all contacts.
- QR scanner not working: Check camera permissions in system settings.

### 2. First-Launch Tutorial (onboarding)

A 4-step swipeable onboarding flow shown only on first launch:

1. **Welcome** -- "Zajel: Private Peer-to-Peer Messaging. No accounts. No servers storing your messages. Just you and your contacts."
2. **Your Identity** -- "Your identity was just created as a cryptographic keypair on this device. It exists nowhere else. If you uninstall this app, your identity is permanently lost." (with warning icon)
3. **How to Connect** -- "Share your pairing code or scan a QR code to connect with someone. Both devices must be online at the same time."
4. **Get Started** -- "You're ready. Tap Connect to add your first peer." (button navigates to Connect screen or dismisses to Home)

### 3. Critical Warnings (contextual, in-flow)

- **Before "Clear All Data"**: Already exists in settings, but strengthen the warning text to explicitly mention identity loss.
- **Before "Regenerate Keys"**: Already exists. Add "Your contacts will no longer recognize you."
- **App update reminder**: If the app detects it hasn't shown the identity warning recently, show a subtle banner on the home screen.

---

## Implementation Plan

### Phase 1: Knowledge Base & Help Screen

#### New files to create

| File | Purpose |
|------|---------|
| `lib/features/help/help_screen.dart` | Main help/KB screen with a list of topic cards |
| `lib/features/help/help_article_screen.dart` | Individual article viewer (scrollable rich text) |
| `lib/features/help/help_content.dart` | Static content definitions (titles, bodies, icons) |

#### Approach: Hardcoded content in Dart

- **No markdown package needed.** The content is authored by us, not user-generated. Using structured Dart data (title, sections with headers and body text) rendered with standard Flutter `Text`, `RichText`, `SelectableText`, and `Card` widgets keeps dependencies minimal and matches the existing codebase style.
- Content is defined as a list of `HelpArticle` objects in `help_content.dart`, each with a title, icon, and list of `HelpSection` objects (header + body paragraphs).
- This avoids adding `flutter_markdown` as a dependency, keeps bundle size down, and ensures the content renders correctly on all 6 platforms without any platform-specific rendering quirks.

#### Widget structure

```
HelpScreen (Scaffold + ListView of topic cards)
  -> HelpArticleScreen (Scaffold + SingleChildScrollView)
       -> Title
       -> Sections (header + body text, with optional warning boxes)
```

The `HelpScreen` will use the same `_buildSection` / `Card` / `ListTile` pattern that `SettingsScreen` already uses, maintaining visual consistency.

Warning boxes (for critical info like identity loss) will use the same orange `Container` + `warning_amber` icon pattern already used in `connect_screen.dart` and `main.dart` pair request dialogs.

#### Router changes

Add two routes to `app_router.dart`:

```dart
GoRoute(
  path: '/help',
  builder: (context, state) => const HelpScreen(),
),
GoRoute(
  path: '/help/:articleId',
  builder: (context, state) {
    final articleId = state.pathParameters['articleId']!;
    return HelpArticleScreen(articleId: articleId);
  },
),
```

#### Settings screen changes

Add a new "Help & Info" section to `settings_screen.dart` between the "About" section and the "Clear All Data" button:

```dart
_buildSection(
  context,
  title: 'Help & Info',
  children: [
    ListTile(
      leading: const Icon(Icons.help_outline),
      title: const Text('How Zajel Works'),
      subtitle: const Text('Learn about P2P messaging and encryption'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push('/help'),
    ),
    ListTile(
      leading: const Icon(Icons.quiz_outlined),
      title: const Text('FAQ'),
      subtitle: const Text('Frequently asked questions'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push('/help/faq'),
    ),
  ],
),
```

### Phase 2: First-Launch Onboarding

#### New files to create

| File | Purpose |
|------|---------|
| `lib/features/onboarding/onboarding_screen.dart` | 4-step swipeable PageView with dots indicator |

#### First-launch detection

In `main.dart`, after `SharedPreferences.getInstance()`, check `prefs.getBool('hasSeenOnboarding') ?? false`. If false, set `initialLocation` in the router to `/onboarding`. After the user completes onboarding, set `hasSeenOnboarding = true` and navigate to `/`.

Alternative (simpler, less invasive): In `_ZajelAppState._initialize()`, after initialization completes, check the flag. If false, show the onboarding as a full-screen overlay or navigate to it. This avoids changing the router's `initialLocation` dynamically.

Recommended approach: Use a `StateProvider<bool>` for `hasSeenOnboardingProvider` seeded from SharedPreferences. In the router's `redirect` callback, if `!hasSeenOnboarding && location == '/'`, redirect to `/onboarding`. This is clean and idiomatic for `go_router`.

#### Router changes

```dart
GoRoute(
  path: '/onboarding',
  builder: (context, state) => const OnboardingScreen(),
),
```

Add redirect logic:

```dart
redirect: (context, state) {
  final container = ProviderScope.containerOf(context);
  final seen = container.read(hasSeenOnboardingProvider);
  if (!seen && state.matchedLocation == '/') return '/onboarding';
  return null;
},
```

#### Onboarding widget structure

```
OnboardingScreen (Scaffold)
  -> PageView (4 pages)
       -> Each page: Column(icon/illustration, title, body text, optional warning box)
  -> Bottom: PageIndicator dots + "Next" / "Get Started" button
```

Style: Use the app's existing `ColorScheme` and `TextTheme`. Warning step (identity) uses the orange warning box pattern. Final step has an `ElevatedButton` that sets `hasSeenOnboarding = true` and navigates to `/` (or `/connect`).

### Phase 3: Contextual Warnings (enhancements to existing screens)

#### Strengthen "Clear All Data" warning

In `settings_screen.dart` `_showClearDataDialog`, change the content text from:
```
'This will delete all messages, contacts, and keys. This action cannot be undone. Continue?'
```
to:
```
'This will permanently destroy your identity, all messages, contacts, and encryption keys. Your contacts will no longer be able to reach you. You will need to re-pair with everyone. This action cannot be undone.'
```

#### Strengthen "Regenerate Keys" warning

In `settings_screen.dart` `_showRegenerateKeysDialog`, change the content text to:
```
'This will create a new identity. All existing peers will no longer recognize you and connections will be severed. You will need to re-pair with everyone. Continue?'
```

#### Add identity warning banner on home screen

Optional: If `prefs.getBool('hasSeenIdentityWarning') != true`, show a dismissible banner at the top of `HomeScreen` that says: "Your identity exists only on this device. If you uninstall Zajel, your identity and messages are permanently lost." with a "Learn more" link to `/help/identity` and a dismiss button that sets the flag.

---

## Files to Create

| File | Type | Estimated size |
|------|------|---------------|
| `packages/app/lib/features/help/help_screen.dart` | New screen | ~120 lines |
| `packages/app/lib/features/help/help_article_screen.dart` | New screen | ~150 lines |
| `packages/app/lib/features/help/help_content.dart` | Content data | ~250 lines |
| `packages/app/lib/features/onboarding/onboarding_screen.dart` | New screen | ~200 lines |

## Files to Modify

| File | Change |
|------|--------|
| `packages/app/lib/app_router.dart` | Add `/help`, `/help/:articleId`, `/onboarding` routes. Add redirect for onboarding. Add imports. |
| `packages/app/lib/features/settings/settings_screen.dart` | Add "Help & Info" section. Strengthen warning dialog texts. |
| `packages/app/lib/features/home/home_screen.dart` | Optional: Add dismissible identity warning banner for first-time users. |
| `packages/app/lib/core/providers/app_providers.dart` | Add `hasSeenOnboardingProvider` seeded from SharedPreferences. |

## Existing Patterns to Reuse

1. **Section/Card layout from `settings_screen.dart`**: The `_buildSection(context, title:, children:)` pattern with `Card` wrapping `ListTile`s is the standard for list-based screens. `HelpScreen` should use the same pattern.

2. **Warning box from `main.dart` / `connect_screen.dart`**: The orange `Container` with `warning_amber` icon and explanation text is used in pair request dialogs, link request dialogs, and the web link tab. Reuse this exact pattern for critical warnings in help articles and onboarding.

3. **Navigation pattern**: `context.push('/path')` via `go_router` is used everywhere. Keep consistent.

4. **Theme usage**: All screens use `Theme.of(context).textTheme.titleMedium`, `.bodyMedium`, etc. and `Theme.of(context).colorScheme.primary`, `.onSurfaceVariant`, etc. No hardcoded colors outside of `AppTheme`.

5. **SharedPreferences for flags**: Already used for `displayName`, `themeMode`, `bootstrapServerUrl`, `notificationSettings`, `blockedPublicKeys`. Adding `hasSeenOnboarding` and `hasSeenIdentityWarning` follows the same pattern.

6. **ConsumerWidget / ConsumerStatefulWidget**: All screens use Riverpod consumers. Keep consistent.

7. **Scrollable content**: `SingleChildScrollView` with `padding: const EdgeInsets.all(24)` is used in `connect_screen.dart` for content-heavy screens. `HelpArticleScreen` should use the same.

---

## Dependencies

**No new packages required.** All content is rendered with standard Flutter widgets. The existing `url_launcher` package can be used if any help article needs to link to external resources (e.g., source code, privacy policy).

---

## Scope & Priority

| Phase | Priority | Effort |
|-------|----------|--------|
| Phase 1: Help/KB screens | High | ~4 hours |
| Phase 2: First-launch onboarding | High | ~3 hours |
| Phase 3: Contextual warnings | Medium | ~1 hour |
| **Total** | | **~8 hours** |

Phase 1 and Phase 2 can be developed in parallel. Phase 3 is a small follow-up.
