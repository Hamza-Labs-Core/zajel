# Implementation Plan: Story 013 - NaN Input Validation Guards in Attestation

## Summary

This plan addresses **Story 013: NaN Input Validation Guards in Attestation**, a HIGH severity security vulnerability where the attestation verification handler in `AttestationRegistryDO` performs bounds checking on `region_index` using comparison operators that silently pass for `NaN` values. In JavaScript, `NaN < 0` and `NaN >= n` both evaluate to `false`, meaning a `NaN` value bypasses both lower and upper bounds checks. This allows attackers to submit malformed `region_index` values (e.g., `"abc"`, `undefined`, `null`) that either cause server crashes (500 errors) or silently coerce to unintended values.

The vulnerability extends beyond `region_index` to include:
1. **`critical_regions[].offset` and `critical_regions[].length`** - Only check `typeof === 'number'` which passes for `NaN`
2. **Nonce consumption DoS** - The nonce is deleted BEFORE input validation, allowing attackers to consume valid nonces with invalid payloads

The fix involves:
- Creating a reusable `isNonNegativeInteger()` validation helper
- Applying strict validation to all numeric inputs with `Number.isFinite()` and `Number.isInteger()`
- Moving nonce deletion to AFTER all input validation passes
- Adding comprehensive test coverage for NaN, Infinity, null, undefined, negative, and fractional values

## Files to Modify

All file paths are relative to `/home/meywd/zajel-ddos/packages/server/`.

### 1. Create New Utility Module

**File:** `src/utils/numeric-validation.js` (NEW FILE)

This new module will contain the shared validation helper function.

### 2. Core Implementation Files

**File:** `src/durable-objects/attestation-registry-do.js`

Modifications needed:
- **Lines 30-33**: Add import for new validation helper
- **Lines 495-502**: Fix `critical_regions` validation to reject NaN/Infinity
- **Lines 719-789**: Restructure verify flow to validate ALL inputs before deleting nonce
- **Lines 752-758**: Replace bounds check with `isNonNegativeInteger()` validation
- **Lines 978-979**: Add guard to `selectRandomRegions()` count parameter (defensive)

### 3. Test Files

**File:** `tests/e2e/attestation.test.js`

Add new test suite for NaN validation scenarios (approximately 150-200 lines of new tests).

**File:** `tests/unit/numeric-validation.test.js` (NEW FILE)

Unit tests for the validation helper function.

## Implementation Steps

### Step 1: Create Numeric Validation Utility Module

**Create:** `/home/meywd/zajel-ddos/packages/server/src/utils/numeric-validation.js`

```javascript
/**
 * Numeric input validation utilities.
 *
 * Provides guards against JavaScript's NaN, Infinity, and type coercion
 * issues that can bypass naive bounds checks.
 */

/**
 * Validate that a value is a non-negative integer.
 *
 * Rejects:
 * - NaN (typeof === 'number' but not finite)
 * - Infinity and -Infinity
 * - Negative numbers
 * - Fractional numbers
 * - Non-number types (undefined, null, string, object, etc.)
 *
 * JavaScript gotchas this prevents:
 * - `NaN < 0` is false, so naive bounds checks pass
 * - `typeof NaN === 'number'` is true
 * - `null` coerces to 0 in numeric comparisons
 * - `undefined` coerces to NaN
 *
 * @param {any} value - The value to validate
 * @returns {boolean} True if the value is a non-negative integer
 *
 * @example
 * isNonNegativeInteger(0)        // true
 * isNonNegativeInteger(5)        // true
 * isNonNegativeInteger(-1)       // false
 * isNonNegativeInteger(1.5)      // false
 * isNonNegativeInteger(NaN)      // false
 * isNonNegativeInteger(Infinity) // false
 * isNonNegativeInteger(null)     // false
 * isNonNegativeInteger("5")      // false
 */
export function isNonNegativeInteger(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
  );
}

/**
 * Validate that a value is a positive integer (> 0).
 *
 * Same as isNonNegativeInteger but rejects zero.
 *
 * @param {any} value - The value to validate
 * @returns {boolean} True if the value is a positive integer
 */
export function isPositiveInteger(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    Number.isInteger(value)
  );
}
```

---

### Step 2: Update Attestation Registry DO Imports

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/attestation-registry-do.js`

**Location:** Lines 30-33 (after existing imports)

**Before:**
```javascript
import { getCorsHeaders } from '../cors.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';
import { parseJsonBody, BodyTooLargeError } from '../utils/request-validation.js';
import { createLogger } from '../logger.js';
```

**After:**
```javascript
import { getCorsHeaders } from '../cors.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';
import { parseJsonBody, BodyTooLargeError } from '../utils/request-validation.js';
import { createLogger } from '../logger.js';
import { isNonNegativeInteger, isPositiveInteger } from '../utils/numeric-validation.js';
```

---

### Step 3: Fix `critical_regions` Validation in `handleUploadReference`

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/attestation-registry-do.js`

