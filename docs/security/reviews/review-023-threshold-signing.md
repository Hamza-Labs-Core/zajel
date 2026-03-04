# Review: Plan 023 - Threshold Signing (M-of-N) for Root Key Operations

**Verdict: NEEDS REVISION**

The plan demonstrates strong architectural thinking and a sensible phased rollout strategy, but contains multiple inaccurate source references, a non-functional FROST implementation that is presented as production code, a critical security flaw in the admin signature verification, and incomplete coverage of several acceptance criteria. The plan should be revised before implementation begins.

---

## Accuracy

### File Path References

All referenced existing file paths are confirmed to exist in the codebase:

| File | Exists |
|------|--------|
| `packages/server/src/index.js` | Yes |
| `packages/server/src/durable-objects/server-registry-do.js` | Yes |
| `packages/server/src/crypto/signing.js` | Yes |
| `scripts/generate-bootstrap-keys.mjs` | Yes |
| `packages/app/lib/core/crypto/bootstrap_verifier.dart` | Yes |
| `packages/server/wrangler.jsonc` | Yes |
| `packages/server/src/cors.js` | Yes |
| `packages/server/src/crypto/timing-safe.js` | Yes |
| `packages/server/src/logger.js` | Yes |

### Line Number References - Story Document

Nearly all line number citations in the story are **wrong**. The story appears to reference an older or simplified version of the codebase. The actual code has significantly evolved (e.g., anomaly detection, build verification, trusted key management have been added).

| Story Reference | Claimed Lines | Actual Location | Verdict |
|----------------|---------------|-----------------|---------|
| `index.js` signing code | Lines 92-101 | Lines 118-126 (the `if (env.BOOTSTRAP_SIGNING_KEY)` block) | **WRONG** - Line 92 is inside the API info response block, not signing code |
| `server-registry-do.js` request routing | Lines 18-60 | Lines 364-462 (`fetch()` method) | **WRONG** - Lines 18-60 are constants and the `AnomalyDetector` object |
| `server-registry-do.js` `registerServer()` | Lines 62-88 | Lines 464-631 | **WRONG** - Lines 62-88 are inside the `AnomalyDetector.analyze()` method |
| `server-registry-do.js` `unregisterServer()` | Lines 113-120 | Lines 666-703 | **WRONG** - Lines 113-120 are the fleet outlier detection code |
| `server-registry-do.js` heartbeat | Lines 122-159 | Lines 706-842 | **WRONG** - Line 122 is the `totalScore` method docstring |
| `signing.js` key import | Lines 27-46 | Lines 38-64 (`importSigningKey` starts at line 45) | **WRONG** - Line 27 is a JSDoc comment for `bytesToBase64` |
| `generate-bootstrap-keys.mjs` | Lines 16-35 | Lines 16-35 | **CORRECT** |
| `bootstrap_verifier.dart` public keys | Lines 14-16 | Lines 15-17 | **CLOSE** - Off by one line (class declaration is line 14, keys are 15-17) |

### Line Number References - Implementation Plan

The plan document references lines from `server-registry-do.js` at:
- `fetch()` method at "line 364" -- Actual: line 364. **CORRECT**.
- `registerServer()` at "lines 464-631" -- Actual: lines 464-631. **CORRECT**.
- `unregisterServer()` at "lines 666-703" -- Actual: lines 666-703. **CORRECT**.

So the implementation plan has correct line numbers, but the story document they correspond to has wrong line numbers. This is internally inconsistent.

### Code Snippet Accuracy - Story Document

The story's code snippets do **not** match the actual source:

1. **`registerServer()` snippet (story lines 37-59)**: Shows a simplified version that reads `await request.json()` directly. The actual code at line 464 uses `await parseJsonBody(request, 4096)` and includes extensive validation (URL validation, private address rejection, build signature verification, anomaly-related fields). The story omits all of this, making the current codebase look more vulnerable than it is. The actual code already has `SERVER_REGISTRY_SECRET` authentication on the `POST /servers` route (lines 375-381 in `fetch()`).

2. **`unregisterServer()` snippet (story lines 67-74)**: Shows a trivial version with no authentication. The actual code at line 666 already includes ownership verification via `publicKey` in the Authorization header (lines 680-691) and the `fetch()` method already checks `SERVER_REGISTRY_SECRET` auth on DELETE routes (lines 391-397).

3. **Claim of unauthenticated registration/removal**: The story claims registration and unregistration are "completely open" and "any HTTP client" can register/delete. This is misleading. The actual `fetch()` method already gates `POST /servers`, `DELETE /servers/:id`, and `POST /servers/heartbeat` behind `SERVER_REGISTRY_SECRET` authentication when that secret is configured (lines 375-424). The story accurately notes that authentication is conditional on the secret being set, but the code snippets it presents omit the existing auth checks entirely.

### Code Snippet Accuracy - Implementation Plan

The "Before" code snippets in the plan (Phase 3, Step 3.2) reference the correct line range (464-631) and show a closer approximation to the actual code, but still simplify significantly (the real `registerServer` is much more complex with URL validation, private address rejection, build verification, etc.).

