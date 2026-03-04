# [LOW] No request logging or audit trail for security-sensitive operations

**Area**: Server
**File**: packages/server/src/index.js, packages/server/src/durable-objects/attestation-registry-do.js
**Type**: Best Practice

**Description**: Security-sensitive operations have no structured logging or audit trail:
- Server registration and deletion (server-registry-do.js)
- Device registration (attestation-registry-do.js)
- Attestation challenge and verification (attestation-registry-do.js)
- Version policy updates (attestation-registry-do.js)
- Failed authentication attempts (CI_UPLOAD_SECRET checks)

The `logger.js` module exists but is only used in `SignalingRoom` (which is dead code). The live Durable Objects (`ServerRegistryDO`, `AttestationRegistryDO`) use only bare `console.error` calls for crash-level errors.

**Impact**: Without audit logging:
- Security incidents cannot be investigated or traced.
- Failed authentication attempts are not tracked (no brute-force detection).
- Administrative actions (version policy changes) leave no audit trail.
- Compliance requirements (who accessed what, when) cannot be met.

**Fix**:
1. Add structured logging to all security-sensitive operations.
2. Log at minimum: timestamp, action, source IP (from `request.headers.get('CF-Connecting-IP')`), result (success/failure), and relevant identifiers.
3. Consider using Cloudflare Logpush for persistent log storage.
4. Use the existing `createLogger` utility in all Durable Objects.
