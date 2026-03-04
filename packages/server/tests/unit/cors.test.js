/**
 * Unit tests for CORS utilities.
 *
 * Covers:
 * - getCorsHeaders with allowed origin
 * - getCorsHeaders with disallowed origin
 * - getCorsHeaders without Origin header
 * - isOriginAllowed exact match
 * - isOriginAllowed localhost wildcard pattern
 * - parseAllowedOrigins from env
 * - Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
 */

import { describe, it, expect } from 'vitest';
import { getCorsHeaders } from '../../src/cors.js';

describe('CORS Utilities', () => {
  describe('getCorsHeaders', () => {
    it('should include origin-specific CORS headers for allowed origin', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'https://zajel.hamzalabs.dev' },
      });
      const env = {};

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBe('https://zajel.hamzalabs.dev');
      expect(headers['Vary']).toBe('Origin');
    });

    it('should not include Access-Control-Allow-Origin for disallowed origin', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'https://evil.com' },
      });
      const env = {};

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(headers['Vary']).toBeUndefined();
    });

    it('should not include Access-Control-Allow-Origin without Origin header', () => {
      const request = new Request('https://test.workers.dev');
      const env = {};

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('should include standard security headers', () => {
      const request = new Request('https://test.workers.dev');
      const env = {};

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, PUT, DELETE, OPTIONS');
      expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
      expect(headers['Access-Control-Expose-Headers']).toBe('X-Bootstrap-Signature, X-Attestation-Token, X-TUF-Timestamp-Version');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Cache-Control']).toBe('no-store');
      expect(headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
      expect(headers['Referrer-Policy']).toBe('no-referrer');
      expect(headers['Content-Security-Policy']).toBe("default-src 'none'");
      expect(headers['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=(), payment=()');
    });

    it('should allow custom origins from env', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'https://custom.example.com' },
      });
      const env = { ALLOWED_ORIGINS: 'https://custom.example.com,https://other.com' };

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBe('https://custom.example.com');
    });

    it('should handle localhost wildcard pattern', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'http://localhost:3000' },
      });
      const env = { ALLOWED_ORIGINS: 'http://localhost:*' };

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    it('should handle localhost with different ports', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'http://localhost:5173' },
      });
      const env = { ALLOWED_ORIGINS: 'http://localhost:*' };

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    });

    it('should reject localhost with wrong protocol', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'https://localhost:3000' },
      });
      const env = { ALLOWED_ORIGINS: 'http://localhost:*' };

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('should handle empty ALLOWED_ORIGINS env var', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'https://zajel.hamzalabs.dev' },
      });
      const env = { ALLOWED_ORIGINS: '' };

      const headers = getCorsHeaders(request, env);

      // Should fall back to default allowed origins
      expect(headers['Access-Control-Allow-Origin']).toBe('https://zajel.hamzalabs.dev');
    });

    it('should trim whitespace in ALLOWED_ORIGINS', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'https://example.com' },
      });
      const env = { ALLOWED_ORIGINS: '  https://example.com  , https://other.com  ' };

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
    });

    it('should use defaults when env is null', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'https://zajel.hamzalabs.dev' },
      });

      const headers = getCorsHeaders(request, null);

      expect(headers['Access-Control-Allow-Origin']).toBe('https://zajel.hamzalabs.dev');
    });

    it('should reject origin not in custom list', () => {
      const request = new Request('https://test.workers.dev', {
        headers: { Origin: 'https://zajel.hamzalabs.dev' },
      });
      const env = { ALLOWED_ORIGINS: 'https://only-this.com' };

      const headers = getCorsHeaders(request, env);

      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });
});
