# Story 021: TUF Role Hierarchy for Registry Trust

## Priority: LONG-TERM
## Severity: MEDIUM
## Component: packages/server

## Summary

The Zajel bootstrap server uses a single Ed25519 signing key (`BOOTSTRAP_SIGNING_KEY`) to sign all server registry responses. There is no role separation, no delegation hierarchy, and no threshold signing as defined by The Update Framework (TUF) specification. A single compromised key grants an attacker full control over the server registry trust chain, allowing them to inject malicious VPS servers into the federation mesh.

## Current Behavior

The bootstrap server's trust model is a flat, single-key architecture with no role separation:

**Key generation** (`scripts/generate-bootstrap-keys.mjs`, lines 16-26): A single Ed25519 keypair is generated using `crypto.subtle.generateKey()`. The 32-byte private seed is stored as a Cloudflare Workers secret (`BOOTSTRAP_SIGNING_KEY`), and the corresponding public key is hardcoded in the Flutter app.

```javascript
// scripts/generate-bootstrap-keys.mjs:16-26
const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
const seed = privateKeyBytes.slice(-32);
const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
```

**Key import and signing** (`packages/server/src/crypto/signing.js`, lines 27-58): The hex-encoded seed is imported by wrapping it in PKCS8 ASN.1 format. The `signPayload()` function signs an arbitrary UTF-8 payload and returns a base64 signature. There is no concept of what "role" this key represents -- it is used for everything.

```javascript
// packages/server/src/crypto/signing.js:27-46
export async function importSigningKey(hexSeed) {
  const seed = hexToBytes(hexSeed);
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
}
```

**Response signing** (`packages/server/src/index.js`, lines 77-104): The `GET /servers` handler fetches the server list from the `ServerRegistryDO` Durable Object, adds a timestamp, and signs the entire JSON body with the single key. If the key is not configured, responses are served unsigned (graceful degradation).

```javascript
// packages/server/src/index.js:92-101
if (env.BOOTSTRAP_SIGNING_KEY) {
  try {
    const key = await importSigningKey(env.BOOTSTRAP_SIGNING_KEY);
    headers['X-Bootstrap-Signature'] = await signPayload(key, body);
  } catch (e) {
    console.error('Failed to sign bootstrap response:', e);
  }
}
```

**Client-side verification** (`packages/app/lib/core/crypto/bootstrap_verifier.dart`, lines 14-16): The Flutter app hardcodes two public keys (production and QA). There is no mechanism for key rotation, revocation, or delegation.

```dart
// packages/app/lib/core/crypto/bootstrap_verifier.dart:14-16
static const _productionPublicKey = 'attUirGAvR2WHcjz00q9lZoQTkWw5QmzJVM0waXwlWQ=';
static const _qaPublicKey = 'aT6HRI0epsGWdhIX2E2I0h/j/h/9ravxrjl09qnGc/A=';
```

**Server registration** (`packages/server/src/durable-objects/server-registry-do.js`, lines 62-88): Any party can register a server by POSTing to `/servers` with a `serverId`, `endpoint`, and `publicKey`. There is no authentication, no signature verification on the registration request, and no trust chain validation.

```javascript
// packages/server/src/durable-objects/server-registry-do.js:62-88
async registerServer(request, corsHeaders) {
  const body = await request.json();
  const { serverId, endpoint, publicKey, region } = body;
  if (!serverId || !endpoint || !publicKey) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
      { status: 400 }
    );
  }
  const serverEntry = { serverId, endpoint, publicKey, region: region || 'unknown', ... };
  await this.state.storage.put(`server:${serverId}`, serverEntry);
}
```

## Expected Behavior

The registry trust model should implement TUF-style role separation with the following roles:

1. **Root role**: Signs the top-level trust metadata. Requires offline, high-security key management. Defines which keys are authorized for each delegated role.
2. **Targets role**: Signs the actual server registry entries (the list of authorized VPS servers and their public keys).
3. **Snapshot role**: Signs a consistent view of all metadata files (prevents mix-and-match attacks).
4. **Timestamp role**: Signs a short-lived timestamp proving the metadata is current (prevents freeze attacks).

