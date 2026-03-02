# Plan: No input size limits on HTTP request bodies

**Issue**: issue-server-12.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/server-registry-do.js`
- `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

All HTTP endpoints that parse JSON bodies call `await request.json()` without checking body size first:

**server-registry-do.js:**
- `registerServer()` line 63: `const body = await request.json()`
- `heartbeat()` line 123: `const body = await request.json()`

**attestation-registry-do.js:**
- `handleRegister()` line 108: `const body = await request.json()`
- `handleUploadReference()` line 258: `const body = await request.json()`
- `handleChallenge()` line 312: `const body = await request.json()`
- `handleVerify()` line 389: `const body = await request.json()`
- `handleSetVersions()` line 556: `const body = await request.json()`

While Cloudflare Workers has a default 100MB body size limit, parsing a large JSON body within the 128MB isolate memory limit can cause OOM crashes.

## Fix Steps

1. **Create a `packages/server/src/utils/request-validation.js` utility**:
   ```js
   const DEFAULT_MAX_BODY_SIZE = 65536; // 64KB

   export async function parseJsonBody(request, maxSize = DEFAULT_MAX_BODY_SIZE) {
     const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
     if (contentLength > maxSize) {
       throw new BodyTooLargeError(`Request body too large: ${contentLength} bytes exceeds ${maxSize} byte limit`);
     }

     // Also check actual body size (Content-Length can be spoofed or missing)
     const bodyText = await request.text();
     if (bodyText.length > maxSize) {
       throw new BodyTooLargeError(`Request body too large: ${bodyText.length} bytes exceeds ${maxSize} byte limit`);
     }

     return JSON.parse(bodyText);
   }

   export class BodyTooLargeError extends Error {
     constructor(message) {
       super(message);
       this.name = 'BodyTooLargeError';
     }
   }
   ```

2. **Update `server-registry-do.js`** -- replace all `await request.json()` calls:
   - `registerServer()` (line 63): Replace with `await parseJsonBody(request, 4096)` (4KB is generous for server registration).
   - `heartbeat()` (line 123): Replace with `await parseJsonBody(request, 1024)` (1KB for heartbeat).
   - Update the catch block (lines 54-58) to handle `BodyTooLargeError` and return 413.

3. **Update `attestation-registry-do.js`** -- replace all `await request.json()` calls:
   - `handleRegister()` (line 108): Replace with `await parseJsonBody(request, 8192)` (8KB for build token + device info).
   - `handleUploadReference()` (line 258): Replace with `await parseJsonBody(request, 65536)` (64KB for reference metadata with critical regions).
   - `handleChallenge()` (line 312): Replace with `await parseJsonBody(request, 2048)` (2KB for challenge request).
   - `handleVerify()` (line 389): Replace with `await parseJsonBody(request, 16384)` (16KB for verification with HMAC responses).
   - `handleSetVersions()` (line 556): Replace with `await parseJsonBody(request, 4096)` (4KB for version policy).
   - Update the catch block (lines 93-98) to handle `BodyTooLargeError` and return 413.

4. **Add 413 response handling in catch blocks**:
   ```js
   } catch (error) {
     if (error instanceof BodyTooLargeError) {
       return new Response(
         JSON.stringify({ error: 'Request body too large' }),
         { status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
       );
     }
     // ... existing error handling
   }
   ```

## Testing

- Verify that normal-sized request bodies are parsed correctly.
- Verify that oversized request bodies return 413.
- Verify that requests with missing Content-Length header are still handled (fall through to body text length check).
- Verify that malformed JSON still returns appropriate error (400 or 500).
- Run existing API tests.

## Risk Assessment

- **Body size limits must be generous enough**: The limits chosen above are based on expected payload sizes. If any legitimate payload exceeds these limits, requests will fail. Review actual payload sizes in production logs before setting final values.
- **Double-read issue**: Calling `request.text()` then `JSON.parse()` instead of `request.json()` reads the body as text first. This is necessary to check the actual body size but means the body is read twice in memory (text + parsed object). For the size limits we are enforcing (max 64KB), this is negligible.
- **Content-Length spoofing**: A malicious client can omit or lie about Content-Length. The fallback to checking `bodyText.length` handles this case.
