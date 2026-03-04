/**
 * Unit tests for ServerRegistryDO authentication fix (Story 004)
 *
 * Tests the fail-closed authentication pattern for protected endpoints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';

class MockStorage {
  constructor() {
    this.data = new Map();
  }
  async get(key) { return this.data.get(key); }
  async put(keyOrMap, value) {
    if (keyOrMap instanceof Map) {
      for (const [k, v] of keyOrMap) { this.data.set(k, v); }
    } else {
      this.data.set(keyOrMap, value);
    }
  }
  async delete(key) { this.data.delete(key); }
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
  async getAlarm() { return null; }
  async setAlarm() {}
}

class MockState {
  constructor() {
    this.storage = new MockStorage();
  }
  blockConcurrencyWhile(fn) { return fn(); }
}

function createRequest(method, path, body = null, authHeader = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (authHeader) {
    options.headers['Authorization'] = authHeader;
  }
  if (body) {
    options.body = JSON.stringify(body);
  }
  return new Request(`https://test.workers.dev${path}`, options);
}

describe('ServerRegistryDO Authentication (Story 004)', () => {
  describe('POST /servers', () => {
    it('should return 503 when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {}; // No SERVER_REGISTRY_SECRET
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toContain('not configured');
    });

    it('should return 401 when SERVER_REGISTRY_SECRET is set but no auth header provided', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret-123' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 401 when wrong auth token is provided', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      }, 'Bearer wrong-secret');

      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should succeed when correct auth token is provided', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret', REPLAY_GRACE_MODE: 'true' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      }, 'Bearer correct-secret');

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });

  describe('DELETE /servers/:serverId', () => {
    it('should return 503 when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {};
      const registry = new ServerRegistryDO(state, env);

      // Pre-populate a server
      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
        lastSeen: Date.now(),
      });

      const request = createRequest('DELETE', '/servers/test-server');
      const response = await registry.fetch(request);
      expect(response.status).toBe(503);
    });

    it('should return 401 without auth header when secret is configured', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret' };
      const registry = new ServerRegistryDO(state, env);

      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
        lastSeen: Date.now(),
      });

      const request = createRequest('DELETE', '/servers/test-server');
      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should succeed with correct auth', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret' };
      const registry = new ServerRegistryDO(state, env);

      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
        lastSeen: Date.now(),
      });

      const request = createRequest('DELETE', '/servers/test-server', null, 'Bearer correct-secret');
      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('POST /servers/heartbeat', () => {
    it('should return 503 when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {};
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers/heartbeat', { serverId: 'test-server' });
      const response = await registry.fetch(request);
      expect(response.status).toBe(503);
    });

    it('should return 401 without auth when secret is configured', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers/heartbeat', { serverId: 'test-server' });
      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should succeed with correct auth', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret', REPLAY_GRACE_MODE: 'true' };
      const registry = new ServerRegistryDO(state, env);

      // Pre-register server
      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
        connections: 0,
        relayConnections: 0,
        signalingConnections: 0,
        activeCodes: 0,
        lastSeen: Date.now(),
      });

      const request = createRequest('POST', '/servers/heartbeat', { serverId: 'test-server' }, 'Bearer correct-secret');
      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('GET /servers/anomalies', () => {
    it('should return 503 when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {};
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('GET', '/servers/anomalies');
      const response = await registry.fetch(request);
      expect(response.status).toBe(503);
    });

    it('should return 401 without auth when secret is configured', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('GET', '/servers/anomalies');
      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should succeed with correct auth', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('GET', '/servers/anomalies', null, 'Bearer correct-secret');
      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('GET /servers (public endpoint)', () => {
    it('should remain accessible without auth regardless of SERVER_REGISTRY_SECRET', async () => {
      const state = new MockState();

      // Test without secret
      const registryNoSecret = new ServerRegistryDO(state, {});
      let request = createRequest('GET', '/servers');
      let response = await registryNoSecret.fetch(request);
      expect(response.status).toBe(200);

      // Test with secret (should still be public)
      const registryWithSecret = new ServerRegistryDO(state, { SERVER_REGISTRY_SECRET: 'secret' });
      request = createRequest('GET', '/servers');
      response = await registryWithSecret.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('Secondary auth check in unregisterServer()', () => {
    it('should deny deletion when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {};
      const registry = new ServerRegistryDO(state, env);

      // Pre-populate server
      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'server-public-key',
        lastSeen: Date.now(),
      });

      // Attempt delete without auth (should fail at fetch() guard)
      const request = createRequest('DELETE', '/servers/test-server');
      const response = await registry.fetch(request);
      expect(response.status).toBe(503);

      // Server should still exist
      const server = await state.storage.get('server:test-server');
      expect(server).toBeDefined();
    });
  });

  describe('Audit logging', () => {
    it('should emit audit log when SERVER_REGISTRY_SECRET is not configured', async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const state = new MockState();
      const registry = new ServerRegistryDO(state, {});

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      });

      await registry.fetch(request);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[audit]'),
        expect.objectContaining({ action: 'auth_unconfigured' })
      );
      warnSpy.mockRestore();
    });

    it('should emit audit log on failed authentication', async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const state = new MockState();
      const registry = new ServerRegistryDO(state, { SERVER_REGISTRY_SECRET: 'correct-secret' });

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      }, 'Bearer wrong-secret');

      await registry.fetch(request);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[audit]'),
        expect.objectContaining({ action: 'auth_failed' })
      );
      warnSpy.mockRestore();
    });
  });
});
