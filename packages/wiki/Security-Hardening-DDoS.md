# Security Hardening: DDoS Risk Analysis

This page documents the 24 security hardening plans produced by the DDoS risk analysis audit of the Zajel federation infrastructure. The audit covered four packages: `packages/server` (CF Worker bootstrap), `packages/server-vps` (federation signaling), `packages/admin-cf` (admin dashboard), and `packages/app` (Flutter client).

All 24 stories have corresponding implementation plans and peer reviews under `docs/security/`.

---

## Summary

| Tier | Stories | Severity Range |
|------|---------|----------------|
| Immediate | 001-004 | CRITICAL, HIGH |
| This Week | 005-010 | HIGH, MEDIUM |
| This Sprint | 011-015 | HIGH |
| Medium-Term | 016-020 | MEDIUM |
| Long-Term | 021-024 | MEDIUM, LOW |

**Severity breakdown**: 2 CRITICAL, 9 HIGH, 12 MEDIUM, 1 LOW

Each plan includes: root cause analysis, file-level change specification, test plan, and review verdict.

---

## Tier 1 -- Immediate (Stories 001-004)

These address active vulnerabilities with direct exploit paths.

### 001 -- Federation Reconnect Bug

**Severity**: HIGH | **Component**: `packages/server-vps`

The outer guard in `ServerConnectionManager.handleDisconnect()` reads `maxReconnectAttempts !== 0`, which is always `false` when the production config sets `maxReconnectAttempts: 0` (the "infinite retries" sentinel). The inner conditional that would correctly permit infinite retries is dead code. Every production VPS server silently drops federation peers permanently on any disconnect.

**Fix**: Remove the contradictory outer guard. The inner condition already handles both infinite and bounded retry semantics. Also fix `scheduleReconnect()` to chain the next attempt in its catch block -- without this, only one reconnect is attempted per disconnect event.

**Key files**:
- `packages/server-vps/src/federation/transport/server-connection.ts` (lines 486-493, 499-513)
- `packages/server-vps/src/index.ts` (line 217 -- production config)
- New: `packages/server-vps/tests/unit/server-connection-reconnect.test.ts`
- New: `packages/server-vps/tests/integration/federation-reconnect.test.ts`

---

### 002 -- Flip Empty Trusted Keys Default to Deny

**Severity**: CRITICAL | **Component**: `packages/server` (CF Worker)

`ServerRegistryDO.registerServer()` and `heartbeat()` evaluate:
```javascript
const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(...)
```
When no trusted keys are loaded (new deployment, missing env var, decryption failure), the condition short-circuits to `true` and any signing key is accepted. This violates the deny-by-default principle required by SLSA Level 2+.

**Fix**: Flip the default -- when `trustedKeys` is empty, `buildVerified` must be `false`. Add an explicit `ALLOW_UNTRUSTED_BUILDS` env flag for development use only.

**Key files**:
- `packages/server/src/durable-objects/server-registry-do.js` (lines 586, 751)
- `packages/server/tests/unit/build-signing.test.js` (five tests require updates to add `TRUSTED_BUILD_KEYS` to their env fixture)

**Review note**: The review identified a pre-existing bug where `server.buildHash` is overwritten before `prevHash` is captured on the next line, making hash-change anomaly detection dead code. This should be fixed in the same change.

---

### 003 -- Attestation Log Leakage

**Severity**: HIGH | **Component**: `packages/server` (CF Worker)

Eight `console.error()` calls in `AttestationRegistryDO` write sensitive data to Cloudflare's log pipeline: nonce values, device IDs, expected vs actual HMAC values, and mismatch details. All 8 paths are in the attestation verification handler (lines 690-782 of `attestation-registry-do.js`).

**Fix**: Replace all 8 `console.error()` calls with `this.logger.warn()` using generic messages. Never log nonce values or expected challenge data.

**Key files**:
- `packages/server/src/durable-objects/attestation-registry-do.js` (lines 690, 701, 711, 727, 741, 753, 769, 782)
- New: `packages/server/tests/unit/attestation-logging.test.js`

