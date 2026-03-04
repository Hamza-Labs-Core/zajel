/**
 * Unit tests for TUF metadata creation, signing, and verification.
 *
 * Tests cover:
 * - Metadata schema functions (canonicalJSON, generateKeyId, isExpired)
 * - Role-specific metadata creation (root, targets, snapshot, timestamp)
 * - Metadata signing and signature verification
 * - Metadata chain hash consistency
 * - Server-side verification module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateKeyId,
  createTufKey,
  createExpiration,
  hashMetadata,
  isExpired,
  canonicalJSON,
  verifySignature,
} from '../../src/crypto/tuf/metadata.js';
import {
  signMetadata,
  importRoleKey,
  createRootMetadata,
  createTargetsMetadata,
  createSnapshotMetadata,
  createTimestampMetadata,
} from '../../src/crypto/tuf/roles.js';
import {
  verifyMetadataSignature,
  validateMetadataChain,
  validateRootMetadata,
  validateVersionIncrement,
} from '../../src/crypto/tuf/verification.js';

// --- Test helpers ---

async function generateTestKeypair() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  const seedHex = Array.from(seed, b => b.toString(16).padStart(2, '0')).join('');
  const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  let binary = '';
  for (let i = 0; i < pubBytes.length; i++) {
    binary += String.fromCharCode(pubBytes[i]);
  }
  const pubBase64 = btoa(binary);
  return { seedHex, pubBase64, keyPair };
}

// --- Tests ---

describe('TUF Metadata Schema', () => {
  describe('generateKeyId', () => {
    it('should generate SHA256 hash of canonical key JSON', async () => {
      const key = createTufKey('dGVzdCBwdWJsaWMga2V5IDMyIGJ5dGVzIQ==');
      const keyid = await generateKeyId(key);
      expect(keyid).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce same keyid for same key', async () => {
      const key = createTufKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      const keyid1 = await generateKeyId(key);
      const keyid2 = await generateKeyId(key);
      expect(keyid1).toBe(keyid2);
    });

    it('should produce different keyids for different keys', async () => {
      const key1 = createTufKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      const key2 = createTufKey('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=');
      const keyid1 = await generateKeyId(key1);
      const keyid2 = await generateKeyId(key2);
      expect(keyid1).not.toBe(keyid2);
    });
  });

  describe('createTufKey', () => {
    it('should create a key object with ed25519 keytype', () => {
      const key = createTufKey('testkey');
      expect(key.keytype).toBe('ed25519');
      expect(key.scheme).toBe('ed25519');
      expect(key.keyval).toBe('testkey');
    });
  });

  describe('createExpiration', () => {
    it('should create a future ISO timestamp', () => {
      const exp = createExpiration(30);
      const date = new Date(exp);
      expect(date.getTime()).toBeGreaterThan(Date.now());
    });

    it('should be approximately N days from now', () => {
      const exp = createExpiration(7);
      const date = new Date(exp);
      const diffDays = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(6.9);
      expect(diffDays).toBeLessThan(7.1);
    });
  });

  describe('hashMetadata', () => {
    it('should produce consistent SHA256 hashes', async () => {
      const obj = { foo: 'bar', baz: 123 };
      const hash1 = await hashMetadata(obj);
      const hash2 = await hashMetadata(obj);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different hashes for different objects', async () => {
      const hash1 = await hashMetadata({ a: 1 });
      const hash2 = await hashMetadata({ a: 2 });
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('isExpired', () => {
    it('should return false for future expiration', () => {
      const future = new Date();
      future.setUTCDate(future.getUTCDate() + 1);
      expect(isExpired(future.toISOString())).toBe(false);
    });

    it('should return true for past expiration', () => {
      const past = new Date();
      past.setUTCDate(past.getUTCDate() - 1);
      expect(isExpired(past.toISOString())).toBe(true);
    });

    it('should handle edge case of current time', () => {
      // Slightly in the past
      const now = new Date(Date.now() - 1000);
      expect(isExpired(now.toISOString())).toBe(true);
    });
  });

  describe('canonicalJSON', () => {
    it('should sort object keys alphabetically', () => {
      expect(canonicalJSON({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
    });

    it('should handle nested objects recursively', () => {
      expect(canonicalJSON({ outer: { z: 1, a: 2 }, foo: 'bar' }))
        .toBe('{"foo":"bar","outer":{"a":2,"z":1}}');
    });

    it('should handle arrays without sorting elements', () => {
      expect(canonicalJSON({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
    });

    it('should handle null values', () => {
      expect(canonicalJSON({ a: null })).toBe('{"a":null}');
    });

    it('should handle boolean values', () => {
      expect(canonicalJSON({ z: true, a: false })).toBe('{"a":false,"z":true}');
    });

    it('should handle deeply nested structures', () => {
      expect(canonicalJSON({
        z: { z: { z: 1, a: 2 }, a: 3 },
        a: 4,
      })).toBe('{"a":4,"z":{"a":3,"z":{"a":2,"z":1}}}');
    });

    it('should handle empty objects and arrays', () => {
      expect(canonicalJSON({})).toBe('{}');
      expect(canonicalJSON([])).toBe('[]');
    });

    it('should handle string values with special characters', () => {
      expect(canonicalJSON({ a: 'hello "world"' })).toBe('{"a":"hello \\"world\\""}');
    });
  });
});

describe('TUF Role Signing', () => {
  let rootKeyPair;
  let rootSeedHex, rootPubBase64;
  let targetsKeyPair;
  let targetsSeedHex, targetsPubBase64;
  let snapshotKeyPair;
  let snapshotSeedHex, snapshotPubBase64;
  let timestampKeyPair;
  let timestampSeedHex, timestampPubBase64;

  beforeEach(async () => {
    const root = await generateTestKeypair();
    rootSeedHex = root.seedHex;
    rootPubBase64 = root.pubBase64;
    rootKeyPair = root.keyPair;

    const targets = await generateTestKeypair();
    targetsSeedHex = targets.seedHex;
    targetsPubBase64 = targets.pubBase64;
    targetsKeyPair = targets.keyPair;

    const snapshot = await generateTestKeypair();
    snapshotSeedHex = snapshot.seedHex;
    snapshotPubBase64 = snapshot.pubBase64;
    snapshotKeyPair = snapshot.keyPair;

    const timestamp = await generateTestKeypair();
    timestampSeedHex = timestamp.seedHex;
    timestampPubBase64 = timestamp.pubBase64;
    timestampKeyPair = timestamp.keyPair;
  });

  describe('importRoleKey', () => {
    it('should import a role key and derive keyid', async () => {
      const result = await importRoleKey(rootSeedHex, rootPubBase64);
      expect(result.keyid).toMatch(/^[0-9a-f]{64}$/);
      expect(result.key).toBeDefined();
      expect(result.key.type).toBe('private');
    });

    it('should produce consistent keyids', async () => {
      const result1 = await importRoleKey(rootSeedHex, rootPubBase64);
      const result2 = await importRoleKey(rootSeedHex, rootPubBase64);
      expect(result1.keyid).toBe(result2.keyid);
    });
  });

  describe('signMetadata', () => {
    it('should produce a signed metadata envelope', async () => {
      const metadata = { _type: 'test', version: 1 };
      const rootKey = await importRoleKey(rootSeedHex, rootPubBase64);
      const signed = await signMetadata(metadata, [rootKey]);

      expect(signed.signed).toEqual(metadata);
      expect(signed.signatures).toHaveLength(1);
      expect(signed.signatures[0].keyid).toBe(rootKey.keyid);
      expect(signed.signatures[0].sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('should support multiple signatures', async () => {
      const metadata = { _type: 'test', version: 1 };
      const key1 = await importRoleKey(rootSeedHex, rootPubBase64);
      const key2 = await importRoleKey(targetsSeedHex, targetsPubBase64);
      const signed = await signMetadata(metadata, [key1, key2]);

      expect(signed.signatures).toHaveLength(2);
      expect(signed.signatures[0].keyid).toBe(key1.keyid);
      expect(signed.signatures[1].keyid).toBe(key2.keyid);
    });
  });

  describe('createRootMetadata', () => {
    it('should create valid root metadata with all roles', async () => {
      const rootMetadata = await createRootMetadata(1, 365, {
        root: rootPubBase64,
        targets: targetsPubBase64,
        snapshot: snapshotPubBase64,
        timestamp: timestampPubBase64,
      });

      expect(rootMetadata._type).toBe('root');
      expect(rootMetadata.spec_version).toBe('1.0.31');
      expect(rootMetadata.version).toBe(1);
      expect(rootMetadata.consistent_snapshot).toBe(false);
      expect(rootMetadata.roles.root).toBeDefined();
      expect(rootMetadata.roles.targets).toBeDefined();
      expect(rootMetadata.roles.snapshot).toBeDefined();
      expect(rootMetadata.roles.timestamp).toBeDefined();

      // Each role should have threshold=1 and one keyid
      for (const role of ['root', 'targets', 'snapshot', 'timestamp']) {
        expect(rootMetadata.roles[role].threshold).toBe(1);
        expect(rootMetadata.roles[role].keyids).toHaveLength(1);
        // Keyid should exist in keys map
        const keyid = rootMetadata.roles[role].keyids[0];
        expect(rootMetadata.keys[keyid]).toBeDefined();
        expect(rootMetadata.keys[keyid].keytype).toBe('ed25519');
      }
    });

    it('should set correct expiration', async () => {
      const rootMetadata = await createRootMetadata(1, 30, {
        root: rootPubBase64,
      });

      const expires = new Date(rootMetadata.expires);
      const diffDays = (expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(29);
      expect(diffDays).toBeLessThan(31);
    });

    it('should be signable and verifiable', async () => {
      const rootMetadata = await createRootMetadata(1, 365, {
        root: rootPubBase64,
        targets: targetsPubBase64,
      });

      const rootKey = await importRoleKey(rootSeedHex, rootPubBase64);
      const signed = await signMetadata(rootMetadata, [rootKey]);

      expect(signed.signatures).toHaveLength(1);
      expect(signed.signatures[0].sig).toMatch(/^[A-Za-z0-9+/]+=*$/);

      // Verify the signature
      const isValid = await verifySignature(signed, rootPubBase64, rootKey.keyid);
      expect(isValid).toBe(true);
    });
  });

  describe('createTargetsMetadata', () => {
    it('should create targets metadata with server entries', async () => {
      const servers = [
        {
          serverId: 'ed25519:test1',
          endpoint: 'wss://test1.example.com',
          publicKey: 'key1',
          region: 'us-east',
          buildVerified: true,
          buildHash: 'abc123',
          buildVersion: 'v1.0.0',
          registeredAt: 1000,
          lastSeen: 2000,
        },
      ];

      const targetsMetadata = await createTargetsMetadata(1, 30, servers);

      expect(targetsMetadata._type).toBe('targets');
      expect(targetsMetadata.version).toBe(1);
      expect(targetsMetadata.delegations).toBeNull();

      const targetKey = 'servers/ed25519:test1.json';
      expect(targetsMetadata.targets[targetKey]).toBeDefined();
      expect(targetsMetadata.targets[targetKey].custom.serverId).toBe('ed25519:test1');
      expect(targetsMetadata.targets[targetKey].custom.endpoint).toBe('wss://test1.example.com');
      expect(targetsMetadata.targets[targetKey].hashes.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(targetsMetadata.targets[targetKey].length).toBeGreaterThan(0);
    });

    it('should handle empty server list', async () => {
      const targetsMetadata = await createTargetsMetadata(1, 30, []);
      expect(targetsMetadata.targets).toEqual({});
    });

    it('should handle multiple servers', async () => {
      const servers = [
        { serverId: 'ed25519:srv1', endpoint: 'wss://srv1.example.com', publicKey: 'k1', region: 'us-east', registeredAt: 1000, lastSeen: 2000 },
        { serverId: 'ed25519:srv2', endpoint: 'wss://srv2.example.com', publicKey: 'k2', region: 'eu-west', registeredAt: 1000, lastSeen: 2000 },
      ];

      const targetsMetadata = await createTargetsMetadata(1, 30, servers);
      expect(Object.keys(targetsMetadata.targets)).toHaveLength(2);
    });
  });

  describe('createSnapshotMetadata', () => {
    it('should create snapshot metadata with targets hash', async () => {
      const targetsMetadata = await createTargetsMetadata(1, 30, []);
      const targetsKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
      const signedTargets = await signMetadata(targetsMetadata, [targetsKey]);

      const snapshotMetadata = await createSnapshotMetadata(1, 7, signedTargets);

      expect(snapshotMetadata._type).toBe('snapshot');
      expect(snapshotMetadata.version).toBe(1);
      expect(snapshotMetadata.meta['targets.json']).toBeDefined();
      expect(snapshotMetadata.meta['targets.json'].version).toBe(1);
      expect(snapshotMetadata.meta['targets.json'].hashes.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce consistent hash for same targets', async () => {
      const targetsMetadata = await createTargetsMetadata(1, 30, []);
      const targetsKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
      const signedTargets = await signMetadata(targetsMetadata, [targetsKey]);

      const snapshot1 = await createSnapshotMetadata(1, 7, signedTargets);
      const snapshot2 = await createSnapshotMetadata(2, 7, signedTargets);

      // Same targets, different snapshot versions, but same targets hash
      expect(snapshot1.meta['targets.json'].hashes.sha256)
        .toBe(snapshot2.meta['targets.json'].hashes.sha256);
    });
  });

  describe('createTimestampMetadata', () => {
    it('should create timestamp metadata with snapshot hash', async () => {
      const targetsMetadata = await createTargetsMetadata(1, 30, []);
      const targetsKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
      const signedTargets = await signMetadata(targetsMetadata, [targetsKey]);

      const snapshotMetadata = await createSnapshotMetadata(1, 7, signedTargets);
      const snapshotKey = await importRoleKey(snapshotSeedHex, snapshotPubBase64);
      const signedSnapshot = await signMetadata(snapshotMetadata, [snapshotKey]);

      const timestampMetadata = await createTimestampMetadata(1, 24, signedSnapshot);

      expect(timestampMetadata._type).toBe('timestamp');
      expect(timestampMetadata.version).toBe(1);
      expect(timestampMetadata.meta['snapshot.json']).toBeDefined();
      expect(timestampMetadata.meta['snapshot.json'].version).toBe(1);
      expect(timestampMetadata.meta['snapshot.json'].hashes.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should set expiration in hours', async () => {
      const targetsMetadata = await createTargetsMetadata(1, 30, []);
      const targetsKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
      const signedTargets = await signMetadata(targetsMetadata, [targetsKey]);

      const snapshotMetadata = await createSnapshotMetadata(1, 7, signedTargets);
      const snapshotKey = await importRoleKey(snapshotSeedHex, snapshotPubBase64);
      const signedSnapshot = await signMetadata(snapshotMetadata, [snapshotKey]);

      const timestampMetadata = await createTimestampMetadata(1, 24, signedSnapshot);

      const expires = new Date(timestampMetadata.expires);
      const diffHours = (expires.getTime() - Date.now()) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(23);
      expect(diffHours).toBeLessThan(25);
    });
  });

  describe('Full metadata chain creation and verification', () => {
    it('should create a valid chain from targets -> snapshot -> timestamp', async () => {
      const servers = [
        {
          serverId: 'ed25519:chain-test',
          endpoint: 'wss://chain.example.com',
          publicKey: 'chainkey',
          region: 'us-east',
          registeredAt: Date.now(),
          lastSeen: Date.now(),
        },
      ];

      // Create and sign targets
      const targetsUnsigned = await createTargetsMetadata(1, 30, servers);
      const tKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
      const targetsMetadata = await signMetadata(targetsUnsigned, [tKey]);

      // Create and sign snapshot
      const snapshotUnsigned = await createSnapshotMetadata(1, 7, targetsMetadata);
      const sKey = await importRoleKey(snapshotSeedHex, snapshotPubBase64);
      const snapshotMetadata = await signMetadata(snapshotUnsigned, [sKey]);

      // Create and sign timestamp
      const timestampUnsigned = await createTimestampMetadata(1, 24, snapshotMetadata);
      const tsKey = await importRoleKey(timestampSeedHex, timestampPubBase64);
      const timestampMetadata = await signMetadata(timestampUnsigned, [tsKey]);

      // Verify signatures on each role
      expect(await verifySignature(targetsMetadata, targetsPubBase64, tKey.keyid)).toBe(true);
      expect(await verifySignature(snapshotMetadata, snapshotPubBase64, sKey.keyid)).toBe(true);
      expect(await verifySignature(timestampMetadata, timestampPubBase64, tsKey.keyid)).toBe(true);

      // Verify hash chain: timestamp -> snapshot
      const snapshotCanonical = canonicalJSON(snapshotMetadata.signed);
      const snapshotHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshotCanonical));
      const snapshotHash = Array.from(new Uint8Array(snapshotHashBuf), b => b.toString(16).padStart(2, '0')).join('');
      expect(timestampMetadata.signed.meta['snapshot.json'].hashes.sha256).toBe(snapshotHash);

      // Verify hash chain: snapshot -> targets
      const targetsCanonical = canonicalJSON(targetsMetadata.signed);
      const targetsHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(targetsCanonical));
      const targetsHash = Array.from(new Uint8Array(targetsHashBuf), b => b.toString(16).padStart(2, '0')).join('');
      expect(snapshotMetadata.signed.meta['targets.json'].hashes.sha256).toBe(targetsHash);

      // Verify version references
      expect(timestampMetadata.signed.meta['snapshot.json'].version).toBe(1);
      expect(snapshotMetadata.signed.meta['targets.json'].version).toBe(1);
    });

    it('should detect tampered targets (hash mismatch in snapshot)', async () => {
      const servers = [
        { serverId: 'ed25519:tamper-test', endpoint: 'wss://tamper.example.com', publicKey: 'tk', region: 'us-east', registeredAt: 1000, lastSeen: 2000 },
      ];

      // Create legitimate chain
      const targetsUnsigned = await createTargetsMetadata(1, 30, servers);
      const tKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
      const targetsMetadata = await signMetadata(targetsUnsigned, [tKey]);

      const snapshotUnsigned = await createSnapshotMetadata(1, 7, targetsMetadata);
      const sKey = await importRoleKey(snapshotSeedHex, snapshotPubBase64);
      const snapshotMetadata = await signMetadata(snapshotUnsigned, [sKey]);

      // Tamper with targets
      const tamperedTargets = JSON.parse(JSON.stringify(targetsMetadata));
      tamperedTargets.signed.targets['servers/ed25519:tamper-test.json'].custom.endpoint = 'wss://evil.example.com';

      // Compute hash of tampered targets
      const tamperedCanonical = canonicalJSON(tamperedTargets.signed);
      const tamperedHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tamperedCanonical));
      const tamperedHash = Array.from(new Uint8Array(tamperedHashBuf), b => b.toString(16).padStart(2, '0')).join('');

      // The snapshot's recorded hash should NOT match the tampered targets
      expect(snapshotMetadata.signed.meta['targets.json'].hashes.sha256).not.toBe(tamperedHash);
    });
  });
});

describe('TUF Signature Verification', () => {
  let rootSeedHex, rootPubBase64;

  beforeEach(async () => {
    const root = await generateTestKeypair();
    rootSeedHex = root.seedHex;
    rootPubBase64 = root.pubBase64;
  });

  describe('verifySignature', () => {
    it('should verify a valid signature', async () => {
      const metadata = { _type: 'test', version: 1 };
      const rootKey = await importRoleKey(rootSeedHex, rootPubBase64);
      const signed = await signMetadata(metadata, [rootKey]);

      const isValid = await verifySignature(signed, rootPubBase64, rootKey.keyid);
      expect(isValid).toBe(true);
    });

    it('should reject signature from wrong key', async () => {
      const metadata = { _type: 'test', version: 1 };
      const rootKey = await importRoleKey(rootSeedHex, rootPubBase64);
      const signed = await signMetadata(metadata, [rootKey]);

      const other = await generateTestKeypair();
      const otherKey = await importRoleKey(other.seedHex, other.pubBase64);

      // Verify with wrong public key but correct keyid from signature
      const isValid = await verifySignature(signed, other.pubBase64, rootKey.keyid);
      expect(isValid).toBe(false);
    });

    it('should reject when keyid is not found in signatures', async () => {
      const metadata = { _type: 'test', version: 1 };
      const rootKey = await importRoleKey(rootSeedHex, rootPubBase64);
      const signed = await signMetadata(metadata, [rootKey]);

      const isValid = await verifySignature(signed, rootPubBase64, 'nonexistent-keyid');
      expect(isValid).toBe(false);
    });

    it('should reject tampered metadata', async () => {
      const metadata = { _type: 'test', version: 1 };
      const rootKey = await importRoleKey(rootSeedHex, rootPubBase64);
      const signed = await signMetadata(metadata, [rootKey]);

      // Tamper with signed content
      signed.signed.version = 999;

      const isValid = await verifySignature(signed, rootPubBase64, rootKey.keyid);
      expect(isValid).toBe(false);
    });
  });

  describe('verifyMetadataSignature', () => {
    it('should verify a valid signature using just the public key', async () => {
      const metadata = { _type: 'test', version: 1 };
      const rootKey = await importRoleKey(rootSeedHex, rootPubBase64);
      const signed = await signMetadata(metadata, [rootKey]);

      const isValid = await verifyMetadataSignature(signed, rootPubBase64);
      expect(isValid).toBe(true);
    });

    it('should reject null metadata', async () => {
      const isValid = await verifyMetadataSignature(null, rootPubBase64);
      expect(isValid).toBe(false);
    });

    it('should reject metadata without signatures', async () => {
      const isValid = await verifyMetadataSignature({ signed: {}, signatures: [] }, rootPubBase64);
      expect(isValid).toBe(false);
    });
  });
});

describe('TUF Verification Module', () => {
  let rootSeedHex, rootPubBase64;
  let targetsSeedHex, targetsPubBase64;
  let snapshotSeedHex, snapshotPubBase64;
  let timestampSeedHex, timestampPubBase64;

  beforeEach(async () => {
    const root = await generateTestKeypair();
    rootSeedHex = root.seedHex;
    rootPubBase64 = root.pubBase64;

    const targets = await generateTestKeypair();
    targetsSeedHex = targets.seedHex;
    targetsPubBase64 = targets.pubBase64;

    const snapshot = await generateTestKeypair();
    snapshotSeedHex = snapshot.seedHex;
    snapshotPubBase64 = snapshot.pubBase64;

    const ts = await generateTestKeypair();
    timestampSeedHex = ts.seedHex;
    timestampPubBase64 = ts.pubBase64;
  });

  async function createFullChain(servers = []) {
    const targetsUnsigned = await createTargetsMetadata(1, 30, servers);
    const tKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
    const targetsMetadata = await signMetadata(targetsUnsigned, [tKey]);

    const snapshotUnsigned = await createSnapshotMetadata(1, 7, targetsMetadata);
    const sKey = await importRoleKey(snapshotSeedHex, snapshotPubBase64);
    const snapshotMetadata = await signMetadata(snapshotUnsigned, [sKey]);

    const timestampUnsigned = await createTimestampMetadata(1, 24, snapshotMetadata);
    const tsKey = await importRoleKey(timestampSeedHex, timestampPubBase64);
    const timestampMetadata = await signMetadata(timestampUnsigned, [tsKey]);

    return { targetsMetadata, snapshotMetadata, timestampMetadata };
  }

  describe('validateMetadataChain', () => {
    it('should validate a consistent metadata chain', async () => {
      const { targetsMetadata, snapshotMetadata, timestampMetadata } = await createFullChain();

      const result = await validateMetadataChain({
        timestamp: timestampMetadata,
        snapshot: snapshotMetadata,
        targets: targetsMetadata,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing signed metadata', async () => {
      const result = await validateMetadataChain({
        timestamp: {},
        snapshot: { signed: { _type: 'snapshot', version: 1, expires: new Date(Date.now() + 86400000).toISOString(), meta: {} } },
        targets: { signed: { _type: 'targets', version: 1, expires: new Date(Date.now() + 86400000).toISOString() } },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect type mismatches', async () => {
      const { targetsMetadata, snapshotMetadata, timestampMetadata } = await createFullChain();

      // Swap timestamp type
      const badTimestamp = JSON.parse(JSON.stringify(timestampMetadata));
      badTimestamp.signed._type = 'snapshot';

      const result = await validateMetadataChain({
        timestamp: badTimestamp,
        snapshot: snapshotMetadata,
        targets: targetsMetadata,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Expected timestamp'))).toBe(true);
    });

    it('should detect version mismatch between timestamp and snapshot', async () => {
      const { targetsMetadata, snapshotMetadata, timestampMetadata } = await createFullChain();

      // Tamper with snapshot version
      const badSnapshot = JSON.parse(JSON.stringify(snapshotMetadata));
      badSnapshot.signed.version = 999;

      const result = await validateMetadataChain({
        timestamp: timestampMetadata,
        snapshot: badSnapshot,
        targets: targetsMetadata,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Timestamp references snapshot'))).toBe(true);
    });

    it('should detect hash mismatch in snapshot -> targets', async () => {
      const { targetsMetadata, snapshotMetadata, timestampMetadata } = await createFullChain();

      // Tamper with targets content
      const badTargets = JSON.parse(JSON.stringify(targetsMetadata));
      badTargets.signed.version = 999;

      const result = await validateMetadataChain({
        timestamp: timestampMetadata,
        snapshot: snapshotMetadata,
        targets: badTargets,
      });

      expect(result.valid).toBe(false);
      // Should detect either version mismatch or hash mismatch
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validateRootMetadata', () => {
    it('should validate a correct root metadata', async () => {
      const rootMetadata = await createRootMetadata(1, 365, {
        root: rootPubBase64,
        targets: targetsPubBase64,
        snapshot: snapshotPubBase64,
        timestamp: timestampPubBase64,
      });

      const result = validateRootMetadata(rootMetadata);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject root with missing roles', () => {
      const result = validateRootMetadata({
        _type: 'root',
        version: 1,
        expires: new Date(Date.now() + 86400000).toISOString(),
        keys: {},
        roles: {
          root: { threshold: 1, keyids: ['key1'] },
          // missing targets, snapshot, timestamp
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('targets'))).toBe(true);
      expect(result.errors.some(e => e.includes('snapshot'))).toBe(true);
      expect(result.errors.some(e => e.includes('timestamp'))).toBe(true);
    });

    it('should reject root with expired expiration', () => {
      const result = validateRootMetadata({
        _type: 'root',
        version: 1,
        expires: new Date(Date.now() - 86400000).toISOString(),
        keys: {},
        roles: {
          root: { threshold: 1, keyids: [] },
          targets: { threshold: 1, keyids: [] },
          snapshot: { threshold: 1, keyids: [] },
          timestamp: { threshold: 1, keyids: [] },
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('expired'))).toBe(true);
    });

    it('should reject root with invalid version', () => {
      const result = validateRootMetadata({
        _type: 'root',
        version: 0,
        expires: new Date(Date.now() + 86400000).toISOString(),
        keys: {},
        roles: {
          root: { threshold: 1, keyids: [] },
          targets: { threshold: 1, keyids: [] },
          snapshot: { threshold: 1, keyids: [] },
          timestamp: { threshold: 1, keyids: [] },
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('version'))).toBe(true);
    });

    it('should reject root with wrong type', () => {
      const result = validateRootMetadata({
        _type: 'targets',
        version: 1,
        expires: new Date(Date.now() + 86400000).toISOString(),
        keys: {},
        roles: {
          root: { threshold: 1, keyids: [] },
          targets: { threshold: 1, keyids: [] },
          snapshot: { threshold: 1, keyids: [] },
          timestamp: { threshold: 1, keyids: [] },
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Expected root'))).toBe(true);
    });
  });

  describe('validateVersionIncrement', () => {
    it('should accept first version (v1)', () => {
      const result = validateVersionIncrement(null, 1);
      expect(result.valid).toBe(true);
    });

    it('should accept version increment', () => {
      const result = validateVersionIncrement(1, 2);
      expect(result.valid).toBe(true);
    });

    it('should accept large version jumps', () => {
      const result = validateVersionIncrement(1, 100);
      expect(result.valid).toBe(true);
    });

    it('should reject same version', () => {
      const result = validateVersionIncrement(1, 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('rollback');
    });

    it('should reject lower version', () => {
      const result = validateVersionIncrement(5, 3);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('rollback');
    });

    it('should reject invalid version number', () => {
      const result = validateVersionIncrement(null, 0);
      expect(result.valid).toBe(false);
    });

    it('should reject non-integer version', () => {
      const result = validateVersionIncrement(null, 1.5);
      expect(result.valid).toBe(false);
    });
  });
});
