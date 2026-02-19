# Plan: Missing security headers on all HTTP responses

**Issue**: issue-server-34.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/index.js`, `packages/server/src/durable-objects/server-registry-do.js`, `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

HTTP responses across the server do not include standard security headers. There are three places where CORS headers are constructed:

1. **`packages/server/src/index.js` lines 28-33**: The main Worker's `corsHeaders` object:
```js
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Bootstrap-Signature, X-Attestation-Token',
};
```

2. **`packages/server/src/durable-objects/server-registry-do.js` lines 21-25**: The ServerRegistryDO's `corsHeaders`.

3. **`packages/server/src/durable-objects/attestation-registry-do.js` lines 47-52**: The AttestationRegistryDO's `corsHeaders`.

None of these include security headers like `X-Content-Type-Options`, `X-Frame-Options`, `Cache-Control`, or `Strict-Transport-Security`.

## Fix Steps

1. **Create a shared security headers constant** or add security headers to each CORS headers object. Since the three files are independent modules, the simplest approach is to add the headers to each location.

2. **In `packages/server/src/index.js`** (lines 28-33), modify the `corsHeaders` object:

```js
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Bootstrap-Signature, X-Attestation-Token',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
```

3. **In `packages/server/src/durable-objects/server-registry-do.js`** (lines 21-25), add the same security headers:

```js
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
```

4. **In `packages/server/src/durable-objects/attestation-registry-do.js`** (lines 47-52), add the same security headers:

```js
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Attestation-Token',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
```

Note: `Content-Security-Policy` is omitted because this is a pure JSON API server, not an HTML-serving application. Adding CSP to an API that never serves HTML provides negligible benefit.

## Testing

- Verify that all HTTP responses include the four new security headers.
- Test CORS preflight (OPTIONS) requests still work correctly with the additional headers.
- Verify that `X-Content-Type-Options: nosniff` prevents browsers from MIME-sniffing responses.
- Verify that `Cache-Control: no-store` prevents proxy caching of responses.

## Risk Assessment

- **Very low risk**: Adding response headers does not affect the response body or status codes.
- **CORS note**: The security headers are added to the same object as CORS headers, so they appear on all responses including CORS preflight. This is correct -- security headers should be on all responses.
- **HSTS consideration**: `Strict-Transport-Security` with `max-age=31536000` (1 year) tells browsers to always use HTTPS. Since the server is behind Cloudflare (which enforces HTTPS), this is safe. However, if the server is ever accessed over plain HTTP during development, HSTS could cause issues. The `dev` configuration in `wrangler.jsonc` uses `local_protocol: "http"`, but HSTS only applies to browser requests, not API clients.