---

### 004 -- Registry Secret Auth Bypass

**Severity**: CRITICAL | **Component**: `packages/server` (CF Worker)

Four protected endpoints in `ServerRegistryDO` share the same auth check pattern:
```javascript
if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
```
When `SERVER_REGISTRY_SECRET` is not configured, JavaScript evaluates the leading `&&` condition as falsy and skips authentication entirely. All protected endpoints (registration, deletion, heartbeat, anomaly view) are fully open.

**Fix**: Add a `requireServerAuth()` helper that unconditionally verifies the secret and returns a 401 response when the secret is missing or wrong. Replace all four call sites.

**Key files**:
- `packages/server/src/durable-objects/server-registry-do.js` (lines 376, 392, 418, 429)
- New: `packages/server/tests/unit/server-registry-auth.test.js`

---

## Tier 2 -- This Week (Stories 005-010)

High-priority hardening to ship within the first week.

### 005 -- Heartbeat Timestamp/Replay Protection

**Severity**: HIGH | **Component**: `packages/server`, `packages/server-vps`

Federation heartbeats between VPS servers and the CF Worker bootstrap registry contain no timestamp, nonce, or sequence number. A captured heartbeat can be replayed to keep stale servers alive, inject false metrics, or prevent TTL-based eviction of compromised nodes.

**Fix**: Add a `timestamp` field to heartbeats; reject requests older than 30 seconds. Add a monotonic `seq` counter per server to prevent same-second replays. Store seen nonces in DO storage with TTL-based cleanup via the alarm handler.

**Key files**:
- `packages/server-vps/src/federation/bootstrap-client.ts`
- `packages/server/src/durable-objects/server-registry-do.js`
- `packages/server-vps/src/config.ts`
- `packages/server-vps/src/types.ts`

---

### 006 -- Admin Portal CORS Wildcard

**Severity**: HIGH | **Component**: `packages/admin-cf`

The CF Workers admin dashboard sets `Access-Control-Allow-Origin: *` on all API responses. Combined with JWT tokens stored in `localStorage` and sent via `Authorization` headers, any page the admin visits can make authenticated cross-origin requests and exfiltrate tokens.

**Fix**: Replace the wildcard with dynamic origin validation against an `ADMIN_ALLOWED_ORIGINS` allowlist, following the same pattern as `packages/server/src/cors.js`.

**Key files**:
- `packages/admin-cf/src/index.ts`
- `packages/admin-cf/src/types.ts`
- New: `packages/admin-cf/src/cors.ts`
- `packages/admin-cf/wrangler.jsonc`
- New: `packages/admin-cf/tests/unit/cors.test.ts`

---

### 007 -- JWT Token in URL Query Parameters

**Severity**: HIGH | **Component**: `packages/admin-cf`, `packages/server-vps`

JWT tokens are passed as `?token=<jwt>` URL query parameters when navigating between the CF admin dashboard and VPS dashboards. This exposes 4-hour tokens to browser history, `Referer` headers sent to external resources, web server access logs, browser extensions, and proxy/CDN logs.

**Fix**: Replace URL-based token passing with a short-lived (30s), single-use authorization code exchange. The CF admin generates a one-time code; the VPS dashboard redeems it via a server-to-server call and sets an `HttpOnly` cookie.

**Key files**:
- `packages/admin-cf/src/index.ts`
- `packages/admin-cf/src/admin-users-do.ts`
- `packages/admin-cf/src/types.ts`
- `packages/server-vps/src/admin/auth.ts`
- New: `packages/admin-cf/tests/unit/auth-code.test.ts`
- New: `packages/server-vps/tests/unit/admin-auth.test.ts`

---

### 008 -- Missing Security Headers

**Severity**: MEDIUM | **Component**: `packages/admin-cf`, `packages/server`

The admin dashboard (`packages/admin-cf/src/index.ts`) is missing `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy`, and `X-Frame-Options`. The bootstrap server CORS module (`packages/server/src/cors.js`) has some headers but is missing `Referrer-Policy`, `Content-Security-Policy`, and `Permissions-Policy`. The VPS admin routes have the same gaps.