---

## Completeness

### Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Notes |
|---------------------|----------------|-------|
| Root key generation uses Shamir's Secret Sharing | Yes (Phase 1) | Well covered by `shamir-keygen.mjs` |
| Root key operations require M key holders | Partially | Plan covers key reconstruction but does not define what "root key operations" are beyond signing |
| No single operator can produce a valid root signature | Yes (Phase 2) | Covered by FROST, but implementation is non-functional (see Risks) |
| Online signing uses FROST or equivalent | Yes (Phase 2) | Code is placeholder only |
| Server registration requires proof of key ownership | Yes (Phase 3) | `verifySelfSignedRegistration()` is well designed |
| Server deregistration requires authorization | Partially | Plan modifies `registerServer` but does not show modified `unregisterServer` code. Existing publicKey ownership check in `unregisterServer` is not mentioned |
| All registry mutations logged in audit trail | Yes (Phase 4) | `AuditLogDO` is well designed |
| Key ceremony tool produces verifiable log | Yes (Phase 1) | Ceremony log JSON is included |
| Client verification remains compatible | Yes | Correctly notes FROST produces standard Ed25519 signatures |
| Emergency revocation requires 1-of-N | **Not covered** | The plan mentions it in the "Open Questions" section but provides no implementation. The story lists it as an acceptance criterion |

### Missing Implementation Details

1. **`unregisterServer()` modification**: The plan says it will "Modify `unregisterServer()` to require authorization (lines 666-703)" but provides no code for this. The existing code already has partial auth (publicKey ownership check). The plan should show the diff.

2. **Heartbeat authentication**: The story identifies heartbeat trust as a weakness (line 120-121 of story: "An attacker who knows a valid `serverId` can keep a stale or compromised server entry alive indefinitely"). The plan does not address heartbeat authentication at all.

3. **Emergency revocation endpoint**: Listed as a requirement ("Add emergency revocation endpoint (requires 1-of-N signatures)") but no code is provided.

4. **`generate-bootstrap-keys.mjs` deprecation**: The plan says to "Add deprecation warning pointing to new threshold key generation tools" but provides no code for this change.

5. **`wrangler.jsonc` QA environment**: The plan shows adding the `AUDIT_LOG` binding to the top-level `durable_objects` but does not show the corresponding change needed in the `env.qa.durable_objects` block (lines 59-69 of `wrangler.jsonc`). Missing this would cause the QA environment to lack audit logging.

6. **Migration tag**: Adding a new Durable Object class (`AuditLogDO`) requires a new migration entry in the `migrations` array of `wrangler.jsonc`. The plan does not mention this. Without it, Cloudflare will reject the deployment.

---

## Risks

### Critical: FROST Implementation Is Non-Functional

The FROST implementation in `packages/server/src/crypto/frost.js` is explicitly marked with `// SIMPLIFIED` and `// PLACEHOLDER` comments throughout. Key operations are stubbed:

- `computeChallenge()` (line 377): `groupCommitment = hiding; // SIMPLIFIED - replace with actual point addition` -- only uses one signer's commitment.
- `aggregateSignature()` (line 418): `aggregatedResponse = responsesArray[0]; // SIMPLIFIED` -- only uses one response, completely ignoring threshold.
- `aggregateSignature()` (line 422): References `this.groupCommitment` which is never assigned (the variable is `groupCommitment` local to `computeChallenge`, not `this.groupCommitment`). This will throw a `TypeError` at runtime.
- `FrostSigner.generateCommitment()` (line 451): Uses `sha512(nonce)` as a placeholder for elliptic curve point multiplication. This is cryptographically incorrect.
- `FrostSigner.computeResponse()` (line 475): Just returns the hiding nonce verbatim. This provides zero threshold security.

The E2E test in Step 5.3 would **fail** because the aggregated "signature" produced by this code is not a valid Ed25519 signature. The test asserts `expect(valid).toBe(true)` for `crypto.subtle.verify('Ed25519', groupPublicKey, signature, message)` which will always return `false` with this implementation.

The plan does acknowledge this ("This is a simplified implementation showing protocol structure") and recommends deferring FROST (final paragraph), but it presents the code as an implementation step rather than a specification sketch. This is confusing.

**Recommendation**: Either (a) clearly label Phase 2 as "design specification only -- do not implement until a production FROST library is available", or (b) provide a working implementation. The current middle ground (pseudo-code disguised as implementation steps) will cause wasted effort.

### High: Admin Signature Verification Has a Replay/Double-Count Vulnerability

In `verifyAdminSignatures()` (plan lines 779-818), the same operator key can satisfy multiple signatures. The function iterates `signatures` and for each, tries all `operatorKeys`. If operator A signs twice (submitting two identical or different signatures), both will count toward the threshold. This defeats the purpose of M-of-N -- a single operator with threshold=2 can sign twice and pass the check.

**Fix needed**: Track which operator keys have already been matched and exclude them from subsequent iterations. For example:

