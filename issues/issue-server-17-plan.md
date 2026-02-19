# Plan: Build token timestamp allows 1-year window enabling replay attacks

**Issue**: issue-server-17.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/attestation-registry-do.js`:
- Lines 187-195: The build token timestamp validation uses a 1-year window:
  ```js
  const tokenAge = Date.now() - timestamp;
  if (tokenAge > 365 * 24 * 60 * 60 * 1000) {
    return this.jsonResponse({ error: 'Build token expired' }, 403, corsHeaders);
  }
  ```

Two problems:
1. **Excessively long validity window**: A compromised build token is usable for an entire year.
2. **No future-date check**: `tokenAge` can be negative (if `timestamp > Date.now()`), and the check `tokenAge > 365 * 24 * 60 * 60 * 1000` will pass for negative values, meaning a token with a far-future timestamp is valid indefinitely.

## Fix Steps

1. **Reduce the validity window to 30 days** (line 189):
   ```js
   const MAX_TOKEN_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
   ```

2. **Add a future-date clock skew tolerance** (1 minute):
   ```js
   const MAX_CLOCK_SKEW = 60 * 1000; // 1 minute tolerance for clock drift
   ```

3. **Replace the timestamp validation block** (lines 187-195):
   ```js
   // Check build token timestamp
   const tokenAge = Date.now() - timestamp;
   if (tokenAge < -MAX_CLOCK_SKEW) {
     return this.jsonResponse(
       { error: 'Build token has a future timestamp' },
       403,
       corsHeaders
     );
   }
   if (tokenAge > MAX_TOKEN_AGE) {
     return this.jsonResponse(
       { error: 'Build token expired' },
       403,
       corsHeaders
     );
   }
   ```

4. **Define constants at the top of the file** (near the existing constants at lines 29-36):
   ```js
   /** Maximum age for build tokens: 30 days */
   const MAX_TOKEN_AGE = 30 * 24 * 60 * 60 * 1000;

   /** Maximum clock skew tolerance: 1 minute */
   const MAX_CLOCK_SKEW = 60 * 1000;
   ```

## Testing

- Verify that a build token with a current timestamp is accepted.
- Verify that a build token older than 30 days is rejected with "Build token expired".
- Verify that a build token with a timestamp 2 minutes in the future is rejected with "Build token has a future timestamp".
- Verify that a build token with a timestamp 30 seconds in the future is accepted (within clock skew tolerance).
- Verify that a build token exactly 30 days old is rejected (boundary case).
- Run existing attestation registration tests.

## Risk Assessment

- **Breaking change for old tokens**: Any devices that were registered with build tokens older than 30 days will fail to re-register. This is intentional -- old tokens should be rotated.
- **Clock synchronization**: The 1-minute clock skew tolerance assumes servers and CI systems have reasonably synchronized clocks (NTP). In practice, Cloudflare Workers use accurate UTC time.
- **CI pipeline impact**: The CI pipeline that generates build tokens must be configured to run within 30 days of the build being deployed. This is standard practice.
