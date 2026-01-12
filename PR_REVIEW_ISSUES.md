# PR #1 Review Issues - Consolidated

> Consolidated from 4 code reviews. Last updated: 2026-01-11

## Summary

| Severity | Total | Fixed | Open |
|----------|-------|-------|------|
| Critical/High | 15 | 15 | 0 |
| Medium | 14 | 14 | 0 |
| Low | 12 | 11 | 1 |
| **Total** | **41** | **40** | **1** |

---

## Critical / High Severity

| # | Issue | File(s) | Status |
|---|-------|---------|--------|
| 1 | **Directory Traversal Vulnerability** - Path validation bypassed with URL encoding | `server/index.ts` | ✅ Fixed |
| 2 | **localStorage XSS Vulnerability** - Private keys accessible to any script on domain | `crypto.ts:29-60` | ✅ Fixed (memory-only keys) |
| 3 | **No Key Verification (MITM Risk)** - Trusts signaling server completely | `crypto.ts`, `App.tsx` | ✅ Fixed (FingerprintDisplay, verifyPeerKey, KeyChangeWarning) |
| 4 | **Pairing Code Enumeration Attack** - Server reveals if codes exist | `handler.ts:478-485` | ✅ Fixed (generic errors) |
| 5 | **DoS via Unbounded Request Storage** - No limit on pending pair requests | `handler.ts:502-506` | ✅ Fixed (10 req limit) |
| 6 | **Memory Leak: Timer References** - setTimeout never cancelled on disconnect | `handler.ts:518-520` | ✅ Fixed |
| 7 | **Missing Security Headers** - No CSP, X-Frame-Options | `server/index.ts` | ✅ Fixed |
| 8 | **No Message Size Limits (DoS)** - WebSocket/WebRTC messages not validated | `signaling.ts`, `webrtc.ts` | ✅ Fixed (1MB limit) |
| 9 | **No Rate Limiting** - No per-IP/connection limits | `handler.ts` | ✅ Fixed (100 msgs/min) |
| 10 | **Stale Closure Bug** - peerCode captured in closures becomes stale | `App.tsx:103, 137` | ✅ Fixed (useRef) |
| 11 | **Race Condition in Signaling State** - State changed before WebSocket send | `signaling.ts:207-209` | ✅ Fixed |
| 12 | **Race Condition in Callback Management** - onSignalingMessage overwritten for each connection | `connection_manager.dart` | ✅ Fixed (Stream-based callbacks) |
| 13 | **Stale Public Key Cache** - regenerateIdentityKeys doesn't update cache | `crypto_service.dart:247-250` | ✅ Fixed |
| 14 | **No File Size Validation** - Memory exhaustion via large files | `App.tsx` | ✅ Fixed (100MB limit) |
| 15 | **No Replay Protection for File Chunks** - encryptBytes/decryptBytes lack sequence numbers | `crypto.ts` | ✅ Fixed (bitmap-based sliding window) |

---

## Medium Severity

