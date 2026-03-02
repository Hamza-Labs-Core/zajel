# [MEDIUM] DELETE /servers/:serverId allows unauthenticated deletion of any server

**Area**: Server
**File**: packages/server/src/durable-objects/server-registry-do.js:113-119
**Type**: Security

**Description**: The `DELETE /servers/:serverId` endpoint requires no authentication and does not verify ownership:
```js
async unregisterServer(serverId, corsHeaders) {
  await this.state.storage.delete(`server:${serverId}`);
  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```
Any client can delete any server by guessing or enumerating server IDs. Server IDs can be discovered via `GET /servers` which lists all registered servers with their IDs.

**Impact**: An attacker can:
1. Call `GET /servers` to discover all server IDs.
2. Call `DELETE /servers/{id}` for each one.
3. Remove all VPS servers from the registry, causing a complete denial of service for the discovery mechanism.

**Fix**:
1. Require authentication (e.g., the server's Ed25519 key signs the delete request).
2. At minimum, require the same `publicKey` used during registration to authorize deletion.
3. Consider requiring a shared admin secret for server management operations.
