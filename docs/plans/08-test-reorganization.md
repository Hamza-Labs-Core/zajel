# Plan 08: Test Reorganization

## Status: Proposed

## Problem Statement

The project has test files scattered across 10+ locations with inconsistent organization conventions, significant code duplication between platform-specific E2E directories, and mislabeled test levels in the server-vps package. This plan proposes a unified structure that reduces duplication, correctly labels test levels, and provides a clear convention for future tests.

---

## 1. Current Structure

```
zajel/
├── e2e-tests/                          # Android E2E (Appium + UiAutomator2)
│   ├── config.py                       # Appium server URLs, APK path, timeouts
│   ├── conftest.py                     # AppHelper (934 lines), HeadlessBob, alice/bob fixtures
│   ├── pytest.ini                      # 27 markers
│   └── tests/
│       ├── test_blocked_enhanced.py    (133 lines)
│       ├── test_calls.py              (258 lines)
│       ├── test_connection_states.py   (204 lines)  *** Android-only ***
│       ├── test_contacts.py           (133 lines)
│       ├── test_emoji_picker.py       (67 lines)
│       ├── test_file_transfer.py      (180 lines)
│       ├── test_headless_file_transfer.py  (73 lines)
│       ├── test_headless_messaging.py (121 lines)
│       ├── test_headless_notifications.py (133 lines)
│       ├── test_headless_pairing.py   (93 lines)
│       ├── test_media_settings.py     (96 lines)
│       ├── test_messaging.py          (106 lines)
│       ├── test_notifications.py      (81 lines)
│       ├── test_offline_peers.py      (103 lines)
│       ├── test_pairing.py            (126 lines)
│       ├── test_peer_management.py    (234 lines)
│       ├── test_protocol_headless.py  (259 lines) *** Android-only ***
│       ├── test_reconnection.py       (161 lines) *** Android-only ***
│       ├── test_settings.py           (208 lines)
│       └── test_signaling_headless.py (250 lines) *** Android-only ***
│
├── e2e-tests-linux/                    # Linux desktop E2E (AT-SPI + dogtail)
│   ├── config.py                       # App path, data dirs, timeouts
│   ├── conftest.py                     # LinuxAppHelper import, HeadlessBob (duplicate)
│   ├── linux_helper.py                 # AT-SPI automation helper (452 lines)
│   ├── pytest.ini                      # 24 markers (subset of Android)
│   └── tests/
│       ├── test_blocked_enhanced.py   (61 lines)
│       ├── test_calls.py             (57 lines)
│       ├── test_contacts.py          (43 lines)
│       ├── test_emoji_picker.py      (37 lines)
│       ├── test_file_transfer.py     (44 lines)
│       ├── test_headless_file_transfer.py (64 lines)
│       ├── test_headless_messaging.py (116 lines)
│       ├── test_headless_notifications.py (117 lines)
│       ├── test_headless_pairing.py  (83 lines)
│       ├── test_media_settings.py    (27 lines)
│       ├── test_messaging.py         (68 lines)
│       ├── test_notifications.py     (28 lines)
│       ├── test_offline_peers.py     (59 lines)
│       ├── test_pairing.py           (41 lines)
│       ├── test_peer_management.py   (57 lines)
│       └── test_settings.py          (31 lines)
│
├── e2e-tests-windows/                  # Windows desktop E2E (pywinauto + UIA)
│   ├── config.py                       # App exe path, timeouts
│   ├── conftest.py                     # WindowsAppHelper import, HeadlessBob (duplicate)
│   ├── windows_helper.py              # UIA automation helper (232 lines)
│   ├── pytest.ini                      # 6 markers (minimal)
│   └── tests/
│       ├── test_headless_messaging.py (81 lines)
│       ├── test_headless_pairing.py   (62 lines)
│       └── test_smoke.py             (57 lines)
│
├── packages/
│   ├── app/
│   │   ├── integration_test/           # Flutter integration tests
│   │   │   ├── app_test.dart
│   │   │   ├── chat_ui_e2e_test.dart
│   │   │   ├── connection_test.dart
│   │   │   ├── messaging_test.dart
│   │   │   ├── reconnection_e2e_test.dart
│   │   │   ├── voip_test.dart
│   │   │   └── voip_ui_e2e_test.dart
│   │   └── test/
│   │       ├── widget_test.dart                      # Root-level orphan
│   │       ├── core/                                 # By-source-structure convention
│   │       │   ├── media/media_service_test.dart
│   │       │   ├── network/
│   │       │   │   ├── connection_manager_test.dart
│   │       │   │   ├── meeting_point_service_test.dart
│   │       │   │   ├── peer_reconnection_service_test.dart
│   │       │   │   ├── pinned_websocket_test.dart
│   │       │   │   ├── relay_client_introduction_test.dart
│   │       │   │   ├── relay_client_load_test.dart
│   │       │   │   ├── relay_client_source_id_test.dart
│   │       │   │   ├── relay_client_test.dart
│   │       │   │   ├── signaling_client_test.dart
│   │       │   │   └── voip_service_test.dart
│   │       │   ├── notifications/notification_service_test.dart
│   │       │   └── providers/
│   │       │       ├── chat_messages_test.dart
│   │       │       └── theme_mode_test.dart
│   │       ├── e2e/                                  # By-test-level convention
│   │       │   ├── connection_test.dart
│   │       │   └── server_discovery_test.dart
│   │       ├── integration/                          # By-test-level convention
│   │       │   ├── reconnection_flow_test.dart
│   │       │   ├── signaling_reconnect_test.dart
│   │       │   └── signaling_rendezvous_test.dart
│   │       ├── unit/                                 # By-test-level convention
│   │       │   ├── crypto/
│   │       │   │   ├── bootstrap_verifier_test.dart
│   │       │   │   └── crypto_service_test.dart
│   │       │   ├── models/
│   │       │   │   ├── message_test.dart
│   │       │   │   └── peer_test.dart
│   │       │   ├── network/rendezvous_service_test.dart
│   │       │   └── protocol/message_protocol_test.dart
│   │       └── widget/                               # By-test-level convention
│   │           ├── call/
│   │           │   ├── call_screen_test.dart
│   │           │   └── incoming_call_dialog_test.dart
│   │           ├── chat/chat_screen_focus_test.dart
│   │           └── home_screen_test.dart
│   │
│   ├── server/                         # CF Workers signaling server
│   │   ├── vitest.config.js
│   │   ├── src/__tests__/              # Unit tests (co-located with source)
│   │   │   ├── relay-registry-do.test.js
│   │   │   ├── relay-registry.test.js
│   │   │   ├── rendezvous-registry.test.js
│   │   │   └── websocket-handler.test.js
│   │   └── tests/
│   │       ├── signing.test.js         # Unit test (mislabeled location)
│   │       └── e2e/
│   │           ├── bootstrap.test.js   # Uses MockStorage/MockState (unit-level mocks)
│   │           └── integration.test.js # Uses real CF Worker bindings
│   │
│   ├── server-vps/                     # VPS signaling/relay server
│   │   ├── vitest.config.ts
│   │   └── tests/
│   │       ├── harness/                # Test helpers (MockBootstrapServer, TestServerHarness)
│   │       │   ├── index.ts
│   │       │   ├── mock-bootstrap.ts
│   │       │   └── server-harness.ts
│   │       ├── unit/                   # Correctly labeled
│   │       │   ├── client-handler-call-signaling.test.ts
│   │       │   ├── client-handler-pairing.test.ts
│   │       │   ├── client-handler-rendezvous.test.ts
│   │       │   ├── hash-ring.test.ts
│   │       │   ├── identity.test.ts
│   │       │   ├── relay-registry.test.ts
│   │       │   ├── rendezvous-registry.test.ts
│   │       │   └── storage.test.ts
│   │       ├── integration/            # MISLABELED: distributed-rendezvous uses mocks
│   │       │   ├── distributed-rendezvous.test.ts  # Uses real SQLite + HashRing but mock servers
│   │       │   └── real-server.test.ts             # Starts real servers, real WebSocket clients
│   │       └── e2e/                    # MISLABELED: these use mock bootstrap, localhost
│   │           ├── bootstrap-client.test.ts  # Real servers + mock bootstrap = integration
│   │           └── federation.test.ts        # Real servers + mock bootstrap = integration
│   │
│   ├── headless-client/                # Python headless client library
│   │   └── tests/                      # Flat structure, no level separation
│   │       ├── conftest.py             # crypto fixtures
│   │       ├── test_crypto.py          # Unit: CryptoService operations
│   │       ├── test_file_transfer.py   # Unit: FileTransferService with mocks
│   │       ├── test_protocol.py        # Unit: message serialization/deserialization
│   │       └── test_signaling.py       # Unit: pairing code generation
│   │
│   ├── integration-tests/              # Cross-app scenario tests
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── orchestrator.ts         # Test infrastructure (WebSocket helper, browser)
│   │       ├── test-constants.ts
│   │       ├── index.ts
│   │       └── scenarios/
│   │           ├── pairing-flow.test.ts    # VPS + WS clients: integration
│   │           ├── voip-flow.test.ts       # VPS + browsers (Playwright): integration
│   │           └── web-to-web.test.ts      # Real VPS + real browsers: true E2E
│   │
│   ├── web-client/                     # React web client
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── components/__tests__/   # Widget-level tests
│   │       │   ├── CallView.test.tsx
│   │       │   ├── ChatView.call.test.tsx
│   │       │   └── IncomingCallOverlay.test.tsx
│   │       └── lib/__tests__/          # Library tests (mixed levels)
│   │           ├── crypto.test.ts          # Unit
│   │           ├── e2e.test.ts             # Not real E2E (uses mocks) - integration
│   │           ├── integration.test.ts     # Integration (mock WebSocket)
│   │           ├── media.test.ts           # Unit
│   │           ├── signaling.test.ts       # Unit
│   │           ├── validation.test.ts      # Unit
│   │           ├── validation-xss.test.ts  # Unit
│   │           ├── voip.test.ts            # Unit/Integration
│   │           └── webrtc.test.ts          # Unit
│   │
│   └── admin-cf/                       # Admin dashboard (CF Workers)
│       ├── vitest.config.ts
│       └── tests/e2e/
│           └── admin-e2e.test.ts       # True E2E (hits live QA deployment)
```

