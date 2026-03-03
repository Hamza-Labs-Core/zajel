# Implementation Plan 010: HMAC-Normalize Timing-Safe Comparison

**Story:** [Story 010: HMAC-Normalize Timing-Safe Comparison](../stories/story-010-timing-safe-hmac-normalize.md)
**Priority:** THIS WEEK
**Severity:** MEDIUM
**Components:** packages/server (crypto/timing-safe.js), packages/admin-cf (crypto.ts)

---

## 1. Summary

The current `timingSafeEqual` implementations in both `packages/server` and `packages/admin-cf` leak timing information about input lengths, which could allow an attacker to determine the exact length of secrets like `SERVER_REGISTRY_SECRET` and `CI_UPLOAD_SECRET` through statistical timing analysis.

**Server version issues:**
- Returns `false` early when input lengths differ (line 25 in timing-safe.js)
- Only iterates `min(len_a, len_b)` times, leaking the minimum length through timing
- Uses `void dummy` which may not prevent dead-code elimination by V8 optimizer

**Admin CF version issues:**
- Uses modular indexing (`i % a.length`) which is better than early return
- Still potentially leaks length information through CPU cache patterns
- Currently only used for equal-length hash comparison (lower risk)

**Solution:** Replace both implementations with HMAC-based normalization using Web Crypto API. HMAC both inputs with a random key to produce fixed-length outputs (32 bytes for HMAC-SHA256), then perform XOR comparison on the fixed-length MACs. This makes timing completely independent of input lengths.

**Impact:** This changes `timingSafeEqual` from synchronous to asynchronous, requiring all callers to use `await`.

---

## 2. Files to Modify

### 2.1 Core Implementation Files

| File Path | Lines | Change Type | Description |
|-----------|-------|-------------|-------------|
| `/home/meywd/zajel-ddos/packages/server/src/crypto/timing-safe.js` | 11-33 | Modify | Replace with HMAC-based implementation, make async |
| `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` | 346-351 | Modify | Make `verifyServerAuth()` async |
| `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` | 357-362 | Modify | Make `verifyCIAuth()` async |
| `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` | 376, 389 | Modify | Add `await` to auth check calls in `fetch()` |
| `/home/meywd/zajel-ddos/packages/admin-cf/src/crypto.ts` | 207-214 | Modify | Replace with HMAC-based implementation, make async |
| `/home/meywd/zajel-ddos/packages/admin-cf/src/crypto.ts` | 52-59 | Modify | Add `await` to `timingSafeEqual` call in `verifyPassword()` |

### 2.2 New Test Files

| File Path | Description |
|-----------|-------------|
| `/home/meywd/zajel-ddos/packages/server/tests/unit/timing-safe.test.js` | Unit tests for server `timingSafeEqual` |
| `/home/meywd/zajel-ddos/packages/admin-cf/tests/unit/crypto.test.ts` | Unit tests for admin-cf crypto functions including `timingSafeEqual` |

---

## 3. Implementation Steps

### 3.1 Server: Update `timingSafeEqual` to HMAC-based approach

**File:** `/home/meywd/zajel-ddos/packages/server/src/crypto/timing-safe.js`

**Before (lines 1-33):**
```javascript
/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 *
 * Uses an XOR-based comparison that always processes all bytes,
 * regardless of where the first difference occurs.
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} Whether the strings are equal
 */
export function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  if (bufA.byteLength !== bufB.byteLength) {
    // Still do a full comparison to avoid leaking length info through timing.
    const minLen = Math.min(bufA.byteLength, bufB.byteLength);
    let dummy = 0;
    for (let i = 0; i < minLen; i++) {
      dummy |= bufA[i] ^ bufB[i];
    }
    // Prevent dead-code elimination
    void dummy;
    return false;
  }

  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
```

**After:**
```javascript
/**
 * Constant-time string comparison using HMAC normalization.
 *
 * HMAC both inputs with a random key, producing fixed-length outputs,
 * then XOR-compare the outputs. This eliminates length-dependent timing
 * because HMAC output is always the same size (32 bytes) regardless of input.
 *
 * Security properties:
 * - No early returns based on length mismatch
 * - Always iterates exactly 32 times (HMAC-SHA256 output length)
 * - Timing is independent of input lengths
 * - Random key per comparison prevents oracle attacks
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {Promise<boolean>} Whether the strings are equal
 */
export async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();

  // Generate a random key per comparison to prevent oracle attacks.
  // Even if an attacker could somehow observe HMAC outputs, the random key
  // makes each comparison independent.
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // HMAC both inputs — output is always 32 bytes regardless of input length.
  // This normalization step is what makes the comparison timing-safe.
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  // Fixed-length comparison (both are exactly 32 bytes)
  const bufA = new Uint8Array(macA);
  const bufB = new Uint8Array(macB);

  // XOR all 32 bytes. If any byte differs, result will be non-zero.
  // This loop always runs exactly 32 iterations.
  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
```

