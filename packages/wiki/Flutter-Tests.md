# Flutter Tests

The Flutter app (`packages/app/`) has a comprehensive test suite organized into unit tests, widget tests, integration tests, and E2E tests. Unit and widget tests run in CI on every push and PR; integration tests are run locally due to platform limitations.

## Test Directory Structure

```
packages/app/test/
  unit/
    attestation/      # App attestation and integrity
    channels/         # Channel service, crypto, sync, links
    crypto/           # Crypto service, bootstrap verifier
    groups/           # Group service, crypto, sync, connections
    help/             # Help content
    media/            # Media service
    models/           # Message and peer models
    network/          # Connection, signaling, relay, VoIP
    notifications/    # Notification service
    protocol/         # Message protocol
    providers/        # Riverpod providers
  widget/
    call/             # Call screen, incoming call dialog
    chat/             # Chat screen focus
    channels_test.dart
    groups_test.dart
    help_screen_test.dart
    home_screen_test.dart
    onboarding_screen_test.dart
  integration/
    connection_test.dart
    reconnection_flow_test.dart
    server_discovery_test.dart
    signaling_reconnect_test.dart
    signaling_rendezvous_test.dart
  e2e/
    (Dart-based E2E -- see e2e-tests/ for the pytest-based E2E suite)
```

## Unit Tests

### Attestation Tests

| File | Tests |
|------|-------|
| `anti_tamper_service_test.dart` | Anti-tamper detection service |
| `attestation_client_test.dart` | Attestation API client |
| `attestation_service_test.dart` | Attestation coordination service |
| `binary_attestation_service_test.dart` | Binary integrity verification |
| `build_token_test.dart` | Build token generation/validation |
| `server_attestation_service_test.dart` | Server-side attestation |
| `session_token_test.dart` | Session token management |
| `version_check_service_test.dart` | Version check service |
| `version_policy_test.dart` | Version policy enforcement |

### Channel Tests

| File | Tests |
|------|-------|
| `admin_management_service_test.dart` | Channel admin management |
| `background_sync_service_test.dart` | Background channel sync |
| `channel_crypto_service_test.dart` | Channel encryption (Ed25519 + HKDF + ChaCha20-Poly1305) |
| `channel_link_service_test.dart` | `zajel://channel/` invite link encoding/decoding |
| `channel_model_test.dart` | Channel data model |
| `channel_providers_test.dart` | Riverpod channel providers |
| `channel_service_test.dart` | Channel CRUD operations |
| `channel_sync_service_test.dart` | Channel sync with relay |
| `key_rotation_test.dart` | Channel key rotation |
| `live_stream_service_test.dart` | Live streaming service |
| `poll_service_test.dart` | Channel poll service |
| `routing_hash_service_test.dart` | Routing hash computation for relay selection |
| `upstream_service_test.dart` | Upstream (subscriber-to-publisher) service |

### Crypto Tests

| File | Tests |
|------|-------|
| `crypto_service_test.dart` | X25519 key exchange, HKDF derivation, ChaCha20-Poly1305 encryption/decryption |
| `bootstrap_verifier_test.dart` | Bootstrap server certificate verification |

### Group Tests

| File | Tests |
|------|-------|
| `group_connection_service_test.dart` | Group P2P connection management |
| `group_crypto_service_test.dart` | Sender key encryption/decryption |
| `group_model_test.dart` | Group data model |
| `group_providers_test.dart` | Riverpod group providers |
| `group_service_test.dart` | Group CRUD and membership |
| `group_sync_service_test.dart` | Group sync service |

### Network Tests

| File | Tests |
|------|-------|
| `connection_manager_test.dart` | WebRTC connection lifecycle management |
| `meeting_point_service_test.dart` | Meeting point derivation and discovery |
| `peer_reconnection_service_test.dart` | Trusted peer reconnection |
| `pinned_websocket_test.dart` | TLS certificate pinning for WebSocket |
| `relay_client_introduction_test.dart` | Relay client introduction protocol |
| `relay_client_load_test.dart` | Relay client load/stress testing |
| `relay_client_source_id_test.dart` | Relay client source ID management |
| `relay_client_test.dart` | Relay client core operations |
| `rendezvous_service_test.dart` | Rendezvous service for peer discovery |
| `signaling_client_test.dart` | WebSocket signaling client |
| `voip_service_test.dart` | VoIP call service |

### Other Unit Tests

| File | Tests |
|------|-------|
| `help/help_content_test.dart` | Help content model |
| `media/media_service_test.dart` | Media device enumeration and management |
| `models/message_test.dart` | Message model serialization |
| `models/peer_test.dart` | Peer model |
| `notifications/notification_service_test.dart` | Notification service |
| `protocol/message_protocol_test.dart` | Message protocol encoding/decoding |
| `providers/chat_messages_test.dart` | Chat message provider |
| `providers/theme_mode_test.dart` | Theme mode provider |

