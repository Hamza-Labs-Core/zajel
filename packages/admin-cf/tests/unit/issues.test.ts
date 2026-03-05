/**
 * Unit tests for issue lifecycle route handlers (US-6.3)
 *
 * Mocks auth to always succeed and uses a mock D1 database
 * to test query logic, validation, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleListIssues,
  handleIssueDetail,
  handleAcknowledgeIssue,
} from '../../src/routes/issues.js';
import type { Env, ApiResponse, IssuesListData, IssueDetailData } from '../../src/types.js';

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

/**
 * Create a mock D1 prepared statement that matches SQL patterns
 * and returns configured results.
 */
function createMockD1(queryHandlers: Array<{
  pattern: RegExp;
  first?: Record<string, unknown> | null;
  all?: MockD1Results;
  run?: { success: boolean };
}>) {
  return {
    prepare: vi.fn((sql: string) => {
      const handler = queryHandlers.find((h) => h.pattern.test(sql));

      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(handler?.first ?? null),
        all: vi.fn().mockResolvedValue(handler?.all ?? { results: [], success: true }),
        run: vi.fn().mockResolvedValue(handler?.run ?? { success: true }),
      };

      return stmt;
    }),
  };
}

// ─── Sample Data ────────────────────────────────

const now = Date.now();

const sampleIssueRow = {
  id: 1,
  error_signature: 'ERR_CONN_TIMEOUT::WebRTC::establish',
  github_issue_number: 42,
  github_issue_url: 'https://github.com/org/repo/issues/42',
  severity: 'high',
  component: 'webrtc',
  status: 'open',
  ai_analysis: JSON.stringify({
    title: 'WebRTC connection timeout in poor networks',
    severity: 'high',
    component: 'webrtc',
    description: 'Connection establishment fails after 15s timeout',
    reproductionHints: 'Throttle network to 3G',
    suggestedFix: 'Increase ICE timeout to 30s',
    isRegression: false,
    affectedUsersEstimate: '5-10%',
  }),
  first_detected: now - 86400000,
  last_detected: now - 3600000,
  total_occurrences: 23,
  created_at: now - 86400000,
  updated_at: now - 3600000,
};