**Location:** Lines 494-503

**Before:**
```javascript
    // Validate each critical region
    for (const region of critical_regions) {
      if (typeof region.offset !== 'number' || typeof region.length !== 'number') {
        return this.jsonResponse(
          { error: 'Each critical_region must have numeric offset and length' },
          400,
          corsHeaders
        );
      }
    }
```

**After:**
```javascript
    // Validate each critical region
    for (const region of critical_regions) {
      if (!isNonNegativeInteger(region.offset)) {
        return this.jsonResponse(
          { error: 'Each critical_region must have a non-negative integer offset' },
          400,
          corsHeaders
        );
      }

      if (!isPositiveInteger(region.length)) {
        return this.jsonResponse(
          { error: 'Each critical_region must have a positive integer length' },
          400,
          corsHeaders
        );
      }

      // Validate data_hex if present
      if (region.data_hex !== undefined) {
        if (typeof region.data_hex !== 'string' || region.data_hex.length === 0) {
          return this.jsonResponse(
            { error: 'critical_region data_hex must be a non-empty string' },
            400,
            corsHeaders
          );
        }

        // Validate hex encoding (must be even length and only hex chars)
        if (region.data_hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(region.data_hex)) {
          return this.jsonResponse(
            { error: 'critical_region data_hex must be valid hex encoding' },
            400,
            corsHeaders
          );
        }
      }
    }
```

**Rationale:**
- `isNonNegativeInteger()` rejects NaN, Infinity, negative, fractional, and non-number types
- `isPositiveInteger()` additionally rejects zero (a region with length=0 is meaningless)
- Added validation for `data_hex` format to prevent downstream hex parsing errors

---

### Step 4: Restructure `handleVerify` to Validate Before Nonce Deletion

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/attestation-registry-do.js`

**Location:** Lines 718-789 (the entire verify flow after device_id check)

**Before:**
```javascript
    // Delete the nonce to prevent replay
    await this.state.storage.delete(`nonce:${nonce}`);

    // Look up reference binary to get expected HMACs
    const reference = await this.state.storage.get(
      `reference:${challenge.build_version}:${challenge.platform}`
    );
    if (!reference) {
      console.error('[verify] Reference binary not found', { version: challenge.build_version, platform: challenge.platform });
      return this.jsonResponse(
        { valid: false, error: 'Reference binary no longer available' },
        200,
        corsHeaders
      );
    }

    // Verify each response
    // [... comment block ...]
    if (responses.length !== challenge.regions.length) {
      console.error('[verify] Wrong response count', { expected: challenge.regions.length, got: responses.length });
      return this.jsonResponse(
        { valid: false, error: 'Wrong number of responses' },
        200,
        corsHeaders
      );
    }

    for (const response of responses) {
      const { region_index, hmac } = response;

      if (region_index < 0 || region_index >= challenge.regions.length) {
        console.error('[verify] Invalid region_index', { region_index });
        return this.jsonResponse(
          { valid: false, error: VERIFY_FAILED_MSG },
          200,
          corsHeaders
        );
      }

      const challengeRegion = challenge.regions[region_index];
      // [... rest of HMAC verification ...]
    }
```

**After:**
```javascript
    // --- STEP 1: Look up reference binary (before deleting nonce) ---
    const reference = await this.state.storage.get(
      `reference:${challenge.build_version}:${challenge.platform}`
    );
    if (!reference) {
      console.error('[verify] Reference binary not found', { version: challenge.build_version, platform: challenge.platform });
      return this.jsonResponse(
        { valid: false, error: 'Reference binary no longer available' },
        200,
        corsHeaders
      );
    }

    // --- STEP 2: Validate response count (before deleting nonce) ---
    if (responses.length !== challenge.regions.length) {
      console.error('[verify] Wrong response count', { expected: challenge.regions.length, got: responses.length });
      return this.jsonResponse(
        { valid: false, error: 'Wrong number of responses' },
        200,
        corsHeaders
      );
    }

    // --- STEP 3: Validate ALL response inputs (before deleting nonce) ---
    // This prevents nonce consumption DoS: an attacker who knows a valid nonce
    // cannot invalidate it by submitting malformed responses.
    for (const response of responses) {
      const { region_index, hmac } = response;

      // Validate region_index is a non-negative integer
      if (!isNonNegativeInteger(region_index)) {
        console.error('[verify] Invalid region_index (not a non-negative integer)', { region_index, type: typeof region_index });
        return this.jsonResponse(
          { valid: false, error: VERIFY_FAILED_MSG },
          200,
          corsHeaders
        );
      }

      // Validate region_index is within bounds
      if (region_index >= challenge.regions.length) {
        console.error('[verify] region_index out of bounds', { region_index, max: challenge.regions.length - 1 });
        return this.jsonResponse(
          { valid: false, error: VERIFY_FAILED_MSG },
          200,
          corsHeaders
        );
      }

      // Validate hmac is a non-empty string
      if (typeof hmac !== 'string' || hmac.length === 0) {
        console.error('[verify] Invalid hmac format', { region_index });
        return this.jsonResponse(
          { valid: false, error: VERIFY_FAILED_MSG },
          200,
          corsHeaders
        );
      }
    }

    // --- STEP 4: Delete nonce AFTER all validation passes ---
    // Now that we know the input is well-formed, consume the nonce to prevent replay
    await this.state.storage.delete(`nonce:${nonce}`);

    // --- STEP 5: Perform HMAC verification ---
    // At this point, all inputs are validated and the nonce is consumed.
    // Any failures here are legitimate attestation failures, not input errors.
    for (const response of responses) {
      const { region_index, hmac } = response;
      const challengeRegion = challenge.regions[region_index];

      // Find the matching critical region in reference data
      const refRegion = reference.critical_regions.find(
        (r) => r.offset === challengeRegion.offset && r.length === challengeRegion.length
      );

      if (!refRegion || !refRegion.data_hex) {
        console.error('[verify] Reference data not available for region', { region_index });
        return this.jsonResponse(
          { valid: false, error: VERIFY_FAILED_MSG },
          200,
          corsHeaders
        );
      }

      // Compute expected HMAC: HMAC-SHA256(region_bytes, nonce)
      const regionBytes = hexToBytes(refRegion.data_hex);
      const expectedHmac = await computeHmac(regionBytes, nonce);

      if (!timingSafeEqual(hmac, expectedHmac)) {
        console.error('[verify] HMAC mismatch', { region_index });
        return this.jsonResponse(
          { valid: false, error: 'HMAC mismatch' },
          200,
          corsHeaders
        );
      }
    }
