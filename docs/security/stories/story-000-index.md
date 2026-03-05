# Security Stories Index

This document indexes all 24 security stories for the Zajel project, grouped by priority tier. All stories are currently **Open**.

---

## Priority Tiers

| Tier | Stories | Description |
|------|---------|-------------|
| Immediate | 001-004 | Active vulnerabilities requiring immediate attention |
| This Week | 005-010 | High-priority hardening that should ship within the week |
| This Sprint | 011-015 | Important improvements for the current sprint |
| Medium-Term | 016-020 | Architectural improvements and defense-in-depth |
| Long-Term | 021-024 | Forward-looking security investments |

---

## Immediate Priority

| # | Title | Severity | Status | File |
|---|-------|----------|--------|------|
| 001 | Fix Federation Reconnect Bug | HIGH | Open | [`story-001-federation-reconnect-bug.md`](story-001-federation-reconnect-bug.md) |
| 002 | Flip Empty Trusted Keys Default to Deny | CRITICAL | Open | [`story-002-trusted-keys-deny-default.md`](story-002-trusted-keys-deny-default.md) |
| 003 | Fix console.error Information Leakage in Attestation Registry | HIGH | Open | [`story-003-attestation-log-leakage.md`](story-003-attestation-log-leakage.md) |
| 004 | SERVER_REGISTRY_SECRET Auth Bypass When Unset | CRITICAL | Open | [`story-004-registry-secret-bypass.md`](story-004-registry-secret-bypass.md) |

## This Week Priority

| # | Title | Severity | Status | File |
|---|-------|----------|--------|------|
| 005 | Add Heartbeat Timestamp/Replay Protection | HIGH | Open | [`story-005-heartbeat-replay-protection.md`](story-005-heartbeat-replay-protection.md) |
| 006 | Fix Admin Portal CORS Wildcard | HIGH | Open | [`story-006-admin-cors-wildcard.md`](story-006-admin-cors-wildcard.md) |
| 007 | Remove JWT Tokens from URL Query Parameters | HIGH | Open | [`story-007-jwt-token-in-url.md`](story-007-jwt-token-in-url.md) |
| 008 | Add Missing Security Headers | MEDIUM | Open | [`story-008-missing-security-headers.md`](story-008-missing-security-headers.md) |
| 009 | Add Audit Logging for Successful Key Reads | MEDIUM | Open | [`story-009-key-read-audit-log.md`](story-009-key-read-audit-log.md) |
| 010 | HMAC-Normalize Timing-Safe Comparison | MEDIUM | Open | [`story-010-timing-safe-hmac-normalize.md`](story-010-timing-safe-hmac-normalize.md) |

## This Sprint Priority

| # | Title | Severity | Status | File |
|---|-------|----------|--------|------|
| 011 | Per-Endpoint and Per-ServerId Rate Limiting | HIGH | Open | [`story-011-per-endpoint-rate-limiting.md`](story-011-per-endpoint-rate-limiting.md) |
| 012 | Key Expiry/Crypto-Period Limits for Build Signing Keys | HIGH | Open | [`story-012-key-expiry-cryptoperiod.md`](story-012-key-expiry-cryptoperiod.md) |
| 013 | NaN Input Validation Guards in Attestation | HIGH | Open | [`story-013-nan-input-validation.md`](story-013-nan-input-validation.md) |
| 014 | Test Coverage for Replay, Rotation, and Race Conditions | HIGH | Open | [`story-014-security-test-coverage.md`](story-014-security-test-coverage.md) |
| 015 | Deploy VPS Behind Reverse Proxy with Connection Rate Limiting | HIGH | Open | [`story-015-vps-reverse-proxy.md`](story-015-vps-reverse-proxy.md) |

## Medium-Term Priority

| # | Title | Severity | Status | File |
|---|-------|----------|--------|------|
| 016 | SLSA L2 Build Provenance | MEDIUM | Open | [`story-016-slsa-build-provenance.md`](story-016-slsa-build-provenance.md) |
| 017 | Transparency Log for Key Changes | MEDIUM | Open | [`story-017-key-transparency-log.md`](story-017-key-transparency-log.md) |
| 018 | Sign WebRTC SDP Offers/Answers | MEDIUM | Open | [`story-018-sdp-signing.md`](story-018-sdp-signing.md) |
| 019 | Durable Object Sharding for High Availability | MEDIUM | Open | [`story-019-do-sharding.md`](story-019-do-sharding.md) |
| 020 | IP Reputation Scoring and Cluster-Aware Rate Limiting | MEDIUM | Open | [`story-020-ip-reputation-scoring.md`](story-020-ip-reputation-scoring.md) |

## Long-Term Priority

| # | Title | Severity | Status | File |
|---|-------|----------|--------|------|
| 021 | TUF Role Hierarchy for Registry Trust | MEDIUM | Open | [`story-021-tuf-role-hierarchy.md`](story-021-tuf-role-hierarchy.md) |
| 022 | Sigstore Keyless/Ephemeral Signing | MEDIUM | Open | [`story-022-sigstore-keyless-signing.md`](story-022-sigstore-keyless-signing.md) |
| 023 | Threshold Signing (M-of-N) for Root Key Operations | MEDIUM | Open | [`story-023-threshold-signing.md`](story-023-threshold-signing.md) |
| 024 | Post-Quantum Key Exchange Migration Planning | LOW | Open | [`story-024-post-quantum-migration.md`](story-024-post-quantum-migration.md) |

---

## Dependency Graph (Long-Term Stories)

```
Story 021 (TUF Role Hierarchy)
  |
  +---> Story 023 (Threshold Signing) -- root role requires M-of-N
  |
  +---> Story 022 (Sigstore Keyless) -- online roles can use Sigstore
           |
           +---> Story 016 (SLSA Build Provenance) -- related CI signing

Story 024 (Post-Quantum Migration) -- independent, cross-cutting
```

## Severity Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 2 |
| HIGH | 9 |
| MEDIUM | 12 |
| LOW | 1 |
| **Total** | **24** |
