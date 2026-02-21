# Plan: CORS headers missing from proxied Durable Object responses

**Issue**: issue-server-16.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**:
- `packages/server/src/index.js`
- `packages/server/src/durable-objects/server-registry-do.js`

## Analysis

In `packages/server/src/index.js`:
- Lines 117-122: Requests to `/servers` (non-GET) are forwarded to the `ServerRegistryDO` and the response is returned directly:
  ```js
  if (url.pathname.startsWith('/servers')) {
    const id = env.SERVER_REGISTRY.idFromName('global');
    const stub = env.SERVER_REGISTRY.get(id);
    return stub.fetch(request);  // No CORS header injection
  }
  ```
- Lines 124-129: Requests to `/attest` are forwarded to `AttestationRegistryDO` similarly.

In `packages/server/src/durable-objects/server-registry-do.js`:
- Lines 21-25: The DO's own CORS headers do NOT include `Authorization` in `Access-Control-Allow-Headers`:
  ```js
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',  // Missing 'Authorization'
  };
  ```

- The main Worker's CORS headers (index.js line 31) include `Authorization`:
  ```js
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  ```

This inconsistency means CORS preflight for authenticated requests to `/servers` endpoints fails because the DO's preflight response does not allow the `Authorization` header.

In `packages/server/src/durable-objects/attestation-registry-do.js`:
- Lines 47-52: The DO's CORS headers DO include `Authorization`:
  ```js
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  ```
  So attestation endpoints are consistent, but still return their own `*` origin.

## Fix Steps

1. **Fix the `ServerRegistryDO` CORS headers** (server-registry-do.js line 24):
   ```js
   const corsHeaders = {
     'Access-Control-Allow-Origin': '*',
     'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
     'Access-Control-Allow-Headers': 'Content-Type, Authorization',
   };
   ```

2. **Ensure consistent CORS across all response paths in `index.js`** (lines 117-129):
   Add CORS headers to proxied DO responses:
   ```js
   if (url.pathname.startsWith('/servers')) {
     const id = env.SERVER_REGISTRY.idFromName('global');
     const stub = env.SERVER_REGISTRY.get(id);
     const doResponse = await stub.fetch(request);
     const response = new Response(doResponse.body, doResponse);
     for (const [key, value] of Object.entries(corsHeaders)) {
       response.headers.set(key, value);
     }
     return response;
   }

   if (url.pathname.startsWith('/attest')) {
     const id = env.ATTESTATION_REGISTRY.idFromName('global');
     const stub = env.ATTESTATION_REGISTRY.get(id);
     const doResponse = await stub.fetch(request);
     const response = new Response(doResponse.body, doResponse);
     for (const [key, value] of Object.entries(corsHeaders)) {
       response.headers.set(key, value);
     }
     return response;
   }
   ```

3. **Note**: If issue-server-1 (CORS origin allowlist) is implemented first, this fix should use the same `getCorsHeaders()` function to ensure consistency. The main Worker's CORS configuration becomes the single source of truth, overriding any DO-level CORS headers.

## Testing

- Make a CORS preflight request (OPTIONS) to a `/servers` endpoint with `Access-Control-Request-Headers: Authorization` and verify the response includes `Authorization` in `Access-Control-Allow-Headers`.
- Verify that non-preflight requests to `/servers` and `/attest` endpoints include correct CORS headers.
- Verify that `Access-Control-Expose-Headers` includes `X-Bootstrap-Signature` and `X-Attestation-Token` consistently.

## Risk Assessment

- **Low risk**: Adding missing CORS headers is additive and does not break existing functionality.
- **Interaction with issue-server-1**: This fix should be coordinated with the CORS origin allowlist fix. If implemented in isolation, it still uses `*` as the origin, which is the current behavior.
- **Response cloning**: Creating a new `Response` from the DO response copies the body and headers. Ensure the DO response body is not consumed before cloning. The `new Response(doResponse.body, doResponse)` pattern handles this correctly.
