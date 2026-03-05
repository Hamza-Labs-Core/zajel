/**
 * Unit tests for notification route handlers (US-8.1)
 *
 * Mocks auth to always succeed and uses a mock D1 database
 * to test query logic, validation, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleListNotifications,
  handleUnreadCount,
  handleMarkRead,
  handleMarkAllRead,
} from '../../src/routes/notifications.js';
import type { Env, ApiResponse, NotificationsListData } from '../../src/types.js';

// ─── Mock Auth ──────────────────────────────────

vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'test-user-id',
    username: 'admin',
    role: 'admin' as const,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

// ─── Mock D1 Helpers ────────────────────────────

interface MockD1Results {
  results: Record<string, unknown>[];
  success: boolean;
}

function createMockD1(queryHandlers: Array<{
  pattern: RegExp;
  first?: Record<string, unknown> | null;
  all?: MockD1Results;
  run?: { success: boolean; meta?: { changes: number } };
}>) {
  const stmtCache: Array<{ all: () => Promise<unknown> }> = [];

  const db = {
    prepare: vi.fn((sql: string) => {
      const handler = queryHandlers.find((h) => h.pattern.test(sql));

      // For batch: all() falls back to wrapping first in an array if all not specified
      const allResult = handler?.all
        ?? (handler?.first !== undefined && handler?.first !== null
          ? { results: [handler.first], success: true }
          : { results: [], success: true });

      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(handler?.first ?? null),
        all: vi.fn().mockResolvedValue(allResult),
        run: vi.fn().mockResolvedValue(handler?.run ?? { success: true, meta: { changes: 0 } }),
      };

      // Track statements so batch can call all() on them
      stmtCache.push(stmt);

      return stmt;
    }),
    batch: vi.fn(async (stmts: Array<{ all: () => Promise<unknown> }>) => {
      return Promise.all(stmts.map((s) => s.all()));
    }),
  };

  return db;
}

// ─── Sample Data ────────────────────────────────

const now = Date.now();

const sampleNotificationRow = {
  id: 1,
  rule_id: 42,
  severity: 'critical',
  title: 'Server offline: vps-us-east-1',
  message: 'Server vps-us-east-1 has been offline for 5+ minutes',
  source: 'server_offline',
  channels_notified: JSON.stringify(['dashboard', 'webhook']),
  created_at: now - 3600000,
  read_at: null,
  read_by: null,
  acknowledged_at: null,
  acknowledged_by: null,
};

const sampleNotificationRow2 = {
  id: 2,
  rule_id: null,
  severity: 'info',
  title: 'New deployment detected',
  message: 'Version 1.5.0 deployed to production',
  source: 'deployment',
  channels_notified: JSON.stringify(['dashboard']),
  created_at: now - 7200000,
  read_at: now - 3600000,
  read_by: 'admin',
  acknowledged_at: null,
  acknowledged_by: null,
};

// ─── Helper: Build Env ──────────────────────────

function makeEnv(db?: ReturnType<typeof createMockD1>): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    DIAGNOSTICS_DB: db as unknown as D1Database | undefined,
  } as Env;
}

function makeRequest(url: string, method = 'GET', body?: string): Request {
  const init: RequestInit = {
    method,
    headers: {
      'Authorization': 'Bearer fake-jwt-token',
      'Content-Type': 'application/json',
    },
  };
  if (body) {
    init.body = body;
  }
  return new Request(url, init);
}

// ─── Tests ──────────────────────────────────────

describe('handleListNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated results with correct shape', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT COUNT/,
        first: { total: 2 },
      },
      {
        pattern: /SELECT id, rule_id/,
        all: { results: [sampleNotificationRow, sampleNotificationRow2], success: true },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/notifications');
    const res = await handleListNotifications(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<NotificationsListData>;
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data!.notifications).toHaveLength(2);
    expect(body.data!.total).toBe(2);
    expect(body.data!.limit).toBe(50);
    expect(body.data!.offset).toBe(0);
    expect(body.data!.lastUpdated).toBeGreaterThan(0);

    // Verify camelCase mapping
    const notification = body.data!.notifications[0]!;
    expect(notification.id).toBe(1);
    expect(notification.ruleId).toBe(42);
    expect(notification.severity).toBe('critical');
    expect(notification.title).toBe('Server offline: vps-us-east-1');
    expect(notification.source).toBe('server_offline');
    expect(notification.channelsNotified).toEqual(['dashboard', 'webhook']);
    expect(notification.readAt).toBeNull();
    expect(notification.readBy).toBeNull();
  });

  it('filters by severity', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT COUNT/,
        first: { total: 1 },
      },
      {
        pattern: /SELECT id, rule_id/,
        all: { results: [sampleNotificationRow], success: true },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/notifications?severity=critical');
    const res = await handleListNotifications(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<NotificationsListData>;
    expect(body.success).toBe(true);

    const prepareCall = db.prepare.mock.calls.find(
      (c) => typeof c[0] === 'string' && /SELECT COUNT/.test(c[0] as string)
    );
    expect(prepareCall).toBeDefined();
    expect(prepareCall![0]).toContain('WHERE');
  });

  it('filters by unreadOnly', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT COUNT/,
        first: { total: 1 },
      },
      {
        pattern: /SELECT id, rule_id/,
        all: { results: [sampleNotificationRow], success: true },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/notifications?unreadOnly=true');
    const res = await handleListNotifications(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<NotificationsListData>;
    expect(body.success).toBe(true);

    const prepareCall = db.prepare.mock.calls.find(
      (c) => typeof c[0] === 'string' && /SELECT COUNT/.test(c[0] as string)
    );
    expect(prepareCall).toBeDefined();
    expect(prepareCall![0]).toContain('read_at IS NULL');
  });

  it('rejects invalid severity', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/notifications?severity=extreme');
    const res = await handleListNotifications(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('severity');
  });

  it('validates limit -- rejects values > 200', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/notifications?limit=300');
    const res = await handleListNotifications(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('limit');
  });

  it('validates limit -- rejects values < 1', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/notifications?limit=0');
    const res = await handleListNotifications(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('limit');
  });

  it('validates offset -- rejects negative values', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/notifications?offset=-1');
    const res = await handleListNotifications(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('offset');
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest('https://admin.example.com/admin/api/notifications');
    const res = await handleListNotifications(req, makeEnv(undefined));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<NotificationsListData>;
    expect(body.success).toBe(true);
    expect(body.data!.notifications).toHaveLength(0);
    expect(body.data!.total).toBe(0);
  });

  it('returns 500 with generic message on D1 error (no error leakage)', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: disk I/O error')),
        all: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: disk I/O error')),
        run: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: disk I/O error')),
      })),
      batch: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: disk I/O error')),
    };

    const req = makeRequest('https://admin.example.com/admin/api/notifications');
    const res = await handleListNotifications(req, makeEnv(db as ReturnType<typeof createMockD1>));

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to retrieve notifications');
    expect(body.error).not.toContain('D1_INTERNAL');
    expect(body.error).not.toContain('disk');
  });
});

describe('handleUnreadCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns unread count', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT COUNT/,
        first: { count: 5 },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/notifications/unread-count');
    const res = await handleUnreadCount(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ count: number }>;
    expect(body.success).toBe(true);
    expect(body.data!.count).toBe(5);
  });

  it('returns 0 when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest('https://admin.example.com/admin/api/notifications/unread-count');
    const res = await handleUnreadCount(req, makeEnv(undefined));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ count: number }>;
    expect(body.success).toBe(true);
    expect(body.data!.count).toBe(0);
  });

  it('returns 500 with generic message on D1 error', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: query failed')),
        all: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: query failed')),
        run: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: query failed')),
      })),
    };

    const req = makeRequest('https://admin.example.com/admin/api/notifications/unread-count');
    const res = await handleUnreadCount(req, makeEnv(db as ReturnType<typeof createMockD1>));

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to retrieve unread count');
    expect(body.error).not.toContain('D1_INTERNAL');
  });
});

describe('handleMarkRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks a notification as read', async () => {
    const readRow = { ...sampleNotificationRow, read_at: now, read_by: 'admin' };

    const db = {
      prepare: vi.fn((sql: string) => {
        const isUpdate = /UPDATE/.test(sql);

        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(isUpdate ? null : sampleNotificationRow),
          all: vi.fn().mockResolvedValue(
            isUpdate
              ? { results: [], success: true }
              : { results: [readRow], success: true }
          ),
          run: vi.fn().mockResolvedValue({ success: true }),
        };
      }),
      batch: vi.fn(async (stmts: Array<{ all: () => Promise<unknown> }>) => {
        return Promise.all(stmts.map((s) => s.all()));
      }),
    };

    const req = makeRequest('https://admin.example.com/admin/api/notifications/1/read', 'POST');
    const res = await handleMarkRead(req, makeEnv(db as ReturnType<typeof createMockD1>), '1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ notification: { readAt: number } }>;
    expect(body.success).toBe(true);
    expect(body.data!.notification.readAt).toBe(now);
  });

  it('returns 404 for non-existent notification', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT[\s\S]*FROM notifications WHERE id/,
        first: null,
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/notifications/999/read', 'POST');
    const res = await handleMarkRead(req, makeEnv(db), '999');

    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Notification not found');
  });

  it('returns 400 for non-numeric id', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/notifications/abc/read', 'POST');
    const res = await handleMarkRead(req, makeEnv(db), 'abc');

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid notification ID');
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest('https://admin.example.com/admin/api/notifications/1/read', 'POST');
    const res = await handleMarkRead(req, makeEnv(undefined), '1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(true);
  });

  it('returns 500 with generic message on D1 error', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: constraint violation')),
        all: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: constraint violation')),
        run: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: constraint violation')),
      })),
    };

    const req = makeRequest('https://admin.example.com/admin/api/notifications/1/read', 'POST');
    const res = await handleMarkRead(req, makeEnv(db as ReturnType<typeof createMockD1>), '1');

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to mark notification as read');
    expect(body.error).not.toContain('D1_INTERNAL');
  });
});

describe('handleMarkAllRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks all unread notifications as read', async () => {
    const db = createMockD1([
      {
        pattern: /UPDATE notifications SET read_at/,
        run: { success: true, meta: { changes: 3 } },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/notifications/read-all', 'POST');
    const res = await handleMarkAllRead(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ updated: number }>;
    expect(body.success).toBe(true);
    expect(body.data!.updated).toBe(3);
  });

  it('returns 200 with 0 updated when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest('https://admin.example.com/admin/api/notifications/read-all', 'POST');
    const res = await handleMarkAllRead(req, makeEnv(undefined));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ updated: number }>;
    expect(body.success).toBe(true);
    expect(body.data!.updated).toBe(0);
  });

  it('returns 500 with generic message on D1 error', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: error')),
        all: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: error')),
        run: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: error')),
      })),
    };

    const req = makeRequest('https://admin.example.com/admin/api/notifications/read-all', 'POST');
    const res = await handleMarkAllRead(req, makeEnv(db as ReturnType<typeof createMockD1>));

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to mark all notifications as read');
    expect(body.error).not.toContain('D1_INTERNAL');
  });
});

// ─── Auth Enforcement ───────────────────────────

describe('Auth enforcement for notification handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleListNotifications returns 401 when auth fails', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);
    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest('https://admin.example.com/admin/api/notifications');
    const res = await handleListNotifications(req, makeEnv());

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('handleUnreadCount returns 401 when auth fails', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);
    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest('https://admin.example.com/admin/api/notifications/unread-count');
    const res = await handleUnreadCount(req, makeEnv());

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('handleMarkRead returns 401 when auth fails', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);
    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest('https://admin.example.com/admin/api/notifications/1/read', 'POST');
    const res = await handleMarkRead(req, makeEnv(), '1');

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('handleMarkAllRead returns 401 when auth fails', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);
    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest('https://admin.example.com/admin/api/notifications/read-all', 'POST');
    const res = await handleMarkAllRead(req, makeEnv());

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });
});
