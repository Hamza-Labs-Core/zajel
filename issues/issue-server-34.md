# [LOW] Missing security headers on all HTTP responses

**Area**: Server
**File**: packages/server/src/index.js (all responses)
**Type**: Best Practice

**Description**: HTTP responses do not include standard security headers:
- `X-Content-Type-Options: nosniff` -- prevents MIME type sniffing
- `X-Frame-Options: DENY` -- prevents clickjacking
- `Strict-Transport-Security` -- enforces HTTPS
- `Content-Security-Policy` -- prevents XSS
- `Cache-Control: no-store` -- prevents caching of sensitive responses

While this is an API server (not serving HTML), security headers are still recommended as defense-in-depth.

**Impact**: Without `X-Content-Type-Options: nosniff`, browsers might interpret JSON responses as HTML if the content type header is missing or wrong. Without cache headers, intermediate proxies might cache sensitive responses. These are low-risk for a pure API, but represent missing defense-in-depth.

**Fix**: Add security headers to the CORS headers object:
```js
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
const corsHeaders = { ...securityHeaders, 'Access-Control-Allow-Origin': ... };
```
