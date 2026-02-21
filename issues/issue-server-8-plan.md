# Plan: Unbounded storage growth in attestation nonces with no cleanup

**Issue**: issue-server-8.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/attestation-registry-do.js`:

- `handleChallenge()` (lines 311-381): Creates nonce entries at line 367 (`await this.state.storage.put('nonce:' + nonce, challengeEntry)`) with a `created_at` timestamp, but no alarm-based cleanup.
- Nonces are only deleted when:
  1. `handleVerify()` consumes them (line 430: `await this.state.storage.delete('nonce:' + nonce)`).
  2. `handleVerify()` finds them expired (line 412: `await this.state.storage.delete('nonce:' + nonce)`).
- If a client calls `/attest/challenge` repeatedly without ever calling `/attest/verify`, nonce entries accumulate indefinitely in Durable Object storage.
- The `NONCE_TTL` is 5 minutes (line 32: `const NONCE_TTL = 5 * 60 * 1000`), but this is only checked during verification, not enforced via cleanup.
- Unlike `RelayRegistryDO` which has an alarm-based cleanup at line 50, `AttestationRegistryDO` has no `alarm()` method at all.

## Fix Steps

1. **Add an `alarm()` method to `AttestationRegistryDO`** (after the constructor at line 42):
   ```js
   async alarm() {
     const now = Date.now();

     // Clean up expired nonces
     const nonces = await this.state.storage.list({ prefix: 'nonce:' });
     const deleteKeys = [];
     for (const [key, value] of nonces) {
       if (now - value.created_at > NONCE_TTL) {
         deleteKeys.push(key);
       }
     }
     if (deleteKeys.length > 0) {
       await this.state.storage.delete(deleteKeys);
     }

     // Schedule next cleanup
     await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
   }
   ```

2. **Schedule the initial alarm in the constructor** (after line 41):
   ```js
   constructor(state, env) {
     this.state = state;
     this.env = env;

     // Schedule periodic cleanup alarm
     this.state.blockConcurrencyWhile(async () => {
       const currentAlarm = await this.state.storage.getAlarm();
       if (!currentAlarm) {
         await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
       }
     });
   }
   ```

3. **Use batch delete** for efficiency: `this.state.storage.delete(deleteKeys)` accepts an array of keys, which is more efficient than individual deletes.

4. **Add nonce count limiting in `handleChallenge()`** (before creating a new nonce at line 367):
   ```js
   // Rate limit: max 5 active nonces per device
   const allNonces = await this.state.storage.list({ prefix: 'nonce:' });
   let deviceNonceCount = 0;
   for (const [, value] of allNonces) {
     if (value.device_id === device_id && now - value.created_at <= NONCE_TTL) {
       deviceNonceCount++;
     }
   }
   if (deviceNonceCount >= 5) {
     return this.jsonResponse(
       { error: 'Too many pending challenges. Please complete or wait for existing challenges to expire.' },
       429,
       corsHeaders
     );
   }
   ```

## Testing

- Verify that expired nonces are cleaned up by the alarm.
- Verify that the alarm reschedules itself after each run.
- Verify that nonce creation still works normally.
- Verify that `handleVerify()` still correctly deletes nonces on use.
- Test the per-device nonce limit by requesting more than 5 challenges without verifying.

## Risk Assessment

- **Storage list performance**: `storage.list({ prefix: 'nonce:' })` scans all nonce keys. If there are many nonces, this could be slow. The 5-minute alarm interval and per-device limiting should keep counts manageable.
- **Alarm reliability**: Cloudflare Durable Object alarms are guaranteed to fire, but may be delayed under high load. Expired nonces remain harmless (they are rejected in `handleVerify`) until the alarm cleans them.
- **Batch delete limits**: Cloudflare DO `storage.delete()` with an array has a limit of 128 keys per call. For very large backlogs, iterate in batches.
