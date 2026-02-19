# Plan 09c: Error Handling and Silent Failure Fixes

## Overview

17+ silent failure locations across 4 packages. Guiding principle: **minimal intervention** -- most fixes add logging at the appropriate level without changing control flow. Goal: make debugging possible when things go wrong in production.

**Already handled (no fix required)**: SF-H2 (federation redirect -- already logs at ERROR), SF-H8 (dead drop -- already logs at ERROR), SF-M2 (enumerateDevices -- already logs at ERROR)

---

## Phase 1: Logging-Only Changes (Zero Risk)

### SF-H1: Bootstrap client returns `[]` on error -- indistinguishable from "no peers"

**File**: `packages/server-vps/src/federation/bootstrap-client.ts:85-129`

**Problem**: When `getServers()` or `heartbeat()` fails, returns `[]`. Caller checks `if (peers.length > 0)` -- failed heartbeat looks identical to "no peers exist." VPS silently loses federation.

**Fix**:
```typescript
// In getServers():
} catch (error) {
  console.warn(`[Bootstrap] Get servers failed (returning empty - NOT the same as "no servers"):`, error);
  return [];
}

// In heartbeat():
} catch (error) {
  console.warn(`[Bootstrap] Heartbeat failed (returning empty - NOT the same as "no peers"):`, error);
  return [];
}
```

Also add visibility in `startHeartbeat` when peers is empty:
```typescript
} else {
  console.debug(`[Bootstrap] Heartbeat returned 0 peers`);
}
```

**Tests**: Run existing test suite. Verify new log lines appear in E2E test output.

---

### SF-H4: `parseQrData` returns null with zero logging

**File**: `packages/app/lib/core/network/device_link_service.dart:481-506`

**Problem**: Three different null-return paths, none logged. QR code scan fails silently -- debugging impossible.

**Fix**: Add `logger.warning` at each return-null path:
```dart
if (!qrData.startsWith(DeviceLinkConstants.qrProtocol)) {
  logger.warning('parseQrData',
      'QR data does not start with expected protocol prefix: '
      '${qrData.substring(0, qrData.length.clamp(0, 30))}...');
  return null;
}
// ... similar for parts.length < 3 and catch block
```

**Tests**:
```dart
test('parseQrData logs warning for invalid protocol prefix', () {
  final result = parseQrData('invalid://data');
  expect(result, isNull);
  // Verify logger.warning was called
});

test('parseQrData logs warning for insufficient parts', () {
  final result = parseQrData('${DeviceLinkConstants.qrProtocol}onlyonepart');
  expect(result, isNull);
});
```

---

### SF-H5: Bootstrap verifier `catch(_)` returns false for ANY error

**File**: `packages/app/lib/core/crypto/bootstrap_verifier.dart:47-72`

**Problem**: `catch (_)` discards exception completely. Security-relevant -- a programming bug could reject legitimate signatures with no diagnostic info.

**Fix**:
```dart
import '../logging/logger_service.dart';

} catch (e) {
  logger.warning('BootstrapVerifier',
      'Signature verification threw an exception (returning false)', e);
  return false;
}
```

**Tests**:
```dart
test('verify logs warning on internal exception', () async {
  // Pass malformed base64 as signature
  final result = await verifier.verify('{}', '!!!not-base64!!!');
  expect(result, isFalse);
  // Verify logger.warning was called with 'BootstrapVerifier'
});
```

---

### SF-H6 + SF-H7: Linked device message handling double-silent-failure

**File**: `packages/app/lib/core/network/connection_manager.dart:608-641`

**Problem**: Two layers of silent failure. `_parseLinkedDeviceMessage` swallows JSON parse errors (returns null). `_handleLinkedDeviceMessage` catches remaining exceptions with comment "Invalid message format - ignore". Linked web client messages silently dropped.

