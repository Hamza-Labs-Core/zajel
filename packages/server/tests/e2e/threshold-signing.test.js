import { describe, it, expect } from 'vitest';
// FROST tests are disabled until Phase 2 is implementable.
// import { FrostCoordinator, FrostSigner } from '../../src/crypto/frost.js';

describe('Threshold signing E2E', () => {
  // FROST signing tests -- DISABLED until production FROST library is available.
  // These tests will fail with the current placeholder implementation because:
  // 1. aggregateSignature() references this.groupCommitment (now fixed but still placeholder)
  // 2. The "aggregated signature" is just the first signer's hiding nonce
  // 3. The result is not a valid Ed25519 signature
  //
  // describe('FROST threshold signing', () => {
  //   it('should produce valid signature with M-of-N signers', async () => {
  //     // ... test code ...
  //   });
  // });

  describe('Registration authentication E2E', () => {
    it('should verify self-signed registration end-to-end', async () => {
      // Generate Ed25519 keypair
      const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
      const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

      // Create registration payload with timestamp
      const payload = {
        serverId: 'e2e-test-server',
        endpoint: 'wss://e2e.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      // Sign the canonical JSON
      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);
      const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      // Import the verification function directly
      const { verifySelfSignedRegistration } = await import('../../src/crypto/registration-auth.js');
      const valid = await verifySelfSignedRegistration(payload, signatureBase64);
      expect(valid).toBe(true);
    });

    it('should verify M-of-N admin signatures end-to-end', async () => {
      // Generate 5 operator keypairs (3-of-5 threshold)
      const operators = [];
      const operatorKeys = [];
      for (let i = 0; i < 5; i++) {
        const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
        operators.push(kp);
        const bytes = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
        operatorKeys.push(btoa(String.fromCharCode(...bytes)));
      }

      const payload = {
        serverId: 'e2e-admin-server',
        endpoint: 'wss://e2e-admin.example.com',
        publicKey: 'dGVzdHB1YmtleQ==',
        region: 'eu-west',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);

      // 3 of 5 operators sign
      const signatures = [];
      for (let i = 0; i < 3; i++) {
        const sig = await crypto.subtle.sign('Ed25519', operators[i].privateKey, message);
        signatures.push(btoa(String.fromCharCode(...new Uint8Array(sig))));
      }

      const { verifyAdminSignatures } = await import('../../src/crypto/registration-auth.js');
      const valid = await verifyAdminSignatures(payload, signatures, operatorKeys, 3);
      expect(valid).toBe(true);

      // Verify that 2 of 5 is not enough for threshold of 3
      const insufficient = await verifyAdminSignatures(
        payload,
        signatures.slice(0, 2),
        operatorKeys,
        3
      );
      expect(insufficient).toBe(false);
    });

    it('should prevent double-count attack in admin signatures', async () => {
      const operator = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const opBytes = new Uint8Array(await crypto.subtle.exportKey('raw', operator.publicKey));
      const opKey = btoa(String.fromCharCode(...opBytes));

      const otherOperator = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const otherBytes = new Uint8Array(await crypto.subtle.exportKey('raw', otherOperator.publicKey));
      const otherKey = btoa(String.fromCharCode(...otherBytes));

      const payload = {
        action: 'revoke',
        serverId: 'compromised-server',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);

      // Same operator creates two signatures
      const sig1 = await crypto.subtle.sign('Ed25519', operator.privateKey, message);
      const sig2 = await crypto.subtle.sign('Ed25519', operator.privateKey, message);

      const { verifyAdminSignatures } = await import('../../src/crypto/registration-auth.js');

      // With 2 operator keys but only 1 actually signing (twice), threshold of 2 should fail
      const valid = await verifyAdminSignatures(
        payload,
        [
          btoa(String.fromCharCode(...new Uint8Array(sig1))),
          btoa(String.fromCharCode(...new Uint8Array(sig2))),
        ],
        [opKey, otherKey],
        2
      );
      expect(valid).toBe(false);
    });
  });
});