**Fix**: Add a CSP with nonce-based script authorization to dashboard HTML responses. Add `Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(), camera=(), microphone=()`, and the full HSTS/XFO/XCTO set to all API responses.

**Key files**:
- `packages/admin-cf/src/index.ts`
- `packages/server/src/cors.js`
- `packages/server-vps/src/admin/routes.ts`
- `packages/server-vps/src/admin/auth.ts`

---

### 009 -- Key Read Audit Log

**Severity**: MEDIUM | **Component**: `packages/server` (CF Worker)

`getTrustedKeys()` logs failed authentication attempts but does not log successful reads. An operator can see who failed to access trusted build keys but has no record of successful access.

**Fix**: Add `this.logger.info('[audit] Trusted build keys read', { action: 'trusted_keys_read', keyCount, ip })` for both successful reads and decryption failures (with appropriate detail levels for each).

**Key files**:
- `packages/server/src/durable-objects/server-registry-do.js` (lines 986-1032)
- `packages/server/tests/unit/build-signing.test.js`

---

### 010 -- HMAC-Normalize Timing-Safe Comparison

**Severity**: MEDIUM | **Component**: `packages/server`, `packages/admin-cf`

`timingSafeEqual` in `packages/server/src/crypto/timing-safe.js` returns `false` early when input lengths differ and iterates over only `minLen` bytes, leaking both the inequality and the exact minimum length through timing. The `packages/admin-cf/src/crypto.ts` version avoids the early return but has its own subtlety with modular indexing.

**Fix**: HMAC both inputs with a fixed random key before comparison. This normalizes lengths to 32 bytes, making comparison fully constant-time regardless of input content or length.

**Key files**:
- `packages/server/src/crypto/timing-safe.js`
- `packages/server/src/durable-objects/server-registry-do.js` (make `verifyServerAuth()` and `verifyCIAuth()` async)
- `packages/admin-cf/src/crypto.ts`

---

## Tier 3 -- This Sprint (Stories 011-015)

Important improvements for the current sprint.

### 011 -- Per-Endpoint and Per-ServerId Rate Limiting

**Severity**: HIGH | **Component**: `packages/server`

A single in-memory `RateLimiter` applies one global 100 req/min/IP limit across all endpoints. The counter is lost on Worker isolate eviction. An attacker can exhaust the budget with cheap requests then be blocked from expensive ones (or vice versa). There are no per-serverId heartbeat limits.

**Fix**: Differentiate limits by endpoint sensitivity: 200 req/min for public reads, 30 req/min for writes, 20 req/min for attestation, 10 req/min for admin/CI. Add per-serverId heartbeat throttling (max 1/30s). Optionally migrate to Durable Object-backed counters for persistence across isolate evictions.

**Key files**:
- `packages/server/src/rate-limiter.js`
- `packages/server/src/index.js`
- `packages/server/src/durable-objects/server-registry-do.js`

---

### 012 -- Key Expiry/Crypto-Period Limits

**Severity**: HIGH | **Component**: `packages/server`

Build signing keys uploaded via `POST /servers/trusted-keys` are stored with no expiration, no rotation schedule, and no crypto-period enforcement. A key remains trusted indefinitely even if its private counterpart is compromised.

**Fix**: Attach an `expiresAt` timestamp (configurable, defaulting to 90 days) to every key on upload. Filter expired keys in `loadTrustedKeys()`. Add a rotation endpoint (`POST /servers/trusted-keys/rotate`) to re-encrypt the key set with a new `CI_UPLOAD_SECRET`.

**Key files**:
- `packages/server/src/durable-objects/server-registry-do.js`
- `packages/server/tests/unit/build-signing.test.js`

---

### 013 -- NaN Input Validation in Attestation

**Severity**: HIGH | **Component**: `packages/server`

