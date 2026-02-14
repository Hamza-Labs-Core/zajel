# [MEDIUM] Attestation uses same signing key for build tokens and session tokens

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:127-163, 505-515
**Type**: Security

**Description**: The `ATTESTATION_SIGNING_KEY` environment variable is used for two different purposes:
1. Verifying build token signatures during device registration (line 138-148).
2. Signing session tokens after successful attestation verification (line 505).

Both operations use the same Ed25519 key pair. The key is imported as a signing key (with `extractable: true`) and then its public key is derived to verify build tokens.

**Impact**: Using the same key for different operations violates the principle of key separation. If the session token signing key is compromised, the attacker can also forge build tokens. Additionally, the signing key is imported with `extractable: true` (attestation.js:55), which is necessary for deriving the public key but increases risk -- any code with access to the key object can export the raw private key material.

**Fix**:
1. Use separate keys for build token verification and session token signing:
   - `ATTESTATION_SIGNING_KEY` for signing session tokens
   - `BUILD_TOKEN_VERIFY_KEY` (public key only) for verifying build tokens
2. Import the session token signing key with `extractable: false`.
3. Store the build token verification public key as a separate environment variable.
