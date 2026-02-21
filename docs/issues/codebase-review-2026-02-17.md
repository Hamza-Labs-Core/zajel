# Code Review: Plan05 Branch — Full Issue Index

**Branch**: `feat/plan05-channels-groups`
**Date**: 2026-02-17
**Scope**: All packages — server (CF Worker + VPS), Flutter app, web client, headless client, admin dashboard

## Summary

**107 issues** found across 5 review audits. Each issue has an ID, severity, and origin (pre-existing vs new in plan05).

| Category | Count | Origin |
|----------|-------|--------|
| Server Code (S1-S23) | 23 | Mixed |
| Flutter App (A1-A29) | 29 | 18 new (plan05) |
| Silent Failures (SF-C/H/M 1-32) | 32 | 16 new (plan05) |
| Web + Headless Client (CR-01-CR-23) | 23 | Mixed |

**Severity breakdown**:

| Severity | Count |
|----------|-------|
| Critical | 15 |
| High | 32 |
| Medium | 41 |
| Low | 19 |

---

## Server Code Issues (S1-S23)

### Critical

| ID | Description | File | Package |
|----|-------------|------|---------|
| S1 | Open redirect via `redirect` URL param — leaks admin JWT to attacker domain | `admin-cf/src/index.ts:603-610` | admin-cf |
| S2 | Bootstrap client missing auth headers — VPS registrations fail with 401 when auth configured | `server-vps/src/federation/bootstrap-client.ts:48-52` | server-vps |
| S3 | Server registry auth bypass when `SERVER_REGISTRY_SECRET` not configured — fail-open allows rogue server registration | `server/src/durable-objects/server-registry-do.js:96` | server |
| S4 | Reconnect logic bug — outer guard `!== 0` blocks infinite reconnects (configured as `0`), federation servers never reconnect | `server-vps/src/federation/transport/server-connection.ts:486-493` | server-vps |

### High

| ID | Description | File | Package |
|----|-------------|------|---------|
| S5 | Admin dashboard XSS via `state.error` injected into HTML unescaped | `admin-cf/src/index.ts:723,838` | admin-cf |
| S6 | Admin dashboard CORS wildcard (`*`) for admin API | `admin-cf/src/index.ts:30-31` | admin-cf |
| S7 | Admin CF health check fetches VPS `/stats` without auth — always returns 401 | `admin-cf/src/routes/servers.ts:108,130` | admin-cf |
| S8 | `timingSafeEqual` early-returns on length mismatch — leaks length info | `admin-cf/src/crypto.ts:206-216` | admin-cf |
| S9 | `selectRandomRegions` uses `Math.random()` for attestation challenges (not crypto-secure) | `server/src/durable-objects/attestation-registry-do.js:863` | server |
| S10 | Admin JWT stored in `localStorage` — XSS-accessible | `admin-cf/src/index.ts:600` | admin-cf |

### Medium

| ID | Description | File | Package |
|----|-------------|------|---------|
| S11 | JWT token passed in URL query parameter — leaked in logs/Referrer | `server-vps/src/admin/auth.ts:71-76` | server-vps |
| S12 | No `count` validation in `get_relays` — unbounded response | `server-vps/src/client/handler.ts:1016` | server-vps |
| S13 | `listServers` batch delete may exceed CF DO 128-key limit | `server/src/durable-objects/server-registry-do.js:297-299` | server |
| S14 | Admin WebSocket no re-authentication during long sessions | `server-vps/src/admin/websocket.ts` | server-vps |
| S15 | Attestation manager sends `build_token` instead of expected fields | `server-vps/src/attestation/attestation-manager.ts:288-291` | server-vps |
| S16 | Rate limiter in-memory — resets on CF Worker isolate eviction | `admin-cf/src/index.ts:19-21` | admin-cf |
| S17 | Admin module `handleRequest` race on `/admin` prefix — 503 during startup | `server-vps/src/index.ts:92-101` | server-vps |

### Low

