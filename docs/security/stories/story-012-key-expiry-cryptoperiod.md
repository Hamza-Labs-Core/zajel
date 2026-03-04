# Story 012: Key Expiry/Crypto-Period Limits for Build Signing Keys

## Priority: THIS SPRINT
## Severity: HIGH
## Component: packages/server

## Summary

Build signing keys uploaded via `POST /servers/trusted-keys` are stored with no expiration date, no rotation schedule, and no crypto-period enforcement. Once a key is added to the trusted set, it remains trusted indefinitely -- even if the corresponding private key is compromised. There is no mechanism to distinguish between a key uploaded yesterday and one uploaded a year ago, and no automated process to force key rotation.

## Current Behavior

**Key storage format** (`packages/server/src/durable-objects/server-registry-do.js`, lines 964-967):
```javascript
const plainData = { keys: finalKeys, updatedAt: Date.now() };
const stored = await BuildVerifier.encryptKeys(plainData, this.env.CI_UPLOAD_SECRET);
await this.state.storage.put('trusted_build_keys', stored);
```
The storage format is `{ keys: string[], updatedAt: number }` -- a flat array of base64 public keys with a single `updatedAt` timestamp for the entire set. Individual keys have no metadata: no `addedAt`, no `expiresAt`, no `keyId`, no `addedBy`.

**Key loading** (`server-registry-do.js`, lines 214-234, `BuildVerifier.loadTrustedKeys`):
```javascript
async loadTrustedKeys(storage, envFallback, ciSecret) {
  const stored = await storage.get('trusted_build_keys');
  if (stored) {
    if (stored.encrypted && ciSecret) {
      const decrypted = await this.decryptKeys(stored, ciSecret);
      if (Array.isArray(decrypted.keys) && decrypted.keys.length > 0) {
        return decrypted.keys;
      }
    }
    // ...
  }
  // Fallback to env var
  if (!envFallback) return [];
  return envFallback.split(',').map(k => k.trim()).filter(Boolean);
}
```
Keys are loaded as a flat string array. No age check, no expiry check.

**Key trust check** (`server-registry-do.js`, lines 279-281):
```javascript
isTrustedKey(publicKeyBase64, trustedKeys) {
  return trustedKeys.includes(publicKeyBase64);
}
```
Simple array inclusion check. A key that was compromised months ago is indistinguishable from a freshly rotated key.

**Key management endpoints** (`server-registry-do.js`, lines 897-978):
- `POST /servers/trusted-keys` with `{ keys }` replaces the entire set.
- `POST /servers/trusted-keys` with `{ addKeys }` appends without any per-key metadata.
- `POST /servers/trusted-keys` with `{ removeKeys }` removes by value match.
- The `isValidKey` validation on line 919 only checks `typeof k === 'string' && k.length > 0 && k.length <= 100` -- no format validation for base64, no Ed25519 public key structure validation.

**Build verification during registration** (`server-registry-do.js`, lines 573-598):
```javascript
if (buildHash && buildSignature && buildSigningKey) {
  const sigValid = await BuildVerifier.verifySignature(buildHash, buildSignature, buildSigningKey);
  const trustedKeys = await BuildVerifier.loadTrustedKeys(...);
  const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
  buildVerified = sigValid && keyTrusted;
}
```
Note the `trustedKeys.length === 0` fallback on line 586 -- if no trusted keys are configured, ALL keys are trusted. This is documented as a bootstrap convenience but has no warning or degraded-trust indicator.

**Environment variable fallback** (`server-registry-do.js`, line 233):
Keys from `TRUSTED_BUILD_KEYS` env var have even less metadata -- they are static strings set at deploy time and never expire.

## Expected Behavior

1. Each trusted key should have per-key metadata: `keyId`, `publicKey`, `addedAt`, `expiresAt`, `addedBy` (CI job URL or identifier).
2. Keys should have a maximum crypto-period (e.g., 90 days). After expiry, the key is no longer trusted for new build verifications.
3. An alarm or scheduled check should flag keys approaching expiry (e.g., 14 days before).
4. The `POST /servers/trusted-keys` endpoint should require `expiresAt` when adding keys, with a maximum allowed value.
5. `GET /servers/trusted-keys` should return per-key metadata including time-to-expiry.
6. Build verification should check key expiry before trusting the signature.
7. When `trustedKeys.length === 0`, the `buildVerified` field should be `false` (not implicitly trusted).

