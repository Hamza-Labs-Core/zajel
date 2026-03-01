# Plan: endpoint field in server registration not validated for format or scheme

**Issue**: issue-server-42.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/server-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/server-registry-do.js`, the `registerServer` method (lines 62-88) accepts the `endpoint` field from the request body without any validation:

```js
async registerServer(request, corsHeaders) {
  const body = await request.json();
  const { serverId, endpoint, publicKey, region } = body;

  if (!serverId || !endpoint || !publicKey) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
      { status: 400, ... }
    );
  }

  const serverEntry = {
    serverId,
    endpoint,  // stored as-is, no validation
    // ...
  };

  await this.state.storage.put(`server:${serverId}`, serverEntry);
```

The `endpoint` is stored directly and returned via `GET /servers` (line 95-108). Clients consuming the server list may automatically connect to these endpoints.

There is no validation that `endpoint`:
- Is a valid URL
- Uses HTTPS or WSS (not HTTP, FTP, file://, javascript:, etc.)
- Does not point to private/internal addresses (localhost, 127.0.0.1, 10.x.x.x, 192.168.x.x, 169.254.x.x)
- Has a reasonable length

Similarly, `region` (line 77: `region: region || 'unknown'`) is stored without validation.

## Fix Steps

1. **Add endpoint URL validation** in `registerServer` (after the existing field check on line 66). Add this validation block before creating the `serverEntry`:

```js
// Validate endpoint URL
let endpointUrl;
try {
  endpointUrl = new URL(endpoint);
} catch {
  return new Response(
    JSON.stringify({ error: 'Invalid endpoint: must be a valid URL' }),
    { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}

// Require secure protocols
if (!['https:', 'wss:'].includes(endpointUrl.protocol)) {
  return new Response(
    JSON.stringify({ error: 'Invalid endpoint: must use HTTPS or WSS protocol' }),
    { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}

// Reject private/internal addresses
const hostname = endpointUrl.hostname;
const privatePatterns = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
];
const privateRanges = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

if (privatePatterns.includes(hostname) || privateRanges.some(r => r.test(hostname))) {
  return new Response(
    JSON.stringify({ error: 'Invalid endpoint: must not point to private or internal addresses' }),
    { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}

// Enforce maximum URL length
if (endpoint.length > 2048) {
  return new Response(
    JSON.stringify({ error: 'Invalid endpoint: URL too long (max 2048 characters)' }),
    { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

2. **Add region validation** (after line 64), to prevent storing excessively long or malicious region strings:

```js
const validRegion = typeof region === 'string' && region.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(region)
  ? region
  : 'unknown';
```

Then use `validRegion` instead of `region` on line 77.

3. **Add publicKey length validation** to prevent excessively long keys:

```js
if (publicKey.length > 1024) {
  return new Response(
    JSON.stringify({ error: 'Invalid publicKey: too long' }),
    { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
```

## Testing

- Test registration with valid HTTPS endpoints: `https://vps.example.com:8443/ws`.
- Test registration with valid WSS endpoints: `wss://relay.example.com/signal`.
- Test rejection of HTTP endpoints: `http://example.com`.
- Test rejection of private addresses: `https://localhost:8080`, `https://192.168.1.1`, `https://10.0.0.1`.
- Test rejection of non-URL strings: `not-a-url`, empty string.
- Test rejection of javascript: URLs: `javascript:alert(1)`.
- Test rejection of very long URLs (> 2048 characters).
- Test that `GET /servers` returns only valid endpoints.
- Verify that region validation correctly sanitizes or defaults invalid regions.

## Risk Assessment

- **Low risk for legitimate VPS servers**: Real VPS servers will have public HTTPS/WSS endpoints. The validation only rejects malformed or malicious inputs.
- **Potential breaking change**: If any existing VPS server uses HTTP (not HTTPS) endpoints, they will be rejected after this fix. This is arguably correct behavior since unencrypted server registration is a security concern.
- **Private IP detection**: The regex-based private IP detection covers common cases but may miss some edge cases (e.g., IPv6-mapped IPv4 addresses like `::ffff:10.0.0.1`). Consider using a more comprehensive IP classification library for production.
- **DNS rebinding**: The validation checks the hostname at registration time but cannot prevent DNS rebinding attacks where a hostname resolves to a public IP initially but to a private IP later. This is a limitation of URL-based validation.
