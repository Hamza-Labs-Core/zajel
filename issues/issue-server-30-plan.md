# Plan: Endpoint URL validation not validated -- path traversal in server ID extraction

**Issue**: issue-server-30.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/server-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/server-registry-do.js`, line 44, the server ID for DELETE requests is extracted via naive string splitting:

```js
if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
  const serverId = url.pathname.split('/')[2];
  return await this.unregisterServer(serverId, corsHeaders);
}
```

Issues identified:
1. `url.pathname` is `/servers/`, `split('/')` yields `['', 'servers', '']`, so `split('/')[2]` is `''` (empty string), not `undefined`. This causes `this.state.storage.delete('server:')` which deletes a key that likely does not exist -- harmless but incorrect.
2. Extra path segments like `/servers/id/extra/path` are silently ignored, using only `id`.
3. URL-encoded characters in the path (e.g., `%2F`) are decoded by the `URL` constructor, so `url.pathname` will contain the decoded `/`. This means `/servers/a%2Fb` becomes `/servers/a/b` and `split('/')[2]` is `a`, not `a/b`.
4. The `startsWith('/servers/')` on line 43 also matches paths like `/servers/heartbeat` for DELETE (though heartbeat only handles POST, so this is not a real issue due to the method check on line 49).

## Fix Steps

1. **Replace the naive path extraction** with proper validation in `server-registry-do.js` (lines 43-45). Replace:

```js
if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
  const serverId = url.pathname.split('/')[2];
  return await this.unregisterServer(serverId, corsHeaders);
}
```

With:

```js
if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
  const pathParts = url.pathname.split('/').filter(Boolean);
  // Expect exactly ['servers', '<serverId>']
  if (pathParts.length !== 2 || pathParts[0] !== 'servers') {
    return new Response(
      JSON.stringify({ error: 'Invalid path format' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
  const serverId = pathParts[1];
  if (!serverId) {
    return new Response(
      JSON.stringify({ error: 'Missing server ID' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
  return await this.unregisterServer(serverId, corsHeaders);
}
```

2. **Combine with the ID validation from issue-server-28**: If the `isValidId` function is added (per issue-server-28 plan), use it here as well:

```js
if (!isValidId(serverId)) {
  return new Response(
    JSON.stringify({ error: 'Invalid server ID format' }),
    { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

## Testing

- Test `DELETE /servers/valid-id` -- should succeed.
- Test `DELETE /servers/` -- should return 400 (no server ID).
- Test `DELETE /servers/id/extra/segments` -- should return 400 (too many path segments).
- Test `DELETE /servers/id%2Fslash` -- should return 400 if `isValidId` rejects slashes (since `URL` decodes `%2F` to `/` which then produces 3 segments).
- Test `DELETE /servers/heartbeat` -- should attempt deletion (not conflict with POST heartbeat route, which is matched earlier on line 49).

## Risk Assessment

- **Low risk**: This only adds stricter validation. Legitimate DELETE requests with clean server IDs will continue to work unchanged.
- **No breaking change**: Any client sending a well-formed `DELETE /servers/<serverId>` request will see identical behavior.
- **Edge case**: If any client currently sends DELETE requests with extra path segments, those will now return 400. This is correct behavior.
