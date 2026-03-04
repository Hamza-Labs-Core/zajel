/**
 * Unit tests for notification configuration route handlers (US-8.2, US-8.3)
 *
 * Mocks auth to always succeed (as super-admin by default) and uses a mock
 * D1 database to test config CRUD, validation, and dispatch testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleGetNotificationConfig,
  handleUpdateNotificationConfig,
  handleTestNotification,
} from '../../src/routes/notification-config.js';
import type { Env, ApiResponse, NotificationConfigData, NotificationConfigEntry } from '../../src/types.js';

// ─── Mock Auth ──────────────────────────────────

vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'test-user-id',
    username: 'superadmin',
    role: 'super-admin' as const,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
  requireSuperAdmin: vi.fn().mockResolvedValue({
    sub: 'test-user-id',
    username: 'superadmin',
    role: 'super-admin' as const,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

function makeSuperAdminPayload() {
  return {
    sub: 'test-user-id',
    username: 'superadmin',
    role: 'super-admin' as const,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

// ─── Mock Dispatch ──────────────────────────────

vi.mock('../../src/routes/notification-dispatch.js', () => ({
  dispatchWebhook: vi.fn().mockResolvedValue({ sent: true, statusCode: 200 }),
  dispatchEmail: vi.fn().mockResolvedValue({ sent: true }),
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
  run?: { success: boolean };
}>) {
  return {
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
        run: vi.fn().mockResolvedValue(handler?.run ?? { success: true }),
      };

      return stmt;
    }),
    batch: vi.fn(async (stmts: Array<{ all: () => Promise<unknown> }>) => {
      return Promise.all(stmts.map((s) => s.all()));
    }),
  };
}

// ─── Sample Data ────────────────────────────────

const now = Date.now();

const sampleWebhookConfigRow = {
  id: 1,
  channel_type: 'webhook',
  enabled: 1,
  config: JSON.stringify({
    url: 'https://hooks.slack.com/services/xxx',
    authHeader: 'Bearer slack-token',
    severityFilter: ['critical', 'warning'],
  }),
  updated_at: now - 86400000,
  updated_by: 'superadmin',
};

const sampleEmailConfigRow = {
  id: 2,
  channel_type: 'email',
  enabled: 1,
  config: JSON.stringify({
    addresses: ['admin@example.com'],
    severityFilter: ['critical'],
    cooldownMinutes: 30,
  }),
  updated_at: now - 86400000,
  updated_by: 'superadmin',
};

const sampleDashboardConfigRow = {
  id: 3,
  channel_type: 'dashboard',
  enabled: 1,
  config: JSON.stringify({
    soundEnabled: true,
    severityFilter: ['critical', 'warning', 'info'],
  }),
  updated_at: now - 86400000,
  updated_by: 'superadmin',
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

describe('handleGetNotificationConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all channel configs', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT id, channel_type/,
        all: {
          results: [sampleWebhookConfigRow, sampleEmailConfigRow, sampleDashboardConfigRow],
          success: true,
        },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config');
    const res = await handleGetNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<NotificationConfigData>;
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data!.channels).toHaveLength(3);

    const webhook = body.data!.channels.find((c) => c.channelType === 'webhook')!;
    expect(webhook.enabled).toBe(true);
    expect((webhook.config as { url: string }).url).toBe('https://hooks.slack.com/services/xxx');

    const email = body.data!.channels.find((c) => c.channelType === 'email')!;
    expect(email.enabled).toBe(true);
    expect((email.config as { addresses: string[] }).addresses).toEqual(['admin@example.com']);
  });

  it('returns empty data when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest('https://admin.example.com/admin/api/notifications/config');
    const res = await handleGetNotificationConfig(req, makeEnv(undefined));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<NotificationConfigData>;
    expect(body.success).toBe(true);
    expect(body.data!.channels).toHaveLength(0);
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

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config');
    const res = await handleGetNotificationConfig(req, makeEnv(db as ReturnType<typeof createMockD1>));

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to retrieve notification configuration');
    expect(body.error).not.toContain('D1_INTERNAL');
  });
});

describe('handleUpdateNotificationConfig', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-establish super-admin mock for both auth functions
    const { requireAuth, requireSuperAdmin } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue(makeSuperAdminPayload());
    vi.mocked(requireSuperAdmin).mockResolvedValue(makeSuperAdminPayload());
  });

  it('updates email config successfully', async () => {
    const db = createMockD1([
      {
        pattern: /INSERT INTO notification_config/,
        run: { success: true },
      },
      {
        pattern: /SELECT id, channel_type/,
        first: sampleEmailConfigRow,
      },
    ]);

    const configBody = JSON.stringify({
      channelType: 'email',
      enabled: true,
      config: {
        addresses: ['admin@example.com', 'ops@example.com'],
        severityFilter: ['critical', 'warning'],
        cooldownMinutes: 15,
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ channel: NotificationConfigEntry }>;
    expect(body.success).toBe(true);
    expect(body.data!.channel).toBeDefined();
  });

  it('updates webhook config successfully', async () => {
    const db = createMockD1([
      {
        pattern: /INSERT INTO notification_config/,
        run: { success: true },
      },
      {
        pattern: /SELECT id, channel_type/,
        first: sampleWebhookConfigRow,
      },
    ]);

    const configBody = JSON.stringify({
      channelType: 'webhook',
      enabled: true,
      config: {
        url: 'https://hooks.slack.com/services/new',
        severityFilter: ['critical'],
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ channel: NotificationConfigEntry }>;
    expect(body.success).toBe(true);
  });

  it('updates dashboard config successfully', async () => {
    const db = createMockD1([
      {
        pattern: /INSERT INTO notification_config/,
        run: { success: true },
      },
      {
        pattern: /SELECT id, channel_type/,
        first: sampleDashboardConfigRow,
      },
    ]);

    const configBody = JSON.stringify({
      channelType: 'dashboard',
      enabled: true,
      config: {
        soundEnabled: false,
        severityFilter: ['critical'],
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ channel: NotificationConfigEntry }>;
    expect(body.success).toBe(true);
  });

  it('returns 403 for non-super-admin', async () => {
    const { requireSuperAdmin } = await import('../../src/routes/auth.js');
    vi.mocked(requireSuperAdmin).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Super-admin access required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const configBody = JSON.stringify({
      channelType: 'email',
      enabled: true,
      config: {
        addresses: ['admin@example.com'],
        severityFilter: ['critical'],
        cooldownMinutes: 30,
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv());

    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Super-admin access required');
  });

  it('rejects invalid channelType', async () => {
    const db = createMockD1([]);
    const configBody = JSON.stringify({
      channelType: 'sms',
      enabled: true,
      config: {},
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('channelType');
  });

  it('rejects missing enabled field', async () => {
    const db = createMockD1([]);
    const configBody = JSON.stringify({
      channelType: 'email',
      config: {
        addresses: ['admin@example.com'],
        severityFilter: ['critical'],
        cooldownMinutes: 30,
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('enabled');
  });

  it('rejects invalid email config - empty addresses', async () => {
    const db = createMockD1([]);
    const configBody = JSON.stringify({
      channelType: 'email',
      enabled: true,
      config: {
        addresses: [],
        severityFilter: ['critical'],
        cooldownMinutes: 30,
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('email config');
  });

  it('rejects invalid email config - negative cooldown', async () => {
    const db = createMockD1([]);
    const configBody = JSON.stringify({
      channelType: 'email',
      enabled: true,
      config: {
        addresses: ['admin@example.com'],
        severityFilter: ['critical'],
        cooldownMinutes: -5,
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('email config');
  });

  it('rejects invalid webhook config - missing url', async () => {
    const db = createMockD1([]);
    const configBody = JSON.stringify({
      channelType: 'webhook',
      enabled: true,
      config: {
        severityFilter: ['critical'],
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('webhook config');
  });

  it('rejects invalid webhook config - invalid url format', async () => {
    const db = createMockD1([]);
    const configBody = JSON.stringify({
      channelType: 'webhook',
      enabled: true,
      config: {
        url: 'not-a-valid-url',
        severityFilter: ['critical'],
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('webhook config');
  });

  it('rejects invalid dashboard config - missing soundEnabled', async () => {
    const db = createMockD1([]);
    const configBody = JSON.stringify({
      channelType: 'dashboard',
      enabled: true,
      config: {
        severityFilter: ['critical'],
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('dashboard config');
  });

  it('rejects invalid severity in filter', async () => {
    const db = createMockD1([]);
    const configBody = JSON.stringify({
      channelType: 'email',
      enabled: true,
      config: {
        addresses: ['admin@example.com'],
        severityFilter: ['critical', 'extreme'],
        cooldownMinutes: 30,
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
  });

  it('rejects invalid JSON body', async () => {
    const db = createMockD1([]);
    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/config',
      'POST',
      'not valid json{'
    );
    const res = await handleUpdateNotificationConfig(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid JSON body');
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const configBody = JSON.stringify({
      channelType: 'email',
      enabled: true,
      config: {
        addresses: ['admin@example.com'],
        severityFilter: ['critical'],
        cooldownMinutes: 30,
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(undefined));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(true);
  });

  it('returns 500 with generic message on D1 error', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: error')),
        all: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: error')),
        run: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: error')),
      })),
      batch: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: error')),
    };

    const configBody = JSON.stringify({
      channelType: 'email',
      enabled: true,
      config: {
        addresses: ['admin@example.com'],
        severityFilter: ['critical'],
        cooldownMinutes: 30,
      },
    });

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config', 'POST', configBody);
    const res = await handleUpdateNotificationConfig(req, makeEnv(db as ReturnType<typeof createMockD1>));

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to update notification configuration');
    expect(body.error).not.toContain('D1_INTERNAL');
  });
});

describe('handleTestNotification', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-establish super-admin mock for both auth functions
    const { requireAuth, requireSuperAdmin } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue(makeSuperAdminPayload());
    vi.mocked(requireSuperAdmin).mockResolvedValue(makeSuperAdminPayload());
  });

  it('sends test webhook notification', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT id, channel_type/,
        first: sampleWebhookConfigRow,
      },
    ]);

    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'webhook' })
    );
    const res = await handleTestNotification(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ sent: boolean; statusCode: number }>;
    expect(body.success).toBe(true);
    expect(body.data!.sent).toBe(true);
    expect(body.data!.statusCode).toBe(200);
  });

  it('sends test email notification', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT id, channel_type/,
        first: sampleEmailConfigRow,
      },
    ]);

    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'email' })
    );
    const res = await handleTestNotification(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ sent: boolean }>;
    expect(body.success).toBe(true);
    expect(body.data!.sent).toBe(true);
  });

  it('returns 403 for non-super-admin', async () => {
    const { requireSuperAdmin } = await import('../../src/routes/auth.js');
    vi.mocked(requireSuperAdmin).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Super-admin access required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'webhook' })
    );
    const res = await handleTestNotification(req, makeEnv());

    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Super-admin access required');
  });

  it('rejects invalid channelType', async () => {
    const db = createMockD1([]);
    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'dashboard' })
    );
    const res = await handleTestNotification(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('channelType');
  });

  it('returns 404 when no config exists for channel', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT id, channel_type/,
        first: null,
      },
    ]);

    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'webhook' })
    );
    const res = await handleTestNotification(req, makeEnv(db));

    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('No configuration found');
  });

  it('returns 400 when channel is disabled', async () => {
    const disabledRow = { ...sampleWebhookConfigRow, enabled: 0 };
    const db = createMockD1([
      {
        pattern: /SELECT id, channel_type/,
        first: disabledRow,
      },
    ]);

    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'webhook' })
    );
    const res = await handleTestNotification(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('disabled');
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'webhook' })
    );
    const res = await handleTestNotification(req, makeEnv(undefined));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<{ sent: boolean; reason: string }>;
    expect(body.success).toBe(true);
    expect(body.data!.sent).toBe(false);
    expect(body.data!.reason).toBe('No database configured');
  });

  it('rejects invalid JSON body', async () => {
    const db = createMockD1([]);
    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      'not valid json{'
    );
    const res = await handleTestNotification(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid JSON body');
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

    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'webhook' })
    );
    const res = await handleTestNotification(req, makeEnv(db as ReturnType<typeof createMockD1>));

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to send test notification');
    expect(body.error).not.toContain('D1_INTERNAL');
  });
});

// ─── Auth Enforcement ───────────────────────────

describe('Auth enforcement for notification config handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleGetNotificationConfig returns 401 when auth fails', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);
    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest('https://admin.example.com/admin/api/notifications/config');
    const res = await handleGetNotificationConfig(req, makeEnv());

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('handleUpdateNotificationConfig returns 401 when auth fails', async () => {
    const { requireSuperAdmin } = await import('../../src/routes/auth.js');
    vi.mocked(requireSuperAdmin).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/config',
      'POST',
      JSON.stringify({ channelType: 'email', enabled: true, config: {} })
    );
    const res = await handleUpdateNotificationConfig(req, makeEnv());

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('handleTestNotification returns 401 when auth fails', async () => {
    const { requireSuperAdmin } = await import('../../src/routes/auth.js');
    vi.mocked(requireSuperAdmin).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest(
      'https://admin.example.com/admin/api/notifications/test',
      'POST',
      JSON.stringify({ channelType: 'webhook' })
    );
    const res = await handleTestNotification(req, makeEnv());

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });
});
