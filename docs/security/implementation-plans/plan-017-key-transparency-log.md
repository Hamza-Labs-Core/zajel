# Implementation Plan: Story 017 - Transparency Log for Key Changes

## Summary

Implement an append-only, hash-chained transparency log for all trusted build key management operations in the ServerRegistry Durable Object. Currently, key changes (add, remove, replace) are logged only to `console.log`, which is ephemeral and provides no durable forensic trail. This plan adds a tamper-evident audit log stored in DO storage, with hash-chaining for integrity verification and a new authenticated endpoint to retrieve the log.

**Key Goals:**
- Create a reusable `TransparencyLog` utility class for append-only logging
- Log all key management operations (add, remove, replace, read attempts)
- Include actor IP, timestamp, sequence number, key deltas, and hash chaining
- Add `GET /servers/trusted-keys/audit-log` endpoint for retrieving the log
- Support log verification to detect tampering
- Maintain backward compatibility with existing key management endpoints

## Files to Modify

### 1. New File: `/home/meywd/zajel-ddos/packages/server/src/utils/transparency-log.js`
**Purpose:** Reusable append-only log with hash-chaining for tamper detection

### 2. Modified: `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`
**Lines affected:**
- Lines 897-978: `setTrustedKeys` - Add audit logging after key updates
- Lines 986-1032: `getTrustedKeys` - Add audit logging for successful reads
- Lines 906-909: Failed auth logging - Add to transparency log
- Lines 438-446: Route handlers - Add new audit-log endpoint
**New additions:**
- Import `TransparencyLog` utility
- New route handler for `GET /servers/trusted-keys/audit-log`
- Helper function `computeKeySetHash` for key set fingerprinting

### 3. New Test File: `/home/meywd/zajel-ddos/packages/server/tests/unit/transparency-log.test.js`
**Purpose:** Unit tests for `TransparencyLog` class

### 4. Modified: `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`
**Lines affected:**
- Add new test suite for audit log functionality (append to end)

## Implementation Steps

### Step 1: Create TransparencyLog Utility

**File:** `/home/meywd/zajel-ddos/packages/server/src/utils/transparency-log.js`

```javascript
/**
 * Append-only transparency log with hash-chaining.
 *
 * Provides tamper-evident audit logging in Cloudflare Durable Object storage.
 * Each entry is assigned a sequential number and includes the hash of the
 * previous entry, creating a verifiable chain.
 *
 * Storage schema:
 * - `{prefix}:meta:sequence` → { sequence: number, lastHash: string }
 * - `{prefix}:{sequence}` → { ...entry, previousHash, entryHash }
 */

/**
 * TransparencyLog provides append-only, hash-chained audit logging.
 */
export class TransparencyLog {
  /**
   * @param {DurableObjectStorage} storage - Durable Object storage instance
   * @param {string} prefix - Key prefix for log entries (default: 'audit-log')
   */
  constructor(storage, prefix = 'audit-log') {
    this.storage = storage;
    this.prefix = prefix;
  }

  /**
   * Append a new entry to the log.
   *
   * @param {object} entry - Log entry data (action, ip, etc.)
   * @returns {Promise<object>} The complete log entry with sequence, hash, etc.
   */
  async append(entry) {
    const seqKey = `${this.prefix}:meta:sequence`;
    const meta = (await this.storage.get(seqKey)) || { sequence: 0, lastHash: 'genesis' };

    const sequence = meta.sequence + 1;
    const logEntry = {
      sequence,
      timestamp: Date.now(),
      previousHash: meta.lastHash,
      ...entry,
    };

    // Hash the entry (excluding entryHash field itself)
    const entryBytes = new TextEncoder().encode(JSON.stringify(logEntry));
    const hashBuffer = await crypto.subtle.digest('SHA-256', entryBytes);
    const entryHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    logEntry.entryHash = entryHash;

    // Store the log entry with zero-padded sequence number
    const key = `${this.prefix}:${String(sequence).padStart(8, '0')}`;
    await this.storage.put(key, logEntry);

    // Update sequence metadata
    await this.storage.put(seqKey, { sequence, lastHash: entryHash });

    return logEntry;
  }

  /**
   * Retrieve log entries starting from a given sequence number.
   *
   * @param {number} fromSequence - Start sequence (default: 0 = all entries)
   * @param {number} limit - Maximum entries to return (default: 100)
   * @returns {Promise<object[]>} Array of log entries, sorted by sequence
   */
  async getEntries(fromSequence = 0, limit = 100) {
    const entries = [];
    const results = await this.storage.list({
      prefix: `${this.prefix}:`,
      limit: limit + 1, // +1 to account for potential meta key
    });

    for (const [key, value] of results) {
      if (key.startsWith(`${this.prefix}:meta:`)) continue;
      if (value.sequence >= fromSequence && entries.length < limit) {
        entries.push(value);
      }
    }

    // Sort by sequence (should already be sorted, but ensure it)
    return entries.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Verify the integrity of the log's hash chain.
   *
   * Recomputes hashes and checks that each entry's previousHash matches
   * the prior entry's entryHash.
   *
   * @returns {Promise<{ valid: boolean, entries: number, brokenAt?: number }>}
   */
  async verify() {
    const entries = await this.getEntries(0, 10000);
    let prevHash = 'genesis';

    for (const entry of entries) {
      // Check hash chain continuity
      if (entry.previousHash !== prevHash) {
        return { valid: false, entries: entries.length, brokenAt: entry.sequence };
      }

      // Recompute hash (excluding entryHash field)
      const { entryHash, ...rest } = entry;
      const bytes = new TextEncoder().encode(JSON.stringify(rest));
      const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
      const computedHash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      if (computedHash !== entryHash) {
        return { valid: false, entries: entries.length, brokenAt: entry.sequence };
      }

      prevHash = entry.entryHash;
    }

    return { valid: true, entries: entries.length };
  }

  /**
   * Get the current sequence number (0 if no entries).
   * @returns {Promise<number>}
   */
  async getCurrentSequence() {
    const seqKey = `${this.prefix}:meta:sequence`;
    const meta = await this.storage.get(seqKey);
    return meta ? meta.sequence : 0;
  }
}
```

