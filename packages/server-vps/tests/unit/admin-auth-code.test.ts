/**
 * VPS Admin Auth Code Exchange Tests
 * Tests the AdminRoutes handler behavior with ?code= and ?token= query parameters.
 *
 * Uses a real AdminRoutes instance with mocked MetricsCollector and global fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { AdminRoutes } from '../../src/admin/routes.js';

// Mock fetch globally for server-to-server exchange calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Minimal mock MetricsCollector — AdminRoutes only needs it for metrics endpoints
function createMockMetrics() {
  return {
    takeSnapshot: vi.fn().mockReturnValue({}),
    getHistory: vi.fn().mockReturnValue({ snapshots: [] }),
    getFederationTopology: vi.fn().mockReturnValue({ nodes: [] }),
    getScalingRecommendation: vi.fn().mockReturnValue({ level: 'normal', recommendations: [] }),
  };
}

// Helper to create a mock IncomingMessage
function createMockReq(url: string, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost:8443', ...headers };
  (req as unknown as { connection: { encrypted?: boolean } }).connection = { encrypted: false };
  return req;
}

// Helper to create a mock ServerResponse
function createMockRes(): ServerResponse & { _status: number; _headers: Record<string, string | string[]>; _body: string; _ended: boolean } {
  const res = new EventEmitter() as ServerResponse & { _status: number; _headers: Record<string, string | string[]>; _body: string; _ended: boolean };
  res._status = 200;
  res._headers = {};
  res._body = '';
  res._ended = false;

  res.writeHead = vi.fn((status: number, headers?: Record<string, string>) => {
    res._status = status;
    if (headers) Object.assign(res._headers, headers);
    return res;
  });
  res.end = vi.fn((body?: string) => {
    res._body = body || '';
    res._ended = true;
  });
  res.setHeader = vi.fn((name: string, value: string | string[]) => {
    res._headers[name.toLowerCase()] = value;
    return res;
  });

  return res;
}

describe('VPS Admin Route: Authorization Code Exchange', () => {
  let routes: AdminRoutes;
  const CF_ADMIN_URL = 'https://admin.example.com';
  const JWT_SECRET = 'test-secret-for-unit-tests';

  beforeEach(() => {
    mockFetch.mockReset();
    routes = new AdminRoutes(
      createMockMetrics() as never,
      {
        jwtSecret: JWT_SECRET,
        cfAdminUrl: CF_ADMIN_URL,
      }
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should exchange valid code for token and redirect', async () => {
    // Create a valid JWT that our verifyJwt will accept
    // We need a real JWT signed with JWT_SECRET for the route handler to verify
    const { createHmac } = await import('crypto');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: 'user1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 14400, // 4 hours
    })).toString('base64url');
    const signature = createHmac('sha256', JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    const validJwt = `${header}.${payload}.${signature}`;

    // Mock successful exchange response from CF admin
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { token: validJwt },
      }),
      text: async () => JSON.stringify({ success: true, data: { token: validJwt } }),
    });

    const req = createMockReq('/admin/?code=abc123def456');
    const res = createMockRes();

    const handled = await routes.handleRequest(req, res, '/admin/');

    expect(handled).toBe(true);
    // Should call CF admin exchange endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      `${CF_ADMIN_URL}/admin/api/auth/exchange`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'abc123def456' }),
      })
    );
    // Should redirect to /admin/ (removing code from URL)
    expect(res._status).toBe(302);
    expect(res._headers['Location']).toBe('/admin/');
    // Should set auth cookie
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('zajel_vps_token=')
    );
  });

  it('should redirect to CF admin when exchange fails', async () => {
    // Mock failed exchange response
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ success: false, error: 'Invalid or expired code' }),
      text: async () => JSON.stringify({ success: false, error: 'Invalid or expired code' }),
    });

    const req = createMockReq('/admin/?code=invalid-code');
    const res = createMockRes();

    const handled = await routes.handleRequest(req, res, '/admin/');

    expect(handled).toBe(true);
    // Should redirect to CF admin for re-authentication
    expect(res._status).toBe(302);
    expect(res._headers['Location']).toBe(CF_ADMIN_URL);
  });

  it('should redirect to CF admin when network error occurs', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const req = createMockReq('/admin/?code=abc123');
    const res = createMockRes();

    const handled = await routes.handleRequest(req, res, '/admin/');

    expect(handled).toBe(true);
    // Should redirect to CF admin for re-authentication
    expect(res._status).toBe(302);
    expect(res._headers['Location']).toBe(CF_ADMIN_URL);
  });

  it('should NOT handle ?token= query parameter (old behavior removed)', async () => {
    const req = createMockReq('/admin/?token=some-jwt-token');
    const res = createMockRes();

    const handled = await routes.handleRequest(req, res, '/admin/');

    expect(handled).toBe(true);
    // Should NOT call fetch for exchange (no code parameter)
    expect(mockFetch).not.toHaveBeenCalled();
    // Should serve dashboard HTML (no redirect, no cookie set from token)
    expect(res._status).toBe(200);
    expect(res._body).toContain('VPS');
  });

  it('should serve dashboard when no code is provided', async () => {
    const req = createMockReq('/admin/');
    const res = createMockRes();

    const handled = await routes.handleRequest(req, res, '/admin/');

    expect(handled).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
  });

  it('should redirect to CF admin when exchange returns invalid token', async () => {
    // Mock exchange returning a token that does NOT verify against our JWT_SECRET
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { token: 'invalid.jwt.token' },
      }),
      text: async () => JSON.stringify({ success: true, data: { token: 'invalid.jwt.token' } }),
    });

    const req = createMockReq('/admin/?code=validcode123');
    const res = createMockRes();

    const handled = await routes.handleRequest(req, res, '/admin/');

    expect(handled).toBe(true);
    // Should redirect to CF admin because the exchanged token is invalid
    expect(res._status).toBe(302);
    expect(res._headers['Location']).toBe(CF_ADMIN_URL);
  });

  it('should redirect to CF admin when exchange response has no token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {}, // missing token field
      }),
      text: async () => JSON.stringify({ success: true, data: {} }),
    });

    const req = createMockReq('/admin/?code=somecode');
    const res = createMockRes();

    const handled = await routes.handleRequest(req, res, '/admin/');

    expect(handled).toBe(true);
    expect(res._status).toBe(302);
    expect(res._headers['Location']).toBe(CF_ADMIN_URL);
  });
});