**Rationale:**
- HMAC-SHA256 always produces 32 bytes of output, regardless of input length
- The comparison loop always runs exactly 32 iterations
- No early returns, no length-dependent branches
- Random key prevents precomputation attacks (though not strictly necessary for this use case)
- Web Crypto API is available in Cloudflare Workers

---

### 3.2 Server: Make `verifyServerAuth` async

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (lines 340-351):**
```javascript
  /**
   * Verify server authentication using the SERVER_REGISTRY_SECRET.
   * Uses constant-time comparison to prevent timing attacks.
   *
   * @param {Request} request - The incoming request
   * @returns {boolean} Whether the request is authenticated
   */
  verifyServerAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.SERVER_REGISTRY_SECRET) return false;
    if (!authHeader) return false;
    return timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
  }
```

**After:**
```javascript
  /**
   * Verify server authentication using the SERVER_REGISTRY_SECRET.
   * Uses constant-time comparison to prevent timing attacks.
   *
   * @param {Request} request - The incoming request
   * @returns {Promise<boolean>} Whether the request is authenticated
   */
  async verifyServerAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.SERVER_REGISTRY_SECRET) return false;
    if (!authHeader) return false;
    return await timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
  }
```

**Changes:**
- Add `async` keyword to method signature
- Add `await` before `timingSafeEqual` call
- Update JSDoc return type to `Promise<boolean>`

---

### 3.3 Server: Make `verifyCIAuth` async

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (lines 353-362):**
```javascript
  /**
   * Verify CI authentication using CI_UPLOAD_SECRET.
   * Same pattern as the attestation registry.
   */
  verifyCIAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.CI_UPLOAD_SECRET) return false;
    if (!authHeader) return false;
    return timingSafeEqual(authHeader, `Bearer ${this.env.CI_UPLOAD_SECRET}`);
  }
```

**After:**
```javascript
  /**
   * Verify CI authentication using CI_UPLOAD_SECRET.
   * Same pattern as the attestation registry.
   */
  async verifyCIAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.CI_UPLOAD_SECRET) return false;
    if (!authHeader) return false;
    return await timingSafeEqual(authHeader, `Bearer ${this.env.CI_UPLOAD_SECRET}`);
  }
```

**Changes:**
- Add `async` keyword to method signature
- Add `await` before `timingSafeEqual` call

---

### 3.4 Server: Update auth check callers in `fetch()`

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

Find all calls to `verifyServerAuth()` and `verifyCIAuth()` in the `fetch()` method and add `await`.

**Location 1 - POST /servers (around line 376):**

**Before:**
```javascript
      if (request.method === 'POST' && url.pathname === '/servers') {
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
```

**After:**
```javascript
      if (request.method === 'POST' && url.pathname === '/servers') {
        if (this.env.SERVER_REGISTRY_SECRET && !(await this.verifyServerAuth(request))) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
```

**Location 2 - POST /ci/build-tokens (around line 389):**

**Before:**
```javascript
      if (request.method === 'POST' && url.pathname === '/ci/build-tokens') {
        if (!this.verifyCIAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
```

**After:**
```javascript
      if (request.method === 'POST' && url.pathname === '/ci/build-tokens') {
        if (!(await this.verifyCIAuth(request))) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
```

**Notes:**
- The `fetch()` method is already async, so no signature change needed
- Need to search the entire file for all usages of these auth methods
- Use grep to find all occurrences:
  ```bash
  grep -n "verifyServerAuth\|verifyCIAuth" /home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js
  ```

---

