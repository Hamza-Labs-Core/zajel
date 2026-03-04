/**
 * Unit tests for extractToken() — verifies query param token extraction is removed
 */

import { describe, it, expect } from 'vitest';
import { extractToken } from '../../src/admin/auth.js';
import type { IncomingMessage } from 'http';

// Helper to create a minimal mock IncomingMessage
function mockReq(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    url: '/',
    method: 'GET',
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

describe('extractToken', () => {
  it('should return token from Authorization header', () => {
    const req = mockReq({
      headers: { authorization: 'Bearer my-jwt-token' },
    });
    expect(extractToken(req)).toBe('my-jwt-token');
  });

  it('should return token from cookie', () => {
    const req = mockReq({
      headers: { cookie: 'zajel_vps_token=cookie-jwt-token; other=value' },
    });
    expect(extractToken(req)).toBe('cookie-jwt-token');
  });

  it('should NOT return token from ?token= query parameter', () => {
    const req = mockReq({
      url: '/admin/api/servers?token=query-jwt-token',
      headers: { host: 'localhost:8443' },
    });
    expect(extractToken(req)).toBeNull();
  });

  it('should return null when no token is present', () => {
    const req = mockReq({
      url: '/admin/',
      headers: { host: 'localhost:8443' },
    });
    expect(extractToken(req)).toBeNull();
  });

  it('should prefer Authorization header over cookie', () => {
    const req = mockReq({
      headers: {
        authorization: 'Bearer header-token',
        cookie: 'zajel_vps_token=cookie-token',
      },
    });
    expect(extractToken(req)).toBe('header-token');
  });

  it('should return null for Authorization header without Bearer prefix', () => {
    const req = mockReq({
      headers: { authorization: 'Basic credentials' },
    });
    expect(extractToken(req)).toBeNull();
  });

  it('should return null for empty cookie header', () => {
    const req = mockReq({
      headers: { cookie: '' },
    });
    expect(extractToken(req)).toBeNull();
  });

  it('should return null for cookie without zajel_vps_token', () => {
    const req = mockReq({
      headers: { cookie: 'other_cookie=value; another=val2' },
    });
    expect(extractToken(req)).toBeNull();
  });
});