---

## 2. Problems Identified

### 2.1 E2E Directory Duplication (Critical)

**Files duplicated across e2e-tests/ and e2e-tests-linux/ (15 test files):**

| Test File | Android (lines) | Linux (lines) | Logic Identical? |
|-----------|-----------------|---------------|------------------|
| test_blocked_enhanced.py | 133 | 61 | Same test flow, different helper API |
| test_calls.py | 258 | 57 | Same scenarios, Android has more tests |
| test_contacts.py | 133 | 43 | Same test flow |
| test_emoji_picker.py | 67 | 37 | Same test flow |
| test_file_transfer.py | 180 | 44 | Same test flow |
| test_headless_file_transfer.py | 73 | 64 | Nearly identical (helper differs) |
| test_headless_messaging.py | 121 | 116 | Nearly identical |
| test_headless_notifications.py | 133 | 117 | Nearly identical |
| test_headless_pairing.py | 93 | 83 | Nearly identical |
| test_media_settings.py | 96 | 27 | Same test flow |
| test_messaging.py | 106 | 68 | Same test flow |
| test_notifications.py | 81 | 28 | Same test flow |
| test_offline_peers.py | 103 | 59 | Same test flow |
| test_pairing.py | 126 | 41 | Same test flow |
| test_peer_management.py | 234 | 57 | Same test flow |
| test_settings.py | 208 | 31 | Same test flow |