**Fix**:
```dart
// In _handleLinkedDeviceMessage:
if (parsed == null) {
  logger.warning('ConnectionManager',
      'Could not parse linked device message from $deviceId '
      '(length=${message.length})');
  return;
}
// ...
} catch (e) {
  logger.warning('ConnectionManager',
      'Error handling linked device message from $deviceId', e);
}

// In _parseLinkedDeviceMessage:
} catch (e) {
  logger.debug('ConnectionManager',
      'Failed to parse linked device JSON: $e');
  return null;
}
```

**Tests**:
```dart
test('logs warning when linked device message cannot be parsed', () {
  connectionManager.handleLinkedDeviceMessage('device1', 'not-json');
  // Verify logger.warning called
});

test('logs warning when linked device message processing throws', () {
  connectionManager.handleLinkedDeviceMessage('device1', '{"type":"unknown"}');
  // Verify logger.warning called
});
```

---

### SF-H9: Headless client decrypt at DEBUG level -- messages silently lost

**File**: `packages/headless-client/zajel/client.py:599-628`

**Problem**: Decryption failures logged at DEBUG. In production, DEBUG is typically disabled -- messages disappear silently. Critical for headless bot deployments.

**Fix**:
```python
# In _on_message_channel_data:
except Exception as e:
    logger.warning("Decrypt failed for %s: %s", peer_id, e)

# In _on_file_channel_data:
except Exception as e:
    logger.warning("File channel decrypt failed for %s: %s", peer_id, e)
```

**Tests**: Verify log output at WARNING level in existing decrypt-failure test scenarios.

---

### SF-M3: Headless protocol converts invalid JSON to "encrypted_text"

**File**: `packages/headless-client/zajel/protocol.py:119-137`

**Problem**: Valid JSON without `type` field silently treated as encrypted text. Could mask protocol bugs.

**Fix**: Add debug log for the fallback case:
```python
# Valid JSON but no 'type' field
logger.debug("Parsed JSON without 'type' field, treating as encrypted text: keys=%s",
             list(msg.keys()) if isinstance(msg, dict) else type(msg).__name__)
```

**Tests**:
```python
def test_parse_channel_message_logs_json_without_type(caplog):
    with caplog.at_level(logging.DEBUG):
        result = parse_channel_message('{"foo": "bar"}')
    assert result["type"] == "encrypted_text"
    assert "without 'type' field" in caplog.text
```

---

### SF-M4: `_loadOrGenerateIdentityKeys` catch(_) silently regenerates identity

**File**: `packages/app/lib/core/crypto/crypto_service.dart:327-339`

**Problem**: On storage corruption (not first run), user's identity silently changes. Warning would help distinguish first-run from corruption.

**Fix**:
```dart
} catch (e) {
  logger.warning('CryptoService',
      'Could not load identity key from storage - generating new keys', e);
}
```

**Tests**: Covered by Plan 09a (SF-C5).

---

### SF-M5: `_getSessionKey` catch(_) silently fails

**File**: `packages/app/lib/core/crypto/crypto_service.dart:370-383`

**Fix**:
```dart
} catch (e) {
  logger.debug('CryptoService',
      'Session key load failed for $peerId - will re-establish', e);
}
```

DEBUG level since session key re-establishment is expected and common.

**Tests**: Covered by Plan 09a (SF-C6).

---

### SF-M7: `disconnectPeer` catch(_) in chat_screen.dart

**File**: `packages/app/lib/features/chat/chat_screen.dart:833`

**Fix**:
```dart
} catch (e) {
  logger.debug('ChatScreen', 'Best-effort disconnect failed for ${peer.id}', e);
}
```

**Tests**: Covered by Plan 09a (SF-C4).

---

### SF-M8: `disconnectPeer` catch(_) in home_screen.dart

**File**: `packages/app/lib/features/home/home_screen.dart:472-476`

**Fix**:
```dart
} catch (e) {
  logger.debug('HomeScreen', 'Best-effort disconnect failed for ${peer.id}', e);
}
```