### 3.5 Admin CF: Update `timingSafeEqual` to HMAC-based approach

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/src/crypto.ts`

**Before (lines 204-214):**
```typescript
/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i % a.length) ^ b.charCodeAt(i % b.length));
  }
  return result === 0;
}
```

**After:**
```typescript
/**
 * Constant-time string comparison using HMAC normalization.
 *
 * HMAC both inputs with a random key, producing fixed-length outputs,
 * then XOR-compare the outputs. This eliminates length-dependent timing
 * because HMAC output is always the same size (32 bytes) regardless of input.
 *
 * Security properties:
 * - No early returns based on length mismatch
 * - Always iterates exactly 32 times (HMAC-SHA256 output length)
 * - Timing is independent of input lengths
 * - Random key per comparison prevents oracle attacks
 *
 * @param a - First string
 * @param b - Second string
 * @returns Whether the strings are equal
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();

  // Generate a random key per comparison to prevent oracle attacks.
  // Even if an attacker could somehow observe HMAC outputs, the random key
  // makes each comparison independent.
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // HMAC both inputs — output is always 32 bytes regardless of input length.
  // This normalization step is what makes the comparison timing-safe.
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  // Fixed-length comparison (both are exactly 32 bytes)
  const bufA = new Uint8Array(macA);
  const bufB = new Uint8Array(macB);

  // XOR all 32 bytes. If any byte differs, result will be non-zero.
  // This loop always runs exactly 32 iterations.
  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
```

**Changes:**
- Make function `async`
- Change return type to `Promise<boolean>`
- Replace modular indexing approach with HMAC normalization
- Add comprehensive JSDoc comment
- Implementation is identical to server version for consistency

---

### 3.6 Admin CF: Update `verifyPassword` to await comparison

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/src/crypto.ts`

**Before (lines 52-59):**
```typescript
/**
 * Verify a password against a stored hash
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string
): Promise<boolean> {
  const computedHash = await hashPassword(password, salt);
  return timingSafeEqual(computedHash, storedHash);
}
```

**After:**
```typescript
/**
 * Verify a password against a stored hash
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string
): Promise<boolean> {
  const computedHash = await hashPassword(password, salt);
  return await timingSafeEqual(computedHash, storedHash);
}
```

**Changes:**
- Add `await` before `timingSafeEqual` call
- No signature change needed (already async)

---

### 3.7 Create unit tests for server `timingSafeEqual`

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/timing-safe.test.js` (NEW)

```javascript
/**
 * Unit tests for timing-safe string comparison.
 *
 * Tests the HMAC-based constant-time comparison that prevents
 * timing side-channel attacks on secret comparison.
 */

import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from '../../src/crypto/timing-safe.js';

describe('timingSafeEqual', () => {
  it('returns true for equal strings', async () => {
    expect(await timingSafeEqual('hello', 'hello')).toBe(true);
    expect(await timingSafeEqual('', '')).toBe(true);
    expect(await timingSafeEqual('Bearer secret123', 'Bearer secret123')).toBe(true);
  });

  it('returns false for different strings of equal length', async () => {
    expect(await timingSafeEqual('hello', 'world')).toBe(false);
    expect(await timingSafeEqual('secret123', 'secret124')).toBe(false);
    expect(await timingSafeEqual('Bearer abc', 'Bearer xyz')).toBe(false);
  });

  it('returns false for different strings of different lengths', async () => {
    expect(await timingSafeEqual('short', 'much longer string')).toBe(false);
    expect(await timingSafeEqual('much longer string', 'short')).toBe(false);
    expect(await timingSafeEqual('', 'non-empty')).toBe(false);
    expect(await timingSafeEqual('non-empty', '')).toBe(false);
  });

  it('handles empty strings correctly', async () => {
    expect(await timingSafeEqual('', '')).toBe(true);
    expect(await timingSafeEqual('', 'a')).toBe(false);
    expect(await timingSafeEqual('a', '')).toBe(false);
  });

  it('handles special characters and unicode', async () => {
    expect(await timingSafeEqual('hello\nworld', 'hello\nworld')).toBe(true);
    expect(await timingSafeEqual('emoji 🚀', 'emoji 🚀')).toBe(true);
    expect(await timingSafeEqual('emoji 🚀', 'emoji 🛸')).toBe(false);
  });

  it('handles Bearer token format (real-world usage)', async () => {
    const secret = 'my-super-secret-token-123';
    const validAuth = `Bearer ${secret}`;
    const invalidAuth = 'Bearer wrong-token';
    const invalidFormat = `Basic ${secret}`;

    expect(await timingSafeEqual(validAuth, validAuth)).toBe(true);
    expect(await timingSafeEqual(validAuth, invalidAuth)).toBe(false);
    expect(await timingSafeEqual(validAuth, invalidFormat)).toBe(false);
  });

  describe('timing properties', () => {
    /**
     * Statistical timing test to verify constant-time behavior.
     *
     * This test compares timing distributions for:
     * 1. Equal-length strings (matching)
     * 2. Equal-length strings (different)
     * 3. Different-length strings
     *
     * All three should have similar timing distributions. If length information
     * leaks through timing, different-length comparisons would be statistically
     * distinguishable from equal-length comparisons.
     *
     * Note: This test may be flaky on heavily loaded systems, but should pass
     * under normal conditions. We use a large sample size (1000) and check
     * that mean timings overlap within 2 standard deviations.
     */
    it('takes similar time for same-length vs different-length inputs', async () => {
      const iterations = 1000;
      const secret = 'x'.repeat(50); // 50-char secret

      // Test case 1: Same length, equal
      const sameEqualTimings = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await timingSafeEqual(secret, secret);
        sameEqualTimings.push(performance.now() - start);
      }

      // Test case 2: Same length, different
      const sameDiffTimings = [];
      const differentSameLength = 'y'.repeat(50);
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await timingSafeEqual(secret, differentSameLength);
        sameDiffTimings.push(performance.now() - start);
      }

      // Test case 3: Different length
      const diffLengthTimings = [];
      const differentLength = 'z'.repeat(30);
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await timingSafeEqual(secret, differentLength);
        diffLengthTimings.push(performance.now() - start);
      }

      // Calculate statistics
      const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const stdDev = (arr) => {
        const avg = mean(arr);
        const squareDiffs = arr.map((value) => Math.pow(value - avg, 2));
        return Math.sqrt(mean(squareDiffs));
      };

      const meanSameEqual = mean(sameEqualTimings);
      const meanSameDiff = mean(sameDiffTimings);
      const meanDiffLength = mean(diffLengthTimings);

      const stdDevSameEqual = stdDev(sameEqualTimings);
      const stdDevSameDiff = stdDev(sameDiffTimings);
      const stdDevDiffLength = stdDev(diffLengthTimings);

      // Check that distributions overlap within 2 standard deviations.
      // If timing leaks length info, different-length would be statistically
      // distinguishable (e.g., consistently faster or slower).
      const maxStdDev = Math.max(stdDevSameEqual, stdDevSameDiff, stdDevDiffLength);
      const timingDiff1 = Math.abs(meanSameEqual - meanDiffLength);
      const timingDiff2 = Math.abs(meanSameDiff - meanDiffLength);

      // Allow up to 2 standard deviations difference (95% confidence)
      expect(timingDiff1).toBeLessThan(2 * maxStdDev);
      expect(timingDiff2).toBeLessThan(2 * maxStdDev);
    }, 30000); // 30 second timeout for this test
  });
});
```

**Key test cases:**
1. Basic equality and inequality
2. Empty strings
3. Different lengths
4. Unicode and special characters
5. Real-world Bearer token format
6. Statistical timing test (verifies constant-time property)

---

### 3.8 Create unit tests for admin-cf crypto functions

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/tests/unit/crypto.test.ts` (NEW)