| ID | Description | File | Package |
|----|-------------|------|---------|
| S18 | `void dummy` does not prevent dead-code elimination in timing-safe | `server/src/crypto/timing-safe.js:24` | server |
| S19 | `server.endpoint` injected into HTML attribute without escaping | `admin-cf/src/index.ts:781` | admin-cf |
| S20 | Health endpoint exposes serverId (full Ed25519 pubkey), env, uptime | `server-vps/src/index.ts:104-115` | server-vps |
| S21 | `generateJwt` signature spread may stack overflow on large signatures | `admin-cf/src/crypto.ts:101` | admin-cf |
| S22 | Heartbeat peers only reported when `peers.length > 0` — no "peers disappeared" signal | `server-vps/src/federation/bootstrap-client.ts:134-141` | server-vps |
| S23 | User ID from URL path not validated in admin-cf delete route | `admin-cf/src/index.ts:90` | admin-cf |

---

## Flutter App Issues (A1-A29)

### Critical

| ID | Severity | Description | File | Origin |
|----|----------|-------------|------|--------|
| A1 | Critical | `async void _handleSignalingMessage` — unhandled Future errors crash isolate | `connection_manager.dart:714` | Pre-existing |
| A7 | Critical | 3 stream subscriptions in `main.dart` never stored/cancelled — memory leak + duplicate listeners on reconnect | `main.dart:619,653,209` | Pre-existing |

### High

| ID | Description | File | Origin |
|----|-------------|------|--------|
| A2 | Null assertion on `_identityKeyPair!` after conditional load — crash if load fails silently | `crypto_service.dart:198,208` | Pre-existing |
| A3 | `encryptionKeyPrivate!` force-unwrap in channel publish — crash if subscriber reaches code | `channel_detail_screen.dart:402` | **NEW (plan05)** |
| A8 | Rendezvous event subscription in provider never cancelled | `app_providers.dart:188` | Pre-existing |
| A10 | Concurrent `sendMessage` can produce duplicate sequence numbers (no mutex) | `group_service.dart:256-257` | **NEW (plan05)** |
| A11 | `_ensureKeysLoaded` has no concurrency guard — duplicate key loading | `group_service.dart:45-52` | **NEW (plan05)** |
| A14 | Shell injection via `cmd /c start` with peer-controlled filePath on Windows | `chat_screen.dart:453` | Pre-existing |
| A15 | Group invitations auto-accepted without user confirmation — any peer can force-join | `group_invitation_service.dart:102-166` | **NEW (plan05)** |
| A18 | `Peer.props` missing `connectionState` — Riverpod won't rebuild on state change (stale UI) | `peer.dart:82` | Pre-existing |
| A19 | `Message.props` missing `content`, `status`, `type` — status changes don't trigger rebuild | `message.dart:94` | Pre-existing |
| A23 | `loadAllSenderKeys` reads ALL secure storage entries then filters — O(N) scan | `group_storage_service.dart:293-306` | **NEW (plan05)** |
| A24 | `getAllChannels` performs N+1 secure storage reads (3 per channel, sequential) | `channel_storage_service.dart:160-186` | **NEW (plan05)** |

### Medium

| ID | Description | File | Origin |
|----|-------------|------|--------|
| A4 | `selfMember` uses exception for control flow (broad `catch (_)`) | `group.dart:98-103` | **NEW** |
| A5 | `dispose()` reads Riverpod provider after widget disposal — may throw | `group_detail_screen.dart:50-58` | **NEW** |
| A6 | `TrustedPeer.fromPeer` crashes if peer ID shorter than 4 chars | `trusted_peers_storage.dart:195` | Pre-existing |
| A9 | `FocusNode()` created on every rebuild (never disposed) | `channel_detail_screen.dart:335` | **NEW** |
| A12 | `_handleChunkData` mutates possibly-shared map in place | `channel_sync_service.dart:335` | **NEW** |
| A13 | Fire-and-forget `Future.delayed` for rendezvous re-registration — fires after dispose | `connection_manager.dart:1075` | Pre-existing |
| A16 | Brute-force group decryption leaks timing info (tries all groups) | `group_invitation_service.dart:172-200` | **NEW** |
| A17 | `_connectToSignaling` uses `dynamic` parameter type | `main.dart:258` | Pre-existing |
| A20 | `Group.props` missing `selfDeviceId` | `group.dart:162` | **NEW** |
| A21 | `groupInvitationServiceProvider` uses empty string as `selfDeviceId` when not connected | `group_providers.dart:79` | **NEW** |
| A22 | `channelMessagesProvider` returns empty for subscribers when key not loaded (silent) | `channel_providers.dart:249-250` | **NEW** |
| A25 | `findGaps` performs N individual DB queries (one per sequence number) | `group_sync_service.dart:154-171` | **NEW** |
| A26 | `channelMessagesProvider` loads ALL chunks without pagination | `channel_providers.dart:253` | **NEW** |
| A27 | Inconsistent null-DB handling — `saveChannel` throws, `getAllChannels` returns empty | `channel_storage_service.dart:95-97,161-162` | **NEW** |