The attestation verification handler in `AttestationRegistryDO` validates `region_index` with comparison operators that silently pass for `NaN` values. In JavaScript, `NaN < 0` and `NaN >= n` both evaluate to `false`, so `NaN` bypasses both bounds checks and reaches array indexing operations with undefined results.

**Fix**: Replace comparison-based bounds checks with an explicit `Number.isInteger(region_index)` guard before any comparison. Create a shared `numeric-validation.js` utility for reuse across the codebase.

**Key files**:
- `packages/server/src/durable-objects/attestation-registry-do.js`
- New: `packages/server/src/utils/numeric-validation.js`
- New: `packages/server/tests/unit/numeric-validation.test.js`

---

### 014 -- Security Test Coverage

**Severity**: HIGH | **Component**: `packages/server`

The server package had 7 existing test files with no coverage for: the `RateLimiter` class, `timingSafeEqual`, `parseJsonBody` size limits, CORS origin validation, logger redaction, replay attacks, key rotation recovery, race conditions on concurrent requests, HKDF edge cases, or ciphertext tampering.

**Fix**: Add 12 new test files covering all of the above gaps. Target is >80% code coverage with comprehensive security scenario coverage.

**Key files -- new test files**:
- `packages/server/tests/unit/rate-limiter.test.js`
- `packages/server/tests/unit/timing-safe.test.js`
- `packages/server/tests/unit/request-validation.test.js`
- `packages/server/tests/unit/cors.test.js`
- `packages/server/tests/unit/logger.test.js`
- `packages/server/tests/security/replay-attack.test.js`
- `packages/server/tests/security/key-rotation.test.js`
- `packages/server/tests/security/race-conditions.test.js`
- `packages/server/tests/security/hkdf-edge-cases.test.js`
- `packages/server/tests/security/ciphertext-tampering.test.js`
- `packages/server/tests/security/nan-validation.test.js`
- `packages/server/tests/helpers/mock-do.js`

---

### 015 -- VPS Reverse Proxy with Connection Rate Limiting

**Severity**: HIGH | **Component**: `packages/server-vps`, `.github/workflows/deploy-vps.yml`

The VPS signaling server runs as a bare Node.js process on port 80 with no reverse proxy, no TLS termination at the infrastructure layer, no connection-level rate limiting, and no DDoS mitigation. Application-level per-IP limits (MAX_CONNECTIONS_PER_IP: 50) can be bypassed with IP rotation.

**Fix**: Deploy nginx as a reverse proxy with:
- `limit_conn_zone` restricting connections per IP
- `limit_req_zone` restricting HTTP request rate before the WebSocket upgrade
- `ngx_http_realip_module` for correct IP attribution
- fail2ban jail watching nginx logs for repeated connection attempts
- UFW firewall blocking all ports except 22, 80, 443

**Key files -- new**:
- `packages/server-vps/deploy/nginx.conf.template`
- `packages/server-vps/deploy/fail2ban-zajel.conf`
- `packages/server-vps/deploy/fail2ban-zajel-filter.conf`
- `packages/server-vps/deploy/setup-firewall.sh`
- `packages/server-vps/deploy/setup-nginx.sh`
- `.github/workflows/deploy-vps.yml` (update deployment job)

---

## Tier 4 -- Medium-Term (Stories 016-020)

Architectural improvements and defense-in-depth.

### 016 -- SLSA L2 Build Provenance

**Severity**: MEDIUM | **Component**: `.github/workflows/release.yml`

The release workflow builds artifacts for all platforms but produces no SLSA provenance metadata. There is no SHA-256 hash, no in-toto attestation, and no Sigstore signing of release artifacts. Users have no way to verify a downloaded binary was built from the tagged source commit by the official CI pipeline.

**Fix**: Add SHA-256 hash computation to each build job output. Generate SLSA L2 provenance using `slsa-framework/slsa-github-generator`. Publish hashes and provenance alongside release artifacts.

**Key files**:
- `.github/workflows/release.yml`

---

### 017 -- Transparency Log for Key Changes

**Severity**: MEDIUM | **Component**: `packages/server`

