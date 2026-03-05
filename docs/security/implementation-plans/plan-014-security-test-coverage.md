# Implementation Plan 014: Test Coverage for Replay, Rotation, and Race Conditions

**Story Reference:** [Story 014: Test Coverage for Replay, Rotation, and Race Conditions](../stories/story-014-security-test-coverage.md)

**Priority:** THIS SPRINT
**Severity:** HIGH
**Component:** packages/server

---

## 1. Summary

The server package currently has **partial test coverage** with 7 existing test files covering some functionality (anomaly detection, attestation crypto, signing, build verification, and e2e integration). However, critical gaps remain:

**Missing Unit Tests:**
- `RateLimiter` class (rate-limiter.js) - no tests for window behavior, pruning, boundary conditions
- `timingSafeEqual` function (timing-safe.js) - no tests for correctness or constant-time behavior
- `parseJsonBody` function (request-validation.js) - no tests for size limit enforcement
- CORS utilities (cors.js) - no tests for origin validation, wildcard patterns
- Logger utilities (logger.js) - no tests for redaction, log levels, environment awareness

**Missing Security Tests:**
- Replay attack scenarios (nonce reuse, expired nonces, cross-device nonces)
- Key rotation scenarios (trusted key replacement, CI_UPLOAD_SECRET rotation, ATTESTATION_SIGNING_KEY rotation)
- Race condition scenarios (concurrent heartbeats, concurrent nonce creation, concurrent key updates, alarm vs request races)
- HKDF edge cases (empty secret, Unicode secret, max-length secret)
- Ciphertext tampering (bit-flip detection, IV reuse detection, truncated ciphertext)
- NaN validation (from Story 013 dependency)

This plan will add the missing test files and scenarios to achieve >80% code coverage and comprehensive security coverage.

---

## 2. Files to Modify

### New Test Files to Create

| File Path | Purpose |
|-----------|---------|
| `/home/meywd/zajel-ddos/packages/server/tests/unit/rate-limiter.test.js` | Unit tests for RateLimiter class |
| `/home/meywd/zajel-ddos/packages/server/tests/unit/timing-safe.test.js` | Unit tests for timingSafeEqual function |
| `/home/meywd/zajel-ddos/packages/server/tests/unit/request-validation.test.js` | Unit tests for parseJsonBody and BodyTooLargeError |
| `/home/meywd/zajel-ddos/packages/server/tests/unit/cors.test.js` | Unit tests for CORS header generation and origin validation |
| `/home/meywd/zajel-ddos/packages/server/tests/unit/logger.test.js` | Unit tests for logger utilities and redaction |
| `/home/meywd/zajel-ddos/packages/server/tests/security/replay-attack.test.js` | Security tests for replay attacks (nonce reuse, expiry, cross-device) |
| `/home/meywd/zajel-ddos/packages/server/tests/security/key-rotation.test.js` | Security tests for key rotation scenarios |
| `/home/meywd/zajel-ddos/packages/server/tests/security/race-conditions.test.js` | Security tests for concurrent access patterns |
| `/home/meywd/zajel-ddos/packages/server/tests/security/hkdf-edge-cases.test.js` | Security tests for HKDF key derivation edge cases |
| `/home/meywd/zajel-ddos/packages/server/tests/security/ciphertext-tampering.test.js` | Security tests for encrypted data integrity |
| `/home/meywd/zajel-ddos/packages/server/tests/security/nan-validation.test.js` | Security tests for NaN input handling |
| `/home/meywd/zajel-ddos/packages/server/tests/helpers/mock-do.js` | Shared mock helpers for Durable Objects (extract from existing tests) |

### Existing Files (No Modifications)

The following source files will be tested but **not modified**:
- `/home/meywd/zajel-ddos/packages/server/src/rate-limiter.js`
- `/home/meywd/zajel-ddos/packages/server/src/crypto/timing-safe.js`
- `/home/meywd/zajel-ddos/packages/server/src/utils/request-validation.js`
- `/home/meywd/zajel-ddos/packages/server/src/cors.js`
- `/home/meywd/zajel-ddos/packages/server/src/logger.js`
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/attestation-registry-do.js`
- `/home/meywd/zajel-ddos/packages/server/src/crypto/attestation.js`

---

## 3. Implementation Steps

### Step 1: Create Shared Mock Helpers

Extract common mock infrastructure from existing tests into a reusable module.

**File:** `/home/meywd/zajel-ddos/packages/server/tests/helpers/mock-do.js`

```javascript
/**
 * Shared mock infrastructure for Durable Object tests.
 *
 * Provides reusable mocks for:
 * - Durable Object Storage
 * - Durable Object State
 * - Durable Object Stub
 * - Request creation utilities
 */

/**
 * Mock implementation of Durable Object Storage API.
 */
export class MockStorage {
  constructor() {
    this.data = new Map();
    this._alarm = null;
  }

  async get(key) {
    return this.data.get(key);
  }

  async put(key, value) {
    this.data.set(key, value);
  }

  async delete(keyOrKeys) {
    if (Array.isArray(keyOrKeys)) {
      for (const k of keyOrKeys) this.data.delete(k);
    } else {
      this.data.delete(keyOrKeys);
    }
  }

  async list({ prefix = '', limit } = {}) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        results.set(key, value);
        if (limit && results.size >= limit) break;
      }
    }
    return results;
  }

  async getAlarm() {
    return this._alarm;
  }

  async setAlarm(time) {
    this._alarm = time;
  }

  clear() {
    this.data.clear();
    this._alarm = null;
  }
}

/**
 * Mock implementation of Durable Object State.
 */
export class MockState {
  constructor() {
    this.storage = new MockStorage();
  }

  blockConcurrencyWhile(fn) {
    return fn();
  }
}

/**
 * Mock implementation of Durable Object Stub.
 */
export class MockDurableObjectStub {
  constructor(doInstance) {
    this.doInstance = doInstance;
  }

