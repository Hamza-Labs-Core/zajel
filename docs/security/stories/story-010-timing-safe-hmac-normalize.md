# Story 010: HMAC-Normalize Timing-Safe Comparison

## Priority: THIS WEEK
## Severity: MEDIUM
## Component: packages/server (crypto/timing-safe.js), packages/admin-cf (crypto.ts)

## Summary

The `timingSafeEqual` function in `packages/server/src/crypto/timing-safe.js` returns `false` early when input lengths differ (line 16-26), leaking that the lengths are different through timing. Additionally, it only iterates over the minimum of the two lengths, leaking the exact minimum length via timing. The version in `packages/admin-cf/src/crypto.ts` uses a different approach that avoids the early return but has its own subtlety with modular indexing. Both implementations should be replaced with HMAC-based normalization that makes comparison fully constant-time regardless of input lengths.

## Current Behavior

### Server Version (`packages/server/src/crypto/timing-safe.js`, lines 11-33)

```javascript
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

**Issues:**
1. **Early `return false` on length mismatch (line 25)**: The function ALWAYS returns `false` when lengths differ. While a dummy loop runs, it only iterates `min(len_a, len_b)` times, not `max(len_a, len_b)`. An attacker measuring response time can distinguish between:
   - Matching lengths (loop runs `n` times, then checks result)
   - Mismatched lengths (loop runs `min(a, b)` times, returns false immediately)
2. **Minimum length leakage**: The loop iterating `minLen` times leaks how long the shorter string is. By varying the length of the guess and measuring timing, an attacker can determine the exact length of the secret.
3. **`void dummy` is not sufficient**: V8 may still optimize away the loop since `dummy` has no observable side effect. The `void` operator merely evaluates the expression and returns `undefined`; it does not constitute a side effect that prevents dead-code elimination.

This function is used for critical authentication checks:
- `verifyServerAuth()` at line 350: `timingSafeEqual(authHeader, \`Bearer ${this.env.SERVER_REGISTRY_SECRET}\`)`
- `verifyCIAuth()` at line 361: `timingSafeEqual(authHeader, \`Bearer ${this.env.CI_UPLOAD_SECRET}\`)`

### Admin CF Version (`packages/admin-cf/src/crypto.ts`, lines 207-214)

```typescript
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i % a.length) ^ b.charCodeAt(i % b.length));
  }
  return result === 0;
}
```

**Issues:**
1. **Better than the server version**: This does not return early and always loops `max(a, b)` times, which is an improvement.
2. **Length XOR in result**: `a.length ^ b.length` correctly encodes length mismatch as non-zero.
3. **Modular indexing wraps around**: When `i >= a.length`, it wraps via `i % a.length`, re-comparing earlier characters. This means the comparison is not of the original strings but of "looped" versions. While this still produces the correct boolean result (lengths differ -> result != 0), the modular arithmetic introduces computation patterns that depend on the lengths, potentially leaking information through CPU cache behavior or branch prediction (though this is more theoretical).
4. **Not used for secret comparison**: This function is only used in `verifyPassword()` (line 58) to compare password hashes, where both inputs are always the same length (hex-encoded SHA-256 output = 64 chars). The risk is lower here, but the function could be reused for other comparisons in the future.

### Comparison with VPS Admin (`packages/server-vps/src/admin/auth.ts`, line 8, 40-43)

The VPS admin correctly uses Node.js's built-in `timingSafeEqual` from the `crypto` module:

```typescript
import { createHmac, timingSafeEqual } from 'crypto';
// ...
if (
  expectedSignature.length !== providedSignature.length ||
  !timingSafeEqual(expectedSignature, providedSignature)
)
```

This is the correct approach for Node.js environments. However, it still has the early return on length mismatch (line 41). For HMAC signatures, this is less concerning since HMAC output is always the same length, but the pattern is still not ideal.

## Expected Behavior

The timing-safe comparison should:
1. Never leak whether the inputs have the same or different lengths.
2. Always take the same amount of time regardless of inputs.
3. Be resistant to compiler/JIT dead-code elimination.

The standard approach is **HMAC normalization**: HMAC both inputs with a random key, then compare the fixed-length HMAC outputs. Since HMAC output is always the same length (e.g., 32 bytes for HMAC-SHA256), the comparison is trivially constant-time.

## Root Cause Analysis

The server's `timingSafeEqual` was implemented as a custom XOR-based comparison because the Cloudflare Workers runtime does not provide Node.js's `crypto.timingSafeEqual`. The developer was aware of the timing issue (the comment on line 17 says "Still do a full comparison to avoid leaking length info through timing") but the mitigation is incomplete:

1. The dummy loop only runs `minLen` iterations, not `maxLen`.
2. The early `return false` after the dummy loop still has a different code path than the equal-length case.
3. V8's optimizer can potentially eliminate the dummy loop entirely.

In practice, the function is called with inputs like:
- `timingSafeEqual("Bearer actual-secret-here", "Bearer attacker-guess")` (for server auth)

An attacker who can make many requests and measure response times with sub-millisecond precision could:
1. Determine the length of the secret by varying guess length and detecting the timing change when lengths match.
2. Once the length is known, focus on byte-by-byte guessing (though the XOR loop resists this in the equal-length case).

In a Cloudflare Workers environment, network jitter makes this attack difficult but not impossible, especially for motivated attackers with many samples.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/crypto/timing-safe.js` | 11-33 | Main `timingSafeEqual()` implementation |
| `packages/server/src/durable-objects/server-registry-do.js` | 350 | `verifyServerAuth()` -- uses `timingSafeEqual` |
| `packages/server/src/durable-objects/server-registry-do.js` | 361 | `verifyCIAuth()` -- uses `timingSafeEqual` |
| `packages/admin-cf/src/crypto.ts` | 207-214 | Admin CF `timingSafeEqual()` implementation |
| `packages/admin-cf/src/crypto.ts` | 58 | `verifyPassword()` -- uses `timingSafeEqual` |

## Reproduction Steps

1. Set up the bootstrap server with a known `SERVER_REGISTRY_SECRET` of length N.
2. Send heartbeat requests with `Authorization: Bearer <guess>` where the guess varies in length.
3. Measure response times for each length.
4. With sufficient samples (thousands), plot response time vs. guess length.
5. Observe a timing shift when the guess length matches the secret length (the function takes a different code path: the equal-length path iterates N times and checks `result === 0`, while the unequal-length path iterates `min(N, guess_length)` times and returns `false`).

Note: In practice, this requires statistical analysis over many samples due to network jitter, but is feasible against a low-latency Cloudflare Workers endpoint.

## Impact Assessment

- **Secret length disclosure**: An attacker can determine the exact length of `SERVER_REGISTRY_SECRET` and `CI_UPLOAD_SECRET` through timing analysis. Knowing the length reduces the search space for brute-force attacks.
- **Minimum length leakage**: The dummy loop leaking `minLen` gives a lower bound on the shorter input's length, which is always the attacker's guess (known) -- so this specifically leaks when the guess is shorter than the secret.
- **Practical difficulty**: Exploiting this requires many requests and statistical analysis. Network jitter in CF Workers adds noise. The severity is MEDIUM because the attack is not trivial but is possible.
- **Compounding with other issues**: If combined with weak secret generation or a constrained character set, length disclosure significantly reduces the effective entropy.

## Proposed Fix

Replace both implementations with HMAC-based normalization using Web Crypto API:

### Server Version (`packages/server/src/crypto/timing-safe.js`)

```javascript
/**
 * Constant-time string comparison using HMAC normalization.
 *
 * HMAC both inputs with a random key, producing fixed-length outputs,
 * then XOR-compare the outputs. This eliminates length-dependent timing
 * because HMAC output is always the same size regardless of input.
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {Promise<boolean>} Whether the strings are equal
 */
export async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();

  // Generate a random key per comparison to prevent oracle attacks
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // HMAC both inputs — output is always 32 bytes regardless of input length
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  // Fixed-length comparison (both are exactly 32 bytes)
  const bufA = new Uint8Array(macA);
  const bufB = new Uint8Array(macB);

  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
```

**Important**: This changes the function to be `async`. All callers must be updated:

```javascript
// server-registry-do.js:350 -- becomes async
verifyServerAuth(request) {
  // ...
  return timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
}
// Must become:
async verifyServerAuth(request) {
  // ...
  return await timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
}
```

And the callers in `fetch()` need `await`:
```javascript
// line 376
if (this.env.SERVER_REGISTRY_SECRET && !(await this.verifyServerAuth(request))) {
```

### Admin CF Version (`packages/admin-cf/src/crypto.ts`)

Apply the same HMAC-based approach, or since this is only used for equal-length hash comparison, the simpler fix is acceptable:

```typescript
/**
 * Timing-safe string comparison using HMAC normalization.
 * Uses Web Crypto API for HMAC to produce fixed-length outputs.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  const bufA = new Uint8Array(macA);
  const bufB = new Uint8Array(macB);

  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
```

Update `verifyPassword()` to be async-aware (it already is async, so this is a minor change):

```typescript
export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string
): Promise<boolean> {
  const computedHash = await hashPassword(password, salt);
  return await timingSafeEqual(computedHash, storedHash);
}
```

### Alternative: Synchronous Fix Without HMAC

If the async change is too disruptive, a synchronous improvement for the server version would be to pad to equal length before comparing:

```javascript
export function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  const maxLen = Math.max(bufA.byteLength, bufB.byteLength);
  // XOR the lengths into the result (non-zero if different)
  let result = bufA.byteLength ^ bufB.byteLength;

  for (let i = 0; i < maxLen; i++) {
    // Use modular indexing to avoid out-of-bounds
    // Length difference is already captured in `result`
    result |= (bufA[i % bufA.byteLength] ^ bufB[i % bufB.byteLength]);
  }
  return result === 0;
}
```

This is essentially what the admin-cf version already does but applied to the server version. It is better than the current server implementation but not as robust as HMAC normalization.

## Acceptance Criteria

- [ ] `timingSafeEqual` in `packages/server/src/crypto/timing-safe.js` does not return early on length mismatch
- [ ] `timingSafeEqual` comparison takes constant time regardless of input lengths
- [ ] The function does not leak the minimum input length through timing
- [ ] HMAC normalization is used (preferred) or at minimum, the function iterates `max(a, b)` times with length encoded in the result
- [ ] All callers of `timingSafeEqual` are updated to handle the async signature (if HMAC approach is used)
- [ ] `verifyServerAuth()` and `verifyCIAuth()` correctly await the comparison result
- [ ] `timingSafeEqual` in `packages/admin-cf/src/crypto.ts` is updated to use the same approach
- [ ] `verifyPassword()` in admin-cf works correctly with the updated function
- [ ] The XOR comparison loop result cannot be optimized away by the JIT compiler (HMAC approach inherently avoids this since the HMAC values are needed)

## Test Requirements

- **Unit test**: Equal strings return `true`.
- **Unit test**: Different strings of equal length return `false`.
- **Unit test**: Different strings of different lengths return `false`.
- **Unit test**: Empty strings: `timingSafeEqual("", "")` returns `true`.
- **Unit test**: One empty, one non-empty: returns `false`.
- **Timing test**: Measure execution time for 1000 comparisons with same-length inputs vs. different-length inputs. Assert that the standard deviation of timing between the two groups overlaps (i.e., no statistically significant timing difference). Note: This test may be flaky due to system load but should pass under normal conditions.
- **Unit test**: `verifyServerAuth` correctly accepts valid auth and rejects invalid auth (regression).
- **Unit test**: `verifyCIAuth` correctly accepts valid auth and rejects invalid auth (regression).
- **Unit test**: `verifyPassword` correctly accepts valid passwords and rejects invalid ones (regression).

## Dependencies

- No blocking dependencies on other stories.
- The async change to `timingSafeEqual` affects `verifyServerAuth()` and `verifyCIAuth()` which are called from the `fetch()` handler. All auth checks in the handler already use `await` for other async operations, so integrating `await` for auth checks is straightforward.
- If the synchronous alternative is chosen instead of HMAC, no caller changes are needed.
