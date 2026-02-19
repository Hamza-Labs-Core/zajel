# Plan: DELETE /servers/:serverId allows unauthenticated deletion of any server

**Issue**: issue-server-29.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/server-registry-do.js`, `packages/server/src/index.js`

## Analysis

In `packages/server/src/durable-objects/server-registry-do.js`, the `unregisterServer` method (lines 113-120) deletes a server from storage without any authentication or ownership verification:

```js
async unregisterServer(serverId, corsHeaders) {
  await this.state.storage.delete(`server:${serverId}`);
  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

The method is called from the route handler on lines 43-45:
```js
if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
  const serverId = url.pathname.split('/')[2];
  return await this.unregisterServer(serverId, corsHeaders);
}
```

Meanwhile, `registerServer` (line 62) stores a `publicKey` with the server entry. This key could be used to authenticate deletion requests, but currently is not.

The `GET /servers` endpoint (line 38) lists all servers with their IDs, making enumeration trivial.

## Fix Steps

1. **Add signature-based authentication to `unregisterServer`** in `server-registry-do.js`. The server registering must prove it owns the `publicKey` stored at registration time.

   Modify the route handler (line 43) to pass the full `request` object:
   ```js
   if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
     const serverId = url.pathname.split('/')[2];
     return await this.unregisterServer(serverId, request, corsHeaders);
   }
   ```

   Modify `unregisterServer` (line 113) to verify ownership:
   ```js
   async unregisterServer(serverId, request, corsHeaders) {
     if (!serverId) {
       return new Response(
         JSON.stringify({ error: 'Missing server ID' }),
         { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
       );
     }

     // Look up the server to get its publicKey
     const server = await this.state.storage.get(`server:${serverId}`);
     if (!server) {
       return new Response(
         JSON.stringify({ error: 'Server not found' }),
         { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
       );
     }

     // Require Authorization header with the server's public key
     const authHeader = request.headers.get('Authorization');
     if (!authHeader || !authHeader.startsWith('Bearer ')) {
       return new Response(
         JSON.stringify({ error: 'Authorization required' }),
         { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
       );
     }

     const providedKey = authHeader.substring(7);
     if (providedKey !== server.publicKey) {
       return new Response(
         JSON.stringify({ error: 'Not authorized to delete this server' }),
         { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
       );
     }

     await this.state.storage.delete(`server:${serverId}`);
     return new Response(
       JSON.stringify({ success: true }),
       { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
     );
   }
   ```

2. **Update CORS headers** in the `corsHeaders` object (line 24) to include `Authorization` in `Access-Control-Allow-Headers`:
   ```js
   'Access-Control-Allow-Headers': 'Content-Type, Authorization',
   ```

3. **Alternatively, use a signed request approach**: Instead of sending the raw public key, require the client to sign the `serverId` and include the signature in the Authorization header. The server verifies the signature against the stored public key. This is more secure but more complex to implement.

## Testing

- Test that DELETE without Authorization header returns 401.
- Test that DELETE with wrong key returns 403.
- Test that DELETE with correct publicKey succeeds and removes the server.
- Test that DELETE for a non-existent server returns 404.
- Test that the CORS preflight includes Authorization in allowed headers.
- Verify existing server registration and listing still work.

## Risk Assessment

- **Breaking change**: Any client that currently uses DELETE without authentication will need to be updated. The VPS server code that performs deregistration must be updated to include the Authorization header.
- **Simple auth vs. signed requests**: Using the raw public key as a bearer token is simpler but means the public key acts as a shared secret. A signature-based approach is stronger but adds complexity. Given that the public key is already public (returned in GET /servers), a signature-based approach is recommended for production. The bearer-token approach above is a pragmatic first step.
- **Migration path**: Deploy the authentication requirement after updating all VPS server clients to include the Authorization header.
