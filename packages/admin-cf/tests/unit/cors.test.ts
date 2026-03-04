/**
 * Unit tests for CORS utility module
 */

import { describe, it, expect } from 'vitest';
import { getCorsHeaders, SECURITY_HEADERS } from '../../src/cors.js';
import type { Env } from '../../src/types.js';

describe('getCorsHeaders', () => {
  const mockEnv: Env = {
    ADMIN_USERS: {} as any,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ADMIN_ALLOWED_ORIGINS: 'https://admin.zajel.hamzalabs.dev,https://example.com,http://localhost:*',
  };

  function mockRequest(origin: string | null, method: string = 'GET'): Request {
    const headers = new Headers();
    if (origin !== null) {
      headers.set('Origin', origin);
    }
    return new Request('https://admin.zajel.hamzalabs.dev/admin/api/users', {
      method,
      headers,
    });
  }

  it('returns CORS headers without Access-Control-Allow-Origin when no Origin header is present', () => {
    const request = mockRequest(null);
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    expect(headers['Access-Control-Max-Age']).toBe('86400');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    // Vary: Origin is always set for cache poisoning prevention
    expect(headers['Vary']).toBe('Origin');
  });

  it('sets Access-Control-Allow-Origin and Vary when origin is in allowlist', () => {
    const request = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://admin.zajel.hamzalabs.dev');
    expect(headers['Vary']).toBe('Origin');
  });

  it('allows exact match for multiple origins in allowlist', () => {
    const request1 = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers1 = getCorsHeaders(request1, mockEnv);
    expect(headers1['Access-Control-Allow-Origin']).toBe('https://admin.zajel.hamzalabs.dev');

    const request2 = mockRequest('https://example.com');
    const headers2 = getCorsHeaders(request2, mockEnv);
    expect(headers2['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('does not set Access-Control-Allow-Origin for disallowed origins', () => {
    const request = mockRequest('https://evil.example.com');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Vary']).toBe('Origin');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('allows localhost with wildcard pattern (http://localhost:*)', () => {
    const request1 = mockRequest('http://localhost:3000');
    const headers1 = getCorsHeaders(request1, mockEnv);
    expect(headers1['Access-Control-Allow-Origin']).toBe('http://localhost:3000');

    const request2 = mockRequest('http://localhost:8787');
    const headers2 = getCorsHeaders(request2, mockEnv);
    expect(headers2['Access-Control-Allow-Origin']).toBe('http://localhost:8787');
  });

  it('rejects https://localhost when only http://localhost:* is allowed', () => {
    const request = mockRequest('https://localhost:3000');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('rejects localhost subdomain spoofing (e.g., evil.localhost)', () => {
    const request = mockRequest('http://evil.localhost:3000');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('handles empty ADMIN_ALLOWED_ORIGINS by rejecting all origins', () => {
    const emptyEnv: Env = {
      ...mockEnv,
      ADMIN_ALLOWED_ORIGINS: '',
    };
    const request = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers = getCorsHeaders(request, emptyEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('handles undefined ADMIN_ALLOWED_ORIGINS by rejecting all origins', () => {
    const undefinedEnv: Env = {
      ...mockEnv,
      ADMIN_ALLOWED_ORIGINS: undefined,
    };
    const request = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers = getCorsHeaders(request, undefinedEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('trims whitespace from allowed origins list', () => {
    const whiteSpaceEnv: Env = {
      ...mockEnv,
      ADMIN_ALLOWED_ORIGINS: '  https://example.com  ,  https://other.com  ',
    };
    const request = mockRequest('https://example.com');
    const headers = getCorsHeaders(request, whiteSpaceEnv);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('handles malformed Origin header gracefully', () => {
    const request = mockRequest('not-a-valid-url');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('always includes security headers regardless of origin', () => {
    const request1 = mockRequest('https://evil.example.com');
    const headers1 = getCorsHeaders(request1, mockEnv);
    expect(headers1['X-Content-Type-Options']).toBe('nosniff');
    expect(headers1['X-Frame-Options']).toBe('DENY');

    const request2 = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers2 = getCorsHeaders(request2, mockEnv);
    expect(headers2['X-Content-Type-Options']).toBe('nosniff');
    expect(headers2['X-Frame-Options']).toBe('DENY');

    const request3 = mockRequest(null);
    const headers3 = getCorsHeaders(request3, mockEnv);
    expect(headers3['X-Content-Type-Options']).toBe('nosniff');
    expect(headers3['X-Frame-Options']).toBe('DENY');
  });

  it('always includes Vary: Origin for cache poisoning prevention', () => {
    // Vary: Origin should be present even when no ACAO is set,
    // to prevent CDN cache poisoning in all cases
    const request1 = mockRequest(null);
    const headers1 = getCorsHeaders(request1, mockEnv);
    expect(headers1['Vary']).toBe('Origin');

    const request2 = mockRequest('https://evil.example.com');
    const headers2 = getCorsHeaders(request2, mockEnv);
    expect(headers2['Vary']).toBe('Origin');

    const request3 = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers3 = getCorsHeaders(request3, mockEnv);
    expect(headers3['Vary']).toBe('Origin');
  });
});

describe('Preflight OPTIONS requests', () => {
  const mockEnv: Env = {
    ADMIN_USERS: {} as any,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ADMIN_ALLOWED_ORIGINS: 'https://admin.zajel.hamzalabs.dev,http://localhost:*',
  };

  function mockOptionsRequest(origin: string): Request {
    const headers = new Headers();
    headers.set('Origin', origin);
    return new Request('https://admin.zajel.hamzalabs.dev/admin/api/users', {
      method: 'OPTIONS',
      headers,
    });
  }

  it('preflight from an allowed origin returns correct CORS headers', () => {
    const request = mockOptionsRequest('https://admin.zajel.hamzalabs.dev');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://admin.zajel.hamzalabs.dev');
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    expect(headers['Access-Control-Max-Age']).toBe('86400');
    expect(headers['Vary']).toBe('Origin');
  });

  it('preflight from a disallowed origin returns no allow-origin header', () => {
    const request = mockOptionsRequest('https://evil.example.com');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('preflight from allowed localhost origin returns correct CORS headers', () => {
    const request = mockOptionsRequest('http://localhost:8787');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:8787');
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    expect(headers['Access-Control-Max-Age']).toBe('86400');
    expect(headers['Vary']).toBe('Origin');
  });
});

describe('SECURITY_HEADERS', () => {
  it('exports the expected security headers', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
  });
});
