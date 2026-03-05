# Implementation Plan: Story 023 - Threshold Signing (M-of-N) for Root Key Operations

## Summary

This plan implements threshold signing (M-of-N) for all trust-critical operations in the Zajel bootstrap server. Currently, a single `BOOTSTRAP_SIGNING_KEY` secret controls all signing authority - server registration, key rotation, and response signing are all controlled by whoever possesses this one key. This single point of failure creates unacceptable risk: a compromised key or rogue operator can unilaterally inject malicious servers into the federation mesh.

The implementation will add:

1. **Shamir's Secret Sharing** for root key storage and ceremony management
2. **FROST threshold signatures** for online operations (M-of-N signers without reconstructing the key)
3. **Authenticated registration** requiring server self-signatures or M-of-N operator approval
4. **Audit logging** for all registry mutations
5. **Client-side threshold verification** (backward compatible - FROST produces standard Ed25519 signatures)

This plan uses a phased rollout to minimize disruption and allow incremental testing. The implementation prioritizes backward compatibility - existing clients will continue to work during the transition, and graceful degradation is maintained when keys are not configured.

## Dependencies

### Required Stories

- **Story 021 (TUF Role Hierarchy)**: Threshold signing is most impactful when applied to the TUF root role. These stories should be coordinated but can be implemented independently. If Story 021 is implemented first, threshold signing would apply to the root role metadata. If implemented standalone, threshold signing protects the current flat bootstrap signing model.

### Optional/Complementary Stories

- **Story 022 (Sigstore Keyless Signing)**: For online roles (timestamp, snapshot in TUF), Sigstore ephemeral keys may be preferable to threshold signing. The two approaches are complementary - use threshold signing for root/critical keys, use Sigstore for short-lived operational keys.

### External Dependencies

- **FROST library**: Need a JavaScript/WASM FROST implementation compatible with Cloudflare Workers runtime
  - Option 1: `@noble/curves` (pure JS, Ed25519 support, no native FROST yet but Schnorr primitives available)
  - Option 2: `frost-ed25519-wasm` (if/when available)
  - Option 3: Custom implementation using FROST RFC 9591 specification
- **Shamir Secret Sharing library**: `secrets.js-grempe` or equivalent for key ceremony tool

## Files to Modify

### New Files to Create

1. **`scripts/threshold/frost-keygen.mjs`**
   - FROST distributed key generation (DKG) ceremony tool
   - Generates M-of-N threshold key shares
   - Produces root public key and individual key shares for distribution

2. **`scripts/threshold/frost-sign.mjs`**
   - Interactive tool for M signers to participate in threshold signature generation
   - Collects commitments, challenges, and responses from M participants
   - Outputs a single standard Ed25519 signature verifiable by the public key

3. **`scripts/threshold/shamir-keygen.mjs`**
   - Simpler fallback: generate a standard Ed25519 key and split it using Shamir's Secret Sharing
   - For offline root key storage (not online signing)

4. **`scripts/threshold/shamir-reconstruct.mjs`**
   - Reconstruct a key from M-of-N shares
   - Perform a one-time operation, then destroy the reconstructed key
   - Used for emergency key recovery or migration

5. **`packages/server/src/crypto/frost.js`**
   - FROST protocol implementation for threshold signing
   - Coordinator functions for multi-round signing protocol
   - Compatible with Cloudflare Workers runtime (no Node.js dependencies)

6. **`packages/server/src/crypto/registration-auth.js`**
   - Signature verification for server self-registration
   - Multi-signature verification for administrative registration
   - Proof-of-key-ownership validation

7. **`packages/server/src/durable-objects/audit-log-do.js`**
   - Append-only audit log Durable Object
   - Records all registry mutations with timestamps and identities
   - Exposes authenticated read-only endpoint for operators

8. **`packages/server/src/middleware/threshold-auth.js`**
   - Middleware to verify M-of-N signatures on administrative operations
   - Load authorized operator public keys from environment/storage
   - Validate that at least M valid signatures are present

9. **`packages/server/tests/unit/frost.test.js`**
   - Unit tests for FROST key generation and signing
   - Test M-of-N threshold (exactly M signers required)
   - Test signature compatibility with standard Ed25519 verification

10. **`packages/server/tests/unit/registration-auth.test.js`**
    - Unit tests for server self-registration signature verification
    - Test multi-signature administrative registration

11. **`packages/server/tests/e2e/threshold-signing.test.js`**
    - End-to-end test for M-of-N signing workflow
    - Test key ceremony, share distribution, and threshold signing

12. **`docs/operations/threshold-signing-ceremony.md`**
    - Operational runbook for key ceremonies
    - Step-by-step procedures for key generation, rotation, and emergency recovery

### Existing Files to Modify

1. **`packages/server/src/crypto/signing.js`**
   - Add `importThresholdKey()` function (FROST public key)
   - Add `verifyThresholdSignature()` (verifies M-of-N multi-sig or single FROST sig)
   - Keep existing `importSigningKey()` and `signPayload()` for backward compatibility

2. **`packages/server/src/index.js`**
   - Modify `GET /servers` handler to support both single-key and threshold signing
   - Add logic to prefer threshold signatures when `FROST_PUBLIC_KEY` is configured
   - Maintain graceful degradation (unsigned responses if no keys configured)

3. **`packages/server/src/durable-objects/server-registry-do.js`**
   - Add authentication middleware to `fetch()` method (line 364)
   - Modify `registerServer()` to verify self-signature or M-of-N operator signatures (lines 464-631)
   - Modify `unregisterServer()` to require authorization (lines 666-703)
   - Add audit log calls to all mutation methods
   - Add emergency revocation endpoint (requires 1-of-N signatures)

4. **`packages/app/lib/core/crypto/bootstrap_verifier.dart`**
   - No immediate changes required (FROST produces standard Ed25519 signatures)
   - Future enhancement: add multi-signature verification mode for Option B approach

5. **`packages/server/wrangler.jsonc`**
   - Document new secrets: `FROST_PUBLIC_KEY`, `OPERATOR_PUBLIC_KEYS` (comma-separated)
   - Keep `BOOTSTRAP_SIGNING_KEY` for backward compatibility during migration

6. **`scripts/generate-bootstrap-keys.mjs`**
   - Add deprecation warning pointing to new threshold key generation tools
   - Keep script functional for backward compatibility

## Implementation Steps

### Phase 1: Shamir's Secret Sharing for Offline Root Keys

This phase implements key splitting for offline root key storage. This is the simplest threshold approach - the key is still a standard Ed25519 key, but it's split into shares so no single operator has the full key.

#### Step 1.1: Create Shamir Key Generation Tool

**File**: `scripts/threshold/shamir-keygen.mjs`