const sampleIssueRow2 = {
  id: 2,
  error_signature: 'ERR_CRYPTO_DECRYPT::ChaCha20::badTag',
  github_issue_number: null,
  github_issue_url: null,
  severity: 'critical',
  component: 'crypto',
  status: 'closed',
  ai_analysis: null,
  first_detected: now - 172800000,
  last_detected: now - 86400000,
  total_occurrences: 5,
  created_at: now - 172800000,
  updated_at: now - 43200000,
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

describe('handleListIssues', () => {
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
        pattern: /SELECT id, error_signature/,
        all: { results: [sampleIssueRow, sampleIssueRow2], success: true },
      },
      {
        pattern: /SUM\(CASE/,
        first: {
          open_count: 1,
          closed_count: 1,
          avg_detection_ms: 5000,
          avg_fix_ms: 43200000,
        },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues');
    const res = await handleListIssues(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<IssuesListData>;
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data!.issues).toHaveLength(2);
    expect(body.data!.total).toBe(2);
    expect(body.data!.limit).toBe(50);
    expect(body.data!.offset).toBe(0);
    expect(body.data!.lastUpdated).toBeGreaterThan(0);

    // Verify camelCase mapping
    const issue = body.data!.issues[0]!;
    expect(issue.id).toBe(1);
    expect(issue.errorSignature).toBe('ERR_CONN_TIMEOUT::WebRTC::establish');
    expect(issue.githubIssueNumber).toBe(42);
    expect(issue.githubIssueUrl).toBe('https://github.com/org/repo/issues/42');
    expect(issue.severity).toBe('high');
    expect(issue.component).toBe('webrtc');
    expect(issue.status).toBe('open');
    expect(issue.totalOccurrences).toBe(23);
  });

  it('filters by status', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT COUNT/,
        first: { total: 1 },
      },
      {
        pattern: /SELECT id, error_signature/,
        all: { results: [sampleIssueRow], success: true },
      },
      {
        pattern: /SUM\(CASE/,
        first: { open_count: 1, closed_count: 1, avg_detection_ms: null, avg_fix_ms: null },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues?status=open');
    const res = await handleListIssues(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<IssuesListData>;
    expect(body.success).toBe(true);

    // Verify the SQL was called with status parameter
    const prepareCall = db.prepare.mock.calls.find(
      (c) => typeof c[0] === 'string' && /SELECT COUNT/.test(c[0] as string)
    );
    expect(prepareCall).toBeDefined();
    expect(prepareCall![0]).toContain('WHERE');
  });

  it('filters by severity', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT COUNT/,
        first: { total: 1 },
      },
      {
        pattern: /SELECT id, error_signature/,
        all: { results: [sampleIssueRow2], success: true },
      },
      {
        pattern: /SUM\(CASE/,
        first: { open_count: 0, closed_count: 1, avg_detection_ms: null, avg_fix_ms: null },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues?severity=critical');
    const res = await handleListIssues(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<IssuesListData>;
    expect(body.success).toBe(true);

    const prepareCall = db.prepare.mock.calls.find(
      (c) => typeof c[0] === 'string' && /SELECT COUNT/.test(c[0] as string)
    );
    expect(prepareCall).toBeDefined();
    expect(prepareCall![0]).toContain('WHERE');
  });

  it('validates limit — rejects values > 200', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/issues?limit=300');
    const res = await handleListIssues(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('limit');
  });

  it('validates limit — rejects values < 1', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/issues?limit=0');
    const res = await handleListIssues(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('limit');
  });

  it('validates offset — rejects negative values', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/issues?offset=-1');
    const res = await handleListIssues(req, makeEnv(db));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('offset');
  });

  it('returns metrics with open/closed counts', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT COUNT/,
        first: { total: 2 },
      },
      {
        pattern: /SELECT id, error_signature/,
        all: { results: [sampleIssueRow, sampleIssueRow2], success: true },
      },
      {
        pattern: /SUM\(CASE/,
        first: {
          open_count: 1,
          closed_count: 1,
          avg_detection_ms: 5000,
          avg_fix_ms: 86400000,
        },
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues');
    const res = await handleListIssues(req, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<IssuesListData>;
    expect(body.success).toBe(true);

    const metrics = body.data!.metrics;
    expect(metrics.openCount).toBe(1);
    expect(metrics.closedCount).toBe(1);
    expect(metrics.avgTimeToDetectionMs).toBe(5000);
    expect(metrics.avgTimeToFixMs).toBe(86400000);
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest('https://admin.example.com/admin/api/issues');
    const res = await handleListIssues(req, makeEnv(undefined));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<IssuesListData>;
    expect(body.success).toBe(true);
    expect(body.data!.issues).toHaveLength(0);
    expect(body.data!.total).toBe(0);
    expect(body.data!.metrics.openCount).toBe(0);
    expect(body.data!.metrics.closedCount).toBe(0);
  });

  it('returns 500 with generic message on D1 error (no error leakage)', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: disk I/O error')),
        all: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: disk I/O error')),
        run: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: disk I/O error')),
      })),
    };

    const req = makeRequest('https://admin.example.com/admin/api/issues');
    const res = await handleListIssues(req, makeEnv(db as ReturnType<typeof createMockD1>));

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to retrieve issues');
    // Ensure no D1 error details leaked
    expect(body.error).not.toContain('D1_INTERNAL');
    expect(body.error).not.toContain('disk');
  });
});

describe('handleIssueDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full data with parsed AI analysis', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT[\s\S]*FROM issue_tracking WHERE id/,
        first: sampleIssueRow,
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues/1');
    const res = await handleIssueDetail(req, makeEnv(db), '1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<IssueDetailData>;
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    const issue = body.data!.issue;
    expect(issue.id).toBe(1);
    expect(issue.errorSignature).toBe('ERR_CONN_TIMEOUT::WebRTC::establish');
    expect(issue.aiAnalysis).toBeDefined();
    expect(issue.aiAnalysis!.title).toBe('WebRTC connection timeout in poor networks');
    expect(issue.aiAnalysis!.severity).toBe('high');
    expect(issue.aiAnalysis!.isRegression).toBe(false);
    expect(issue.aiAnalysis!.suggestedFix).toBe('Increase ICE timeout to 30s');
  });

  it('returns 404 for non-existent id', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT[\s\S]*FROM issue_tracking WHERE id/,
        first: null,
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues/999');
    const res = await handleIssueDetail(req, makeEnv(db), '999');

    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Issue not found');
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest('https://admin.example.com/admin/api/issues/1');
    const res = await handleIssueDetail(req, makeEnv(undefined), '1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(true);
  });

  it('returns 400 for non-numeric id', async () => {
    const db = createMockD1([]);
    const req = makeRequest('https://admin.example.com/admin/api/issues/abc');
    const res = await handleIssueDetail(req, makeEnv(db), 'abc');

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid issue ID');
  });

  it('returns 500 with generic message on D1 error', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: table not found')),
        all: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: table not found')),
        run: vi.fn().mockRejectedValue(new Error('D1_INTERNAL: table not found')),
      })),
    };

    const req = makeRequest('https://admin.example.com/admin/api/issues/1');
    const res = await handleIssueDetail(req, makeEnv(db as ReturnType<typeof createMockD1>), '1');

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to retrieve issue');
    expect(body.error).not.toContain('D1_INTERNAL');
  });
});

