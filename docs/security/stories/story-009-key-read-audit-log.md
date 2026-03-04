# Story 009: Add Audit Logging for Successful Key Reads

## Priority: THIS WEEK
## Severity: MEDIUM
## Component: packages/server (ServerRegistryDO)

## Summary

The `getTrustedKeys` method in `ServerRegistryDO` logs failed authentication attempts (`trusted_keys_read_failed` at line 995-998) but does not log successful reads. This creates a blind spot in the audit trail: an operator can see who failed to read trusted build keys but has no record of who successfully accessed them. Trusted build keys are security-critical assets that determine which server binaries are considered authentic in the federation.

## Current Behavior

In `packages/server/src/durable-objects/server-registry-do.js`, the `getTrustedKeys` method (lines 986-1032) handles the `GET /servers/trusted-keys` endpoint.

**Failed authentication is logged** (lines 994-998):

```javascript
// server-registry-do.js:994-998
if (!this.verifyCIAuth(request)) {
  this.logger.warn('[audit] Unauthorized trusted-keys read attempt', {
    action: 'trusted_keys_read_failed',
    ip: request.headers.get('CF-Connecting-IP'),
  });
  // ... return 401
}
```

**Successful read has no logging** (lines 1005-1031):

```javascript
// server-registry-do.js:1005-1031
const raw = await this.state.storage.get('trusted_build_keys');
let keys = [];
let updatedAt = null;

if (raw) {
  if (raw.encrypted) {
    try {
      const decrypted = await BuildVerifier.decryptKeys(raw, this.env.CI_UPLOAD_SECRET);
      keys = decrypted.keys || [];
      updatedAt = decrypted.updatedAt || null;
    } catch {
      return new Response(
        JSON.stringify({ error: 'Failed to decrypt stored keys' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  } else {
    keys = raw.keys || [];
    updatedAt = raw.updatedAt || null;
  }
}

return new Response(
  JSON.stringify({ keys, updatedAt }),
  { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
);
```

No `this.logger.info('[audit] ...')` call is made on the success path.

For comparison, the `setTrustedKeys` method (lines 897-978) properly logs both failures AND successes:

- Failure: `this.logger.warn('[audit] Unauthorized trusted-keys update attempt', ...)` (line 906-909)
- Success: `this.logger.info('[audit] Trusted build keys updated', ...)` (line 969-972)

Other audit-logged operations in the same file:
- `server_register` (line 619-625): Logged with serverId, region, buildVerified, IP
- `server_unregister` (line 695-698): Logged with serverId
- `build_verify` (line 590-598): Logged with serverId, buildHash, verification result
- `build_hash_changed` (line 758-764): Logged with serverId and hash changes
- `anomaly_detected` (line 828-836): Logged with serverId and anomaly details

The `getTrustedKeys` success path is the only security-sensitive operation that lacks an audit log entry.

## Expected Behavior

Every successful read of trusted build keys should be logged with:
- The action type (`trusted_keys_read`)
- The number of keys returned
- The requester's IP address
- The `updatedAt` timestamp of the keys

## Root Cause Analysis

The `getTrustedKeys` endpoint was added as a read-only complement to `setTrustedKeys`. The write operation was given proper audit logging (as writes modify state), but the read operation was overlooked because reads are often considered lower risk. However, for security-critical data like trusted build signing keys:

1. **Key exfiltration detection**: If an attacker compromises `CI_UPLOAD_SECRET`, they can read the current trusted keys without detection. The keys themselves (Ed25519 public keys) are not secret, but knowing which keys are trusted helps an attacker plan a more targeted key replacement attack.
2. **Compliance requirements**: Security audit trails typically require logging all access to sensitive cryptographic material, not just modifications.
3. **Operational visibility**: Operators need to know how frequently and from where trusted keys are being read, especially to detect unauthorized CI pipeline configurations.

