# Plan: No request logging or audit trail for security-sensitive operations

**Issue**: issue-server-41.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/server-registry-do.js`, `packages/server/src/durable-objects/attestation-registry-do.js`, `packages/server/src/index.js`

## Analysis

The active Durable Objects (`ServerRegistryDO` and `AttestationRegistryDO`) have minimal logging:

### ServerRegistryDO (`server-registry-do.js`)
- No logging for server registration (line 62).
- No logging for server deletion (line 113).
- No logging for heartbeats (line 122).
- The catch block (line 54-58) logs errors via the response, not `console.error`.

### AttestationRegistryDO (`attestation-registry-do.js`)
- No logging for device registration (line 107).
- No logging for reference upload (line 239).
- No logging for challenge generation (line 311).
- No logging for verification attempts (line 388) -- especially important for failed auth attempts.
- No logging for version policy updates (line 537).
- The catch block (line 93-98) returns the error message but does not log it.

### index.js
- The only logging is on line 110: `console.error('Failed to sign bootstrap response:', e)` for signing failures.
- No request-level logging.

A `logger.js` module exists with a `createLogger` utility (lines 39-135), but it is only used by `SignalingRoom` (dead code). The active DOs do not use it.

## Fix Steps

1. **Import and initialize the logger** in both active DOs.

   In `server-registry-do.js`, add at the top:
   ```js
   import { createLogger } from '../logger.js';
   ```

   In the constructor (line 11):
   ```js
   constructor(state, env) {
     this.state = state;
     this.env = env;
     this.serverTTL = 5 * 60 * 1000;
     this.logger = createLogger(env);
   }
   ```

   In `attestation-registry-do.js`, add at the top (with existing imports):
   ```js
   import { createLogger } from '../logger.js';
   ```

   In the constructor (line 39):
   ```js
   constructor(state, env) {
     this.state = state;
     this.env = env;
     this.logger = createLogger(env);
   }
   ```

2. **Add audit logging to security-sensitive operations in `server-registry-do.js`**:

   In `registerServer` (after line 82, the storage.put call):
   ```js
   this.logger.info('[audit] Server registered', {
     action: 'server_register',
     serverId,
     region: region || 'unknown',
     ip: request.headers.get('CF-Connecting-IP'),
   });
   ```

   In `unregisterServer` (after line 114, the storage.delete call):
   ```js
   this.logger.info('[audit] Server unregistered', {
     action: 'server_unregister',
     serverId,
   });
   ```

   Note: `registerServer` does not currently receive the `request` object -- only `corsHeaders`. To log the IP, modify the method signature to also accept `request`, or pass the IP from the `fetch` handler.

   Modify line 34 to pass `request`:
   ```js
   return await this.registerServer(request, corsHeaders);
   ```

3. **Add audit logging to security-sensitive operations in `attestation-registry-do.js`**:

   In `handleRegister` (after line 217, successful device registration):
   ```js
   this.logger.info('[audit] Device registered', {
     action: 'device_register',
     device_id,
     version,
     platform,
     ip: request.headers.get('CF-Connecting-IP'),
   });
   ```

   In `handleUploadReference` (after line 297, successful reference upload):
   ```js
   this.logger.info('[audit] Reference uploaded', {
     action: 'reference_upload',
     version,
     platform,
   });
   ```

   In `handleUploadReference` (line 250, failed auth):
   ```js
   this.logger.warn('[audit] Unauthorized reference upload attempt', {
     action: 'reference_upload_failed',
     ip: request.headers.get('CF-Connecting-IP'),
   });
   ```

   In `handleVerify` (after line 493, successful verification):
   ```js
   this.logger.info('[audit] Attestation verified', {
     action: 'attest_verify_success',
     device_id,
   });
   ```

   In `handleVerify` (for each failure case):
   ```js
   this.logger.warn('[audit] Attestation verification failed', {
     action: 'attest_verify_failed',
     device_id,
     reason: 'specific reason for server logs',
   });
   ```

   In `handleSetVersions` (line 548, failed auth):
   ```js
   this.logger.warn('[audit] Unauthorized version policy update attempt', {
     action: 'version_policy_failed',
     ip: request.headers.get('CF-Connecting-IP'),
   });
   ```

   In `handleSetVersions` (after line 571, successful update):
   ```js
   this.logger.info('[audit] Version policy updated', {
     action: 'version_policy_updated',
     policy,
   });
   ```

4. **Add error logging to catch blocks**:

   In `server-registry-do.js` (line 54):
   ```js
   } catch (error) {
     this.logger.error('[server-registry] Unhandled error', error);
     return new Response(/* ... */);
   }
   ```

   In `attestation-registry-do.js` (line 93):
   ```js
   } catch (error) {
     this.logger.error('[attestation-registry] Unhandled error', error);
     return new Response(/* ... */);
   }
   ```

## Testing

- Verify that all security-sensitive operations produce log entries.
- Test that production mode (`ENVIRONMENT=production`) redacts sensitive data in logs.
- Test that failed authentication attempts are logged with IP addresses.
- Verify that the logger does not throw errors that interrupt request processing (all log calls should be fire-and-forget).
- Check that log output appears in Cloudflare Workers logs (accessible via `wrangler tail`).

## Risk Assessment

- **Low risk**: Logging is additive and does not change the request/response flow. All log calls are synchronous `console.*` calls that cannot fail in a way that affects the response.
- **Privacy consideration**: Logging IP addresses may have GDPR implications. Consider making IP logging configurable via environment variable.
- **Performance**: The `createLogger` utility uses `console.*` which in Cloudflare Workers is buffered and sent asynchronously. No measurable performance impact.
- **Log volume**: In high-traffic scenarios, audit logging could produce significant log volume. Consider using log levels to control verbosity in production.
