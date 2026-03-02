# Plan: Timing-based secret comparison enables auth token brute-forcing

**Issue**: issue-server-11.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/attestation-registry-do.js`
- `packages/server/src/durable-objects/server-registry-do.js` (if auth is added per issue-server-2)

## Analysis

In `packages/server/src/durable-objects/attestation-registry-do.js`:

- **Line 250**: `handleUploadReference()` compares the `CI_UPLOAD_SECRET`:
  ```js
  if (!authHeader || authHeader !== `Bearer ${this.env.CI_UPLOAD_SECRET}`) {
  ```
  JavaScript's `!==` operator short-circuits on the first differing character, leaking timing information.

- **Line 548**: `handleSetVersions()` uses the same pattern:
  ```js
  if (!authHeader || authHeader !== `Bearer ${this.env.CI_UPLOAD_SECRET}`) {
  ```

Both comparisons use standard string inequality, which is not constant-time.

## Fix Steps

1. **Create a `packages/server/src/crypto/timing-safe.js` utility module**:
   ```js
   /**
    * Constant-time string comparison using Web Crypto API.
    * Prevents timing side-channel attacks on secret comparisons.
    * @param {string} a - First string
    * @param {string} b - Second string
    * @returns {Promise<boolean>} Whether the strings are equal
    */
   export async function timingSafeEqual(a, b) {
     const encoder = new TextEncoder();
     const bufA = encoder.encode(a);
     const bufB = encoder.encode(b);

     if (bufA.byteLength !== bufB.byteLength) {
       // Still do a comparison to avoid leaking length info through timing
       const dummy = encoder.encode(a.padEnd(b.length, '\0'));
       try { crypto.subtle.timingSafeEqual(dummy, bufB); } catch(e) {}
       return false;
     }

     return crypto.subtle.timingSafeEqual(bufA, bufB);
   }
   ```

   Note: `crypto.subtle.timingSafeEqual` is available in Cloudflare Workers. If not available, fall back to a manual XOR-based comparison:
   ```js
   export function timingSafeEqualSync(a, b) {
     const encoder = new TextEncoder();
     const bufA = encoder.encode(a);
     const bufB = encoder.encode(b);

     if (bufA.byteLength !== bufB.byteLength) return false;

     let result = 0;
     for (let i = 0; i < bufA.byteLength; i++) {
       result |= bufA[i] ^ bufB[i];
     }
     return result === 0;
   }
   ```

2. **Update `handleUploadReference()` (line 250)**:
   ```js
   const expected = `Bearer ${this.env.CI_UPLOAD_SECRET}`;
   if (!authHeader || !(await timingSafeEqual(authHeader, expected))) {
     return this.jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
   }
   ```

3. **Update `handleSetVersions()` (line 548)**:
   ```js
   const expected = `Bearer ${this.env.CI_UPLOAD_SECRET}`;
   if (!authHeader || !(await timingSafeEqual(authHeader, expected))) {
     return this.jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
   }
   ```

4. **If auth is added to `server-registry-do.js`** (per issue-server-2), use the same `timingSafeEqual` function for any secret comparisons there.

## Testing

- Verify that valid secrets are still accepted.
- Verify that invalid secrets are still rejected.
- Verify the function handles different-length strings correctly (returns false without leaking length).
- Benchmark to confirm the comparison time is consistent regardless of input.

## Risk Assessment

- **Very low risk**: This is a drop-in replacement for the comparison logic. The behavior is identical (returns true/false), only the timing characteristics change.
- **Async vs sync**: If `crypto.subtle.timingSafeEqual` is not available in all Cloudflare Workers runtimes, use the sync XOR fallback. Test in the actual runtime.
- **Performance**: Constant-time comparison is marginally slower than short-circuit comparison, but this is negligible for auth checks.