**Root cause:** Each platform has a different UI automation backend (Appium/UiAutomator2 for Android, dogtail/AT-SPI for Linux, pywinauto/UIA for Windows), but the test *logic* is the same: pair, send message, verify, etc. The `AppHelper`, `LinuxAppHelper`, and `WindowsAppHelper` classes provide the same interface with different implementations.

**HeadlessBob class is copy-pasted 3 times** (identical in all three conftest.py files, ~60 lines each). The headless tests (test_headless_*.py) are especially close to identical since they only interact with one device via the helper, with the peer being the platform-agnostic headless client.

**Android-only tests (4 files, 874 lines):** `test_connection_states.py`, `test_protocol_headless.py`, `test_reconnection.py`, `test_signaling_headless.py` exist only in e2e-tests/ because Linux/Windows support was added later and these scenarios weren't ported.

### 2.2 Flutter Test Organization (Medium)

Two conflicting conventions coexist:
- **By test level:** `test/unit/`, `test/widget/`, `test/integration/`, `test/e2e/`
- **By source structure:** `test/core/network/`, `test/core/providers/`, `test/core/media/`

The `test/core/` subtree has 14 files that are all unit-level tests (they use mocks/fakes, no real services), but they sit outside the `test/unit/` directory. The orphan `test/widget_test.dart` in the root is a default Flutter scaffold test.