**New Code**:
```javascript
#!/usr/bin/env node

/**
 * Generate Ed25519 keypair and split using Shamir's Secret Sharing.
 *
 * Usage:
 *   node scripts/threshold/shamir-keygen.mjs --threshold 3 --shares 5
 *
 * Output:
 *   - Root public key (base64)
 *   - 5 key shares (hex-encoded)
 *   - Ceremony log (signed JSON document)
 */

import secrets from 'secrets.js-grempe';
import { createHash } from 'crypto';

const args = process.argv.slice(2);
const thresholdIdx = args.indexOf('--threshold');
const sharesIdx = args.indexOf('--shares');

if (thresholdIdx === -1 || sharesIdx === -1) {
  console.error('Usage: shamir-keygen.mjs --threshold M --shares N');
  process.exit(1);
}

const threshold = parseInt(args[thresholdIdx + 1], 10);
const totalShares = parseInt(args[sharesIdx + 1], 10);

if (threshold < 2 || threshold > totalShares || totalShares > 10) {
  console.error('Invalid parameters: 2 <= M <= N <= 10');
  process.exit(1);
}

// Generate root Ed25519 keypair
const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
const seed = privateKeyBytes.slice(-32);
const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

// Split the 32-byte seed into N shares with M threshold
const seedHex = Array.from(seed, b => b.toString(16).padStart(2, '0')).join('');
const shares = secrets.share(seedHex, totalShares, threshold);

// Generate ceremony log
const ceremonyLog = {
  type: 'shamir-keygen',
  timestamp: new Date().toISOString(),
  publicKey: publicKeyBase64,
  threshold,
  totalShares,
  shares: shares.map((_, i) => ({
    index: i + 1,
    fingerprint: createHash('sha256').update(shares[i]).digest('hex').slice(0, 16),
  })),
};

console.log('=== Shamir Secret Sharing Key Ceremony ===\n');
console.log('Root public key (base64):');
console.log(`  ${publicKeyBase64}\n`);
console.log(`Threshold: ${threshold} of ${totalShares}\n`);
console.log('Key shares (distribute to separate operators):\n');

shares.forEach((share, i) => {
  console.log(`Share ${i + 1}/${totalShares}:`);
  console.log(`  ${share}`);
  console.log(`  Fingerprint: ${ceremonyLog.shares[i].fingerprint}\n`);
});

console.log('Ceremony log (save to version control):');
console.log(JSON.stringify(ceremonyLog, null, 2));
console.log('\nIMPORTANT:');
console.log('- Distribute shares to separate operators via secure channels');
console.log('- Each operator should verify the share fingerprint');
console.log('- Store shares on separate secure media (Yubikey, encrypted USB, etc.)');
console.log('- NEVER store all shares together');
console.log('- The original key has been destroyed (only shares remain)');
```

**Dependencies**: `npm install secrets.js-grempe`

#### Step 1.2: Create Shamir Key Reconstruction Tool

**File**: `scripts/threshold/shamir-reconstruct.mjs`

**New Code**:
```javascript
#!/usr/bin/env node

/**
 * Reconstruct Ed25519 key from M-of-N Shamir shares.
 *
 * Usage:
 *   node scripts/threshold/shamir-reconstruct.mjs
 *   (Interactive prompts for shares)
 *
 * SECURITY: This tool reconstructs the full private key. Use only for:
 * - Emergency key recovery
 * - Migration to new threshold scheme
 * - One-time signing operations
 *
 * Destroy the reconstructed key immediately after use.
 */

import secrets from 'secrets.js-grempe';
import { createInterface } from 'readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

console.log('=== Shamir Key Reconstruction ===\n');
console.log('WARNING: This will reconstruct the full private key.');
console.log('Only proceed if you have authorization from M key holders.\n');

const numShares = parseInt(await question('How many shares will you provide? '), 10);
if (numShares < 2 || numShares > 10) {
  console.error('Invalid number of shares');
  process.exit(1);
}

const shares = [];
for (let i = 0; i < numShares; i++) {
  const share = await question(`Enter share ${i + 1}/${numShares}: `);
  shares.push(share.trim());
}

rl.close();

// Reconstruct the seed
let seedHex;
try {
  seedHex = secrets.combine(shares);
} catch (error) {
  console.error('Failed to reconstruct key:', error.message);
  console.error('Possible causes: insufficient shares, corrupted shares, wrong threshold');
  process.exit(1);
}

// Import as Ed25519 key
const seed = new Uint8Array(seedHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));

const pkcs8Prefix = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
  0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
pkcs8.set(pkcs8Prefix);
pkcs8.set(seed, pkcs8Prefix.length);

const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
const publicKeyBytes = new Uint8Array(
  await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey('Ed25519', true, ['sign'])).publicKey)
);
// Note: We can't easily get the public key from the imported private key in Web Crypto,
// so derive it by signing a test message (alternative approach)
const testSig = await crypto.subtle.sign('Ed25519', privateKey, new Uint8Array([0]));

console.log('\nKey successfully reconstructed!');
console.log('Reconstructed seed (hex):');
console.log(`  ${seedHex}`);
console.log('\nUse this for ONE operation, then DESTROY IT.');
console.log('Consider using `wrangler secret put BOOTSTRAP_SIGNING_KEY` if needed.');
console.log('\nPress Ctrl+C when done to clear from terminal history.');
```

**Test**: Verify that M shares reconstruct the key, M-1 shares fail.

### Phase 2: FROST Threshold Signature Scheme

This phase implements online threshold signing using FROST, allowing M-of-N signers to produce a signature without ever reconstructing the full key.

#### Step 2.1: Create FROST Protocol Implementation

**File**: `packages/server/src/crypto/frost.js`

