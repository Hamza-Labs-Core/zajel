# Plan: Unbounded storage growth in device and server registrations

**Issue**: issue-server-9.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/attestation-registry-do.js`
- `packages/server/src/durable-objects/server-registry-do.js`

## Analysis

**Server entries** in `packages/server/src/durable-objects/server-registry-do.js`:
- `registerServer()` (line 82): Stores `server:{serverId}` with no cap on total entries.
- `listServers()` (lines 90-111): Does TTL-based cleanup while listing (line 99-104), but only runs when someone calls `GET /servers`. If no one lists servers, stale entries persist indefinitely.
- No `alarm()` method exists for periodic cleanup.
- `serverId` (line 64) is client-supplied with no format validation.

**Device entries** in `packages/server/src/durable-objects/attestation-registry-do.js`:
- `handleRegister()` (line 217): Stores `device:{device_id}` with no cap, no TTL, and no cleanup mechanism.
- `device_id` (line 109) is client-supplied with no format validation.
- There is no alarm, no expiration field, and no periodic cleanup for device entries.

## Fix Steps

### ServerRegistryDO

1. **Add an `alarm()` method** for periodic cleanup of stale server entries:
   ```js
   async alarm() {
     const now = Date.now();
     const entries = await this.state.storage.list({ prefix: 'server:' });
     const deleteKeys = [];
     for (const [key, server] of entries) {
       if (now - server.lastSeen >= this.serverTTL) {
         deleteKeys.push(key);
       }
     }
     if (deleteKeys.length > 0) {
       await this.state.storage.delete(deleteKeys);
     }
     await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
   }
   ```

2. **Schedule the alarm in the constructor** (after line 15):
   ```js
   constructor(state, env) {
     this.state = state;
     this.env = env;
     this.serverTTL = 5 * 60 * 1000;

     this.state.blockConcurrencyWhile(async () => {
       const currentAlarm = await this.state.storage.getAlarm();
       if (!currentAlarm) {
         await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
       }
     });
   }
   ```

3. **Validate `serverId` format** in `registerServer()` (after line 64):
   ```js
   if (typeof serverId !== 'string' || serverId.length > 64 || !/^[\w-]+$/.test(serverId)) {
     return new Response(JSON.stringify({ error: 'Invalid serverId format' }),
       { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
   }
   ```

4. **Add a maximum entry count** in `registerServer()`:
   ```js
   const existing = await this.state.storage.list({ prefix: 'server:' });
   if (existing.size >= 1000 && !existing.has(`server:${serverId}`)) {
     return new Response(JSON.stringify({ error: 'Server registry full' }),
       { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
   }
   ```

### AttestationRegistryDO

5. **Add a `last_seen` timestamp and TTL to device entries** in `handleRegister()` (line 209-215):
   ```js
   const deviceEntry = {
     device_id,
     build_version: version,
     platform,
     build_hash,
     registered_at: Date.now(),
     last_seen: Date.now(),
   };
   ```

6. **Add device entry cleanup in the `alarm()` method** (building on issue-server-8's alarm):
   ```js
   // Clean up stale device entries (not seen in 90 days)
   const DEVICE_TTL = 90 * 24 * 60 * 60 * 1000;
   const devices = await this.state.storage.list({ prefix: 'device:' });
   const deleteDeviceKeys = [];
   for (const [key, device] of devices) {
     const lastActivity = device.last_seen || device.registered_at;
     if (now - lastActivity > DEVICE_TTL) {
       deleteDeviceKeys.push(key);
     }
   }
   if (deleteDeviceKeys.length > 0) {
     await this.state.storage.delete(deleteDeviceKeys);
   }
   ```

7. **Validate `device_id` format** in `handleRegister()` (after line 110):
   ```js
   if (typeof device_id !== 'string' || device_id.length > 128 || !/^[\w-]+$/.test(device_id)) {
     return this.jsonResponse({ error: 'Invalid device_id format' }, 400, corsHeaders);
   }
   ```

8. **Add a maximum device count** check:
   ```js
   const deviceCount = await this.state.storage.list({ prefix: 'device:', limit: 100001 });
   if (deviceCount.size >= 100000) {
     return this.jsonResponse({ error: 'Device registry full' }, 503, corsHeaders);
   }
   ```

## Testing

- Verify that stale server entries are cleaned up by the alarm.
- Verify that device entries with expired TTL are cleaned up.
- Verify that `serverId` and `device_id` format validation rejects invalid inputs.
- Verify that maximum entry count limits are enforced.
- Verify normal registration flows still work.

## Risk Assessment

- **Device TTL**: 90 days is a reasonable default but should be configurable. Legitimate devices that are offline for extended periods would need to re-register.
- **Storage.list() performance**: Listing all entries to count them on every registration is expensive at scale. Consider using a counter key instead (e.g., `meta:device_count`) that is atomically incremented/decremented.
- **Batch delete limits**: Cloudflare DO `storage.delete()` has a batch limit. Process in chunks of 128 keys.