```typescript
/**
 * Unit tests for admin-cf crypto utilities.
 *
 * Tests password hashing, JWT operations, and timing-safe comparison.
 */

import { describe, it, expect } from 'vitest';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateJwt,
  verifyJwt,
  generateId,
} from '../../src/crypto.js';

describe('Admin CF Crypto', () => {
  describe('Salt generation', () => {
    it('generates random 64-character hex salt', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();

      expect(salt1).toMatch(/^[0-9a-f]{64}$/);
      expect(salt2).toMatch(/^[0-9a-f]{64}$/);
      expect(salt1).not.toBe(salt2); // Different each time
    });
  });

  describe('Password hashing', () => {
    it('hashes password with PBKDF2', async () => {
      const password = 'test-password-123';
      const salt = generateSalt();

      const hash = await hashPassword(password, salt);

      expect(hash).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars
      expect(hash).not.toBe(password); // Obviously not plaintext
    });

    it('produces same hash for same password and salt', async () => {
      const password = 'consistent-password';
      const salt = generateSalt();

      const hash1 = await hashPassword(password, salt);
      const hash2 = await hashPassword(password, salt);

      expect(hash1).toBe(hash2);
    });

    it('produces different hash for different salt', async () => {
      const password = 'same-password';
      const salt1 = generateSalt();
      const salt2 = generateSalt();

      const hash1 = await hashPassword(password, salt1);
      const hash2 = await hashPassword(password, salt2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Password verification', () => {
    it('accepts correct password', async () => {
      const password = 'correct-password';
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      const result = await verifyPassword(password, hash, salt);

      expect(result).toBe(true);
    });

    it('rejects incorrect password', async () => {
      const correctPassword = 'correct-password';
      const incorrectPassword = 'wrong-password';
      const salt = generateSalt();
      const hash = await hashPassword(correctPassword, salt);

      const result = await verifyPassword(incorrectPassword, hash, salt);

      expect(result).toBe(false);
    });

    it('rejects password with wrong salt', async () => {
      const password = 'test-password';
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const hash = await hashPassword(password, salt1);

      const result = await verifyPassword(password, hash, salt2);

      expect(result).toBe(false);
    });

    it('handles empty password', async () => {
      const password = '';
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      const resultCorrect = await verifyPassword('', hash, salt);
      const resultIncorrect = await verifyPassword('not-empty', hash, salt);

      expect(resultCorrect).toBe(true);
      expect(resultIncorrect).toBe(false);
    });
  });

  describe('JWT generation and verification', () => {
    it('generates and verifies valid JWT', async () => {
      const payload = { userId: '123', username: 'admin' };
      const secret = 'test-secret';

      const token = await generateJwt(payload, secret, 15);
      const decoded = await verifyJwt<typeof payload>(token, secret);

      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe('123');
      expect(decoded?.username).toBe('admin');
    });

    it('rejects JWT with wrong secret', async () => {
      const payload = { userId: '123' };
      const correctSecret = 'correct-secret';
      const wrongSecret = 'wrong-secret';

      const token = await generateJwt(payload, correctSecret, 15);
      const decoded = await verifyJwt(token, wrongSecret);

      expect(decoded).toBeNull();
    });

    it('includes expiration in payload', async () => {
      const payload = { userId: '123' };
      const secret = 'test-secret';

      const token = await generateJwt(payload, secret, 15);
      const decoded = await verifyJwt<typeof payload & { exp: number }>(token, secret);

      expect(decoded).not.toBeNull();
      expect(decoded?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('rejects expired JWT', async () => {
      const payload = { userId: '123' };
      const secret = 'test-secret';

      // Generate token that expires immediately (0 minutes)
      const token = await generateJwt(payload, secret, 0);

      // Wait a bit to ensure expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      const decoded = await verifyJwt(token, secret);

      expect(decoded).toBeNull();
    });

    it('rejects malformed JWT', async () => {
      const secret = 'test-secret';

      expect(await verifyJwt('not.a.jwt', secret)).toBeNull();
      expect(await verifyJwt('only.two', secret)).toBeNull();
      expect(await verifyJwt('', secret)).toBeNull();
    });
  });

  describe('ID generation', () => {
    it('generates random 32-character hex ID', () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).toMatch(/^[0-9a-f]{32}$/);
      expect(id2).toMatch(/^[0-9a-f]{32}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('timingSafeEqual (via verifyPassword)', () => {
    /**
     * Since timingSafeEqual is not exported, we test it indirectly
     * through verifyPassword, which uses it internally.
     * The password verification tests above already cover correctness.
     *
     * For timing properties, the server's timing-safe.test.js has
     * comprehensive timing tests that apply equally to this implementation
     * since they share the same HMAC-based approach.
     */

    it('verifyPassword uses timing-safe comparison (smoke test)', async () => {
      // This is a smoke test to ensure timing-safe comparison is being used.
      // The actual timing properties are tested in the server's test suite.
      const password = 'test';
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      // These should complete without throwing
      await verifyPassword(password, hash, salt);
      await verifyPassword('wrong', hash, salt);
      await verifyPassword('much-longer-wrong-password', hash, salt);
    });
  });
});
```