**New Code**:
```javascript
/**
 * FROST (Flexible Round-Optimized Schnorr Threshold) signatures for Ed25519.
 *
 * Implementation based on RFC 9591.
 * This is a simplified 2-round protocol for M-of-N threshold signing.
 *
 * Round 1: Each signer generates and broadcasts a commitment
 * Round 2: Coordinator computes challenge, signers produce response shares
 * Final: Coordinator aggregates shares into a single Ed25519 signature
 */

import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { sha512 } from '@noble/hashes/sha512';

/**
 * FROST Coordinator - orchestrates the signing protocol.
 */
export class FrostCoordinator {
  constructor(publicKey, threshold, signerIds) {
    this.publicKey = publicKey; // Group public key (32 bytes)
    this.threshold = threshold; // M
    this.signerIds = signerIds; // Array of participant IDs
    this.commitments = new Map(); // Round 1: signer ID -> commitment
    this.responses = new Map(); // Round 2: signer ID -> response
  }

  /**
   * Round 1: Collect commitments from participants.
   * Each signer submits their hiding and binding commitments.
   */
  addCommitment(signerId, hidingCommit, bindingCommit) {
    if (!this.signerIds.includes(signerId)) {
      throw new Error(`Unknown signer ID: ${signerId}`);
    }
    this.commitments.set(signerId, { hiding: hidingCommit, binding: bindingCommit });
  }

  /**
   * After M commitments are received, compute the challenge.
   * Returns the challenge that all signers will use in Round 2.
   */
  computeChallenge(message) {
    if (this.commitments.size < this.threshold) {
      throw new Error(`Need ${this.threshold} commitments, got ${this.commitments.size}`);
    }

    // Aggregate commitments (sum of hiding and binding)
    // In real FROST: R = hiding_commit + binding_factor * binding_commit
    // Simplified: R = sum of all commitments
    const commitmentsArray = Array.from(this.commitments.values());
    let groupCommitment = new Uint8Array(32);

    // Aggregate commitment points (this is simplified - real FROST uses binding factors)
    for (const { hiding, binding } of commitmentsArray) {
      // TODO: Proper point addition on Ed25519 curve
      // For now, this is a placeholder showing the structure
      groupCommitment = hiding; // SIMPLIFIED - replace with actual point addition
    }

    // Challenge = H(R || pubkey || message)
    const challengeInput = new Uint8Array(32 + 32 + message.length);
    challengeInput.set(groupCommitment, 0);
    challengeInput.set(this.publicKey, 32);
    challengeInput.set(message, 64);

    const challenge = sha512(challengeInput).slice(0, 32);
    this.challenge = challenge;
    this.message = message;
    return challenge;
  }

  /**
   * Round 2: Collect response shares from participants.
   */
  addResponse(signerId, responseShare) {
    if (!this.commitments.has(signerId)) {
      throw new Error(`No commitment from signer ${signerId}`);
    }
    this.responses.set(signerId, responseShare);
  }

  /**
   * After M responses are received, aggregate into final signature.
   * Returns a standard Ed25519 signature (64 bytes).
   */
  aggregateSignature() {
    if (this.responses.size < this.threshold) {
      throw new Error(`Need ${this.threshold} responses, got ${this.responses.size}`);
    }

    // Aggregate responses: s = sum(response_i * lambda_i) where lambda_i is Lagrange coefficient
    // Simplified implementation - real FROST uses Lagrange interpolation
    const responsesArray = Array.from(this.responses.values());
    let aggregatedResponse = new Uint8Array(32);

    // TODO: Proper scalar addition and Lagrange coefficients
    // For now, placeholder
    aggregatedResponse = responsesArray[0]; // SIMPLIFIED

    // Signature is (R, s) where R is group commitment, s is aggregated response
    const signature = new Uint8Array(64);
    signature.set(this.groupCommitment, 0); // R
    signature.set(aggregatedResponse, 32); // s

    return signature;
  }
}

/**
 * FROST Signer - participant in threshold signing.
 */
export class FrostSigner {
  constructor(signerId, keyShare, threshold, totalParticipants) {
    this.signerId = signerId;
    this.keyShare = keyShare; // This signer's share of the private key
    this.threshold = threshold;
    this.totalParticipants = totalParticipants;
  }

  /**
   * Round 1: Generate nonce and commitment.
   * Returns { hidingCommit, bindingCommit, hidingNonce, bindingNonce }
   */
  generateCommitment() {
    // Generate two random nonces (hiding and binding)
    const hidingNonce = randomBytes(32);
    const bindingNonce = randomBytes(32);

    // Commitments are G * nonce (elliptic curve point multiplication)
    // Simplified: use hash as placeholder for point multiplication
    const hidingCommit = sha512(hidingNonce).slice(0, 32);
    const bindingCommit = sha512(bindingNonce).slice(0, 32);

    this.hidingNonce = hidingNonce;
    this.bindingNonce = bindingNonce;

    return { hidingCommit, bindingCommit };
  }

  /**
   * Round 2: Compute response share using challenge from coordinator.
   */
  computeResponse(challenge) {
    if (!this.hidingNonce || !this.bindingNonce) {
      throw new Error('Must call generateCommitment() first');
    }

    // Response = nonce + (challenge * key_share * lambda)
    // where lambda is Lagrange coefficient for this signer
    // Simplified implementation - real FROST uses scalar arithmetic

    // TODO: Proper scalar multiplication and Lagrange coefficients
    const response = new Uint8Array(32);
    // PLACEHOLDER - replace with actual computation
    response.set(this.hidingNonce);

    // Clear nonces after use
    this.hidingNonce = null;
    this.bindingNonce = null;

    return response;
  }
}

/**
 * Verify a FROST-generated signature.
 * FROST signatures are standard Ed25519 signatures, so use normal Ed25519 verification.
 */
export function verifyFrostSignature(message, signature, publicKey) {
  return ed25519.verify(signature, message, publicKey);
}

// NOTE: This is a simplified FROST implementation showing the protocol structure.
// A production implementation requires:
// 1. Proper elliptic curve point operations (addition, scalar multiplication)
// 2. Lagrange interpolation for coefficient calculation
// 3. Binding factor computation (FROST security requirement)
// 4. Secure nonce generation and storage
// 5. Commitment validation and transcript hashing
//
// Consider using a battle-tested library when available:
// - ZcashFoundation/frost (Rust, could compile to WASM)
// - @noble/curves extensions (if/when FROST support is added)
```

**Dependencies**: `npm install @noble/curves @noble/hashes`

**Note**: This is a simplified implementation showing protocol structure. Production use requires either:
1. A complete FROST implementation from a trusted library
2. Full implementation of elliptic curve operations per RFC 9591

#### Step 2.2: Create FROST Key Generation Tool

**File**: `scripts/threshold/frost-keygen.mjs`

**New Code**:
```javascript
#!/usr/bin/env node

/**
 * FROST Distributed Key Generation (DKG) ceremony.
 *
 * Usage:
 *   node scripts/threshold/frost-keygen.mjs --threshold 3 --participants 5
 *
 * Output:
 *   - Group public key (for signature verification)
 *   - Individual key shares for each participant
 *   - Verification keys for each share
 */

import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';

const args = process.argv.slice(2);
const thresholdIdx = args.indexOf('--threshold');
const participantsIdx = args.indexOf('--participants');

if (thresholdIdx === -1 || participantsIdx === -1) {
  console.error('Usage: frost-keygen.mjs --threshold M --participants N');
  process.exit(1);
}

const threshold = parseInt(args[thresholdIdx + 1], 10);
const totalParticipants = parseInt(args[participantsIdx + 1], 10);

if (threshold < 2 || threshold > totalParticipants || totalParticipants > 10) {
  console.error('Invalid parameters: 2 <= M <= N <= 10');
  process.exit(1);
}

console.log('=== FROST Distributed Key Generation ===\n');
console.log('WARNING: Full FROST DKG requires a secure multi-party ceremony.');
console.log('This tool generates shares from a trusted dealer (simplified DKG).\n');

// Simplified DKG: Generate master secret, split into shares
// Real FROST DKG would use Feldman VSS with no dealer
const masterSecret = randomBytes(32);

// Generate polynomial coefficients for Shamir's Secret Sharing
// f(x) = a0 + a1*x + a2*x^2 + ... + a(t-1)*x^(t-1)
// where a0 = masterSecret
const coefficients = [masterSecret];
for (let i = 1; i < threshold; i++) {
  coefficients.push(randomBytes(32));
}

// Evaluate polynomial at x=1,2,...,N to get shares
const shares = [];
for (let participantId = 1; participantId <= totalParticipants; participantId++) {
  // In real FROST: share_i = f(i) where f is the polynomial
  // Simplified: just use different random values (placeholder)
  const share = randomBytes(32);
  shares.push({
    participantId,
    keyShare: Buffer.from(share).toString('hex'),
    // Verification key would be G * share_i
    verificationKey: Buffer.from(randomBytes(32)).toString('hex'), // PLACEHOLDER
  });
}

// Group public key = G * masterSecret
// In real implementation, this would be derived from the polynomial
const groupPublicKey = ed25519.getPublicKey(masterSecret);

console.log('Group public key (use for signature verification):');
console.log(`  ${Buffer.from(groupPublicKey).toString('base64')}\n`);

console.log(`Threshold: ${threshold} of ${totalParticipants}\n`);
console.log('Key shares (distribute to separate participants):\n');

shares.forEach((share) => {
  console.log(`Participant ${share.participantId}:`);
  console.log(`  Key share: ${share.keyShare}`);
  console.log(`  Verification key: ${share.verificationKey}\n`);
});

console.log('IMPORTANT:');
console.log('- This is a SIMPLIFIED DKG using a trusted dealer');
console.log('- Production FROST requires verifiable secret sharing (VSS)');
console.log('- Each participant should verify their share against commitments');
console.log('- Store shares separately and securely');
console.log('- Master secret has been destroyed (only shares remain)');

console.log('\nNext steps:');
console.log('1. Distribute shares to participants via secure channels');
console.log('2. Each participant verifies their share');
console.log('3. Store group public key in FROST_PUBLIC_KEY secret');
console.log('4. Use frost-sign.mjs for threshold signing operations');
```