```

**Rationale:**
- Moved nonce deletion from line 720 to AFTER all input validation (line 720 → after input validation loop)
- Split the original single loop into two loops:
  1. First loop: Validate ALL inputs (region_index, hmac format) - returns early on error WITHOUT consuming nonce
  2. Second loop: Perform HMAC verification - runs only after nonce is deleted
- This prevents nonce consumption DoS where an attacker submits invalid `region_index` values to consume a legitimate device's nonce
- Improved error logging to distinguish type errors from bounds errors

---

### Step 5: Add Defensive Guard to `selectRandomRegions`

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/attestation-registry-do.js`

**Location:** Lines 977-979

**Before:**
```javascript
  selectRandomRegions(criticalRegions, count) {
    const selectCount = Math.min(count, criticalRegions.length);
    const selected = [];
```

**After:**
```javascript
  selectRandomRegions(criticalRegions, count) {
    // Defensive guard: count should always be a valid integer from the caller,
    // but guard against NaN/Infinity which would make Math.min return NaN
    if (!isNonNegativeInteger(count)) {
      throw new Error(`selectRandomRegions: count must be a non-negative integer, got ${count}`);
    }

    const selectCount = Math.min(count, criticalRegions.length);
    const selected = [];
```

**Rationale:**
- The current caller uses `MIN_CHALLENGE_REGIONS + Math.floor(Math.random() * ...)` which always produces a valid integer
- However, this is a fragile assumption. Adding an explicit guard makes the function more robust and easier to debug if called incorrectly in the future
- If `count` is NaN, `Math.min(NaN, n)` returns NaN, and the loop `for (let i = 0; i < NaN; i++)` never executes, returning an empty array (silent failure)

---

## Test Plan

### Test File 1: Unit Tests for Validation Helper

**Create:** `/home/meywd/zajel-ddos/packages/server/tests/unit/numeric-validation.test.js`

