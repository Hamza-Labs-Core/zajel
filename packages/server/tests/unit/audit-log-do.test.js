import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditLogDO } from '../../src/durable-objects/audit-log-do.js';

/**
 * Create a mock DurableObjectStorage with in-memory Map.
 */
function createMockStorage() {
  const data = new Map();
  return {
    data,
    get: vi.fn(async (key) => data.get(key)),
    put: vi.fn(async (key, value) => {
      if (key instanceof Map) {
        for (const [k, v] of key) {
          data.set(k, v);
        }
      } else {
        data.set(key, value);
      }
    }),
    delete: vi.fn(async (keys) => {
      if (Array.isArray(keys)) {
        for (const key of keys) {
          data.delete(key);
        }
      } else {
        data.delete(keys);
      }
    }),
    list: vi.fn(async ({ prefix }) => {
      const result = new Map();
      for (const [key, value] of data) {
        if (key.startsWith(prefix)) {
          result.set(key, value);
        }
      }
      return result;
    }),
  };
}

/**
 * Create a mock environment.
 */
function createMockEnv(overrides = {}) {
  return {
    AUDIT_LOG_SECRET: 'test-admin-secret',
    AUDIT_LOG_INTERNAL_TOKEN: 'test-internal-token',
    ALLOWED_ORIGINS: '*',
    ...overrides,
  };
}

/**
 * Create an AuditLogDO instance with mock state/env.
 */
function createAuditLogDO(envOverrides = {}) {
  const storage = createMockStorage();
  const env = createMockEnv(envOverrides);
  const state = { storage };
  return { do: new AuditLogDO(state, env), storage, env };
}

describe('AuditLogDO', () => {
  describe('POST /log - append event', () => {
    it('should append audit event with valid internal token', async () => {
      const { do: auditLog } = createAuditLogDO();

      const request = new Request('https://audit-log/log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': 'test-internal-token',
        },
        body: JSON.stringify({
          action: 'server_register',
          serverId: 'test-server',
          timestamp: Date.now(),
          metadata: { ip: '1.2.3.4' },
        }),
      });

      const response = await auditLog.fetch(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.eventId).toBe(1);
    });

    it('should reject POST without internal token', async () => {
      const { do: auditLog } = createAuditLogDO();

      const request = new Request('https://audit-log/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'server_register',
          timestamp: Date.now(),
        }),
      });

      const response = await auditLog.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should accept POST without internal token when AUDIT_LOG_INTERNAL_TOKEN is not set', async () => {
      const { do: auditLog } = createAuditLogDO({ AUDIT_LOG_INTERNAL_TOKEN: undefined });

      const request = new Request('https://audit-log/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'server_register',
          serverId: 'test-server',
          timestamp: Date.now(),
        }),
      });

      const response = await auditLog.fetch(request);
      expect(response.status).toBe(200);
    });

    it('should reject POST with missing required fields', async () => {
      const { do: auditLog } = createAuditLogDO();

      const request = new Request('https://audit-log/log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': 'test-internal-token',
        },
        body: JSON.stringify({
          serverId: 'test-server',
          // Missing 'action' and 'timestamp'
        }),
      });

      const response = await auditLog.fetch(request);
      expect(response.status).toBe(400);
    });

    it('should assign sequential event IDs', async () => {
      const { do: auditLog } = createAuditLogDO();

      for (let i = 1; i <= 3; i++) {
        const request = new Request('https://audit-log/log', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': 'test-internal-token',
          },
          body: JSON.stringify({
            action: `event_${i}`,
            timestamp: Date.now(),
          }),
        });

        const response = await auditLog.fetch(request);
        const body = await response.json();
        expect(body.eventId).toBe(i);
      }
    });
  });

  describe('GET /log - read events', () => {
    it('should return events with valid admin auth', async () => {
      const { do: auditLog } = createAuditLogDO();

      // First, add some events
      for (let i = 0; i < 3; i++) {
        await auditLog.fetch(new Request('https://audit-log/log', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': 'test-internal-token',
          },
          body: JSON.stringify({
            action: `action_${i}`,
            serverId: `server_${i}`,
            timestamp: Date.now(),
          }),
        }));
      }

      // Read events
      const request = new Request('https://audit-log/log', {
        headers: { 'Authorization': 'Bearer test-admin-secret' },
      });

      const response = await auditLog.fetch(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.total).toBe(3);
      expect(body.events).toHaveLength(3);
    });

    it('should reject GET without admin auth', async () => {
      const { do: auditLog } = createAuditLogDO();

      const request = new Request('https://audit-log/log');
      const response = await auditLog.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should filter events by action', async () => {
      const { do: auditLog } = createAuditLogDO();

      // Add events of different types
      const events = [
        { action: 'server_register', serverId: 's1', timestamp: Date.now() },
        { action: 'server_unregister', serverId: 's1', timestamp: Date.now() },
        { action: 'server_register', serverId: 's2', timestamp: Date.now() },
      ];

      for (const event of events) {
        await auditLog.fetch(new Request('https://audit-log/log', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': 'test-internal-token',
          },
          body: JSON.stringify(event),
        }));
      }

      const request = new Request('https://audit-log/log?action=server_register', {
        headers: { 'Authorization': 'Bearer test-admin-secret' },
      });

      const response = await auditLog.fetch(request);
      const body = await response.json();
      expect(body.total).toBe(2);
      expect(body.events.every(e => e.action === 'server_register')).toBe(true);
    });

    it('should filter events by serverId', async () => {
      const { do: auditLog } = createAuditLogDO();

      const events = [
        { action: 'server_register', serverId: 'server-a', timestamp: Date.now() },
        { action: 'server_register', serverId: 'server-b', timestamp: Date.now() },
        { action: 'server_unregister', serverId: 'server-a', timestamp: Date.now() },
      ];

      for (const event of events) {
        await auditLog.fetch(new Request('https://audit-log/log', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': 'test-internal-token',
          },
          body: JSON.stringify(event),
        }));
      }

      const request = new Request('https://audit-log/log?serverId=server-a', {
        headers: { 'Authorization': 'Bearer test-admin-secret' },
      });

      const response = await auditLog.fetch(request);
      const body = await response.json();
      expect(body.total).toBe(2);
      expect(body.events.every(e => e.serverId === 'server-a')).toBe(true);
    });
  });

  describe('404 for unknown paths', () => {
    it('should return 404 for unknown paths', async () => {
      const { do: auditLog } = createAuditLogDO();
      const request = new Request('https://audit-log/unknown');
      const response = await auditLog.fetch(request);
      expect(response.status).toBe(404);
    });
  });
});
