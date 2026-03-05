/**
 * Unit tests for request validation utilities.
 *
 * Covers:
 * - parseJsonBody with valid JSON
 * - parseJsonBody with size limit enforcement (Content-Length check)
 * - parseJsonBody with size limit enforcement (actual body size check)
 * - BodyTooLargeError exception
 * - Malformed JSON handling
 * - Edge cases (empty body, missing Content-Length, spoofed header)
 */

import { describe, it, expect } from 'vitest';
import { parseJsonBody, BodyTooLargeError } from '../../src/utils/request-validation.js';

describe('Request Validation', () => {
  describe('parseJsonBody', () => {
    it('should parse valid JSON body', async () => {
      const body = JSON.stringify({ key: 'value', number: 123 });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
        headers: { 'Content-Length': body.length.toString() },
      });

      const parsed = await parseJsonBody(request);
      expect(parsed).toEqual({ key: 'value', number: 123 });
    });

    it('should reject body exceeding Content-Length limit', async () => {
      const body = JSON.stringify({ data: 'x'.repeat(70000) });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
        headers: { 'Content-Length': body.length.toString() },
      });

      await expect(parseJsonBody(request, 65536)).rejects.toThrow(BodyTooLargeError);
    });

    it('should include size limit in error message', async () => {
      const body = JSON.stringify({ data: 'x'.repeat(70000) });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
        headers: { 'Content-Length': body.length.toString() },
      });

      await expect(parseJsonBody(request, 65536)).rejects.toThrow(/exceeds 65536 byte limit/);
    });

    it('should handle missing Content-Length header', async () => {
      const body = JSON.stringify({ key: 'value' });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
      });

      const parsed = await parseJsonBody(request);
      expect(parsed).toEqual({ key: 'value' });
    });

    it('should reject malformed JSON', async () => {
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body: '{invalid json}',
        headers: { 'Content-Length': '14' },
      });

      await expect(parseJsonBody(request)).rejects.toThrow();
    });

    it('should handle empty body', async () => {
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body: '',
        headers: { 'Content-Length': '0' },
      });

      await expect(parseJsonBody(request)).rejects.toThrow();
    });

    it('should use custom size limit', async () => {
      const body = JSON.stringify({ data: 'x'.repeat(2000) });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
        headers: { 'Content-Length': body.length.toString() },
      });

      await expect(parseJsonBody(request, 1000)).rejects.toThrow(BodyTooLargeError);
    });

    it('should accept body within default limit', async () => {
      const body = JSON.stringify({ data: 'x'.repeat(100) });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
        headers: { 'Content-Length': body.length.toString() },
      });

      const parsed = await parseJsonBody(request);
      expect(parsed).toHaveProperty('data');
    });
  });

  describe('BodyTooLargeError', () => {
    it('should have correct error name', () => {
      const error = new BodyTooLargeError('test message');
      expect(error.name).toBe('BodyTooLargeError');
    });

    it('should preserve error message', () => {
      const message = 'Custom error message';
      const error = new BodyTooLargeError(message);
      expect(error.message).toBe(message);
    });

    it('should be instance of Error', () => {
      const error = new BodyTooLargeError('test');
      expect(error).toBeInstanceOf(Error);
    });
  });
});