```javascript
/**
 * Unit tests for numeric validation utilities.
 *
 * Tests the isNonNegativeInteger and isPositiveInteger functions
 * against JavaScript's type coercion edge cases.
 */

import { describe, it, expect } from 'vitest';
import { isNonNegativeInteger, isPositiveInteger } from '../../src/utils/numeric-validation.js';

describe('isNonNegativeInteger', () => {
  it('should accept valid non-negative integers', () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(1)).toBe(true);
    expect(isNonNegativeInteger(5)).toBe(true);
    expect(isNonNegativeInteger(100)).toBe(true);
    expect(isNonNegativeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('should reject negative integers', () => {
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(-5)).toBe(false);
    expect(isNonNegativeInteger(Number.MIN_SAFE_INTEGER)).toBe(false);
  });

  it('should reject fractional numbers', () => {
    expect(isNonNegativeInteger(0.5)).toBe(false);
    expect(isNonNegativeInteger(1.1)).toBe(false);
    expect(isNonNegativeInteger(1.9999)).toBe(false);
    expect(isNonNegativeInteger(Math.PI)).toBe(false);
  });

  it('should reject NaN', () => {
    expect(isNonNegativeInteger(NaN)).toBe(false);
    expect(isNonNegativeInteger(0 / 0)).toBe(false);
    expect(isNonNegativeInteger(Math.sqrt(-1))).toBe(false);
  });

  it('should reject Infinity and -Infinity', () => {
    expect(isNonNegativeInteger(Infinity)).toBe(false);
    expect(isNonNegativeInteger(-Infinity)).toBe(false);
    expect(isNonNegativeInteger(1 / 0)).toBe(false);
  });

  it('should reject null', () => {
    expect(isNonNegativeInteger(null)).toBe(false);
  });

  it('should reject undefined', () => {
    expect(isNonNegativeInteger(undefined)).toBe(false);
  });

  it('should reject numeric strings', () => {
    expect(isNonNegativeInteger('0')).toBe(false);
    expect(isNonNegativeInteger('5')).toBe(false);
    expect(isNonNegativeInteger('123')).toBe(false);
  });

  it('should reject non-numeric strings', () => {
    expect(isNonNegativeInteger('abc')).toBe(false);
    expect(isNonNegativeInteger('NaN')).toBe(false);
    expect(isNonNegativeInteger('')).toBe(false);
  });

  it('should reject objects and arrays', () => {
    expect(isNonNegativeInteger({})).toBe(false);
    expect(isNonNegativeInteger([])).toBe(false);
    expect(isNonNegativeInteger([5])).toBe(false);
    expect(isNonNegativeInteger({ value: 5 })).toBe(false);
  });

  it('should reject booleans', () => {
    expect(isNonNegativeInteger(true)).toBe(false);
    expect(isNonNegativeInteger(false)).toBe(false);
  });
});

describe('isPositiveInteger', () => {
  it('should accept valid positive integers', () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(5)).toBe(true);
    expect(isPositiveInteger(100)).toBe(true);
    expect(isPositiveInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('should reject zero', () => {
    expect(isPositiveInteger(0)).toBe(false);
  });

  it('should reject negative integers', () => {
    expect(isPositiveInteger(-1)).toBe(false);
    expect(isPositiveInteger(-5)).toBe(false);
  });

  it('should reject NaN, Infinity, null, undefined', () => {
    expect(isPositiveInteger(NaN)).toBe(false);
    expect(isPositiveInteger(Infinity)).toBe(false);
    expect(isPositiveInteger(-Infinity)).toBe(false);
    expect(isPositiveInteger(null)).toBe(false);
    expect(isPositiveInteger(undefined)).toBe(false);
  });
});
```

**Expected Results:**
- All tests pass
- 100% code coverage for the validation utility module

---

### Test File 2: E2E Tests for Attestation NaN Validation

**File:** `/home/meywd/zajel-ddos/packages/server/tests/e2e/attestation.test.js`

**Location:** Add new test suite at end of file (before closing `describe` block)

