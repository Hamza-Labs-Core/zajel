# Story 002: Flip Empty Trusted Keys Default to Deny

## Priority: IMMEDIATE
## Severity: CRITICAL
## Component: packages/server (CF Workers)

## Summary

The build signature verification logic in `ServerRegistryDO` uses an "allow-all" default when no trusted build signing keys are configured. The expression `trustedKeys.length === 0 || BuildVerifier.isTrustedKey(...)` means that any server presenting a valid Ed25519 signature (signed with any key, including attacker-generated keys) is marked as `buildVerified: true` when the operator has not yet configured trusted keys. This defeats the entire purpose of build verification -- an attacker can sign a malicious build with their own key and it will be treated as trusted.

## Current Behavior

In `packages/server/src/durable-objects/server-registry-do.js`, the trusted key check appears in two locations:

**Line 586** (in `registerServer`):
```javascript
const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
```

**Line 750-751** (in `heartbeat`):
```javascript
const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
```

In both cases, `keyTrusted` is `true` when:
1. No trusted keys exist in DO storage AND no `TRUSTED_BUILD_KEYS` env var is set (`trustedKeys.length === 0` short-circuits to `true`), OR
2. The provided key is in the trusted set.

The `BuildVerifier.loadTrustedKeys()` method (lines 214-233) returns an empty array when neither DO storage nor the env var contains keys:

```javascript
if (!envFallback) return [];
return envFallback.split(',').map(k => k.trim()).filter(Boolean);
```

The result `buildVerified = sigValid && keyTrusted` (line 588) will be `true` for any server that provides a valid self-signed build, as long as trusted keys have not been configured.

## Expected Behavior

When no trusted keys are configured, **no builds should be verified**. The default should be deny-all, not allow-all. `keyTrusted` should be `false` when `trustedKeys.length === 0`, meaning `buildVerified` will be `false` until an operator explicitly uploads trusted keys.

## Root Cause Analysis

This is a classic "fail-open" security anti-pattern. The developer likely intended the empty-keys check as a convenience for development/testing: "if no keys are configured, don't enforce key checking." However, this creates a security gap in production:

1. A new CF Workers deployment starts with no trusted keys.
2. Any VPS server with a self-signed build registers and gets `buildVerified: true`.
3. The `listServers` endpoint (line 633) returns these servers to clients, which may use `buildVerified` as a trust signal.
4. An attacker registers a rogue server with a self-signed build -- it appears verified and trustworthy.
5. Even after the operator configures trusted keys, there is a window where rogue servers were accepted.

The problem is compounded by the fact that `buildVerified` is stored in the server entry (line 610) and returned in the public `GET /servers` response. Clients or other servers may make trust decisions based on this field.

The flow for build verification:
1. VPS sends `POST /servers` with `buildHash`, `buildSignature`, `buildSigningKey` fields
2. `BuildVerifier.verifySignature()` checks the Ed25519 signature is valid (line 582) -- this only proves the signer possessed the private key
3. `BuildVerifier.loadTrustedKeys()` loads the allowed key set (line 585)
4. The `trustedKeys.length === 0` check bypasses key validation entirely (line 586)
5. `buildVerified` is set to `true` and persisted (lines 588, 617)

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/durable-objects/server-registry-do.js` | 586 | `keyTrusted` allow-all in `registerServer()` |
| `packages/server/src/durable-objects/server-registry-do.js` | 751 | `keyTrusted` allow-all in `heartbeat()` |
| `packages/server/src/durable-objects/server-registry-do.js` | 214-233 | `loadTrustedKeys()` returns empty array when unconfigured |
| `packages/server/src/durable-objects/server-registry-do.js` | 279-281 | `isTrustedKey()` -- correct but bypassed |
| `packages/server/src/durable-objects/server-registry-do.js` | 588 | `buildVerified` assignment |
| `packages/server/src/durable-objects/server-registry-do.js` | 610 | `buildVerified` persisted in server entry |
| `packages/server/src/durable-objects/server-registry-do.js` | 752 | `buildVerified` re-assignment in heartbeat |

## Reproduction Steps

1. Deploy the CF Workers server WITHOUT setting `TRUSTED_BUILD_KEYS` env var and without uploading keys via `POST /servers/trusted-keys`.
2. Generate a fresh Ed25519 keypair (attacker-controlled).
3. Sign an arbitrary build hash with the attacker's private key.
4. Send `POST /servers` with the attacker's `buildSigningKey`, valid `buildSignature`, and arbitrary `buildHash`.
5. Observe the response contains `buildVerified: true`.
6. Send `GET /servers` and confirm the rogue server appears with `buildVerified: true`.

## Impact Assessment

- **Rogue servers appear verified**: Any attacker can register a server that shows `buildVerified: true` in the public server listing, which clients may use to decide which servers to trust for signaling.
- **Trust erosion**: The `buildVerified` flag becomes meaningless -- it only proves someone signed something, not that the build is authentic.
- **Window of vulnerability**: Even in deployments that eventually configure trusted keys, the period between deployment and key configuration is fully vulnerable.
- **Heartbeat re-verification bypass**: The same bug in the heartbeat handler (line 751) means an attacker can maintain `buildVerified: true` indefinitely through heartbeats, even if the original registration somehow caught the issue.

## Proposed Fix

Change the default from allow-all to deny-all in both locations:

```javascript
// In registerServer() -- line 586
const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);

// In heartbeat() -- line 751
const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
```

Additionally, add an audit log entry when build verification is skipped due to no trusted keys being configured:

```javascript
if (trustedKeys.length === 0) {
  this.logger.warn('[audit] Build verification skipped: no trusted keys configured', {
    action: 'build_verify_no_keys',
    serverId,
  });
}
```

Consider also adding a startup check or health indicator that warns operators when `TRUSTED_BUILD_KEYS` is not configured.

## Acceptance Criteria

- [ ] When no trusted keys are configured (empty DO storage and no env var), `buildVerified` is `false` for all servers.
- [ ] When trusted keys are configured, only servers signed with a trusted key get `buildVerified: true`.
- [ ] The `registerServer` and `heartbeat` handlers both use deny-default logic.
- [ ] An audit log warning is emitted when build verification is attempted but no trusted keys are configured.
- [ ] Existing servers with `buildVerified: true` from the old allow-all behavior are re-verified on next heartbeat (they will flip to `false` if their key is not in the trusted set).
- [ ] The `loadTrustedKeys()` return value is not changed (it still returns `[]` when unconfigured) -- only the caller's interpretation changes.

## Test Requirements

- **Unit test**: Verify that `buildVerified` is `false` when `trustedKeys` is empty and a valid signature is provided.
- **Unit test**: Verify that `buildVerified` is `true` when the signing key is in the trusted set and signature is valid.
- **Unit test**: Verify that `buildVerified` is `false` when the signing key is NOT in the trusted set, even with valid signature.
- **Unit test**: Verify the heartbeat path also correctly denies when no trusted keys are configured.
- **Integration test**: Register a server with a self-signed build when no trusted keys are configured; confirm `buildVerified` is `false`.

## Dependencies

- None. This is a self-contained fix that changes the interpretation of an empty trusted key set.
