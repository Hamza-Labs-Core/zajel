/**
 * Security tests for key rotation scenarios.
 *
 * Covers:
 * - Trusted build key replacement (invalidates old keys)
 * - Trusted build key addition (addKeys operation)
 * - Trusted build key removal (removeKeys operation)
 * - CI_UPLOAD_SECRET rotation (encrypted keys become unreadable)
 * - ATTESTATION_SIGNING_KEY rotation (old session tokens rejected)
 * - Graceful fallback when decryption fails
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { AttestationRegistryDO } from '../../src/durable-objects/attestation-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';
import {
  importAttestationSigningKey,
  exportPublicKeyBase64,
  signPayloadEd25519,
  createSessionToken,
  verifySessionToken,
  importVerifyKey,
  importSessionSigningKey,
} from '../../src/crypto/attestation.js';

async function generateTestKeypair() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');

  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const publicKeyBytes = spki.slice(-32);
  const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

  return { keyPair, seedHex, publicKeyBase64 };
}

async function signBuildHash(privateKey, buildHash) {
  const data = new TextEncoder().encode(buildHash);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

describe('Key Rotation Security', () => {
  describe('Trusted Build Key Rotation', () => {
    let mockState;
    let serverRegistry;
    let keypair1, keypair2;

    beforeEach(async () => {
      mockState = new MockState();
      keypair1 = await generateTestKeypair();
      keypair2 = await generateTestKeypair();
      serverRegistry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'ci-secret',
        REPLAY_GRACE_MODE: 'true', // Allow registration without timestamp/nonce
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should invalidate old keys when replacing with new keys', async () => {
      const ciAuth = { Authorization: 'Bearer ci-secret' };
      const serverAuth = { Authorization: 'Bearer test-secret' };

      // Set initial key
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair1.publicKeyBase64],
      }, ciAuth));

      // Register server with keypair1 (should be verified)
      const buildHash1 = 'a'.repeat(64);
      const sig1 = await signBuildHash(keypair1.keyPair.privateKey, buildHash1);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server1',
        endpoint: 'wss://s1.example.com',
        publicKey: 'key1',
        buildHash: buildHash1,
        buildSignature: sig1,
        buildSigningKey: keypair1.publicKeyBase64,
      }, serverAuth));

      let entry = await mockState.storage.get('server:ed25519:server1');
      expect(entry.buildVerified).toBe(true);

      // Replace keys with keypair2 (invalidates keypair1)
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair2.publicKeyBase64],
      }, ciAuth));

      // Register new server with keypair1 (should NOT be verified - key revoked)
      const buildHash2 = 'b'.repeat(64);
      const sig2 = await signBuildHash(keypair1.keyPair.privateKey, buildHash2);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server2',
        endpoint: 'wss://s2.example.com',
        publicKey: 'key2',
        buildHash: buildHash2,
        buildSignature: sig2,
        buildSigningKey: keypair1.publicKeyBase64,
      }, serverAuth));

      entry = await mockState.storage.get('server:ed25519:server2');
      expect(entry.buildVerified).toBe(false); // Old key no longer trusted
    });

    it('should allow adding keys without invalidating existing', async () => {
      const ciAuth = { Authorization: 'Bearer ci-secret' };
      const serverAuth = { Authorization: 'Bearer test-secret' };

      // Set initial key
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair1.publicKeyBase64],
      }, ciAuth));

      // Add keypair2 (without removing keypair1)
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        addKeys: [keypair2.publicKeyBase64],
      }, ciAuth));

      // Both keys should work
      const buildHash1 = 'a'.repeat(64);
      const sig1 = await signBuildHash(keypair1.keyPair.privateKey, buildHash1);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server1',
        endpoint: 'wss://s1.example.com',
        publicKey: 'key1',
        buildHash: buildHash1,
        buildSignature: sig1,
        buildSigningKey: keypair1.publicKeyBase64,
      }, serverAuth));

      const buildHash2 = 'b'.repeat(64);
      const sig2 = await signBuildHash(keypair2.keyPair.privateKey, buildHash2);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server2',
        endpoint: 'wss://s2.example.com',
        publicKey: 'key2',
        buildHash: buildHash2,
        buildSignature: sig2,
        buildSigningKey: keypair2.publicKeyBase64,
      }, serverAuth));

      const entry1 = await mockState.storage.get('server:ed25519:server1');
      const entry2 = await mockState.storage.get('server:ed25519:server2');
      expect(entry1.buildVerified).toBe(true);
      expect(entry2.buildVerified).toBe(true);
    });

    it('should allow removing specific keys', async () => {
      const ciAuth = { Authorization: 'Bearer ci-secret' };
      const serverAuth = { Authorization: 'Bearer test-secret' };

      // Set both keys
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair1.publicKeyBase64, keypair2.publicKeyBase64],
      }, ciAuth));

      // Remove keypair1
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        removeKeys: [keypair1.publicKeyBase64],
      }, ciAuth));

      // keypair1 should no longer work
      const buildHash1 = 'a'.repeat(64);
      const sig1 = await signBuildHash(keypair1.keyPair.privateKey, buildHash1);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server1',
        endpoint: 'wss://s1.example.com',
        publicKey: 'key1',
        buildHash: buildHash1,
        buildSignature: sig1,
        buildSigningKey: keypair1.publicKeyBase64,
      }, serverAuth));

      const entry1 = await mockState.storage.get('server:ed25519:server1');
      expect(entry1.buildVerified).toBe(false);

      // keypair2 should still work
      const buildHash2 = 'b'.repeat(64);
      const sig2 = await signBuildHash(keypair2.keyPair.privateKey, buildHash2);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server2',
        endpoint: 'wss://s2.example.com',
        publicKey: 'key2',
        buildHash: buildHash2,
        buildSignature: sig2,
        buildSigningKey: keypair2.publicKeyBase64,
      }, serverAuth));

      const entry2 = await mockState.storage.get('server:ed25519:server2');
      expect(entry2.buildVerified).toBe(true);
    });
  });

  describe('CI_UPLOAD_SECRET Rotation', () => {
    let mockState;
    let keypair;

    beforeEach(async () => {
      mockState = new MockState();
      keypair = await generateTestKeypair();
      vi.useFakeTimers();
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should fail to decrypt keys after CI_UPLOAD_SECRET rotation', async () => {
      // Upload keys with secret1
      let serverRegistry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'secret1',
      });

      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer secret1' }));

      // Raw storage should contain encrypted data
      const raw = await mockState.storage.get('trusted_build_keys');
      expect(raw.encrypted).toBe(true);

      // Create new registry with different secret (simulates secret rotation)
      serverRegistry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'secret2',
      });

      // Attempt to GET keys with new secret should fail (decryption error)
      const resp = await serverRegistry.fetch(createRequest('GET', '/servers/trusted-keys', null, {
        Authorization: 'Bearer secret2',
      }));

      // Should return 500 (failed to decrypt stored keys)
      expect(resp.status).toBe(500);
    });

    it('should fall back to env var when decryption fails during registration', async () => {
      // Upload keys with secret1
      let serverRegistry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'secret1',
        TRUSTED_BUILD_KEYS: '',
        REPLAY_GRACE_MODE: 'true',
      });

      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer secret1' }));

      // Create new registry with different secret BUT with env var fallback
      const fallbackKeypair = await generateTestKeypair();
      serverRegistry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'secret2',
        TRUSTED_BUILD_KEYS: fallbackKeypair.publicKeyBase64,
        REPLAY_GRACE_MODE: 'true',
      });

      // Register server with fallback key (should work via env var fallback)
      const buildHash = 'c'.repeat(64);
      const sig = await signBuildHash(fallbackKeypair.keyPair.privateKey, buildHash);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:fallback-server',
        endpoint: 'wss://fb.example.com',
        publicKey: 'key',
        buildHash,
        buildSignature: sig,
        buildSigningKey: fallbackKeypair.publicKeyBase64,
      }, { Authorization: 'Bearer test-secret' }));

      const entry = await mockState.storage.get('server:ed25519:fallback-server');
      expect(entry.buildVerified).toBe(true);
    });
  });

  describe('ATTESTATION_SIGNING_KEY Rotation', () => {
    let mockState;
    let seed1, seed2;

    beforeEach(async () => {
      mockState = new MockState();
      const kp1 = await generateTestKeypair();
      const kp2 = await generateTestKeypair();
      seed1 = kp1.seedHex;
      seed2 = kp2.seedHex;
      vi.useFakeTimers();
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should reject session tokens signed with old key after rotation', async () => {
      // Create session token with seed1
      const signingKey1 = await importSessionSigningKey(seed1);
      const tokenData = {
        device_id: 'device-001',
        build_version: '1.0.0',
        expires_at: Date.now() + 3600000,
      };
      const sessionToken = await createSessionToken(signingKey1, tokenData);

      // Verify token works with seed1's public key
      const attestationSigningKey1 = await importAttestationSigningKey(seed1);
      const verifyKey1 = await importVerifyKey(await exportPublicKeyBase64(attestationSigningKey1));
      const decoded1 = await verifySessionToken(verifyKey1, sessionToken);
      expect(decoded1).not.toBeNull();

      // Try to verify old token with seed2's public key (should fail)
      const attestationSigningKey2 = await importAttestationSigningKey(seed2);
      const verifyKey2 = await importVerifyKey(await exportPublicKeyBase64(attestationSigningKey2));
      const decoded2 = await verifySessionToken(verifyKey2, sessionToken);
      expect(decoded2).toBeNull(); // Token signature invalid with new key
    });

    it('should allow new tokens after key rotation', async () => {
      // Create session token with seed2 (after rotation)
      const signingKey2 = await importSessionSigningKey(seed2);
      const tokenData = {
        device_id: 'device-002',
        build_version: '1.0.0',
        expires_at: Date.now() + 3600000,
      };
      const sessionToken = await createSessionToken(signingKey2, tokenData);

      // Verify token works with seed2
      const attestationSigningKey2 = await importAttestationSigningKey(seed2);
      const verifyKey2 = await importVerifyKey(await exportPublicKeyBase64(attestationSigningKey2));
      const decoded = await verifySessionToken(verifyKey2, sessionToken);
      expect(decoded).not.toBeNull();
      expect(decoded.device_id).toBe('device-002');
    });
  });
});
