# Phase 1: Quick Wins (Low Effort, High Impact)

## Item 1: Fix Cross-Layer Import (FilteredEmojiPicker)

**Problem**: `shared/widgets/compose_bar.dart` imports from `features/chat/widgets/` — shared layer depends on feature layer.

**Files to Modify**:

| Action | File |
|--------|------|
| **Move** | `lib/features/chat/widgets/filtered_emoji_picker.dart` → `lib/shared/widgets/filtered_emoji_picker.dart` |
| **Update import** | `lib/shared/widgets/compose_bar.dart` line 6: change to `import 'filtered_emoji_picker.dart';` |

**Steps**:
1. Move `filtered_emoji_picker.dart` from `features/chat/widgets/` to `shared/widgets/`
2. Update import in `compose_bar.dart` to relative `filtered_emoji_picker.dart`
3. Search for any other imports of the old path and update them
4. Run `flutter analyze` and `flutter test test/`

**Risk**: Very Low — pure file move, no logic changes.

---

## Item 2: Add Salt to HKDF

**Problem**: All HKDF `deriveKey` calls use empty salt (`nonce: const []`). In the `cryptography` package, the `nonce` parameter IS the HKDF salt. Empty salt means HKDF uses a zero-filled key in the extract step, weakening domain separation.

**Critical**: Cross-platform breaking change — ALL clients (Dart, Python, Web) must be updated simultaneously.

### 4 HKDF Contexts and Their Salt Values

| Context | Info String | Salt Value |
|---------|------------|------------|
| Session key | `zajel_session` | `zajel-session-salt-v1` |
| Channel content | `zajel_channel_content_epoch_N` | `zajel-channel-salt-v1` |
| Upstream message | `zajel_upstream_message` | `zajel-upstream-salt-v1` |
| Device link | `zajel_link_tunnel_CODE` | `zajel-link-salt-v1` |

### Files to Modify

**Dart App:**

| File | Line(s) | Change |
|------|---------|--------|
| `lib/core/constants.dart` | New | Add salt constants to `CryptoConstants` |
| `lib/core/crypto/crypto_service.dart` | 345 | `nonce: const []` → `nonce: utf8.encode(CryptoConstants.hkdfSessionSalt)` |
| `lib/features/channels/services/channel_crypto_service.dart` | 183 | `nonce: const []` → `nonce: utf8.encode('zajel-channel-salt-v1')` |
| `lib/features/channels/services/upstream_service.dart` | 189, 302 | `nonce: const []` → `nonce: utf8.encode('zajel-upstream-salt-v1')` |

**Python Headless Client:**

| File | Line(s) | Change |
|------|---------|--------|
| `packages/headless-client/zajel/crypto.py` | 111 | `salt=b""` → `salt=b"zajel-session-salt-v1"` |
| `packages/headless-client/zajel/channels.py` | 761 | `salt=None` → `salt=b"zajel-channel-salt-v1"` |
| `packages/headless-client/zajel/channels.py` | 961, 1041 | `salt=None` → `salt=b"zajel-upstream-salt-v1"` |

**Web Client:**

| File | Line(s) | Change |
|------|---------|--------|
| `packages/web-client/src/lib/crypto.ts` | 264 | Add `const salt = new TextEncoder().encode('zajel-session-salt-v1');` and pass to hkdf |
| `packages/web-client/src/lib/deviceLink.ts` | 441 | Add `const salt = new TextEncoder().encode('zajel-link-salt-v1');` and pass to hkdf |

### Tests to Update

| File | Change |
|------|--------|
| `test/unit/crypto/cross_platform_test.dart` | Line 95: update `nonce` param; recompute expected hash on line 105 |
| `test/unit/crypto/crypto_service_test.dart` | Re-run; update any hardcoded expected key values |

**NOTE**: `meeting_point_service.dart` line 228 uses `nonce: const []` in an HMAC context (NOT HKDF) — do NOT change that.

**Risk**: Medium — protocol-breaking change requiring all 3 platforms updated simultaneously.

**Order**: Do this LAST in Phase 1.

---

## Item 3: Add Schema Validation on Server WebSocket Messages

**Problem**: `client/handler.ts` `handleMessage` method parses JSON and casts directly to typed interfaces via `as` (TypeScript type assertions with no runtime validation). Malicious clients can send messages with missing required fields.

**Existing validation**: Size check (line 589), rate limiting (line 597), JSON parse with error handling (line 604), peerId consistency check (line 614). Individual handlers do SOME validation but it's inconsistent.

### Files to Modify

| File | Change |
|------|--------|
| `packages/server-vps/src/client/handler.ts` | Add `validateMessage()` private method; call it after JSON parse before the switch statement |

### Validation Function

