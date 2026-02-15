/**
 * Tests for attestation cryptographic utilities.
 *
 * Covers:
 * - Ed25519 key import/export for attestation
 * - Build token signature creation and verification
 * - HMAC-SHA256 computation for challenge-response
 * - Session token creation and verification
 * - Version comparison
 * - Nonce generation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  importAttestationSigningKey,
  importVerifyKey,
  exportPublicKeyBase64,
  verifyBuildTokenSignature,
  signPayloadEd25519,
  generateNonce,
  computeHmac,
  createSessionToken,
  verifySessionToken,
  compareVersions,
} from '../../src/crypto/attestation.js';


describe('Attestation Crypto Utilities', () => {
  let seedHex;
  let keyPair;

  beforeEach(async () => {
    // Generate a test keypair
    keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    const seed = pkcs8.slice(-32);
    seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
  });

  describe('importAttestationSigningKey', () => {
    it('should import a signing key from hex seed', async () => {
      const key = await importAttestationSigningKey(seedHex);
      expect(key).toBeDefined();
      expect(key.type).toBe('private');
    });

    it('should produce keys that can sign data', async () => {
      const key = await importAttestationSigningKey(seedHex);
      const data = new TextEncoder().encode('test');
      const sig = await crypto.subtle.sign('Ed25519', key, data);
      expect(sig.byteLength).toBe(64);
    });
  });

  describe('exportPublicKeyBase64', () => {
    it('should export the public key as base64', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      expect(pubKeyBase64).toBeDefined();
      expect(typeof pubKeyBase64).toBe('string');
      // Base64-encoded 32-byte key should be ~44 chars
      const decoded = atob(pubKeyBase64);
      expect(decoded.length).toBe(32);
    });
  });

  describe('importVerifyKey', () => {
    it('should import a public key for verification', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);
      expect(verifyKey).toBeDefined();
      expect(verifyKey.type).toBe('public');
    });

    it('should verify signatures from the corresponding private key', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);

      const payload = 'test payload';
      const data = new TextEncoder().encode(payload);
      const sig = await crypto.subtle.sign('Ed25519', signingKey, data);
      const valid = await crypto.subtle.verify('Ed25519', verifyKey, sig, data);
      expect(valid).toBe(true);
    });
  });

  describe('signPayloadEd25519 + verifyBuildTokenSignature', () => {
    it('should sign and verify a payload', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);

      const payload = JSON.stringify({ version: '1.0.0', platform: 'android' });
      const signature = await signPayloadEd25519(signingKey, payload);

      const valid = await verifyBuildTokenSignature(verifyKey, payload, signature);
      expect(valid).toBe(true);
    });

    it('should reject tampered payload', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);

      const payload = JSON.stringify({ version: '1.0.0', platform: 'android' });
      const signature = await signPayloadEd25519(signingKey, payload);

      const tampered = payload + 'x';
      const valid = await verifyBuildTokenSignature(verifyKey, tampered, signature);
      expect(valid).toBe(false);
    });

    it('should reject wrong key', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);

      // Generate a different keypair
      const otherKeyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const otherPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', otherKeyPair.privateKey));
      const otherSeed = otherPkcs8.slice(-32);
      const otherSeedHex = Array.from(otherSeed, (b) => b.toString(16).padStart(2, '0')).join('');
      const otherSigningKey = await importAttestationSigningKey(otherSeedHex);
      const otherPubBase64 = await exportPublicKeyBase64(otherSigningKey);
      const otherVerifyKey = await importVerifyKey(otherPubBase64);

      const payload = 'test payload';
      const signature = await signPayloadEd25519(signingKey, payload);

      const valid = await verifyBuildTokenSignature(otherVerifyKey, payload, signature);
      expect(valid).toBe(false);
    });
  });

  describe('generateNonce', () => {
    it('should generate a hex-encoded nonce', () => {
      const nonce = generateNonce();
      expect(nonce).toMatch(/^[0-9a-f]+$/);
      // Default 32 bytes = 64 hex chars
      expect(nonce.length).toBe(64);
    });

    it('should generate unique nonces', () => {
      const nonce1 = generateNonce();
      const nonce2 = generateNonce();
      expect(nonce1).not.toBe(nonce2);
    });

    it('should support custom byte lengths', () => {
      const nonce = generateNonce(16);
      expect(nonce.length).toBe(32); // 16 bytes = 32 hex chars
    });
  });

  describe('computeHmac', () => {
    it('should compute HMAC-SHA256', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const nonceHex = 'aa'.repeat(32); // 32-byte key

      const hmac = await computeHmac(data, nonceHex);
      expect(hmac).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 32 bytes = 64 hex
    });

    it('should produce different HMACs for different data', async () => {
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([4, 5, 6]);
      const nonceHex = 'bb'.repeat(32);

      const hmac1 = await computeHmac(data1, nonceHex);
      const hmac2 = await computeHmac(data2, nonceHex);
      expect(hmac1).not.toBe(hmac2);
    });

    it('should produce different HMACs for different nonces', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const nonce1 = 'aa'.repeat(32);
      const nonce2 = 'bb'.repeat(32);

      const hmac1 = await computeHmac(data, nonce1);
      const hmac2 = await computeHmac(data, nonce2);
      expect(hmac1).not.toBe(hmac2);
    });

    it('should produce deterministic results', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const nonceHex = 'cc'.repeat(32);

      const hmac1 = await computeHmac(data, nonceHex);
      const hmac2 = await computeHmac(data, nonceHex);
      expect(hmac1).toBe(hmac2);
    });
  });

  describe('createSessionToken + verifySessionToken', () => {
    it('should create and verify a session token', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);

      const tokenData = {
        device_id: 'test-device',
        build_version: '1.0.0',
        expires_at: Date.now() + 3600000,
      };

      const token = await createSessionToken(signingKey, tokenData);
      expect(token).toContain('.'); // payload.signature format

      const decoded = await verifySessionToken(verifyKey, token);
      expect(decoded).not.toBeNull();
      expect(decoded.device_id).toBe('test-device');
      expect(decoded.build_version).toBe('1.0.0');
    });

    it('should reject expired session token', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);

      const tokenData = {
        device_id: 'test-device',
        expires_at: Date.now() - 1000, // Already expired
      };

      const token = await createSessionToken(signingKey, tokenData);
      const decoded = await verifySessionToken(verifyKey, token);
      expect(decoded).toBeNull();
    });

    it('should reject tampered session token', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);

      const tokenData = {
        device_id: 'test-device',
        expires_at: Date.now() + 3600000,
      };

      const token = await createSessionToken(signingKey, tokenData);
      // Tamper with the payload portion
      const parts = token.split('.');
      parts[0] = btoa(JSON.stringify({ ...tokenData, device_id: 'hacker' }));
      const tampered = parts.join('.');

      const decoded = await verifySessionToken(verifyKey, tampered);
      expect(decoded).toBeNull();
    });

    it('should reject malformed token', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);

      const decoded = await verifySessionToken(verifyKey, 'not-a-valid-token');
      expect(decoded).toBeNull();
    });
  });

  describe('compareVersions', () => {
    it('should return 0 for equal versions', () => {
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('2.3.4', '2.3.4')).toBe(0);
    });

    it('should return -1 when first is less', () => {
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
      expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
      expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    });

    it('should return 1 when first is greater', () => {
      expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    });

    it('should reject missing patch version (non-semver)', () => {
      expect(() => compareVersions('1.0', '1.0.0')).toThrow('Invalid semver version format');
      expect(() => compareVersions('1.0.0', '1.0')).toThrow('Invalid semver version format');
    });

    it('should reject non-string inputs', () => {
      expect(() => compareVersions(null, '1.0.0')).toThrow('Version must be a string');
      expect(() => compareVersions('1.0.0', 123)).toThrow('Version must be a string');
    });

    it('should reject pre-release versions', () => {
      expect(() => compareVersions('1.0.0-beta', '1.0.0')).toThrow('Invalid semver version format');
    });

    it('should handle multi-digit versions', () => {
      expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
      expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    });
  });
});