### 2.3 server-vps Test Level Mislabeling (Medium)

| File | Current Label | Actual Level | Reason |
|------|--------------|--------------|--------|
| `tests/e2e/bootstrap-client.test.ts` | E2E | **Integration** | Starts real servers but uses a mock bootstrap server on localhost. No external dependencies. |
| `tests/e2e/federation.test.ts` | E2E | **Integration** | Same: real servers + mock bootstrap, all localhost. |
| `tests/integration/distributed-rendezvous.test.ts` | Integration | **Integration** (correct) | Uses real SQLite + real HashRing but simulates multi-server topology with in-memory objects. |
| `tests/integration/real-server.test.ts` | Integration | **Integration** (correct) | Starts real servers with mock bootstrap, real WebSocket clients. Uses TestServerHarness. |

The "e2e" tests never hit an external service. They should be relabeled as integration tests.

### 2.4 headless-client Tests (Low)

All 4 tests are unit tests (test_crypto, test_protocol, test_signaling use no network; test_file_transfer uses mocks). The flat structure works for now but should be labeled.

### 2.5 integration-tests Package (Medium)

Contains 3 scenario tests that overlap with:
- `packages/server-vps/tests/e2e/` (pairing flow with WebSocket clients)
- `packages/web-client/src/lib/__tests__/e2e.test.ts` (web client E2E with mocks)

The `web-to-web.test.ts` is the only true E2E test (hits real deployed VPS). The other two (`pairing-flow.test.ts`, `voip-flow.test.ts`) spin up local servers with mock bootstrap, making them integration tests.

### 2.6 web-client Test Naming (Low)

`src/lib/__tests__/e2e.test.ts` uses mock WebSocket and mock WebRTC -- it is not E2E. It should be called `pairing-flow.test.ts` or `integration.test.ts` (but `integration.test.ts` already exists).

### 2.7 server (CF Workers) Test Location Split (Low)

Unit tests are split between `src/__tests__/` (4 files) and `tests/signing.test.js` (1 file). The `tests/e2e/` contains `bootstrap.test.js` (uses MockStorage -- unit-level) and `integration.test.js`.

---

## 3. Proposed Target Structure

### 3.1 Unified E2E Directory

```
e2e-tests/
├── conftest.py                     # Shared fixtures: HeadlessBob (single copy),
│                                   #   alice/bob fixture dispatch by platform
├── pytest.ini                      # Unified markers (superset of all platforms)
├── config.py                       # Platform-dispatched config
│
├── platforms/                      # Platform-specific helpers
│   ├── __init__.py                 # Platform detection + helper factory
│   ├── android_helper.py           # Current AppHelper from e2e-tests/conftest.py
│   ├── android_config.py           # Current e2e-tests/config.py
│   ├── linux_helper.py             # Current e2e-tests-linux/linux_helper.py
│   ├── linux_config.py             # Current e2e-tests-linux/config.py
│   ├── windows_helper.py           # Current e2e-tests-windows/windows_helper.py
│   └── windows_config.py           # Current e2e-tests-windows/config.py
│
├── tests/
│   ├── test_pairing.py             # Unified: uses helper.navigate_to_connect() etc.
│   ├── test_messaging.py
│   ├── test_calls.py
│   ├── test_settings.py
│   ├── test_contacts.py
│   ├── test_emoji_picker.py
│   ├── test_file_transfer.py
│   ├── test_notifications.py
│   ├── test_media_settings.py
│   ├── test_peer_management.py
│   ├── test_blocked_enhanced.py
│   ├── test_offline_peers.py
│   ├── test_connection_states.py
│   ├── test_reconnection.py
│   │
│   ├── test_headless_pairing.py    # Headless tests are already near-identical
│   ├── test_headless_messaging.py
│   ├── test_headless_file_transfer.py
│   ├── test_headless_notifications.py
│   │
│   ├── test_protocol_headless.py   # No-emulator protocol tests (headless only)
│   └── test_signaling_headless.py  # No-emulator signaling tests (headless only)
│
└── requirements.txt                # All platform deps (conditional install)
```