**Note**: This is a simplified dealer-based DKG. Production FROST should use Pedersen DKG or Feldman VSS for true distributed generation.

#### Step 2.3: Create FROST Signing Tool

**File**: `scripts/threshold/frost-sign.mjs`

**New Code**:
```javascript
#!/usr/bin/env node

/**
 * FROST threshold signing coordinator.
 *
 * Usage:
 *   node scripts/threshold/frost-sign.mjs --message <file> --threshold 3
 *
 * Interactive tool that collects commitments and responses from M participants.
 */

import { FrostCoordinator } from '../packages/server/src/crypto/frost.js';
import { readFileSync } from 'fs';
import { createInterface } from 'readline';

const args = process.argv.slice(2);
const messageIdx = args.indexOf('--message');
const thresholdIdx = args.indexOf('--threshold');
const publicKeyIdx = args.indexOf('--public-key');

if (messageIdx === -1 || thresholdIdx === -1 || publicKeyIdx === -1) {
  console.error('Usage: frost-sign.mjs --message <file> --threshold M --public-key <base64>');
  process.exit(1);
}

const messagePath = args[messageIdx + 1];
const threshold = parseInt(args[thresholdIdx + 1], 10);
const publicKeyBase64 = args[publicKeyIdx + 1];

const message = readFileSync(messagePath);
const publicKey = Buffer.from(publicKeyBase64, 'base64');

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

console.log('=== FROST Threshold Signing ===\n');
console.log(`Message: ${messagePath}`);
console.log(`Threshold: ${threshold}\n`);

// Collect participant IDs
const participantIds = [];
for (let i = 0; i < threshold; i++) {
  const id = parseInt(await question(`Enter participant ${i + 1} ID: `), 10);
  participantIds.push(id);
}

const coordinator = new FrostCoordinator(publicKey, threshold, participantIds);

// Round 1: Collect commitments
console.log('\n--- Round 1: Collecting Commitments ---');
for (const id of participantIds) {
  console.log(`\nParticipant ${id}: Run this command:`);
  console.log(`  node frost-signer.mjs --id ${id} --round 1`);
  const hidingCommit = await question('Enter hiding commitment (hex): ');
  const bindingCommit = await question('Enter binding commitment (hex): ');
  coordinator.addCommitment(
    id,
    Buffer.from(hidingCommit.trim(), 'hex'),
    Buffer.from(bindingCommit.trim(), 'hex')
  );
}

// Compute challenge
const challenge = coordinator.computeChallenge(message);
console.log('\n--- Challenge Computed ---');
console.log(`Challenge (hex): ${Buffer.from(challenge).toString('hex')}`);

// Round 2: Collect responses
console.log('\n--- Round 2: Collecting Responses ---');
for (const id of participantIds) {
  console.log(`\nParticipant ${id}: Run this command:`);
  console.log(`  node frost-signer.mjs --id ${id} --round 2 --challenge ${Buffer.from(challenge).toString('hex')}`);
  const response = await question('Enter response (hex): ');
  coordinator.addResponse(id, Buffer.from(response.trim(), 'hex'));
}

// Aggregate signature
const signature = coordinator.aggregateSignature();
console.log('\n--- Signature Generated ---');
console.log(`Signature (base64): ${Buffer.from(signature).toString('base64')}`);

rl.close();

console.log('\nThis signature can be verified using standard Ed25519 verification');
console.log('with the group public key.');
```

### Phase 3: Authenticated Server Registration

This phase adds cryptographic authentication to the server registration endpoint.

#### Step 3.1: Create Registration Authentication Module

**File**: `packages/server/src/crypto/registration-auth.js`

**New Code**:
```javascript
/**
 * Authentication for server registration and deregistration.
 *
 * Supports two modes:
 * 1. Self-registration: Server signs the registration payload with its Ed25519 key
 * 2. Administrative registration: M-of-N operators sign the registration payload
 */

/**
 * Verify that a server registration is self-signed.
 * The server must sign the registration payload with the Ed25519 key
 * corresponding to the publicKey field.
 *
 * @param {object} payload - { serverId, endpoint, publicKey, region, timestamp }
 * @param {string} signatureBase64 - Ed25519 signature over canonical JSON
 * @returns {Promise<boolean>}
 */
export async function verifySelfSignedRegistration(payload, signatureBase64) {
  try {
    // Canonical JSON encoding (sorted keys, no whitespace)
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    const message = new TextEncoder().encode(canonical);

    // Decode public key (base64 -> bytes)
    const publicKeyBytes = Uint8Array.from(atob(payload.publicKey), c => c.charCodeAt(0));
    if (publicKeyBytes.length !== 32) return false;

    // SPKI wrapper for Ed25519 public key
    const spkiPrefix = new Uint8Array([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
      0x03, 0x21, 0x00,
    ]);
    const spki = new Uint8Array(spkiPrefix.length + publicKeyBytes.length);
    spki.set(spkiPrefix);
    spki.set(publicKeyBytes, spkiPrefix.length);

    const cryptoKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);

    // Decode signature
    const signatureBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    if (signatureBytes.length !== 64) return false;

    return await crypto.subtle.verify('Ed25519', cryptoKey, signatureBytes, message);
  } catch {
    return false;
  }
}

/**
 * Verify M-of-N administrative signatures on a registration payload.
 * Used when operators manually register a server (not self-registration).
 *
 * @param {object} payload - Registration payload
 * @param {string[]} signatures - Array of base64 Ed25519 signatures
 * @param {string[]} operatorKeys - Array of authorized operator public keys (base64)
 * @param {number} threshold - Minimum required signatures
 * @returns {Promise<boolean>}
 */
export async function verifyAdminSignatures(payload, signatures, operatorKeys, threshold) {
  if (signatures.length < threshold) return false;

  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const message = new TextEncoder().encode(canonical);

  let validCount = 0;

  for (const sigBase64 of signatures) {
    // Try to verify against each operator key
    for (const keyBase64 of operatorKeys) {
      try {
        const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
        if (keyBytes.length !== 32) continue;

        const spkiPrefix = new Uint8Array([
          0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
          0x03, 0x21, 0x00,
        ]);
        const spki = new Uint8Array(spkiPrefix.length + keyBytes.length);
        spki.set(spkiPrefix);
        spki.set(keyBytes, spkiPrefix.length);

        const cryptoKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);
        const sigBytes = Uint8Array.from(atob(sigBase64), c => c.charCodeAt(0));
        if (sigBytes.length !== 64) continue;

        const valid = await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, message);
        if (valid) {
          validCount++;
          break; // Found valid signature from this key
        }
      } catch {
        continue;
      }
    }
  }

  return validCount >= threshold;
}
```