### Step 2: Add Key Set Hashing Helper to ServerRegistryDO

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (line 143):**
```javascript
const BuildVerifier = {
  /**
   * Derive an AES-256-GCM key from CI_UPLOAD_SECRET via HKDF.
```

**After (insert before BuildVerifier, around line 143):**
```javascript
/**
 * Compute a SHA-256 hash of a key set for audit logging.
 * Keys are sorted before hashing to ensure deterministic output.
 * @param {string[]} keys - Array of base64 public keys
 * @returns {Promise<string>} Hex-encoded SHA-256 hash
 */
async function computeKeySetHash(keys) {
  const sorted = [...keys].sort();
  const keySetString = JSON.stringify(sorted);
  const bytes = new TextEncoder().encode(keySetString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const BuildVerifier = {
  /**
   * Derive an AES-256-GCM key from CI_UPLOAD_SECRET via HKDF.
```

### Step 3: Import TransparencyLog in ServerRegistryDO

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (lines 11-14):**
```javascript
import { getCorsHeaders } from '../cors.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';
import { parseJsonBody, BodyTooLargeError } from '../utils/request-validation.js';
import { createLogger } from '../logger.js';
```

**After:**
```javascript
import { getCorsHeaders } from '../cors.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';
import { parseJsonBody, BodyTooLargeError } from '../utils/request-validation.js';
import { createLogger } from '../logger.js';
import { TransparencyLog } from '../utils/transparency-log.js';
```

### Step 4: Add Audit Logging to setTrustedKeys

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (lines 905-913):**
```javascript
    if (!this.verifyCIAuth(request)) {
      this.logger.warn('[audit] Unauthorized trusted-keys update attempt', {
        action: 'trusted_keys_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
```

**After:**
```javascript
    if (!this.verifyCIAuth(request)) {
      this.logger.warn('[audit] Unauthorized trusted-keys update attempt', {
        action: 'trusted_keys_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });

      // Log failed auth to transparency log
      const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
      await auditLog.append({
        action: 'trusted_keys_update_failed',
        reason: 'unauthorized',
        ip: request.headers.get('CF-Connecting-IP'),
        userAgent: request.headers.get('User-Agent'),
      });

      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
```

**Before (lines 964-977):**
```javascript
    // Encrypt before storing
    const plainData = { keys: finalKeys, updatedAt: Date.now() };
    const stored = await BuildVerifier.encryptKeys(plainData, this.env.CI_UPLOAD_SECRET);
    await this.state.storage.put('trusted_build_keys', stored);

    this.logger.info('[audit] Trusted build keys updated', {
      action: 'trusted_keys_updated',
      keyCount: finalKeys.length,
    });

    return new Response(
      JSON.stringify({ success: true, keys: finalKeys }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
```