Each role should have its own key(s), stored with appropriate security levels. Root keys should be offline and require multiple signers. Timestamp and snapshot keys can be online but should be rotatable without app updates.

## Root Cause Analysis

The current system was designed for simplicity: a single Ed25519 key signs server list responses, and clients verify with a hardcoded public key. This was adequate for the initial architecture where the bootstrap server is a trusted Cloudflare Worker, but it has several fundamental weaknesses:

1. **No role separation**: The same key that signs the server list could theoretically be used to sign anything. There is no metadata schema that constrains what a key is authorized to do.

2. **No key rotation without app update**: The public keys in `bootstrap_verifier.dart` are compile-time constants. Rotating the signing key requires pushing a new app version to all clients. This makes incident response (compromised key) extremely slow.

3. **No delegation**: All trust flows through a single key. There is no mechanism for the root to delegate signing authority to subordinate keys, which means the root key must be online and accessible to the Cloudflare Worker at all times.

4. **No freeze attack protection**: While the response includes a `timestamp` field and the client checks for freshness (5-minute window in `bootstrap_verifier.dart:19`), there is no signed metadata that guarantees the server list itself is the latest version. An attacker who compromises a previous valid signed response can replay it within the 5-minute window.

5. **No consistent snapshot**: The client receives a flat list of servers. There is no mechanism to verify that the list is a complete and consistent view of the registry (preventing partial-list attacks).

6. **Open registration**: The `POST /servers` endpoint accepts any registration without cryptographic proof that the registrant controls the claimed `publicKey`. An attacker can register servers with arbitrary public keys.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `scripts/generate-bootstrap-keys.mjs` | 1-35 | Single-key generation script, no role concept |
| `packages/server/src/crypto/signing.js` | 1-58 | Generic signing utilities, no role-aware signing |
| `packages/server/src/index.js` | 77-104 | GET /servers handler, single-key signing |
| `packages/server/src/durable-objects/server-registry-do.js` | 62-88 | Open server registration, no authentication |
| `packages/server/src/durable-objects/server-registry-do.js` | 90-111 | Server listing, no snapshot/version metadata |
| `packages/app/lib/core/crypto/bootstrap_verifier.dart` | 14-16 | Hardcoded public keys, no key rotation support |
| `packages/app/lib/core/crypto/bootstrap_verifier.dart` | 47-72 | Single-key verification, no role validation |
| `packages/server/wrangler.jsonc` | 1-64 | No configuration for multiple signing keys or roles |

## Reproduction Steps

1. Generate a bootstrap keypair using `node scripts/generate-bootstrap-keys.mjs`.
2. Store the private seed as `BOOTSTRAP_SIGNING_KEY` in Cloudflare Workers.
3. Deploy the bootstrap server.
4. Observe that all signing operations use this single key.
5. Attempt to rotate the key -- this requires updating the hardcoded public key in `bootstrap_verifier.dart` and releasing a new app version.
6. Attempt to register a malicious server via `POST /servers` -- no authentication is required.

## Impact Assessment

- **Single point of failure**: Compromise of the `BOOTSTRAP_SIGNING_KEY` Cloudflare secret grants full control over the federation trust chain. An attacker can sign arbitrary server lists, directing all clients to malicious servers.
- **Slow incident response**: Key rotation requires an app update (modifying `bootstrap_verifier.dart`), which takes days to weeks to propagate to all users through app store review processes.
- **No revocation**: There is no mechanism to revoke a compromised key. Even if a new key is deployed server-side, old clients will reject the new signatures.
- **Freeze attacks**: An attacker with a network position can replay a valid signed response within the 5-minute freshness window, potentially hiding newly registered legitimate servers or keeping stale/compromised servers in the list.
- **Open registration abuse**: Without authentication on `POST /servers`, any party can pollute the registry with malicious server entries.

## Proposed Fix

### Phase 1: TUF Metadata Schema

Implement the four TUF roles as separate JSON metadata documents:

1. **Root metadata**: Contains the public keys and thresholds for all roles. Signed by root key(s). Includes a version number and expiration date. The root metadata is the only file that must be trusted out-of-band (embedded in the app).

