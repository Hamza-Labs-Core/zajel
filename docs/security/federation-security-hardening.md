# Federation Security Hardening Roadmap

**Date:** 2026-03-03
**Scope:** Codebase audit of `packages/server/src/` — server-registry-do.js, attestation-registry-do.js, cors.js, timing-safe.js, rate-limiter.js, index.js, and all test files (93 tests across 7 files)

---

## TIER 1 — CRITICAL (Fix Before Production)

### 1. Empty Trusted Keys = Trust All Builds

**File:** `server-registry-do.js:586`

```js
const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(...)
```

When no keys are loaded (new deployment, decryption fails, env var missing), ANY signing key is accepted. Sigstore/TUF enforce **deny-by-default** — if no root of trust is established, nothing is trusted. SLSA Level 2+ requires explicit provenance chains.

**Fix:** Flip the default. `trustedKeys.length === 0` → `buildVerified = false`. Add explicit `ALLOW_UNTRUSTED_BUILDS` env flag for development only.

### 2. No Replay Protection on Heartbeats/Registration

**Where:** `POST /servers`, `POST /servers/heartbeat`

No timestamp, nonce, or sequence number. An attacker who intercepts a heartbeat can replay it to keep deregistered servers alive, trigger false anomalies, or overwrite legitimate metrics. Matrix federation signs server-to-server requests with `origin_server_ts`. TLS alone doesn't prevent application-layer replay.

**Fix:** Add `timestamp` field to heartbeats, reject >30s stale. Add monotonic `seq` per-server to prevent same-second replays.

### 3. Attestation Challenge Replay (Nonce-Device Binding Gap)

**File:** `attestation-registry-do.js:720-790`

Nonce is bound to `device_id` but not to any session/IP context. Attacker who intercepts a nonce can submit verification responses from a different origin.

**Fix:** Bind the challenge to `CF-Connecting-IP` or require a session token.

### 4. Console.error Leaks Sensitive Data

**File:** `attestation-registry-do.js:690-782`

`console.error` logs expose nonce values, device IDs, expected vs actual values, HMAC mismatch details. These go to Cloudflare's log pipeline.

**Fix:** Replace with `this.logger.warn()` using generic messages. Never log nonce values or expected challenge data.

---

## TIER 2 — HIGH PRIORITY

### 5. Missing Per-Endpoint Rate Limiting

Global 100 req/min per IP is in-memory only (lost on Worker restart, bypassed by IP rotation). No per-endpoint or per-serverId limits. Cloudflare's own docs recommend Durable Objects for persistent rate limiting. Matrix uses exponential backoff with sliding window per endpoint.

**Options:** DO storage counters (most accurate), CF Rate Limiting rules (easiest), per-serverId heartbeat rate limits (max 1/30s).

### 6. No Audit Log for Successful Key Reads

`getTrustedKeys()` only logs failures. An attacker with valid `CI_UPLOAD_SECRET` can read the full key set with no record. AWS CloudTrail, GCP Audit Logs, and Sigstore Rekor all log successful reads.

**Fix:** Add `this.logger.info('[audit] Trusted build keys read', { action: 'trusted_keys_read', keyCount, ip })`.

### 7. Key Rotation Has No Tested Recovery Path

When `CI_UPLOAD_SECRET` rotates, old encrypted keys can't be decrypted. The code falls back to env var, but if that's also stale, all keys are lost. Zero test coverage. TUF handles rotation with explicit root key ceremonies and threshold signatures. NIST SP 800-57 mandates crypto-period limits and transition plans.

**Fix:** Add `/servers/trusted-keys/rotate-secret` endpoint that re-encrypts with the new secret. Or store key version for multi-version decryption. At minimum: add tests.

### 8. Timing Leak in `timingSafeEqual` Length Check

**File:** `timing-safe.js:16-26`

Returns early when lengths differ. Comparing `minLen` bytes instead of fixed-size hashes leaks the length of `SERVER_REGISTRY_SECRET`. Node.js `crypto.timingSafeEqual` throws on length mismatch. Production implementations HMAC both inputs first.

**Fix:** HMAC both inputs with a fixed key before comparison to normalize length.

---

## TIER 3 — MEDIUM PRIORITY (Hardening)

### 9. Anomaly Detection Bypass Vectors

Red team attack paths not currently detected:

| Attack | Description | Why it works |
|---|---|---|
| Smooth climb | Increase 2.9x per heartbeat | Just under 3x spike threshold |
| Coordinated fleet | All servers spike together | stddev stays low, no outlier |
| History-less new server | First heartbeat has 10K connections | `history.length < 2` skips spike detection |
| Off-by-one metric spoof | `connections=100, relay=99, sig=99` | Inconsistency threshold is `>1` |

