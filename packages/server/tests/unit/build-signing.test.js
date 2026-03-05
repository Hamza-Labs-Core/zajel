/**
 * Build Signing Verification Tests
 *
 * Tests for the build signature verification in the ServerRegistry Durable Object.
 * Covers:
 * - Ed25519 signature verification on registration
 * - Trusted key enforcement (deny-default when no keys configured)
 * - Heartbeat re-verification
 * - Graceful handling of unsigned builds
 * - Build info in anomalies endpoint
 * - Audit logging for no-keys-configured scenario
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';

// --- Test Ed25519 key generation using Web Crypto ---

async function generateTestKeypair() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
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

// --- Shared test constants ---
const TEST_SERVER_SECRET = 'test-registry-secret';

function defaultEnv(overrides = {}) {
  return {
    SERVER_REGISTRY_SECRET: TEST_SERVER_SECRET,
    REPLAY_GRACE_MODE: 'true',
    ...overrides,
  };
}

// --- Mock infrastructure ---

class MockStorage {
  constructor() {
    this.data = new Map();
    this._alarm = null;
  }
  async get(key) { return this.data.get(key); }
  async put(keyOrMap, value) {
    if (keyOrMap instanceof Map) {
      for (const [k, v] of keyOrMap) { this.data.set(k, v); }
    } else {
      this.data.set(keyOrMap, value);
    }
  }
  async delete(key) {
    if (Array.isArray(key)) { for (const k of key) this.data.delete(k); }
    else { this.data.delete(key); }
  }
  async list({ prefix, start, limit }) {
    const results = new Map();
    const sortedKeys = [...this.data.keys()].sort();
    for (const key of sortedKeys) {
      if (typeof key !== 'string') continue;
      if (start && key < start) continue;
      if (key.startsWith(prefix) && results.size < (limit || Infinity)) {
        results.set(key, this.data.get(key));
      }
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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_SERVER_SECRET}`,
      'CF-Connecting-IP': '127.0.0.1',
      ...headers,
    },
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  describe('Registration with Build Signature', () => {
    it('should verify a valid build signature on registration', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const buildHash = 'a'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:signed-server', endpoint: 'wss://signed.example.com',
        publicKey: 'test-key', region: 'eu-west',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64, buildVersion: '1.0.0',
      });

      const response = await registry.fetch(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      const entry = await mockState.storage.get('server:ed25519:signed-server');
      expect(entry.buildVerified).toBe(true);
      expect(entry.buildHash).toBe(buildHash);
      expect(entry.buildVersion).toBe('1.0.0');
    });

    it('should reject an invalid build signature', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const buildHash = 'a'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:tampered-server', endpoint: 'wss://tampered.example.com',
        publicKey: 'test-key', buildHash: 'b'.repeat(64),
        buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:tampered-server');
      expect(entry.buildVerified).toBe(false);
    });

    it('should handle registration without build signing (unsigned build)', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:unsigned-server', endpoint: 'wss://unsigned.example.com', publicKey: 'test-key',
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
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const buildHash = 'c'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:trusted-server', endpoint: 'wss://trusted.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:trusted-server');
      expect(entry.buildVerified).toBe(true);
    });

    it('should reject when signing key is NOT in TRUSTED_BUILD_KEYS', async () => {
      const otherKey = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: otherKey.publicKeyBase64 }));
      const buildHash = 'd'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:untrusted-server', endpoint: 'wss://untrusted.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:untrusted-server');
      expect(entry.buildVerified).toBe(false);
    });

    it('should deny when no trusted keys configured (deny-default)', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      const buildHash = 'e'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:any-key-server', endpoint: 'wss://anykey.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      const entry = await mockState.storage.get('server:ed25519:any-key-server');
      expect(entry.buildVerified).toBe(false);
      expect(response.status).toBe(200);
    });

    it('should not verify build when no build signing fields provided', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:no-fields-server', endpoint: 'wss://nofields.example.com', publicKey: 'test-key',
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:no-fields-server');
      expect(entry.buildVerified).toBe(false);
      expect(entry.buildHash).toBeNull();
    });

    it('should log audit warning when no trusted keys configured', async () => {
      const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      registry.logger = mockLogger;

      const buildHash = 'g'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:audit-log-server', endpoint: 'wss://audit.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[audit] Build verification skipped: no trusted keys configured',
        expect.objectContaining({ action: 'build_verify_no_keys', serverId: 'ed25519:audit-log-server' })
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[audit] Build signature checked',
        expect.objectContaining({ action: 'build_verify', buildVerified: false, keyTrusted: false })
      );
    });

    it('should support multiple trusted keys (comma-separated)', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, defaultEnv({
        TRUSTED_BUILD_KEYS: `${keypair.publicKeyBase64},${key2.publicKeyBase64}`,
      }));
      const buildHash = 'f'.repeat(64);
      const signature = await signBuildHash(key2.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:multi-trust-server', endpoint: 'wss://multi.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: key2.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      const entry = await mockState.storage.get('server:ed25519:multi-trust-server');
      expect(entry.buildVerified).toBe(true);
    });
  });

  describe('Heartbeat Build Re-verification', () => {
    it('should re-verify build signature on heartbeat', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const buildHash = 'abcd'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:heartbeat-verify', endpoint: 'wss://hb.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      const hbResponse = await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-verify', connections: 10, relayConnections: 5, signalingConnections: 5,
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      expect(hbResponse.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:heartbeat-verify');
      expect(entry.buildVerified).toBe(true);
    });

    it('should detect tampered signature in heartbeat', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const buildHash = 'dead'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:tamper-detect', endpoint: 'wss://td.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      let entry = await mockState.storage.get('server:ed25519:tamper-detect');
      expect(entry.buildVerified).toBe(true);

      const tamperedSig = btoa('x'.repeat(64));
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:tamper-detect', connections: 5, relayConnections: 3, signalingConnections: 2,
        buildHash, buildSignature: tamperedSig, buildSigningKey: keypair.publicKeyBase64,
      }));

      entry = await mockState.storage.get('server:ed25519:tamper-detect');
      expect(entry.buildVerified).toBe(false);
    });

    it('should deny in heartbeat when no trusted keys configured', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      const buildHash = 'hhhh'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:heartbeat-deny', endpoint: 'wss://hbdeny.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      let entry = await mockState.storage.get('server:ed25519:heartbeat-deny');
      expect(entry.buildVerified).toBe(false);

      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-deny', connections: 10, relayConnections: 5, signalingConnections: 5,
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      entry = await mockState.storage.get('server:ed25519:heartbeat-deny');
      expect(entry.buildVerified).toBe(false);
    });

    it('should re-verify to false when trusted keys are removed', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const ciAuth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, ciAuth));

      const buildHash = 'iiii'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:reverify-server', endpoint: 'wss://reverify.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      let entry = await mockState.storage.get('server:ed25519:reverify-server');
      expect(entry.buildVerified).toBe(true);

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [] }, ciAuth));

      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:reverify-server', connections: 5, relayConnections: 3, signalingConnections: 2,
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      entry = await mockState.storage.get('server:ed25519:reverify-server');
      expect(entry.buildVerified).toBe(false);
    });
  });

  describe('Build Info in Anomalies Endpoint', () => {
    it('should include build info in anomalies response', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const buildHash = '1234'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:build-info-server', endpoint: 'wss://info.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64, buildVersion: '2.0.0',
      }));

      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:build-info-server', connections: 10, relayConnections: 5, signalingConnections: 5,
      }));

      const response = await registry.fetch(createRequest('GET', '/servers/anomalies'));
      const data = await response.json();

      expect(data.servers).toHaveLength(1);
      expect(data.servers[0].buildVerified).toBe(true);
      expect(data.servers[0].buildHash).toBe(buildHash);
      expect(data.servers[0].buildVersion).toBe('2.0.0');
    });

    it('should show buildVerified=false for unsigned servers', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:no-build-server', endpoint: 'wss://noinfo.example.com', publicKey: 'test-key',
      }));

      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:no-build-server', connections: 5, relayConnections: 3, signalingConnections: 2,
      }));

      const response = await registry.fetch(createRequest('GET', '/servers/anomalies'));
      const data = await response.json();
      expect(data.servers[0].buildVerified).toBe(false);
      expect(data.servers[0].buildHash).toBeNull();
    });
  });

  describe('Trusted Keys via CI (POST /servers/trusted-keys)', () => {
    it('should upload trusted keys with CI_UPLOAD_SECRET', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer ci-secret-123' }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.keys).toHaveLength(1);
      expect(data.keys[0]).toBe(keypair.publicKeyBase64);
    });

    it('should reject without CI_UPLOAD_SECRET', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }));
      expect(response.status).toBe(401);
    });

    it('should reject with wrong secret', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer wrong-secret' }));
      expect(response.status).toBe(401);
    });

    it('should return 503 when CI_UPLOAD_SECRET is not configured', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer anything' }));
      expect(response.status).toBe(503);
    });

    it('should support addKeys to append without replacing', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, auth));
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', { addKeys: [key2.publicKeyBase64] }, auth));

      const data = await response.json();
      expect(data.keys).toHaveLength(2);
      expect(data.keys).toContain(keypair.publicKeyBase64);
      expect(data.keys).toContain(key2.publicKeyBase64);
    });

    it('should support removeKeys to revoke a key', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64, key2.publicKeyBase64] }, auth));
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', { removeKeys: [keypair.publicKeyBase64] }, auth));

      const data = await response.json();
      expect(data.keys).toHaveLength(1);
      expect(data.keys[0]).toBe(key2.publicKeyBase64);
    });

    it('should deduplicate keys', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64, keypair.publicKeyBase64, keypair.publicKeyBase64],
      }, { Authorization: 'Bearer ci-secret-123' }));

      const data = await response.json();
      expect(data.keys).toHaveLength(1);
    });

    it('should return 400 if no keys/addKeys/removeKeys provided', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        something: 'else',
      }, { Authorization: 'Bearer ci-secret-123' }));
      expect(response.status).toBe(400);
    });
  });

  describe('GET /servers/trusted-keys', () => {
    it('should return 503 when CI_UPLOAD_SECRET is not configured', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys'));
      expect(response.status).toBe(503);
    });

    it('should return 401 without auth', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys'));
      expect(response.status).toBe(401);
    });

    it('should return 401 with wrong secret', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, { Authorization: 'Bearer wrong-secret' }));
      expect(response.status).toBe(401);
    });

    it('should return keys uploaded by CI when authenticated', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, auth));
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, auth));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.keys).toHaveLength(1);
      expect(data.keys[0]).toBe(keypair.publicKeyBase64);
      expect(data.updatedAt).toBeTypeOf('number');
    });
  });

  describe('Audit Logging for Key Reads', () => {
    it('should log successful key read with audit trail', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const registry = new ServerRegistryDO(mockState, defaultEnv({
        CI_UPLOAD_SECRET: 'ci-secret-123',
      }));

      // Replace logger with mock
      registry.logger = mockLogger;

      const authHeaders = {
        Authorization: 'Bearer ci-secret-123',
        'CF-Connecting-IP': '203.0.113.45',
      };

      // Upload keys
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64, 'another-key-base64'],
      }, authHeaders));

      // Clear previous log calls
      mockLogger.info.mockClear();

      // Read keys
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.keys).toHaveLength(2);

      // Verify audit log was called
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[audit] Trusted build keys read',
        expect.objectContaining({
          action: 'trusted_keys_read',
          keyCount: 2,
          ip: '203.0.113.45',
          updatedAt: expect.any(Number),
        })
      );
    });

    it('should log keyCount: 0 when no keys are stored', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const registry = new ServerRegistryDO(mockState, defaultEnv({
        CI_UPLOAD_SECRET: 'ci-secret-123',
      }));

      registry.logger = mockLogger;

      const authHeaders = {
        Authorization: 'Bearer ci-secret-123',
        'CF-Connecting-IP': '203.0.113.45',
      };

      // Read keys without uploading any
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.keys).toHaveLength(0);

      // Verify audit log shows keyCount: 0
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[audit] Trusted build keys read',
        expect.objectContaining({
          action: 'trusted_keys_read',
          keyCount: 0,
          ip: '203.0.113.45',
        })
      );
    });

    it('should still log failed authentication attempts (regression test)', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const registry = new ServerRegistryDO(mockState, defaultEnv({
        CI_UPLOAD_SECRET: 'ci-secret-123',
      }));

      registry.logger = mockLogger;

      // Try to read keys with wrong auth
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, {
        Authorization: 'Bearer wrong-secret',
        'CF-Connecting-IP': '198.51.100.77',
      }));

      expect(response.status).toBe(401);

      // Verify failed auth was logged (existing behavior)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[audit] Unauthorized trusted-keys read attempt',
        expect.objectContaining({
          action: 'trusted_keys_read_failed',
          ip: '198.51.100.77',
        })
      );

      // Verify success log was NOT called
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[audit] Trusted build keys read',
        expect.anything()
      );
    });

    it('should log decryption failure when wrong secret is used', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const registry1 = new ServerRegistryDO(mockState, defaultEnv({
        CI_UPLOAD_SECRET: 'original-secret-123',
      }));

      // Upload encrypted keys with original secret
      await registry1.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer original-secret-123',
      }));

      // Create new registry instance with DIFFERENT secret (simulating secret rotation)
      const registry2 = new ServerRegistryDO(mockState, defaultEnv({
        CI_UPLOAD_SECRET: 'new-secret-456',
      }));

      registry2.logger = mockLogger;

      // Try to read keys with new secret (should fail to decrypt)
      const response = await registry2.fetch(createRequest('GET', '/servers/trusted-keys', null, {
        Authorization: 'Bearer new-secret-456',
        'CF-Connecting-IP': '203.0.113.45',
      }));

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe('Failed to decrypt stored keys');

      // Verify decryption failure was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[audit] Failed to decrypt trusted build keys',
        expect.objectContaining({
          action: 'trusted_keys_decrypt_failed',
          ip: '203.0.113.45',
          error: expect.any(String),
        })
      );

      // Verify success log was NOT called
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[audit] Trusted build keys read',
        expect.anything()
      );
    });

    it('should log audit trail for legacy plaintext key reads', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      // Store keys directly in plaintext format (legacy migration path)
      await mockState.storage.put('trusted_build_keys', {
        keys: [keypair.publicKeyBase64],
        updatedAt: 1000000,
      });

      const registry = new ServerRegistryDO(mockState, defaultEnv({
        CI_UPLOAD_SECRET: 'ci-secret-123',
      }));

      registry.logger = mockLogger;

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, {
        Authorization: 'Bearer ci-secret-123',
        'CF-Connecting-IP': '10.0.0.1',
      }));

      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.keys).toEqual([keypair.publicKeyBase64]);

      // Verify audit log fires for legacy plaintext path too
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[audit] Trusted build keys read',
        expect.objectContaining({
          action: 'trusted_keys_read',
          keyCount: 1,
          updatedAt: 1000000,
          ip: '10.0.0.1',
        })
      );
    });
  });

  describe('DO Storage Keys Override Env Var', () => {
    it('should use DO-stored keys over env var when both exist', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, defaultEnv({
        CI_UPLOAD_SECRET: 'ci-secret-123', TRUSTED_BUILD_KEYS: key2.publicKeyBase64,
      }));

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer ci-secret-123' }));

      const buildHash = 'a'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:do-key-server', endpoint: 'wss://do.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:do-key-server');
      expect(entry.buildVerified).toBe(true);

      const sig2 = await signBuildHash(key2.privateKey, buildHash);
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:env-key-server', endpoint: 'wss://env.example.com', publicKey: 'test-key',
        buildHash, buildSignature: sig2, buildSigningKey: key2.publicKeyBase64,
      }));

      const entry2 = await mockState.storage.get('server:ed25519:env-key-server');
      expect(entry2.buildVerified).toBe(false);
    });

    it('should fall back to env var when DO storage is empty', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const buildHash = 'b'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:env-fallback-server', endpoint: 'wss://envfb.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:env-fallback-server');
      expect(entry.buildVerified).toBe(true);
    });
  });

  describe('Encrypted Storage', () => {
    it('should store keys encrypted (not plaintext) in DO storage', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer ci-secret-123' }));

      const raw = await mockState.storage.get('trusted_build_keys');
      expect(raw.encrypted).toBe(true);
      expect(raw.iv).toBeTypeOf('string');
      expect(raw.data).toBeTypeOf('string');
      expect(raw.keys).toBeUndefined();
      expect(raw.data).not.toContain(keypair.publicKeyBase64);
    });

    it('should decrypt and return correct keys via GET', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, auth));

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, auth));
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.keys).toEqual([keypair.publicKeyBase64]);
      expect(data.updatedAt).toBeTypeOf('number');
    });

    it('should read legacy plaintext keys (migration path)', async () => {
      await mockState.storage.put('trusted_build_keys', { keys: [keypair.publicKeyBase64], updatedAt: 1000000 });
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));

      const buildHash = 'a'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:legacy-server', endpoint: 'wss://legacy.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:legacy-server');
      expect(entry.buildVerified).toBe(true);
    });

    it('should read legacy plaintext keys via GET endpoint', async () => {
      await mockState.storage.put('trusted_build_keys', { keys: [keypair.publicKeyBase64], updatedAt: 1000000 });
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, { Authorization: 'Bearer ci-secret-123' }));
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.keys).toEqual([keypair.publicKeyBase64]);
      expect(data.updatedAt).toBe(1000000);
    });

    it('should use encrypted DO keys for build verification', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer ci-secret-123' }));

      const buildHash = 'c'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:enc-verify-server', endpoint: 'wss://enc.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: keypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:enc-verify-server');
      expect(entry.buildVerified).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed signature gracefully', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:malformed-sig', endpoint: 'wss://bad.example.com', publicKey: 'test-key',
        buildHash: 'abc123', buildSignature: 'not-valid-base64!!!', buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:malformed-sig');
      expect(entry.buildVerified).toBe(false);
    });

    it('should handle malformed public key gracefully', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 }));
      const buildHash = 'a'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:malformed-key', endpoint: 'wss://bad2.example.com', publicKey: 'test-key',
        buildHash, buildSignature: signature, buildSigningKey: 'too-short',
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:malformed-key');
      expect(entry.buildVerified).toBe(false);
    });

    it('should handle partial build fields (missing signature)', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:partial-build', endpoint: 'wss://partial.example.com', publicKey: 'test-key',
        buildHash: 'a'.repeat(64),
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const entry = await mockState.storage.get('server:ed25519:partial-build');
      expect(entry.buildVerified).toBe(false);
    });
  });

  describe('Transparency Log for Key Management', () => {
    it('should log key updates to transparency log', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, auth));
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log', null, auth));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].action).toBe('trusted_keys_updated');
      expect(data.entries[0].mode).toBe('replace');
      expect(data.entries[0].newKeyCount).toBe(1);
      expect(data.entries[0].previousHash).toBe('genesis');
    });

    it('should log failed auth attempts', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, { Authorization: 'Bearer wrong-secret' }));
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log', null, { Authorization: 'Bearer ci-secret-123' }));
      const data = await response.json();

      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].action).toBe('trusted_keys_update_failed');
      expect(data.entries[0].reason).toBe('unauthorized');
    });

    it('should chain multiple operations in audit log', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, auth));
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { addKeys: [key2.publicKeyBase64] }, auth));
      await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, auth));

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log', null, auth));
      const data = await response.json();

      expect(data.entries).toHaveLength(3);
      expect(data.entries[0].sequence).toBe(1);
      expect(data.entries[1].sequence).toBe(2);
      expect(data.entries[2].sequence).toBe(3);
      expect(data.entries[1].previousHash).toBe(data.entries[0].entryHash);
      expect(data.entries[2].previousHash).toBe(data.entries[1].entryHash);
    });

    it('should support pagination with from parameter', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, auth));
      await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, auth));
      await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, auth));

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log?from=2', null, auth));
      const data = await response.json();
      expect(data.entries).toHaveLength(2);
      expect(data.entries[0].sequence).toBe(2);
    });

    it('should verify log integrity on request', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, auth));
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log?verify=true', null, auth));
      const data = await response.json();

      expect(data.verification).toBeTruthy();
      expect(data.verification.valid).toBe(true);
      expect(data.verification.entries).toBeGreaterThan(0);
    });

    it('should include key deltas in audit log', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64] }, auth));
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { addKeys: [key2.publicKeyBase64] }, auth));

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log', null, auth));
      const data = await response.json();

      const addEntry = data.entries.find(e => e.mode === 'add');
      expect(addEntry.addedKeys).toContain(key2.publicKeyBase64);
      expect(addEntry.removedKeys).toEqual([]);
    });

    it('should include remove mode key deltas in audit log', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const auth = { Authorization: 'Bearer ci-secret-123' };

      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [keypair.publicKeyBase64, key2.publicKeyBase64] }, auth));
      const key3 = await generateTestKeypair();
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', { keys: [key2.publicKeyBase64, key3.publicKeyBase64] }, auth));

      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log', null, auth));
      const data = await response.json();

      const replaceEntries = data.entries.filter(e => e.mode === 'replace');
      const replaceEntry = replaceEntries[replaceEntries.length - 1];
      expect(replaceEntry.addedKeys).toContain(key3.publicKeyBase64);
      expect(replaceEntry.removedKeys).toContain(keypair.publicKeyBase64);
      expect(replaceEntry.addedKeys).not.toContain(key2.publicKeyBase64);
      expect(replaceEntry.removedKeys).not.toContain(key2.publicKeyBase64);
    });

    it('should reject audit log access without auth', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv({ CI_UPLOAD_SECRET: 'ci-secret-123' }));
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log'));
      expect(response.status).toBe(401);
    });

    it('should return 503 when CI_UPLOAD_SECRET not configured', async () => {
      const registry = new ServerRegistryDO(mockState, defaultEnv());
      const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys/audit-log'));
      expect(response.status).toBe(503);
    });
  });
});
