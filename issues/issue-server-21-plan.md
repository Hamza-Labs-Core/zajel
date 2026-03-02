# Plan: Attestation uses same signing key for build tokens and session tokens

**Issue**: issue-server-21.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/attestation-registry-do.js`
- `packages/server/src/crypto/attestation.js`

## Analysis

In `packages/server/src/durable-objects/attestation-registry-do.js`:
- `handleRegister()` (lines 137-163): Imports the `ATTESTATION_SIGNING_KEY` as a signing key (line 138), then exports its public key (line 148), re-imports as a verify key (line 149), and uses it to verify build token signatures (lines 151-155). The same key is used for two purposes.
- `handleVerify()` (lines 505-515): Uses the same `ATTESTATION_SIGNING_KEY` to sign session tokens (line 505):
  ```js
  const signingKey = await importAttestationSigningKey(this.env.ATTESTATION_SIGNING_KEY);
  ```

In `packages/server/src/crypto/attestation.js`:
- `importAttestationSigningKey()` (line 55): Imports with `extractable: true`, which is required to derive the public key via `exportPublicKeyBase64()` (line 63). However, this means the private key material can be extracted by any code with access to the key object.

**The core problem**: A single key (`ATTESTATION_SIGNING_KEY`) is used for:
1. Verifying build token signatures (verification purpose -- only needs the public key)
2. Signing session tokens (signing purpose -- needs the private key)

If the session token signing is compromised, the attacker can also forge build tokens (since the same key pair is used).

## Fix Steps

1. **Add a new environment variable** `BUILD_TOKEN_VERIFY_KEY`:
   - This should contain the **public key** (base64-encoded, 32 bytes) for verifying build tokens.
   - The corresponding private key is held by the CI system that signs build tokens.
   - This key is distinct from `ATTESTATION_SIGNING_KEY`.

2. **Update `handleRegister()` in `attestation-registry-do.js`** (lines 127-163):
   ```js
   // Verify build token signature using the dedicated build token public key
   if (!this.env.BUILD_TOKEN_VERIFY_KEY) {
     return this.jsonResponse(
       { error: 'Build token verification not configured' },
       503,
       corsHeaders
     );
   }

   let verifyKey;
   try {
     verifyKey = await importVerifyKey(this.env.BUILD_TOKEN_VERIFY_KEY);
   } catch (e) {
     return this.jsonResponse(
       { error: 'Build token verification configuration error' },
       500,
       corsHeaders
     );
   }

   const valid = await verifyBuildTokenSignature(
     verifyKey,
     build_token.payload,
     build_token.signature
   );
   ```
   This eliminates the round-trip of importing as signing key, exporting the public key, and re-importing as verify key.

3. **Update `handleVerify()` in `attestation-registry-do.js`** (line 505):
   - Keep using `ATTESTATION_SIGNING_KEY` for session token signing, but import with `extractable: false`:
   ```js
   const signingKey = await importSessionSigningKey(this.env.ATTESTATION_SIGNING_KEY);
   ```

4. **Add `importSessionSigningKey()` to `attestation.js`**:
   ```js
   export async function importSessionSigningKey(hexSeed) {
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
   Note: `extractable: false` (second-to-last argument) prevents the private key from being exported.

5. **Update CI build pipeline** to use a separate Ed25519 key pair for signing build tokens:
   - Generate a new Ed25519 key pair for build token signing.
   - Configure CI with the private key for signing build tokens.
   - Set `BUILD_TOKEN_VERIFY_KEY` in Cloudflare Workers with the base64-encoded public key.
   - Keep `ATTESTATION_SIGNING_KEY` as a separate key for session token signing.

6. **Remove `exportPublicKeyBase64` usage** from `handleRegister()` since the public key is now provided directly.

## Testing

- Verify that build token verification works with the new dedicated public key.
- Verify that session token signing works with the `ATTESTATION_SIGNING_KEY` (now non-extractable).
- Verify that the old flow (where both used the same key) is no longer possible.
- Generate test build tokens with the new signing key and verify they are accepted.
- Verify that build tokens signed with the old key are rejected (since the verification key is different).
- Run existing attestation tests with updated key configuration.

## Risk Assessment

- **Key rotation required**: This change requires generating a new key pair and updating both the CI pipeline and the Cloudflare Workers configuration. Coordinate deployment carefully.
- **Backward compatibility**: Existing build tokens signed with the old `ATTESTATION_SIGNING_KEY` will fail verification because the verification key is now different. Devices with old tokens will need to re-register with tokens signed by the new build token key. Consider a transition period where both keys are accepted.
- **Migration strategy**:
  1. Deploy with `BUILD_TOKEN_VERIFY_KEY` set to the public key derived from the current `ATTESTATION_SIGNING_KEY` (so existing tokens still work).
  2. Generate a new build token key pair and update CI.
  3. After all old tokens expire (30 days per issue-server-17's fix), update `BUILD_TOKEN_VERIFY_KEY` to the new key's public key.
  4. Rotate `ATTESTATION_SIGNING_KEY` independently.
