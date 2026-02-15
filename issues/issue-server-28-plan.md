# Plan: serverId used in storage key without sanitization enables key injection

**Issue**: issue-server-28.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/server-registry-do.js`, `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

Several user-controlled values are directly interpolated into Durable Object storage keys without sanitization:

### server-registry-do.js
- Line 82: `await this.state.storage.put(\`server:${serverId}\`, serverEntry);` -- `serverId` from request body (line 64).
- Line 44: `const serverId = url.pathname.split('/')[2];` -- `serverId` from URL path, then used on line 114: `await this.state.storage.delete(\`server:${serverId}\`);`
- Line 133: `await this.state.storage.get(\`server:${serverId}\`);` -- heartbeat also uses unsanitized `serverId` from body.

### attestation-registry-do.js
- Line 217: `await this.state.storage.put(\`device:${device_id}\`, deviceEntry);` -- `device_id` from request body (line 109).
- Line 324: `await this.state.storage.get(\`device:${device_id}\`);` -- challenge handler.
- Line 367: `await this.state.storage.put(\`nonce:${nonce}\`, challengeEntry);` -- nonce is server-generated via `generateNonce()`, so this is safe.
- Line 297: `await this.state.storage.put(\`reference:${version}:${platform}\`, referenceEntry);` -- `version` and `platform` from CI upload (protected by auth), lower risk.

While DO storage keys are simple strings (no SQL-injection-style attack), a crafted `serverId` could be extremely long (consuming storage quota) or contain characters that create confusion (e.g., a serverId containing `:` that mimics a different prefix).

## Fix Steps

1. **Create a shared validation helper**. Add an `isValidId` function. This can go at the top of each DO file, or in a shared utility:

```js
function isValidId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9._-]+$/.test(id);
}
```

2. **In `server-registry-do.js`, validate `serverId`**:

   - In `registerServer` (line 62), after the existing `if (!serverId || !endpoint || !publicKey)` check on line 66, add:
   ```js
   if (!isValidId(serverId)) {
     return new Response(
       JSON.stringify({ error: 'Invalid serverId format: must be 1-128 alphanumeric characters, dots, hyphens, or underscores' }),
       { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
     );
   }
   ```

   - In `unregisterServer` (called from line 45), validate `serverId` before using it:
   ```js
   if (!serverId || !isValidId(serverId)) {
     return new Response(
       JSON.stringify({ error: 'Invalid server ID' }),
       { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
     );
   }
   ```

   - In `heartbeat` (line 122), after the existing `if (!serverId)` check on line 126, add the same `isValidId` check.

3. **In `attestation-registry-do.js`, validate `device_id`**:

   - In `handleRegister` (line 107), after the existing `if (!build_token || !device_id)` check on line 111, add:
   ```js
   if (!isValidId(device_id)) {
     return this.jsonResponse({ error: 'Invalid device_id format' }, 400, corsHeaders);
   }
   ```

   - In `handleChallenge` (line 311), after the existing `if (!device_id || !build_version)` check on line 315, add the same validation.

   - In `handleVerify` (line 388), after the existing `if (!device_id || !nonce || !responses)` check on line 392, add the same validation.

   - Also validate `version` and `platform` in `handleUploadReference` (line 239) after the existing field check:
   ```js
   if (!isValidId(version) || !isValidId(platform)) {
     return this.jsonResponse({ error: 'Invalid version or platform format' }, 400, corsHeaders);
   }
   ```

## Testing

- Test registration with valid IDs (alphanumeric, with dots and hyphens).
- Test with IDs containing invalid characters: spaces, colons, slashes, unicode, etc.
- Test with extremely long IDs (> 128 chars).
- Test with empty strings.
- Verify all endpoints reject invalid IDs with 400 status.

## Risk Assessment

- **Low risk for legitimate clients**: Standard server IDs and device IDs (typically UUIDs) will pass the validation easily.
- **Potential breaking change**: If any existing client uses IDs with characters outside `[a-zA-Z0-9._-]`, they would be rejected. UUIDs with hyphens are fine. Review any existing ID formats before deploying.
- **Good defense-in-depth**: Even though DO storage keys don't have injection risks like SQL, limiting the character set prevents storage abuse and confusing key collisions.