describe('handleAcknowledgeIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates status from open to acknowledged', async () => {
    const acknowledgedRow = { ...sampleIssueRow, status: 'acknowledged', updated_at: Date.now() };

    // First call returns the open issue, then the update runs, then returns acknowledged
    let callCount = 0;
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(async () => {
          if (/UPDATE/.test(sql)) return null;
          callCount++;
          if (callCount === 1) return sampleIssueRow;
          return acknowledgedRow;
        }),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };

    const req = makeRequest('https://admin.example.com/admin/api/issues/1/acknowledge', 'POST');
    const res = await handleAcknowledgeIssue(req, makeEnv(db as ReturnType<typeof createMockD1>), '1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse<IssueDetailData>;
    expect(body.success).toBe(true);
    expect(body.data!.issue.status).toBe('acknowledged');
  });

  it('returns 404 for non-existent id', async () => {
    const db = createMockD1([
      {
        pattern: /SELECT[\s\S]*FROM issue_tracking WHERE id/,
        first: null,
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues/999/acknowledge', 'POST');
    const res = await handleAcknowledgeIssue(req, makeEnv(db), '999');

    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Issue not found');
  });

  it('returns 409 for already-closed issue', async () => {
    const closedRow = { ...sampleIssueRow, status: 'closed' };
    const db = createMockD1([
      {
        pattern: /SELECT[\s\S]*FROM issue_tracking WHERE id/,
        first: closedRow,
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues/1/acknowledge', 'POST');
    const res = await handleAcknowledgeIssue(req, makeEnv(db), '1');

    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Issue is already closed');
  });

  it('returns 409 for already-acknowledged issue', async () => {
    const ackRow = { ...sampleIssueRow, status: 'acknowledged' };
    const db = createMockD1([
      {
        pattern: /SELECT[\s\S]*FROM issue_tracking WHERE id/,
        first: ackRow,
      },
    ]);

    const req = makeRequest('https://admin.example.com/admin/api/issues/1/acknowledge', 'POST');
    const res = await handleAcknowledgeIssue(req, makeEnv(db), '1');

    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Issue is already acknowledged');
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const req = makeRequest('https://admin.example.com/admin/api/issues/1/acknowledge', 'POST');
    const res = await handleAcknowledgeIssue(req, makeEnv(undefined), '1');

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

    const req = makeRequest('https://admin.example.com/admin/api/issues/1/acknowledge', 'POST');
    const res = await handleAcknowledgeIssue(req, makeEnv(db as ReturnType<typeof createMockD1>), '1');

    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to acknowledge issue');
    expect(body.error).not.toContain('D1_INTERNAL');
  });
});

// ─── Auth Enforcement ───────────────────────────

describe('Auth enforcement for issue handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleListIssues returns 401 when auth fails', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);
    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest('https://admin.example.com/admin/api/issues');
    const res = await handleListIssues(req, makeEnv());

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('handleIssueDetail returns 401 when auth fails', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);
    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest('https://admin.example.com/admin/api/issues/1');
    const res = await handleIssueDetail(req, makeEnv(), '1');

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('handleAcknowledgeIssue returns 401 when auth fails', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);
    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = makeRequest('https://admin.example.com/admin/api/issues/1/acknowledge', 'POST');
    const res = await handleAcknowledgeIssue(req, makeEnv(), '1');

    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });
});
