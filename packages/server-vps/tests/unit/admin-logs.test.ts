/**
 * Unit tests for admin log REST endpoints (GET /admin/api/logs, GET /admin/api/logs/export)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { AdminRoutes } from '../../src/admin/routes.js';
import { LogBuffer } from '../../src/admin/log-buffer.js';
import type { AdminConfig } from '../../src/admin/types.js';
import { createHmac } from 'crypto';

// ─── Helpers ─────────────────────────────────────────

/** Create a valid HS256 JWT for admin auth. */
function createJwt(secret: string, payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

const JWT_SECRET = 'test-secret-for-unit-tests';
const VALID_TOKEN = createJwt(JWT_SECRET, {
  sub: 'user-1',
  username: 'admin',
  role: 'admin',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
});

function mockReq(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    url: '/',
    method: 'GET',
    headers: { authorization: `Bearer ${VALID_TOKEN}`, host: 'localhost:8443' },
    ...overrides,
  } as IncomingMessage;
}

/** Capture the response written to a mock ServerResponse. */
function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          res._headers[k.toLowerCase()] = v;
        }
      }
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
      return res;
    },
    end(body?: string) {
      if (body) res._body = body;
    },
  } as unknown as ServerResponse & { _status: number; _headers: Record<string, string>; _body: string };
  return res;
}

/** Stub MetricsCollector with just the methods AdminRoutes needs. */
function stubMetrics() {
  return {
    takeSnapshot: () => ({}),
    getHistory: () => ({ snapshots: [], startTime: 0, endTime: 0 }),
    getFederationTopology: () => ({ nodes: [], edges: [] }),
    getScalingRecommendation: () => ({
      level: 'normal' as const,
      message: '',
      metrics: { connectionLoad: 0, entropyPressure: 0, federationHealth: 100 },
      recommendations: [],
    }),
  } as any;
}

// ─── Tests ───────────────────────────────────────────