2. **Targets metadata**: Contains the authoritative list of VPS servers with their endpoints, public keys, and regions. Signed by the targets key. Includes a version number and expiration date.

3. **Snapshot metadata**: Contains hashes and version numbers of all other metadata files. Signed by the snapshot key. Prevents mix-and-match attacks.

4. **Timestamp metadata**: Contains the hash of the current snapshot metadata. Signed by the timestamp key. Short expiration (hours). Prevents freeze attacks.

### Phase 2: Key Hierarchy Implementation

- **Root keys**: Generated offline. Stored in hardware security modules or air-gapped machines. Used only to sign root metadata updates (key rotations, threshold changes).
- **Targets key**: Stored as a Cloudflare Workers secret. Used to sign the server registry when it changes.
- **Snapshot key**: Stored as a Cloudflare Workers secret. Updated whenever targets metadata changes.
- **Timestamp key**: Stored as a Cloudflare Workers secret. Rotated automatically on a short schedule (e.g., weekly). Used to sign timestamp metadata every few minutes.

### Phase 3: Client Verification Update

Update `BootstrapVerifier` to:
1. Fetch and verify the full TUF metadata chain (timestamp -> snapshot -> targets -> root).
2. Support key rotation by trusting root metadata transitions (N+1 verification).
3. Cache verified metadata locally for offline/degraded operation.
4. Enforce metadata expiration to prevent freeze attacks.

### Phase 4: Authenticated Registration

Require VPS servers to prove ownership of their claimed public key when registering:
- The registration request must include a signature over the registration payload using the server's private key.
- The bootstrap server verifies this signature before accepting the registration.

## Acceptance Criteria

- [ ] Root, targets, snapshot, and timestamp roles are defined with separate keys.
- [ ] Root metadata is embedded in the app binary and supports versioned transitions.
- [ ] Targets metadata lists authorized VPS servers and is signed by the targets key.
- [ ] Snapshot metadata prevents mix-and-match attacks on metadata files.
- [ ] Timestamp metadata has a short expiration (e.g., 1 hour) and prevents freeze attacks.
- [ ] Key rotation for any non-root role does not require an app update.
- [ ] Root key rotation uses N+1 trust (old root signs new root metadata).
- [ ] Server registration requires cryptographic proof of key ownership.
- [ ] Client verification follows TUF's metadata verification workflow.
- [ ] All metadata includes version numbers and expiration dates.

## Test Requirements

- **Unit tests**: Verify each role's signing and verification in isolation.
- **Integration tests**: Verify the full metadata chain (timestamp -> snapshot -> targets) verification.
- **Key rotation tests**: Verify that rotating targets/snapshot/timestamp keys produces metadata that old-root-trusting clients can still verify.
- **Root rotation tests**: Verify N+1 root key transition.
- **Freeze attack tests**: Verify that expired timestamp metadata is rejected.
- **Rollback attack tests**: Verify that lower-version metadata is rejected.
- **Mix-and-match tests**: Verify that targets metadata with an incorrect snapshot hash is rejected.
- **Registration authentication tests**: Verify that server registration without valid key ownership proof is rejected.

## Dependencies

- Story 023 (Threshold Signing) -- TUF root role naturally requires M-of-N threshold signing.
- Story 022 (Sigstore Keyless Signing) -- Online roles (timestamp, snapshot) could use Sigstore ephemeral keys instead of long-lived secrets.

## Research References

- [TUF Specification v1.0.31](https://theupdateframework.github.io/specification/latest/) -- The canonical TUF specification defining roles, metadata format, and verification workflow.
- [TUF: Attacks and Weaknesses](https://theupdateframework.io/security/) -- Threat model and known attack vectors that TUF addresses.
- [python-tuf](https://github.com/theupdateframework/python-tuf) -- Reference implementation.
- [go-tuf](https://github.com/theupdateframework/go-tuf) -- Go implementation, relevant for server-side tooling.
- [PEP 458](https://peps.python.org/pep-0458/) -- TUF integration with PyPI, a real-world deployment reference.
- [Uptane](https://uptane.github.io/) -- TUF adaptation for automotive OTA updates, demonstrates TUF in constrained environments similar to mobile apps.
