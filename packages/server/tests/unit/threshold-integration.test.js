import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verifySelfSignedRegistration, verifyAdminSignatures } from '../../src/crypto/registration-auth.js';

/**
 * Helper to generate an Ed25519 keypair and return base64 public key.
 */
async function generateOperator() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));
  return { keyPair, publicKeyBase64 };
}

/**
 * Helper to sign a payload with an Ed25519 private key using canonical JSON.
 */
async function signPayload(payload, privateKey) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const message = new TextEncoder().encode(canonical);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, message);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

describe('Threshold Signing Integration', () => {
  describe('Self-signed registration', () => {
    it('should verify when server signs its own registration', async () => {
      const server = await generateOperator();

      const payload = {
        serverId: 'my-server-1',
        endpoint: 'wss://my-server.example.com',
        publicKey: server.publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const signature = await signPayload(payload, server.keyPair.privateKey);
      const valid = await verifySelfSignedRegistration(payload, signature);
      expect(valid).toBe(true);
    });

    it('should reject when signature is from different key than publicKey in payload', async () => {
      const server = await generateOperator();
      const attacker = await generateOperator();

      const payload = {
        serverId: 'my-server-1',
        endpoint: 'wss://my-server.example.com',
        publicKey: server.publicKeyBase64, // Claims to be server
        region: 'us-east',
        timestamp: Date.now(),
      };

      // But signs with attacker's key
      const signature = await signPayload(payload, attacker.keyPair.privateKey);
      const valid = await verifySelfSignedRegistration(payload, signature);
      expect(valid).toBe(false);
    });

    it('should reject when endpoint is tampered after signing', async () => {
      const server = await generateOperator();

      const payload = {
        serverId: 'my-server-1',
        endpoint: 'wss://my-server.example.com',
        publicKey: server.publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const signature = await signPayload(payload, server.keyPair.privateKey);

      // Tamper with endpoint
      payload.endpoint = 'wss://evil-server.example.com';
      const valid = await verifySelfSignedRegistration(payload, signature);
      expect(valid).toBe(false);
    });

    it('should reject empty signature', async () => {
      const server = await generateOperator();

      const payload = {
        serverId: 'my-server-1',
        endpoint: 'wss://my-server.example.com',
        publicKey: server.publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const valid = await verifySelfSignedRegistration(payload, '');
      expect(valid).toBe(false);
    });
  });

  describe('M-of-N admin signatures - threshold met', () => {
    it('should accept 2-of-3 valid operator signatures', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();
      const op3 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64, op3.publicKeyBase64];

      const payload = {
        serverId: 'admin-registered-server',
        endpoint: 'wss://admin.example.com',
        publicKey: 'dGVzdHB1YmtleQ==',
        region: 'eu-west',
        timestamp: Date.now(),
      };

      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op2.keyPair.privateKey);

      const valid = await verifyAdminSignatures(payload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(true);
    });

    it('should accept 3-of-5 valid operator signatures', async () => {
      const operators = [];
      for (let i = 0; i < 5; i++) {
        operators.push(await generateOperator());
      }
      const operatorKeys = operators.map(op => op.publicKeyBase64);

      const payload = {
        serverId: 'critical-server',
        endpoint: 'wss://critical.example.com',
        publicKey: 'dGVzdHB1YmtleQ==',
        region: 'us-west',
        timestamp: Date.now(),
      };

      // Non-adjacent operators sign (0, 2, 4)
      const sig0 = await signPayload(payload, operators[0].keyPair.privateKey);
      const sig2 = await signPayload(payload, operators[2].keyPair.privateKey);
      const sig4 = await signPayload(payload, operators[4].keyPair.privateKey);

      const valid = await verifyAdminSignatures(payload, [sig0, sig2, sig4], operatorKeys, 3);
      expect(valid).toBe(true);
    });

    it('should accept exactly M signatures when M equals N', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();
      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const payload = {
        action: 'unanimous-decision',
        timestamp: Date.now(),
      };

      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op2.keyPair.privateKey);

      const valid = await verifyAdminSignatures(payload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(true);
    });
  });

  describe('M-of-N admin signatures - threshold NOT met', () => {
    it('should reject when only M-1 signatures provided', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();
      const op3 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64, op3.publicKeyBase64];

      const payload = {
        serverId: 'needs-approval',
        endpoint: 'wss://needs-approval.example.com',
        publicKey: 'dGVzdHB1YmtleQ==',
        region: 'us-east',
        timestamp: Date.now(),
      };

      // Only 1 signature, threshold is 2
      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const valid = await verifyAdminSignatures(payload, [sig1], operatorKeys, 2);
      expect(valid).toBe(false);
    });

    it('should reject zero signatures', async () => {
      const op1 = await generateOperator();
      const operatorKeys = [op1.publicKeyBase64];

      const payload = { action: 'test', timestamp: Date.now() };
      const valid = await verifyAdminSignatures(payload, [], operatorKeys, 1);
      expect(valid).toBe(false);
    });
  });

  describe('Invalid signatures do not count toward threshold', () => {
    it('should not count signatures from unauthorized keys', async () => {
      const authorized = await generateOperator();
      const unauthorized = await generateOperator();

      const operatorKeys = [authorized.publicKeyBase64];

      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'dGVzdHB1YmtleQ==',
        region: 'us-east',
        timestamp: Date.now(),
      };

      const sigFromUnauthorized = await signPayload(payload, unauthorized.keyPair.privateKey);
      const valid = await verifyAdminSignatures(payload, [sigFromUnauthorized], operatorKeys, 1);
      expect(valid).toBe(false);
    });

    it('should not count signatures over tampered payload', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const originalPayload = {
        serverId: 'honest-server',
        endpoint: 'wss://honest.example.com',
        publicKey: 'dGVzdHB1YmtleQ==',
        region: 'us-east',
        timestamp: Date.now(),
      };

      // Sign the original payload
      const sig1 = await signPayload(originalPayload, op1.keyPair.privateKey);
      const sig2 = await signPayload(originalPayload, op2.keyPair.privateKey);

      // Verify against tampered payload
      const tamperedPayload = { ...originalPayload, serverId: 'evil-server' };
      const valid = await verifyAdminSignatures(tamperedPayload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(false);
    });

    it('should not count truncated signatures', async () => {
      const op1 = await generateOperator();
      const operatorKeys = [op1.publicKeyBase64];

      const payload = { action: 'test', timestamp: Date.now() };

      // Create a truncated signature (not 64 bytes)
      const truncated = btoa(String.fromCharCode(...new Uint8Array(32)));
      const valid = await verifyAdminSignatures(payload, [truncated], operatorKeys, 1);
      expect(valid).toBe(false);
    });

    it('should not count random garbage as valid signatures', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const payload = { action: 'test', timestamp: Date.now() };

      // 64 bytes of random data encoded as base64
      const randomSig = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64))));
      const valid = await verifyAdminSignatures(payload, [randomSig], operatorKeys, 1);
      expect(valid).toBe(false);
    });
  });

  describe('Duplicate signatures from same key do not count twice', () => {
    it('should reject when operator signs twice with threshold=2', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const payload = {
        action: 'revoke',
        serverId: 'compromised',
        timestamp: Date.now(),
      };

      // Op1 signs twice (Ed25519 is deterministic, so both signatures are identical)
      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op1.keyPair.privateKey);

      const valid = await verifyAdminSignatures(payload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(false);
    });

    it('should accept if one operator signs and another signs too', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();
      const op3 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64, op3.publicKeyBase64];

      const payload = {
        action: 'revoke',
        serverId: 'compromised',
        timestamp: Date.now(),
      };

      // Op1 signs, then op1 signs again (duplicate), then op2 signs (valid)
      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig1_dup = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op2.keyPair.privateKey);

      // Even with 3 signatures, only 2 unique operators signed
      const valid = await verifyAdminSignatures(payload, [sig1, sig1_dup, sig2], operatorKeys, 2);
      expect(valid).toBe(true); // 2 unique operators >= threshold of 2
    });

    it('should not double-count even with different order', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const payload = {
        action: 'important',
        timestamp: Date.now(),
      };

      // op1 signs 3 times
      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op1.keyPair.privateKey);
      const sig3 = await signPayload(payload, op1.keyPair.privateKey);

      const valid = await verifyAdminSignatures(payload, [sig1, sig2, sig3], operatorKeys, 2);
      expect(valid).toBe(false); // Only 1 unique operator, need 2
    });
  });

  describe('Emergency revocation threshold', () => {
    it('should verify revocation with 2-of-N operator signatures', async () => {
      const operators = [];
      for (let i = 0; i < 5; i++) {
        operators.push(await generateOperator());
      }
      const operatorKeys = operators.map(op => op.publicKeyBase64);

      const revocationPayload = {
        action: 'revoke',
        serverId: 'compromised-server',
        timestamp: Date.now(),
      };

      // Only 2 operators needed for emergency revocation
      const sig1 = await signPayload(revocationPayload, operators[0].keyPair.privateKey);
      const sig2 = await signPayload(revocationPayload, operators[3].keyPair.privateKey);

      const valid = await verifyAdminSignatures(revocationPayload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(true);
    });

    it('should reject revocation with only 1 signature when threshold is 2', async () => {
      const operators = [];
      for (let i = 0; i < 5; i++) {
        operators.push(await generateOperator());
      }
      const operatorKeys = operators.map(op => op.publicKeyBase64);

      const revocationPayload = {
        action: 'revoke',
        serverId: 'compromised-server',
        timestamp: Date.now(),
      };

      const sig1 = await signPayload(revocationPayload, operators[0].keyPair.privateKey);

      const valid = await verifyAdminSignatures(revocationPayload, [sig1], operatorKeys, 2);
      expect(valid).toBe(false);
    });
  });

  describe('Timestamp replay protection in admin signatures', () => {
    it('should reject admin signatures with timestamp >5 minutes old', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const stalePayload = {
        action: 'register',
        timestamp: Date.now() - (6 * 60 * 1000), // 6 minutes ago
      };

      const sig1 = await signPayload(stalePayload, op1.keyPair.privateKey);
      const sig2 = await signPayload(stalePayload, op2.keyPair.privateKey);

      const valid = await verifyAdminSignatures(stalePayload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(false);
    });

    it('should reject admin signatures with future timestamp >5 minutes', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const futurePayload = {
        action: 'register',
        timestamp: Date.now() + (6 * 60 * 1000), // 6 minutes from now
      };

      const sig1 = await signPayload(futurePayload, op1.keyPair.privateKey);
      const sig2 = await signPayload(futurePayload, op2.keyPair.privateKey);

      const valid = await verifyAdminSignatures(futurePayload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(false);
    });

    it('should accept admin signatures with timestamp within 5 minutes', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const recentPayload = {
        action: 'register',
        timestamp: Date.now() - (4 * 60 * 1000), // 4 minutes ago (within window)
      };

      const sig1 = await signPayload(recentPayload, op1.keyPair.privateKey);
      const sig2 = await signPayload(recentPayload, op2.keyPair.privateKey);

      const valid = await verifyAdminSignatures(recentPayload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(true);
    });

    it('should reject admin signatures with no timestamp at all', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const operatorKeys = [op1.publicKeyBase64, op2.publicKeyBase64];

      const noTimestampPayload = {
        action: 'register',
        // no timestamp
      };

      const sig1 = await signPayload(noTimestampPayload, op1.keyPair.privateKey);
      const sig2 = await signPayload(noTimestampPayload, op2.keyPair.privateKey);

      const valid = await verifyAdminSignatures(noTimestampPayload, [sig1, sig2], operatorKeys, 2);
      expect(valid).toBe(false);
    });
  });

  describe('Canonical JSON serialization', () => {
    it('should produce same canonical form regardless of key insertion order', async () => {
      const op = await generateOperator();
      const operatorKeys = [op.publicKeyBase64];

      const ts = Date.now();

      // Keys inserted in different order
      const payload1 = { timestamp: ts, action: 'test', serverId: 'a' };
      const payload2 = { serverId: 'a', action: 'test', timestamp: ts };
      const payload3 = { action: 'test', timestamp: ts, serverId: 'a' };

      const sig = await signPayload(payload1, op.keyPair.privateKey);

      // All three should verify because sorted keys produce same canonical form
      const v1 = await verifyAdminSignatures(payload1, [sig], operatorKeys, 1);
      const v2 = await verifyAdminSignatures(payload2, [sig], operatorKeys, 1);
      const v3 = await verifyAdminSignatures(payload3, [sig], operatorKeys, 1);

      expect(v1).toBe(true);
      expect(v2).toBe(true);
      expect(v3).toBe(true);
    });
  });
});