Add a `validateMessage(message: Record<string, unknown>): string | null` method that checks required fields per message type:

```
register       → pairingCode+publicKey OR peerId (string)
pair_request   → targetCode (string)
pair_response  → targetCode (string), accepted (boolean)
offer/answer/ice_candidate → target (string)
call_offer/answer/reject/hangup/ice → target (string)
link_request   → linkCode (string), publicKey (string)
link_response  → linkCode (string), accepted (boolean)
upstream-message → channelId (string), ephemeralPublicKey (string)
stream-start/frame/end → streamId (string), channelId (string)
channel-subscribe → channelId (string)
channel-owner-register → channelId (string)
chunk_announce → peerId (string), chunks (array)
chunk_request  → chunkId (string), channelId (string)
chunk_push     → chunkId (string), channelId (string)
update_load    → peerId (string)
register_rendezvous → peerId (string), relayId (string)
heartbeat      → peerId (string)
ping           → (no required fields)
attest_request → build_token (string), device_id (string)
attest_response → nonce (string), responses (array)
get_relays     → (no required fields)
```

Call after line 609:
```typescript
const validationError = this.validateMessage(message as Record<string, unknown>);
if (validationError) {
  this.sendError(ws, `Invalid message: ${validationError}`);
  return;
}
```

### Tests to Add

In `tests/unit/client-handler-pairing.test.ts` (or new file):
- `pair_request` without `targetCode` → error response
- `register` without `pairingCode` or `peerId` → error response
- Message with non-string `type` → error response
- All message types with missing required fields

**Risk**: Low — additive validation. Only checks required fields, not optional ones, preserving backward compatibility.

---

## Item 4: Guard E2E_TEST Flag

**Problem**: `E2E_TEST=true` compile-time flag auto-accepts ALL pair requests, disables bootstrap signature verification, forces relay mode, disables pinned WebSocket. If it leaks into a release build, it's a critical security bypass.

Currently defined in `lib/core/config/environment.dart` line 75:
```dart
static const bool isE2eTest = bool.fromEnvironment('E2E_TEST');
```

### Files to Modify

| File | Change |
|------|--------|
| `lib/core/config/environment.dart` | Add `assertNoE2eTestInRelease()` static method |
| `lib/main.dart` | Call assertion early in `main()` |

### Implementation

In `environment.dart`:
```dart
import 'package:flutter/foundation.dart';

static void assertNoE2eTestInRelease() {
  if (kReleaseMode && isE2eTest) {
    throw StateError(
      'FATAL: E2E_TEST=true must never be used in release builds. '
      'This flag disables security features including pair request approval.',
    );
  }
}
```

In `main.dart`, after `WidgetsFlutterBinding.ensureInitialized()`:
```dart
Environment.assertNoE2eTestInRelease();
```

**Note**: Using `if + throw` instead of `assert()` because `assert` is stripped from release builds and wouldn't fire when it matters most.

**Risk**: Very Low — safety net only fires on accidental misuse.

---

## Item 5: Add Error Boundary to handleDisconnect

**Problem**: `handleDisconnect` in `client/handler.ts` (line 2438) performs many cleanup operations. If any throws, remaining cleanup is skipped → resource leaks. Called from `ws.on('close')` (index.ts:338) — unhandled rejection could crash the process.

### Files to Modify

| File | Change |
|------|--------|
| `packages/server-vps/src/client/handler.ts` | Wrap each logical cleanup section in individual try/catch blocks |

### Implementation

Wrap each cleanup section independently:

```
Outer try/catch (prevents unhandled rejections) {
  try { attestation cleanup } catch { log warning }
  rate limiting cleanup (sync, can't throw)
  try { channel owner cleanup } catch { log warning }
  try { channel subscriber cleanup } catch { log warning }
  try { pairing code cleanup } catch { log warning }
  try { peerId + relay + rendezvous + chunk cleanup (async) } catch { log warning }
}
```

Each section failing independently ensures remaining cleanup still runs.

### Tests to Add

- `handleDisconnect does not throw when distributedRendezvous.unregisterPeer throws`
- `pairing code cleanup still happens even if channel owner cleanup throws`

**Risk**: Low — purely defensive. No behavioral changes for the success path.

---

## Recommended Execution Order

```
1 → 4 → 5 → 3 → 2
```

| Order | Item | Reason |
|-------|------|--------|
| 1st | Fix cross-layer import | Simplest, zero risk |
| 2nd | Guard E2E_TEST | Simple, important safety net |
| 3rd | Error boundary handleDisconnect | Defensive, low risk |
| 4th | Schema validation | Needs validation function + tests |
| 5th | HKDF salt | Protocol-breaking, needs all 3 platforms |