Matrix's server-ACLs and Jitsi's Ocelot use reputation scoring with minimum observation periods for new servers.

### 10. Region Index NaN Bypass

**File:** `attestation-registry-do.js:752`

`NaN < 0` is `false` AND `NaN >= length` is `false`, so NaN passes both bounds checks.

**Fix:** Add `typeof region_index !== 'number' || !Number.isInteger(region_index)` guard.

### 11. Add Security Headers

Missing `Referrer-Policy: no-referrer` (prevents token leakage via Referer header).

### 12. Single DO Instance = SPOF

One DO instance handles all federation state globally. No sharding, no failover. Matrix uses per-room state distribution. TUF mirrors are region-sharded.

---

## TIER 4 — INDUSTRY BEST PRACTICE ADOPTION

### 13. Adopt SLSA Build Provenance (Level 2+)

**Current:** Ed25519 proves "someone with key X signed hash Y." No provenance of WHO, WHERE, or FROM WHAT.

**Industry standard (SLSA L3):** Signed, non-falsifiable provenance including `{ sourceRepo, commitHash, ciSystem, builderIdentity }`. Sigstore + GitHub Actions achieves this with keyless signing via OIDC identity.

**Recommendation:** Extend build attestation to include provenance metadata. Use GitHub artifact attestations for SLSA L3 compliance.

### 14. Transparency Log for Key Changes

**Current:** Key updates logged to `this.logger.info` — mutable, non-auditable.

**Industry standard:** Sigstore's Rekor provides an immutable append-only transparency log. TUF uses signed timestamps.

**Recommendation:** Store tamper-evident key change log (append-only array in DO storage with signed entries).

### 15. Threshold Signing (M-of-N Key Requirement)

**Current:** Any single trusted key can sign a build.

**Industry standard:** TUF requires M-of-N threshold signatures for root key operations. Docker Notary v2 requires delegation chains. TUF's root key ceremony involves 5 keyholders from different organizations.

### 16. Key Expiry / Crypto-Period Limits

**Current:** Keys never expire once added.

**Industry standard:** NIST SP 800-57 mandates crypto-periods (1-3 years for signing keys). Sigstore uses ephemeral keys (~20 minutes). TUF timestamp metadata expires daily.

**Recommendation:** Add `expiresAt` per key. Reject expired keys during build verification.

### 17. Sign WebRTC Signaling to Prevent MITM

**Learned from Jitsi:** Any system where the signaling server can modify SDP without detection is vulnerable to MITM (see [academic paper](https://eprint.iacr.org/2023/1118.pdf)). Zajel should cryptographically sign SDP offers/answers with the peer's Ed25519 key.

### 18. Prefer Ephemeral/Keyless Signing

**Learned from Sigstore:** Long-lived signing keys create management burden and compromise risk. Sigstore proved that ephemeral keys tied to OIDC identity eliminate entire classes of problems. For federation server identity, consider short-lived certificates (hours/days) renewed automatically.

---

## Test Coverage Gaps

| Area | Current Coverage | Red Team Priority |
|---|---|---|
| Replay attacks | 0% | CRITICAL |
| Concurrent access races | 0% | HIGH |
| Key rotation scenarios | 0% | HIGH |
| HKDF edge cases (empty secret) | 0% | MEDIUM |
| Ciphertext tampering | 0% | MEDIUM |
| CORS subdomain spoofing | 0% | MEDIUM |
| Anomaly bypass vectors | 40% | MEDIUM |
| Payload boundary conditions | 30% | MEDIUM |
| Timing-safe length oracle | 0% | MEDIUM |
| NaN injection in validators | 0% | LOW |

---

## Recommended Implementation Order

| # | Item | Effort | Impact |
|---|---|---|---|
| 1 | Flip empty-keys default to deny | 30min | Eliminates trust bypass |
| 2 | Add heartbeat timestamp validation | 1h | Eliminates replay attacks |
| 3 | Replace console.error in attestation | 30min | Eliminates info leak |
| 4 | Add audit log for successful key reads | 10min | Audit trail |
| 5 | HMAC-normalize timing-safe comparison | 1h | Eliminates length oracle |
| 6 | Add per-serverId heartbeat rate limiting | 2h | Prevents metric flooding |
| 7 | Add key expiry field | 1h | Crypto-period limits |
| 8 | NaN guards in attestation validators | 30min | Input validation |
| 9 | Add Referrer-Policy header | 5min | Defense in depth |
| 10 | Add replay/rotation/boundary tests | 3h | Closes test gaps |