## Root Cause Analysis

The trusted key system was designed for the initial rollout where a single CI pipeline generates one long-lived signing key. The storage format (`{ keys: string[], updatedAt }`) reflects this: it's a set-level operation, not a per-key-level operation.

As the project moves toward multi-operator federation where different VPS operators may have their own build signing keys, the lack of per-key lifecycle management becomes a critical gap:
- A compromised operator's key cannot be expired; it must be explicitly removed via `removeKeys`.
- There is no audit trail of when each key was added or by whom.
- The `updatedAt` field only tracks the last modification to the entire set, not individual key additions.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/durable-objects/server-registry-do.js` | 131 | `MAX_TRUSTED_BUILD_KEYS = 50` constant |
| `packages/server/src/durable-objects/server-registry-do.js` | 172-204 | `BuildVerifier.encryptKeys` / `decryptKeys` (flat `{ keys, updatedAt }` format) |
| `packages/server/src/durable-objects/server-registry-do.js` | 214-234 | `BuildVerifier.loadTrustedKeys` (no expiry filtering) |
| `packages/server/src/durable-objects/server-registry-do.js` | 279-281 | `BuildVerifier.isTrustedKey` (no expiry check) |
| `packages/server/src/durable-objects/server-registry-do.js` | 573-598 | Build verification during server registration (uses `length === 0` fallback) |
| `packages/server/src/durable-objects/server-registry-do.js` | 747-765 | Build verification during heartbeat (same issue) |
| `packages/server/src/durable-objects/server-registry-do.js` | 897-978 | `setTrustedKeys` handler (no per-key metadata) |
| `packages/server/src/durable-objects/server-registry-do.js` | 986-1032 | `getTrustedKeys` handler (returns flat array) |
| `packages/server/src/durable-objects/server-registry-do.js` | 919 | `isValidKey` validation (no format enforcement) |

## Reproduction Steps

1. **Add a key with no expiry**:
   ```bash
   curl -X POST https://bootstrap.example.com/servers/trusted-keys \
     -H "Authorization: Bearer $CI_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"addKeys": ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]}'
   ```
   The key is now trusted forever.

2. **Verify key never expires**:
   ```bash
   # Wait any amount of time, then register a server with this key
   curl -X POST https://bootstrap.example.com/servers \
     -H "Authorization: Bearer $SERVER_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"serverId":"test","endpoint":"wss://test.example.com","publicKey":"...","buildHash":"abc123","buildSignature":"...","buildSigningKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}'
   # buildVerified: true (even years later)
   ```

3. **Empty trusted keys set -- all keys trusted**:
   ```bash
   curl -X POST https://bootstrap.example.com/servers/trusted-keys \
     -H "Authorization: Bearer $CI_SECRET" \
     -d '{"keys": []}'
   # Now trustedKeys.length === 0, so ALL build signing keys are accepted
   ```

## Impact Assessment

- **Compromised key longevity**: If a build signing private key is leaked, the attacker can sign arbitrary builds and register them as `buildVerified: true` indefinitely. The only remediation is manual removal via `removeKeys`, which requires knowing which key was compromised and having CI access.
- **No rotation pressure**: Without expiry, there is zero incentive or mechanism to rotate signing keys. Long-lived signing keys are a known cryptographic anti-pattern (NIST SP 800-57 recommends crypto-periods).
- **Audit gap**: No per-key `addedAt` metadata means there is no way to audit when a key was introduced or correlate it with a CI build.
- **Zero-trust-keys fallback**: When `trustedKeys.length === 0`, the `buildVerified` field becomes meaningfully `true` for any signature, giving a false sense of security.
- **Blast radius**: All federation servers that register with a compromised signing key appear as legitimate (`buildVerified: true`) to all clients querying `GET /servers`.

## Proposed Fix

### 1. Migrate storage format to per-key metadata

```javascript
// New storage format
{
  keys: [
    {
      keyId: "sha256-fingerprint-of-public-key",
      publicKey: "base64-encoded-ed25519-public-key",
      addedAt: 1709000000000,
      expiresAt: 1716776000000,  // addedAt + 90 days
      addedBy: "github-actions/run-12345",
      revoked: false,
    },
    // ...
  ],
  updatedAt: 1709000000000,
  schemaVersion: 2,
}
```

### 2. Enforce expiry on key addition

```javascript
// In setTrustedKeys handler:
const MAX_KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