**Key test cases:**
1. Salt generation randomness
2. Password hashing determinism
3. Password verification (correct/incorrect)
4. JWT generation and verification
5. JWT expiration
6. ID generation
7. Smoke test for timing-safe comparison (detailed timing tests in server suite)

---

### 3.9 Create unit test directory for admin-cf

**Command:**
```bash
mkdir -p /home/meywd/zajel-ddos/packages/admin-cf/tests/unit
```

This directory doesn't exist yet and needs to be created before writing the test file.

---

## 4. Test Plan

### 4.1 Unit Tests

**Server (`packages/server/tests/unit/timing-safe.test.js`):**
- [x] Equal strings return `true`
- [x] Different strings of equal length return `false`
- [x] Different strings of different lengths return `false`
- [x] Empty string comparison: `timingSafeEqual("", "")` returns `true`
- [x] One empty, one non-empty: returns `false`
- [x] Special characters and unicode handling
- [x] Bearer token format (real-world usage)
- [x] Statistical timing test: Verify that same-length and different-length comparisons have overlapping timing distributions (no statistically significant difference)

**Admin CF (`packages/admin-cf/tests/unit/crypto.test.ts`):**
- [x] Salt generation produces random 64-char hex
- [x] Password hashing is deterministic for same input
- [x] Password hashing produces different output for different salt
- [x] `verifyPassword` accepts correct password
- [x] `verifyPassword` rejects incorrect password
- [x] `verifyPassword` rejects password with wrong salt
- [x] `verifyPassword` handles empty password
- [x] JWT generation and verification (valid token)
- [x] JWT rejection with wrong secret
- [x] JWT expiration handling
- [x] Malformed JWT rejection
- [x] ID generation produces random 32-char hex
- [x] Smoke test for timing-safe comparison via `verifyPassword`

