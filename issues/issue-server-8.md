# [HIGH] Unbounded storage growth in attestation nonces with no cleanup

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:367
**Type**: Security

**Description**: The `handleChallenge` method creates nonce entries in Durable Object storage (`nonce:{nonce}`) with a 5-minute logical TTL. However, there is no alarm or cleanup mechanism to delete expired nonces from storage. Nonces are only deleted when:
1. A client calls `handleVerify` with the nonce (which deletes it), or
2. A client calls `handleVerify` and the nonce is found to be expired (which deletes it).

If an attacker repeatedly calls `POST /attest/challenge` without ever calling `POST /attest/verify`, the nonce entries accumulate in Durable Object storage indefinitely.

**Impact**: Unbounded storage growth in the Durable Object. Durable Object storage is billed per GB, and `storage.list()` operations become slower as the number of keys grows. An attacker can exhaust storage budget by spamming challenge requests.

**Fix**:
1. Add a periodic alarm (similar to `RelayRegistryDO`) that lists and deletes expired nonce entries:
```js
async alarm() {
  const now = Date.now();
  const nonces = await this.state.storage.list({ prefix: 'nonce:' });
  for (const [key, value] of nonces) {
    if (now - value.created_at > NONCE_TTL) {
      await this.state.storage.delete(key);
    }
  }
  await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
}
```
2. Rate limit the challenge endpoint per device_id.