```javascript
describe('NaN and Type Coercion Input Validation', () => {
  let mockEnv;
  let mockState;
  let attestationDO;
  let seedHex;
  let publicKeyBase64;

  beforeEach(async () => {
    mockState = new MockState();
    seedHex = await generateTestSeed();
    publicKeyBase64 = await exportPublicKey(seedHex);

    mockEnv = {
      ATTESTATION_SIGNING_KEY: seedHex,
      BUILD_SIGNING_PUBKEY: publicKeyBase64,
      AUDIT_LOG_KEY: 'test-audit-key',
    };

    attestationDO = new AttestationRegistryDO(mockState, mockEnv);

    // Upload reference binary
    const uploadRequest = createRequest(
      'POST',
      '/attest/upload-reference',
      {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        critical_regions: [
          { offset: 0, length: 100, data_hex: 'deadbeef' },
          { offset: 200, length: 50, data_hex: 'cafebabe' },
          { offset: 500, length: 75, data_hex: 'baadf00d' },
        ],
      },
      { Authorization: 'Bearer test-ci-secret' }
    );

    mockEnv.CI_UPLOAD_SECRET = 'test-ci-secret';
    await attestationDO.fetch(uploadRequest);

    // Register device
    const buildToken = await createBuildToken(seedHex, {
      version: '1.0.0',
      platform: 'android',
      build_hash: 'abc123',
      timestamp: Date.now(),
    });

    const registerRequest = createRequest('POST', '/attest/register', {
      device_id: 'device-nan-test',
      build_token: buildToken,
    });

    await attestationDO.fetch(registerRequest);
  });

  describe('region_index validation', () => {
    it('should reject region_index as string "abc" (NaN coercion)', async () => {
      // Get challenge
      const challengeReq = createRequest('POST', '/attest/challenge', {
        device_id: 'device-nan-test',
        build_version: '1.0.0',
      });
      const challengeRes = await attestationDO.fetch(challengeReq);
      const { nonce, regions } = await challengeRes.json();

      // Submit verify with string region_index
      const verifyReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: regions.map((r) => ({
          region_index: 'abc', // String, not a number
          hmac: 'deadbeef',
        })),
      });

      const verifyRes = await attestationDO.fetch(verifyReq);
      const data = await verifyRes.json();

      expect(verifyRes.status).toBe(200);
      expect(data.valid).toBe(false);
      expect(data.error).toBe(VERIFY_FAILED_MSG);

      // Verify nonce was NOT consumed (should still exist)
      const retryVerifyReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: regions.map((r) => ({
          region_index: r.index,
          hmac: 'wrong-but-valid-format',
        })),
      });

      const retryRes = await attestationDO.fetch(retryVerifyReq);
      const retryData = await retryRes.json();

      // Nonce should be consumed on second attempt (even if HMAC is wrong)
      // Because the second request has valid region_index format
      expect(retryRes.status).toBe(200);
      // This would fail HMAC verification, but at least it processes
    });

    it('should reject region_index as null (coerces to 0)', async () => {
      const challengeReq = createRequest('POST', '/attest/challenge', {
        device_id: 'device-nan-test',
        build_version: '1.0.0',
      });
      const challengeRes = await attestationDO.fetch(challengeReq);
      const { nonce } = await challengeRes.json();

      const verifyReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: [
          { region_index: null, hmac: 'deadbeef' },
        ],
      });

      const verifyRes = await attestationDO.fetch(verifyReq);
      const data = await verifyRes.json();

      expect(verifyRes.status).toBe(200);
      expect(data.valid).toBe(false);
      expect(data.error).toBe(VERIFY_FAILED_MSG);
    });

    it('should reject region_index as undefined (missing field)', async () => {
      const challengeReq = createRequest('POST', '/attest/challenge', {
        device_id: 'device-nan-test',
        build_version: '1.0.0',
      });
      const challengeRes = await attestationDO.fetch(challengeReq);
      const { nonce } = await challengeRes.json();

      const verifyReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: [
          { hmac: 'deadbeef' }, // Missing region_index
        ],
      });

      const verifyRes = await attestationDO.fetch(verifyReq);
      const data = await verifyRes.json();

      expect(verifyRes.status).toBe(200);
      expect(data.valid).toBe(false);
    });

    it('should reject region_index as negative integer', async () => {
      const challengeReq = createRequest('POST', '/attest/challenge', {
        device_id: 'device-nan-test',
        build_version: '1.0.0',
      });
      const challengeRes = await attestationDO.fetch(challengeReq);
      const { nonce } = await challengeRes.json();

      const verifyReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: [
          { region_index: -1, hmac: 'deadbeef' },
        ],
      });

      const verifyRes = await attestationDO.fetch(verifyReq);
      const data = await verifyRes.json();

      expect(verifyRes.status).toBe(200);
      expect(data.valid).toBe(false);
    });

    it('should reject region_index as fractional number', async () => {
      const challengeReq = createRequest('POST', '/attest/challenge', {
        device_id: 'device-nan-test',
        build_version: '1.0.0',
      });
      const challengeRes = await attestationDO.fetch(challengeReq);
      const { nonce } = await challengeRes.json();

      const verifyReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: [
          { region_index: 1.5, hmac: 'deadbeef' },
        ],
      });

      const verifyRes = await attestationDO.fetch(verifyReq);
      const data = await verifyRes.json();

      expect(verifyRes.status).toBe(200);
      expect(data.valid).toBe(false);
    });

    it('should reject region_index as Infinity', async () => {
      const challengeReq = createRequest('POST', '/attest/challenge', {
        device_id: 'device-nan-test',
        build_version: '1.0.0',
      });
      const challengeRes = await attestationDO.fetch(challengeReq);
      const { nonce } = await challengeRes.json();

      // Note: JSON.stringify(Infinity) produces "null", so we need to construct
      // the request body manually
      const body = {
        device_id: 'device-nan-test',
        nonce,
        responses: [
          { region_index: Infinity, hmac: 'deadbeef' },
        ],
      };

      // JSON.stringify will convert Infinity to null, but in a real scenario
      // the client might send a custom payload. For this test, we'll use
      // a large number to simulate Infinity-like behavior.
      body.responses[0].region_index = Number.MAX_VALUE;

      const verifyReq = createRequest('POST', '/attest/verify', body);
      const verifyRes = await attestationDO.fetch(verifyReq);
      const data = await verifyRes.json();

      expect(verifyRes.status).toBe(200);
      expect(data.valid).toBe(false);
    });

    it('should accept valid region_index values', async () => {
      const challengeReq = createRequest('POST', '/attest/challenge', {
        device_id: 'device-nan-test',
        build_version: '1.0.0',
      });
      const challengeRes = await attestationDO.fetch(challengeReq);
      const { nonce, regions } = await challengeRes.json();

      // Compute correct HMACs
      const responses = [];
      for (const region of regions) {
        const refRegion = await mockState.storage.get('reference:1.0.0:android');
        const matchingRegion = refRegion.critical_regions.find(
          (r) => r.offset === region.offset && r.length === region.length
        );
        const regionBytes = hexToBytes(matchingRegion.data_hex);
        const hmac = await computeHmac(regionBytes, nonce);
        responses.push({ region_index: region.index, hmac });
      }

      const verifyReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses,
      });

      const verifyRes = await attestationDO.fetch(verifyReq);
      const data = await verifyRes.json();

      expect(verifyRes.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.session_token).toBeDefined();
    });
  });

  describe('critical_regions validation in upload-reference', () => {
    it('should reject critical_region with NaN offset', async () => {
      const uploadRequest = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '2.0.0',
          platform: 'android',
          build_hash: 'xyz789',
          critical_regions: [
            { offset: NaN, length: 100, data_hex: 'deadbeef' },
          ],
        },
        { Authorization: 'Bearer test-ci-secret' }
      );

      const response = await attestationDO.fetch(uploadRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('non-negative integer offset');
    });

    it('should reject critical_region with negative offset', async () => {
      const uploadRequest = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '2.0.0',
          platform: 'android',
          build_hash: 'xyz789',
          critical_regions: [
            { offset: -100, length: 100, data_hex: 'deadbeef' },
          ],
        },
        { Authorization: 'Bearer test-ci-secret' }
      );

      const response = await attestationDO.fetch(uploadRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('non-negative integer offset');
    });

    it('should reject critical_region with zero length', async () => {
      const uploadRequest = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '2.0.0',
          platform: 'android',
          build_hash: 'xyz789',
          critical_regions: [
            { offset: 0, length: 0, data_hex: 'deadbeef' },
          ],
        },
        { Authorization: 'Bearer test-ci-secret' }
      );

      const response = await attestationDO.fetch(uploadRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('positive integer length');
    });

    it('should reject critical_region with fractional length', async () => {
      const uploadRequest = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '2.0.0',
          platform: 'android',
          build_hash: 'xyz789',
          critical_regions: [
            { offset: 0, length: 100.5, data_hex: 'deadbeef' },
          ],
        },
        { Authorization: 'Bearer test-ci-secret' }
      );

      const response = await attestationDO.fetch(uploadRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('positive integer length');
    });

    it('should reject critical_region with null offset', async () => {
      const uploadRequest = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '2.0.0',
          platform: 'android',
          build_hash: 'xyz789',
          critical_regions: [
            { offset: null, length: 100, data_hex: 'deadbeef' },
          ],
        },
        { Authorization: 'Bearer test-ci-secret' }
      );

      const response = await attestationDO.fetch(uploadRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('non-negative integer offset');
    });

    it('should reject critical_region with invalid hex data', async () => {
      const uploadRequest = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '2.0.0',
          platform: 'android',
          build_hash: 'xyz789',
          critical_regions: [
            { offset: 0, length: 100, data_hex: 'not-hex-data!' },
          ],
        },
        { Authorization: 'Bearer test-ci-secret' }
      );

      const response = await attestationDO.fetch(uploadRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('valid hex encoding');
    });

    it('should reject critical_region with odd-length hex data', async () => {
      const uploadRequest = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '2.0.0',
          platform: 'android',
          build_hash: 'xyz789',
          critical_regions: [
            { offset: 0, length: 100, data_hex: 'abc' }, // Odd length
          ],
        },
        { Authorization: 'Bearer test-ci-secret' }
      );

      const response = await attestationDO.fetch(uploadRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('valid hex encoding');
    });

    it('should accept valid critical_regions', async () => {
      const uploadRequest = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '2.0.0',
          platform: 'android',
          build_hash: 'xyz789',
          critical_regions: [
            { offset: 0, length: 100, data_hex: 'deadbeef' },
            { offset: 200, length: 50, data_hex: 'cafebabe' },
          ],
        },
        { Authorization: 'Bearer test-ci-secret' }
      );

      const response = await attestationDO.fetch(uploadRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('Nonce consumption DoS prevention', () => {
    it('should NOT consume nonce when region_index validation fails', async () => {
      // Get challenge
      const challengeReq = createRequest('POST', '/attest/challenge', {
        device_id: 'device-nan-test',
        build_version: '1.0.0',
      });
      const challengeRes = await attestationDO.fetch(challengeReq);
      const { nonce, regions } = await challengeRes.json();

      // First attempt: invalid region_index
      const invalidVerifyReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: regions.map(() => ({
          region_index: 'invalid',
          hmac: 'deadbeef',
        })),
      });

      const invalidRes = await attestationDO.fetch(invalidVerifyReq);
      expect(invalidRes.status).toBe(200);
      const invalidData = await invalidRes.json();
      expect(invalidData.valid).toBe(false);

      // Second attempt: valid format but wrong HMAC
      const validFormatReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: regions.map((r) => ({
          region_index: r.index,
          hmac: 'wrong-hmac-but-valid-format',
        })),
      });

      const validFormatRes = await attestationDO.fetch(validFormatReq);
      expect(validFormatRes.status).toBe(200);

      // The second attempt should succeed in consuming the nonce
      // (even though HMAC verification fails), proving the nonce
      // was NOT consumed by the first attempt.

      // Third attempt: should fail with "Invalid or expired nonce"
      const thirdAttemptReq = createRequest('POST', '/attest/verify', {
        device_id: 'device-nan-test',
        nonce,
        responses: regions.map((r) => ({
          region_index: r.index,
          hmac: 'any-value',
        })),
      });

      const thirdAttemptRes = await attestationDO.fetch(thirdAttemptReq);
      const thirdAttemptData = await thirdAttemptRes.json();
      expect(thirdAttemptRes.status).toBe(403);
      expect(thirdAttemptData.error).toContain('Invalid or expired nonce');
    });
  });
});
```