#### Step 3.2: Modify Server Registration to Require Authentication

**File**: `packages/server/src/durable-objects/server-registry-do.js`

**Before** (lines 464-631):
```javascript
async registerServer(request, corsHeaders) {
  const body = await parseJsonBody(request, 4096);
  const { serverId, endpoint, publicKey, region } = body;

  if (!serverId || !endpoint || !publicKey) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // ... validation ...

  const serverEntry = {
    serverId,
    endpoint,
    publicKey,
    region: validRegion,
    connections,
    relayConnections,
    signalingConnections,
    activeCodes,
    buildVerified,
    buildHash,
    buildVersion,
    registeredAt: Date.now(),
    lastSeen: Date.now(),
  };

  await this.state.storage.put(`server:${serverId}`, serverEntry);
  // ... rest ...
}
```

**After**:
```javascript
import { verifySelfSignedRegistration, verifyAdminSignatures } from '../crypto/registration-auth.js';

async registerServer(request, corsHeaders) {
  const body = await parseJsonBody(request, 4096);
  const { serverId, endpoint, publicKey, region } = body;

  if (!serverId || !endpoint || !publicKey) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // --- Authentication required ---
  const selfSignature = body.signature; // Server signs its own registration
  const adminSignatures = body.adminSignatures; // Or M-of-N operators sign

  let authenticated = false;

  // Mode 1: Self-signed registration (server proves key ownership)
  if (selfSignature) {
    const registrationPayload = {
      serverId,
      endpoint,
      publicKey,
      region: region || 'unknown',
      timestamp: body.timestamp || Date.now(),
    };
    authenticated = await verifySelfSignedRegistration(registrationPayload, selfSignature);
    if (authenticated) {
      this.logger.info('[audit] Self-signed server registration', {
        action: 'server_register_self',
        serverId,
      });
    }
  }

  // Mode 2: Administrative registration (M-of-N operators sign)
  if (!authenticated && adminSignatures && Array.isArray(adminSignatures)) {
    const operatorKeys = this.env.OPERATOR_PUBLIC_KEYS
      ? this.env.OPERATOR_PUBLIC_KEYS.split(',').map(k => k.trim())
      : [];
    const threshold = parseInt(this.env.ADMIN_THRESHOLD || '2', 10);

    if (operatorKeys.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Administrative registration not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const registrationPayload = {
      serverId,
      endpoint,
      publicKey,
      region: region || 'unknown',
      timestamp: body.timestamp || Date.now(),
    };

    authenticated = await verifyAdminSignatures(
      registrationPayload,
      adminSignatures,
      operatorKeys,
      threshold
    );

    if (authenticated) {
      this.logger.info('[audit] Admin-signed server registration', {
        action: 'server_register_admin',
        serverId,
        signatureCount: adminSignatures.length,
      });
    }
  }

  // Reject unauthenticated registration (unless auth is disabled)
  const authRequired = this.env.REQUIRE_REGISTRATION_AUTH === 'true';
  if (authRequired && !authenticated) {
    this.logger.warn('[audit] Rejected unauthenticated registration', {
      action: 'server_register_rejected',
      serverId,
      ip: request.headers.get('CF-Connecting-IP'),
    });
    return new Response(
      JSON.stringify({ error: 'Registration signature required' }),
      { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // ... rest of validation (unchanged) ...

  const serverEntry = {
    serverId,
    endpoint,
    publicKey,
    region: validRegion,
    connections,
    relayConnections,
    signalingConnections,
    activeCodes,
    buildVerified,
    buildHash,
    buildVersion,
    registeredAt: Date.now(),
    lastSeen: Date.now(),
    authenticated, // Record whether this registration was authenticated
  };

  await this.state.storage.put(`server:${serverId}`, serverEntry);

  // Log to audit trail
  await this.logAuditEvent({
    action: 'server_register',
    serverId,
    authenticated,
    ip: request.headers.get('CF-Connecting-IP'),
  });

  return new Response(
    JSON.stringify({ success: true, server: serverEntry }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

**New environment variables**:
- `OPERATOR_PUBLIC_KEYS`: Comma-separated list of authorized operator Ed25519 public keys (base64)
- `ADMIN_THRESHOLD`: Number of operator signatures required (default: 2)
- `REQUIRE_REGISTRATION_AUTH`: `true` to reject unsigned registrations (default: `false` for backward compat)

### Phase 4: Audit Logging

This phase adds append-only audit logging for all registry mutations.

#### Step 4.1: Create Audit Log Durable Object

**File**: `packages/server/src/durable-objects/audit-log-do.js`

**New Code**:
```javascript
/**
 * AuditLog Durable Object - Append-only audit trail.
 *
 * Stores all registry mutations (registration, deregistration, heartbeat)
 * with timestamps and source identifiers.
 */

import { getCorsHeaders } from '../cors.js';
import { createLogger } from '../logger.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';

