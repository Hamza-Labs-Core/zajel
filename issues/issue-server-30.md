# [MEDIUM] Endpoint URL validation not validated -- path traversal in server ID extraction

**Area**: Server
**File**: packages/server/src/durable-objects/server-registry-do.js:44
**Type**: Security

**Description**: The server ID for DELETE requests is extracted via string splitting:
```js
const serverId = url.pathname.split('/')[2];
```
This naive extraction has several issues:
1. A URL like `/servers/` yields `undefined` as the serverId (empty string after last slash).
2. A URL like `/servers/id/extra/path/segments` only uses `id`, silently ignoring extra segments.
3. URL-encoded characters (e.g., `%2F` for `/`) in the path are not decoded consistently across environments.
4. The `url.pathname.startsWith('/servers/')` check on line 43 matches any path starting with `/servers/`, including `/servers/heartbeat` on DELETE method (though heartbeat only handles POST).

**Impact**: Edge cases in URL parsing could lead to unexpected behavior, including accidentally deleting the wrong server entry or passing `undefined` to storage operations.

**Fix**: Use a proper URL pattern matcher or add explicit validation:
```js
const pathParts = url.pathname.split('/').filter(Boolean);
if (pathParts.length !== 2 || pathParts[0] !== 'servers') {
  return new Response('Not Found', { status: 404, headers: corsHeaders });
}
const serverId = decodeURIComponent(pathParts[1]);
if (!serverId || !isValidId(serverId)) {
  return new Response(JSON.stringify({ error: 'Invalid server ID' }), { status: 400 });
}
```
