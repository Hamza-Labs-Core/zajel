# Story 023: Threshold Signing (M-of-N) for Root Key Operations

## Priority: LONG-TERM
## Severity: MEDIUM
## Component: packages/server

## Summary

All trust-critical operations in the Zajel bootstrap server -- server registration, key upload, key rotation, and response signing -- are controlled by a single cryptographic key. There is no M-of-N threshold requirement for any operation. A single compromised key or a single rogue operator can unilaterally modify the server registry, inject malicious servers, or replace the signing key. Threshold signing (requiring M-of-N key holders to agree) would prevent any single point of compromise from subverting the trust model.

## Current Behavior

### Single-Key Signing Authority

**Bootstrap signing** (`packages/server/src/index.js`, lines 92-101): A single `BOOTSTRAP_SIGNING_KEY` secret controls all response signing. Whoever possesses this 32-byte seed has complete authority to produce signatures that every client will accept.

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

There is no multi-party authorization. The key is a Cloudflare Workers secret accessible to anyone with `wrangler secret` access to the project.

### Unauthenticated Server Registration

**Registration endpoint** (`packages/server/src/durable-objects/server-registry-do.js`, lines 62-88): Server registration is completely open. Any HTTP client can register a server by posting a JSON body with `serverId`, `endpoint`, and `publicKey`. There is no authorization check, no signature verification, and no requirement for multiple parties to approve a registration.

```javascript
// packages/server/src/durable-objects/server-registry-do.js:62-88
async registerServer(request, corsHeaders) {
  const body = await request.json();
  const { serverId, endpoint, publicKey, region } = body;

  if (!serverId || !endpoint || !publicKey) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  const serverEntry = {
    serverId,
    endpoint,
    publicKey,
    region: region || 'unknown',
    registeredAt: Date.now(),
    lastSeen: Date.now(),
  };

  await this.state.storage.put(`server:${serverId}`, serverEntry);
  // ...
}
```

### Unauthenticated Server Removal

**Unregistration endpoint** (`packages/server/src/durable-objects/server-registry-do.js`, lines 113-120): Any party can delete any server from the registry by sending a `DELETE /servers/:serverId` request. No authentication or authorization is required.

```javascript
// packages/server/src/durable-objects/server-registry-do.js:113-120
async unregisterServer(serverId, corsHeaders) {
  await this.state.storage.delete(`server:${serverId}`);
  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

### Single-Point Key Management

**Key generation** (`scripts/generate-bootstrap-keys.mjs`, lines 16-35): A single operator runs the key generation script and obtains the full private key. There is no secret sharing, no Shamir's Secret Sharing split, and no multi-party ceremony. The operator who generates the key has unilateral control.

```javascript
// scripts/generate-bootstrap-keys.mjs:16-22
const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
const seed = privateKeyBytes.slice(-32);
const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
```

### Hardcoded Client Trust

**Client-side verification** (`packages/app/lib/core/crypto/bootstrap_verifier.dart`, lines 14-16): The public keys for production and QA are hardcoded constants. Changing these keys (rotation) requires an app update, which means key rotation is effectively a single-party operation (the developer who pushes the update).

```dart
// packages/app/lib/core/crypto/bootstrap_verifier.dart:14-16
static const _productionPublicKey = 'attUirGAvR2WHcjz00q9lZoQTkWw5QmzJVM0waXwlWQ=';
static const _qaPublicKey = 'aT6HRI0epsGWdhIX2E2I0h/j/h/9ravxrjl09qnGc/A=';
```

## Expected Behavior

Critical operations should require M-of-N threshold authorization:

1. **Root key operations** (key rotation, trust policy changes): Require at least 2-of-3 (or 3-of-5) root key holders to co-sign.
2. **Server registration/removal**: Require either (a) a signature from the registering server proving key ownership, or (b) for manual administrative registration, M-of-N operator approval.
3. **Signing key rotation**: Require a threshold of current key holders to authorize the transition to a new key.
4. **Emergency key revocation**: Require a lower threshold (e.g., 1-of-N) to trigger revocation, but a higher threshold (e.g., M-of-N) to install a replacement.

## Root Cause Analysis

The single-key model exists because Zajel was designed as a simple bootstrap discovery service. The Cloudflare Workers runtime offers limited key management capabilities -- secrets are flat key-value pairs, and there is no built-in HSM or multi-party approval workflow. The design prioritized getting the system working over building defense-in-depth.

The specific weaknesses in the control flow are:

1. **No authorization layer**: The `ServerRegistryDO` Durable Object processes all requests without any authentication. The `fetch()` method at line 18 routes directly to handlers based on HTTP method and path, with no middleware for authorization.

2. **Secret as sole authority**: The `env.BOOTSTRAP_SIGNING_KEY` is the entire trust anchor. It is a single Cloudflare secret that can be read by the worker at runtime. Anyone with access to the Cloudflare dashboard or `wrangler` CLI for this project can read or replace this secret.

3. **No key ceremony**: The `generate-bootstrap-keys.mjs` script is designed to be run by a single person on their local machine. There is no ceremony protocol, no witness requirement, and no cryptographic splitting of the resulting key.

4. **Heartbeat trust**: The `heartbeat()` method at line 122 updates a server's `lastSeen` timestamp based solely on the `serverId` provided in the request body. An attacker who knows a valid `serverId` can keep a stale or compromised server entry alive indefinitely.

5. **No operational logging**: None of the `ServerRegistryDO` methods produce audit logs. There is no record of who registered a server, when it was removed, or who rotated a key.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/durable-objects/server-registry-do.js` | 18-60 | Request routing with no authentication middleware |
| `packages/server/src/durable-objects/server-registry-do.js` | 62-88 | Open server registration |
| `packages/server/src/durable-objects/server-registry-do.js` | 113-120 | Open server unregistration |
| `packages/server/src/durable-objects/server-registry-do.js` | 122-159 | Unauthenticated heartbeat |
| `packages/server/src/index.js` | 92-101 | Single-key response signing |
| `packages/server/src/crypto/signing.js` | 27-46 | Single-key import (no threshold support) |
| `scripts/generate-bootstrap-keys.mjs` | 16-35 | Single-party key generation ceremony |
| `packages/app/lib/core/crypto/bootstrap_verifier.dart` | 14-16 | Single public key trust (no threshold verification) |