describe('GET /admin/api/logs', () => {
  let routes: AdminRoutes;
  let logBuffer: LogBuffer;
  const config: AdminConfig = { jwtSecret: JWT_SECRET };

  beforeEach(() => {
    logBuffer = new LogBuffer();
    routes = new AdminRoutes(stubMetrics(), config);
    routes.setLogBuffer(logBuffer);
  });

  it('should require authentication', async () => {
    const req = mockReq({ headers: { host: 'localhost:8443' } }); // no auth header
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');
    expect(res._status).toBe(401);
  });

  it('should return empty entries when buffer is empty', async () => {
    const req = mockReq({ url: '/admin/api/logs' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(true);
    expect(body.data.entries).toEqual([]);
    expect(body.data.total).toBe(0);
    expect(body.data.hasMore).toBe(false);
  });

  it('should return log entries', async () => {
    logBuffer.add({ timestamp: 1000, severity: 'info', category: 'test', message: 'hello' });
    logBuffer.add({ timestamp: 2000, severity: 'warn', category: 'test', message: 'world' });

    const req = mockReq({ url: '/admin/api/logs' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');

    const body = JSON.parse(res._body);
    expect(body.success).toBe(true);
    expect(body.data.entries).toHaveLength(2);
    expect(body.data.total).toBe(2);
    // Newest first
    expect(body.data.entries[0].timestamp).toBe(2000);
    expect(body.data.entries[1].timestamp).toBe(1000);
  });

  it('should filter by severity (minimum inclusive)', async () => {
    logBuffer.add({ timestamp: 1000, severity: 'debug', category: 'a', message: 'dbg' });
    logBuffer.add({ timestamp: 2000, severity: 'info', category: 'a', message: 'inf' });
    logBuffer.add({ timestamp: 3000, severity: 'warn', category: 'a', message: 'wrn' });
    logBuffer.add({ timestamp: 4000, severity: 'error', category: 'a', message: 'err' });

    const req = mockReq({ url: '/admin/api/logs?severity=warn' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');

    const body = JSON.parse(res._body);
    expect(body.data.entries).toHaveLength(2);
    expect(body.data.entries.map((e: any) => e.severity)).toEqual(['error', 'warn']);
  });

  it('should reject invalid severity', async () => {
    const req = mockReq({ url: '/admin/api/logs?severity=bogus' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toContain('Invalid severity');
  });

  it('should filter by time range', async () => {
    logBuffer.add({ timestamp: 1000, severity: 'info', category: 'a', message: 'old' });
    logBuffer.add({ timestamp: 5000, severity: 'info', category: 'a', message: 'mid' });
    logBuffer.add({ timestamp: 9000, severity: 'info', category: 'a', message: 'new' });

    const req = mockReq({ url: '/admin/api/logs?since=2000&until=8000' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');

    const body = JSON.parse(res._body);
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0].message).toBe('mid');
  });

  it('should filter by keyword (case-insensitive)', async () => {
    logBuffer.add({ timestamp: 1000, severity: 'info', category: 'a', message: 'Connection established' });
    logBuffer.add({ timestamp: 2000, severity: 'info', category: 'a', message: 'Pairing matched' });

    const req = mockReq({ url: '/admin/api/logs?keyword=pairing' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');

    const body = JSON.parse(res._body);
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0].message).toContain('Pairing');
  });

  it('should filter by category', async () => {
    logBuffer.add({ timestamp: 1000, severity: 'info', category: 'federation', message: 'joined' });
    logBuffer.add({ timestamp: 2000, severity: 'info', category: 'pairing', message: 'matched' });

    const req = mockReq({ url: '/admin/api/logs?category=federation' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');

    const body = JSON.parse(res._body);
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0].category).toBe('federation');
  });

  it('should respect limit and offset for pagination', async () => {
    for (let i = 0; i < 10; i++) {
      logBuffer.add({ timestamp: i * 1000, severity: 'info', category: 'a', message: `msg-${i}` });
    }

    const req = mockReq({ url: '/admin/api/logs?limit=3&offset=2' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');

    const body = JSON.parse(res._body);
    expect(body.data.entries).toHaveLength(3);
    expect(body.data.total).toBe(10);
    expect(body.data.hasMore).toBe(true);
    // Newest-first, offset 2 means skip the two newest
    expect(body.data.entries[0].message).toBe('msg-7');
  });

  it('should clamp limit to max 1000', async () => {
    const req = mockReq({ url: '/admin/api/logs?limit=9999' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs');
    // No error — just clamped internally
    expect(res._status).toBe(200);
  });
});

describe('GET /admin/api/logs/export', () => {
  let routes: AdminRoutes;
  let logBuffer: LogBuffer;
  const config: AdminConfig = { jwtSecret: JWT_SECRET };

  beforeEach(() => {
    logBuffer = new LogBuffer();
    routes = new AdminRoutes(stubMetrics(), config);
    routes.setLogBuffer(logBuffer);
  });

  it('should require authentication', async () => {
    const req = mockReq({ headers: { host: 'localhost:8443' }, url: '/admin/api/logs/export?since=0&until=99999' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs/export');
    expect(res._status).toBe(401);
  });

  it('should require since and until params', async () => {
    const req = mockReq({ url: '/admin/api/logs/export' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs/export');
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toContain('since and until');
  });

  it('should reject invalid format', async () => {
    const req = mockReq({ url: '/admin/api/logs/export?since=0&until=99999&format=xml' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs/export');
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toContain('Invalid format');
  });

  it('should export JSON with Content-Disposition header', async () => {
    logBuffer.add({ timestamp: 5000, severity: 'info', category: 'test', message: 'hello' });

    const req = mockReq({ url: '/admin/api/logs/export?since=0&until=99999' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs/export');

    expect(res._status).toBe(200);
    expect(res._headers['content-disposition']).toContain('attachment');
    expect(res._headers['content-disposition']).toContain('.json');

    const body = JSON.parse(res._body);
    expect(body.success).toBe(true);
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0].message).toBe('hello');
  });

  it('should export CSV with correct headers', async () => {
    logBuffer.add({ timestamp: 5000, severity: 'warn', category: 'security', message: 'blocked IP' });

    const req = mockReq({ url: '/admin/api/logs/export?since=0&until=99999&format=csv' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs/export');

    expect(res._status).toBe(200);
    expect(res._headers['content-type']).toContain('text/csv');
    expect(res._headers['content-disposition']).toContain('.csv');

    // Verify CSV content
    const lines = res._body.split('\n');
    expect(lines[0]).toBe('timestamp,severity,category,message,metadata');
    expect(lines[1]).toContain('5000');
    expect(lines[1]).toContain('warn');
    expect(lines[1]).toContain('blocked IP');
  });

  it('should export CSV with properly escaped fields', async () => {
    logBuffer.add({ timestamp: 5000, severity: 'info', category: 'test', message: 'has "quotes" and, commas' });

    const req = mockReq({ url: '/admin/api/logs/export?since=0&until=99999&format=csv' });
    const res = mockRes();
    await routes.handleRequest(req, res, '/admin/api/logs/export');

    const lines = res._body.split('\n');
    // Quotes should be doubled inside CSV
    expect(lines[1]).toContain('""quotes""');
  });
});
