/**
 * Tests for TufMetadataDO - TUF Metadata Durable Object
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TufMetadataDO } from '../../src/durable-objects/tuf-metadata-do.js';
import { canonicalJSON, generateKeyId } from '../../src/crypto/tuf/metadata.js';
import { importSigningKey, signPayload } from '../../src/crypto/signing.js';

// --- Test helpers ---

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
    if (Array.isArray(key)) {
      for (const k of key) this.data.delete(k);
    } else {
      this.data.delete(key);
    }
  }
  async list({ prefix }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        results.set(key, value);
      }
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

function createSignedMetadata(type, version, expiresInDays = 30) {
  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + expiresInDays);
  return {
    signed: {
      _type: type,
      spec_version: '1.0.31',
      version,
      expires: expiry.toISOString(),
    },
    signatures: [{ keyid: 'test-key-id', sig: 'dGVzdC1zaWc=' }],
  };
}

function createExpiredMetadata(type, version) {
  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() - 1); // yesterday
  return {
    signed: {
      _type: type,
      spec_version: '1.0.31',
      version,
      expires: expiry.toISOString(),
    },
    signatures: [{ keyid: 'test-key-id', sig: 'dGVzdC1zaWc=' }],
  };
}

// --- Tests ---

describe('TufMetadataDO', () => {
  let mockState;
  let tufDO;
  const TUF_SECRET = 'test-tuf-secret-123';
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TUF_SECRET}`,
  };

  beforeEach(() => {
    mockState = new MockState();
    tufDO = new TufMetadataDO(mockState, { TUF_UPDATE_SECRET: TUF_SECRET });
  });

  afterEach(() => {
    mockState.storage.clear();
  });

  // --- Authentication tests ---

  describe('PUT /tuf/:role authentication', () => {
    it('should reject updates without Authorization header', async () => {
      const metadata = createSignedMetadata('root', 1);
      const request = new Request('https://internal/tuf/root.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      });
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should reject updates with wrong secret', async () => {
      const metadata = createSignedMetadata('root', 1);
      const request = new Request('https://internal/tuf/root.json', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-secret',
        },
        body: JSON.stringify(metadata),
      });
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should accept updates with correct secret', async () => {
      const metadata = createSignedMetadata('root', 1);
      const request = new Request('https://internal/tuf/root.json', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(metadata),
      });
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.version).toBe(1);
    });

    it('should fall back to SERVER_REGISTRY_SECRET if TUF_UPDATE_SECRET not set', async () => {
      const fallbackDO = new TufMetadataDO(mockState, {
        SERVER_REGISTRY_SECRET: 'fallback-secret',
      });
      const metadata = createSignedMetadata('root', 1);
      const request = new Request('https://internal/tuf/root.json', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer fallback-secret',
        },
        body: JSON.stringify(metadata),
      });
      const response = await fallbackDO.fetch(request);
      expect(response.status).toBe(200);
    });

    it('should return 500 if no secret is configured', async () => {
      const noDO = new TufMetadataDO(mockState, {});
      const metadata = createSignedMetadata('root', 1);
      const request = new Request('https://internal/tuf/root.json', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(metadata),
      });
      const response = await noDO.fetch(request);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('no update secret');
    });
  });

  // --- Version monotonicity tests ---

  describe('version monotonicity', () => {
    it('should accept first version (v1)', async () => {
      const metadata = createSignedMetadata('targets', 1);
      const request = new Request('https://internal/tuf/targets.json', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(metadata),
      });
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(200);
    });

    it('should accept version increment (v1 -> v2)', async () => {
      // Store v1
      const v1 = createSignedMetadata('targets', 1);
      await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(v1),
      }));

      // Update to v2
      const v2 = createSignedMetadata('targets', 2);
      const response = await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(v2),
      }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.version).toBe(2);
    });

    it('should reject same version (rollback to v1)', async () => {
      // Store v1
      const v1 = createSignedMetadata('targets', 1);
      await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(v1),
      }));

      // Try to store v1 again
      const v1again = createSignedMetadata('targets', 1);
      const response = await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(v1again),
      }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Version rollback detected');
    });

    it('should reject lower version (rollback v2 -> v1)', async () => {
      // Store v2
      const v2 = createSignedMetadata('targets', 2);
      await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(v2),
      }));

      // Try to store v1
      const v1 = createSignedMetadata('targets', 1);
      const response = await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(v1),
      }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Version rollback detected');
    });
  });

  // --- Metadata validation tests ---

  describe('metadata validation', () => {
    it('should reject metadata without signed field', async () => {
      const request = new Request('https://internal/tuf/root.json', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ signatures: [] }),
      });
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('missing signed or signatures');
    });

    it('should reject metadata without signatures field', async () => {
      const request = new Request('https://internal/tuf/root.json', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ signed: { _type: 'root', version: 1 } }),
      });
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(400);
    });

    it('should reject metadata type mismatch', async () => {
      const metadata = createSignedMetadata('snapshot', 1);
      const request = new Request('https://internal/tuf/root.json', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(metadata),
      });
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Metadata type mismatch');
    });
  });

  // --- GET metadata tests ---

  describe('GET /tuf/:role.json', () => {
    it('should return 404 for missing metadata', async () => {
      const request = new Request('https://internal/tuf/root.json');
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain('not found');
    });

    it('should return stored metadata', async () => {
      const metadata = createSignedMetadata('root', 1);
      await tufDO.fetch(new Request('https://internal/tuf/root.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(metadata),
      }));

      const response = await tufDO.fetch(new Request('https://internal/tuf/root.json'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.signed.version).toBe(1);
      expect(body.signed._type).toBe('root');
    });

    it('should set short cache for timestamp', async () => {
      const metadata = createSignedMetadata('timestamp', 1);
      await tufDO.fetch(new Request('https://internal/tuf/timestamp.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(metadata),
      }));

      const response = await tufDO.fetch(new Request('https://internal/tuf/timestamp.json'));
      expect(response.headers.get('Cache-Control')).toBe('max-age=300');
    });

    it('should set long cache for targets', async () => {
      const metadata = createSignedMetadata('targets', 1);
      await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(metadata),
      }));

      const response = await tufDO.fetch(new Request('https://internal/tuf/targets.json'));
      expect(response.headers.get('Cache-Control')).toBe('max-age=3600');
    });

    it('should still serve expired metadata (with warning)', async () => {
      const metadata = createExpiredMetadata('root', 1);
      await tufDO.fetch(new Request('https://internal/tuf/root.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(metadata),
      }));

      const response = await tufDO.fetch(new Request('https://internal/tuf/root.json'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.signed.version).toBe(1);
    });
  });

  // --- History capping tests ---

  describe('version history', () => {
    it('should store version history entries', async () => {
      const metadata = createSignedMetadata('targets', 1);
      await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(metadata),
      }));

      const history = await mockState.storage.get('tuf:targets:history');
      expect(history).toBeDefined();
      expect(history.length).toBe(1);
      expect(history[0].version).toBe(1);
    });

    it('should cap history at 10 entries', async () => {
      for (let v = 1; v <= 15; v++) {
        const metadata = createSignedMetadata('targets', v);
        await tufDO.fetch(new Request('https://internal/tuf/targets.json', {
          method: 'PUT', headers: authHeaders, body: JSON.stringify(metadata),
        }));
      }

      const history = await mockState.storage.get('tuf:targets:history');
      expect(history.length).toBe(10);
      // Should keep the latest 10 (versions 6-15)
      expect(history[0].version).toBe(6);
      expect(history[9].version).toBe(15);
    });
  });

  // --- CORS and routing tests ---

  describe('routing', () => {
    it('should handle OPTIONS preflight', async () => {
      const request = new Request('https://internal/tuf/root.json', {
        method: 'OPTIONS',
      });
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(200);
    });

    it('should return 404 for unknown paths', async () => {
      const request = new Request('https://internal/unknown');
      const response = await tufDO.fetch(request);
      expect(response.status).toBe(404);
    });

    it('should handle all four role endpoints', async () => {
      const roles = ['root', 'targets', 'snapshot', 'timestamp'];
      for (const role of roles) {
        const metadata = createSignedMetadata(role, 1);
        const putResponse = await tufDO.fetch(new Request(`https://internal/tuf/${role}.json`, {
          method: 'PUT', headers: authHeaders, body: JSON.stringify(metadata),
        }));
        expect(putResponse.status).toBe(200);

        const getResponse = await tufDO.fetch(new Request(`https://internal/tuf/${role}.json`));
        expect(getResponse.status).toBe(200);
        const body = await getResponse.json();
        expect(body.signed._type).toBe(role);
      }
    });
  });

  // --- Error handling tests ---

  describe('error handling', () => {
    it('should return 500 on unhandled error', async () => {
      // Force an error by making storage.get throw
      mockState.storage.get = async () => { throw new Error('Storage failure'); };
      const metadata = createSignedMetadata('root', 1);
      await tufDO.fetch(new Request('https://internal/tuf/root.json', {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(metadata),
      }));

      // GET should fail because storage.get throws
      const response = await tufDO.fetch(new Request('https://internal/tuf/root.json'));
      expect(response.status).toBe(500);
    });
  });
});

// --- Canonical JSON tests ---

describe('canonicalJSON', () => {
  it('should sort keys alphabetically', () => {
    const result = canonicalJSON({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it('should recursively sort nested objects', () => {
    const result = canonicalJSON({ b: { z: 1, a: 2 }, a: 1 });
    expect(result).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });

  it('should handle arrays without sorting', () => {
    const result = canonicalJSON({ b: [3, 1, 2] });
    expect(result).toBe('{"b":[3,1,2]}');
  });

  it('should handle null values', () => {
    const result = canonicalJSON({ a: null, b: 1 });
    expect(result).toBe('{"a":null,"b":1}');
  });

  it('should handle strings', () => {
    const result = canonicalJSON({ b: 'hello', a: 'world' });
    expect(result).toBe('{"a":"world","b":"hello"}');
  });

  it('should handle booleans', () => {
    const result = canonicalJSON({ z: true, a: false });
    expect(result).toBe('{"a":false,"z":true}');
  });

  it('should handle deeply nested structures', () => {
    const result = canonicalJSON({
      z: { z: { z: 1, a: 2 }, a: 3 },
      a: 4,
    });
    expect(result).toBe('{"a":4,"z":{"a":3,"z":{"a":2,"z":1}}}');
  });

  it('should handle empty objects', () => {
    expect(canonicalJSON({})).toBe('{}');
  });

  it('should handle empty arrays', () => {
    expect(canonicalJSON([])).toBe('[]');
  });
});
