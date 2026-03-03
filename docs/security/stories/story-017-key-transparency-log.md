# Story 017: Transparency Log for Key Changes

## Priority: MEDIUM-TERM
## Severity: MEDIUM
## Component: packages/server

## Summary

Key management operations on the bootstrap server (adding, removing, and replacing trusted build signing keys) are logged only to `console.log` via the `createLogger` utility. These logs are ephemeral -- they exist only in Cloudflare's transient log stream and are lost once the request completes. There is no append-only, tamper-evident audit trail for key changes. A compromised CI secret holder could add a rogue signing key, use it to sign a malicious build, and then remove the key -- all without leaving a durable forensic record.

## Current Behavior

**Key change logging** (`packages/server/src/durable-objects/server-registry-do.js`, lines 969-972):
```javascript
this.logger.info('[audit] Trusted build keys updated', {
  action: 'trusted_keys_updated',
  keyCount: finalKeys.length,
});
```
This is the only record of a key change. The log entry:
- Does not include which keys were added or removed
- Does not include the IP address of the requester
- Does not include a cryptographic commitment (hash) of the new key set
- Is written to `console.log` which in Cloudflare Workers goes to the live tail/logpush -- a mutable, potentially ephemeral log sink

**Other audit log points**:
- `[audit] Unauthorized trusted-keys update attempt` (line 906) -- logs failed auth, but same ephemeral destination
- `[audit] Unauthorized trusted-keys read attempt` (line 995) -- same issue
- `[audit] Server registered` (line 619) -- logs server registrations, ephemeral
- `[audit] Build signature checked` (lines 590-598) -- logs build verification results, ephemeral

**Log infrastructure** (`packages/server/src/logger.js`, lines 39-135):
The `createLogger` function wraps `console.log`, `console.warn`, `console.error`, etc. These go to Cloudflare's standard log output. There is no structured log destination, no append-only storage, and no log integrity verification.

**DO storage** is currently used for:
- Server entries: `server:{serverId}`
- Anomaly history: `anomaly-history:{serverId}`
- Anomaly scores: `anomaly-score:{serverId}`
- Trusted keys: `trusted_build_keys` (single key, overwritten on each update)

None of these are append-only log structures.

## Expected Behavior

1. Every key management operation should produce an immutable, append-only log entry in Durable Object storage.
2. Each log entry should include:
   - Timestamp
   - Action (add_key, remove_key, replace_keys, read_keys)
   - Actor IP address
   - Previous key set hash (for chaining)
   - New key set hash
   - Delta (which keys were added/removed)
   - Sequence number (monotonically increasing)
3. The log should be hash-chained: each entry includes the hash of the previous entry, creating a tamper-evident chain.
4. A `GET /servers/trusted-keys/audit-log` endpoint should allow authorized callers to retrieve the log.
5. Log entries should be retained for at least 1 year (configurable).

## Root Cause Analysis

The current logging approach was sufficient for the initial development phase where the CF Worker was a simple server registry. As the system grew to include build signing, attestation, and multi-operator federation, the audit requirements outgrew the `console.log` infrastructure.

Cloudflare Workers offer several options for durable logging:
1. **DO storage** -- append-only keys with sequence numbers (e.g., `audit-log:0001`, `audit-log:0002`)
2. **Workers Analytics Engine** -- structured event logging with SQL queries
3. **Logpush** -- push logs to external services (R2, S3, etc.)

The simplest and most self-contained approach is DO storage with append-only keys, which keeps the transparency log in the same consistency domain as the key data.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/durable-objects/server-registry-do.js` | 897-978 | `setTrustedKeys` -- key change with ephemeral logging |
| `packages/server/src/durable-objects/server-registry-do.js` | 986-1032 | `getTrustedKeys` -- key read with ephemeral logging |
| `packages/server/src/durable-objects/server-registry-do.js` | 906-909 | Unauthorized access logging |
| `packages/server/src/durable-objects/server-registry-do.js` | 619-625 | Server registration logging |
| `packages/server/src/durable-objects/server-registry-do.js` | 590-598 | Build verification logging |
| `packages/server/src/logger.js` | 1-138 | Entire logger implementation (console-based) |

## Reproduction Steps

1. **Add a rogue key, use it, remove it**:
   ```bash
   # Step 1: Add a rogue key
   curl -X POST https://bootstrap.example.com/servers/trusted-keys \
     -H "Authorization: Bearer $CI_SECRET" \
     -d '{"addKeys": ["rogue-key-base64"]}'

   # Step 2: Register a server with a build signed by the rogue key
   curl -X POST https://bootstrap.example.com/servers \
     -H "Authorization: Bearer $SERVER_SECRET" \
     -d '{"serverId":"evil","endpoint":"wss://evil.com","publicKey":"...","buildHash":"...","buildSignature":"...","buildSigningKey":"rogue-key-base64"}'
   # buildVerified: true

   # Step 3: Remove the rogue key
   curl -X POST https://bootstrap.example.com/servers/trusted-keys \
     -H "Authorization: Bearer $CI_SECRET" \
     -d '{"removeKeys": ["rogue-key-base64"]}'

   # Step 4: Check the audit trail
   # There is none. The only record was a console.log that's already gone.
   ```

2. **Verify ephemeral logging**:
   ```bash
   # The Cloudflare dashboard shows real-time logs for ~1 hour
   # After that, the key change event is lost
   # Logpush (if configured) sends to an external sink, but the CF dashboard shows
   # no historic log entries for Workers
   ```

## Impact Assessment

- **Forensic blindness**: Key management operations leave no durable trail. Post-incident investigation of a compromised signing key cannot determine when the key was added, by whom, or what it was used for.
- **Non-repudiation gap**: A CI secret holder who acts maliciously cannot be held accountable because their actions are not durably recorded.
- **Compliance failure**: Security audits for key management require append-only audit logs. The current `console.log` approach fails any reasonable audit.
- **Tamper detection**: Without hash-chaining, even if logs were durably stored, an attacker with DO storage access could modify historical entries.

## Proposed Fix

### 1. Create a TransparencyLog utility

```javascript
// packages/server/src/utils/transparency-log.js

