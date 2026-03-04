# Story 004: SERVER_REGISTRY_SECRET Auth Bypass When Unset

## Priority: IMMEDIATE
## Severity: CRITICAL
## Component: packages/server (CF Workers)

## Summary

The `ServerRegistryDO` authentication check pattern `if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request))` skips authentication entirely when the `SERVER_REGISTRY_SECRET` environment variable is not configured. This means that in any deployment where the secret has not been explicitly set, all protected endpoints -- server registration, server deletion, heartbeat, and anomaly viewing -- are fully accessible without any authentication. An attacker can register rogue servers, delete legitimate servers, send fake heartbeats, and view anomaly data.

## Current Behavior

In `packages/server/src/durable-objects/server-registry-do.js`, the `fetch()` method contains four identical auth check patterns that all fail open:

**Line 376** -- `POST /servers` (Register a server):
```javascript
if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
  return new Response(
    JSON.stringify({ error: 'Unauthorized' }),
    { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

**Line 392** -- `DELETE /servers/:serverId` (Unregister a server):
```javascript
if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
```

**Line 418** -- `POST /servers/heartbeat` (Update server timestamp):
```javascript
if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
```

**Line 429** -- `GET /servers/anomalies` (View anomaly scores):
```javascript
if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
```

In all four cases, when `this.env.SERVER_REGISTRY_SECRET` is `undefined` (not set in the Cloudflare Workers environment), the entire `if` block short-circuits to `false` due to JavaScript's falsy evaluation of `undefined`. The auth check is never performed, and the request proceeds to the handler as if authenticated.

The `verifyServerAuth()` method on line 346-351 is correctly implemented:
```javascript
verifyServerAuth(request) {
  const authHeader = request.headers.get('Authorization');
  if (!this.env.SERVER_REGISTRY_SECRET) return false;
  if (!authHeader) return false;
  return timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
}
```

Note that `verifyServerAuth()` itself returns `false` when the secret is not set (line 348), which is the correct deny-by-default behavior. But the callers never reach this method when the secret is unset because the outer `if` guard short-circuits first.

Additionally, the `DELETE /servers/:serverId` endpoint has a secondary auth path (lines 677-691) for when `SERVER_REGISTRY_SECRET` is not set. It attempts to verify ownership via the server's `publicKey`, but this is only checked if an `Authorization` header is provided. If no header is sent, the delete proceeds without any auth:

```javascript
if (!this.env.SERVER_REGISTRY_SECRET) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const providedKey = authHeader.substring(7);
    if (providedKey !== server.publicKey) {
      return new Response(
        JSON.stringify({ error: 'Not authorized to delete this server' }),
        { status: 403, ... }
      );
    }
  }
  // No auth header? Falls through -- delete proceeds!
}
```

## Expected Behavior

When `SERVER_REGISTRY_SECRET` is not configured, all protected endpoints should **deny access** with a 503 (Service Unavailable) or 401 (Unauthorized) response. The server registry should not be operable without authentication configured. This follows the principle of "secure by default" -- missing configuration should result in a locked-down system, not an open one.

## Root Cause Analysis

The auth check pattern was likely written with the intent: "if a secret is configured, enforce it; if not, allow open access for development/testing." This is a common but dangerous pattern that creates a fail-open security posture.

The problem manifests in multiple ways:

1. **New deployments**: A fresh CF Workers deployment will not have `SERVER_REGISTRY_SECRET` set until an operator explicitly configures it via `wrangler secret put`. The window between deployment and secret configuration is fully vulnerable.

2. **Secret rotation failures**: If `wrangler secret delete SERVER_REGISTRY_SECRET` is accidentally run (e.g., during debugging), all endpoints immediately become unauthenticated.

3. **Environment mismatches**: If the secret is configured in production but not in staging, staging becomes an open target that may be used to test attacks against the production API.

4. **The `verifyServerAuth()` method is correct but dead code**: The method properly returns `false` when no secret is configured (deny-by-default), but this behavior is negated by the callers that check `this.env.SERVER_REGISTRY_SECRET` as a guard before even calling the method.

The full list of protected endpoints and their vulnerability:

| Method | Path | Purpose | Unauthed Impact |
|--------|------|---------|-----------------|
| POST | `/servers` | Register server | Rogue server injection |
| DELETE | `/servers/:id` | Unregister server | Legitimate server removal |
| POST | `/servers/heartbeat` | Server heartbeat | Fake metrics, anomaly manipulation |
| GET | `/servers/anomalies` | View anomaly data | Information disclosure |

Note that `GET /servers` (list servers) and the trusted-keys endpoints are NOT affected -- `GET /servers` is intentionally public, and the trusted-keys endpoints use `CI_UPLOAD_SECRET` with a different (correct) auth pattern that returns 503 when unconfigured (lines 898-903).

## Affected Code

| File | Lines | Endpoint | Description |
|------|-------|----------|-------------|
| `packages/server/src/durable-objects/server-registry-do.js` | 376 | `POST /servers` | Auth bypass on register |
| `packages/server/src/durable-objects/server-registry-do.js` | 392 | `DELETE /servers/:id` | Auth bypass on unregister |
| `packages/server/src/durable-objects/server-registry-do.js` | 418 | `POST /servers/heartbeat` | Auth bypass on heartbeat |
| `packages/server/src/durable-objects/server-registry-do.js` | 429 | `GET /servers/anomalies` | Auth bypass on anomaly view |
| `packages/server/src/durable-objects/server-registry-do.js` | 346-351 | `verifyServerAuth()` | Correct implementation, but bypassed by callers |
| `packages/server/src/durable-objects/server-registry-do.js` | 677-691 | `unregisterServer()` | Secondary auth check also fails open |

## Reproduction Steps

1. Deploy the CF Workers server WITHOUT setting the `SERVER_REGISTRY_SECRET` environment variable.
2. Send `POST /servers` with a valid body (serverId, endpoint, publicKey). No `Authorization` header needed.
3. Observe a 200 response -- the server is registered without authentication.
4. Send `GET /servers` and confirm the rogue server appears in the list.
5. Send `DELETE /servers/{legitimate-server-id}` without any `Authorization` header.
6. Observe a 200 response -- the legitimate server is deleted.
7. Send `POST /servers/heartbeat` with `{ serverId: "rogue" }` -- succeeds without auth.
8. Send `GET /servers/anomalies` -- returns full anomaly data without auth.

## Impact Assessment

- **Rogue server injection**: An attacker can register arbitrary servers in the federation registry. These servers will be returned to clients via `GET /servers` and may be used for signaling. Clients connecting to rogue servers can be subject to MitM attacks on the signaling layer.
- **Legitimate server removal**: An attacker can delete any server entry by ID, disrupting the federation mesh and causing clients to lose access to signaling services.
- **Heartbeat manipulation**: Fake heartbeats can manipulate connection metrics and anomaly scores, potentially causing legitimate servers to be flagged/quarantined (false positives) or keeping rogue servers healthy (false negatives).
- **Information disclosure**: The `/servers/anomalies` endpoint exposes internal anomaly scores, server endpoints, regions, and build verification status for all registered servers.
- **Combined with Story 002**: If trusted keys are also unconfigured (Story 002), an attacker can register a rogue server that appears both authenticated AND build-verified, achieving maximum trust with zero credentials.

## Proposed Fix

Replace the fail-open pattern with a fail-closed pattern. When `SERVER_REGISTRY_SECRET` is not configured, return 503 (Service Unavailable) to indicate the service is not properly configured:

```javascript
// In fetch(), replace all four auth check blocks with:

// Helper method
requireServerAuth(request, corsHeaders) {
  if (!this.env.SERVER_REGISTRY_SECRET) {
    return new Response(
      JSON.stringify({ error: 'Server authentication not configured' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
  if (!this.verifyServerAuth(request)) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
  return null; // Auth passed
}

// Usage in fetch():
if (request.method === 'POST' && url.pathname === '/servers') {
  const authError = this.requireServerAuth(request, corsHeaders);
  if (authError) return authError;
  return await this.registerServer(request, corsHeaders);
}
```

Also fix the secondary auth check in `unregisterServer()` (lines 677-691) to deny when no auth header is provided:

```javascript
if (!this.env.SERVER_REGISTRY_SECRET) {
  // SERVER_REGISTRY_SECRET not configured -- should be blocked by fetch() guard
  // But as defense-in-depth, reject the request
  return new Response(
    JSON.stringify({ error: 'Server authentication not configured' }),
    { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

For local development, provide an explicit `DEV_MODE=true` flag (already used on line 495 for endpoint validation) that can optionally relax auth in non-production environments.

## Acceptance Criteria

- [ ] When `SERVER_REGISTRY_SECRET` is not set, `POST /servers` returns 503.
- [ ] When `SERVER_REGISTRY_SECRET` is not set, `DELETE /servers/:id` returns 503.
- [ ] When `SERVER_REGISTRY_SECRET` is not set, `POST /servers/heartbeat` returns 503.
- [ ] When `SERVER_REGISTRY_SECRET` is not set, `GET /servers/anomalies` returns 503.
- [ ] When `SERVER_REGISTRY_SECRET` is set and the correct Bearer token is provided, all endpoints work normally.
- [ ] When `SERVER_REGISTRY_SECRET` is set and no/wrong token is provided, all endpoints return 401.
- [ ] The secondary auth path in `unregisterServer()` is also fixed to deny-by-default.
- [ ] `GET /servers` (public listing) remains unauthenticated (intentionally public).
- [ ] An audit log entry is emitted when a request is rejected due to unconfigured auth.
- [ ] A `DEV_MODE` escape hatch exists for local development (optional, clearly documented as insecure).

## Test Requirements

- **Unit test**: For each of the 4 protected endpoints, verify that a request WITHOUT `SERVER_REGISTRY_SECRET` configured returns 503.
- **Unit test**: For each of the 4 protected endpoints, verify that a request WITH `SERVER_REGISTRY_SECRET` configured but without an `Authorization` header returns 401.
- **Unit test**: For each of the 4 protected endpoints, verify that a request WITH correct auth succeeds (200).
- **Unit test**: Verify that `GET /servers` (public) still works without auth regardless of `SERVER_REGISTRY_SECRET` configuration.
- **Unit test**: Verify the `unregisterServer()` secondary auth path rejects requests when `SERVER_REGISTRY_SECRET` is not configured.
- **Integration test**: Deploy without `SERVER_REGISTRY_SECRET` and confirm all protected endpoints are inaccessible.

## Dependencies

- This fix should be deployed in coordination with Story 002 (trusted keys deny-default), as both address fail-open security patterns in the same file.
- VPS servers that currently register without auth (because their CF Workers deployment lacks `SERVER_REGISTRY_SECRET`) will need the secret configured before this fix is deployed, or they will lose the ability to register.