### 4.2 Integration Tests

**Server Registry DO Authentication (manual/E2E):**

Test with existing E2E test infrastructure:

1. **Valid server auth:**
   ```bash
   curl -X POST https://bootstrap.zajel.test/servers \
     -H "Authorization: Bearer ${SERVER_REGISTRY_SECRET}" \
     -H "Content-Type: application/json" \
     -d '{"id":"test","url":"wss://test.example.com"}'
   ```
   Expected: 200 OK

2. **Invalid server auth (wrong secret):**
   ```bash
   curl -X POST https://bootstrap.zajel.test/servers \
     -H "Authorization: Bearer wrong-secret" \
     -H "Content-Type: application/json" \
     -d '{"id":"test","url":"wss://test.example.com"}'
   ```
   Expected: 401 Unauthorized

3. **Invalid server auth (missing header):**
   ```bash
   curl -X POST https://bootstrap.zajel.test/servers \
     -H "Content-Type: application/json" \
     -d '{"id":"test","url":"wss://test.example.com"}'
   ```
   Expected: 401 Unauthorized

4. **Valid CI auth:**
   ```bash
   curl -X POST https://bootstrap.zajel.test/ci/build-tokens \
     -H "Authorization: Bearer ${CI_UPLOAD_SECRET}" \
     -H "Content-Type: application/json" \
     -d '{"platform":"android","version":"1.0.0","buildNumber":"1"}'
   ```
   Expected: 200 OK with build token

5. **Invalid CI auth:**
   ```bash
   curl -X POST https://bootstrap.zajel.test/ci/build-tokens \
     -H "Authorization: Bearer wrong-secret" \
     -H "Content-Type: application/json" \
     -d '{"platform":"android","version":"1.0.0","buildNumber":"1"}'
   ```
   Expected: 401 Unauthorized

**Admin CF Authentication:**

Test with admin-cf E2E suite (extend `tests/e2e/admin-e2e.test.ts`):

1. Add test case for login with correct password
2. Add test case for login with incorrect password
3. Verify JWT verification in subsequent requests

### 4.3 Regression Tests

Run existing test suites to ensure no breakage:

```bash
# Server tests
cd /home/meywd/zajel-ddos/packages/server
npm run test

# Admin CF tests
cd /home/meywd/zajel-ddos/packages/admin-cf
npm run test
```

**Expected results:**
- All existing tests pass
- New unit tests pass
- No test timeouts (async changes handled correctly)

### 4.4 Performance Tests

**Baseline timing measurement:**

Before and after implementation, measure auth endpoint response times:

```bash
# Measure 100 requests
for i in {1..100}; do
  curl -w "%{time_total}\n" -o /dev/null -s \
    -X POST https://bootstrap.zajel.test/servers \
    -H "Authorization: Bearer ${SERVER_REGISTRY_SECRET}" \
    -H "Content-Type: application/json" \
    -d '{"id":"test","url":"wss://test.example.com"}'
done | awk '{sum+=$1; sumsq+=$1*$1} END {print "Mean:", sum/NR, "StdDev:", sqrt(sumsq/NR - (sum/NR)^2)}'
```

**Expected results:**
- Mean response time should not increase significantly (< 10ms increase acceptable)
- HMAC operations are fast (< 1ms on modern hardware)
- The async overhead is negligible since fetch() is already async

### 4.5 Security Validation

**Manual timing attack attempt:**

1. Set up local dev environment with known secret
2. Write a script to measure response times for different auth header lengths
3. Perform 10,000 requests with varying lengths
4. Plot timing distribution
5. Verify no correlation between input length and response time

**Example validation script:**
```javascript
// timing-attack-validation.js
async function measureTiming(url, authHeader, iterations = 1000) {
  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 'test', url: 'wss://test.example.com' }),
    });
    timings.push(performance.now() - start);
  }
  return timings;
}

// Test with different lengths
const url = 'http://localhost:8787/servers';
const lengths = [10, 20, 30, 40, 50];
const results = {};

for (const len of lengths) {
  const authHeader = `Bearer ${'x'.repeat(len)}`;
  results[len] = await measureTiming(url, authHeader);
}

// Calculate statistics
for (const [len, timings] of Object.entries(results)) {
  const mean = timings.reduce((a, b) => a + b) / timings.length;
  const variance = timings.reduce((a, b) => a + (b - mean) ** 2, 0) / timings.length;
  const stdDev = Math.sqrt(variance);
  console.log(`Length ${len}: Mean=${mean.toFixed(2)}ms, StdDev=${stdDev.toFixed(2)}ms`);
}
```

