# App - Settings, Onboarding, Help & Attestation Features

## Settings

### Settings Screen
- **Location**: `packages/app/lib/features/settings/settings_screen.dart`
- **Description**: Main settings screen with sections: Profile, Appearance, Notifications, Audio & Video, Privacy & Security, External Connections, Debugging, About, and Help

### Notification Settings Screen
- **Location**: `packages/app/lib/features/settings/notification_settings_screen.dart`
- **Description**: DND controls, sound/preview toggles, notification type toggles, and muted peers management

### Media Settings Screen
- **Location**: `packages/app/lib/features/settings/media_settings_screen.dart`
- **Description**: Audio input/output selection, camera preview, noise suppression, echo cancellation, auto gain control, and background blur

### Blocked Peers Screen
- **Location**: `packages/app/lib/features/settings/blocked_peers_screen.dart`
- **Description**: Display blocked users, unblock functionality, and permanent removal

## Onboarding

### Onboarding Screen
- **Location**: `packages/app/lib/features/onboarding/onboarding_screen.dart`
- **Description**: 4-step swipeable tutorial: Welcome, Your Identity, How to Connect, You're Ready

## Help

### Help Screen
- **Location**: `packages/app/lib/features/help/help_screen.dart`
- **Description**: Main knowledge base with topic listing

### Help Article Screen
- **Location**: `packages/app/lib/features/help/help_article_screen.dart`
- **Description**: Individual article display with rich text rendering

### Help Content
- **Location**: `packages/app/lib/features/help/help_content.dart`
- **Description**: Static help content with 8 articles covering: How Zajel Works, Your Identity, Pairing & Connecting, Encryption Explained, Data Storage, Platform-Specific Notes, and Troubleshooting

## Attestation

### Attestation Initializer
- **Location**: `packages/app/lib/features/attestation/attestation_initializer.dart`
- **Description**: Initialization orchestrator for version check, registration, and anti-tamper checks

### Attestation Service
- **Location**: `packages/app/lib/features/attestation/services/attestation_service.dart`
- **Description**: Main orchestrator for build token registration and session token management

### Version Check Service
- **Location**: `packages/app/lib/features/attestation/services/version_check_service.dart`
- **Description**: Version policy checking and semver comparison

### Anti-Tamper Service
- **Location**: `packages/app/lib/features/attestation/services/anti_tamper_service.dart`
- **Description**: Debugger, root/jailbreak, and emulator detection

### Binary Attestation Service
- **Location**: `packages/app/lib/features/attestation/services/binary_attestation_service.dart`
- **Description**: Dynamic binary attestation challenge handling with HMAC-SHA256

### Server Attestation Service
- **Location**: `packages/app/lib/features/attestation/services/server_attestation_service.dart`
- **Description**: Server identity verification against bootstrap registry

### Attestation Client
- **Location**: `packages/app/lib/features/attestation/services/attestation_client.dart`
- **Description**: HTTP client for bootstrap API (register, challenge, verify, version policy)

### Session Token Model
- **Location**: `packages/app/lib/features/attestation/models/session_token.dart`
- **Description**: Short-lived session token with expiration

### Build Token Model
- **Location**: `packages/app/lib/features/attestation/models/build_token.dart`
- **Description**: Build token with version, platform, hash, timestamp, and signature

### Version Policy Model
- **Location**: `packages/app/lib/features/attestation/models/version_policy.dart`
- **Description**: Version management policy with minimum/recommended versions and blocked versions

### Force Update Dialog
- **Location**: `packages/app/lib/features/attestation/widgets/force_update_dialog.dart`
- **Description**: Full-screen blocking update dialog

### Update Prompt Dialog
- **Location**: `packages/app/lib/features/attestation/widgets/update_prompt_dialog.dart`
- **Description**: Dismissable update suggestion dialog

### Binary Reader (Abstract)
- **Location**: `packages/app/lib/features/attestation/platform/binary_reader.dart`
- **Description**: Abstract interface for binary reading with stub implementation

### Binary Reader (Desktop)
- **Location**: `packages/app/lib/features/attestation/platform/binary_reader_desktop.dart`
- **Description**: Desktop (Linux/Windows/macOS) binary reader using Platform.resolvedExecutable

### Attestation Providers
- **Location**: `packages/app/lib/features/attestation/providers/attestation_providers.dart`
- **Description**: Riverpod providers for all attestation services