**Key design decisions:**
- `conftest.py` detects the platform from `ZAJEL_TEST_PLATFORM` env var (or auto-detects) and provides `alice`, `bob` fixtures that return the appropriate helper type.
- All platform helpers implement the same interface: `navigate_to_connect()`, `get_pairing_code_from_connect_screen()`, `enter_peer_code()`, `send_message()`, `has_message()`, etc.
- Tests use the helper interface only, never platform-specific APIs.
- `HeadlessBob` is defined once in conftest.py (currently copy-pasted 3 times).
- Platform-specific tests (e.g., `test_connection_states.py` which uses `terminate_app`/`activate_app`) get `@pytest.mark.android` markers and are skipped on other platforms.

### 3.2 Flutter Test Consolidation

```
packages/app/test/
├── unit/
│   ├── crypto/
│   │   ├── bootstrap_verifier_test.dart
│   │   └── crypto_service_test.dart
│   ├── models/
│   │   ├── message_test.dart
│   │   └── peer_test.dart
│   ├── network/
│   │   ├── connection_manager_test.dart        # Move from core/network/
│   │   ├── meeting_point_service_test.dart     # Move from core/network/
│   │   ├── peer_reconnection_service_test.dart # Move from core/network/
│   │   ├── pinned_websocket_test.dart          # Move from core/network/
│   │   ├── relay_client_introduction_test.dart # Move from core/network/
│   │   ├── relay_client_load_test.dart         # Move from core/network/
│   │   ├── relay_client_source_id_test.dart    # Move from core/network/
│   │   ├── relay_client_test.dart              # Move from core/network/
│   │   ├── rendezvous_service_test.dart        # Already in unit/network/
│   │   ├── signaling_client_test.dart          # Move from core/network/
│   │   └── voip_service_test.dart              # Move from core/network/
│   ├── media/
│   │   └── media_service_test.dart             # Move from core/media/
│   ├── notifications/
│   │   └── notification_service_test.dart      # Move from core/notifications/
│   ├── providers/
│   │   ├── chat_messages_test.dart             # Move from core/providers/
│   │   └── theme_mode_test.dart                # Move from core/providers/
│   └── protocol/
│       └── message_protocol_test.dart
│
├── widget/
│   ├── call/
│   │   ├── call_screen_test.dart
│   │   └── incoming_call_dialog_test.dart
│   ├── chat/
│   │   └── chat_screen_focus_test.dart
│   └── home_screen_test.dart
│
├── integration/
│   ├── reconnection_flow_test.dart
│   ├── signaling_reconnect_test.dart
│   └── signaling_rendezvous_test.dart
│
└── e2e/
    ├── connection_test.dart
    └── server_discovery_test.dart

# DELETE: test/widget_test.dart (default scaffold, superseded by widget/ tests)
# DELETE: test/core/ (all files moved to unit/)
```

### 3.3 server-vps Test Relabeling

```
packages/server-vps/tests/
├── harness/                        # (unchanged)
│   ├── index.ts
│   ├── mock-bootstrap.ts
│   └── server-harness.ts
├── unit/                           # (unchanged)
│   └── ... (8 files)
└── integration/
    ├── distributed-rendezvous.test.ts  # (unchanged)
    ├── real-server.test.ts             # (unchanged)
    ├── bootstrap-client.test.ts        # MOVED from e2e/
    └── federation.test.ts              # MOVED from e2e/
# DELETE: tests/e2e/ directory (empty after move)
```

### 3.4 headless-client Test Labeling

```
packages/headless-client/tests/
├── conftest.py                     # (unchanged)
└── unit/
    ├── test_crypto.py              # MOVED from tests/
    ├── test_file_transfer.py       # MOVED from tests/
    ├── test_protocol.py            # MOVED from tests/
    └── test_signaling.py           # MOVED from tests/
```

### 3.5 integration-tests Package Cleanup

```
packages/integration-tests/
├── vitest.config.ts
└── src/
    ├── orchestrator.ts
    ├── test-constants.ts
    ├── index.ts
    └── scenarios/
        ├── pairing-flow.test.ts    # Keep (integration: local VPS + WS clients)
        ├── voip-flow.test.ts       # Keep (integration: local VPS + browsers)
        └── web-to-web.test.ts      # Keep (E2E: real deployed VPS)
```