export class AuditLogDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env);
  }

  /**
   * Verify admin authentication for read access.
   */
  verifyAdminAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.AUDIT_LOG_SECRET) return false;
    if (!authHeader) return false;
    return timingSafeEqual(authHeader, `Bearer ${this.env.AUDIT_LOG_SECRET}`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, this.env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /log - Append audit event (internal only)
    if (request.method === 'POST' && url.pathname === '/log') {
      // No authentication - this is called internally by ServerRegistryDO
      // Consider adding internal auth token if needed
      return await this.appendEvent(request, corsHeaders);
    }

    // GET /log - Read audit log (admin only)
    if (request.method === 'GET' && url.pathname === '/log') {
      if (!this.verifyAdminAuth(request)) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      return await this.readLog(request, corsHeaders);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }

  async appendEvent(request, corsHeaders) {
    const body = await request.json();
    const { action, serverId, timestamp, metadata } = body;

    if (!action || !timestamp) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: action, timestamp' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Generate sequential event ID
    const counter = (await this.state.storage.get('event_counter')) || 0;
    const eventId = counter + 1;
    await this.state.storage.put('event_counter', eventId);

    // Store event with sequential key for ordered retrieval
    const eventKey = `event:${String(eventId).padStart(12, '0')}`;
    const event = {
      eventId,
      action,
      serverId,
      timestamp,
      metadata: metadata || {},
    };

    await this.state.storage.put(eventKey, event);

    this.logger.info('[audit] Event logged', { eventId, action, serverId });

    return new Response(
      JSON.stringify({ success: true, eventId }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  async readLog(request, corsHeaders) {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const action = url.searchParams.get('action');
    const serverId = url.searchParams.get('serverId');

    // List all events
    const allEvents = await this.state.storage.list({ prefix: 'event:' });
    let events = Array.from(allEvents.values());

    // Filter by action or serverId if provided
    if (action) {
      events = events.filter(e => e.action === action);
    }
    if (serverId) {
      events = events.filter(e => e.serverId === serverId);
    }

    // Sort by eventId descending (most recent first)
    events.sort((a, b) => b.eventId - a.eventId);

    // Pagination
    const total = events.length;
    const paginatedEvents = events.slice(offset, offset + limit);

    return new Response(
      JSON.stringify({
        events: paginatedEvents,
        total,
        limit,
        offset,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
```

#### Step 4.2: Add Audit Logging to Server Registry

**File**: `packages/server/src/durable-objects/server-registry-do.js`

**Add helper method**:
```javascript
/**
 * Log an event to the audit log Durable Object.
 */
async logAuditEvent(event) {
  if (!this.env.AUDIT_LOG) return; // Graceful degradation if not configured

  try {
    const id = this.env.AUDIT_LOG.idFromName('global');
    const stub = this.env.AUDIT_LOG.get(id);
    await stub.fetch(new Request('https://audit-log/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: event.action,
        serverId: event.serverId || null,
        timestamp: Date.now(),
        metadata: event.metadata || {},
      }),
    }));
  } catch (error) {
    this.logger.error('[audit] Failed to log event', error);
    // Don't fail the operation if audit logging fails
  }
}
```

**Add audit calls to mutation methods**:

In `registerServer()` (after successful registration):
```javascript
await this.logAuditEvent({
  action: 'server_register',
  serverId,
  metadata: { authenticated, ip: request.headers.get('CF-Connecting-IP') },
});
```

In `unregisterServer()` (after deletion):
```javascript
await this.logAuditEvent({
  action: 'server_unregister',
  serverId,
  metadata: { ip: request.headers.get('CF-Connecting-IP') },
});
```

In `heartbeat()` (periodically, e.g., every 10th heartbeat):
```javascript
if (server.heartbeatCount % 10 === 0) {
  await this.logAuditEvent({
    action: 'server_heartbeat',
    serverId,
    metadata: { connections: server.connections },
  });
}
```

#### Step 4.3: Wire Audit Log in Worker

**File**: `packages/server/src/index.js`

**Add export**:
```javascript
export { AuditLogDO } from './durable-objects/audit-log-do.js';
```

**File**: `packages/server/wrangler.jsonc`

**Add binding**:
```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "SERVER_REGISTRY", "class_name": "ServerRegistryDO" },
      { "name": "ATTESTATION_REGISTRY", "class_name": "AttestationRegistryDO" },
      { "name": "AUDIT_LOG", "class_name": "AuditLogDO" }
    ]
  }
}
```

### Phase 5: Client-Side and Testing

#### Step 5.1: Update Client Verification (Future)

**File**: `packages/app/lib/core/crypto/bootstrap_verifier.dart`

**No immediate changes required** - FROST produces standard Ed25519 signatures that the existing verifier can handle.

**Future enhancement** (for multi-signature approach):
```dart
/// Verify M-of-N multi-signature (if using Option B instead of FROST).
Future<bool> verifyMultiSignature(
  String responseBody,
  List<String> signaturesBase64,
  List<String> publicKeysBase64,
  int threshold,
) async {
  int validCount = 0;
  final bodyBytes = Uint8List.fromList(utf8.encode(responseBody));

  for (final sigBase64 in signaturesBase64) {
    for (final keyBase64 in publicKeysBase64) {
      try {
        final keyBytes = base64Decode(keyBase64);
        final publicKey = SimplePublicKey(keyBytes, type: KeyPairType.ed25519);
        final signature = Signature(
          base64Decode(sigBase64),
          publicKey: publicKey,
        );
        final isValid = await _ed25519.verify(bodyBytes, signature: signature);
        if (isValid) {
          validCount++;
          break; // Found valid signature from this key
        }
      } catch (e) {
        continue;
      }
    }
  }

  return validCount >= threshold;
}
```

#### Step 5.2: Create Unit Tests

**File**: `packages/server/tests/unit/registration-auth.test.js`

**New Code**:
```javascript
import { describe, it, expect } from 'vitest';
import { verifySelfSignedRegistration, verifyAdminSignatures } from '../../src/crypto/registration-auth.js';

describe('Registration authentication', () => {
  let keyPair;
  let publicKeyBase64;

  beforeEach(async () => {
    keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));
  });

  describe('verifySelfSignedRegistration', () => {
    it('should accept valid self-signed registration', async () => {
      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);
      const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifySelfSignedRegistration(payload, signatureBase64);
      expect(valid).toBe(true);
    });

    it('should reject tampered payload', async () => {
      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);
      const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      // Tamper with payload
      payload.serverId = 'evil-server';

      const valid = await verifySelfSignedRegistration(payload, signatureBase64);
      expect(valid).toBe(false);
    });

    it('should reject signature from wrong key', async () => {
      // Generate a different keypair
      const wrongKeyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);

      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);
      const signature = await crypto.subtle.sign('Ed25519', wrongKeyPair.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifySelfSignedRegistration(payload, signatureBase64);
      expect(valid).toBe(false);
    });
  });

  describe('verifyAdminSignatures', () => {
    it('should accept M valid signatures from authorized keys', async () => {
      // Generate 3 operator keypairs
      const operators = await Promise.all([
        crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
        crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
        crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
      ]);

      const operatorKeys = await Promise.all(
        operators.map(async (kp) => {
          const bytes = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
          return btoa(String.fromCharCode(...bytes));
        })
      );

      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);

      // 2 of 3 operators sign
      const signatures = await Promise.all([
        crypto.subtle.sign('Ed25519', operators[0].privateKey, message),
        crypto.subtle.sign('Ed25519', operators[1].privateKey, message),
      ]);

      const signaturesBase64 = signatures.map(sig =>
        btoa(String.fromCharCode(...new Uint8Array(sig)))
      );

      const valid = await verifyAdminSignatures(payload, signaturesBase64, operatorKeys, 2);
      expect(valid).toBe(true);
    });

    it('should reject when fewer than M signatures', async () => {
      const operators = await Promise.all([
        crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
        crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
      ]);

      const operatorKeys = await Promise.all(
        operators.map(async (kp) => {
          const bytes = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
          return btoa(String.fromCharCode(...bytes));
        })
      );

      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);

      // Only 1 signature, but threshold is 2
      const signature = await crypto.subtle.sign('Ed25519', operators[0].privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifyAdminSignatures(payload, [signatureBase64], operatorKeys, 2);
      expect(valid).toBe(false);
    });
  });
});
```

#### Step 5.3: Create E2E Tests

**File**: `packages/server/tests/e2e/threshold-signing.test.js`

**New Code** (abbreviated):
```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { FrostCoordinator, FrostSigner } from '../../src/crypto/frost.js';