**After:**
```javascript
    // Encrypt before storing
    const plainData = { keys: finalKeys, updatedAt: Date.now() };
    const stored = await BuildVerifier.encryptKeys(plainData, this.env.CI_UPLOAD_SECRET);
    await this.state.storage.put('trusted_build_keys', stored);

    this.logger.info('[audit] Trusted build keys updated', {
      action: 'trusted_keys_updated',
      keyCount: finalKeys.length,
    });

    // Determine the operation mode and delta
    let mode = 'unknown';
    const addedKeys = [];
    const removedKeys = [];

    if (Array.isArray(body.keys)) {
      mode = 'replace';
      // For replace mode, calculate delta from current keys
      const currentSet = new Set(currentKeys);
      const finalSet = new Set(finalKeys);
      for (const k of finalKeys) {
        if (!currentSet.has(k)) addedKeys.push(k);
      }
      for (const k of currentKeys) {
        if (!finalSet.has(k)) removedKeys.push(k);
      }
    } else if (Array.isArray(body.addKeys)) {
      mode = 'add';
      addedKeys.push(...body.addKeys);
    } else if (Array.isArray(body.removeKeys)) {
      mode = 'remove';
      removedKeys.push(...body.removeKeys);
    }

    // Log to transparency log
    const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
    await auditLog.append({
      action: 'trusted_keys_updated',
      mode,
      previousKeyCount: currentKeys.length,
      newKeyCount: finalKeys.length,
      addedKeys,
      removedKeys,
      previousKeySetHash: await computeKeySetHash(currentKeys),
      newKeySetHash: await computeKeySetHash(finalKeys),
      ip: request.headers.get('CF-Connecting-IP'),
      userAgent: request.headers.get('User-Agent'),
    });

    return new Response(
      JSON.stringify({ success: true, keys: finalKeys }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
```

### Step 5: Add Audit Logging to getTrustedKeys

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (lines 994-1002):**
```javascript
    if (!this.verifyCIAuth(request)) {
      this.logger.warn('[audit] Unauthorized trusted-keys read attempt', {
        action: 'trusted_keys_read_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
```

**After:**
```javascript
    if (!this.verifyCIAuth(request)) {
      this.logger.warn('[audit] Unauthorized trusted-keys read attempt', {
        action: 'trusted_keys_read_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });

      // Log failed auth to transparency log
      const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
      await auditLog.append({
        action: 'trusted_keys_read_failed',
        reason: 'unauthorized',
        ip: request.headers.get('CF-Connecting-IP'),
        userAgent: request.headers.get('User-Agent'),
      });

      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
```

**Before (lines 1026-1032):**
```javascript
    }

    return new Response(
      JSON.stringify({ keys, updatedAt }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
```

**After:**
```javascript
    }

    // Log successful read to transparency log
    const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
    await auditLog.append({
      action: 'trusted_keys_read',
      keyCount: keys.length,
      keySetHash: await computeKeySetHash(keys),
      ip: request.headers.get('CF-Connecting-IP'),
      userAgent: request.headers.get('User-Agent'),
    });

    return new Response(
      JSON.stringify({ keys, updatedAt }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
```

### Step 6: Add Audit Log Retrieval Endpoint

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (lines 443-448):**
```javascript
      // GET /servers/trusted-keys - Read current trusted build keys (authenticated)
      if (request.method === 'GET' && url.pathname === '/servers/trusted-keys') {
        return await this.getTrustedKeys(request, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
```

**After:**
```javascript
      // GET /servers/trusted-keys - Read current trusted build keys (authenticated)
      if (request.method === 'GET' && url.pathname === '/servers/trusted-keys') {
        return await this.getTrustedKeys(request, corsHeaders);
      }

      // GET /servers/trusted-keys/audit-log - Read transparency log (authenticated)
      if (request.method === 'GET' && url.pathname === '/servers/trusted-keys/audit-log') {
        return await this.getKeyAuditLog(request, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
```

**Before (end of class, after getTrustedKeys method, around line 1032):**
```javascript
    return new Response(
      JSON.stringify({ keys, updatedAt }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
```