No structural change needed. The package name "integration-tests" is acceptable since most tests are integration-level. The `web-to-web.test.ts` is the exception (true E2E) but already self-documents this via its skip-in-CI logic and comments.

### 3.6 web-client Test Rename

Rename `src/lib/__tests__/e2e.test.ts` to `src/lib/__tests__/pairing-flow.test.ts` to avoid confusion with true E2E tests. The file uses mock WebSocket and mock WebRTC, making it an integration test at best.

### 3.7 server (CF Workers) Test Consolidation

```
packages/server/
├── vitest.config.js                # Update include path
├── src/__tests__/                  # Keep co-located unit tests
│   ├── relay-registry-do.test.js
│   ├── relay-registry.test.js
│   ├── rendezvous-registry.test.js
│   └── websocket-handler.test.js
└── tests/
    ├── unit/
    │   └── signing.test.js         # MOVED from tests/signing.test.js
    ├── integration/
    │   └── integration.test.js     # MOVED from tests/e2e/integration.test.js
    └── e2e/
        └── bootstrap.test.js       # Keep (uses MockStorage but tests full DO lifecycle)
```

Note: `bootstrap.test.js` uses MockStorage/MockState but exercises the Durable Object worker pattern end-to-end. This is debatable -- it could be labeled integration. Keeping it as-is since the CF Worker testing model is inherently mock-based (Miniflare).

---

## 4. Migration Steps

### Phase 1: E2E Unification (Highest Impact)

1. **Extract a platform helper interface** (Python abstract base class or protocol):
   ```python
   class PlatformHelper(Protocol):
       def wait_for_app_ready(self, timeout: int = 60) -> None: ...
       def navigate_to_connect(self) -> None: ...
       def get_pairing_code_from_connect_screen(self) -> str: ...
       def enter_peer_code(self, code: str) -> None: ...
       def go_back_to_home(self) -> None: ...
       def is_peer_connected(self, peer_name: str = None) -> bool: ...
       def open_chat_with_peer(self, peer_name: str = None) -> None: ...
       def send_message(self, text: str) -> None: ...
       def has_message(self, text: str) -> bool: ...
       # ... etc
   ```

2. **Move platform helpers** into `e2e-tests/platforms/`:
   - `e2e-tests/conftest.py` AppHelper class (lines 209-1014) -> `platforms/android_helper.py`
   - `e2e-tests-linux/linux_helper.py` -> `platforms/linux_helper.py` (as-is)
   - `e2e-tests-windows/windows_helper.py` -> `platforms/windows_helper.py` (as-is)

3. **Move platform configs** into `e2e-tests/platforms/`:
   - `e2e-tests/config.py` -> `platforms/android_config.py`
   - `e2e-tests-linux/config.py` -> `platforms/linux_config.py`
   - `e2e-tests-windows/config.py` -> `platforms/windows_config.py`

4. **Create platform factory** in `platforms/__init__.py`:
   ```python
   def get_platform() -> str:
       return os.environ.get("ZAJEL_TEST_PLATFORM", "android")

   def create_helper(platform: str, **kwargs) -> PlatformHelper:
       if platform == "android":
           from .android_helper import AppHelper
           return AppHelper(kwargs["driver"])
       elif platform == "linux":
           from .linux_helper import LinuxAppHelper
           return LinuxAppHelper(kwargs["app_path"], kwargs["data_dir"], kwargs.get("name", "zajel"))
       elif platform == "windows":
           from .windows_helper import WindowsAppHelper
           return WindowsAppHelper(kwargs["app_path"])
   ```

5. **Rewrite conftest.py** to use the factory. The `alice`/`bob` fixtures dispatch based on platform.

6. **Consolidate HeadlessBob**: Define once in conftest.py (remove from linux/windows conftest.py).

7. **Unify test files**: For each duplicated test file, take the more complete version (usually Android) and rewrite it to use the helper interface instead of platform-specific APIs like `app_helper(alice)` or `alice.find_by_name()`.

8. **Add platform skip markers**: Tests that use platform-specific features (e.g., `terminate_app()` for Android) get `@pytest.mark.android`.