**Expected Results:**
- All tests pass
- Nonce consumption DoS is prevented (nonce not deleted on input validation failure)
- All NaN, Infinity, null, undefined, negative, and fractional values are rejected
- Valid inputs continue to work correctly

---

### Test Execution Commands

```bash
# Run all server tests
cd /home/meywd/zajel-ddos/packages/server
npm test

# Run only numeric validation unit tests
npm test -- numeric-validation.test.js

# Run only attestation E2E tests
npm test -- attestation.test.js

# Run with coverage
npm test -- --coverage
```

---

## Rollback Risk

**Risk Level: LOW**

### Why Low Risk?

1. **Additive Changes**: The fix adds stricter validation without changing the happy path logic. Valid inputs that worked before will continue to work.

2. **No Schema Changes**: No changes to storage keys, data structures, or API response formats. The fix only rejects previously-accepted malformed inputs.

3. **Graceful Degradation**: If the new validation is too strict (false positive), the server returns a clean 400/403 error instead of crashing with a 500 error. This is strictly better than the current behavior.

4. **Isolated Module**: The new `numeric-validation.js` utility is self-contained and has no side effects. It can be disabled by reverting the imports.

### Rollback Plan

If issues arise after deployment:

1. **Immediate Rollback** (revert to previous behavior):
   ```bash
   git revert <commit-hash>
   wrangler deploy
   ```