export class TransparencyLog {
  constructor(storage, prefix = 'audit-log') {
    this.storage = storage;
    this.prefix = prefix;
  }

  async append(entry) {
    const seqKey = `${this.prefix}:meta:sequence`;
    const meta = await this.storage.get(seqKey) || { sequence: 0, lastHash: 'genesis' };

    const sequence = meta.sequence + 1;
    const logEntry = {
      sequence,
      timestamp: Date.now(),
      previousHash: meta.lastHash,
      ...entry,
    };

    // Hash the entry for chaining
    const entryBytes = new TextEncoder().encode(JSON.stringify(logEntry));
    const hashBuffer = await crypto.subtle.digest('SHA-256', entryBytes);
    const entryHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    logEntry.entryHash = entryHash;

    // Store the log entry
    const key = `${this.prefix}:${String(sequence).padStart(8, '0')}`;
    await this.storage.put(key, logEntry);

    // Update sequence metadata
    await this.storage.put(seqKey, { sequence, lastHash: entryHash });

    return logEntry;
  }

  async getEntries(fromSequence = 0, limit = 100) {
    const entries = [];
    const results = await this.storage.list({
      prefix: `${this.prefix}:`,
      limit: limit + 1, // +1 for meta key
    });
    for (const [key, value] of results) {
      if (key.startsWith(`${this.prefix}:meta:`)) continue;
      if (value.sequence >= fromSequence) {
        entries.push(value);
      }
    }
    return entries;
  }

  async verify() {
    const entries = await this.getEntries(0, 10000);
    let prevHash = 'genesis';
    for (const entry of entries) {
      if (entry.previousHash !== prevHash) {
        return { valid: false, brokenAt: entry.sequence };
      }
      // Recompute hash
      const { entryHash, ...rest } = entry;
      const bytes = new TextEncoder().encode(JSON.stringify({ ...rest, entryHash: undefined }));
      // ... verify hash matches
      prevHash = entry.entryHash;
    }
    return { valid: true, entries: entries.length };
  }
}
```

### 2. Log key changes in setTrustedKeys

```javascript
// In setTrustedKeys handler, before the final response:
const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
await auditLog.append({
  action: 'trusted_keys_updated',
  mode: Array.isArray(body.keys) ? 'replace' : (body.addKeys ? 'add' : 'remove'),
  previousKeyCount: currentKeys.length,
  newKeyCount: finalKeys.length,
  addedKeys: Array.isArray(body.addKeys) ? body.addKeys : [],
  removedKeys: Array.isArray(body.removeKeys) ? body.removeKeys : [],
  ip: request.headers.get('CF-Connecting-IP'),
  keySetHash: await computeKeySetHash(finalKeys),
});
```

### 3. Add audit log read endpoint

```javascript
// GET /servers/trusted-keys/audit-log (authenticated with CI_UPLOAD_SECRET)
if (request.method === 'GET' && url.pathname === '/servers/trusted-keys/audit-log') {
  if (!this.verifyCIAuth(request)) { /* 401 */ }
  const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
  const fromSeq = parseInt(url.searchParams.get('from') || '0', 10);
  const entries = await auditLog.getEntries(fromSeq, 100);
  return this.jsonResponse({ entries, verified: await auditLog.verify() });
}
```

## Acceptance Criteria

- [ ] Every key management operation (add, remove, replace) creates an append-only log entry in DO storage
- [ ] Each log entry includes: sequence number, timestamp, action, actor IP, previous hash, key set delta
- [ ] Log entries are hash-chained (each entry references the hash of the previous entry)
- [ ] A `GET /servers/trusted-keys/audit-log` endpoint returns the full log (authenticated)
- [ ] A verification endpoint or response field confirms the hash chain integrity
- [ ] Log entries survive DO hibernation and isolate eviction (they are in DO storage, not memory)
- [ ] Failed authentication attempts are also logged in the transparency log
- [ ] Build verification outcomes (pass/fail) for each server registration are logged
- [ ] Log retention is at least 1 year (no automatic cleanup of audit entries)

## Test Requirements

1. **Append test**: Perform 3 key changes, verify 3 log entries with correct sequence numbers
2. **Hash chain test**: Verify `entry[n].previousHash === entry[n-1].entryHash`
3. **Tamper detection**: Modify a middle entry, verify `verify()` reports the break point
4. **Read pagination**: Create 200 entries, verify `getEntries(100, 50)` returns entries 100-149
5. **Failed auth logging**: Submit an unauthorized key change, verify it appears in the audit log
6. **Concurrent append**: Two rapid key changes, verify they get sequential numbers (DO serialization)

## Dependencies

- Related: Story 012 (Key Expiry) -- key metadata from Story 012 should be included in audit log entries
- Related: Story 016 (SLSA Build Provenance) -- provenance metadata complements the key audit trail
- Depends on: None