| # | Issue | File(s) | Status |
|---|-------|---------|--------|
| 16 | **Missing Input Validation** - Pairing codes not validated client-side | `signaling.ts` | ✅ Fixed |
| 17 | **Public Key Validation** - No length/format check on peer public keys | `crypto.ts:60-62` | ✅ Fixed |
| 18 | **Resource Leaks** - WebSocket/Signaling subscriptions not always cleaned | `signaling_client.dart`, `connection_manager.dart` | ✅ Fixed (proper dispose) |
| 19 | **Unsafe Null Assertions** - Non-null assertions in connection_manager | `connection_manager.dart` | ✅ Fixed (null checks) |
| 20 | **No Runtime Type Validation** - Signaling messages not validated | `signaling.ts` | ✅ Fixed (validation.ts) |
| 21 | **Missing Test Coverage** - No tests for web client TypeScript code | `packages/web-client/` | ✅ Fixed (274+ tests) |
| 22 | **Missing Test Coverage** - publicKeyBase64 getter lacks Dart tests | `crypto_service.dart` | ✅ Fixed |
| 23 | **No Certificate Pinning** - WSS connection vulnerable to MITM at signaling layer | `signaling.ts` | ✅ Fixed (PinnedWebSocket for Flutter, browser handles web) |
| 24 | **File Transfer Error Handling** - No chunk retry, silent failures | `App.tsx`, `webrtc.ts` | ✅ Fixed (reliable transfer protocol) |
| 25 | **Handshake Verification** - WebRTC handshake doesn't verify key from signaling | `App.tsx` | ✅ Fixed |
| 26 | **Unbounded Array Growth** - Messages/transfers arrays could grow | `App.tsx:26-27` | ✅ Fixed (MAX limits) |
| 27 | **VPS Server Message Size Validation** - No size check before JSON.parse, potential DoS | `handler.ts` | ✅ Fixed (64KB limit) |
| 28 | **Replay Window Memory Leak** - seenSequences Set grows unbounded | `crypto.ts` | ✅ Fixed (bitmap sliding window, auto-cleanup) |
| 29 | **Missing displayName/XSS Validation** - User-controlled strings not sanitized | Multiple files | ✅ Fixed (validation.ts with sanitization) |

---

## Low Severity

| # | Issue | File(s) | Status |
|---|-------|---------|--------|
| 30 | **ICE Candidate Timing** - Candidates added before setRemoteDescription | `webrtc.ts` | ✅ Fixed (pendingCandidates queue) |
| 31 | **No Backpressure in File Transfer** - No bufferedAmount check | `webrtc.ts` | ✅ Fixed (HIGH/LOW_WATER_MARK) |
| 32 | **Magic Numbers** - Constants scattered, not centralized | Multiple files | ✅ Fixed (constants.ts) |
| 33 | **Inconsistent Error Handling** - Some log, some silently fail | Multiple files | ✅ Fixed (consistent logging) |
| 34 | **File Transfer Status** - 'receiving' used for sending files too | `App.tsx:250` | ✅ Fixed |
| 35 | **Timeout Too Short** - 60s may be too short for fingerprint verification | `handler.ts` | ✅ Fixed (configurable timeout) |
| 36 | **Modulo Bias** - Random generation with % operator | `signaling.ts` | ✅ Fixed (rejection sampling) |
| 37 | **Error Swallowing** - Empty catch blocks hide failures | Multiple files | ✅ Fixed (proper error propagation) |
| 38 | **Information Disclosure** - Pairing codes logged | Multiple files | ✅ Fixed (masked logging) |
| 39 | **No PWA Support** - No service worker, manifest | `packages/web-client/` | ✅ Fixed (pwa.ts, manifest.json) |
| 40 | **No Accessibility** - Missing ARIA labels, keyboard nav | `packages/web-client/` | ✅ Fixed (ARIA labels, roles, keyboard nav) |
| 41 | **Pairing Code Entropy** - 30-bit entropy (6 chars from 32-char alphabet) | `signaling.ts` | 🔶 Monitor (acceptable for current scale) |

---

## Completion Summary

### All Critical/High Issues Fixed ✅
- MITM protection via fingerprint display and key verification
- Callback race condition fixed with stream-based architecture
- All memory leaks patched
- All DoS vectors mitigated

### All Medium Issues Fixed ✅
- Comprehensive test coverage added (274+ tests)
- Certificate pinning for Flutter app
- Runtime type validation for all messages
- Reliable file transfer protocol with retry

### Low Issues: 11/12 Fixed ✅
- Only #41 (pairing code entropy) marked for monitoring
- Current 30-bit entropy acceptable up to ~33k simultaneous codes

---

## Notes

- All issues addressed in feature/web-client-pairing branch
- Test coverage includes: crypto.ts, signaling.ts, webrtc.ts, validation.ts
- Certificate pinning implemented via native platform channels for iOS/Android
- Web clients rely on browser TLS validation (pinning not possible in browser)