## Reproduction Steps

1. Obtain the `BOOTSTRAP_SIGNING_KEY` secret (requires Cloudflare dashboard access or `wrangler` CLI access).
2. Use the key to sign an arbitrary server list payload:
   ```javascript
   const key = await importSigningKey(compromisedSeed);
   const maliciousPayload = JSON.stringify({
     servers: [{ serverId: 'evil', endpoint: 'wss://evil.example.com', publicKey: 'attacker-key' }],
     timestamp: Date.now()
   });
   const signature = await signPayload(key, maliciousPayload);
   ```
3. Serve this signed response to clients -- they will accept it and connect to the attacker's server.
4. Alternatively, directly call `POST /servers` to inject a malicious server without any signing key access at all:
   ```bash
   curl -X POST https://signal.zajel.hamzalabs.dev/servers \
     -H 'Content-Type: application/json' \
     -d '{"serverId":"evil","endpoint":"wss://evil.example.com","publicKey":"attacker-key"}'
   ```

## Impact Assessment

- **Single-operator compromise**: A disgruntled or compromised team member with Cloudflare access can unilaterally subvert the entire federation trust chain.
- **Insider threat**: No separation of duties means a single insider can perform all critical operations (register servers, rotate keys, sign responses) without any second-party approval.
- **Key theft**: If the `BOOTSTRAP_SIGNING_KEY` is exfiltrated (e.g., through a Cloudflare vulnerability, a compromised CI pipeline, or social engineering), the attacker has permanent, unilateral signing authority.
- **Registry poisoning**: The open `POST /servers` endpoint allows anyone to inject servers into the registry. While the signed response only covers the `GET /servers` output, a poisoned registry means the signed response itself contains malicious entries.
- **No recovery path**: If the single key is compromised, there is no "other key holders" who can authorize a rotation. The only recovery path is to push an app update with a new hardcoded public key, which takes days to weeks.

## Proposed Fix

### Phase 1: Shamir's Secret Sharing for Root Keys

Implement a key ceremony tool that:
1. Generates an Ed25519 root key pair.
2. Splits the private key seed into N shares using Shamir's Secret Sharing (e.g., 3-of-5).
3. Distributes shares to N key holders on separate secure media.
4. Deletes the original key from the ceremony machine.
5. Produces a signed ceremony log documenting the participants, date, and public key.

For key reconstruction:
1. M key holders submit their shares to a secure ceremony tool.
2. The tool reconstructs the seed, performs the required operation (e.g., signing a new root metadata file), and immediately destroys the reconstructed key.
3. The ceremony is logged with all participant identities.

### Phase 2: Threshold Signature Scheme

For online operations where key reconstruction is impractical, implement a threshold signature scheme:

**Option A: FROST (Flexible Round-Optimized Schnorr Threshold signatures)**
- FROST enables M-of-N threshold signing without ever reconstructing the full key.
- Compatible with Ed25519 (both use Schnorr signatures over elliptic curves).
- Each key holder holds a key share. To produce a signature, M holders participate in a distributed signing protocol.
- The resulting signature is a standard Ed25519 signature verifiable by the public key -- no changes needed on the client side.

**Option B: Multi-signature with aggregation**
- Each authorized signer produces an independent Ed25519 signature.
- The server collects M signatures and includes them all in the response.
- Clients verify that at least M valid signatures are present from the set of known public keys.
- Simpler to implement but requires client-side changes (verify multiple signatures).

### Phase 3: Authenticated Registration

Add a registration authorization protocol:

1. **Self-registration**: VPS servers sign their registration payload with their Ed25519 key. The bootstrap server verifies the signature using the `publicKey` in the payload (proof of key ownership).
2. **Administrative registration**: For manual server additions, require M-of-N operator signatures on the registration payload.
3. **Deregistration**: Require either the server's own signature (self-deregistration) or M-of-N operator signatures (administrative removal).

### Phase 4: Operational Audit Trail

Add structured logging to all `ServerRegistryDO` methods:
1. Log all registration, deregistration, and heartbeat events with timestamps and source identifiers.
2. Store an append-only audit log in Durable Object storage.
3. Expose an authenticated audit log endpoint for operators.

## Acceptance Criteria

- [ ] Root key generation uses Shamir's Secret Sharing with configurable M-of-N threshold.
- [ ] Root key operations (rotation, trust policy changes) require M key holders to participate.
- [ ] No single operator can unilaterally produce a valid root signature.
- [ ] Online signing operations use FROST threshold signatures or equivalent scheme.
- [ ] Server registration requires cryptographic proof of key ownership (self-signed payload).
- [ ] Server deregistration requires authorization (server self-deregistration or operator threshold).
- [ ] All registry mutations are logged in an append-only audit trail.
- [ ] Key ceremony tool produces a verifiable ceremony log.
- [ ] Client verification remains compatible (FROST produces standard Ed25519 signatures).
- [ ] Emergency revocation requires only 1-of-N holders (lower threshold for safety).

## Test Requirements

- **Shamir's Secret Sharing tests**: Verify that M shares reconstruct the original secret, M-1 shares do not, and N shares reconstruct correctly.
- **FROST protocol tests**: Verify that M-of-N signers produce a valid Ed25519 signature. Verify that M-1 signers cannot produce a valid signature.
- **Registration authentication tests**: Verify that registration without a valid self-signature is rejected. Verify that registration with a valid signature is accepted.
- **Deregistration authorization tests**: Verify that unauthorized deregistration is rejected.
- **Audit trail tests**: Verify that all mutations produce audit log entries. Verify that the audit log is append-only (cannot be modified or deleted).
- **Key ceremony tests**: Verify the end-to-end ceremony workflow including share generation, distribution, reconstruction, and ceremony log production.
- **Threshold edge cases**: Verify behavior when exactly M signers participate (should succeed), when fewer than M participate (should fail), and when more than M participate (should succeed).

## Dependencies

- Story 021 (TUF Role Hierarchy) -- Threshold signing is most impactful when applied to the TUF root role. The two stories should be designed together.
- Story 022 (Sigstore Keyless Signing) -- For online roles (timestamp, snapshot), Sigstore ephemeral keys may be preferable to threshold signing. The two approaches are complementary.

## Research References

- [FROST: Flexible Round-Optimized Schnorr Threshold Signatures](https://eprint.iacr.org/2020/852) -- The FROST protocol paper by Komlo and Goldberg. Describes the M-of-N threshold Schnorr signing protocol.
- [RFC 9591: FROST](https://www.rfc-editor.org/rfc/rfc9591.html) -- The IETF RFC standardizing FROST for threshold Schnorr signatures.
- [Shamir's Secret Sharing](https://en.wikipedia.org/wiki/Shamir%27s_secret_sharing) -- Original scheme for splitting a secret into N shares with M-of-N reconstruction.
- [TUF Threshold Signing](https://theupdateframework.github.io/specification/latest/#document-formats) -- TUF's approach to threshold signing for root metadata.
- [ZcashFoundation/frost](https://github.com/ZcashFoundation/frost) -- Rust implementation of FROST for various ciphersuites including Ed25519.
- [hashicorp/vault](https://developer.hashicorp.com/vault/docs/concepts/seal) -- Vault's Shamir unseal mechanism, a real-world deployment of threshold key management.
- [Google's Key Transparency](https://github.com/nicola/key-transparency) -- Reference for transparent key management systems.
- [NIST SP 800-57](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final) -- Key management recommendations including key ceremony best practices.
