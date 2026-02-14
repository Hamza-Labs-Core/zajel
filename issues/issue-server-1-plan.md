# Plan: Wildcard CORS allows any origin to access all API endpoints

**Issue**: issue-server-1.md
**Severity**: CRITICAL
**Area**: Server
**Files to modify**:
- `packages/server/src/index.js`
- `packages/server/src/durable-objects/server-registry-do.js`
- `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

The current code at `packages/server/src/index.js:29` sets:
```js
'Access-Control-Allow-Origin': '*',
```

This wildcard CORS origin is present in three places:
1. **index.js line 29**: The main Worker's `corsHeaders` object, used for `/health`, `/`, `GET /servers`, `OPTIONS`, and `404` responses.
2. **server-registry-do.js line 22**: The `ServerRegistryDO.fetch()` method defines its own `corsHeaders` with `'Access-Control-Allow-Origin': '*'`.
3. **attestation-registry-do.js line 48**: The `AttestationRegistryDO.fetch()` method defines its own `corsHeaders` with `'Access-Control-Allow-Origin': '*'`.

Combined with `'Access-Control-Allow-Headers': 'Content-Type, Authorization'` (lines 31, 50 in attestation-registry-do.js), this allows any website to make credentialed cross-origin requests including Bearer token auth to admin endpoints like `POST /attest/upload-reference` and `POST /attest/versions`.

## Fix Steps

1. **Create a shared CORS utility module** at `packages/server/src/cors.js`:
   - Define an `ALLOWED_ORIGINS` array, sourced from an environment variable `ALLOWED_ORIGINS` (comma-separated) with a sensible default (e.g., `['https://zajel.hamzalabs.dev']`).
   - Export a `getCorsHeaders(request, env)` function that reads the `Origin` header, checks it against the allowlist, and returns CORS headers with the matched origin or no `Access-Control-Allow-Origin` if not matched.
   - Include `Access-Control-Allow-Headers: 'Content-Type, Authorization'` consistently.

2. **Update `packages/server/src/index.js`**:
   - Import `getCorsHeaders` from `./cors.js`.
   - Replace the hardcoded `corsHeaders` object (lines 28-33) with a call to `getCorsHeaders(request, env)`.
   - Pass `env` through to the function so it can read `env.ALLOWED_ORIGINS`.

3. **Update `packages/server/src/durable-objects/server-registry-do.js`**:
   - Import `getCorsHeaders` from `../cors.js`.
   - Replace the hardcoded `corsHeaders` (lines 21-25) with `getCorsHeaders(request, this.env)`.
   - This also fixes issue-server-16 partially: the DO's CORS headers currently lack `Authorization` in `Access-Control-Allow-Headers`.

4. **Update `packages/server/src/durable-objects/attestation-registry-do.js`**:
   - Import `getCorsHeaders` from `../cors.js`.
   - Replace the hardcoded `corsHeaders` (lines 47-52) with `getCorsHeaders(request, this.env)`.

5. **Add `ALLOWED_ORIGINS` to `wrangler.toml`** (or `.dev.vars`):
   - For production: `ALLOWED_ORIGINS = "https://zajel.hamzalabs.dev,https://signal.zajel.hamzalabs.dev"`
   - For development: consider allowing `http://localhost:*` patterns.

## Testing

- Verify that requests from allowed origins receive correct `Access-Control-Allow-Origin` header matching the request origin.
- Verify that requests from disallowed origins do NOT receive `Access-Control-Allow-Origin: *`.
- Verify CORS preflight (OPTIONS) still works correctly for allowed origins.
- Test that `Authorization` header is consistently listed in `Access-Control-Allow-Headers` across all endpoints.
- Run existing unit/integration tests to ensure no regressions.

## Risk Assessment

- **Breaking change for legitimate clients**: If there are existing browser-based clients making cross-origin requests from origins not in the allowlist, they will break. Audit current client origins before deploying.
- **Native app clients**: Native apps (Flutter) do not use CORS, so they are unaffected.
- **Development workflow**: Ensure `localhost` origins are allowed in development configuration.