### Low

| ID | Description | File | Origin |
|----|-------------|------|--------|
| A28 | `_extractDeviceId` in WebRTC adapter assumes device ID has no underscores — differs from `_parseGroupPeerId` | `webrtc_p2p_adapter.dart:59-66` | **NEW** |
| A29 | `MemberConnection` is mutable where immutability expected (has `copyWith` but mutable fields) | `group_connection_service.dart:12-13` | **NEW** |

---

## Silent Failures (SF-C/H/M 1-32)

### Critical (SF-C1-C8)

| ID | Description | File | New? |
|----|-------------|------|------|
| SF-C1 | Empty catch hides disconnect errors during peer deletion | `chat_screen.dart:858` | No |
| SF-C2 | App init failure swallowed — app continues in broken state (`_initialized = true`) | `main.dart:178-180` | Partial |
| SF-C3 | Delivery receipt `except Exception: pass` — bare empty catch | `client.py:2452-2458` | No |
| SF-C4 | Channel chunk receive `catch (_) {}` — malformed chunks silently dropped, no logging | `channel_providers.dart:118-120` | **YES** |
| SF-C5 | Channel messages silently dropped during decryption — entire pipeline wrapped | `channel_providers.dart:287-289` | **YES** |
| SF-C6 | VPS channel registration failure silently ignored — no retry mechanism exists | `channel_providers.dart:157-159` | **YES** |
| SF-C7 | Attestation service silently fails to store session token — may cause re-attest loop | `attestation_service.dart:144-146` | **YES** |
| SF-C8 | Connection manager silently ignores linked device messages — no logging | `connection_manager.dart:698-700` | No |

### High (SF-H1-H10)

| ID | Description | File | New? |
|----|-------------|------|------|
| SF-H1 | Background sync returns `false` with no logging — OS may deprioritize future syncs | `background_sync_service.dart:542-544` | **YES** |
| SF-H2 | Channel sync silently drops JSON parse failures — chunks permanently lost | `channel_sync_service.dart:326-328` | **YES** |
| SF-H3 | `_parseLinkedDeviceMessage` returns null on any error — no logging | `connection_manager.dart:709-711` | No |
| SF-H4 | Admin websocket silently ignores malformed messages (covers handler errors too) | `websocket.ts:79-81` | **YES** |
| SF-H5 | Bootstrap signing failure degrades security silently — unsigned responses served | `server/src/index.js:122-125` | No |
| SF-H6 | `build_token.dart` parse returns null for any error — attestation silently degrades | `build_token.dart:43-45` | **YES** |
| SF-H7 | Attestation initializer "fail open" on version check error | `attestation_initializer.dart:99-103` | **YES** |
| SF-H8 | Server `verifyBuildToken` returns null for any error — invalid = absent token | `attestation.js:238-240` | **YES** |
| SF-H9 | Peer storage silently falls back to raw (possibly plaintext) session key on decrypt failure | `peer_storage.py:160-167` | No |
| SF-H10 | Federation transport silently drops connection errors during bootstrap — `.catch(() => {})` | `federation-manager.ts:372-374` | No |

### Medium (SF-M1-M12)

