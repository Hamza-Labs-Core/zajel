/**
 * Tests for Ed25519 bootstrap response signing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hexToBytes, importSigningKey, signPayload } from '../../src/crypto/signing.js';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import worker from '../../src/index.js';

// --- Signing utility tests ---

describe('Signing utilities', () => {
  describe('hexToBytes', () => {
    it('should convert hex string to Uint8Array', () => {
      const result = hexToBytes('deadbeef');
      expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it('should handle all-zeros', () => {
      const result = hexToBytes('0000');
      expect(result).toEqual(new Uint8Array([0, 0]));
    });

    it('should handle 32-byte key seed', () => {
      const hex = 'a'.repeat(64);
      const result = hexToBytes(hex);
      expect(result.length).toBe(32);
      expect(result.every((b) => b === 0xaa)).toBe(true);
    });
  });

  describe('importSigningKey + signPayload', () => {
    let keyPair;
    let seedHex;

    beforeEach(async () => {
      // Generate a test keypair
      keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
      const seed = pkcs8.slice(-32);
      seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
    });

    it('should import a key from hex seed', async () => {
      const key = await importSigningKey(seedHex);
      expect(key).toBeDefined();
      expect(key.type).toBe('private');
    });

    it('should produce a valid base64 signature', async () => {
      const key = await importSigningKey(seedHex);
      const sig = await signPayload(key, 'test payload');

      // Should be valid base64
      expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);

      // Ed25519 signature is 64 bytes -> base64 is 88 chars
      expect(atob(sig).length).toBe(64);
    });

    it('should produce a signature verifiable with the original public key', async () => {
      const key = await importSigningKey(seedHex);
      const payload = '{"servers":[],"timestamp":1234567890}';
      const sigBase64 = await signPayload(key, payload);

      // Verify with the original public key
      const sigBytes = Uint8Array.from(atob(sigBase64), (c) => c.charCodeAt(0));
      const data = new TextEncoder().encode(payload);
      const valid = await crypto.subtle.verify('Ed25519', keyPair.publicKey, sigBytes, data);

      expect(valid).toBe(true);
    });

    it('should reject tampered payload', async () => {
      const key = await importSigningKey(seedHex);
      const payload = '{"servers":[],"timestamp":1234567890}';
      const sigBase64 = await signPayload(key, payload);

      const sigBytes = Uint8Array.from(atob(sigBase64), (c) => c.charCodeAt(0));
      const tampered = new TextEncoder().encode(payload + 'x');
      const valid = await crypto.subtle.verify('Ed25519', keyPair.publicKey, sigBytes, tampered);

      expect(valid).toBe(false);
    });
  });
});

// --- Integration: GET /servers with signing ---

class MockStorage {
  constructor() {
    this.data = new Map();
  }
  async get(key) {
    return this.data.get(key);
  }
  async put(key, value) {
    this.data.set(key, value);
  }
  async delete(key) {
    this.data.delete(key);
  }
  async list({ prefix }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) results.set(key, value);
    }
    return results;
  }
  clear() {
    this.data.clear();
  }
}

class MockState {
  constructor() {
    this.storage = new MockStorage();
  }
}

class MockDurableObjectStub {
  constructor(doInstance) {
    this.doInstance = doInstance;
  }
  async fetch(request) {
    return this.doInstance.fetch(request);
  }
}

describe('GET /servers signing integration', () => {
  let mockState;
  let serverRegistry;
  let keyPair;
  let seedHex;

  beforeEach(async () => {
    mockState = new MockState();
    serverRegistry = new ServerRegistryDO(mockState, {});

    // Generate test keypair
    keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    const seed = pkcs8.slice(-32);
    seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');

    vi.useFakeTimers();
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  function createEnv(signingKey = null) {
    return {
      SERVER_REGISTRY: {
        idFromName: () => 'mock-id',
        get: () => new MockDurableObjectStub(serverRegistry),
      },
      ...(signingKey ? { BOOTSTRAP_SIGNING_KEY: signingKey } : {}),
    };
  }

  it('should include X-Bootstrap-Signature header when key is set', async () => {
    const env = createEnv(seedHex);
    const request = new Request('https://test.workers.dev/servers');
    const response = await worker.fetch(request, env);

    expect(response.headers.get('X-Bootstrap-Signature')).not.toBeNull();
  });

  it('should include Access-Control-Expose-Headers', async () => {
    const env = createEnv(seedHex);
    const request = new Request('https://test.workers.dev/servers');
    const response = await worker.fetch(request, env);

    expect(response.headers.get('Access-Control-Expose-Headers')).toContain(
      'X-Bootstrap-Signature'
    );
  });

  it('should include timestamp in response body', async () => {
    const env = createEnv(seedHex);
    const request = new Request('https://test.workers.dev/servers');
    const response = await worker.fetch(request, env);
    const data = await response.json();

    expect(data.timestamp).toBeDefined();
    expect(typeof data.timestamp).toBe('number');
  });

  it('should produce a valid signature over the response body', async () => {
    const env = createEnv(seedHex);
    const request = new Request('https://test.workers.dev/servers');
    const response = await worker.fetch(request, env);

    const body = await response.text();
    const sigBase64 = response.headers.get('X-Bootstrap-Signature');

    const sigBytes = Uint8Array.from(atob(sigBase64), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(body);
    const valid = await crypto.subtle.verify('Ed25519', keyPair.publicKey, sigBytes, data);

    expect(valid).toBe(true);
  });

  it('should work without signing key (graceful degradation)', async () => {
    const env = createEnv(); // no signing key
    const request = new Request('https://test.workers.dev/servers');
    const response = await worker.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.servers).toBeDefined();
    expect(data.timestamp).toBeDefined();
    expect(response.headers.get('X-Bootstrap-Signature')).toBeNull();
  });

  it('should still pass through POST /servers to DO', async () => {
    const env = createEnv(seedHex);
    const request = new Request('https://test.workers.dev/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: 'ed25519:test',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      }),
    });
    const response = await worker.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('should include registered servers in signed response', async () => {
    const env = createEnv(seedHex);

    // Register a server via the DO directly
    await serverRegistry.fetch(
      new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: 'ed25519:srv1',
          endpoint: 'wss://srv1.example.com',
          publicKey: 'key1',
          region: 'eu-west',
        }),
      })
    );

    const request = new Request('https://test.workers.dev/servers');
    const response = await worker.fetch(request, env);
    const body = await response.text();
    const data = JSON.parse(body);

    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].serverId).toBe('ed25519:srv1');

    // Verify signature
    const sigBase64 = response.headers.get('X-Bootstrap-Signature');
    const sigBytes = Uint8Array.from(atob(sigBase64), (c) => c.charCodeAt(0));
    const encoded = new TextEncoder().encode(body);
    const valid = await crypto.subtle.verify('Ed25519', keyPair.publicKey, sigBytes, encoded);
    expect(valid).toBe(true);
  });
});
