/**
 * Regression tests for verifyServerAuth and verifyCIAuth.
 *
 * These tests ensure that the sync-to-async migration of timingSafeEqual
 * does not introduce authentication bypass bugs (e.g., missing await
 * causing a Promise to be truthy regardless of actual auth result).
 */

import { describe, it, expect, beforeEach } from 'vitest';

// We test through the DO class to exercise the real code path.
// Import the DO class and create a minimal instance with mock env/storage.
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';

/**
 * Create a minimal mock Durable Object state and env for auth testing.
 */
function createMockDO(env = {}) {
  const mockState = {
    storage: {
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
      list: async () => new Map(),
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    id: { toString: () => 'test-id' },
    blockConcurrencyWhile: async (fn) => await fn(),
  };

  const defaultEnv = {
    SERVER_REGISTRY_SECRET: 'test-server-secret-12345',
    CI_UPLOAD_SECRET: 'test-ci-secret-67890',
    ...env,
  };

  return new ServerRegistryDO(mockState, defaultEnv);
}

/**
 * Create a mock Request with the given Authorization header.
 */
function createMockRequest(authHeader) {
  const headers = new Headers();
  if (authHeader !== undefined) {
    headers.set('Authorization', authHeader);
  }
  headers.set('CF-Connecting-IP', '127.0.0.1');
  return new Request('https://example.com/servers', {
    method: 'POST',
    headers,
  });
}

describe('verifyServerAuth', () => {
  let doInstance;

  beforeEach(() => {
    doInstance = createMockDO();
  });

  it('accepts valid server auth', async () => {
    const request = createMockRequest('Bearer test-server-secret-12345');
    const result = await doInstance.verifyServerAuth(request);
    expect(result).toBe(true);
  });

  it('rejects invalid server auth (wrong secret)', async () => {
    const request = createMockRequest('Bearer wrong-secret');
    const result = await doInstance.verifyServerAuth(request);
    expect(result).toBe(false);
  });

  it('rejects missing Authorization header', async () => {
    const request = createMockRequest(undefined);
    const result = await doInstance.verifyServerAuth(request);
    expect(result).toBe(false);
  });

  it('rejects empty Authorization header', async () => {
    const request = createMockRequest('');
    const result = await doInstance.verifyServerAuth(request);
    expect(result).toBe(false);
  });

  it('returns false when SERVER_REGISTRY_SECRET is not configured', async () => {
    doInstance = createMockDO({ SERVER_REGISTRY_SECRET: undefined });
    const request = createMockRequest('Bearer anything');
    const result = await doInstance.verifyServerAuth(request);
    expect(result).toBe(false);
  });

  it('rejects auth with different prefix (Basic vs Bearer)', async () => {
    const request = createMockRequest('Basic test-server-secret-12345');
    const result = await doInstance.verifyServerAuth(request);
    expect(result).toBe(false);
  });

  it('result is a boolean, not a Promise (i.e., await is working)', async () => {
    const request = createMockRequest('Bearer test-server-secret-12345');
    const result = await doInstance.verifyServerAuth(request);
    // This test specifically catches the "missing await" bug:
    // if verifyServerAuth returns a Promise and caller forgets await,
    // the Promise object is truthy regardless of the actual result.
    expect(typeof result).toBe('boolean');
  });
});

describe('verifyCIAuth', () => {
  let doInstance;

  beforeEach(() => {
    doInstance = createMockDO();
  });

  it('accepts valid CI auth', async () => {
    const request = createMockRequest('Bearer test-ci-secret-67890');
    const result = await doInstance.verifyCIAuth(request);
    expect(result).toBe(true);
  });

  it('rejects invalid CI auth (wrong secret)', async () => {
    const request = createMockRequest('Bearer wrong-ci-secret');
    const result = await doInstance.verifyCIAuth(request);
    expect(result).toBe(false);
  });

  it('rejects missing Authorization header', async () => {
    const request = createMockRequest(undefined);
    const result = await doInstance.verifyCIAuth(request);
    expect(result).toBe(false);
  });

  it('returns false when CI_UPLOAD_SECRET is not configured', async () => {
    doInstance = createMockDO({ CI_UPLOAD_SECRET: undefined });
    const request = createMockRequest('Bearer anything');
    const result = await doInstance.verifyCIAuth(request);
    expect(result).toBe(false);
  });

  it('result is a boolean, not a Promise (i.e., await is working)', async () => {
    const request = createMockRequest('Bearer test-ci-secret-67890');
    const result = await doInstance.verifyCIAuth(request);
    expect(typeof result).toBe('boolean');
  });
});

describe('auth integration via fetch()', () => {
  let doInstance;

  beforeEach(() => {
    doInstance = createMockDO();
  });

  it('POST /servers returns 401 for invalid auth when secret is configured', async () => {
    const request = new Request('https://example.com/servers', {
      method: 'POST',
      headers: new Headers({
        'Authorization': 'Bearer wrong-secret',
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      }),
      body: JSON.stringify({ serverId: 'test', endpoint: 'wss://test.example.com', publicKey: 'key' }),
    });
    const response = await doInstance.fetch(request);
    expect(response.status).toBe(401);
  });

  it('POST /servers/trusted-keys returns 401 for invalid CI auth', async () => {
    const request = new Request('https://example.com/servers/trusted-keys', {
      method: 'POST',
      headers: new Headers({
        'Authorization': 'Bearer wrong-ci-secret',
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      }),
      body: JSON.stringify({ keys: ['key1'] }),
    });
    const response = await doInstance.fetch(request);
    expect(response.status).toBe(401);
  });

  it('GET /servers/trusted-keys returns 401 for invalid CI auth', async () => {
    const request = new Request('https://example.com/servers/trusted-keys', {
      method: 'GET',
      headers: new Headers({
        'Authorization': 'Bearer wrong-ci-secret',
        'CF-Connecting-IP': '127.0.0.1',
      }),
    });
    const response = await doInstance.fetch(request);
    expect(response.status).toBe(401);
  });

  it('DELETE /servers/:serverId returns 401 for invalid auth', async () => {
    const request = new Request('https://example.com/servers/test-server-id', {
      method: 'DELETE',
      headers: new Headers({
        'Authorization': 'Bearer wrong-secret',
        'CF-Connecting-IP': '127.0.0.1',
      }),
    });
    const response = await doInstance.fetch(request);
    expect(response.status).toBe(401);
  });

  it('POST /servers/heartbeat returns 401 for invalid auth', async () => {
    const request = new Request('https://example.com/servers/heartbeat', {
      method: 'POST',
      headers: new Headers({
        'Authorization': 'Bearer wrong-secret',
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      }),
      body: JSON.stringify({ serverId: 'test' }),
    });
    const response = await doInstance.fetch(request);
    expect(response.status).toBe(401);
  });

  it('GET /servers/anomalies returns 401 for invalid auth', async () => {
    const request = new Request('https://example.com/servers/anomalies', {
      method: 'GET',
      headers: new Headers({
        'Authorization': 'Bearer wrong-secret',
        'CF-Connecting-IP': '127.0.0.1',
      }),
    });
    const response = await doInstance.fetch(request);
    expect(response.status).toBe(401);
  });

  it('GET /servers/trusted-keys/audit-log returns 401 for invalid CI auth', async () => {
    const request = new Request('https://example.com/servers/trusted-keys/audit-log', {
      method: 'GET',
      headers: new Headers({
        'Authorization': 'Bearer wrong-ci-secret',
        'CF-Connecting-IP': '127.0.0.1',
      }),
    });
    const response = await doInstance.fetch(request);
    expect(response.status).toBe(401);
  });
});