for (const key of body.addKeys) {
  const expiresAt = key.expiresAt || (Date.now() + MAX_KEY_LIFETIME_MS);
  if (expiresAt - Date.now() > MAX_KEY_LIFETIME_MS) {
    return this.jsonResponse({ error: `Key expiry exceeds maximum ${MAX_KEY_LIFETIME_MS}ms` }, 400);
  }
  // ... store with metadata
}
```

### 3. Filter expired keys during verification

```javascript
// In BuildVerifier.loadTrustedKeys:
const now = Date.now();
const validKeys = decrypted.keys
  .filter(k => !k.revoked && k.expiresAt > now)
  .map(k => k.publicKey);
return validKeys;
```

### 4. Fix the empty-set fallback

```javascript
// In registerServer:
const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
// Note: reversed logic -- empty set means NOT trusted
```

### 5. Add alarm for expiring keys

```javascript
// In the DO alarm handler:
const keys = await BuildVerifier.loadTrustedKeysRaw(this.state.storage, this.env.CI_UPLOAD_SECRET);
const now = Date.now();
const WARNING_PERIOD = 14 * 24 * 60 * 60 * 1000; // 14 days
for (const key of keys) {
  if (key.expiresAt - now < WARNING_PERIOD && !key.revoked) {
    this.logger.warn('[audit] Trusted build key expiring soon', {
      action: 'key_expiry_warning',
      keyId: key.keyId,
      expiresAt: new Date(key.expiresAt).toISOString(),
    });
  }
}
```

### 6. Add key fingerprint computation

```javascript
async function computeKeyFingerprint(publicKeyBase64) {
  const keyBytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', keyBytes);
  return Array.from(new Uint8Array(hash.slice(0, 8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(':');
}
```

## Acceptance Criteria

- [ ] Key storage format includes per-key metadata: `keyId`, `publicKey`, `addedAt`, `expiresAt`, `addedBy`
- [ ] `POST /servers/trusted-keys` with `addKeys` requires `expiresAt` for each key (or applies a default max of 90 days)
- [ ] `expiresAt` cannot exceed the maximum crypto-period (90 days from now)
- [ ] `BuildVerifier.loadTrustedKeys` filters out expired and revoked keys before returning
- [ ] `GET /servers/trusted-keys` returns per-key metadata including time-to-expiry
- [ ] Build verification fails (returns `buildVerified: false`) when `trustedKeys` is empty
- [ ] DO alarm logs warnings for keys expiring within 14 days
- [ ] Backward compatibility: existing flat-format keys are migrated on first read (treated as added now, expiring in 90 days)
- [ ] Key validation enforces proper base64 format and 32-byte decoded length for Ed25519 public keys

## Test Requirements

1. **Key expiry filtering**:
   - Add a key with `expiresAt` in the past, verify it is filtered out by `loadTrustedKeys`
   - Add a key with `expiresAt` in the future, verify it is included
   - Add a revoked key, verify it is filtered out

2. **Maximum crypto-period enforcement**:
   - Attempt to add a key with `expiresAt` > 90 days from now, verify 400 response
   - Add a key with no `expiresAt`, verify it defaults to 90 days from now

3. **Empty set behavior**:
   - Clear all trusted keys, then register a server with a signed build
   - Verify `buildVerified` is `false` (not `true`)

4. **Schema migration**:
   - Seed storage with old-format `{ keys: ["base64key"], updatedAt: ... }`
   - Call `loadTrustedKeys`, verify migration to new format
   - Verify migrated keys have `addedAt = updatedAt` and `expiresAt = updatedAt + 90 days`

5. **Key fingerprint uniqueness**:
   - Add the same key twice, verify deduplication by fingerprint

6. **Alarm warning test**:
   - Add a key expiring in 7 days, trigger the alarm, verify warning is logged

## Dependencies

- Related: Story 017 (Transparency Log for Key Changes) -- key metadata feeds into the transparency log
- Related: Story 016 (SLSA Build Provenance) -- build signing keys are the trust root for provenance