The decryption failure path also lacks proper audit logging -- the `catch` block at line 1015 silently returns a 500 error without logging the decryption failure. This could indicate that the `CI_UPLOAD_SECRET` has been changed (possibly by an attacker), which is an important security event.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/durable-objects/server-registry-do.js` | 986-1032 | `getTrustedKeys()` method -- missing success audit log |
| `packages/server/src/durable-objects/server-registry-do.js` | 1015 | Decryption failure -- silent catch, no audit log |

## Reproduction Steps

1. Configure the bootstrap server with a `CI_UPLOAD_SECRET`.
2. Upload trusted keys via `POST /servers/trusted-keys`.
3. Read trusted keys via `GET /servers/trusted-keys` with a valid `Authorization: Bearer <CI_UPLOAD_SECRET>`.
4. Check server logs.
5. Observe that the `POST` operation was logged (`trusted_keys_updated`) but the `GET` operation produced no log entry.
6. Query logs for `trusted_keys_read` -- no results.

## Impact Assessment

- **Audit gap**: No forensic trail for who read the trusted keys and when. In a security incident involving build signing key compromise, investigators cannot determine if the attacker enumerated the current trusted keys before replacing them.
- **Compliance**: Fails to meet typical logging requirements for access to cryptographic key material.
- **Operational blindness**: Cannot detect abnormal read patterns (e.g., frequent reads from unusual IPs) that might indicate reconnaissance.
- **Silent decryption failures**: If `CI_UPLOAD_SECRET` is changed (rotated or compromised), the decryption failure goes unlogged, delaying detection.

## Proposed Fix

Add audit logging on both the success and decryption-failure paths:

```javascript
async getTrustedKeys(request, corsHeaders) {
  if (!this.env.CI_UPLOAD_SECRET) {
    return new Response(
      JSON.stringify({ error: 'Trusted key management not configured' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  if (!this.verifyCIAuth(request)) {
    this.logger.warn('[audit] Unauthorized trusted-keys read attempt', {
      action: 'trusted_keys_read_failed',
      ip: request.headers.get('CF-Connecting-IP'),
    });
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  const raw = await this.state.storage.get('trusted_build_keys');
  let keys = [];
  let updatedAt = null;

  if (raw) {
    if (raw.encrypted) {
      try {
        const decrypted = await BuildVerifier.decryptKeys(raw, this.env.CI_UPLOAD_SECRET);
        keys = decrypted.keys || [];
        updatedAt = decrypted.updatedAt || null;
      } catch (err) {
        // NEW: Log decryption failure (possible secret rotation or compromise)
        this.logger.error('[audit] Failed to decrypt trusted build keys', {
          action: 'trusted_keys_decrypt_failed',
          ip: request.headers.get('CF-Connecting-IP'),
          error: err?.message || 'unknown',
        });
        return new Response(
          JSON.stringify({ error: 'Failed to decrypt stored keys' }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    } else {
      keys = raw.keys || [];
      updatedAt = raw.updatedAt || null;
    }
  }

  // NEW: Log successful read
  this.logger.info('[audit] Trusted build keys read', {
    action: 'trusted_keys_read',
    keyCount: keys.length,
    updatedAt,
    ip: request.headers.get('CF-Connecting-IP'),
  });

  return new Response(
    JSON.stringify({ keys, updatedAt }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

## Acceptance Criteria

- [ ] Successful `GET /servers/trusted-keys` requests are logged with action `trusted_keys_read`
- [ ] The log entry includes the number of keys returned (`keyCount`)
- [ ] The log entry includes the requester's IP address (`CF-Connecting-IP`)
- [ ] The log entry includes the `updatedAt` timestamp of the keys
- [ ] Decryption failures are logged with action `trusted_keys_decrypt_failed` including the error message and IP
- [ ] Existing failure logging (`trusted_keys_read_failed`) is not affected
- [ ] Log format is consistent with other audit log entries in the file (using `this.logger.info('[audit] ...')` pattern)

## Test Requirements

- **Unit test**: Mock a successful `GET /servers/trusted-keys` request with valid auth. Assert that the logger's `info` method was called with `action: 'trusted_keys_read'` and the correct `keyCount`.
- **Unit test**: Mock a request where decryption fails (e.g., wrong secret). Assert that the logger's `error` method was called with `action: 'trusted_keys_decrypt_failed'`.
- **Unit test**: Verify that the log entry includes `ip` from `CF-Connecting-IP` header.
- **Unit test**: Verify that failed auth still logs `trusted_keys_read_failed` (regression test).
- **Unit test**: When no keys are stored, the success log should show `keyCount: 0`.

## Dependencies

- No blocking dependencies on other stories.
- This is a low-risk, isolated change that can be deployed independently.
