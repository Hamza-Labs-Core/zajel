import { describe, it, expect, beforeEach } from 'vitest';
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

    it('should reject registration without timestamp', async () => {
      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        // no timestamp
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);
      const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifySelfSignedRegistration(payload, signatureBase64);
      expect(valid).toBe(false);
    });

    it('should reject registration with stale timestamp (>5 minutes old)', async () => {
      const staleTimestamp = Date.now() - (6 * 60 * 1000); // 6 minutes ago
      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: staleTimestamp,
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);
      const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifySelfSignedRegistration(payload, signatureBase64);
      expect(valid).toBe(false);
    });

    it('should reject registration with future timestamp (>5 minutes ahead)', async () => {
      const futureTimestamp = Date.now() + (6 * 60 * 1000); // 6 minutes from now
      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: futureTimestamp,
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);
      const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifySelfSignedRegistration(payload, signatureBase64);
      expect(valid).toBe(false);
    });

    it('should accept registration with timestamp within 5 minute window', async () => {
      const recentTimestamp = Date.now() - (4 * 60 * 1000); // 4 minutes ago
      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: recentTimestamp,
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);
      const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifySelfSignedRegistration(payload, signatureBase64);
      expect(valid).toBe(true);
    });

    it('should reject invalid signature format', async () => {
      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const valid = await verifySelfSignedRegistration(payload, 'not-valid-base64!@#');
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

    it('should reject when same operator signs twice (double-count prevention)', async () => {
      // Generate 2 operator keypairs
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

      // Operator 0 signs twice -- should only count once
      const sig1 = await crypto.subtle.sign('Ed25519', operators[0].privateKey, message);
      const sig2 = await crypto.subtle.sign('Ed25519', operators[0].privateKey, message);

      const signaturesBase64 = [
        btoa(String.fromCharCode(...new Uint8Array(sig1))),
        btoa(String.fromCharCode(...new Uint8Array(sig2))),
      ];

      // Threshold is 2, but both signatures are from the same operator
      const valid = await verifyAdminSignatures(payload, signaturesBase64, operatorKeys, 2);
      expect(valid).toBe(false);
    });

    it('should reject admin signatures without timestamp', async () => {
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
        // no timestamp
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);

      const signatures = await Promise.all([
        crypto.subtle.sign('Ed25519', operators[0].privateKey, message),
        crypto.subtle.sign('Ed25519', operators[1].privateKey, message),
      ]);

      const signaturesBase64 = signatures.map(sig =>
        btoa(String.fromCharCode(...new Uint8Array(sig)))
      );

      const valid = await verifyAdminSignatures(payload, signaturesBase64, operatorKeys, 2);
      expect(valid).toBe(false);
    });

    it('should reject admin signatures with stale timestamp', async () => {
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
        timestamp: Date.now() - (6 * 60 * 1000), // 6 minutes ago
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);

      const signatures = await Promise.all([
        crypto.subtle.sign('Ed25519', operators[0].privateKey, message),
        crypto.subtle.sign('Ed25519', operators[1].privateKey, message),
      ]);

      const signaturesBase64 = signatures.map(sig =>
        btoa(String.fromCharCode(...new Uint8Array(sig)))
      );

      const valid = await verifyAdminSignatures(payload, signaturesBase64, operatorKeys, 2);
      expect(valid).toBe(false);
    });

    it('should reject signatures from unauthorized keys', async () => {
      // Generate authorized and unauthorized keypairs
      const authorizedOp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const unauthorizedOp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);

      const authorizedBytes = new Uint8Array(await crypto.subtle.exportKey('raw', authorizedOp.publicKey));
      const operatorKeys = [btoa(String.fromCharCode(...authorizedBytes))];

      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);

      // Sign with unauthorized key
      const signature = await crypto.subtle.sign('Ed25519', unauthorizedOp.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifyAdminSignatures(payload, [signatureBase64], operatorKeys, 1);
      expect(valid).toBe(false);
    });

    it('should accept threshold of 1 with single valid signature', async () => {
      const operator = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const opBytes = new Uint8Array(await crypto.subtle.exportKey('raw', operator.publicKey));
      const operatorKeys = [btoa(String.fromCharCode(...opBytes))];

      const payload = {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: publicKeyBase64,
        region: 'us-east',
        timestamp: Date.now(),
      };

      const canonical = JSON.stringify(payload, Object.keys(payload).sort());
      const message = new TextEncoder().encode(canonical);

      const signature = await crypto.subtle.sign('Ed25519', operator.privateKey, message);
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

      const valid = await verifyAdminSignatures(payload, [signatureBase64], operatorKeys, 1);
      expect(valid).toBe(true);
    });
  });
});