| ID | Description | File | New? |
|----|-------------|------|------|
| SF-M1 | Group model `selfMember` uses try-catch instead of null-safe lookup | `group.dart:99-104` | **YES** |
| SF-M2 | `CryptoService._loadKeys` silent fallback to key generation on ANY error | `crypto_service.dart:398-402` | No |
| SF-M3 | Bootstrap verifier timestamp check silently returns false | `bootstrap_verifier.dart:69-71` | No |
| SF-M4 | `displayNameWithTag` provider catches all exceptions | `app_providers.dart:92-95` | No |
| SF-M5 | stableId catch during handshake — all exceptions caught, stableId omitted | `connection_manager.dart:945-947` | No |
| SF-M6 | Channel crypto `verifySignature` catches all and returns false — no logging | `channel_crypto_service.dart:155-157,301-303` | **YES** |
| SF-M7 | Federation URL fallback to string concatenation on parse failure | `federation-manager.ts:324-328` | No |
| SF-M8 | Upstream signature verification error logged at `debug` — should be `warning` | `upstream_service.dart:393-398` | **YES** |
| SF-M9 | Group mesh activation failure logged but no user feedback | `group_detail_screen.dart:43-46` | **YES** |
| SF-M10 | Group message send errors caught per-member — message shows "sent" when delivery failed to ALL | `group_detail_screen.dart:299-302` | **YES** |
| SF-M11 | Admin CF `verifyJWT` catches all → null — server config errors silently lock out admins | `admin-cf/src/crypto.ts:160-162` | No |
| SF-M12 | Device link service silently fails to load linked devices | `device_link_service.dart:440-442` | No |

---

## Web + Headless Client Issues (CR-01-CR-23)

### Critical

| ID | Description | File | Package |
|----|-------------|------|---------|
| CR-02 | Headless client accepts mismatched handshake keys — WARNING only, proceeds with wrong key | `client.py:2373-2383` | headless |

### High

| ID | Description | File | Package |
|----|-------------|------|---------|
| CR-03 | Headless client does NOT send stableId in handshake — Flutter can't recognize peer across sessions | `client.py:2294` | headless |
| CR-04 | Python nonce replay set uses unordered eviction — old nonces may be retained while new evicted | `crypto.py:151` | headless |
| CR-05 | Web client `App.tsx` drops stableId from onHandshake callback — discarded even if peer sends it | `App.tsx:100` | web |
| CR-06 | DeviceLink handshake public key comparison is not constant-time | `deviceLink.ts:529` | web |
| CR-07 | DeviceLink sends handshake unencrypted despite having established tunnel session | `deviceLink.ts:510-519` | web |

### Medium

| ID | Description | File | Package |
|----|-------------|------|---------|
| CR-08 | Missing replay detection documentation for binary/file channel in headless | `crypto.py` | headless |
| CR-09 | Headless client logs pairing code in plaintext (web client masks it) | `signaling.py:153` | headless |
| CR-10 | Headless signaling has no message size validation (web client limits to 1MB) | `signaling.py:446-449` | headless |
| CR-11 | Headless has no data channel message size validation | `webrtc.py:247-250` | headless |
| CR-12 | Python client does not validate peer public key size before key exchange | `crypto.py:80-83` | headless |
| CR-13 | Headless stableId silently ignored during handshake parse | `client.py:2367-2388` | headless |
| CR-14 | Web client stableId validation silently drops malformed IDs (no warning) | `validation.ts:506-511` | web |
| CR-15 | DeviceLink sequence counter overflow — `setUint32` silently wraps at 2^32 | `deviceLink.ts:642-647` | web |
| CR-16 | Headless ICE candidate queue unbounded (web caps at 100) | `webrtc.py:81` | headless |

### Low