**Tests**: No behavioral test needed -- logging-only change.

---

### SF-M9: ICE candidate add error at DEBUG only

**File**: `packages/headless-client/zajel/webrtc.py:205-208`

**Fix**: Escalate to INFO (genuinely non-fatal but useful for debugging):
```python
except Exception as e:
    logger.info("ICE candidate add error (non-fatal): %s", e)
```

**Tests**: No new test needed.

---

## Phase 2: Minor Behavioral Awareness (Very Low Risk)

### SF-H3: App initialization failure -- app continues in broken state

**File**: `packages/app/lib/main.dart:116-169`

**Problem**: If crypto/storage/network init throws, error is logged but `_initialized = true` unconditionally. App shows home screen in partially initialized state.

**Fix**: Track success and log degraded state warning:
```dart
bool coreInitOk = false;
try {
  // ... existing init steps ...
  coreInitOk = true;
} catch (e, stack) {
  logger.error('ZajelApp', 'Initialization failed - app in degraded state', e, stack);
}

if (!coreInitOk) {
  logger.warning('ZajelApp',
      'App proceeding with incomplete initialization. '
      'Crypto, storage, or network services may not work.');
}
```

**Tests**:
```dart
test('logs warning when initialization fails', () async {
  // Mock crypto service to throw during initialize()
  // Verify: logger.warning called with 'incomplete initialization'
  // Verify: _initialized is still set to true (UI still shows)
});
```

---

### SF-M1: Notification init failure silently degrades

**File**: `packages/app/lib/core/notifications/notification_service.dart:48-61`

**Problem**: Init failure already logged at ERROR. But `show*Notification` methods silently skip when `!_initialized`. No indication first time notifications are suppressed.

**Fix**: Add one-time warning log:
```dart
bool _loggedInitWarning = false;

Future<void> showMessageNotification({...}) async {
  if (!_initialized) {
    if (!_loggedInitWarning) {
      logger.warning(_tag, 'Notification suppressed: service not initialized');
      _loggedInitWarning = true;
    }
    return;
  }
  // ... rest unchanged ...
```

**Tests**:
```dart
test('logs warning once when notification suppressed due to init failure', () async {
  // Create service without initializing
  await service.showMessageNotification(peerName: 'test', message: 'hi');
  await service.showMessageNotification(peerName: 'test', message: 'hi again');
  // Verify logger.warning called exactly once
});
```

---

### SF-H10: Admin CF auth silently removes token on network error

**File**: `packages/admin-cf/src/index.ts:540-542`

**Problem**: If `/admin/api/auth/verify` fails (transient network error), stored auth token removed and user silently logged out.

**Fix**:
```javascript
} catch (e) {
  console.warn('[Admin] Token verification failed, clearing session:', e.message || e);
  localStorage.removeItem('zajel_admin_token');
}
```

**Tests**: Manual -- verify console.warn appears on network disconnect in admin dashboard.

---

## Implementation Order

| Order | Issue | Package | Severity | Risk |
|-------|-------|---------|----------|------|
| 1 | SF-H1 | server-vps | High | Zero |
| 2 | SF-H5 | app | High | Zero |
| 3 | SF-H6+H7 | app | High | Zero |
| 4 | SF-H9 | headless | High | Zero |
| 5 | SF-H4 | app | High | Zero |
| 6 | SF-M4 | app | Medium | Zero |
| 7 | SF-M5 | app | Medium | Zero |
| 8 | SF-M7+M8 | app | Medium | Zero |
| 9 | SF-M3 | headless | Medium | Zero |
| 10 | SF-M9 | headless | Medium | Zero |
| 11 | SF-H3 | app | High | Very Low |
| 12 | SF-M1 | app | Medium | Very Low |
| 13 | SF-H10 | admin-cf | High | Very Low |

**Total new tests**: ~10 test cases across Flutter, Python, and TypeScript