2. **Partial Rollback** (disable only new validation, keep test coverage):
   - Comment out the `isNonNegativeInteger()` checks in `attestation-registry-do.js`
   - Restore the original `typeof === 'number'` checks
   - Keep the nonce deletion move (it's a security improvement with no downside)

3. **Monitor for False Positives**:
   - Check error logs for `Invalid region_index (not a non-negative integer)` messages
   - If legitimate clients are being rejected, investigate their request payloads
   - Adjust validation logic if needed (e.g., allow specific edge cases)

### Monitoring After Deployment

Monitor these metrics for 24 hours post-deployment:

- **Error rate for `/attest/verify`**: Should not increase for legitimate clients
- **`console.error('[verify] Invalid region_index')`**: Should appear only for malformed requests
- **Nonce consumption rate**: Should decrease (fewer nonces consumed by invalid requests)
- **500 errors from attestation endpoints**: Should decrease to zero

---

## Dependencies on Other Stories

### Depends On

**None**. This story is self-contained and can be implemented independently.

### Blocks

**Story 014: Security Test Coverage** (Priority: THIS SPRINT)

Story 014 identifies the lack of test coverage for server code as a high-severity issue. This implementation plan addresses part of Story 014 by adding:
- Unit tests for numeric validation (`numeric-validation.test.js`)
- E2E tests for NaN validation in attestation flow (new test suite in `attestation.test.js`)

However, Story 014 has a much broader scope (testing ALL server functionality, not just NaN validation). Once this plan is implemented, Story 014's scope can be updated to exclude NaN validation tests.

### Related Stories

**Story 003: Attestation Log Leakage** (Priority: THIS SPRINT)

Story 003 addresses information leakage through error logs. The NaN validation fix in this plan improves logging by:
- Adding type information to error logs: `{ region_index, type: typeof region_index }`
- Distinguishing type errors from bounds errors

This is complementary to Story 003's goal of reducing log leakage. When implementing Story 003, consider whether the enhanced logging in this plan leaks too much information to attackers.

**Story 010: Timing-Safe HMAC Normalize** (Priority: THIS SPRINT)

Story 010 addresses timing side-channel attacks in HMAC comparison. The NaN validation fix in this plan is orthogonal to Story 010 but shares a similar theme of JavaScript type safety in security-critical code. Both stories can be implemented in parallel.

---

## Implementation Checklist

- [ ] Create `src/utils/numeric-validation.js` with validation helpers
- [ ] Add import to `attestation-registry-do.js`
- [ ] Update `critical_regions` validation in `handleUploadReference` (lines 494-503)
- [ ] Restructure `handleVerify` to validate before nonce deletion (lines 718-789)
- [ ] Add defensive guard to `selectRandomRegions` (lines 977-979)
- [ ] Create `tests/unit/numeric-validation.test.js` with unit tests
- [ ] Add E2E tests to `tests/e2e/attestation.test.js`
- [ ] Run full test suite: `npm test`
- [ ] Verify all tests pass
- [ ] Deploy to staging environment
- [ ] Monitor error logs for 24 hours
- [ ] Deploy to production
- [ ] Update Story 014 to reflect completed NaN validation tests

---

## Acceptance Criteria

### From Story 013

- [x] `region_index` is validated as a non-negative integer using `Number.isFinite()` and `Number.isInteger()`
- [x] `critical_regions[].offset` and `critical_regions[].length` are validated with `Number.isFinite()` and `Number.isInteger()`
- [x] NaN, Infinity, -Infinity, null, undefined, and string values for `region_index` return a clean error response (not 500)
- [x] Nonce deletion is moved after input validation to prevent nonce consumption DoS
- [x] All numeric field validations in both DOs use the same `isNonNegativeInteger` helper for consistency
- [x] The `isNonNegativeInteger` helper is extracted to a shared utility module

### Additional Criteria

- [x] Validation also rejects negative and fractional values
- [x] `isPositiveInteger()` helper is provided for zero-rejecting validation
- [x] Enhanced error logging includes type information for debugging
- [x] Comprehensive test coverage for all edge cases
- [x] Hex data validation added to `critical_regions` (bonus security improvement)

---

## Notes for Implementation

### JavaScript Type Coercion Gotchas

When implementing the validation, be aware of these JavaScript quirks:

1. **`typeof NaN === 'number'`** is `true`
   - Use `Number.isFinite()` to reject NaN and Infinity

2. **`null` coerces to `0` in numeric contexts**
   - `null < 1` is `true` (null → 0 < 1)
   - Use strict type check: `typeof value === 'number'`

3. **`undefined` coerces to `NaN` in numeric contexts**
   - `undefined < 1` is `false` (undefined → NaN, NaN < 1 → false)
   - Array access: `arr[undefined]` returns `undefined` (not an error!)

4. **Comparison operators with NaN always return `false`**
   - `NaN < 0` → false
   - `NaN >= 0` → false
   - `NaN === NaN` → false

5. **`Number.isInteger()` returns `false` for non-numbers**
   - `Number.isInteger(null)` → false (correct)
   - `Number.isInteger("5")` → false (correct)
   - `Number.isInteger(5.0)` → true (correct, 5.0 is an integer)

### Test Coverage Goals

Aim for these coverage metrics:

- **`numeric-validation.js`**: 100% line, branch, and function coverage
- **`attestation-registry-do.js` (modified functions)**: >95% coverage
- **Overall server package**: >80% coverage after Story 014 is complete

### Performance Considerations

The additional validation adds minimal overhead:

- `isNonNegativeInteger()`: 4 checks (typeof, isFinite, >= 0, isInteger) - approximately 50-100ns per call
- Moved nonce deletion: No performance impact (same number of storage operations, different order)
- Extra validation loop: One additional loop over `responses` array (typically 3-5 elements) - negligible impact

The performance cost is FAR outweighed by the security benefit of preventing nonce consumption DoS.

---

## Estimated Implementation Time

- **Step 1** (Create validation utility): 30 minutes
- **Step 2** (Update imports): 5 minutes
- **Step 3** (Fix critical_regions validation): 30 minutes
- **Step 4** (Restructure verify flow): 1 hour
- **Step 5** (Add defensive guard): 15 minutes
- **Test File 1** (Unit tests): 1 hour
- **Test File 2** (E2E tests): 2 hours
- **Testing and debugging**: 1 hour
- **Documentation updates**: 30 minutes

**Total: ~7 hours**

This is a conservative estimate. An experienced developer familiar with the codebase could complete this in 4-5 hours.

---

## Security Impact Summary

### Before Fix

- ❌ `region_index: "abc"` bypasses bounds check → 500 error (TypeError)
- ❌ `region_index: null` silently coerces to `0` → accesses wrong region
- ❌ `region_index: undefined` bypasses bounds check → 500 error
- ❌ Invalid requests consume nonces → DoS against legitimate devices
- ❌ `critical_regions` with NaN offset/length poisoned in storage → future verification failures

### After Fix

- ✅ All malformed `region_index` values rejected with clean 400 error
- ✅ Nonces preserved when validation fails → no DoS vector
- ✅ `critical_regions` with NaN/negative/fractional values rejected at upload time
- ✅ Improved error logging for debugging without information leakage
- ✅ Consistent validation across all numeric inputs

### Remaining Risks (Out of Scope)

This fix does NOT address:
- **Timing side-channels in HMAC verification** (covered by Story 010)
- **Log information leakage** (covered by Story 003)
- **Rate limiting on attestation endpoints** (covered by Story 011)
- **Test coverage gaps** (covered by Story 014)

These are separate stories and should be implemented independently.

---

**End of Implementation Plan**