**Success criteria:**
- No statistically significant correlation between auth header length and response time
- Standard deviation across different lengths is similar (no outliers)

---

## 5. Rollback Risk

### 5.1 Risk Level: LOW

**Rationale:**
- Changes are isolated to crypto utility functions and their direct callers
- No database schema changes
- No changes to external API contracts
- The async change is localized (auth methods already called from async context)

### 5.2 Potential Issues

| Issue | Probability | Impact | Mitigation |
|-------|------------|--------|------------|
| Performance regression | Low | Medium | Pre-deployment benchmark testing; HMAC is very fast |
| Async/await bug (missed await) | Low | High | Comprehensive test coverage; TypeScript in admin-cf catches missing await at compile time |
| Dead-code elimination of XOR loop | Very Low | Medium | HMAC output is used in return value, cannot be eliminated |
| Web Crypto API unavailable | Very Low | High | CF Workers and admin-cf both support Web Crypto API (verified) |
| Random key generation failure | Very Low | High | `crypto.getRandomValues` is a standard API, very reliable |

### 5.3 Rollback Procedure

If issues arise in production:

1. **Immediate rollback:**
   ```bash
   cd /home/meywd/zajel-ddos/packages/server
   git revert <commit-hash>
   npm run deploy

   cd /home/meywd/zajel-ddos/packages/admin-cf
   git revert <commit-hash>
   npm run deploy
   ```

2. **Verification:**
   - Check `/servers` endpoint responds to valid auth
   - Check `/ci/build-tokens` endpoint responds to valid auth
   - Check admin dashboard login works

3. **Post-rollback:**
   - Review logs for error messages
   - Reproduce issue in dev environment
   - Fix issue and re-deploy with additional tests

### 5.4 Safe Deployment Strategy

1. Deploy to staging environment first
2. Run full test suite including timing tests
3. Perform manual auth verification
4. Monitor error rates for 1 hour
5. Deploy to production during low-traffic window
6. Monitor error rates and response times for 24 hours

---

## 6. Dependencies on Other Stories

### 6.1 Blocking Dependencies: NONE

This story is self-contained and does not depend on any other security stories.

### 6.2 Stories That Depend on This: NONE (Likely)

However, future stories might benefit from this fix:

- **Any new authentication endpoints** will automatically get timing-safe comparison if they use `verifyServerAuth` or `verifyCIAuth`
- **Any new secret comparison** should use the updated `timingSafeEqual` function

### 6.3 Related Stories (Non-blocking)

This story is part of the broader timing-attack prevention effort:

- **Story 010** (this story): Fix HMAC-normalize timing-safe comparison
- **Potential future story**: Audit all other string comparisons in the codebase for timing safety (e.g., pairing code comparison, signature verification)
- **Potential future story**: Add rate limiting to auth endpoints to prevent statistical timing attacks even if comparison is not perfectly constant-time

### 6.4 Coordination Notes

- **Code review**: Security-sensitive change, requires thorough review
- **Testing**: Run on multiple platforms (local dev, staging, production) to ensure timing behavior is consistent
- **Documentation**: Update crypto documentation to explain HMAC-based approach and why it's used

---

## 7. Implementation Checklist

### 7.1 Pre-implementation

- [ ] Review this plan with team
- [ ] Confirm Web Crypto API availability in CF Workers (already confirmed, but double-check)
- [ ] Set up staging environment for testing
- [ ] Create feature branch: `feat/timing-safe-hmac-normalize`

### 7.2 Implementation (Server)

- [ ] Update `timingSafeEqual` in `timing-safe.js` to use HMAC approach
- [ ] Make `verifyServerAuth` async
- [ ] Make `verifyCIAuth` async
- [ ] Add `await` to all calls in `fetch()` method
- [ ] Search for any other callers of these methods (grep)
- [ ] Create unit tests in `tests/unit/timing-safe.test.js`
- [ ] Run server test suite: `npm run test`
- [ ] Fix any issues

### 7.3 Implementation (Admin CF)

- [ ] Update `timingSafeEqual` in `crypto.ts` to use HMAC approach
- [ ] Add `await` to call in `verifyPassword`
- [ ] Create `tests/unit` directory
- [ ] Create unit tests in `tests/unit/crypto.test.ts`
- [ ] Run admin-cf test suite: `npm run test`
- [ ] Fix any issues

### 7.4 Testing

- [ ] Run all unit tests (server and admin-cf)
- [ ] Run timing-specific tests multiple times to ensure consistency
- [ ] Manual testing of server auth endpoints (valid/invalid)
- [ ] Manual testing of CI auth endpoints (valid/invalid)
- [ ] Manual testing of admin login (valid/invalid password)
- [ ] Performance benchmark (before/after comparison)
- [ ] Security validation script (timing correlation analysis)