```javascript
const usedKeys = new Set();
for (const sigBase64 of signatures) {
  for (const keyBase64 of operatorKeys) {
    if (usedKeys.has(keyBase64)) continue;
    // ... verify ...
    if (valid) {
      validCount++;
      usedKeys.add(keyBase64);
      break;
    }
  }
}
```

### High: Canonical JSON Serialization Is Fragile

`verifySelfSignedRegistration()` uses `JSON.stringify(payload, Object.keys(payload).sort())` for canonical encoding. This has several issues:

1. `Object.keys(payload).sort()` only sorts top-level keys. Nested objects retain insertion order.
2. The payload object is constructed inline in `registerServer()` with keys `{ serverId, endpoint, publicKey, region, timestamp }`. If the calling code constructs the object with keys in a different order, `Object.keys().sort()` will produce the same sorted output -- but this only works if both signer and verifier use the exact same canonicalization. There is no specification for what fields are included.
3. The `timestamp` field uses `body.timestamp || Date.now()`. If the server falls back to `Date.now()`, the signer cannot have known this timestamp in advance, making signature verification impossible.

**Recommendation**: Define the canonical format explicitly. Require `timestamp` to be provided by the registering server (reject if missing when auth is required). Consider using a dedicated canonicalization library or JCS (RFC 8785).

### Medium: Audit Log Has No Internal Authentication

The plan notes (line 1041-1042): "No authentication - this is called internally by ServerRegistryDO. Consider adding internal auth token if needed." Since Durable Objects are accessed by ID name, any code running in the same Worker with access to the `AUDIT_LOG` binding can post arbitrary audit events. While this is an internal-only risk, it means a compromised Worker handler could inject false audit entries, undermining the audit trail's integrity.

### Medium: No Timestamp Replay Protection on Registration

The `verifySelfSignedRegistration()` function verifies the signature but does not check whether the timestamp is recent. An attacker who captures a valid signed registration payload can replay it indefinitely. The plan adds a `timestamp` field but never validates its freshness.

### Low: `secrets.js-grempe` Dependency Risk

The Shamir implementation depends on `secrets.js-grempe`. This package has not been updated since 2021 and has limited maintenance. For a security-critical key ceremony tool, consider using a more actively maintained alternative or implementing Shamir's Secret Sharing directly (the algorithm is straightforward for GF(2^8)).

### Low: Shamir Key Reconstruction Tool Generates Spurious Public Key

In `shamir-reconstruct.mjs` (plan lines 293-295), the code generates a new random keypair to get a public key:
```javascript
const publicKeyBytes = new Uint8Array(
  await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey('Ed25519', true, ['sign'])).publicKey)
);
```
This generates a completely unrelated public key. The comment acknowledges this ("We can't easily get the public key from the imported private key"). The public key bytes are computed but never used, which is dead code. The tool should either derive the correct public key or remove the dead code.

---

## Recommended Changes

### Must Fix (Before Implementation)

1. **Correct all line number references in the story document**. The story references an older version of the codebase and nearly every line citation is wrong. Update the story to reflect the actual code, including the existing authentication in `fetch()`.

2. **Fix the admin signature double-count vulnerability** in `verifyAdminSignatures()` by tracking used keys.

3. **Add a freshness check on registration timestamps**. Reject registration payloads where `body.timestamp` is more than N minutes old (e.g., 5 minutes).

4. **Add `wrangler.jsonc` migration tag** for the new `AuditLogDO` class. Without this, deployment will fail.

5. **Add `AuditLogDO` binding to the QA environment** in `wrangler.jsonc` under `env.qa.durable_objects.bindings`.

6. **Require `timestamp` in self-signed registrations** rather than falling back to `Date.now()`. A server-generated timestamp cannot be signed by the client.

### Should Fix (Before Merge)

7. **Clearly mark Phase 2 (FROST) as design-only**. Either remove the implementation code and replace with a specification, or defer Phase 2 entirely. The current pseudo-code will not pass any tests and will confuse implementers.

8. **Add `unregisterServer()` modification code**. The plan mentions modifying it but provides no diff. Show the actual change, accounting for the existing publicKey ownership check.

9. **Address heartbeat authentication**. The story identifies this as a weakness but the plan ignores it. At minimum, add a note explaining why it is deferred or propose a solution (e.g., require heartbeat payloads to be signed by the server's registered publicKey).

10. **Implement emergency revocation endpoint** or explicitly defer it with a rationale. It is an acceptance criterion in the story.

11. **Remove dead code** in `shamir-reconstruct.mjs` (the spurious public key generation).

### Nice to Have

12. **Adopt RFC 8785 (JCS)** for canonical JSON serialization instead of `Object.keys().sort()`.

13. **Add internal auth token** for the audit log POST endpoint to prevent arbitrary event injection from within the Worker.

14. **Add log rotation** to `AuditLogDO` from the start (the plan acknowledges this as a high-risk rollback scenario but defers it).

15. **Consider `secrets.js-grempe` alternatives** or vendoring the Shamir implementation to reduce dependency risk.