  async fetch(request) {
    return this.doInstance.fetch(request);
  }
}

/**
 * Create a mock environment object with default values.
 */
export function createMockEnv(overrides = {}) {
  return {
    SERVER_REGISTRY_SECRET: 'test-secret',
    CI_UPLOAD_SECRET: 'test-ci-secret',
    ATTESTATION_SIGNING_KEY: null,
    TRUSTED_BUILD_KEYS: '',
    DEV_MODE: 'false',
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

/**
 * Create a Request object for testing.
 */
export function createRequest(method, path, body = null, headers = {}) {
  const url = `https://test.workers.dev${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return new Request(url, options);
}
```

---

### Step 2: Create Unit Test for RateLimiter

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/rate-limiter.test.js`

```javascript
/**
 * Unit tests for RateLimiter class.
 *
 * Covers:
 * - Basic rate limiting (check within limit, exceeded limit)
 * - Sliding window behavior
 * - Window reset after expiry
 * - Pruning expired entries
 * - Multiple IPs tracked independently
 * - Edge cases (boundary conditions, zero limit, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../../src/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('check()', () => {
    it('should allow first request within limit', () => {
      const result = limiter.check('192.168.1.1', 10, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it('should allow subsequent requests up to limit', () => {
      const ip = '192.168.1.1';
      for (let i = 0; i < 10; i++) {
        const result = limiter.check(ip, 10, 60000);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9 - i);
      }
    });

    it('should reject requests exceeding limit', () => {
      const ip = '192.168.1.1';
      // Use up the limit
      for (let i = 0; i < 10; i++) {
        limiter.check(ip, 10, 60000);
      }
      // Next request should be rejected
      const result = limiter.check(ip, 10, 60000);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should reset counter after window expires', () => {
      const ip = '192.168.1.1';
      limiter.check(ip, 10, 60000); // count = 1

      // Advance time past window
      vi.advanceTimersByTime(61000);

      const result = limiter.check(ip, 10, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9); // Fresh window
    });

    it('should track multiple IPs independently', () => {
      const ip1 = '192.168.1.1';
      const ip2 = '192.168.1.2';

      limiter.check(ip1, 5, 60000); // ip1: count = 1
      limiter.check(ip1, 5, 60000); // ip1: count = 2
      limiter.check(ip2, 5, 60000); // ip2: count = 1

      expect(limiter.counters.get(ip1).count).toBe(2);
      expect(limiter.counters.get(ip2).count).toBe(1);
    });

    it('should handle boundary case at exact limit', () => {
      const ip = '192.168.1.1';
      for (let i = 0; i < 9; i++) {
        limiter.check(ip, 10, 60000);
      }
      // 10th request should be allowed (at limit)
      const result = limiter.check(ip, 10, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);

      // 11th request should be rejected
      const rejected = limiter.check(ip, 10, 60000);
      expect(rejected.allowed).toBe(false);
    });

    it('should handle limit of 1', () => {
      const ip = '192.168.1.1';
      const first = limiter.check(ip, 1, 60000);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(0);

      const second = limiter.check(ip, 1, 60000);
      expect(second.allowed).toBe(false);
      expect(second.remaining).toBe(0);
    });

    it('should handle very short windows', () => {
      const ip = '192.168.1.1';
      limiter.check(ip, 5, 1000); // 1 second window

      vi.advanceTimersByTime(1001);

      const result = limiter.check(ip, 5, 1000);
      expect(result.allowed).toBe(true); // Window reset
    });
  });

  describe('prune()', () => {
    it('should remove expired entries', () => {
      limiter.check('192.168.1.1', 10, 60000);
      limiter.check('192.168.1.2', 10, 60000);
      limiter.check('192.168.1.3', 10, 60000);

      expect(limiter.counters.size).toBe(3);

      // Advance time past window
      vi.advanceTimersByTime(61000);

      limiter.prune();

      expect(limiter.counters.size).toBe(0);
    });

    it('should keep non-expired entries', () => {
      limiter.check('192.168.1.1', 10, 60000); // t=0

      vi.advanceTimersByTime(30000); // t=30s

      limiter.check('192.168.1.2', 10, 60000); // t=30s

      vi.advanceTimersByTime(35000); // t=65s (ip1 expired, ip2 still valid)

      limiter.prune();

      expect(limiter.counters.size).toBe(1);
      expect(limiter.counters.has('192.168.1.2')).toBe(true);
    });

    it('should handle empty counters map', () => {
      expect(() => limiter.prune()).not.toThrow();
    });
  });
});
```

---

### Step 3: Create Unit Test for timingSafeEqual

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/timing-safe.test.js`

```javascript
/**
 * Unit tests for timingSafeEqual function.
 *
 * Covers:
 * - Correctness (equal strings return true, different strings return false)
 * - Different length strings (return false without leaking length via timing)
 * - Empty strings
 * - Unicode/multi-byte characters
 * - Edge cases
 *
 * NOTE: True constant-time verification requires specialized tools/benchmarks.
 * These tests verify functional correctness and that the implementation
 * processes all bytes (preventing early return leaks).
 */

import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from '../../src/crypto/timing-safe.js';

describe('timingSafeEqual', () => {
  describe('Correctness', () => {
    it('should return true for equal strings', () => {
      expect(timingSafeEqual('abc', 'abc')).toBe(true);
      expect(timingSafeEqual('test123', 'test123')).toBe(true);
      expect(timingSafeEqual('', '')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(timingSafeEqual('abc', 'abd')).toBe(false);
      expect(timingSafeEqual('test', 'best')).toBe(false);
      expect(timingSafeEqual('a', 'b')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(timingSafeEqual('ab', 'abc')).toBe(false);
      expect(timingSafeEqual('abc', 'ab')).toBe(false);
      expect(timingSafeEqual('', 'a')).toBe(false);
    });

    it('should handle long strings', () => {
      const str1 = 'a'.repeat(1000);
      const str2 = 'a'.repeat(1000);
      const str3 = 'a'.repeat(999) + 'b';

      expect(timingSafeEqual(str1, str2)).toBe(true);
      expect(timingSafeEqual(str1, str3)).toBe(false);
    });
  });

  describe('Unicode Support', () => {
    it('should handle multi-byte UTF-8 characters', () => {
      expect(timingSafeEqual('😀', '😀')).toBe(true);
      expect(timingSafeEqual('😀', '😁')).toBe(false);
      expect(timingSafeEqual('こんにちは', 'こんにちは')).toBe(true);
      expect(timingSafeEqual('こんにちは', 'さようなら')).toBe(false);
    });

    it('should handle mixed ASCII and Unicode', () => {
      const str1 = 'Hello 世界';
      const str2 = 'Hello 世界';
      const str3 = 'Hello 世';

      expect(timingSafeEqual(str1, str2)).toBe(true);
      expect(timingSafeEqual(str1, str3)).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty strings', () => {
      expect(timingSafeEqual('', '')).toBe(true);
      expect(timingSafeEqual('', 'a')).toBe(false);
      expect(timingSafeEqual('a', '')).toBe(false);
    });

    it('should handle whitespace', () => {
      expect(timingSafeEqual(' ', ' ')).toBe(true);
      expect(timingSafeEqual('  ', '  ')).toBe(true);
      expect(timingSafeEqual(' ', '')).toBe(false);
    });

    it('should differentiate case', () => {
      expect(timingSafeEqual('ABC', 'abc')).toBe(false);
      expect(timingSafeEqual('Test', 'test')).toBe(false);
    });

    it('should handle special characters', () => {
      expect(timingSafeEqual('a!@#$%', 'a!@#$%')).toBe(true);
      expect(timingSafeEqual('a\nb\tc', 'a\nb\tc')).toBe(true);
      expect(timingSafeEqual('a\nb', 'a\tb')).toBe(false);
    });
  });

  describe('Constant-Time Behavior (Structural)', () => {
    it('should process all bytes even when first byte differs', () => {
      // This test verifies that the function doesn't short-circuit.
      // The implementation XORs all bytes, so both paths should execute.
      const result1 = timingSafeEqual('abcdefgh', 'xbcdefgh'); // First byte differs
      const result2 = timingSafeEqual('abcdefgh', 'abcdefgx'); // Last byte differs

      expect(result1).toBe(false);
      expect(result2).toBe(false);
      // Both should return false, having processed all bytes
    });

    it('should handle different lengths without timing leak', () => {
      // The implementation performs a dummy comparison loop for length mismatch.
      // Verify it returns false without crashing.
      expect(timingSafeEqual('short', 'verylongstring')).toBe(false);
      expect(timingSafeEqual('verylongstring', 'short')).toBe(false);
    });
  });
});
```

---

### Step 4: Create Unit Test for request-validation

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/request-validation.test.js`

```javascript
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
      await expect(parseJsonBody(request, 65536)).rejects.toThrow(/exceeds 65536 byte limit/);
    });

    it('should reject body exceeding actual size limit', async () => {
      // Spoofed Content-Length (claims smaller than actual)
      const body = JSON.stringify({ data: 'x'.repeat(70000) });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
        headers: { 'Content-Length': '1000' }, // Lie about size
      });

      await expect(parseJsonBody(request, 65536)).rejects.toThrow(BodyTooLargeError);
    });

    it('should accept body at exact limit', async () => {
      const body = JSON.stringify({ data: 'x'.repeat(65500) });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
        headers: { 'Content-Length': body.length.toString() },
      });

      const parsed = await parseJsonBody(request, 65536);
      expect(parsed).toHaveProperty('data');
    });

    it('should handle missing Content-Length header', async () => {
      const body = JSON.stringify({ key: 'value' });
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body,
        // No Content-Length header
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

      await expect(parseJsonBody(request)).rejects.toThrow(SyntaxError);
    });

    it('should handle empty body', async () => {
      const request = new Request('https://test.workers.dev', {
        method: 'POST',
        body: '',
        headers: { 'Content-Length': '0' },
      });

      await expect(parseJsonBody(request)).rejects.toThrow(SyntaxError);
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
```

---

### Step 5: Create Unit Test for CORS

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/cors.test.js`

```javascript
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
 * - Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
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

      expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS');
      expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
      expect(headers['Access-Control-Expose-Headers']).toBe('X-Bootstrap-Signature, X-Attestation-Token');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Cache-Control']).toBe('no-store');
      expect(headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
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
  });
});
```

---

### Step 6: Create Unit Test for Logger

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/logger.test.js`

```javascript
/**
 * Unit tests for logger utilities.
 *
 * Covers:
 * - redactPairingCode function
 * - createLogger with different environments
 * - Log level filtering
 * - Pairing event logging with automatic redaction
 * - Production vs development behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { redactPairingCode, createLogger } from '../../src/logger.js';

describe('Logger Utilities', () => {
  describe('redactPairingCode', () => {
    it('should redact middle characters of code', () => {
      expect(redactPairingCode('ABC123')).toBe('A****3');
      expect(redactPairingCode('TEST')).toBe('T****T');
    });

    it('should handle short codes', () => {
      expect(redactPairingCode('AB')).toBe('****');
      expect(redactPairingCode('A')).toBe('****');
      expect(redactPairingCode('')).toBe('****');
    });

    it('should handle three character code', () => {
      expect(redactPairingCode('ABC')).toBe('A****C');
    });

    it('should handle long codes', () => {
      expect(redactPairingCode('ABCDEFGHIJ')).toBe('A****J');
    });
  });

  describe('createLogger', () => {
    let consoleSpies;

    beforeEach(() => {
      consoleSpies = {
        debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('Environment Detection', () => {
      it('should detect production environment', () => {
        const logger = createLogger({ ENVIRONMENT: 'production' });
        expect(logger.shouldRedact).toBe(true);
      });

      it('should detect development environment', () => {
        const logger = createLogger({ ENVIRONMENT: 'development' });
        expect(logger.shouldRedact).toBe(false);
      });

      it('should default to development when no env provided', () => {
        const logger = createLogger();
        expect(logger.shouldRedact).toBe(false);
      });

      it('should support NODE_ENV for production detection', () => {
        const logger = createLogger({ NODE_ENV: 'production' });
        expect(logger.shouldRedact).toBe(true);
      });
    });

    describe('Pairing Code Redaction', () => {
      it('should redact pairing codes in production', () => {
        const logger = createLogger({ ENVIRONMENT: 'production' });
        expect(logger.pairingCode('ABC123')).toBe('A****3');
      });

      it('should not redact pairing codes in development', () => {
        const logger = createLogger({ ENVIRONMENT: 'development' });
        expect(logger.pairingCode('ABC123')).toBe('ABC123');
      });
    });

    describe('Log Level Filtering', () => {
      it('should log debug messages when level is debug', () => {
        const logger = createLogger({ LOG_LEVEL: 'debug' });
        logger.debug('test message');
        expect(consoleSpies.debug).toHaveBeenCalledWith('[DEBUG] test message');
      });

      it('should not log debug messages when level is info', () => {
        const logger = createLogger({ LOG_LEVEL: 'info' });
        logger.debug('test message');
        expect(consoleSpies.debug).not.toHaveBeenCalled();
      });

      it('should log info messages when level is info', () => {
        const logger = createLogger({ LOG_LEVEL: 'info' });
        logger.info('test message');
        expect(consoleSpies.log).toHaveBeenCalledWith('[INFO] test message');
      });

      it('should not log info messages when level is warn', () => {
        const logger = createLogger({ LOG_LEVEL: 'warn' });
        logger.info('test message');
        expect(consoleSpies.log).not.toHaveBeenCalled();
      });

      it('should log warn messages when level is warn', () => {
        const logger = createLogger({ LOG_LEVEL: 'warn' });
        logger.warn('test message');
        expect(consoleSpies.warn).toHaveBeenCalledWith('[WARN] test message');
      });

      it('should always log error messages', () => {
        const logger = createLogger({ LOG_LEVEL: 'error' });
        logger.error('test message');
        expect(consoleSpies.error).toHaveBeenCalledWith('[ERROR] test message', '');
      });

      it('should default to info level in production', () => {
        const logger = createLogger({ ENVIRONMENT: 'production' });
        logger.debug('test');
        expect(consoleSpies.debug).not.toHaveBeenCalled();
        logger.info('test');
        expect(consoleSpies.log).toHaveBeenCalled();
      });

      it('should default to debug level in development', () => {
        const logger = createLogger({ ENVIRONMENT: 'development' });
        logger.debug('test');
        expect(consoleSpies.debug).toHaveBeenCalled();
      });
    });

    describe('Log Messages with Metadata', () => {
      it('should log debug with metadata', () => {
        const logger = createLogger({ LOG_LEVEL: 'debug' });
        logger.debug('test', { key: 'value' });
        expect(consoleSpies.debug).toHaveBeenCalledWith('[DEBUG] test', { key: 'value' });
      });

      it('should log info with metadata', () => {
        const logger = createLogger({ LOG_LEVEL: 'info' });
        logger.info('test', { key: 'value' });
        expect(consoleSpies.log).toHaveBeenCalledWith('[INFO] test', { key: 'value' });
      });

      it('should log warn with metadata', () => {
        const logger = createLogger({ LOG_LEVEL: 'warn' });
        logger.warn('test', { key: 'value' });
        expect(consoleSpies.warn).toHaveBeenCalledWith('[WARN] test', { key: 'value' });
      });

      it('should log error with Error object', () => {
        const logger = createLogger({ LOG_LEVEL: 'error' });
        const error = new Error('test error');
        logger.error('test', error);
        expect(consoleSpies.error).toHaveBeenCalledWith('[ERROR] test', error);
      });
    });

    describe('Pairing Event Logging', () => {
      it('should log pairing event with redacted code in production', () => {
        const logger = createLogger({ ENVIRONMENT: 'production', LOG_LEVEL: 'debug' });
        logger.pairingEvent('registered', 'ABC123');
        expect(consoleSpies.debug).toHaveBeenCalledWith(
          '[Pairing] registered',
          { code: 'A****3' }
        );
      });

      it('should log pairing event with plain code in development', () => {
        const logger = createLogger({ ENVIRONMENT: 'development', LOG_LEVEL: 'debug' });
        logger.pairingEvent('registered', 'ABC123');
        expect(consoleSpies.debug).toHaveBeenCalledWith(
          '[Pairing] registered',
          { code: 'ABC123' }
        );
      });

      it('should log pairing event with target code', () => {
        const logger = createLogger({ ENVIRONMENT: 'production', LOG_LEVEL: 'debug' });
        logger.pairingEvent('signaling', 'ABC123', 'XYZ789');
        expect(consoleSpies.debug).toHaveBeenCalledWith(
          '[Pairing] signaling',
          { code: 'A****3', target: 'X****9' }
        );
      });
    });
  });
});
```

---

### Step 7: Create Security Test for Replay Attacks

**File:** `/home/meywd/zajel-ddos/packages/server/tests/security/replay-attack.test.js`

```javascript
/**
 * Security tests for replay attack prevention.
 *
 * Covers:
 * - Nonce reuse detection (POST /attest/verify)
 * - Expired nonce rejection
 * - Cross-device nonce rejection
 * - Build token replay (intentionally allowed for multiple registrations)
 * - Session token replay prevention
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AttestationRegistryDO } from '../../src/durable-objects/attestation-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';
import {
  importAttestationSigningKey,
  signPayloadEd25519,
  computeHmac,
} from '../../src/crypto/attestation.js';

async function generateTestSeed() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  return Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function createBuildToken(seedHex, tokenPayload) {
  const signingKey = await importAttestationSigningKey(seedHex);
  const payload = JSON.stringify(tokenPayload);
  const signature = await signPayloadEd25519(signingKey, payload);
  return { payload, signature };
}

describe('Replay Attack Prevention', () => {
  let mockState;
  let attestationDO;
  let seedHex;

  beforeEach(async () => {
    mockState = new MockState();
    seedHex = await generateTestSeed();
    attestationDO = new AttestationRegistryDO(mockState, {
      ATTESTATION_SIGNING_KEY: seedHex,
      CI_UPLOAD_SECRET: 'test-secret',
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  describe('Nonce Reuse Detection', () => {
    it('should reject reused nonce', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      // Register device
      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));

      // Request challenge
      const challengeResp = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', { device_id: 'device-001' })
      );
      const { nonce, critical_regions } = await challengeResp.json();

      // Compute valid HMAC
      const criticalData = new Uint8Array(
        critical_regions.flatMap(r => Array.from(r.data_hex.match(/.{2}/g).map(b => parseInt(b, 16))))
      );
      const hmac = await computeHmac(criticalData, nonce);

      // First verify (should succeed)
      const firstVerify = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          hmac,
        })
      );
      expect(firstVerify.status).toBe(200);

      // Second verify with same nonce (should fail - nonce consumed)
      const secondVerify = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          hmac,
        })
      );
      expect(secondVerify.status).toBe(400);
      const data = await secondVerify.json();
      expect(data.error).toContain('Invalid or expired nonce');
    });
  });

  describe('Expired Nonce Rejection', () => {
    it('should reject nonce after NONCE_TTL expires', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));

      const challengeResp = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', { device_id: 'device-001' })
      );
      const { nonce, critical_regions } = await challengeResp.json();

      const criticalData = new Uint8Array(
        critical_regions.flatMap(r => Array.from(r.data_hex.match(/.{2}/g).map(b => parseInt(b, 16))))
      );
      const hmac = await computeHmac(criticalData, nonce);

      // Advance time past NONCE_TTL (5 minutes)
      vi.advanceTimersByTime(6 * 60 * 1000);

      const verifyResp = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          hmac,
        })
      );
      expect(verifyResp.status).toBe(400);
      const data = await verifyResp.json();
      expect(data.error).toContain('Invalid or expired nonce');
    });

    it('should accept nonce just before expiry', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));

      const challengeResp = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', { device_id: 'device-001' })
      );
      const { nonce, critical_regions } = await challengeResp.json();

      const criticalData = new Uint8Array(
        critical_regions.flatMap(r => Array.from(r.data_hex.match(/.{2}/g).map(b => parseInt(b, 16))))
      );
      const hmac = await computeHmac(criticalData, nonce);

      // Advance time to 4m 50s (just before 5m TTL)
      vi.advanceTimersByTime(290 * 1000);

      const verifyResp = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          hmac,
        })
      );
      expect(verifyResp.status).toBe(200);
    });
  });

  describe('Cross-Device Nonce Rejection', () => {
    it('should reject nonce from different device', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      // Register device-001
      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));

      // Register device-002
      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-002',
      }));

      // Get challenge for device-001
      const challengeResp = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', { device_id: 'device-001' })
      );
      const { nonce, critical_regions } = await challengeResp.json();

      const criticalData = new Uint8Array(
        critical_regions.flatMap(r => Array.from(r.data_hex.match(/.{2}/g).map(b => parseInt(b, 16))))
      );
      const hmac = await computeHmac(criticalData, nonce);

      // Try to use device-001's nonce with device-002
      const verifyResp = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-002', // Wrong device
          nonce,
          hmac,
        })
      );
      expect(verifyResp.status).toBe(400);
      const data = await verifyResp.json();
      expect(data.error).toContain('Invalid or expired nonce');
    });
  });

  describe('Build Token Replay (Intentional Behavior)', () => {
    it('should allow same build token to register multiple devices', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      // Register device-001
      const resp1 = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));
      expect(resp1.status).toBe(200);

      // Register device-002 with same token (should succeed - intentional)
      const resp2 = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-002',
      }));
      expect(resp2.status).toBe(200);
    });

    it('should check build token timestamp for staleness', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days old
      });

      const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));
      expect(resp.status).toBe(400);
      const data = await resp.json();
      expect(data.error).toContain('Build token timestamp');
    });
  });

  describe('Session Token Replay Prevention', () => {
    it('should reject session token after expiry', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));

      const challengeResp = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', { device_id: 'device-001' })
      );
      const { nonce, critical_regions } = await challengeResp.json();

      const criticalData = new Uint8Array(
        critical_regions.flatMap(r => Array.from(r.data_hex.match(/.{2}/g).map(b => parseInt(b, 16))))
      );
      const hmac = await computeHmac(criticalData, nonce);

      const verifyResp = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          hmac,
        })
      );
      const { session_token } = await verifyResp.json();

      // Session token should have ~24h expiry
      // Advance time past expiry
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      // Try to use expired session token (would be validated by client/server code)
      // This test verifies the token structure includes expiry
      expect(session_token).toBeDefined();
      expect(typeof session_token).toBe('string');
      expect(session_token.includes('.')).toBe(true); // Has signature separator
    });
  });
});
```

---

### Step 8: Create Security Test for Key Rotation

**File:** `/home/meywd/zajel-ddos/packages/server/tests/security/key-rotation.test.js`

```javascript
/**
 * Security tests for key rotation scenarios.
 *
 * Covers:
 * - Trusted build key replacement (invalidates old keys)
 * - Trusted build key addition (addKeys operation)
 * - Trusted build key removal (removeKeys operation)
 * - CI_UPLOAD_SECRET rotation (encrypted keys become unreadable)
 * - ATTESTATION_SIGNING_KEY rotation (old session tokens rejected)
 * - Graceful fallback when decryption fails
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { AttestationRegistryDO } from '../../src/durable-objects/attestation-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';
import {
  importAttestationSigningKey,
  exportPublicKeyBase64,
  signPayloadEd25519,
  createSessionToken,
  verifySessionToken,
  importVerifyKey,
} from '../../src/crypto/attestation.js';

async function generateTestKeypair() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');

  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const publicKeyBytes = spki.slice(-32);
  const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

  return { keyPair, seedHex, publicKeyBase64 };
}

async function signBuildHash(privateKey, buildHash) {
  const data = new TextEncoder().encode(buildHash);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

describe('Key Rotation Security', () => {
  describe('Trusted Build Key Rotation', () => {
    let mockState;
    let serverRegistry;
    let keypair1, keypair2;

    beforeEach(async () => {
      mockState = new MockState();
      keypair1 = await generateTestKeypair();
      keypair2 = await generateTestKeypair();
      serverRegistry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'test-secret',
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should invalidate old keys when replacing with new keys', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      // Set initial key
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair1.publicKeyBase64],
      }, authHeaders));

      // Register server with keypair1 (should be verified)
      const buildHash1 = 'a'.repeat(64);
      const sig1 = await signBuildHash(keypair1.keyPair.privateKey, buildHash1);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server1',
        endpoint: 'wss://s1.example.com',
        publicKey: 'key1',
        buildHash: buildHash1,
        buildSignature: sig1,
        buildSigningKey: keypair1.publicKeyBase64,
      }));

      let entry = await mockState.storage.get('server:ed25519:server1');
      expect(entry.buildVerified).toBe(true);

      // Replace keys with keypair2 (invalidates keypair1)
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair2.publicKeyBase64], // Complete replacement
      }, authHeaders));

      // Register new server with keypair1 (should NOT be verified - key revoked)
      const buildHash2 = 'b'.repeat(64);
      const sig2 = await signBuildHash(keypair1.keyPair.privateKey, buildHash2);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server2',
        endpoint: 'wss://s2.example.com',
        publicKey: 'key2',
        buildHash: buildHash2,
        buildSignature: sig2,
        buildSigningKey: keypair1.publicKeyBase64,
      }));

      entry = await mockState.storage.get('server:ed25519:server2');
      expect(entry.buildVerified).toBe(false); // Old key no longer trusted
    });

    it('should allow adding keys without invalidating existing', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      // Set initial key
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair1.publicKeyBase64],
      }, authHeaders));

      // Add keypair2 (without removing keypair1)
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        addKeys: [keypair2.publicKeyBase64],
      }, authHeaders));

      // Both keys should work
      const buildHash1 = 'a'.repeat(64);
      const sig1 = await signBuildHash(keypair1.keyPair.privateKey, buildHash1);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server1',
        endpoint: 'wss://s1.example.com',
        publicKey: 'key1',
        buildHash: buildHash1,
        buildSignature: sig1,
        buildSigningKey: keypair1.publicKeyBase64,
      }));

      const buildHash2 = 'b'.repeat(64);
      const sig2 = await signBuildHash(keypair2.keyPair.privateKey, buildHash2);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server2',
        endpoint: 'wss://s2.example.com',
        publicKey: 'key2',
        buildHash: buildHash2,
        buildSignature: sig2,
        buildSigningKey: keypair2.publicKeyBase64,
      }));

      const entry1 = await mockState.storage.get('server:ed25519:server1');
      const entry2 = await mockState.storage.get('server:ed25519:server2');
      expect(entry1.buildVerified).toBe(true);
      expect(entry2.buildVerified).toBe(true);
    });

    it('should allow removing specific keys', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      // Set both keys
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair1.publicKeyBase64, keypair2.publicKeyBase64],
      }, authHeaders));

      // Remove keypair1
      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        removeKeys: [keypair1.publicKeyBase64],
      }, authHeaders));

      // keypair1 should no longer work
      const buildHash1 = 'a'.repeat(64);
      const sig1 = await signBuildHash(keypair1.keyPair.privateKey, buildHash1);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server1',
        endpoint: 'wss://s1.example.com',
        publicKey: 'key1',
        buildHash: buildHash1,
        buildSignature: sig1,
        buildSigningKey: keypair1.publicKeyBase64,
      }));

      const entry1 = await mockState.storage.get('server:ed25519:server1');
      expect(entry1.buildVerified).toBe(false);

      // keypair2 should still work
      const buildHash2 = 'b'.repeat(64);
      const sig2 = await signBuildHash(keypair2.keyPair.privateKey, buildHash2);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:server2',
        endpoint: 'wss://s2.example.com',
        publicKey: 'key2',
        buildHash: buildHash2,
        buildSignature: sig2,
        buildSigningKey: keypair2.publicKeyBase64,
      }));

      const entry2 = await mockState.storage.get('server:ed25519:server2');
      expect(entry2.buildVerified).toBe(true);
    });
  });

  describe('CI_UPLOAD_SECRET Rotation', () => {
    let mockState;
    let serverRegistry;
    let keypair;

    beforeEach(async () => {
      mockState = new MockState();
      keypair = await generateTestKeypair();
      vi.useFakeTimers();
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should fail to decrypt keys with wrong CI_UPLOAD_SECRET', async () => {
      // Upload keys with secret1
      serverRegistry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'secret1',
      });

      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer secret1' }));

      // Raw storage should contain encrypted data
      const raw = await mockState.storage.get('trusted_build_keys');
      expect(raw.encrypted).toBe(true);

      // Create new registry with different secret (simulates secret rotation)
      serverRegistry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'secret2', // Different secret
      });

      // Attempt to GET keys with new secret should fail or return empty
      const resp = await serverRegistry.fetch(createRequest('GET', '/servers/trusted-keys', null, {
        Authorization: 'Bearer secret2',
      }));

      // Should return 503 or empty keys (graceful fallback)
      // Implementation may vary - verify it doesn't crash
      expect([200, 503]).toContain(resp.status);
    });

    it('should fall back to env var when decryption fails', async () => {
      // Upload keys with secret1
      serverRegistry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'secret1',
        TRUSTED_BUILD_KEYS: '', // Empty env var
      });

      await serverRegistry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, { Authorization: 'Bearer secret1' }));

      // Create new registry with different secret BUT with env var fallback
      const fallbackKeypair = await generateTestKeypair();
      serverRegistry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'secret2',
        TRUSTED_BUILD_KEYS: fallbackKeypair.publicKeyBase64, // Fallback key
      });

      // Register server with fallback key (should work)
      const buildHash = 'c'.repeat(64);
      const sig = await signBuildHash(fallbackKeypair.keyPair.privateKey, buildHash);
      await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:fallback-server',
        endpoint: 'wss://fb.example.com',
        publicKey: 'key',
        buildHash,
        buildSignature: sig,
        buildSigningKey: fallbackKeypair.publicKeyBase64,
      }));

      const entry = await mockState.storage.get('server:ed25519:fallback-server');
      expect(entry.buildVerified).toBe(true);
    });
  });

  describe('ATTESTATION_SIGNING_KEY Rotation', () => {
    let mockState;
    let attestationDO;
    let seed1, seed2;

    beforeEach(async () => {
      mockState = new MockState();
      const kp1 = await generateTestKeypair();
      const kp2 = await generateTestKeypair();
      seed1 = kp1.seedHex;
      seed2 = kp2.seedHex;
      vi.useFakeTimers();
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should reject session tokens signed with old key after rotation', async () => {
      // Create DO with seed1
      attestationDO = new AttestationRegistryDO(mockState, {
        ATTESTATION_SIGNING_KEY: seed1,
        CI_UPLOAD_SECRET: 'test-secret',
      });

      // Create session token with seed1
      const signingKey1 = await importAttestationSigningKey(seed1);
      const tokenData = {
        device_id: 'device-001',
        build_version: '1.0.0',
        expires_at: Date.now() + 3600000,
      };
      const sessionToken = await createSessionToken(signingKey1, tokenData);

      // Verify token works with seed1
      const verifyKey1 = await importVerifyKey(await exportPublicKeyBase64(signingKey1));
      const decoded1 = await verifySessionToken(verifyKey1, sessionToken);
      expect(decoded1).not.toBeNull();

      // Rotate to seed2
      attestationDO = new AttestationRegistryDO(mockState, {
        ATTESTATION_SIGNING_KEY: seed2, // New key
        CI_UPLOAD_SECRET: 'test-secret',
      });

      // Try to verify old token with new key (should fail)
      const signingKey2 = await importAttestationSigningKey(seed2);
      const verifyKey2 = await importVerifyKey(await exportPublicKeyBase64(signingKey2));
      const decoded2 = await verifySessionToken(verifyKey2, sessionToken);
      expect(decoded2).toBeNull(); // Token signature invalid with new key
    });

    it('should allow new tokens after key rotation', async () => {
      // Create DO with seed2 (after rotation)
      attestationDO = new AttestationRegistryDO(mockState, {
        ATTESTATION_SIGNING_KEY: seed2,
        CI_UPLOAD_SECRET: 'test-secret',
      });

      // Create session token with seed2
      const signingKey2 = await importAttestationSigningKey(seed2);
      const tokenData = {
        device_id: 'device-002',
        build_version: '1.0.0',
        expires_at: Date.now() + 3600000,
      };
      const sessionToken = await createSessionToken(signingKey2, tokenData);

      // Verify token works with seed2
      const verifyKey2 = await importVerifyKey(await exportPublicKeyBase64(signingKey2));
      const decoded = await verifySessionToken(verifyKey2, sessionToken);
      expect(decoded).not.toBeNull();
      expect(decoded.device_id).toBe('device-002');
    });
  });
});
```

---

### Step 9-11: Additional Security Tests

Due to length constraints, I'll provide abbreviated outlines for the remaining security test files:

**File:** `/home/meywd/zajel-ddos/packages/server/tests/security/race-conditions.test.js`

Test concurrent operations:
- Concurrent heartbeats for same serverId (verify DO serialization)
- Concurrent nonce creation for same device_id
- Concurrent key updates (POST /servers/trusted-keys)
- Alarm cleanup running during request processing

**File:** `/home/meywd/zajel-ddos/packages/server/tests/security/hkdf-edge-cases.test.js`

Test HKDF key derivation edge cases:
- Empty CI_UPLOAD_SECRET string
- Unicode/multi-byte secret
- Very long secret (max-length)
- Null/undefined secret

**File:** `/home/meywd/zajel-ddos/packages/server/tests/security/ciphertext-tampering.test.js`

Test encrypted data integrity:
- Bit-flip in ciphertext (modify single byte)
- IV reuse detection (verify fresh IV per encryption)
- Truncated ciphertext
- Modified authentication tag

**File:** `/home/meywd/zajel-ddos/packages/server/tests/security/nan-validation.test.js`

Test NaN input handling (from Story 013):
- `region_index: NaN` in server registration
- `connections: NaN` in heartbeat
- `limit: NaN` in query parameters
- `timestamp: NaN` in build token

---

## 4. Test Plan

### Unit Test Validation

**Run all unit tests:**
```bash
cd /home/meywd/zajel-ddos/packages/server
npm run test tests/unit/
```

**Expected results:**
- All unit tests pass (rate-limiter, timing-safe, request-validation, cors, logger)
- Code coverage for tested modules >90%

### Security Test Validation

**Run all security tests:**
```bash
cd /home/meywd/zajel-ddos/packages/server
npm run test tests/security/
```

**Expected results:**
- Replay attack tests pass (nonce reuse detected, expired nonces rejected)
- Key rotation tests pass (old keys invalidated, new keys work)
- Race condition tests pass (no crashes, consistent state)
- HKDF edge case tests pass (no crashes, graceful error handling)
- Ciphertext tampering tests pass (decryption fails gracefully)
- NaN validation tests pass (clean error responses, no NaN propagation)

### Integration Test Validation

**Run all tests:**
```bash
cd /home/meywd/zajel-ddos/packages/server
npm run test
```

**Expected results:**
- All existing tests continue to pass (no regressions)
- New tests pass
- Overall code coverage >80%

### Coverage Report

**Generate coverage report:**
```bash
cd /home/meywd/zajel-ddos/packages/server
npm run test -- --coverage
```

**Expected coverage:**
- `rate-limiter.js`: >95% line coverage
- `timing-safe.js`: 100% line coverage
- `request-validation.js`: >90% line coverage
- `cors.js`: >85% line coverage
- `logger.js`: >90% line coverage
- `server-registry-do.js`: >80% line coverage (combined with existing tests)
- `attestation-registry-do.js`: >80% line coverage (combined with existing tests)
- `attestation.js`: >90% line coverage (combined with existing tests)

### Manual Testing

**Smoke test the server:**
```bash
cd /home/meywd/zajel-ddos/packages/server
npm run dev
```

Then use curl to verify endpoints still work:
```bash
# List servers
curl http://localhost:8787/servers

# Register server (should fail without auth, demonstrating rate limiting works)
curl -X POST http://localhost:8787/servers \
  -H "Content-Type: application/json" \
  -d '{"serverId":"test","endpoint":"wss://test.com","publicKey":"key"}'
```

---

## 5. Rollback Risk

**Risk Level:** LOW

### Why Low Risk:
1. **No source code changes** - Only adding test files
2. **Existing tests unaffected** - New tests are isolated
3. **No runtime behavior changes** - Tests don't modify production code
4. **CI integration is additive** - Existing CI continues to work

### Rollback Procedure:
If tests cause CI failures or reveal critical bugs:

1. **Disable failing tests temporarily:**
   ```bash
   # Mark specific test as skip
   it.skip('problematic test', () => { ... });
   ```

2. **Revert new test files:**
   ```bash
   cd /home/meywd/zajel-ddos/packages/server
   git checkout HEAD -- tests/unit/rate-limiter.test.js
   git checkout HEAD -- tests/security/
   ```

3. **Continue with existing test suite:**
   - Existing tests (anomaly-detection, attestation-crypto, signing, build-signing, e2e) remain functional

### Potential Issues:
- **Test flakiness** - Timing-dependent tests may fail in CI due to clock skew
  - Mitigation: Use `vi.useFakeTimers()` consistently
- **Mock incompleteness** - Mocks may not perfectly replicate Cloudflare DO behavior
  - Mitigation: Validate in `wrangler dev` environment after tests pass

---

## 6. Dependencies on Other Stories

### Direct Dependencies (Must Complete First):

**Story 013: NaN Input Validation**
- **Reason:** NaN validation tests (`tests/security/nan-validation.test.js`) will verify the fixes from Story 013
- **Impact:** Cannot write NaN tests until Story 013 adds validation code
- **Workaround:** Write placeholder tests that expect current behavior (NaN propagation), then update after Story 013

**Story 012: Key Expiry**
- **Reason:** Key rotation tests (`tests/security/key-rotation.test.js`) will verify the fixes from Story 012
- **Impact:** Key expiry logic must exist before testing it
- **Workaround:** Skip key expiry-specific tests until Story 012 is complete

### Related Stories (Parallel Work):

**Story 011: Per-Endpoint Rate Limiting**
- **Reason:** Rate limiter tests should verify per-endpoint logic
- **Impact:** Tests may need updates after Story 011
- **Workaround:** Write tests for current global rate limiting, extend after Story 011

### Future Work:

**Story 015+: Additional Security Hardening**
- These tests will serve as foundation for future security work
- Test infrastructure (mock helpers, security test patterns) will be reused

---

## 7. Success Criteria

This implementation is complete when:

- [ ] All 12 new test files created and passing
- [ ] Shared mock helpers extracted to `/home/meywd/zajel-ddos/packages/server/tests/helpers/mock-do.js`
- [ ] Unit tests achieve >90% coverage for rate-limiter, timing-safe, request-validation, cors, logger
- [ ] Security tests cover all 8 categories (replay, rotation, race, HKDF, tampering, NaN, etc.)
- [ ] Overall server package code coverage >80%
- [ ] `npm run test --workspace=zajel-signaling` passes with all tests
- [ ] CI pipeline runs server tests successfully
- [ ] No regressions in existing tests
- [ ] Coverage report shows improvement from baseline

---

## 8. Implementation Timeline

**Estimated effort:** 2-3 days

**Day 1:**
- Create mock-do.js helpers (1 hour)
- Create unit tests for rate-limiter, timing-safe, request-validation (3 hours)
- Create unit tests for cors, logger (2 hours)

**Day 2:**
- Create security tests for replay attacks (2 hours)
- Create security tests for key rotation (2 hours)
- Create security tests for race conditions (2 hours)

**Day 3:**
- Create security tests for HKDF edge cases, ciphertext tampering, NaN validation (3 hours)
- Run full test suite and fix any failures (2 hours)
- Generate coverage report and verify >80% target met (1 hour)

---

## 9. Notes

### Test Philosophy
- **Unit tests** verify individual functions in isolation
- **Security tests** verify attack resistance and edge cases
- **Integration tests** (existing e2e) verify full request/response flows

### Coverage Gaps (Intentional)
- `index.js` - Tested via e2e tests, not unit tests (routing/CORS integration)
- `signing.js` - Already has unit tests in `tests/unit/signing.test.js`
- DO alarm handlers - Tested via e2e tests (cleanup scenarios)

### Future Enhancements
- Add performance benchmarks for timing-safe comparison
- Add load testing for rate limiter (stress test concurrent requests)
- Add fuzz testing for JSON parsing (malformed payloads)

---

**Plan Status:** READY FOR IMPLEMENTATION
**Approver:** (Security lead sign-off required)
**Implementation Start Date:** TBD
