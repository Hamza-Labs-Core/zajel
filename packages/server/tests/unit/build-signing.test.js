/**
 * Build Signing Verification Tests
 *
 * Tests for the build signature verification in the ServerRegistry Durable Object.
 * Covers:
 * - Ed25519 signature verification on registration
 * - Trusted key enforcement
 * - Heartbeat re-verification
 * - Graceful handling of unsigned builds
 * - Build info in anomalies endpoint
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';

// --- Test Ed25519 key generation using Web Crypto ---

async function generateTestKeypair() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);

  // Export private key to get seed
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);

  // Export public key as raw bytes
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  // SPKI for Ed25519: 12-byte prefix + 32-byte key
  const publicKeyBytes = spki.slice(-32);

  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBase64: btoa(String.fromCharCode(...publicKeyBytes)),
    seedHex: Array.from(seed, b => b.toString(16).padStart(2, '0')).join(''),
  };
}

async function signBuildHash(privateKey, buildHash) {
  const data = new TextEncoder().encode(buildHash);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// --- Mock infrastructure ---

class MockStorage {
  constructor() {
    this.data = new Map();
    this._alarm = null;
  }
  async get(key) { return this.data.get(key); }
  async put(key, value) { this.data.set(key, value); }
  async delete(key) {
    if (Array.isArray(key)) { for (const k of key) this.data.delete(k); }
    else { this.data.delete(key); }
  }
  async list({ prefix }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) results.set(key, value);
    }
    return results;
  }
  async getAlarm() { return this._alarm; }
  async setAlarm(time) { this._alarm = time; }
  clear() { this.data.clear(); this._alarm = null; }
}

class MockState {
  constructor() { this.storage = new MockStorage(); }
  blockConcurrencyWhile(fn) { return fn(); }
}

function createRequest(method, path, body = null, headers = {}) {
  const url = `https://test.workers.dev${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) options.body = JSON.stringify(body);
  return new Request(url, options);
}

describe('Build Signing Verification', () => {
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

  describe('Registration with Build Signature', () => {
    it('should verify a valid build signature on registration', async () => {
      const registry = new ServerRegistryDO(mockState, {});
      const buildHash = 'a'.repeat(64); // 64 hex chars
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:signed-server',
        endpoint: 'wss://signed.example.com',
        publicKey: 'test-key',
        region: 'eu-west',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
        buildVersion: '1.0.0',
      });

      const response = await registry.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Check server entry has buildVerified = true
      const entry = await mockState.storage.get('server:ed25519:signed-server');
      expect(entry.buildVerified).toBe(true);
      expect(entry.buildHash).toBe(buildHash);
      expect(entry.buildVersion).toBe('1.0.0');
    });

    it('should reject an invalid build signature', async () => {
      const registry = new ServerRegistryDO(mockState, {});
      const buildHash = 'a'.repeat(64);

      // Sign with the real key but tamper with the hash in the body
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:tampered-server',
        endpoint: 'wss://tampered.example.com',
        publicKey: 'test-key',
        buildHash: 'b'.repeat(64), // Different hash than what was signed
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200); // Registration still succeeds

      const entry = await mockState.storage.get('server:ed25519:tampered-server');
      expect(entry.buildVerified).toBe(false); // But build is NOT verified
    });

    it('should handle registration without build signing (unsigned build)', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:unsigned-server',
        endpoint: 'wss://unsigned.example.com',
        publicKey: 'test-key',
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);

      const entry = await mockState.storage.get('server:ed25519:unsigned-server');
      expect(entry.buildVerified).toBe(false);
      expect(entry.buildHash).toBeNull();
    });
  });

  describe('Trusted Key Enforcement', () => {
    it('should verify when signing key is in TRUSTED_BUILD_KEYS', async () => {
      const registry = new ServerRegistryDO(mockState, {
        TRUSTED_BUILD_KEYS: keypair.publicKeyBase64,
      });

      const buildHash = 'c'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:trusted-server',
        endpoint: 'wss://trusted.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);

      const entry = await mockState.storage.get('server:ed25519:trusted-server');
      expect(entry.buildVerified).toBe(true);
    });

    it('should reject when signing key is NOT in TRUSTED_BUILD_KEYS', async () => {
      const otherKey = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, {
        TRUSTED_BUILD_KEYS: otherKey.publicKeyBase64, // Different key
      });

      const buildHash = 'd'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:untrusted-server',
        endpoint: 'wss://untrusted.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64, // Valid sig, but untrusted key
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);

      const entry = await mockState.storage.get('server:ed25519:untrusted-server');
      expect(entry.buildVerified).toBe(false); // Signature valid but key untrusted
    });

    it('should accept any valid signature when TRUSTED_BUILD_KEYS is not configured', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const buildHash = 'e'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:any-key-server',
        endpoint: 'wss://anykey.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      const entry = await mockState.storage.get('server:ed25519:any-key-server');
      expect(entry.buildVerified).toBe(true);
    });

    it('should support multiple trusted keys (comma-separated)', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, {
        TRUSTED_BUILD_KEYS: `${keypair.publicKeyBase64},${key2.publicKeyBase64}`,
      });

      const buildHash = 'f'.repeat(64);
      const signature = await signBuildHash(key2.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:multi-trust-server',
        endpoint: 'wss://multi.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: key2.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      const entry = await mockState.storage.get('server:ed25519:multi-trust-server');
      expect(entry.buildVerified).toBe(true);
    });
  });

  describe('Heartbeat Build Re-verification', () => {
    it('should re-verify build signature on heartbeat', async () => {
      const registry = new ServerRegistryDO(mockState, {});
      const buildHash = 'abcd'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      // Register first
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:heartbeat-verify',
        endpoint: 'wss://hb.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      // Heartbeat with same build
      const hbResponse = await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-verify',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      expect(hbResponse.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:heartbeat-verify');
      expect(entry.buildVerified).toBe(true);
    });

    it('should detect tampered signature in heartbeat', async () => {
      const registry = new ServerRegistryDO(mockState, {});
      const buildHash = 'dead'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      // Register with valid build
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:tamper-detect',
        endpoint: 'wss://td.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      let entry = await mockState.storage.get('server:ed25519:tamper-detect');
      expect(entry.buildVerified).toBe(true);

      // Heartbeat with tampered signature
      const tamperedSig = btoa('x'.repeat(64));
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:tamper-detect',
        connections: 5,
        relayConnections: 3,
        signalingConnections: 2,
        buildHash,
        buildSignature: tamperedSig,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      entry = await mockState.storage.get('server:ed25519:tamper-detect');
      expect(entry.buildVerified).toBe(false); // No longer verified
    });
  });

  describe('Build Info in Anomalies Endpoint', () => {
    it('should include build info in anomalies response', async () => {
      const registry = new ServerRegistryDO(mockState, {});
      const buildHash = '1234'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      // Register with build signing
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:build-info-server',
        endpoint: 'wss://info.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
        buildVersion: '2.0.0',
      }));

      // Heartbeat to generate anomaly data
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:build-info-server',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
      }));

      // Fetch anomalies
      const response = await registry.fetch(createRequest('GET', '/servers/anomalies'));
      const data = await response.json();

      expect(data.servers).toHaveLength(1);
      expect(data.servers[0].buildVerified).toBe(true);
      expect(data.servers[0].buildHash).toBe(buildHash);
      expect(data.servers[0].buildVersion).toBe('2.0.0');
    });

    it('should show buildVerified=false for unsigned servers', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      // Register without build signing
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:no-build-server',
        endpoint: 'wss://noinfo.example.com',
        publicKey: 'test-key',
      }));

      // Heartbeat
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:no-build-server',
        connections: 5,
        relayConnections: 3,
        signalingConnections: 2,
      }));

      const response = await registry.fetch(createRequest('GET', '/servers/anomalies'));
      const data = await response.json();

      expect(data.servers[0].buildVerified).toBe(false);
      expect(data.servers[0].buildHash).toBeNull();
    });
  });

  describe('Trusted Keys via CI (POST /servers/trusted-keys)', () => {
    it('should upload trusted keys with CI_UPLOAD_SECRET', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer ci-secret-123',
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.keys).toHaveLength(1);
      expect(data.keys[0]).toBe(keypair.publicKeyBase64);
    });

    it('should reject without CI_UPLOAD_SECRET', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }));

      expect(response.status).toBe(401);
    });

    it('should reject with wrong secret', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer wrong-secret',
      }));

      expect(response.status).toBe(401);
    });

    it('should return 503 when CI_UPLOAD_SECRET is not configured', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer anything',
      }));

      expect(response.status).toBe(503);
    });

    it('should support addKeys to append without replacing', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // First: set initial key
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));

      // Then: addKeys to append
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        addKeys: [key2.publicKeyBase64],
      }, authHeaders));

      const data = await response.json();
      expect(data.keys).toHaveLength(2);
      expect(data.keys).toContain(keypair.publicKeyBase64);
      expect(data.keys).toContain(key2.publicKeyBase64);
    });

    it('should support removeKeys to revoke a key', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Set two keys
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64, key2.publicKeyBase64],
      }, authHeaders));

      // Remove one
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        removeKeys: [keypair.publicKeyBase64],
      }, authHeaders));

      const data = await response.json();
      expect(data.keys).toHaveLength(1);
      expect(data.keys[0]).toBe(key2.publicKeyBase64);
    });

    it('should deduplicate keys', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64, keypair.publicKeyBase64, keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer ci-secret-123',
      }));

      const data = await response.json();
      expect(data.keys).toHaveLength(1);
    });

    it('should return 400 if no keys/addKeys/removeKeys provided', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        something: 'else',
      }, {
        Authorization: 'Bearer ci-secret-123',
      }));

      expect(response.status).toBe(400);
    });
  });

  describe('GET /servers/trusted-keys', () => {
    it('should return 503 when CI_UPLOAD_SECRET is not configured', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys'));
      expect(response.status).toBe(503);
    });

    it('should return 401 without auth', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys'));
      expect(response.status).toBe(401);
    });

    it('should return 401 with wrong secret', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, {
        Authorization: 'Bearer wrong-secret',
      }));
      expect(response.status).toBe(401);
    });

    it('should return keys uploaded by CI when authenticated', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Upload keys
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));

      // Read them back (with auth)
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.keys).toHaveLength(1);
      expect(data.keys[0]).toBe(keypair.publicKeyBase64);
      expect(data.updatedAt).toBeTypeOf('number');
    });
  });

  describe('DO Storage Keys Override Env Var', () => {
    it('should use DO-stored keys over env var when both exist', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
        // Env var has key2
        TRUSTED_BUILD_KEYS: key2.publicKeyBase64,
      });

      // CI uploads keypair (different from env var)
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer ci-secret-123',
      }));

      const buildHash = 'a'.repeat(64);

      // Sign with keypair (in DO storage, NOT in env var)
      const signature = await signBuildHash(keypair.privateKey, buildHash);
      const response = await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:do-key-server',
        endpoint: 'wss://do.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:do-key-server');
      expect(entry.buildVerified).toBe(true); // DO key is trusted

      // Sign with key2 (in env var, NOT in DO storage)
      const sig2 = await signBuildHash(key2.privateKey, buildHash);
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:env-key-server',
        endpoint: 'wss://env.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: sig2,
        buildSigningKey: key2.publicKeyBase64,
      }));

      const entry2 = await mockState.storage.get('server:ed25519:env-key-server');
      expect(entry2.buildVerified).toBe(false); // Env key is ignored when DO has keys
    });

    it('should fall back to env var when DO storage is empty', async () => {
      const registry = new ServerRegistryDO(mockState, {
        TRUSTED_BUILD_KEYS: keypair.publicKeyBase64,
      });

      const buildHash = 'b'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:env-fallback-server',
        endpoint: 'wss://envfb.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:env-fallback-server');
      expect(entry.buildVerified).toBe(true);
    });
  });

  describe('Encrypted Storage', () => {
    it('should store keys encrypted (not plaintext) in DO storage', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer ci-secret-123',
      }));

      // Read raw storage — should be encrypted envelope, not plaintext
      const raw = await mockState.storage.get('trusted_build_keys');
      expect(raw.encrypted).toBe(true);
      expect(raw.iv).toBeTypeOf('string');
      expect(raw.data).toBeTypeOf('string');
      // Should NOT have plaintext keys array
      expect(raw.keys).toBeUndefined();
      // The ciphertext should not contain the key in plaintext
      expect(raw.data).not.toContain(keypair.publicKeyBase64);
    });

    it('should decrypt and return correct keys via GET', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Upload
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));

      // GET should decrypt and return plaintext keys
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.keys).toEqual([keypair.publicKeyBase64]);
      expect(data.updatedAt).toBeTypeOf('number');
    });

    it('should read legacy plaintext keys (migration path)', async () => {
      // Simulate legacy plaintext data in storage
      await mockState.storage.put('trusted_build_keys', {
        keys: [keypair.publicKeyBase64],
        updatedAt: 1000000,
      });

      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      // Should read legacy plaintext keys via build verification
      const buildHash = 'a'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:legacy-server',
        endpoint: 'wss://legacy.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:legacy-server');
      expect(entry.buildVerified).toBe(true);
    });

    it('should read legacy plaintext keys via GET endpoint', async () => {
      // Simulate legacy plaintext data in storage
      await mockState.storage.put('trusted_build_keys', {
        keys: [keypair.publicKeyBase64],
        updatedAt: 1000000,
      });

      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, {
        Authorization: 'Bearer ci-secret-123',
      }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.keys).toEqual([keypair.publicKeyBase64]);
      expect(data.updatedAt).toBe(1000000);
    });

    it('should use encrypted DO keys for build verification', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      // Upload key via CI (stored encrypted)
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer ci-secret-123',
      }));

      // Register with matching key — should be verified
      const buildHash = 'c'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:enc-verify-server',
        endpoint: 'wss://enc.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:enc-verify-server');
      expect(entry.buildVerified).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed signature gracefully', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:malformed-sig',
        endpoint: 'wss://bad.example.com',
        publicKey: 'test-key',
        buildHash: 'abc123',
        buildSignature: 'not-valid-base64!!!',
        buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200); // Should not crash

      const entry = await mockState.storage.get('server:ed25519:malformed-sig');
      expect(entry.buildVerified).toBe(false);
    });

    it('should handle malformed public key gracefully', async () => {
      const registry = new ServerRegistryDO(mockState, {});
      const buildHash = 'a'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:malformed-key',
        endpoint: 'wss://bad2.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: 'too-short', // Not a valid 32-byte key
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);

      const entry = await mockState.storage.get('server:ed25519:malformed-key');
      expect(entry.buildVerified).toBe(false);
    });

    it('should handle partial build fields (missing signature)', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:partial-build',
        endpoint: 'wss://partial.example.com',
        publicKey: 'test-key',
        buildHash: 'a'.repeat(64),
        // Missing buildSignature and buildSigningKey
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);

      const entry = await mockState.storage.get('server:ed25519:partial-build');
      expect(entry.buildVerified).toBe(false);
    });
  });
});
