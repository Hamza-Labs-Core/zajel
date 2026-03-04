# [MEDIUM] CORS headers missing from proxied Durable Object responses

**Area**: Server
**File**: packages/server/src/index.js:118-129
**Type**: Bug

**Description**: The main Worker's `fetch` handler defines `corsHeaders` and applies them to the `/health`, `/`, and `GET /servers` responses. However, when requests are forwarded to Durable Objects on lines 118-129:
```js
if (url.pathname.startsWith('/servers')) {
  const id = env.SERVER_REGISTRY.idFromName('global');
  const stub = env.SERVER_REGISTRY.get(id);
  return stub.fetch(request);  // Response returned directly without CORS headers
}
if (url.pathname.startsWith('/attest')) {
  const id = env.ATTESTATION_REGISTRY.idFromName('global');
  const stub = env.ATTESTATION_REGISTRY.get(id);
  return stub.fetch(request);  // Response returned directly without CORS headers
}
```
The Durable Objects define their own CORS headers, but the `ServerRegistryDO` CORS headers do not include `Authorization` in `Access-Control-Allow-Headers`, while the main Worker does. This inconsistency means that CORS preflight for authenticated requests to `/servers` endpoints will fail because the DO's CORS response does not allow the `Authorization` header.

**Impact**: Browser-based clients cannot make authenticated requests to server registry endpoints due to CORS preflight failures. While this may currently be masked if clients are native apps, it will break if a web client is added.

**Fix**: Either:
1. Add CORS headers in the main Worker before returning DO responses:
```js
const doResponse = await stub.fetch(request);
const response = new Response(doResponse.body, doResponse);
Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v));
return response;
```
2. Or ensure DO CORS headers match the main Worker's CORS headers exactly.