| ID | Description | File | Package |
|----|-------------|------|---------|
| CR-17 | Web CryptoService is module-level singleton — state persists across tests | `crypto.ts:372` | web |
| CR-18 | Headless uses `datetime.utcnow()` (deprecated in Python 3.12+) | `client.py:2312-2313` | headless |
| CR-19 | `parseLinkQrData` colon-split may break with unusual URL formats | `deviceLink.ts:79-87` | web |
| CR-20 | Headless `_webrtc_signal_loop` is a no-op (placeholder never implemented) | `client.py:2355-2361` | headless |
| CR-21 | Web client `seenNonces` and `seenNoncesBytes` are separate but redundant maps | `crypto.ts:41-42` | web |
| CR-22 | Headless signaling missing type validation for `pair_matched` fields | `signaling.py:498-509` | headless |
| CR-23 | Headless file channel data decrypted then JSON-parsed without structure validation | `client.py:2466-2473` | headless |

---

## Test Coverage Gaps

### Critical Gaps (No Tests)

| Area | Description | Impact |
|------|-------------|--------|
| **Storage Layer** | `MessageStorage` CRUD, `TrustedPeersStorageImpl` — zero unit tests | Data corruption undetected |
| **Channel Services** (plan05) | `ChannelService`, `ChannelStorageService`, `ChannelCryptoService` — zero unit tests | All channel logic untested |
| **Group Services** (plan05) | `GroupService`, `GroupStorageService`, `GroupCryptoService`, `GroupSyncService` — zero unit tests | All group logic untested |
| **Error Paths** | Network failures, timeouts, malformed data — minimal coverage across all packages | Production crashes undetected |

### Incomplete Coverage

| Area | What Exists | What's Missing |
|------|-------------|----------------|
| Connection Manager | Basic init (165 lines) | Peer lifecycle, event streams, message routing, cleanup |
| Channels (plan05) | Widget UI tests (`channels_test.dart`) | Service layer, crypto, chunk relay, storage |
| Groups (plan05) | Widget UI tests (`groups_test.dart`) | Service layer, mesh state, message routing, storage, sequence tracking |
| Server | Bootstrap tests (800+ lines) | Channel/group coordination, migrations, auth, rate limiting |

### Well-Tested Areas

| Area | Coverage |
|------|----------|
| `CryptoService` | Comprehensive (key exchange, encryption roundtrips, edge cases) |
| `MessageProtocol` | Extensive (all message types, encoding, roundtrips) |
| `SignalingClient` | Good (WebSocket lifecycle, pairing) |
| Web Client `validation.ts` | Comprehensive (1038 lines — type guards, XSS, input validation) |
| Web Client `crypto.test.ts` | Good (653 lines — key exchange, encryption) |

---

## Priority Matrix

### Immediate (Security + Data Loss)

1. **S1** — Admin open redirect (JWT theft)
2. **CR-02** — Headless accepts mismatched handshake keys (MITM)
3. **S3** — Bootstrap auth bypass (rogue server registration)
4. **A14** — Shell injection on Windows
5. **A15** — Auto-accept group invitations (spam/resource exhaustion)
6. **SF-C4/C5** — Channel messages silently lost (data loss)

### High Priority (Correctness)

7. **S4** — Federation reconnect blocked (network resilience broken)
8. **S2** — Bootstrap client missing auth (federation broken when auth enabled)
9. **A7** — Stream subscription leaks (memory + duplicate handlers)
10. **A18/A19** — Equatable props missing fields (stale UI)
11. **CR-03/CR-05** — stableId not sent/received by headless/web (cross-session identity broken)
12. **A10** — Duplicate sequence numbers in groups (data corruption)

### Medium Priority (Robustness)

13. **SF-H9** — Peer storage fallback to raw key (security risk)
14. **S5** — Admin XSS via error messages
15. **S10** — JWT in localStorage
16. **A23/A24** — N+1 secure storage reads (performance)
17. All logging-only silent failure fixes (SF-H1-H10, SF-M1-M12)

### Lower Priority (Cleanup + Testing)

18. Test coverage for storage, channels, groups
19. Server code cleanup (S18-S23)
20. Client consistency (CR-08-CR-23)

---

## Origin Summary

| Origin | Count |
|--------|-------|
| Pre-existing (main branch) | 57 |
| New in plan05 | 50 |

The plan05 branch (channels, groups, attestation, stableId) introduces **50 new issues**, roughly half the total. The channel and group features in particular have significant silent failure patterns (SF-C4/C5/C6) and lack unit test coverage entirely.
