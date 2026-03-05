/**
 * Unit tests for NotificationDO (US-8.1, US-8.2, US-8.3)
 *
 * Tests notification storage, broadcast, email/webhook dispatch, and retry logic.
 * Uses mocked DurableObject state and environment bindings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env, StoredNotification, NotificationPayload } from '../../src/types.js';
import { NotificationDO } from '../../src/notification-do.js';

// ─── Polyfill CF Workers globals (vi.hoisted runs before module evaluation) ──

vi.hoisted(() => {
  if (typeof globalThis.WebSocketRequestResponsePair === 'undefined') {
    (globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {
      constructor(public request: string, public response: string) {}
    };
  }
  if (typeof globalThis.WebSocketPair === 'undefined') {
    (globalThis as Record<string, unknown>).WebSocketPair = class {
      0: unknown;
      1: unknown;
      constructor() {
        this[0] = { send() {}, close() {}, readyState: 1 };
        this[1] = { send() {}, close() {}, readyState: 1, serializeAttachment() {}, deserializeAttachment() { return null; } };
      }
    };
  }
});

// ─── Mock Crypto (for JWT verify and generateId) ──

vi.mock('../../src/crypto.js', () => ({
  generateId: vi.fn(() => 'mock-notif-id-001'),
  generateJwt: vi.fn(async () => 'mock-jwt-token'),
  verifyJwt: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return {
        sub: 'user-1',
        username: 'testadmin',
        role: 'super-admin' as const,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    }
    return null;
  }),
}));

// ─── Mock Email Module ────────────────────────────

vi.mock('../../src/email.js', () => ({
  buildEmailSubject: vi.fn(() => '[Zajel Alert - CRITICAL] Test'),
  buildEmailHtml: vi.fn(() => '<html>Test email</html>'),
  buildRawMimeEmail: vi.fn(() => 'From: test\r\nTo: test\r\n\r\nTest'),
  getSenderEmail: vi.fn(() => 'notifications@zajel.hamzalabs.dev'),
  passesSeverityFilter: vi.fn(() => true),
  hashEmail: vi.fn(async () => 'hashed-email'),
}));

// ─── Mock Webhook Module ──────────────────────────

vi.mock('../../src/webhook.js', () => ({
  buildWebhookPayload: vi.fn(() => ({
    body: '{"test":true}',
    contentType: 'application/json',
  })),
}));

// ─── Mock DO State ────────────────────────────────

function createMockStorage() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
      return store.get(key) as T | undefined;
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
      return true;
    }),
    list: vi.fn(async <T>(options?: { prefix?: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>> => {
      const result = new Map<string, T>();
      const entries = Array.from(store.entries())
        .filter(([k]) => !options?.prefix || k.startsWith(options.prefix))
        .sort(([a], [b]) => options?.reverse ? b.localeCompare(a) : a.localeCompare(b));

      const limited = options?.limit ? entries.slice(0, options.limit) : entries;
      for (const [k, v] of limited) {
        result.set(k, v as T);
      }
      return result;
    }),
    setAlarm: vi.fn(async (time: number) => {
      alarm = time;
    }),
    getAlarm: vi.fn(async () => alarm),
    _store: store,
  };
}

function createMockWebSocket() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
    serializeAttachment: vi.fn(),
    deserializeAttachment: vi.fn(() => ({
      userId: 'user-1',
      username: 'testadmin',
      role: 'super-admin',
      connectedAt: Date.now(),
    })),
  };
}

function createMockState(storage: ReturnType<typeof createMockStorage>) {
  const mockWebSockets: ReturnType<typeof createMockWebSocket>[] = [];

  return {
    storage,
    id: { toString: () => 'test-do-id' },
    setWebSocketAutoResponse: vi.fn(),
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn(() => mockWebSockets),
    _mockWebSockets: mockWebSockets,
  };
}

function createMockD1(queryResults: Record<string, { results?: unknown[]; success: boolean }> = {}) {
  return {
    prepare: vi.fn((sql: string) => {
      // Find matching query
      const key = Object.keys(queryResults).find((k) => sql.includes(k));
      const result = key ? queryResults[key] : { results: [], success: true };

      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn(async () => result.results?.[0] ?? null),
        all: vi.fn(async () => result),
        run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
      };
    }),
    batch: vi.fn(async (stmts: Array<{ all: () => Promise<unknown> }>) => {
      return Promise.all(stmts.map((s) => s.all()));
    }),
  };
}

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  };
}

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    DIAGNOSTICS_DB: createMockD1() as unknown as D1Database,
    ADMIN_KV: createMockKV() as unknown as KVNamespace,
    ...overrides,
  } as Env;
}

// ─── Tests ──────────────────────────────────────

describe('NotificationDO', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let state: ReturnType<typeof createMockState>;
  let env: Env;
  let notifDO: NotificationDO;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
    state = createMockState(storage);
    env = createMockEnv();
    notifDO = new NotificationDO(
      state as unknown as DurableObjectState,
      env
    );
  });

  describe('fetch() routing', () => {
    it('returns 404 for unknown paths', async () => {
      const req = new Request('http://do/unknown');
      const res = await notifDO.fetch(req);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /notify', () => {
    it('stores notification and returns success', async () => {
      const payload: NotificationPayload = {
        severity: 'critical',
        title: 'Test alert',
        message: 'This is a test alert.',
        category: 'system',
      };

      const req = new Request('http://do/notify', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await notifDO.fetch(req);
      expect(res.status).toBe(200);

      const body = await res.json() as { success: boolean; data: { id: string; delivered: number } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('mock-notif-id-001');
      expect(typeof body.data.delivered).toBe('number');

      // Verify stored in DO storage
      expect(storage.put).toHaveBeenCalled();
      const storedCalls = storage.put.mock.calls;
      const notifCall = storedCalls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('notification:')
      );
      expect(notifCall).toBeDefined();
    });

    it('rejects missing required fields', async () => {
      const req = new Request('http://do/notify', {
        method: 'POST',
        body: JSON.stringify({ severity: 'info' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await notifDO.fetch(req);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing required fields');
    });

    it('rejects invalid JSON', async () => {
      const req = new Request('http://do/notify', {
        method: 'POST',
        body: 'not-json{',
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await notifDO.fetch(req);
      expect(res.status).toBe(400);
    });

    it('broadcasts to connected WebSockets', async () => {
      const mockWs = createMockWebSocket();
      state._mockWebSockets.push(mockWs as unknown as ReturnType<typeof createMockWebSocket>);

      const payload: NotificationPayload = {
        severity: 'warning',
        title: 'Broadcast test',
        message: 'Testing broadcast.',
        category: 'system',
      };

      const req = new Request('http://do/notify', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await notifDO.fetch(req);
      expect(res.status).toBe(200);

      const body = await res.json() as { success: boolean; data: { delivered: number } };
      expect(body.data.delivered).toBe(1);

      // Verify WebSocket received the message
      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sentMsg = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sentMsg.type).toBe('notification');
      expect(sentMsg.data.title).toBe('Broadcast test');
    });

    it('broadcasts to multiple WebSockets', async () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      state._mockWebSockets.push(
        ws1 as unknown as ReturnType<typeof createMockWebSocket>,
        ws2 as unknown as ReturnType<typeof createMockWebSocket>
      );

      const req = new Request('http://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          severity: 'info',
          title: 'Multi broadcast',
          message: 'Testing.',
          category: 'system',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await notifDO.fetch(req);
      const body = await res.json() as { data: { delivered: number } };
      expect(body.data.delivered).toBe(2);
    });

    it('handles WebSocket send errors gracefully', async () => {
      const ws1 = createMockWebSocket();
      ws1.send.mockImplementation(() => {
        throw new Error('WebSocket closed');
      });
      const ws2 = createMockWebSocket();
      state._mockWebSockets.push(
        ws1 as unknown as ReturnType<typeof createMockWebSocket>,
        ws2 as unknown as ReturnType<typeof createMockWebSocket>
      );

      const req = new Request('http://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          severity: 'info',
          title: 'Error test',
          message: 'Testing error handling.',
          category: 'system',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await notifDO.fetch(req);
      const body = await res.json() as { data: { delivered: number } };
      // ws1 failed, ws2 succeeded
      expect(body.data.delivered).toBe(1);
    });
  });

  describe('GET /notifications', () => {
    it('returns stored notifications', async () => {
      // Pre-populate storage with notifications
      const notif1: StoredNotification = {
        id: 'id-1',
        severity: 'critical',
        title: 'Alert 1',
        message: 'First alert',
        category: 'system',
        timestamp: Date.now() - 1000,
        readBy: [],
      };
      const notif2: StoredNotification = {
        id: 'id-2',
        severity: 'info',
        title: 'Alert 2',
        message: 'Second alert',
        category: 'system',
        timestamp: Date.now(),
        readBy: [],
      };
      await storage.put(`notification:${notif1.timestamp}:${notif1.id}`, notif1);
      await storage.put(`notification:${notif2.timestamp}:${notif2.id}`, notif2);

      const req = new Request('http://do/notifications?limit=50');
      const res = await notifDO.fetch(req);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: { notifications: StoredNotification[] };
      };
      expect(body.success).toBe(true);
      expect(body.data.notifications).toHaveLength(2);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await storage.put(`notification:${Date.now() + i}:id-${i}`, {
          id: `id-${i}`,
          severity: 'info',
          title: `Alert ${i}`,
          message: `Alert message ${i}`,
          category: 'system',
          timestamp: Date.now() + i,
          readBy: [],
        });
      }

      const req = new Request('http://do/notifications?limit=3');
      const res = await notifDO.fetch(req);
      const body = await res.json() as {
        data: { notifications: StoredNotification[] };
      };
      expect(body.data.notifications).toHaveLength(3);
    });
  });

  describe('WebSocket upgrade', () => {
    it('returns 401 when token is missing', async () => {
      const req = new Request('http://do/ws');
      const res = await notifDO.fetch(req);
      expect(res.status).toBe(401);

      const body = await res.json() as { error: string };
      expect(body.error).toContain('Missing token');
    });

    it('returns 401 for invalid token', async () => {
      const req = new Request('http://do/ws?token=invalid-token');
      const res = await notifDO.fetch(req);
      expect(res.status).toBe(401);

      const body = await res.json() as { error: string };
      expect(body.error).toContain('Invalid');
    });
  });

  describe('webSocketMessage()', () => {
    it('handles mark_read message', async () => {
      // Store a notification first
      const notif: StoredNotification = {
        id: 'notif-to-read',
        severity: 'info',
        title: 'Read test',
        message: 'Testing.',
        category: 'system',
        timestamp: Date.now(),
        readBy: [],
      };
      await storage.put(`notification:${notif.timestamp}:${notif.id}`, notif);

      const mockWs = createMockWebSocket();

      await notifDO.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({ type: 'mark_read', id: 'notif-to-read' })
      );

      // Verify read_ack was sent
      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sentMsg = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sentMsg.type).toBe('read_ack');
      expect(sentMsg.id).toBe('notif-to-read');

      // Verify readBy was updated in storage
      const stored = storage._store.get(`notification:${notif.timestamp}:${notif.id}`) as StoredNotification;
      expect(stored.readBy).toContain('user-1');
    });

    it('handles mark_all_read message', async () => {
      // Store two notifications
      const ts = Date.now();
      await storage.put(`notification:${ts}:id-1`, {
        id: 'id-1',
        severity: 'info',
        title: 'N1',
        message: 'N1',
        category: 'system',
        timestamp: ts,
        readBy: [],
      });
      await storage.put(`notification:${ts + 1}:id-2`, {
        id: 'id-2',
        severity: 'info',
        title: 'N2',
        message: 'N2',
        category: 'system',
        timestamp: ts + 1,
        readBy: [],
      });

      const mockWs = createMockWebSocket();

      await notifDO.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({ type: 'mark_all_read' })
      );

      // Verify both notifications have user-1 in readBy
      const n1 = storage._store.get(`notification:${ts}:id-1`) as StoredNotification;
      const n2 = storage._store.get(`notification:${ts + 1}:id-2`) as StoredNotification;
      expect(n1.readBy).toContain('user-1');
      expect(n2.readBy).toContain('user-1');
    });

    it('handles invalid JSON gracefully', async () => {
      const mockWs = createMockWebSocket();

      // Should not throw
      await notifDO.webSocketMessage(
        mockWs as unknown as WebSocket,
        'not-valid-json{'
      );
    });
  });

  describe('webSocketClose()', () => {
    it('handles close without throwing', async () => {
      const mockWs = createMockWebSocket();

      // Should not throw
      await notifDO.webSocketClose(
        mockWs as unknown as WebSocket,
        1000,
        'Normal closure',
        true
      );
    });
  });

  describe('webSocketError()', () => {
    it('handles error without throwing', async () => {
      const mockWs = createMockWebSocket();

      // Should not throw
      await notifDO.webSocketError(
        mockWs as unknown as WebSocket,
        new Error('test error')
      );
    });
  });

  describe('notification storage pruning', () => {
    it('prunes oldest notifications when exceeding 200 cap', async () => {
      // Store 201 notifications
      for (let i = 0; i < 201; i++) {
        const ts = 1000000 + i;
        await storage.put(`notification:${ts}:id-${i}`, {
          id: `id-${i}`,
          severity: 'info',
          title: `Alert ${i}`,
          message: `Message ${i}`,
          category: 'system',
          timestamp: ts,
          readBy: [],
        });
      }

      // Send a notification to trigger pruning
      const req = new Request('http://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          severity: 'info',
          title: 'Trigger prune',
          message: 'This should trigger pruning.',
          category: 'system',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      await notifDO.fetch(req);

      // The storage.delete should have been called for excess entries
      expect(storage.delete).toHaveBeenCalled();
    });
  });
});

describe('NotificationDO alarm (webhook retry)', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let state: ReturnType<typeof createMockState>;
  let env: Env;
  let notifDO: NotificationDO;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
    state = createMockState(storage);
    env = createMockEnv();
    notifDO = new NotificationDO(
      state as unknown as DurableObjectState,
      env
    );
  });

  it('processes retry entries in alarm handler', async () => {
    // Store a retry entry
    const retryPayload = {
      webhookConfigId: 1,
      url: 'https://hooks.example.com/test',
      format: 'generic' as const,
      payload: {
        severity: 'critical' as const,
        title: 'Retry test',
        message: 'Testing retry.',
        category: 'system' as const,
      },
      firstAttemptAt: Date.now() - 30000,
      errorMessage: 'HTTP 500',
    };
    await storage.put('retry:123456:1', retryPayload);

    // Mock global fetch for webhook retry
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200 })
    );

    try {
      await notifDO.alarm();

      // Verify fetch was called with the retry URL
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://hooks.example.com/test',
        expect.objectContaining({
          method: 'POST',
        })
      );

      // Verify retry key was deleted
      expect(storage.delete).toHaveBeenCalledWith('retry:123456:1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('deletes retry keys even on failed retry', async () => {
    const retryPayload = {
      webhookConfigId: 1,
      url: 'https://hooks.example.com/fail',
      format: 'generic' as const,
      payload: {
        severity: 'critical' as const,
        title: 'Fail retry test',
        message: 'Testing failed retry.',
        category: 'system' as const,
      },
      firstAttemptAt: Date.now() - 30000,
    };
    await storage.put('retry:123456:1', retryPayload);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    try {
      await notifDO.alarm();

      // Retry key should still be deleted (single retry only)
      expect(storage.delete).toHaveBeenCalledWith('retry:123456:1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does nothing when no retry entries exist', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();

    try {
      await notifDO.alarm();

      // fetch should not have been called
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
