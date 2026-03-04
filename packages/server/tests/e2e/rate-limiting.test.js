/**
 * Rate Limiting Integration Tests
 *
 * Tests for per-endpoint rate limiting in the Worker fetch handler:
 * - Per-endpoint rate limit key assignment
 * - Per-endpoint specific limits (POST /servers: 5/min, GET /servers: 30/min, etc.)
 * - Endpoint isolation: different endpoints have independent counters
 * - 429 response includes Retry-After, X-RateLimit-Remaining, X-RateLimit-Limit headers
 * - Different IPs have independent limits
 * - Missing CF-Connecting-IP is rejected with 400
 * - Per-serverId heartbeat rate limiting (2/min, min 30s interval) in DO
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { rateLimiter } from '../../src/rate-limiter.js';
import worker, { getEndpointRateLimitKey, RATE_LIMITS } from '../../src/index.js';

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

class MockDurableObjectStub {
  constructor(doInstance) { this.doInstance = doInstance; }
  async fetch(request) { return this.doInstance.fetch(request); }
}

function createMockEnv(doInstance) {
  return {
    SERVER_REGISTRY: {
      idFromName: () => 'mock-id',
      get: () => new MockDurableObjectStub(doInstance),
    },
    ATTESTATION_REGISTRY: {
      idFromName: () => 'mock-attest-id',
      get: () => new MockDurableObjectStub(doInstance),
    },
  };
}

describe('Per-Endpoint Rate Limiting', () => {
  let mockState;
  let serverRegistry;
  let env;

  beforeEach(() => {
    mockState = new MockState();
    serverRegistry = new ServerRegistryDO(mockState, {});
    env = createMockEnv(serverRegistry);
    // Clear singleton rate limiter state between tests
    rateLimiter.counters.clear();
    rateLimiter.requestCount = 0;
  });

  afterEach(() => {
    rateLimiter.counters.clear();
    rateLimiter.requestCount = 0;
  });

  describe('getEndpointRateLimitKey()', () => {
    it('should classify GET /health as read', () => {
      expect(getEndpointRateLimitKey('GET', '/health')).toBe('read');
    });

    it('should classify GET /attest/versions as read', () => {
      expect(getEndpointRateLimitKey('GET', '/attest/versions')).toBe('read');
    });

    it('should classify OPTIONS requests as read', () => {
      expect(getEndpointRateLimitKey('OPTIONS', '/servers')).toBe('read');
      expect(getEndpointRateLimitKey('OPTIONS', '/attest/register')).toBe('read');
    });

    it('should classify GET /servers as GET:/servers (30/min)', () => {
      expect(getEndpointRateLimitKey('GET', '/servers')).toBe('GET:/servers');
    });

    it('should classify GET /servers/trusted-keys as GET:/servers/trusted-keys (10/min)', () => {
      expect(getEndpointRateLimitKey('GET', '/servers/trusted-keys')).toBe('GET:/servers/trusted-keys');
    });

    it('should classify POST /servers as POST:/servers (5/min)', () => {
      expect(getEndpointRateLimitKey('POST', '/servers')).toBe('POST:/servers');
    });

    it('should classify POST /servers/trusted-keys as POST:/servers/trusted-keys (5/min)', () => {
      expect(getEndpointRateLimitKey('POST', '/servers/trusted-keys')).toBe('POST:/servers/trusted-keys');
    });

    it('should classify POST /servers/heartbeat as write', () => {
      expect(getEndpointRateLimitKey('POST', '/servers/heartbeat')).toBe('write');
    });

    it('should classify DELETE /servers/test-id as write', () => {
      expect(getEndpointRateLimitKey('DELETE', '/servers/test-id')).toBe('write');
    });

    it('should classify admin endpoints correctly', () => {
      expect(getEndpointRateLimitKey('POST', '/attest/upload-reference')).toBe('admin');
      expect(getEndpointRateLimitKey('POST', '/attest/versions')).toBe('admin');
    });

    it('should classify attest endpoints correctly', () => {
      expect(getEndpointRateLimitKey('POST', '/attest/register')).toBe('attest');
      expect(getEndpointRateLimitKey('POST', '/attest/challenge')).toBe('attest');
      expect(getEndpointRateLimitKey('POST', '/attest/verify')).toBe('attest');
    });
  });

  describe('RATE_LIMITS', () => {
    it('should define per-endpoint limits with correct values', () => {
      expect(RATE_LIMITS.read).toEqual({ limit: 200, windowMs: 60000 });
      expect(RATE_LIMITS['GET:/servers']).toEqual({ limit: 30, windowMs: 60000 });
      expect(RATE_LIMITS['GET:/servers/trusted-keys']).toEqual({ limit: 10, windowMs: 60000 });
      expect(RATE_LIMITS['POST:/servers']).toEqual({ limit: 5, windowMs: 60000 });
      expect(RATE_LIMITS['POST:/servers/trusted-keys']).toEqual({ limit: 5, windowMs: 60000 });
      expect(RATE_LIMITS.write).toEqual({ limit: 30, windowMs: 60000 });
      expect(RATE_LIMITS.attest).toEqual({ limit: 20, windowMs: 60000 });
      expect(RATE_LIMITS.admin).toEqual({ limit: 10, windowMs: 60000 });
    });
  });

  describe('POST /servers rate limit (5/min per IP)', () => {
    it('should allow 5 POST /servers requests per minute', async () => {
      const ip = '10.0.0.10';
      for (let i = 0; i < 5; i++) {
        const req = new Request('https://test.workers.dev/servers', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: `server-${i}`, endpoint: 'wss://test.com', publicKey: 'key' }),
        });
        const res = await worker.fetch(req, env);
        expect(res.status).not.toBe(429);
      }
    });

    it('should reject 6th POST /servers request within a minute', async () => {
      const ip = '10.0.0.11';
      for (let i = 0; i < 5; i++) {
        const req = new Request('https://test.workers.dev/servers', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: `server-${i}`, endpoint: 'wss://test.com', publicKey: 'key' }),
        });
        await worker.fetch(req, env);
      }

      const req = new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: 'server-6', endpoint: 'wss://test.com', publicKey: 'key' }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe('Too Many Requests');
      expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    });
  });

  describe('GET /servers rate limit (30/min per IP)', () => {
    it('should allow 30 GET /servers requests per minute', async () => {
      const ip = '10.0.0.20';
      for (let i = 0; i < 30; i++) {
        const req = new Request('https://test.workers.dev/servers', {
          headers: { 'CF-Connecting-IP': ip },
        });
        const res = await worker.fetch(req, env);
        expect(res.status).not.toBe(429);
      }
    });

    it('should reject 31st GET /servers request within a minute', async () => {
      const ip = '10.0.0.21';
      for (let i = 0; i < 30; i++) {
        const req = new Request('https://test.workers.dev/servers', {
          headers: { 'CF-Connecting-IP': ip },
        });
        await worker.fetch(req, env);
      }

      const req = new Request('https://test.workers.dev/servers', {
        headers: { 'CF-Connecting-IP': ip },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(429);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('30');
    });
  });

  describe('POST /servers/trusted-keys rate limit (5/min per IP)', () => {
    it('should reject 6th POST /servers/trusted-keys request', async () => {
      const ip = '10.0.0.30';
      for (let i = 0; i < 5; i++) {
        const req = new Request('https://test.workers.dev/servers/trusted-keys', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: ['key1'] }),
        });
        await worker.fetch(req, env);
      }

      const req = new Request('https://test.workers.dev/servers/trusted-keys', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: ['key1'] }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(429);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    });
  });

  describe('GET /servers/trusted-keys rate limit (10/min per IP)', () => {
    it('should reject 11th GET /servers/trusted-keys request', async () => {
      const ip = '10.0.0.40';
      for (let i = 0; i < 10; i++) {
        const req = new Request('https://test.workers.dev/servers/trusted-keys', {
          headers: { 'CF-Connecting-IP': ip },
        });
        await worker.fetch(req, env);
      }

      const req = new Request('https://test.workers.dev/servers/trusted-keys', {
        headers: { 'CF-Connecting-IP': ip },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(429);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    });
  });

  describe('Endpoint isolation', () => {
    it('should not count GET /health requests against POST /servers limit', async () => {
      const ip = '10.0.0.50';

      // Exhaust read tier (200 requests to /health)
      for (let i = 0; i < 200; i++) {
        const req = new Request('https://test.workers.dev/health', {
          headers: { 'CF-Connecting-IP': ip },
        });
        const res = await worker.fetch(req, env);
        expect(res.status).toBe(200);
      }

      // Next /health request should be rate limited
      const healthReq = new Request('https://test.workers.dev/health', {
        headers: { 'CF-Connecting-IP': ip },
      });
      const healthRes = await worker.fetch(healthReq, env);
      expect(healthRes.status).toBe(429);

      // But POST /servers should still be available (different key)
      const postReq = new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: 'test-server', endpoint: 'wss://test.com', publicKey: 'key' }),
      });
      const postRes = await worker.fetch(postReq, env);
      expect(postRes.status).not.toBe(429);
    });

    it('should not count POST /servers requests against GET /servers limit', async () => {
      const ip = '10.0.0.51';

      // Exhaust POST /servers limit (5 requests)
      for (let i = 0; i < 5; i++) {
        const req = new Request('https://test.workers.dev/servers', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: `s-${i}`, endpoint: 'wss://test.com', publicKey: 'key' }),
        });
        await worker.fetch(req, env);
      }

      // POST /servers is now rate limited
      const postReq = new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: 's-6', endpoint: 'wss://test.com', publicKey: 'key' }),
      });
      const postRes = await worker.fetch(postReq, env);
      expect(postRes.status).toBe(429);

      // But GET /servers should still work
      const getReq = new Request('https://test.workers.dev/servers', {
        headers: { 'CF-Connecting-IP': ip },
      });
      const getRes = await worker.fetch(getReq, env);
      expect(getRes.status).not.toBe(429);
    });

    it('should not count read requests against attest tier', async () => {
      const ip = '10.0.0.52';

      // Exhaust read tier
      for (let i = 0; i < 200; i++) {
        const req = new Request('https://test.workers.dev/health', {
          headers: { 'CF-Connecting-IP': ip },
        });
        await worker.fetch(req, env);
      }

      // Attest tier should still be available
      const attestReq = new Request('https://test.workers.dev/attest/challenge', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: 'test-device', build_version: '1.0.0', platform: 'android' }),
      });
      const attestRes = await worker.fetch(attestReq, env);
      expect(attestRes.status).not.toBe(429);
    });
  });

  describe('Rate limit headers', () => {
    it('should include Retry-After, X-RateLimit-Remaining, and X-RateLimit-Limit on 429', async () => {
      const ip = '10.0.0.60';

      // Exhaust POST /servers limit (5 requests)
      for (let i = 0; i < 5; i++) {
        const req = new Request('https://test.workers.dev/servers', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: `server-${i}`, endpoint: 'wss://test.com', publicKey: 'key' }),
        });
        await worker.fetch(req, env);
      }

      // 6th request should be rate limited
      const req = new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: 'server-6', endpoint: 'wss://test.com', publicKey: 'key' }),
      });
      const res = await worker.fetch(req, env);

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      expect(parseInt(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    });

    it('should include X-RateLimit-Remaining on successful responses', async () => {
      const req = new Request('https://test.workers.dev/health', {
        headers: { 'CF-Connecting-IP': '10.0.0.61' },
      });
      const res = await worker.fetch(req, env);

      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
      expect(parseInt(res.headers.get('X-RateLimit-Remaining'))).toBe(199); // 200 - 1
    });
  });

  describe('IP independence', () => {
    it('should give different IPs independent limits', async () => {
      // IP1 exhausts admin tier (10 requests)
      for (let i = 0; i < 10; i++) {
        const req = new Request('https://test.workers.dev/attest/versions', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': '10.0.0.70', 'Content-Type': 'application/json' },
          body: JSON.stringify({ min_version: '1.0.0', force_update_version: '1.0.0' }),
        });
        await worker.fetch(req, env);
      }

      // IP1 is rate limited
      const req1 = new Request('https://test.workers.dev/attest/versions', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '10.0.0.70', 'Content-Type': 'application/json' },
        body: JSON.stringify({ min_version: '1.0.0', force_update_version: '1.0.0' }),
      });
      const res1 = await worker.fetch(req1, env);
      expect(res1.status).toBe(429);

      // IP2 should still have full quota
      const req2 = new Request('https://test.workers.dev/attest/versions', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '10.0.0.71', 'Content-Type': 'application/json' },
        body: JSON.stringify({ min_version: '1.0.0', force_update_version: '1.0.0' }),
      });
      const res2 = await worker.fetch(req2, env);
      expect(res2.status).not.toBe(429);
    });
  });

  describe('Missing IP rejection', () => {
    it('should reject requests without CF-Connecting-IP header', async () => {
      const req = new Request('https://test.workers.dev/health');
      const res = await worker.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Missing client IP');
    });
  });

  describe('Per-serverId heartbeat rate limiting (DO-backed)', () => {
    let doState;
    let doEnv;
    let doInstance;

    beforeEach(() => {
      doState = new MockState();
      doEnv = {
        SERVER_REGISTRY_SECRET: 'test-secret',
        REPLAY_GRACE_MODE: 'true',
      };
      doInstance = new ServerRegistryDO(doState, doEnv);
    });

    async function registerServer(serverId) {
      const regReq = new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-secret',
          'CF-Connecting-IP': '127.0.0.1',
        },
        body: JSON.stringify({
          serverId,
          endpoint: 'wss://test.com',
          publicKey: 'testkey',
          region: 'us-east',
        }),
      });
      return doInstance.fetch(regReq);
    }

    async function sendHeartbeat(serverId) {
      const hbReq = new Request('https://test.workers.dev/servers/heartbeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-secret',
          'CF-Connecting-IP': '127.0.0.1',
        },
        body: JSON.stringify({ serverId }),
      });
      return doInstance.fetch(hbReq);
    }

    it('should allow first heartbeat for a registered server', async () => {
      await registerServer('server-hb-1');
      const res = await sendHeartbeat('server-hb-1');
      expect(res.status).toBe(200);
    });

    it('should reject heartbeat within 30s of the last one (min interval)', async () => {
      await registerServer('server-hb-2');
      const res1 = await sendHeartbeat('server-hb-2');
      expect(res1.status).toBe(200);

      // Immediate second heartbeat should be rejected (< 30s)
      const res2 = await sendHeartbeat('server-hb-2');
      expect(res2.status).toBe(429);
      const body = await res2.json();
      expect(body.error).toContain('min 30s interval');
      expect(res2.headers.get('Retry-After')).toBeTruthy();
    });

    it('should reject 3rd heartbeat within 60s (max 2 per minute)', async () => {
      await registerServer('server-hb-3');

      // First heartbeat at t=0
      const res1 = await sendHeartbeat('server-hb-3');
      expect(res1.status).toBe(200);

      // Simulate 31s passing by updating DO storage directly
      const hbKey = 'heartbeat-rl:server-hb-3';
      const entry = await doState.storage.get(hbKey);
      const windowStart = entry.windowStart;
      await doState.storage.put(hbKey, {
        count: 1,
        windowStart: windowStart,
        lastRequestAt: Date.now() - 31000, // 31s ago
      });

      // Second heartbeat at t=31s
      const res2 = await sendHeartbeat('server-hb-3');
      expect(res2.status).toBe(200);

      // Simulate 31s passing again (still within the 60s window)
      const entry2 = await doState.storage.get(hbKey);
      await doState.storage.put(hbKey, {
        count: entry2.count,
        windowStart: entry2.windowStart,
        lastRequestAt: Date.now() - 31000,
      });

      // Third heartbeat should be rejected (count >= 2 within window)
      const res3 = await sendHeartbeat('server-hb-3');
      expect(res3.status).toBe(429);
      const body = await res3.json();
      expect(body.error).toContain('Heartbeat rate limit exceeded');
    });

    it('should allow heartbeats for different serverIds independently', async () => {
      await registerServer('server-A');
      await registerServer('server-B');

      const resA = await sendHeartbeat('server-A');
      expect(resA.status).toBe(200);

      // server-B should not be affected by server-A's heartbeat
      const resB = await sendHeartbeat('server-B');
      expect(resB.status).toBe(200);
    });

    it('should reset heartbeat window after 60s', async () => {
      await registerServer('server-hb-reset');

      // First heartbeat
      const res1 = await sendHeartbeat('server-hb-reset');
      expect(res1.status).toBe(200);

      // Simulate window expiry (61s ago) by updating storage
      const hbKey = 'heartbeat-rl:server-hb-reset';
      await doState.storage.put(hbKey, {
        count: 2,
        windowStart: Date.now() - 61000,
        lastRequestAt: Date.now() - 31000,
      });

      // Should be allowed (new window)
      const res2 = await sendHeartbeat('server-hb-reset');
      expect(res2.status).toBe(200);
    });

    it('should return 429 with Retry-After header on heartbeat rate limit', async () => {
      await registerServer('server-hb-headers');
      await sendHeartbeat('server-hb-headers');

      const res = await sendHeartbeat('server-hb-headers');
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      expect(parseInt(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    });

    it('should clean up heartbeat rate limit entries in alarm()', async () => {
      await registerServer('server-cleanup');
      await sendHeartbeat('server-cleanup');

      // Verify heartbeat-rl entry exists
      const hbKey = 'heartbeat-rl:server-cleanup';
      expect(await doState.storage.get(hbKey)).toBeTruthy();

      // Simulate server going stale (lastSeen > TTL)
      const serverEntry = await doState.storage.get('server:server-cleanup');
      serverEntry.lastSeen = Date.now() - 6 * 60 * 1000; // 6 minutes ago (past 5-min TTL)
      await doState.storage.put('server:server-cleanup', serverEntry);

      // Run alarm cleanup
      await doInstance.alarm();

      // heartbeat-rl entry should be cleaned up along with the server
      expect(await doState.storage.get(hbKey)).toBeUndefined();
      expect(await doState.storage.get('server:server-cleanup')).toBeUndefined();
    });
  });
});