9. **Delete** `e2e-tests-linux/` and `e2e-tests-windows/` directories.

10. **Update CI**: Change workflow commands from separate directories to unified with env var:
    - Android: `cd e2e-tests && ZAJEL_TEST_PLATFORM=android pytest`
    - Linux: `cd e2e-tests && ZAJEL_TEST_PLATFORM=linux pytest`
    - Windows: `cd e2e-tests && ZAJEL_TEST_PLATFORM=windows pytest`

### Phase 2: Flutter Test Consolidation

1. **Move all `test/core/` files** to `test/unit/` preserving subdirectory structure:
   - `test/core/network/*.dart` -> `test/unit/network/*.dart`
   - `test/core/media/*.dart` -> `test/unit/media/*.dart`
   - `test/core/notifications/*.dart` -> `test/unit/notifications/*.dart`
   - `test/core/providers/*.dart` -> `test/unit/providers/*.dart`

2. **Delete** `test/widget_test.dart` (default scaffold).

3. **Delete** `test/core/` directory (empty after move).

4. **Update imports**: Any import paths in moved files that reference other files.

5. **Verify**: Run `flutter test` to confirm nothing broke.

### Phase 3: server-vps Relabeling

1. **Move** `tests/e2e/bootstrap-client.test.ts` -> `tests/integration/bootstrap-client.test.ts`
2. **Move** `tests/e2e/federation.test.ts` -> `tests/integration/federation.test.ts`
3. **Delete** `tests/e2e/` directory.
4. **Update** vitest.config.ts if it has path-specific includes (currently `tests/**/*.test.ts` which covers all subdirectories, so no change needed).
5. **Update** CI workflow `server-vps-tests.yml` if it references `tests/e2e/` path specifically.

### Phase 4: headless-client Labeling

1. **Create** `tests/unit/` directory.
2. **Move** all 4 test files from `tests/` to `tests/unit/`.
3. **Update** any pytest configuration or import paths.

### Phase 5: Minor Cleanups

1. **Rename** `packages/web-client/src/lib/__tests__/e2e.test.ts` to `pairing-flow.test.ts`.
2. **Move** `packages/server/tests/signing.test.js` to `packages/server/tests/unit/signing.test.js`.
3. **Update** vitest include path if needed.

---

## 5. Duplication Analysis

### Exact Duplicates (HeadlessBob)

The `HeadlessBob` class is byte-for-byte identical across all 3 conftest.py files (lines 60-121 in linux, lines 32-94 in windows, lines 1029-1091 in android). All three:
- Create an asyncio event loop in a background thread
- Wrap `ZajelHeadlessClient` methods synchronously
- Provide connect/pair_with/wait_for_pair/send_text/receive_message/send_file/receive_file/disconnect

**Savings**: ~120 lines removed (2 copies eliminated).

### Near-Duplicate Tests (Headless Tests)

The `test_headless_*.py` files differ only in:
1. Module docstring ("Flutter app on emulator" vs "Flutter Linux app" vs "Flutter Windows app")
2. Helper creation (`app_helper(alice)` vs direct `alice` fixture)
3. Minor string literals ("Hello from Alice!" vs "Hello from Linux Alice!" vs "Hello from Windows Alice!")

These can be unified with zero behavioral change by:
- Using the platform-dispatched `alice` fixture
- Using a generic message string

**Savings**: ~500 lines removed across 8 duplicate files.

### Structurally Identical Tests (UI Tests)

The non-headless tests (test_pairing, test_messaging, test_calls, etc.) have the same test scenarios but different implementation:
- Android tests use `app_helper(driver)` pattern with XPath selectors
- Linux tests call `alice.click("Connect")` directly via AT-SPI
- Windows tests call `alice.click("Connect")` directly via UIA

After unifying the helper interface, the test files become platform-agnostic. The Android versions are typically more comprehensive (more test cases), so those become the canonical versions.

**Savings**: ~1000 lines removed across 15 duplicate files.

### Total Estimated Savings: ~1620 lines of duplicated test code eliminated.

---

## 6. CI Pipeline Changes

### Current Workflows Affected

