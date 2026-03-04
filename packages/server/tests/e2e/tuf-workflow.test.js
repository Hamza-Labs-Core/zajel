/**
 * E2E tests for TUF workflow including attack resistance.
 *
 * Tests the full TUF metadata lifecycle:
 * - Metadata creation, signing, storage, and retrieval
 * - Metadata chain consistency across all roles
 * - Attack scenario resistance (freeze, rollback, mix-and-match)
 * - Root key rotation (N -> N+1 transition)
 * - Version monotonicity enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyId,
  canonicalJSON,
  isExpired,
  hashMetadata,
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
  validateMetadataChain,
  validateRootMetadata,
} from '../../src/crypto/tuf/verification.js';
import { TufMetadataDO } from '../../src/durable-objects/tuf-metadata-do.js';

// --- Test helpers ---

class MockStorage {
  constructor() {
    this.data = new Map();
  }
  async get(key) { return this.data.get(key); }
  async put(key, value) { this.data.set(key, value); }
  async delete(key) {
    if (Array.isArray(key)) {
      for (const k of key) this.data.delete(k);
    } else {
      this.data.delete(key);
    }
  }
  async list({ prefix }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) results.set(key, value);
    }
    return results;
  }
  clear() { this.data.clear(); }
}

class MockState {
  constructor() { this.storage = new MockStorage(); }
}

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

// --- Full Lifecycle Tests ---

describe('TUF Full Workflow', () => {
  let rootKeys, targetsKeys, snapshotKeys, timestampKeys;
  let mockState;
  let tufDO;
  const TUF_SECRET = 'test-tuf-secret';
  const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TUF_SECRET}` };

  beforeEach(async () => {
    rootKeys = await generateTestKeypair();
    targetsKeys = await generateTestKeypair();
    snapshotKeys = await generateTestKeypair();
    timestampKeys = await generateTestKeypair();

    mockState = new MockState();
    tufDO = new TufMetadataDO(mockState, { TUF_UPDATE_SECRET: TUF_SECRET });
  });

  afterEach(() => {
    mockState.storage.clear();
  });

  async function storeMetadata(role, metadata) {
    const request = new Request(`https://internal/tuf/${role}.json`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(metadata),
    });
    const response = await tufDO.fetch(request);
    expect(response.status).toBe(200);
    return response;
  }

  async function fetchMetadata(role) {
    const request = new Request(`https://internal/tuf/${role}.json`);
    const response = await tufDO.fetch(request);
    expect(response.status).toBe(200);
    return response.json();
  }

  async function createAndStoreFullChain(version, servers = []) {
    // Create root
    const rootUnsigned = await createRootMetadata(version, 365, {
      root: rootKeys.pubBase64,
      targets: targetsKeys.pubBase64,
      snapshot: snapshotKeys.pubBase64,
      timestamp: timestampKeys.pubBase64,
    });
    const rootKey = await importRoleKey(rootKeys.seedHex, rootKeys.pubBase64);
    const rootMetadata = await signMetadata(rootUnsigned, [rootKey]);

    // Create targets
    const targetsUnsigned = await createTargetsMetadata(version, 30, servers);
    const tKey = await importRoleKey(targetsKeys.seedHex, targetsKeys.pubBase64);
    const targetsMetadata = await signMetadata(targetsUnsigned, [tKey]);

    // Create snapshot
    const snapshotUnsigned = await createSnapshotMetadata(version, 7, targetsMetadata);
    const sKey = await importRoleKey(snapshotKeys.seedHex, snapshotKeys.pubBase64);
    const snapshotMetadata = await signMetadata(snapshotUnsigned, [sKey]);

    // Create timestamp
    const timestampUnsigned = await createTimestampMetadata(version, 24, snapshotMetadata);
    const tsKey = await importRoleKey(timestampKeys.seedHex, timestampKeys.pubBase64);
    const timestampMetadata = await signMetadata(timestampUnsigned, [tsKey]);

    // Store all in DO
    await storeMetadata('root', rootMetadata);
    await storeMetadata('targets', targetsMetadata);
    await storeMetadata('snapshot', snapshotMetadata);
    await storeMetadata('timestamp', timestampMetadata);

    return { rootMetadata, targetsMetadata, snapshotMetadata, timestampMetadata };
  }

  it('should store and retrieve all four metadata types', async () => {
    await createAndStoreFullChain(1);

    const root = await fetchMetadata('root');
    expect(root.signed._type).toBe('root');
    expect(root.signed.version).toBe(1);

    const targets = await fetchMetadata('targets');
    expect(targets.signed._type).toBe('targets');
    expect(targets.signed.version).toBe(1);

    const snapshot = await fetchMetadata('snapshot');
    expect(snapshot.signed._type).toBe('snapshot');
    expect(snapshot.signed.version).toBe(1);

    const timestamp = await fetchMetadata('timestamp');
    expect(timestamp.signed._type).toBe('timestamp');
    expect(timestamp.signed.version).toBe(1);
  });

  it('should maintain metadata chain consistency', async () => {
    const servers = [
      { serverId: 'ed25519:srv1', endpoint: 'wss://srv1.example.com', publicKey: 'k1', region: 'us-east', registeredAt: 1000, lastSeen: 2000 },
    ];
    await createAndStoreFullChain(1, servers);

    const timestamp = await fetchMetadata('timestamp');
    const snapshot = await fetchMetadata('snapshot');
    const targets = await fetchMetadata('targets');

    const result = await validateMetadataChain({ timestamp, snapshot, targets });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should verify signatures on all stored metadata', async () => {
    await createAndStoreFullChain(1);

    const root = await fetchMetadata('root');
    const targets = await fetchMetadata('targets');
    const snapshot = await fetchMetadata('snapshot');
    const timestamp = await fetchMetadata('timestamp');

    // Verify root signature
    const rootKeyId = (await importRoleKey(rootKeys.seedHex, rootKeys.pubBase64)).keyid;
    expect(await verifySignature(root, rootKeys.pubBase64, rootKeyId)).toBe(true);

    // Verify targets signature
    const targetsKeyId = (await importRoleKey(targetsKeys.seedHex, targetsKeys.pubBase64)).keyid;
    expect(await verifySignature(targets, targetsKeys.pubBase64, targetsKeyId)).toBe(true);

    // Verify snapshot signature
    const snapshotKeyId = (await importRoleKey(snapshotKeys.seedHex, snapshotKeys.pubBase64)).keyid;
    expect(await verifySignature(snapshot, snapshotKeys.pubBase64, snapshotKeyId)).toBe(true);

    // Verify timestamp signature
    const timestampKeyId = (await importRoleKey(timestampKeys.seedHex, timestampKeys.pubBase64)).keyid;
    expect(await verifySignature(timestamp, timestampKeys.pubBase64, timestampKeyId)).toBe(true);
  });

  it('should increment versions correctly across updates', async () => {
    await createAndStoreFullChain(1);
    await createAndStoreFullChain(2);

    const root = await fetchMetadata('root');
    const targets = await fetchMetadata('targets');
    const snapshot = await fetchMetadata('snapshot');
    const timestamp = await fetchMetadata('timestamp');

    expect(root.signed.version).toBe(2);
    expect(targets.signed.version).toBe(2);
    expect(snapshot.signed.version).toBe(2);
    expect(timestamp.signed.version).toBe(2);
  });

  it('should include servers in targets metadata', async () => {
    const servers = [
      { serverId: 'ed25519:srv1', endpoint: 'wss://srv1.example.com', publicKey: 'k1', region: 'us-east', registeredAt: 1000, lastSeen: 2000 },
      { serverId: 'ed25519:srv2', endpoint: 'wss://srv2.example.com', publicKey: 'k2', region: 'eu-west', registeredAt: 1000, lastSeen: 2000 },
    ];
    await createAndStoreFullChain(1, servers);

    const targets = await fetchMetadata('targets');
    expect(Object.keys(targets.signed.targets)).toHaveLength(2);
    expect(targets.signed.targets['servers/ed25519:srv1.json']).toBeDefined();
    expect(targets.signed.targets['servers/ed25519:srv2.json']).toBeDefined();
    expect(targets.signed.targets['servers/ed25519:srv1.json'].custom.region).toBe('us-east');
  });
});

// --- Attack Resistance Tests ---

describe('TUF Attack Resistance', () => {
  let rootKeys, targetsKeys, snapshotKeys, timestampKeys;

  beforeEach(async () => {
    rootKeys = await generateTestKeypair();
    targetsKeys = await generateTestKeypair();
    snapshotKeys = await generateTestKeypair();
    timestampKeys = await generateTestKeypair();
  });

  describe('Freeze Attack', () => {
    it('should detect expired timestamp metadata', async () => {
      const targetsUnsigned = await createTargetsMetadata(1, 30, []);
      const tKey = await importRoleKey(targetsKeys.seedHex, targetsKeys.pubBase64);
      const targetsMetadata = await signMetadata(targetsUnsigned, [tKey]);

      const snapshotUnsigned = await createSnapshotMetadata(1, 7, targetsMetadata);
      const sKey = await importRoleKey(snapshotKeys.seedHex, snapshotKeys.pubBase64);
      const snapshotMetadata = await signMetadata(snapshotUnsigned, [sKey]);

      // Create timestamp that expires immediately (very short-lived)
      const expiry = new Date(Date.now() - 1000); // already expired
      const timestampUnsigned = {
        _type: 'timestamp',
        spec_version: '1.0.31',
        version: 1,
        expires: expiry.toISOString(),
        meta: {
          'snapshot.json': {
            version: snapshotMetadata.signed.version,
            hashes: {
              sha256: await hashMetadata(snapshotMetadata.signed),
            },
          },
        },
      };
      const tsKey = await importRoleKey(timestampKeys.seedHex, timestampKeys.pubBase64);
      const timestampMetadata = await signMetadata(timestampUnsigned, [tsKey]);

      // Client should detect expiration
      expect(isExpired(timestampMetadata.signed.expires)).toBe(true);
    });

    it('should detect expired snapshot metadata', () => {
      const past = new Date(Date.now() - 86400000); // 1 day ago
      expect(isExpired(past.toISOString())).toBe(true);
    });

    it('should accept non-expired metadata', () => {
      const future = new Date(Date.now() + 86400000); // 1 day from now
      expect(isExpired(future.toISOString())).toBe(false);
    });
  });

  describe('Rollback Attack', () => {
    let mockState, tufDO;
    const TUF_SECRET = 'test-tuf-secret';
    const authH = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TUF_SECRET}` };

    beforeEach(() => {
      mockState = new MockState();
      tufDO = new TufMetadataDO(mockState, { TUF_UPDATE_SECRET: TUF_SECRET });
    });

    afterEach(() => {
      mockState.storage.clear();
    });

    it('should reject rollback on timestamp metadata (v2 -> v1)', async () => {
      // Store version 2
      const v2Expiry = new Date(Date.now() + 86400000);
      const v2 = {
        signed: { _type: 'timestamp', spec_version: '1.0.31', version: 2, expires: v2Expiry.toISOString(), meta: {} },
        signatures: [{ keyid: 'k', sig: 'dGVzdA==' }],
      };
      await tufDO.fetch(new Request('https://internal/tuf/timestamp.json', {
        method: 'PUT', headers: authH, body: JSON.stringify(v2),
      }));

      // Try to store version 1 (rollback)
      const v1 = {
        signed: { _type: 'timestamp', spec_version: '1.0.31', version: 1, expires: v2Expiry.toISOString(), meta: {} },
        signatures: [{ keyid: 'k', sig: 'dGVzdA==' }],
      };
      const response = await tufDO.fetch(new Request('https://internal/tuf/timestamp.json', {
        method: 'PUT', headers: authH, body: JSON.stringify(v1),
      }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Version rollback detected');
    });

    it('should reject same version (v5 -> v5)', async () => {
      const expiry = new Date(Date.now() + 86400000);
      const v5 = {
        signed: { _type: 'targets', spec_version: '1.0.31', version: 5, expires: expiry.toISOString(), targets: {} },
        signatures: [{ keyid: 'k', sig: 'dGVzdA==' }],
      };
      await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authH, body: JSON.stringify(v5),
      }));

      const response = await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authH, body: JSON.stringify(v5),
      }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Version rollback detected');
    });

    it('should accept forward version increment', async () => {
      const expiry = new Date(Date.now() + 86400000);
      for (let v = 1; v <= 5; v++) {
        const metadata = {
          signed: { _type: 'snapshot', spec_version: '1.0.31', version: v, expires: expiry.toISOString(), meta: {} },
          signatures: [{ keyid: 'k', sig: 'dGVzdA==' }],
        };
        const response = await tufDO.fetch(new Request('https://internal/tuf/snapshot.json', {
          method: 'PUT', headers: authH, body: JSON.stringify(metadata),
        }));
        expect(response.status).toBe(200);
      }
    });
  });

  describe('Mix-and-Match Attack', () => {
    it('should detect when timestamp references wrong snapshot hash', async () => {
      // Create legitimate chain
      const targetsUnsigned = await createTargetsMetadata(1, 30, []);
      const tKey = await importRoleKey(targetsKeys.seedHex, targetsKeys.pubBase64);
      const targetsMetadata = await signMetadata(targetsUnsigned, [tKey]);

      const snapshotUnsigned = await createSnapshotMetadata(1, 7, targetsMetadata);
      const sKey = await importRoleKey(snapshotKeys.seedHex, snapshotKeys.pubBase64);
      const snapshotMetadata = await signMetadata(snapshotUnsigned, [sKey]);

      const timestampUnsigned = await createTimestampMetadata(1, 24, snapshotMetadata);
      const tsKey = await importRoleKey(timestampKeys.seedHex, timestampKeys.pubBase64);
      const timestampMetadata = await signMetadata(timestampUnsigned, [tsKey]);

      // Create a DIFFERENT snapshot (attacker's version)
      const evilTargetsUnsigned = await createTargetsMetadata(1, 30, [
        { serverId: 'evil', endpoint: 'wss://evil.example.com', publicKey: 'evil', region: 'evil', registeredAt: 1, lastSeen: 2 },
      ]);
      const evilTargets = await signMetadata(evilTargetsUnsigned, [tKey]);
      const evilSnapshotUnsigned = await createSnapshotMetadata(1, 7, evilTargets);
      const evilSnapshot = await signMetadata(evilSnapshotUnsigned, [sKey]);

      // The timestamp's snapshot hash should NOT match the evil snapshot
      const evilSnapshotHash = await hashMetadata(evilSnapshot.signed);
      const legitSnapshotHash = timestampMetadata.signed.meta['snapshot.json'].hashes.sha256;

      expect(evilSnapshotHash).not.toBe(legitSnapshotHash);

      // Validate chain detects the mismatch
      const result = await validateMetadataChain({
        timestamp: timestampMetadata,
        snapshot: evilSnapshot,
        targets: evilTargets,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('hash mismatch') || e.includes('Snapshot hash'))).toBe(true);
    });

    it('should detect when snapshot references wrong targets hash', async () => {
      const targetsUnsigned = await createTargetsMetadata(1, 30, []);
      const tKey = await importRoleKey(targetsKeys.seedHex, targetsKeys.pubBase64);
      const targetsMetadata = await signMetadata(targetsUnsigned, [tKey]);

      const snapshotUnsigned = await createSnapshotMetadata(1, 7, targetsMetadata);
      const sKey = await importRoleKey(snapshotKeys.seedHex, snapshotKeys.pubBase64);
      const snapshotMetadata = await signMetadata(snapshotUnsigned, [sKey]);

      // Tamper with targets
      const tamperedTargets = JSON.parse(JSON.stringify(targetsMetadata));
      tamperedTargets.signed.targets = {
        'servers/evil.json': {
          length: 10,
          hashes: { sha256: 'deadbeef' },
          custom: { serverId: 'evil' },
        },
      };

      const result = await validateMetadataChain({
        timestamp: {
          signed: {
            _type: 'timestamp',
            version: 1,
            expires: new Date(Date.now() + 86400000).toISOString(),
            meta: {
              'snapshot.json': {
                version: 1,
                hashes: { sha256: await hashMetadata(snapshotMetadata.signed) },
              },
            },
          },
        },
        snapshot: snapshotMetadata,
        targets: tamperedTargets,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('hash mismatch') || e.includes('Targets hash'))).toBe(true);
    });
  });
});

// --- Root Key Rotation Tests ---

describe('TUF Root Key Rotation', () => {
  it('should generate root v1 -> v2 with different keys', async () => {
    const oldRootKeys = await generateTestKeypair();
    const newRootKeys = await generateTestKeypair();
    const targetsKeys = await generateTestKeypair();
    const snapshotKeys = await generateTestKeypair();
    const timestampKeys = await generateTestKeypair();

    // Create root v1 with old key
    const rootV1 = await createRootMetadata(1, 365, {
      root: oldRootKeys.pubBase64,
      targets: targetsKeys.pubBase64,
      snapshot: snapshotKeys.pubBase64,
      timestamp: timestampKeys.pubBase64,
    });
    const oldRootKey = await importRoleKey(oldRootKeys.seedHex, oldRootKeys.pubBase64);
    const signedRootV1 = await signMetadata(rootV1, [oldRootKey]);

    // Verify root v1
    expect(await verifySignature(signedRootV1, oldRootKeys.pubBase64, oldRootKey.keyid)).toBe(true);
    const v1Result = validateRootMetadata(rootV1);
    expect(v1Result.valid).toBe(true);

    // Create root v2 with new key
    const rootV2 = await createRootMetadata(2, 365, {
      root: newRootKeys.pubBase64,
      targets: targetsKeys.pubBase64,
      snapshot: snapshotKeys.pubBase64,
      timestamp: timestampKeys.pubBase64,
    });

    // Sign v2 with BOTH old and new root keys (TUF spec requires this)
    const newRootKey = await importRoleKey(newRootKeys.seedHex, newRootKeys.pubBase64);
    const signedRootV2 = await signMetadata(rootV2, [oldRootKey, newRootKey]);

    // Verify v2 with old key (for existing clients)
    expect(await verifySignature(signedRootV2, oldRootKeys.pubBase64, oldRootKey.keyid)).toBe(true);

    // Verify v2 with new key (self-signed)
    expect(await verifySignature(signedRootV2, newRootKeys.pubBase64, newRootKey.keyid)).toBe(true);

    // Validate root v2
    const v2Result = validateRootMetadata(rootV2);
    expect(v2Result.valid).toBe(true);

    // Version increment check
    expect(rootV2.version).toBe(rootV1.version + 1);
  });

  it('should support multi-step rotation (v1 -> v2 -> v3)', async () => {
    const keyA = await generateTestKeypair();
    const keyB = await generateTestKeypair();
    const keyC = await generateTestKeypair();
    const delegatedKeys = await generateTestKeypair();

    // v1: signed by A
    const rootV1 = await createRootMetadata(1, 365, {
      root: keyA.pubBase64,
      targets: delegatedKeys.pubBase64,
      snapshot: delegatedKeys.pubBase64,
      timestamp: delegatedKeys.pubBase64,
    });
    const keyARole = await importRoleKey(keyA.seedHex, keyA.pubBase64);
    const signedV1 = await signMetadata(rootV1, [keyARole]);
    expect(await verifySignature(signedV1, keyA.pubBase64, keyARole.keyid)).toBe(true);

    // v2: signed by both A and B
    const rootV2 = await createRootMetadata(2, 365, {
      root: keyB.pubBase64,
      targets: delegatedKeys.pubBase64,
      snapshot: delegatedKeys.pubBase64,
      timestamp: delegatedKeys.pubBase64,
    });
    const keyBRole = await importRoleKey(keyB.seedHex, keyB.pubBase64);
    const signedV2 = await signMetadata(rootV2, [keyARole, keyBRole]);

    // Client trusting A can verify v2
    expect(await verifySignature(signedV2, keyA.pubBase64, keyARole.keyid)).toBe(true);
    // v2 is self-signed with B
    expect(await verifySignature(signedV2, keyB.pubBase64, keyBRole.keyid)).toBe(true);

    // v3: signed by both B and C (A is no longer trusted)
    const rootV3 = await createRootMetadata(3, 365, {
      root: keyC.pubBase64,
      targets: delegatedKeys.pubBase64,
      snapshot: delegatedKeys.pubBase64,
      timestamp: delegatedKeys.pubBase64,
    });
    const keyCRole = await importRoleKey(keyC.seedHex, keyC.pubBase64);
    const signedV3 = await signMetadata(rootV3, [keyBRole, keyCRole]);

    // Client now trusting B (after accepting v2) can verify v3
    expect(await verifySignature(signedV3, keyB.pubBase64, keyBRole.keyid)).toBe(true);
    // v3 is self-signed with C
    expect(await verifySignature(signedV3, keyC.pubBase64, keyCRole.keyid)).toBe(true);

    // Client trusting only A cannot verify v3 directly (must go through v2 first)
    expect(await verifySignature(signedV3, keyA.pubBase64, keyARole.keyid)).toBe(false);
  });
});

// --- Registration Signature Tests ---

describe('Registration Signature Verification', () => {
  it('should produce verifiable registration signatures', async () => {
    const serverKeys = await generateTestKeypair();

    const serverId = 'ed25519:test-server';
    const endpoint = 'wss://test.example.com:8443';
    const publicKey = serverKeys.pubBase64;

    // Create the registration payload (same format as server-registry-do.js)
    const payload = `zajel-server-registration|${serverId}|${endpoint}|${publicKey}`;

    // Sign with the server's private key
    const seed = new Uint8Array(serverKeys.seedHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const pkcs8Prefix = new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
      0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ]);
    const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
    pkcs8.set(pkcs8Prefix);
    pkcs8.set(seed, pkcs8Prefix.length);
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);

    const data = new TextEncoder().encode(payload);
    const signatureBuffer = await crypto.subtle.sign('Ed25519', privateKey, data);
    const sigBytes = new Uint8Array(signatureBuffer);
    let binary = '';
    for (let i = 0; i < sigBytes.length; i++) {
      binary += String.fromCharCode(sigBytes[i]);
    }
    const signatureBase64 = btoa(binary);

    // Verify with the public key (same as server-registry-do.js verifyRegistrationSignature)
    const keyBytes = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0));
    const spkiPrefix = new Uint8Array([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]);
    const spki = new Uint8Array(spkiPrefix.length + keyBytes.length);
    spki.set(spkiPrefix);
    spki.set(keyBytes, spkiPrefix.length);
    const verifyKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);

    const verifyData = new TextEncoder().encode(payload);
    const verifySignatureBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('Ed25519', verifyKey, verifySignatureBytes, verifyData);

    expect(isValid).toBe(true);
  });

  it('should reject signature from wrong key', async () => {
    const correctKeys = await generateTestKeypair();
    const wrongKeys = await generateTestKeypair();

    const payload = `zajel-server-registration|id|endpoint|${correctKeys.pubBase64}`;

    // Sign with wrong key
    const seed = new Uint8Array(wrongKeys.seedHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const pkcs8Prefix = new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
      0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ]);
    const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
    pkcs8.set(pkcs8Prefix);
    pkcs8.set(seed, pkcs8Prefix.length);
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);

    const data = new TextEncoder().encode(payload);
    const signatureBuffer = await crypto.subtle.sign('Ed25519', privateKey, data);
    const sigBytes = new Uint8Array(signatureBuffer);
    let binary = '';
    for (let i = 0; i < sigBytes.length; i++) {
      binary += String.fromCharCode(sigBytes[i]);
    }
    const signatureBase64 = btoa(binary);

    // Verify with CORRECT public key (should fail because signed with wrong key)
    const keyBytes = Uint8Array.from(atob(correctKeys.pubBase64), c => c.charCodeAt(0));
    const spkiPrefix = new Uint8Array([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]);
    const spki = new Uint8Array(spkiPrefix.length + keyBytes.length);
    spki.set(spkiPrefix);
    spki.set(keyBytes, spkiPrefix.length);
    const verifyKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);

    const verifyData = new TextEncoder().encode(payload);
    const verifySigBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('Ed25519', verifyKey, verifySigBytes, verifyData);

    expect(isValid).toBe(false);
  });
});
