# Plan: Server registration and deletion have no authentication

**Issue**: issue-server-2.md
**Severity**: CRITICAL
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/server-registry-do.js`
- `packages/server/src/index.js`

## Analysis

In `packages/server/src/durable-objects/server-registry-do.js`:
- `registerServer()` (line 62): Parses request body and stores directly, no auth check.
- `unregisterServer()` (line 113): Deletes `server:{serverId}` from storage with no ownership or auth verification.
- `heartbeat()` (line 122): Updates `lastSeen` timestamp for any `serverId` with no auth.
- `listServers()` (line 90): Read-only, acceptable without auth.

The `serverId` is entirely client-supplied (line 64: `const { serverId, endpoint, publicKey, region } = body`), so anyone can register, delete, or heartbeat for any server identity.

In `packages/server/src/index.js`, the routes at lines 117-122 pass requests directly to the DO with no middleware auth checks.

## Fix Steps

1. **Add a `SERVER_REGISTRY_SECRET` environment variable** for server-to-bootstrap authentication. Add it to `wrangler.toml` (secrets section).

2. **Create an auth check helper in `server-registry-do.js`**:
   ```js
   verifyServerAuth(request) {
     const authHeader = request.headers.get('Authorization');
     if (!this.env.SERVER_REGISTRY_SECRET) return false;
     if (!authHeader || authHeader !== `Bearer ${this.env.SERVER_REGISTRY_SECRET}`) return false;
     return true;
   }
   ```
   Note: Use constant-time comparison (see issue-server-11) once that fix is also applied.

3. **Guard `registerServer()` (line 62)**: Add auth verification before `request.json()`. Return 401 if unauthorized.

4. **Guard `unregisterServer()` (line 113)**: Add auth verification. Return 401 if unauthorized.

5. **Guard `heartbeat()` (line 122)**: Add auth verification. Return 401 if unauthorized.

6. **Leave `listServers()` as public** (or optionally require auth), since the main Worker already signs the response with `BOOTSTRAP_SIGNING_KEY` (index.js lines 104-112) for tamper-proof server lists.

7. **Update VPS server code** (headless package) to include `Authorization: Bearer <SERVER_REGISTRY_SECRET>` when calling these endpoints.

8. **Validate `serverId` format** (line 64): Add length (max 64 chars) and character set (`/^[\w-]+$/`) validation to prevent storage abuse via malformed IDs.

## Testing

- Verify unauthenticated `POST /servers` returns 401.
- Verify unauthenticated `DELETE /servers/:id` returns 401.
- Verify unauthenticated `POST /servers/heartbeat` returns 401.
- Verify authenticated requests succeed with the correct secret.
- Verify `GET /servers` still works without authentication.
- Run E2E tests with the headless VPS server using the new auth configuration.

## Risk Assessment

- **Requires coordinated deployment**: The VPS server (headless package) must be updated to send the auth header before this change is deployed, or server registration will break.
- **Secret management**: The `SERVER_REGISTRY_SECRET` must be securely stored in Cloudflare Workers secrets and distributed to all VPS servers.
- **Rollback plan**: If VPS servers are not yet updated, temporarily allow unauthenticated access as a fallback (with a deprecation warning in logs).
