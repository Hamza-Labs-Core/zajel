/**
 * Server Identity Tests
 *
 * Tests for Ed25519 key generation, signing, and verification.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import {
  generateIdentity,
  sign,
  signMessage,
  verify,
  verifyMessage,
  publicKeyFromServerId,
  saveIdentity,
  loadIdentity,
  loadOrGenerateIdentity,
  computeNodeId,
  createAuthPayload,
  verifyAuthPayload,
} from '../../src/identity/server-identity.js';

describe('Server Identity', () => {
  const testKeyPath = './test-data/test-identity.key';

  beforeAll(() => {
    if (!existsSync('./test-data')) {
      mkdirSync('./test-data', { recursive: true });
    }
  });

  afterAll(() => {
    // Cleanup test files
    if (existsSync(testKeyPath)) {
      unlinkSync(testKeyPath);
    }
  });

  describe('generateIdentity', () => {
    it('should generate a valid identity', async () => {
      const identity = await generateIdentity('test');

      expect(identity.serverId).toMatch(/^ed25519:/);
      expect(identity.nodeId).toHaveLength(40); // 160 bits = 20 bytes = 40 hex chars
      expect(identity.ephemeralId).toMatch(/^test-[a-z0-9]{6}$/);
      expect(identity.publicKey).toBeInstanceOf(Uint8Array);
      expect(identity.privateKey).toBeInstanceOf(Uint8Array);
      expect(identity.publicKey.length).toBe(32); // Ed25519 public key
      expect(identity.privateKey.length).toBe(32); // Ed25519 private key
    });

    it('should generate unique identities', async () => {
      const identity1 = await generateIdentity();
      const identity2 = await generateIdentity();

      expect(identity1.serverId).not.toBe(identity2.serverId);
      expect(identity1.nodeId).not.toBe(identity2.nodeId);
    });
  });

  describe('computeNodeId', () => {
    it('should compute deterministic node ID from public key', async () => {
      const identity = await generateIdentity();
      const nodeId1 = computeNodeId(identity.publicKey);
      const nodeId2 = computeNodeId(identity.publicKey);

      expect(nodeId1).toBe(nodeId2);
      expect(nodeId1).toHaveLength(40);
    });

    it('should produce different node IDs for different public keys', async () => {
      const identity1 = await generateIdentity();
      const identity2 = await generateIdentity();

      const nodeId1 = computeNodeId(identity1.publicKey);
      const nodeId2 = computeNodeId(identity2.publicKey);

      expect(nodeId1).not.toBe(nodeId2);
    });
  });

  describe('signing and verification', () => {
    it('should sign and verify raw data', async () => {
      const identity = await generateIdentity();
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      const signature = await sign(identity, data);
      const isValid = await verify(data, signature, identity.publicKey);

      expect(isValid).toBe(true);
    });

    it('should reject modified data', async () => {
      const identity = await generateIdentity();
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      const signature = await sign(identity, data);

      // Modify data
      data[0] = 99;
      const isValid = await verify(data, signature, identity.publicKey);

      expect(isValid).toBe(false);
    });

    it('should sign and verify string messages', async () => {
      const identity = await generateIdentity();
      const message = 'Hello, World!';

      const signature = await signMessage(identity, message);
      const isValid = await verifyMessage(message, signature, identity.publicKey);

      expect(isValid).toBe(true);
    });

    it('should reject tampered messages', async () => {
      const identity = await generateIdentity();
      const message = 'Hello, World!';

      const signature = await signMessage(identity, message);
      const isValid = await verifyMessage('Hello, World?', signature, identity.publicKey);

      expect(isValid).toBe(false);
    });

    it('should reject signatures from wrong key', async () => {
      const identity1 = await generateIdentity();
      const identity2 = await generateIdentity();
      const message = 'Test message';

      const signature = await signMessage(identity1, message);
      const isValid = await verifyMessage(message, signature, identity2.publicKey);

      expect(isValid).toBe(false);
    });
  });

  describe('publicKeyFromServerId', () => {
    it('should extract public key from server ID', async () => {
      const identity = await generateIdentity();
      const extracted = publicKeyFromServerId(identity.serverId);

      expect(extracted).toEqual(identity.publicKey);
    });

    it('should throw for invalid server ID format', () => {
      expect(() => publicKeyFromServerId('invalid:abc')).toThrow();
      expect(() => publicKeyFromServerId('abc')).toThrow();
    });
  });

  describe('persistence', () => {
    it('should save and load identity', async () => {
      const original = await generateIdentity('persist');
      saveIdentity(original, testKeyPath);

      const loaded = loadIdentity(testKeyPath);

      expect(loaded.serverId).toBe(original.serverId);
      expect(loaded.nodeId).toBe(original.nodeId);
      expect(loaded.ephemeralId).toBe(original.ephemeralId);
      expect(loaded.publicKey).toEqual(original.publicKey);
      expect(loaded.privateKey).toEqual(original.privateKey);
    });

    it('should load existing identity with loadOrGenerateIdentity', async () => {
      const original = await generateIdentity('existing');
      saveIdentity(original, testKeyPath);

      const loaded = await loadOrGenerateIdentity(testKeyPath);

      expect(loaded.serverId).toBe(original.serverId);
    });

    it('should generate new identity if file does not exist', async () => {
      const newPath = './test-data/new-identity.key';
      if (existsSync(newPath)) {
        unlinkSync(newPath);
      }

      const identity = await loadOrGenerateIdentity(newPath, 'new');

      expect(identity.serverId).toMatch(/^ed25519:/);
      expect(existsSync(newPath)).toBe(true);

      // Cleanup
      unlinkSync(newPath);
    });
  });

  describe('auth payload', () => {
    it('should create and verify auth payload', async () => {
      const server1 = await generateIdentity('srv1');
      const server2 = await generateIdentity('srv2');

      const timestamp = Date.now();
      const payload = createAuthPayload(server1, server2.serverId, timestamp);
      const signature = await signMessage(server1, payload);

      const isValid = await verifyAuthPayload(
        payload,
        signature,
        server1.serverId,
        server2.serverId,
        30000
      );

      expect(isValid).toBe(true);
    });

    it('should reject expired auth payload', async () => {
      const server1 = await generateIdentity('srv1');
      const server2 = await generateIdentity('srv2');

      const timestamp = Date.now() - 60000; // 1 minute ago
      const payload = createAuthPayload(server1, server2.serverId, timestamp);
      const signature = await signMessage(server1, payload);

      const isValid = await verifyAuthPayload(
        payload,
        signature,
        server1.serverId,
        server2.serverId,
        30000 // 30 second max age
      );

      expect(isValid).toBe(false);
    });

    it('should reject payload for wrong recipient', async () => {
      const server1 = await generateIdentity('srv1');
      const server2 = await generateIdentity('srv2');
      const server3 = await generateIdentity('srv3');

      const timestamp = Date.now();
      const payload = createAuthPayload(server1, server2.serverId, timestamp);
      const signature = await signMessage(server1, payload);

      // Try to use payload meant for server2 on server3
      const isValid = await verifyAuthPayload(
        payload,
        signature,
        server1.serverId,
        server3.serverId, // Wrong recipient
        30000
      );

      expect(isValid).toBe(false);
    });
  });
});