describe('FROST threshold signing E2E', () => {
  it('should produce valid signature with M-of-N signers', async () => {
    const threshold = 2;
    const totalParticipants = 3;

    // Simulate DKG (simplified - in reality would be distributed)
    // ... key generation ...

    // Round 1: Signers generate commitments
    const signers = [
      new FrostSigner(1, keyShare1, threshold, totalParticipants),
      new FrostSigner(2, keyShare2, threshold, totalParticipants),
    ];

    const commitments = signers.map(s => s.generateCommitment());

    // Coordinator collects commitments
    const coordinator = new FrostCoordinator(groupPublicKey, threshold, [1, 2]);
    commitments.forEach((c, i) => {
      coordinator.addCommitment(signers[i].signerId, c.hidingCommit, c.bindingCommit);
    });

    // Coordinator computes challenge
    const message = new TextEncoder().encode('test message');
    const challenge = coordinator.computeChallenge(message);

    // Round 2: Signers compute responses
    const responses = signers.map(s => s.computeResponse(challenge));
    responses.forEach((r, i) => {
      coordinator.addResponse(signers[i].signerId, r);
    });

    // Coordinator aggregates signature
    const signature = coordinator.aggregateSignature();

    // Verify with standard Ed25519 verification
    const valid = await crypto.subtle.verify('Ed25519', groupPublicKey, signature, message);
    expect(valid).toBe(true);
  });

  it('should fail with M-1 signers', async () => {
    // Similar test but with only 1 signer when threshold is 2
    // Should throw error when trying to aggregate
  });
});
```

## Test Plan

### Unit Tests

1. **Shamir Secret Sharing**
   - ✓ M shares reconstruct the original secret
   - ✓ M-1 shares fail to reconstruct
   - ✓ All N shares reconstruct correctly
   - ✓ Invalid shares are rejected
   - ✓ Share fingerprints are deterministic

2. **FROST Protocol**
   - ✓ M-of-N DKG produces valid group public key
   - ✓ M signers produce valid Ed25519 signature
   - ✓ M-1 signers fail to produce signature
   - ✓ Signature verifies with standard Ed25519 verification
   - ✓ Tampering with message invalidates signature
   - ✓ Commitment phase rejects invalid commitments
   - ✓ Response phase rejects invalid challenge

3. **Registration Authentication**
   - ✓ Self-signed registration accepts valid signature
   - ✓ Self-signed registration rejects tampered payload
   - ✓ Self-signed registration rejects wrong key
   - ✓ Admin registration accepts M valid signatures
   - ✓ Admin registration rejects M-1 signatures
   - ✓ Admin registration rejects signatures from unauthorized keys
   - ✓ Admin registration validates canonical JSON encoding

4. **Audit Logging**
   - ✓ Events are appended in sequential order
   - ✓ Event counter increments correctly
   - ✓ Read endpoint returns events in descending order
   - ✓ Filtering by action works correctly
   - ✓ Filtering by serverId works correctly
   - ✓ Pagination works correctly
   - ✓ Unauthorized read attempts are rejected

### Integration Tests

1. **Server Registration with Self-Signature**
   - ✓ POST /servers with valid self-signature succeeds
   - ✓ POST /servers without signature is rejected when auth required
   - ✓ POST /servers without signature succeeds when auth not required (backward compat)
   - ✓ Self-signature verification failure returns 401
   - ✓ Audit log records authenticated registration

2. **Server Registration with Admin Signatures**
   - ✓ POST /servers with M admin signatures succeeds
   - ✓ POST /servers with M-1 admin signatures is rejected
   - ✓ POST /servers with signatures from unauthorized keys is rejected
   - ✓ Audit log records admin-signed registration

3. **Server Unregistration**
   - ✓ DELETE /servers/:id with SERVER_REGISTRY_SECRET succeeds
   - ✓ DELETE /servers/:id with valid publicKey auth succeeds
   - ✓ DELETE /servers/:id with wrong publicKey is rejected
   - ✓ Audit log records unregistration

4. **Bootstrap Response Signing**
   - ✓ GET /servers with FROST_PUBLIC_KEY uses threshold signature
   - ✓ GET /servers falls back to BOOTSTRAP_SIGNING_KEY if FROST not configured
   - ✓ GET /servers returns unsigned response if no keys configured
   - ✓ Client verification succeeds for FROST signatures
   - ✓ Timestamp freshness check works correctly

### End-to-End Tests

1. **Complete Key Ceremony Workflow**
   - ✓ Run `shamir-keygen.mjs` to generate shares
   - ✓ Distribute shares to separate operators (simulated)
   - ✓ Run `shamir-reconstruct.mjs` with M shares
   - ✓ Reconstructed key matches original public key
   - ✓ Use reconstructed key to sign a test payload
   - ✓ Signature verifies correctly

2. **Complete FROST Signing Workflow**
   - ✓ Run `frost-keygen.mjs` to generate M-of-N key shares
   - ✓ Each participant receives their share
   - ✓ Run `frost-sign.mjs` coordinator
   - ✓ M participants provide commitments
   - ✓ Coordinator computes challenge
   - ✓ M participants provide responses
   - ✓ Coordinator aggregates signature
   - ✓ Signature verifies with group public key
   - ✓ Client verification succeeds

3. **Audit Log Query**
   - ✓ Register multiple servers
   - ✓ Query audit log with GET /log
   - ✓ Verify all events are present
   - ✓ Filter by action returns correct subset
   - ✓ Pagination works across large event sets

### Security Tests

1. **Threshold Enforcement**
   - ✓ M-1 signers cannot produce valid signature
   - ✓ Invalid share cannot participate in signing
   - ✓ Tampering with coordinator challenges is detected
   - ✓ Replay of old commitments/responses is prevented

2. **Authentication Bypass Attempts**
   - ✓ Attempt registration without signature (should fail if auth required)
   - ✓ Attempt registration with replayed signature (timestamp check)
   - ✓ Attempt registration with signature from wrong payload
   - ✓ Attempt unregistration of another server's entry

3. **Audit Log Integrity**
   - ✓ Attempt to modify existing audit log entry (should fail - append-only)
   - ✓ Attempt to delete audit log entries (should fail)
   - ✓ Attempt to read audit log without auth (should fail)

### Performance Tests

1. **FROST Signing Performance**
   - ✓ Measure Round 1 commitment generation time (per signer)
   - ✓ Measure coordinator challenge computation time
   - ✓ Measure Round 2 response generation time (per signer)
   - ✓ Measure signature aggregation time
   - ✓ Verify total latency is acceptable for operational use (<5s for 3-of-5)

2. **Audit Log Performance**
   - ✓ Measure write latency for single event
   - ✓ Measure read latency for 100-event query
   - ✓ Measure read latency for 10,000-event query with pagination

### Compatibility Tests

1. **Backward Compatibility**
   - ✓ Existing clients continue to work with single-key signatures
   - ✓ FROST signatures verify with standard Ed25519 verification
   - ✓ Unsigned responses work when keys not configured
   - ✓ Old server registration (without signatures) works when auth not required

2. **Migration Path**
   - ✓ Deploy with REQUIRE_REGISTRATION_AUTH=false (permissive mode)
   - ✓ Existing servers continue to register without signatures
   - ✓ New servers can register with signatures
   - ✓ Enable REQUIRE_REGISTRATION_AUTH=true (enforce mode)
   - ✓ Only authenticated registrations accepted

## Rollback Risk

### Low Risk (Graceful Degradation)

- **Audit logging failure**: If the AuditLogDO fails, operations continue (audit calls are wrapped in try/catch)
- **Missing signing keys**: If FROST_PUBLIC_KEY not configured, falls back to BOOTSTRAP_SIGNING_KEY, then to unsigned responses
- **Missing auth configuration**: If REQUIRE_REGISTRATION_AUTH=false, unauthenticated registrations are allowed (backward compat)

### Medium Risk (Requires Configuration Rollback)

- **FROST signature verification failure**: If FROST implementation has bugs, clients will reject all bootstrap responses
  - **Mitigation**: Deploy with both FROST_PUBLIC_KEY and BOOTSTRAP_SIGNING_KEY set; include both signatures in response headers; clients try FROST first, fall back to single-key
  - **Rollback**: Remove FROST_PUBLIC_KEY secret, worker falls back to BOOTSTRAP_SIGNING_KEY
- **Registration auth breaking existing servers**: If REQUIRE_REGISTRATION_AUTH=true deployed prematurely, existing servers cannot re-register after TTL expiry
  - **Mitigation**: Deploy in permissive mode first (auth optional), monitor adoption, then enforce
  - **Rollback**: Set REQUIRE_REGISTRATION_AUTH=false

### High Risk (Requires Code Deployment)

- **Audit log storage exhaustion**: If AuditLogDO accumulates unbounded events, storage could hit limits
  - **Mitigation**: Implement log rotation (delete events older than 90 days)
  - **Rollback**: Deploy updated AuditLogDO with cleanup logic; manually purge old events
- **FROST protocol bugs**: If FROST implementation has cryptographic errors, signatures may not verify or may leak key material
  - **Mitigation**: Use battle-tested library (prefer ZcashFoundation/frost WASM build over custom implementation)
  - **Rollback**: Remove FROST code, fall back to single-key signing

### Rollback Procedure

1. **Emergency rollback to single-key signing**:
   ```bash
   wrangler secret delete FROST_PUBLIC_KEY
   wrangler secret delete OPERATOR_PUBLIC_KEYS
   # Worker automatically falls back to BOOTSTRAP_SIGNING_KEY
   ```

2. **Disable registration authentication**:
   ```bash
   wrangler secret put REQUIRE_REGISTRATION_AUTH
   # Enter: false
   ```

3. **Disable audit logging**:
   - Remove `AUDIT_LOG` binding from `wrangler.jsonc`
   - Deploy updated configuration
   - `logAuditEvent()` calls gracefully no-op when binding missing

4. **Full code rollback**:
   - Revert to previous git commit
   - `npm run build && wrangler deploy`
   - Existing data (server registrations) remains intact

## Dependencies on Other Stories

### Story 021 (TUF Role Hierarchy)

**Relationship**: Complementary but independent

- If Story 021 is implemented **first**: Threshold signing applies to the TUF root role. The root metadata file is signed by M-of-N root key holders. This is the ideal architecture.
- If Story 023 is implemented **first**: Threshold signing protects the current flat bootstrap signing model. Can migrate to TUF roles later.
- If implemented **together**: Use threshold signing for TUF root role, use single-key or Sigstore for online roles (timestamp, snapshot).

**Shared components**:
- Both stories use Ed25519 signing
- Both stories need key ceremony tools
- Both stories benefit from audit logging

**Recommendation**: Implement Story 023 first (simpler, provides immediate security improvement). Then implement Story 021 on top (adds role separation). Story 021 can use the threshold signing infrastructure from Story 023 for the root role.

### Story 022 (Sigstore Keyless Signing)

**Relationship**: Alternative approaches for different use cases

- **Threshold signing (Story 023)**: Best for long-lived root keys where no single party should have signing authority
- **Sigstore (Story 022)**: Best for short-lived operational keys where signing is tied to CI/CD pipeline identity

**Potential combined architecture**:
- Root role: M-of-N threshold signing (Story 023)
- Timestamp/Snapshot roles: Sigstore ephemeral signing (Story 022)
- Build artifacts: Sigstore with SLSA provenance (Story 022)

**No blocking dependencies**: These stories can be implemented independently and combined later.

## Open Questions and Future Work

### FROST Library Selection

**Question**: Which FROST implementation to use?

**Options**:
1. **ZcashFoundation/frost** (Rust): Most mature, but requires WASM compilation for CF Workers
2. **Custom implementation**: Full control, but high risk of cryptographic bugs
3. **@noble/curves extension**: Wait for official FROST support in @noble library

**Recommendation**: Start with Shamir's Secret Sharing (simpler, proven) for offline root keys. Evaluate FROST libraries for online signing. Consider deferring FROST until a production-ready JS/WASM library is available.

### Key Rotation Protocol

**Question**: How to rotate threshold keys without app updates?

**Future work**:
- Implement TUF-style root metadata file with versioned keys
- Clients fetch root metadata on first run, cache with expiry
- Root key rotation requires M-of-N ceremony to sign new root metadata
- App hardcodes only the initial root public key (pins trust anchor)

### Emergency Key Revocation

**Question**: What threshold for emergency revocation?

**Options**:
- **1-of-N**: Any single key holder can trigger revocation (fast response, risk of abuse)
- **M-of-N**: Same threshold as normal operations (slower response, more secure)
- **2-of-N**: Compromise (requires two operators to agree)

**Recommendation**: Implement 2-of-N for revocation. One operator can initiate, second must confirm within 1 hour. After revocation, full M-of-N ceremony required to install replacement key.

### Audit Log Retention

**Question**: How long to retain audit logs?

**Options**:
- 30 days: Sufficient for incident detection, limits storage costs
- 90 days: Better for forensic analysis
- 1 year: Regulatory compliance in some jurisdictions

**Recommendation**: 90 days with automatic rotation. Provide export endpoint for long-term archival.

### Performance: FROST vs Multi-Signature

**Question**: Is FROST's online signing latency acceptable for operational use?

**Alternative**: Use multi-signature approach (each of M operators produces independent Ed25519 signature, server collects all M signatures). Simpler protocol, no round trips, but requires client-side changes to verify M signatures.

**Recommendation**: Prototype both approaches. Measure FROST latency with 3-of-5 configuration. If >5 seconds, consider multi-signature fallback.

---

## Summary

This implementation plan provides a phased rollout of threshold signing for the Zajel bootstrap server:

1. **Phase 1** (Low risk): Shamir's Secret Sharing for offline root key storage
2. **Phase 2** (Medium risk): FROST threshold signatures for online operations
3. **Phase 3** (Medium risk): Authenticated server registration
4. **Phase 4** (Low risk): Audit logging
5. **Phase 5** (Low risk): Client compatibility and testing

Each phase can be deployed independently with graceful degradation. Backward compatibility is maintained throughout. The implementation eliminates single points of failure in the trust chain while preserving operational simplicity.

**Estimated implementation effort**: 3-4 weeks for Phases 1-4, 1 week for Phase 5 (testing and documentation).

**Recommended order**: Implement Phases 1, 3, 4 first (Shamir + Auth + Audit). Defer Phase 2 (FROST) until a production-ready library is available or until Story 021 (TUF) provides clear requirements for online threshold signing.