| Workflow | Current Behavior | Change Needed |
|----------|-----------------|---------------|
| `pr-pipeline.yml` | Runs E2E tests from `e2e-tests/` | Update path to unified `e2e-tests/`, add `ZAJEL_TEST_PLATFORM=android` |
| (hypothetical linux CI) | Would run from `e2e-tests-linux/` | Update to `e2e-tests/` with `ZAJEL_TEST_PLATFORM=linux` |
| (hypothetical windows CI) | Would run from `e2e-tests-windows/` | Update to `e2e-tests/` with `ZAJEL_TEST_PLATFORM=windows` |
| `flutter-tests.yml` | Runs `flutter test` from `packages/app` | No change needed (flutter test discovers all tests recursively) |
| `server-vps-tests.yml` | Runs unit tests, then "E2E tests" | Rename "E2E Tests" job to "Integration Tests" |
| `server-tests.yml` | Runs unit tests, then "E2E tests" | No structural change needed |
| `web-client-tests.yml` | Runs `npm run test:run` | No change needed |
| `integration-tests.yml` | Runs from `packages/integration-tests` | No change needed |

### New CI Configuration

For the unified E2E directory, CI workflows set the platform via env var:

```yaml
# Android E2E (existing pr-pipeline.yml)
- name: Run E2E tests
  working-directory: e2e-tests
  env:
    ZAJEL_TEST_PLATFORM: android
    APPIUM_SERVER_COUNT: "2"
  run: pytest -m "not protocol" --timeout=300

# Linux E2E
- name: Run E2E tests (Linux)
  working-directory: e2e-tests
  env:
    ZAJEL_TEST_PLATFORM: linux
    ZAJEL_APP_PATH: ${{ steps.build.outputs.app_path }}
  run: pytest --timeout=300

# Windows E2E
- name: Run E2E tests (Windows)
  working-directory: e2e-tests
  env:
    ZAJEL_TEST_PLATFORM: windows
    ZAJEL_APP_PATH: ${{ steps.build.outputs.app_path }}
  run: pytest -m "smoke or headless" --timeout=300
```

---

## 7. Risk Assessment

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| E2E tests break during unification | CI pipeline failures, blocked PRs | Do the migration on a feature branch. Run Android E2E CI to verify before merging. Keep the old directories until CI passes. |
| Platform-specific test logic gets lost | Tests pass on one platform, fail on another | Review each test file diff carefully. Headless tests are safest to unify first. |
| Flutter import paths break | `flutter test` fails | Run `flutter test` locally after each batch of file moves. |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Helper interface is incomplete | Some tests can't be expressed platform-agnostically | Allow `@pytest.mark.{platform}` escape hatch for platform-specific tests. |
| server-vps path changes break CI | CI can't find test files | The vitest glob `tests/**/*.test.ts` covers all subdirectories, so moving within `tests/` is safe. Verify by running `npm test` locally. |
| Headless client test path changes break imports | pytest can't find tests | Update `testpaths` in pytest.ini if needed. |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| web-client rename breaks imports | One test reference breaks | Simple find-and-replace. |
| server signing.test.js move | Already isolated | Update vitest include if needed. |
| Orphaned .venv in e2e-tests/ | Disk space | `.gitignore` already excludes it. Delete manually if needed. |

---

## 8. Implementation Order

1. **Phase 1a**: Unify HeadlessBob and headless tests (lowest risk, highest duplication savings)
2. **Phase 1b**: Create platform factory and unify remaining E2E tests
3. **Phase 2**: Flutter test consolidation (independent of Phase 1)
4. **Phase 3**: server-vps relabeling (2-file move, trivial)
5. **Phase 4**: headless-client labeling (4-file move, trivial)
6. **Phase 5**: Minor cleanups (renames)

Phases 2-5 are independent and can be done in parallel on separate branches if desired.

---

## 9. Success Criteria

- [ ] Single `e2e-tests/` directory serves Android, Linux, and Windows
- [ ] `HeadlessBob` defined in exactly one file
- [ ] All 15 duplicated test files consolidated to one copy each
- [ ] `flutter test` passes with all tests under `test/{unit,widget,integration,e2e}/`
- [ ] No `test/core/` directory remains
- [ ] `packages/server-vps/tests/e2e/` directory removed; files in `tests/integration/`
- [ ] `packages/headless-client/tests/unit/` directory contains all 4 test files
- [ ] CI pipelines updated and passing for all platforms
- [ ] No test coverage regression (same number of test scenarios as before)
