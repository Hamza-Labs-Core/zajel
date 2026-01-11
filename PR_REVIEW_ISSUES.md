# PR #1 Review Issues - Consolidated

> Consolidated from 4 code reviews. Last updated: 2026-01-11

## Summary

| Severity | Total | Fixed | Open |
|----------|-------|-------|------|
| Critical/High | 15 | 14 | 1 |
| Medium | 14 | 3 | 11 |
| Low | 12 | 0 | 12 |
| **Total** | **41** | **17** | **24** |

---

## Critical / High Severity

| # | Issue | File(s) | Status |
|---|-------|---------|--------|
| 1 | **Directory Traversal Vulnerability** - Path validation bypassed with URL encoding | `server/index.ts` | ✅ Fixed |
| 2 | **localStorage XSS Vulnerability** - Private keys accessible to any script on domain | `crypto.ts:29-60` | ✅ Fixed (memory-only keys) |
| 3 | **No Key Verification (MITM Risk)** - Trusts signaling server completely. Fingerprints added but no UI flow forcing verification, no Safety Numbers, no TOFU, no QR verification | `crypto.ts:103-111`, `App.tsx:102-105` | 🔶 Partial |
| 4 | **Pairing Code Enumeration Attack** - Server reveals if codes exist | `handler.ts:478-485` | ✅ Fixed (generic errors) |
| 5 | **DoS via Unbounded Request Storage** - No limit on pending pair requests | `handler.ts:502-506` | ✅ Fixed (10 req limit) |
| 6 | **Memory Leak: Timer References** - setTimeout never cancelled on disconnect | `handler.ts:518-520` | ✅ Fixed |
| 7 | **Missing Security Headers** - No CSP, X-Frame-Options | `server/index.ts` | ✅ Fixed |
| 8 | **No Message Size Limits (DoS)** - WebSocket/WebRTC messages not validated | `signaling.ts`, `webrtc.ts` | ✅ Fixed (1MB limit) |
| 9 | **No Rate Limiting** - No per-IP/connection limits | `handler.ts` | ✅ Fixed (100 msgs/min) |
| 10 | **Stale Closure Bug** - peerCode captured in closures becomes stale | `App.tsx:103, 137` | ✅ Fixed (useRef) |
| 11 | **Race Condition in Signaling State** - State changed before WebSocket send | `signaling.ts:207-209` | ✅ Fixed |
| 12 | **Race Condition in Callback Management** - onSignalingMessage overwritten for each connection | `connection_manager.dart:150-154` | ❌ Open |
| 13 | **Stale Public Key Cache** - regenerateIdentityKeys doesn't update cache | `crypto_service.dart:247-250` | ✅ Fixed |
| 14 | **No File Size Validation** - Memory exhaustion via large files | `App.tsx` | ✅ Fixed (100MB limit) |
| 15 | **No Replay Protection for File Chunks** - encryptBytes/decryptBytes lack sequence numbers | `crypto.ts` | ✅ Fixed |

---

## Medium Severity

| # | Issue | File(s) | Status |
|---|-------|---------|--------|
| 16 | **Missing Input Validation** - Pairing codes not validated client-side | `signaling.ts` | ✅ Fixed |
| 17 | **Public Key Validation** - No length/format check on peer public keys | `crypto.ts:60-62` | ✅ Fixed |
| 18 | **Resource Leaks** - WebSocket/Signaling subscriptions not always cleaned | `signaling_client.dart:63`, `connection_manager.dart:95` | ❌ Open |
| 19 | **Unsafe Null Assertions** - Non-null assertions in connection_manager | `connection_manager.dart:152,159,283,288` | ❌ Open |
| 20 | **No Runtime Type Validation** - Signaling messages not validated | `signaling.ts:77` | ❌ Open |
| 21 | **Missing Test Coverage** - No tests for web client TypeScript code | `packages/web-client/` | ❌ Open |
| 22 | **Missing Test Coverage** - publicKeyBase64 getter lacks Dart tests | `crypto_service.dart:44-49` | ❌ Open |
| 23 | **No Certificate Pinning** - WSS connection vulnerable to MITM at signaling layer | `signaling.ts` | ❌ Open |
| 24 | **File Transfer Error Handling** - No chunk retry, silent failures | `App.tsx:268-290` | ❌ Open |
| 25 | **Handshake Verification** - WebRTC handshake doesn't verify key from signaling | `App.tsx:96-99` | ❌ Open |
| 26 | **Unbounded Array Growth** - Messages/transfers arrays could grow | `App.tsx:26-27` | ✅ Fixed (MAX limits) |
| 27 | **VPS Server Message Size Validation** - No size check before JSON.parse, potential DoS | `handler.ts:240` | ❌ Open |
| 28 | **Replay Window Memory Leak** - seenSequences Set grows unbounded in one-way communication | `crypto.ts:210-221` | ❌ Open |
| 29 | **Missing displayName/XSS Validation** - User-controlled strings not sanitized | Multiple files | ❌ Open |

---

## Low Severity

| # | Issue | File(s) | Status |
|---|-------|---------|--------|
| 30 | **ICE Candidate Timing** - Candidates added before setRemoteDescription | `webrtc.ts:86-89` | ❌ Open |
| 31 | **No Backpressure in File Transfer** - No bufferedAmount check | `webrtc.ts` | ❌ Open |
| 32 | **Magic Numbers** - Constants scattered, not centralized | Multiple files | ❌ Open |
| 33 | **Inconsistent Error Handling** - Some log, some silently fail | Multiple files | ❌ Open |
| 34 | **File Transfer Status** - 'receiving' used for sending files too | `App.tsx:250` | ❌ Open |
| 35 | **Timeout Too Short** - 60s may be too short for fingerprint verification | `handler.ts:153` | ❌ Open |
| 36 | **Modulo Bias** - Random generation with % operator | `signaling.ts` | ❌ Open |
| 37 | **Error Swallowing** - Empty catch blocks hide failures | Multiple files | ❌ Open |
| 38 | **Information Disclosure** - Pairing codes logged | Multiple files | ❌ Open |
| 39 | **No PWA Support** - No service worker, manifest | `packages/web-client/` | ❌ Open |
| 40 | **No Accessibility** - Missing ARIA labels, keyboard nav | `packages/web-client/` | ❌ Open |
| 41 | **Pairing Code Entropy** - 30-bit entropy (6 chars from 32-char alphabet), collisions likely at ~33k active codes | `signaling.ts:52-57` | ❌ Open (monitor) |

---

## Priority Order for Remaining Issues

### Must Fix (Security/Stability)
1. **#12** Race condition in callback management (Dart) - Critical open
2. **#27** VPS server message size validation - DoS risk
3. **#28** Replay window memory leak - Long session stability
4. **#3** MITM mitigation UI - Add fingerprint display in connected state

### Should Fix (Quality)
5. **#18** Resource leaks in Dart subscriptions
6. **#19** Unsafe null assertions
7. **#24** File transfer error handling
8. **#25** Handshake key verification
9. **#21-22** Test coverage

### Nice to Have
10. **#29** Input sanitization
11. **#30-41** Low severity items

---

## Notes

- Issues marked ✅ Fixed have been addressed in commits up to `7d98339`
- Issues marked 🔶 Partial have partial fixes but need additional work
- Issues marked ❌ Open need to be addressed