**After (add new method before closing brace):**
```javascript
    return new Response(
      JSON.stringify({ keys, updatedAt }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  /**
   * GET /servers/trusted-keys/audit-log
   *
   * Returns the transparency log of all key management operations.
   * Requires CI_UPLOAD_SECRET authentication.
   *
   * Query params:
   * - from: sequence number to start from (default: 0)
   * - limit: max entries to return (default: 100, max: 1000)
   * - verify: if 'true', include chain verification result
   */
  async getKeyAuditLog(request, corsHeaders) {
    if (!this.env.CI_UPLOAD_SECRET) {
      return new Response(
        JSON.stringify({ error: 'Audit log access not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (!this.verifyCIAuth(request)) {
      this.logger.warn('[audit] Unauthorized audit-log read attempt', {
        action: 'audit_log_read_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const url = new URL(request.url);
    const fromSeq = parseInt(url.searchParams.get('from') || '0', 10);
    const limit = Math.min(
      parseInt(url.searchParams.get('limit') || '100', 10),
      1000
    );
    const shouldVerify = url.searchParams.get('verify') === 'true';

    const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
    const entries = await auditLog.getEntries(fromSeq, limit);
    const currentSequence = await auditLog.getCurrentSequence();

    const response = {
      entries,
      count: entries.length,
      currentSequence,
      hasMore: entries.length === limit,
    };

    if (shouldVerify) {
      response.verification = await auditLog.verify();
    }

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
```

## Test Plan