Key management operations (add, remove, replace trusted build signing keys) are logged only to Cloudflare's transient log stream. There is no append-only, tamper-evident audit trail. A compromised CI secret holder could add a rogue key, sign a malicious build, then remove the key without leaving a durable forensic record.

**Fix**: Create a `TransparencyLog` utility backed by a dedicated Durable Object that appends signed entries for every key management operation. Each entry includes: action, key fingerprint, actor IP, timestamp, and the Ed25519 signature of the full log entry.

**Key files**:
- New: `packages/server/src/utils/transparency-log.js`
- `packages/server/src/durable-objects/server-registry-do.js`
- New: `packages/server/tests/unit/transparency-log.test.js`

---

### 018 -- Sign WebRTC SDP Offers/Answers

**Severity**: MEDIUM | **Component**: `packages/server-vps`, `packages/app`

WebRTC SDP offers and answers are forwarded through the VPS signaling server as opaque payloads with no integrity protection. A compromised VPS server can modify SDP content -- for example, replacing ICE candidates to redirect traffic through an attacker-controlled relay, or modifying DTLS fingerprints to intercept media.

**Fix**: Sign SDP messages with the sender's Ed25519 identity key before forwarding. The VPS server and receiving client each verify the signature before processing the SDP. Adds `sdp_signature` and `sender_pubkey` fields to offer/answer messages.

**Key files**:
- `packages/app/lib/core/crypto/crypto_service.dart` (add SDP signing)
- `packages/app/lib/core/network/signaling_client.dart` (sign outgoing SDP, verify incoming)
- `packages/server-vps/src/client/signaling-handler.ts` (relay signature fields without stripping)

---

### 019 -- Durable Object Sharding for High Availability

**Severity**: MEDIUM | **Component**: `packages/server`

All three Durable Object types in the CF Worker bootstrap use `idFromName('global')`, routing all requests to a single global instance. This is a single point of failure: if the DO becomes overloaded or the colocated Cloudflare region has an outage, the entire bootstrap service is unavailable.

**Fix**: Shard `SERVER_REGISTRY` across N shards using consistent hashing on `serverId`. Fan out `GET /servers` reads across all shards and merge results. Shard `ATTESTATION_REGISTRY` on `device_id`. Add a migration helper for zero-downtime resharding.

**Key files**:
- `packages/server/src/index.js`
- `packages/server/src/durable-objects/server-registry-do.js`
- `packages/server/wrangler.jsonc`

---

### 020 -- IP Reputation Scoring and Cluster-Aware Rate Limiting

**Severity**: MEDIUM | **Component**: `packages/server`, `packages/server-vps`

Rate limiting across the Zajel infrastructure is entirely per-isolate and in-memory, with no cross-request reputation tracking and no awareness of coordinated attacks across the federation. An attacker rate-limited on one VPS server can freely attack another.

**Fix**: Phase 1 -- Implement persistent IP reputation scoring in the CF Worker using the Cache API, with a sliding reputation score that decays over time. Phase 2 -- Share reputation data between VPS servers via the CF Worker as a coordination point. VPS servers periodically push offender lists; the CF Worker distributes block lists back.

**Key files**:
- New: `packages/server/src/reputation.js`
- `packages/server/src/index.js`
- `packages/server-vps/src/index.ts`

---

## Tier 5 -- Long-Term (Stories 021-024)

Forward-looking security investments.

### 021 -- TUF Role Hierarchy for Registry Trust

**Severity**: MEDIUM | **Component**: `packages/server`, `packages/app`

The bootstrap server uses a single Ed25519 signing key (`BOOTSTRAP_SIGNING_KEY`) for all server registry responses. There is no role separation, no delegation hierarchy, and no threshold signing. A single compromised key grants full control over the federation trust chain.

**Fix**: Implement a TUF (The Update Framework) role hierarchy with separate Root, Targets, Snapshot, and Timestamp roles. Root and Targets use offline keys; Snapshot and Timestamp use online keys. The app verifies the full TUF metadata chain before trusting any server list.