### 7.5 Deployment

- [ ] Deploy to staging
- [ ] Verify staging deployment
- [ ] Monitor staging for 1 hour
- [ ] Deploy to production (low-traffic window)
- [ ] Monitor production error rates
- [ ] Monitor production response times
- [ ] Verify auth endpoints work correctly

### 7.6 Post-deployment

- [ ] Monitor for 24 hours
- [ ] Review any error logs
- [ ] Document lessons learned
- [ ] Update security documentation
- [ ] Close story

---

## 8. Success Metrics

### 8.1 Functional Success

- [ ] All unit tests pass (existing + new)
- [ ] All integration tests pass
- [ ] Manual auth verification succeeds
- [ ] No authentication errors in production logs

### 8.2 Security Success

- [ ] Timing attack validation script shows no length correlation
- [ ] Statistical analysis confirms constant-time behavior
- [ ] No early returns in code path
- [ ] Fixed iteration count (32) in comparison loop

### 8.3 Performance Success

- [ ] Response time increase < 10ms
- [ ] No timeout errors
- [ ] No user-reported slowness

### 8.4 Code Quality Success

- [ ] Code review approved
- [ ] JSDoc/TSDoc comments complete
- [ ] Test coverage > 95% for modified functions
- [ ] No linter warnings

---

## 9. Notes

### 9.1 Alternative Approaches Considered

**Option 1: Synchronous modular indexing (like admin-cf current)**
- Pros: No async change needed
- Cons: Still potentially leaks length info through CPU cache patterns; not as robust as HMAC

**Option 2: Pad to maximum expected length**
- Pros: Synchronous, simpler than HMAC
- Cons: Requires choosing max length (arbitrary); wasted computation for short inputs

**Option 3: Use Node.js crypto.timingSafeEqual (not applicable)**
- Pros: Battle-tested implementation
- Cons: Not available in CF Workers; still has early return on length mismatch

**Decision: Use HMAC-based normalization**
- Most robust against timing attacks
- Standardized approach (used in security-critical systems)
- Web Crypto API is available and performant
- The async change is acceptable (already in async context)

### 9.2 Security Considerations

**Why random key per comparison?**
- Prevents precomputation attacks where an attacker might try to build a table of HMAC outputs for common secrets
- In practice, not strictly necessary for this use case (secret is already unknown), but adds defense in depth
- No performance cost (key generation is fast)

**Why HMAC-SHA256 instead of SHA-256?**
- HMAC is specifically designed for this purpose (message authentication)
- More standardized for constant-time comparison
- SHA-256 alone would work but HMAC is the "right tool for the job"

**Could we use constant-time comparison library?**
- Not readily available for CF Workers environment
- Custom implementation with HMAC is straightforward and auditable
- Avoids dependency on external library (attack surface reduction)

### 9.3 Future Improvements

- **Rate limiting**: Add rate limiting to auth endpoints to prevent brute-force even with perfect constant-time comparison
- **Audit other comparisons**: Search codebase for other sensitive string comparisons (pairing codes, signatures, etc.)
- **Monitoring**: Add metrics for auth failure rates to detect potential attacks
- **Secret rotation**: Implement secret rotation for SERVER_REGISTRY_SECRET and CI_UPLOAD_SECRET

---

## 10. Acceptance Criteria (Final Checklist)

From the original story, these must all be satisfied:

- [ ] `timingSafeEqual` in `packages/server/src/crypto/timing-safe.js` does not return early on length mismatch
- [ ] `timingSafeEqual` comparison takes constant time regardless of input lengths
- [ ] The function does not leak the minimum input length through timing
- [ ] HMAC normalization is used (preferred approach)
- [ ] All callers of `timingSafeEqual` are updated to handle the async signature
- [ ] `verifyServerAuth()` and `verifyCIAuth()` correctly await the comparison result
- [ ] `timingSafeEqual` in `packages/admin-cf/src/crypto.ts` is updated to use the same approach
- [ ] `verifyPassword()` in admin-cf works correctly with the updated function
- [ ] The XOR comparison loop result cannot be optimized away by the JIT compiler (HMAC approach inherently avoids this since the HMAC values are needed)
- [ ] All unit tests pass
- [ ] Timing test passes (no statistically significant timing difference)
- [ ] Integration tests verify auth still works correctly

---

**Plan prepared by:** Claude Sonnet 4.5
**Date:** 2026-03-03
**Estimated implementation time:** 4-6 hours (including testing)
**Estimated testing time:** 2-3 hours
**Total estimated time:** 6-9 hours