### Unit Tests for TransparencyLog

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/transparency-log.test.js`

```javascript
/**
 * TransparencyLog Unit Tests
 *
 * Tests for the append-only audit log with hash-chaining.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TransparencyLog } from '../../src/utils/transparency-log.js';

class MockStorage {
  constructor() {
    this.data = new Map();
  }
  async get(key) { return this.data.get(key); }
  async put(key, value) { this.data.set(key, value); }
  async list({ prefix, limit }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix) && results.size < (limit || Infinity)) {
        results.set(key, value);
      }
    }
    return results;
  }
  clear() { this.data.clear(); }
}

describe('TransparencyLog', () => {
  let storage;
  let log;

  beforeEach(() => {
    storage = new MockStorage();
    log = new TransparencyLog(storage, 'test-audit');
  });

  describe('append', () => {
    it('should append first entry with genesis hash', async () => {
      const entry = await log.append({
        action: 'test_action',
        data: 'test_data',
      });

      expect(entry.sequence).toBe(1);
      expect(entry.previousHash).toBe('genesis');
      expect(entry.entryHash).toBeTruthy();
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(entry.action).toBe('test_action');
    });

    it('should chain subsequent entries', async () => {
      const entry1 = await log.append({ action: 'first' });
      const entry2 = await log.append({ action: 'second' });

      expect(entry2.sequence).toBe(2);
      expect(entry2.previousHash).toBe(entry1.entryHash);
    });

    it('should increment sequence numbers correctly', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      const entry3 = await log.append({ action: 'c' });

      expect(entry3.sequence).toBe(3);
    });

    it('should store entry with zero-padded key', async () => {
      await log.append({ action: 'test' });

      const raw = await storage.get('test-audit:00000001');
      expect(raw).toBeTruthy();
      expect(raw.sequence).toBe(1);
    });
  });

  describe('getEntries', () => {
    it('should return empty array for empty log', async () => {
      const entries = await log.getEntries();
      expect(entries).toEqual([]);
    });

    it('should return all entries by default', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      await log.append({ action: 'c' });

      const entries = await log.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].action).toBe('a');
      expect(entries[2].action).toBe('c');
    });

    it('should respect fromSequence parameter', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      await log.append({ action: 'c' });

      const entries = await log.getEntries(2);
      expect(entries).toHaveLength(2);
      expect(entries[0].sequence).toBe(2);
      expect(entries[1].sequence).toBe(3);
    });

    it('should respect limit parameter', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      await log.append({ action: 'c' });

      const entries = await log.getEntries(0, 2);
      expect(entries).toHaveLength(2);
    });

    it('should exclude meta keys from results', async () => {
      await log.append({ action: 'test' });
      const entries = await log.getEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('test');
    });
  });

  describe('verify', () => {
    it('should verify valid chain', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      await log.append({ action: 'c' });

      const result = await log.verify();
      expect(result.valid).toBe(true);
      expect(result.entries).toBe(3);
      expect(result.brokenAt).toBeUndefined();
    });

    it('should detect broken chain (tampered previousHash)', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });

      // Tamper with entry 2's previousHash
      const entry2 = await storage.get('test-audit:00000002');
      entry2.previousHash = 'tampered-hash';
      await storage.put('test-audit:00000002', entry2);

      const result = await log.verify();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('should detect tampered entry content', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });

      // Tamper with entry 2's action (but keep hashes)
      const entry2 = await storage.get('test-audit:00000002');
      entry2.action = 'tampered-action';
      await storage.put('test-audit:00000002', entry2);

      const result = await log.verify();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('should verify empty log', async () => {
      const result = await log.verify();
      expect(result.valid).toBe(true);
      expect(result.entries).toBe(0);
    });
  });

  describe('getCurrentSequence', () => {
    it('should return 0 for empty log', async () => {
      const seq = await log.getCurrentSequence();
      expect(seq).toBe(0);
    });

    it('should return current sequence after appends', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });

      const seq = await log.getCurrentSequence();
      expect(seq).toBe(2);
    });
  });
});
```

### Integration Tests for Audit Log Endpoint

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Add to end of file (before closing):**

```javascript
  describe('Transparency Log for Key Management', () => {
    it('should log key updates to transparency log', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Upload keys
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));

      // Read audit log
      const response = await registry.fetch(
        createRequest('GET', '/servers/trusted-keys/audit-log', null, authHeaders)
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].action).toBe('trusted_keys_updated');
      expect(data.entries[0].mode).toBe('replace');
      expect(data.entries[0].newKeyCount).toBe(1);
      expect(data.entries[0].previousHash).toBe('genesis');
    });

    it('should log failed auth attempts', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      // Attempt unauthorized update
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, {
        Authorization: 'Bearer wrong-secret',
      }));

      // Read audit log with correct auth
      const response = await registry.fetch(
        createRequest('GET', '/servers/trusted-keys/audit-log', null, {
          Authorization: 'Bearer ci-secret-123',
        })
      );
      const data = await response.json();

      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].action).toBe('trusted_keys_update_failed');
      expect(data.entries[0].reason).toBe('unauthorized');
    });

    it('should chain multiple operations in audit log', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Operation 1: Set initial keys
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));

      // Operation 2: Add another key
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        addKeys: [key2.publicKeyBase64],
      }, authHeaders));

      // Operation 3: Read keys
      await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));

      // Check audit log
      const response = await registry.fetch(
        createRequest('GET', '/servers/trusted-keys/audit-log', null, authHeaders)
      );
      const data = await response.json();

      expect(data.entries).toHaveLength(3);
      expect(data.entries[0].sequence).toBe(1);
      expect(data.entries[1].sequence).toBe(2);
      expect(data.entries[2].sequence).toBe(3);
      expect(data.entries[1].previousHash).toBe(data.entries[0].entryHash);
      expect(data.entries[2].previousHash).toBe(data.entries[1].entryHash);
    });

    it('should support pagination with from parameter', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Create 3 log entries
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));
      await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
      await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));

      // Read from sequence 2
      const response = await registry.fetch(
        createRequest('GET', '/servers/trusted-keys/audit-log?from=2', null, authHeaders)
      );
      const data = await response.json();

      expect(data.entries).toHaveLength(2);
      expect(data.entries[0].sequence).toBe(2);
    });

    it('should verify log integrity on request', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Create entries
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));

      // Read with verification
      const response = await registry.fetch(
        createRequest('GET', '/servers/trusted-keys/audit-log?verify=true', null, authHeaders)
      );
      const data = await response.json();

      expect(data.verification).toBeTruthy();
      expect(data.verification.valid).toBe(true);
      expect(data.verification.entries).toBeGreaterThan(0);
    });

    it('should include key deltas in audit log', async () => {
      const key2 = await generateTestKeypair();
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Set initial keys
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));

      // Add a key
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        addKeys: [key2.publicKeyBase64],
      }, authHeaders));

      // Read audit log
      const response = await registry.fetch(
        createRequest('GET', '/servers/trusted-keys/audit-log', null, authHeaders)
      );
      const data = await response.json();

      const addEntry = data.entries.find(e => e.mode === 'add');
      expect(addEntry.addedKeys).toContain(key2.publicKeyBase64);
      expect(addEntry.removedKeys).toEqual([]);
    });

    it('should reject audit log access without auth', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });

      const response = await registry.fetch(
        createRequest('GET', '/servers/trusted-keys/audit-log')
      );

      expect(response.status).toBe(401);
    });

    it('should return 503 when CI_UPLOAD_SECRET not configured', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const response = await registry.fetch(
        createRequest('GET', '/servers/trusted-keys/audit-log')
      );

      expect(response.status).toBe(503);
    });
  });
```

### Manual Testing Checklist

1. **Append Test**: Perform 3 key changes (add, replace, remove), verify 3 log entries with correct sequence numbers
2. **Hash Chain Test**: Verify `entry[n].previousHash === entry[n-1].entryHash` for all entries
3. **Tamper Detection Test**: Manually modify a middle entry in DO storage, verify `verify=true` reports the break point
4. **Pagination Test**: Create 200 entries, verify `from=100&limit=50` returns entries 100-149
5. **Failed Auth Logging Test**: Submit an unauthorized key change, verify it appears in the audit log
6. **Concurrent Append Test**: Two rapid key changes via concurrent requests, verify they get sequential numbers (DO serialization ensures this)
7. **IP and User-Agent Test**: Verify audit log entries include `CF-Connecting-IP` header and `User-Agent`
8. **Key Delta Accuracy Test**: Replace keys A,B with B,C, verify audit shows added=[C], removed=[A]

## Rollback Risk

**Risk Level:** LOW

**Rollback Strategy:**
1. The transparency log is purely additive - it doesn't modify any existing behavior
2. Key management operations continue to work exactly as before if `TransparencyLog.append()` fails
3. The audit log endpoint is a new route - removing it doesn't affect existing functionality
4. To rollback: Simply revert the commit, no data migration needed (DO storage will retain logs harmlessly)

**Safe Rollback Guarantees:**
- No changes to the stored format of `trusted_build_keys` (still encrypted with AES-GCM)
- No changes to request/response formats of existing endpoints
- New audit log entries are stored with a distinct prefix (`key-audit:`) - won't conflict with existing data
- If rollback is needed, old audit log entries remain in storage but become inaccessible (acceptable)

**Mitigation for Append Failures:**
- Wrap `auditLog.append()` calls in try-catch to prevent audit failures from blocking key operations
- Log append failures to console for monitoring
- Consider adding error handling in TransparencyLog for storage quota exhaustion

## Dependencies on Other Stories

### Dependencies (must be completed before this)
- **None** - This story is self-contained

### Related Stories (should coordinate with)
- **Story 012 (Key Expiry/Cryptoperiod)**: When key expiry metadata is added, include it in audit log entries (e.g., `expiresAt`, `notBefore`)
- **Story 016 (SLSA Build Provenance)**: Provenance metadata complements the key audit trail. Could add provenance hash to build verification log entries

### Enables (can be completed after this)
- **Story 009 (Key Read Audit Log)**: This story already implements read audit logging, so Story 009 may be partially addressed
- Future stories that require forensic investigation of key operations

### Integration Points
- The `computeKeySetHash()` helper can be reused by other components that need to fingerprint key sets
- The `TransparencyLog` utility can be reused for other audit logging needs (e.g., server registration audit, attestation operations)
- Consider extracting TransparencyLog to `@zajel/common` if web-client or VPS server need similar logging

## Post-Implementation Validation

### Acceptance Criteria Verification
- [ ] Every key management operation (add, remove, replace) creates an append-only log entry
- [ ] Each log entry includes: sequence number, timestamp, action, actor IP, previous hash, key set delta
- [ ] Log entries are hash-chained (each entry references the hash of the previous entry)
- [ ] `GET /servers/trusted-keys/audit-log` endpoint returns the full log (authenticated)
- [ ] `?verify=true` parameter confirms the hash chain integrity
- [ ] Log entries survive DO hibernation and isolate eviction (stored in DO storage, not memory)
- [ ] Failed authentication attempts are logged in the transparency log
- [ ] Build verification outcomes are logged (covered by existing logging at line 590-598)
- [ ] Log retention: No automatic cleanup implemented (entries persist indefinitely)

### Performance Checks
- [ ] Measure DO storage usage growth rate (estimate: ~1KB per key operation)
- [ ] Test audit log retrieval with 1000+ entries (should complete under 500ms)
- [ ] Verify that `append()` doesn't add more than 50ms to key update operations

### Monitoring & Observability
- [ ] Add CloudWatch/Logpush metrics for audit log append failures
- [ ] Monitor DO storage quota (current limit: 128MB per DO, audit log uses ~1KB per entry = 128K entries max)
- [ ] Alert on hash chain verification failures

### Documentation Updates
- [ ] Update API documentation to include `/servers/trusted-keys/audit-log` endpoint
- [ ] Document audit log schema and hash chain verification
- [ ] Add runbook for investigating key management incidents using audit log
- [ ] Update security compliance documentation to reflect audit trail implementation