**Key files**:
- New: `packages/server/src/crypto/tuf/metadata.js`
- New: `packages/server/src/crypto/tuf/roles.js`
- New: `packages/server/src/crypto/tuf/verification.js`
- `packages/app/lib/core/network/server_discovery_service.dart`

**Dependency**: Story 023 (Threshold Signing) extends this for the Root role.

---

### 022 -- Sigstore Keyless/Ephemeral Signing

**Severity**: MEDIUM | **Component**: `packages/server`, `.github/workflows`

The release pipeline and bootstrap server use long-lived Ed25519 keys stored as Cloudflare Workers secrets and GitHub Actions secrets. These are vulnerable to secret exfiltration, insider threats, and supply chain attacks.

**Fix**: Replace long-lived keys with Sigstore keyless signing. GitHub Actions OIDC tokens provide ephemeral signing keys bound to a specific workflow run. Signatures are published to Rekor for a public, tamper-evident audit trail. Users can verify artifact authenticity using `cosign verify` without pre-distributing any public key.

**Key files**:
- `.github/workflows/release.yml`
- New: `docs/RELEASE_VERIFICATION.md`

**Dependency**: Story 016 (SLSA provenance) is a prerequisite.

---

### 023 -- Threshold Signing (M-of-N) for Root Key Operations

**Severity**: MEDIUM | **Component**: `packages/server`

All trust-critical operations are controlled by a single cryptographic key. There is no M-of-N threshold requirement for any operation. A single compromised key or rogue operator can unilaterally modify the server registry, inject malicious servers, or replace the signing key.

**Fix**: Implement FROST (Flexible Round-Optimized Schnorr Threshold) signature scheme. Root key operations (key rotation, server de-listing, trust anchor updates) require M-of-N approvals. Each key shard is held by a separate operator. Partial signatures are aggregated server-side.

**Key files**:
- New: `packages/server/src/crypto/frost.js`

**Dependency**: Story 021 (TUF Role Hierarchy) provides the role structure that threshold signing protects.

---

### 024 -- Post-Quantum Key Exchange Migration

**Severity**: LOW | **Component**: `packages/app`, `packages/headless-client`, `packages/web-client`

The current key exchange uses X25519, which is vulnerable to a sufficiently large quantum computer via Shor's algorithm. "Harvest now, decrypt later" attacks are already a concern for long-lived identity keys.

**Fix**: Implement a hybrid X25519 + ML-KEM-768 (CRYSTALS-Kyber) key exchange. Both secrets are concatenated and passed through HKDF. The classical X25519 component maintains security against current adversaries while ML-KEM-768 provides post-quantum security. Protocol version negotiation allows gradual rollout with fallback for peers that do not yet support the hybrid mode.

**Key files**:
- `packages/app/lib/core/crypto/crypto_service.dart`
- New: `packages/app/lib/core/crypto/ml_kem_service.dart`
- `packages/headless-client/zajel/crypto.py`
- `packages/web-client/src/lib/crypto.ts`

---

## Dependency Graph

The long-term stories have a dependency chain:

```
Story 021 (TUF Role Hierarchy)
  |
  +---> Story 023 (Threshold Signing) -- Root role requires M-of-N
  |
  +---> Story 022 (Sigstore Keyless)  -- Online roles use Sigstore
           |
           +---> Story 016 (SLSA Build Provenance) -- related CI signing

Story 024 (Post-Quantum Migration) -- independent, cross-cutting
```

All other stories (001-020) are independent and can be implemented in any order within their tier.

---

## Source Files

All 24 stories, implementation plans, and peer reviews are in `docs/security/`:

| Document type | Location |
|---------------|----------|
| Story index | `docs/security/stories/story-000-index.md` |
| Individual stories | `docs/security/stories/story-NNN-*.md` |
| Implementation plans | `docs/security/implementation-plans/plan-NNN-*.md` |
| Peer reviews | `docs/security/reviews/review-NNN-*.md` |
| Original roadmap | `docs/security/federation-security-hardening.md` |

See also: [Security Architecture](Security-Architecture) for the full threat model and existing hardening documentation.
