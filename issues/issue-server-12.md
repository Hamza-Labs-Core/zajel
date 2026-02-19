# [HIGH] No input size limits on HTTP request bodies

**Area**: Server
**File**: packages/server/src/durable-objects/server-registry-do.js:63, packages/server/src/durable-objects/attestation-registry-do.js:108
**Type**: Security

**Description**: All HTTP endpoints that parse JSON bodies call `await request.json()` without first checking `Content-Length` or limiting the body size. This applies to:
- `POST /servers` (server-registry-do.js:63)
- `POST /servers/heartbeat` (server-registry-do.js:123)
- `POST /attest/register` (attestation-registry-do.js:108)
- `POST /attest/upload-reference` (attestation-registry-do.js:258)
- `POST /attest/challenge` (attestation-registry-do.js:312)
- `POST /attest/verify` (attestation-registry-do.js:389)
- `POST /attest/versions` (attestation-registry-do.js:556)

While Cloudflare Workers has a default 100MB body size limit, parsing a large JSON body consumes significant CPU and memory within the 128MB isolate memory limit.

**Impact**: An attacker can send requests with very large JSON bodies (e.g., 50MB), consuming CPU time and memory in the Durable Object during JSON parsing, potentially causing the isolate to exceed its memory limit and crash.

**Fix**: Check `Content-Length` before parsing and reject oversized bodies:
```js
const contentLength = parseInt(request.headers.get('Content-Length') || '0');
if (contentLength > 65536) { // 64KB max
  return new Response(JSON.stringify({ error: 'Request body too large' }), { status: 413 });
}
```
