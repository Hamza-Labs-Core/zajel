/**
 * Tests for client IP extraction utility.
 *
 * Verifies that the getClientIp function correctly reads X-Real-IP and
 * X-Forwarded-For headers when the server is behind a reverse proxy,
 * and falls back to socket.remoteAddress for direct connections.
 */

import { describe, it, expect } from 'vitest';
import { getClientIp } from '../../src/utils/client-ip.js';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';

/**
 * Create a minimal mock IncomingMessage for testing.
 */
function createMockRequest(opts: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string | null;
}): IncomingMessage {
  const { headers = {} } = opts;
  const remoteAddress = opts.remoteAddress === null
    ? undefined
    : (opts.remoteAddress ?? '127.0.0.1');
  return {
    headers,
    socket: { remoteAddress } as Socket,
  } as IncomingMessage;
}

describe('getClientIp', () => {
  describe('X-Real-IP header (preferred)', () => {
    it('should return X-Real-IP when present', () => {
      const req = createMockRequest({
        headers: { 'x-real-ip': '203.0.113.50' },
        remoteAddress: '127.0.0.1',
      });
      expect(getClientIp(req)).toBe('203.0.113.50');
    });

    it('should trim whitespace from X-Real-IP', () => {
      const req = createMockRequest({
        headers: { 'x-real-ip': '  203.0.113.50  ' },
      });
      expect(getClientIp(req)).toBe('203.0.113.50');
    });

    it('should prefer X-Real-IP over X-Forwarded-For', () => {
      const req = createMockRequest({
        headers: {
          'x-real-ip': '203.0.113.50',
          'x-forwarded-for': '198.51.100.1, 10.0.0.1',
        },
      });
      expect(getClientIp(req)).toBe('203.0.113.50');
    });

    it('should skip empty X-Real-IP and fall through to X-Forwarded-For', () => {
      const req = createMockRequest({
        headers: {
          'x-real-ip': '',
          'x-forwarded-for': '198.51.100.1',
        },
      });
      expect(getClientIp(req)).toBe('198.51.100.1');
    });

    it('should skip whitespace-only X-Real-IP', () => {
      const req = createMockRequest({
        headers: {
          'x-real-ip': '   ',
          'x-forwarded-for': '198.51.100.1',
        },
      });
      expect(getClientIp(req)).toBe('198.51.100.1');
    });
  });

  describe('X-Forwarded-For header (fallback)', () => {
    it('should return first IP from X-Forwarded-For when no X-Real-IP', () => {
      const req = createMockRequest({
        headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.1, 10.0.0.2' },
        remoteAddress: '127.0.0.1',
      });
      expect(getClientIp(req)).toBe('203.0.113.50');
    });

    it('should handle single IP in X-Forwarded-For', () => {
      const req = createMockRequest({
        headers: { 'x-forwarded-for': '203.0.113.50' },
      });
      expect(getClientIp(req)).toBe('203.0.113.50');
    });

    it('should trim whitespace from X-Forwarded-For entries', () => {
      const req = createMockRequest({
        headers: { 'x-forwarded-for': '  203.0.113.50 , 10.0.0.1' },
      });
      expect(getClientIp(req)).toBe('203.0.113.50');
    });

    it('should skip empty X-Forwarded-For and fall through to socket', () => {
      const req = createMockRequest({
        headers: { 'x-forwarded-for': '' },
        remoteAddress: '192.168.1.100',
      });
      expect(getClientIp(req)).toBe('192.168.1.100');
    });
  });

  describe('Direct connection fallback (no proxy headers)', () => {
    it('should return socket remoteAddress when no proxy headers', () => {
      const req = createMockRequest({
        headers: {},
        remoteAddress: '192.168.1.100',
      });
      expect(getClientIp(req)).toBe('192.168.1.100');
    });

    it('should return IPv6 address from socket', () => {
      const req = createMockRequest({
        headers: {},
        remoteAddress: '::ffff:192.168.1.100',
      });
      expect(getClientIp(req)).toBe('::ffff:192.168.1.100');
    });

    it('should return "unknown" when socket has no remoteAddress', () => {
      const req = createMockRequest({
        headers: {},
        remoteAddress: null, // null signals "no remoteAddress" to the mock
      });
      expect(getClientIp(req)).toBe('unknown');
    });
  });

  describe('IPv6 addresses', () => {
    it('should handle IPv6 in X-Real-IP', () => {
      const req = createMockRequest({
        headers: { 'x-real-ip': '2001:db8::1' },
      });
      expect(getClientIp(req)).toBe('2001:db8::1');
    });

    it('should handle IPv6 in X-Forwarded-For', () => {
      const req = createMockRequest({
        headers: { 'x-forwarded-for': '2001:db8::1, 10.0.0.1' },
      });
      expect(getClientIp(req)).toBe('2001:db8::1');
    });
  });
});
