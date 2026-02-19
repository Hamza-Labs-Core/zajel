# Plan 09b: Server Code Issues

## Strategic Decision: Delete Dead Code

The `index.js` entry point only exports `ServerRegistryDO`. `wrangler.jsonc` migration v3 explicitly deleted `SignalingRoom` and `RelayRegistryDO`. Five source files and four test files are completely dead code. Issues S2, S3, S5, S6, S7, S11, S12, and SF-C1/C2/C3 all affect dead code.

**Recommendation**: Delete all dead code. If relay/rendezvous is needed later, rebuild against the current VPS federation architecture.

---

## Step 1: Delete Dead Code (S1)

**Source files to delete**:
- `src/signaling-room.js` (203 lines)
- `src/relay-registry.js` (150 lines)
- `src/rendezvous-registry.js` (243 lines)
- `src/websocket-handler.js` (252 lines)
- `src/durable-objects/relay-registry-do.js` (131 lines)
- `src/logger.js` (only imported by dead code)

**Test files to delete**:
- `src/__tests__/relay-registry.test.js`
- `src/__tests__/relay-registry-do.test.js`
- `src/__tests__/rendezvous-registry.test.js`
- `src/__tests__/websocket-handler.test.js`

**This eliminates**: S2, S3, S5, S6, S7, S11, S12, SF-C1, SF-C2, SF-C3

---

## Step 2: Fix S4 — DELETE /servers without ID silently deletes `server:undefined`

**File**: `src/durable-objects/server-registry-do.js:43`

**Current code**:
```javascript
if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
    const serverId = url.pathname.split('/')[2];
    return await this.unregisterServer(serverId, corsHeaders);
}
```

**Fix**:
```javascript
if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
    const serverId = url.pathname.slice('/servers/'.length);
    if (!serverId) {
        return new Response(
            JSON.stringify({ error: 'Missing serverId in path' }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    }
    return await this.unregisterServer(serverId, corsHeaders);
}
```

**Tests** (add to `tests/e2e/bootstrap.test.js`):
```javascript
it('should return 400 when DELETE /servers/ has no serverId', async () => {
    const request = createRequest('DELETE', '/servers/');
    const response = await serverRegistry.fetch(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Missing serverId');
});

it('should handle server IDs containing slashes', async () => {
    const serverId = 'ed25519:abc/def';
    await registerServer(serverId, 'wss://test.example.com');
    const deleteResponse = await serverRegistry.fetch(
        createRequest('DELETE', `/servers/${serverId}`)
    );
    expect(deleteResponse.status).toBe(200);
});
```

---

## Step 3: Fix S10 — No validation of endpoint/publicKey format

**File**: `src/durable-objects/server-registry-do.js:62-88`

**Fix**: Add validation helper:
```javascript
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_SERVER_ID_LENGTH = 256;
const MAX_PUBLIC_KEY_LENGTH = 256;
const MAX_REGION_LENGTH = 64;

function validateServerInput({ serverId, endpoint, publicKey, region }) {
    if (!serverId || typeof serverId !== 'string' || serverId.length > MAX_SERVER_ID_LENGTH)
        return 'serverId must be a non-empty string (max 256 chars)';
    if (!endpoint || typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH)
        return 'endpoint must be a non-empty string (max 2048 chars)';
    try {
        const url = new URL(endpoint);
        if (url.protocol !== 'wss:' && url.protocol !== 'ws:')
            return 'endpoint must use wss:// or ws:// protocol';
    } catch {
        return 'endpoint must be a valid URL';
    }
    if (!publicKey || typeof publicKey !== 'string' || publicKey.length > MAX_PUBLIC_KEY_LENGTH)
        return 'publicKey must be a non-empty string (max 256 chars)';
    if (region && typeof region === 'string' && region.length > MAX_REGION_LENGTH)
        return 'region exceeds maximum length';
    return null;
}
```

**Tests** (add to `tests/e2e/bootstrap.test.js`):
```javascript
it('should reject non-URL endpoint', async () => {
    const response = await registerServer('ed25519:test', 'not-a-url');
    expect(response.status).toBe(400);
});

it('should reject non-WSS endpoint', async () => {
    const response = await registerServer('ed25519:test', 'http://example.com');
    expect(response.status).toBe(400);
});

it('should accept ws:// endpoint for dev', async () => {
    const response = await registerServer('ed25519:test', 'ws://localhost:8080');
    expect(response.status).toBe(200);
});

it('should reject oversized serverId', async () => {
    const response = await registerServer('x'.repeat(300), 'wss://test.com');
    expect(response.status).toBe(400);
});
```

**Note**: Update existing "very long endpoint" test (line 628) to expect 400 instead of 200.

---

## Step 4: Fix S8 — Fragile btoa spread pattern

**File**: `src/crypto/signing.js:57`

**Current**: `return btoa(String.fromCharCode(...new Uint8Array(signature)));`

**Fix**:
```javascript
export async function signPayload(key, payload) {
    const data = new TextEncoder().encode(payload);
    const signature = await crypto.subtle.sign('Ed25519', key, data);
    const bytes = new Uint8Array(signature);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
```

**Tests**: Existing signing tests continue to pass. No new tests needed.

---

## Step 5: Fix S9 — Stale compatibility_date

**File**: `wrangler.jsonc:7`

**Fix**: Update from `"2024-01-01"` to `"2026-01-01"` after reviewing CF changelog for breaking changes between those dates.

**Tests**: Run all existing tests after update. No new tests needed.

---

## Implementation Order

| Order | Issue | Action | Risk |
|-------|-------|--------|------|
| 1 | S1 | Delete 5 source + 4 test files | Low — dead code |
| 2 | S4 | Add empty-ID guard to DELETE | Low |
| 3 | S10 | Add input validation | Medium — update existing test expectations |
| 4 | S8 | Replace btoa spread | Low |
| 5 | S9 | Update compat date | Medium — review CF changelog first |

**Total new tests**: ~8 test cases in `bootstrap.test.js`
