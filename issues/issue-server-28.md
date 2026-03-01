# [MEDIUM] serverId used in storage key without sanitization enables key injection

**Area**: Server
**File**: packages/server/src/durable-objects/server-registry-do.js:82
**Type**: Security

**Description**: The `serverId` from user input is directly interpolated into a Durable Object storage key:
```js
await this.state.storage.put(`server:${serverId}`, serverEntry);
```
Similar patterns exist with `device_id` in attestation-registry-do.js:
```js
await this.state.storage.put(`device:${device_id}`, deviceEntry);
```
And with nonce, version, and platform:
```js
await this.state.storage.put(`nonce:${nonce}`, challengeEntry);
await this.state.storage.put(`reference:${version}:${platform}`, referenceEntry);
```

While Durable Object storage keys are strings and there is no direct injection vulnerability like SQL injection, a malicious client can craft a `serverId` like `../device:target_device_id` or use extremely long strings as keys.

The `unregisterServer` method extracts `serverId` from the URL path via string splitting (line 44), which is also unsanitized.

**Impact**:
- Key collision: A specially crafted `serverId` could overwrite entries in a different key namespace (e.g., `server:` key that looks like another prefix, though prefixes are separate).
- Storage abuse: Very long keys consume storage quota.
- Path traversal in DELETE: The URL-extracted `serverId` could contain encoded characters.

**Fix**: Validate all storage key components:
```js
function isValidId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9._-]+$/.test(id);
}
if (!isValidId(serverId)) {
  return new Response(JSON.stringify({ error: 'Invalid serverId format' }), { status: 400 });
}
```