## Widget Tests

Widget tests verify Flutter UI components render correctly and handle user interactions:

| File | Tests |
|------|-------|
| `call/call_screen_test.dart` | Call screen UI (mute, video toggle, hangup) |
| `call/incoming_call_dialog_test.dart` | Incoming call dialog (accept/reject) |
| `chat/chat_screen_focus_test.dart` | Chat input focus behavior |
| `channels_test.dart` | Channel list and detail screens |
| `groups_test.dart` | Group list and detail screens |
| `help_screen_test.dart` | Help screen content rendering |
| `home_screen_test.dart` | Home screen navigation |
| `onboarding_screen_test.dart` | Onboarding flow |

## Integration Tests

Integration tests at `packages/app/test/integration/` test multi-component flows on a real device or desktop:

| File | Tests |
|------|-------|
| `connection_test.dart` | Full connection lifecycle |
| `reconnection_flow_test.dart` | Reconnection after disconnect |
| `server_discovery_test.dart` | Server discovery via bootstrap |
| `signaling_reconnect_test.dart` | Signaling WebSocket reconnection |
| `signaling_rendezvous_test.dart` | Rendezvous-based peer reconnection |

**CI Status**: Skipped in CI due to platform limitations. See `docs/testing/CI_LIMITATIONS.md`.

**Run Locally**:
```bash
cd packages/app

# Linux
flutter test integration_test/ -d linux

# macOS
flutter test integration_test/ -d macos

# Using the helper script
./run_integration_tests.sh
./run_integration_tests.sh --with-server
./run_integration_tests.sh --mock
```

## Running Tests

### All Tests

```bash
cd packages/app
flutter test
```

### Specific Category

```bash
# Just unit tests
flutter test test/unit/

# Just crypto tests
flutter test test/unit/crypto/

# Just widget tests
flutter test test/widget/

# A single test file
flutter test test/unit/channels/channel_crypto_service_test.dart
```

### With Verbose Output

```bash
flutter test --reporter expanded
```

### With Coverage

```bash
flutter test --coverage
# Coverage report at coverage/lcov.info
```

## CI Configuration

### `ci.yml` (CI - App)

Triggered on push/PR to `main` when `packages/app/**` changes:

1. **analyze** job: `flutter analyze --no-fatal-infos` + `dart format --set-exit-if-changed .`
2. **test** job (depends on analyze): `flutter test`

### `flutter-tests.yml` (Flutter Tests)

Triggered on push/PR to `main`/`feature/**` when `packages/app/**` changes:

1. **Analyze**: `flutter analyze --no-fatal-infos`
2. **Unit Tests**: `flutter test test/`
3. **Build Android**: `flutter build apk --debug` (verifies build succeeds)
4. **Build iOS**: `flutter build ios --no-codesign --debug` (on `macos-latest`)

Uses concurrency group `flutter-${{ github.ref }}` with cancel-in-progress.

### `pr-pipeline.yml` (PR Pipeline - Phase 1)

The PR Pipeline's Phase 1 also runs Flutter tests as part of the Unit Tests job:

```yaml
- name: Analyze code
  run: flutter analyze --no-fatal-infos

- name: Run unit tests
  run: flutter test test/
```

## Test Patterns

### Mocking with Mockito

```dart
import 'package:mockito/mockito.dart';
import 'package:mockito/annotations.dart';

@GenerateNiceMocks([MockSpec<CryptoService>()])
import 'crypto_service_test.mocks.dart';

void main() {
  late MockCryptoService mockCrypto;

  setUp(() {
    mockCrypto = MockCryptoService();
  });

  test('encrypts message with session key', () {
    when(mockCrypto.encrypt(any, any)).thenReturn(encrypted);
    // ...
  });
}
```

### Riverpod Provider Testing

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  test('channel provider emits channels', () async {
    final container = ProviderContainer(overrides: [
      channelServiceProvider.overrideWithValue(mockService),
    ]);
    addTearDown(container.dispose);

    final channels = container.read(channelsProvider);
    expect(channels, hasLength(2));
  });
}
```

### Widget Test Pattern

```dart
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('home screen shows peer list', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [...],
        child: MaterialApp(home: HomeScreen()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Contacts'), findsOneWidget);
  });
}
```

## Flutter Version

All CI workflows pin the Flutter version via an environment variable:

```yaml
env:
  FLUTTER_VERSION: '3.38.5'
```

This ensures consistent behavior across all CI jobs and local development.
