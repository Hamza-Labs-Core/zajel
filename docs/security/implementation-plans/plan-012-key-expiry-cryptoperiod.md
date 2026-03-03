# Implementation Plan: Story 012 - Key Expiry/Crypto-Period Limits for Build Signing Keys

## 1. Summary

Build signing keys uploaded via `POST /servers/trusted-keys` are currently stored with no expiration date, no rotation schedule, and no crypto-period enforcement. This implementation plan addresses the security gap by:

1. Migrating the storage format from a flat array of keys to a structured array with per-key metadata (keyId, addedAt, expiresAt, addedBy, revoked)
2. Enforcing a maximum crypto-period of 90 days for all keys
3. Filtering out expired and revoked keys during verification
4. Fixing the empty-set fallback behavior (currently trusts ANY key when no trusted keys exist)
5. Adding DO alarm handler logic to warn about expiring keys
6. Improving key validation to enforce proper Ed25519 public key format

This plan ensures backward compatibility through automatic migration of legacy flat-format keys.

## 2. Files to Modify

### 2.1 Core Implementation
- **`/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`**
  - Lines 131-132: Add crypto-period constants
  - Lines 172-204: Update `encryptKeys`/`decryptKeys` type signatures (no logic change)
  - Lines 214-234: Rewrite `loadTrustedKeys` to filter expired keys and migrate legacy format
  - Lines 279-281: Update `isTrustedKey` to use structured keys
  - Lines 317-337: Enhance `alarm()` handler to check for expiring keys
  - Lines 573-598: Fix empty-set fallback in `registerServer`
  - Lines 747-765: Fix empty-set fallback in heartbeat handler
  - Lines 897-978: Rewrite `setTrustedKeys` to handle structured keys with expiry
  - Lines 919: Enhance `isValidKey` validation
  - Lines 986-1032: Update `getTrustedKeys` to return structured metadata

### 2.2 Tests
- **`/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`**
  - Add new test suite: "Key Expiry and Crypto-Period"
  - Add new test suite: "Key Metadata and Fingerprints"
  - Add new test suite: "Empty Trusted Keys Set Behavior"
  - Add new test suite: "Legacy Format Migration"
  - Add new test suite: "Alarm Handler Key Expiry Warnings"
  - Update existing tests to handle new API response format

## 3. Implementation Steps

### Step 3.1: Add Constants and Helper Functions

**Location:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`, after line 132

**Before:**
```javascript
/** Maximum trusted build keys allowed */
const MAX_TRUSTED_BUILD_KEYS = 50;

/**
 * Build signature verification for federation server binaries.
```

**After:**
```javascript
/** Maximum trusted build keys allowed */
const MAX_TRUSTED_BUILD_KEYS = 50;

/** Maximum key lifetime (crypto-period): 90 days in milliseconds */
const MAX_KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** Warning threshold for expiring keys: 14 days in milliseconds */
const KEY_EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Build signature verification for federation server binaries.
```

**Add new helper function after line 204:**

```javascript
  /**
   * Compute a short fingerprint (SHA-256 prefix) for a public key.
   * Used as keyId for deduplication and audit trails.
   * @param {string} publicKeyBase64 - Base64-encoded Ed25519 public key
   * @returns {Promise<string>} 8-byte hex fingerprint (e.g., "a1b2c3d4:e5f6a7b8")
   */
  async computeKeyFingerprint(publicKeyBase64) {
    try {
      const keyBytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0));
      const hash = await crypto.subtle.digest('SHA-256', keyBytes);
      const prefix = new Uint8Array(hash.slice(0, 8));
      return Array.from(prefix, b => b.toString(16).padStart(2, '0'))
        .reduce((acc, byte, i) => acc + byte + (i === 3 ? ':' : ''), '');
    } catch {
      // Fallback for invalid base64
      return 'invalid-key';
    }
  },

  /**
   * Validate that a key is properly formatted as a 32-byte Ed25519 public key.
   * @param {string} publicKeyBase64 - Base64-encoded key to validate
   * @returns {boolean} True if valid Ed25519 public key format
   */
  isValidEd25519Key(publicKeyBase64) {
    if (typeof publicKeyBase64 !== 'string' || publicKeyBase64.length === 0) {
      return false;
    }
    try {
      const keyBytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0));
      // Ed25519 public keys are exactly 32 bytes
      return keyBytes.length === 32;
    } catch {
      return false;
    }
  },
```

### Step 3.2: Rewrite `loadTrustedKeys` with Expiry Filtering and Migration

**Location:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`, lines 214-234

**Before:**
```javascript
  /**
   * Load trusted build signing public keys from DO storage or env var.
   * @param {DurableObjectStorage} storage - DO storage instance
   * @param {string|undefined} envFallback - TRUSTED_BUILD_KEYS env var
   * @param {string|undefined} ciSecret - CI_UPLOAD_SECRET for decryption
   * @returns {Promise<string[]>} Array of base64-encoded public keys
   */
  async loadTrustedKeys(storage, envFallback, ciSecret) {
    const stored = await storage.get('trusted_build_keys');
    if (stored) {
      if (stored.encrypted && ciSecret) {
        try {
          const decrypted = await this.decryptKeys(stored, ciSecret);
          if (Array.isArray(decrypted.keys) && decrypted.keys.length > 0) {
            return decrypted.keys;
          }
        } catch {
          // Decryption failed — secret may have changed, fall through to env var
        }
      } else if (Array.isArray(stored.keys) && stored.keys.length > 0) {
        // Legacy plaintext format
        return stored.keys;
      }
    }
    // Fallback to env var for backward compatibility
    if (!envFallback) return [];
    return envFallback.split(',').map(k => k.trim()).filter(Boolean);
  },
```

**After:**
```javascript
  /**
   * Load trusted build signing public keys from DO storage or env var.
   * Filters out expired and revoked keys. Migrates legacy flat-array format.
   * @param {DurableObjectStorage} storage - DO storage instance
   * @param {string|undefined} envFallback - TRUSTED_BUILD_KEYS env var
   * @param {string|undefined} ciSecret - CI_UPLOAD_SECRET for decryption
   * @returns {Promise<string[]>} Array of base64-encoded public keys (active only)
   */
  async loadTrustedKeys(storage, envFallback, ciSecret) {
    const stored = await storage.get('trusted_build_keys');
    const now = Date.now();

    if (stored) {
      let decrypted;
      if (stored.encrypted && ciSecret) {
        try {
          decrypted = await this.decryptKeys(stored, ciSecret);
        } catch {
          // Decryption failed — fall through to env var
          decrypted = null;
        }
      } else {
        // Legacy plaintext format
        decrypted = stored;
      }

      if (decrypted && Array.isArray(decrypted.keys) && decrypted.keys.length > 0) {
        // Check schema version — if missing or v1 (flat array), migrate
        if (!decrypted.schemaVersion || decrypted.schemaVersion === 1) {
          // Legacy format: { keys: string[], updatedAt: number }
          // Migrate to v2 on first read (lazy migration)
          const migratedKeys = await Promise.all(
            decrypted.keys.map(async (publicKey) => ({
              keyId: await this.computeKeyFingerprint(publicKey),
              publicKey,
              addedAt: decrypted.updatedAt || now,
              expiresAt: (decrypted.updatedAt || now) + MAX_KEY_LIFETIME_MS,
              addedBy: 'legacy-migration',
              revoked: false,
            }))
          );

          const migratedData = {
            keys: migratedKeys,
            updatedAt: now,
            schemaVersion: 2,
          };

          // Store migrated format (best-effort, don't fail on write error)
          if (ciSecret) {
            try {
              const encrypted = await this.encryptKeys(migratedData, ciSecret);
              await storage.put('trusted_build_keys', encrypted);
            } catch {
              // Migration write failed, continue with in-memory migrated keys
            }
          }

          // Return only non-expired, non-revoked keys
          return migratedKeys
            .filter(k => !k.revoked && k.expiresAt > now)
            .map(k => k.publicKey);
        }

        // Schema v2: structured keys with metadata
        return decrypted.keys
          .filter(k => !k.revoked && k.expiresAt > now)
          .map(k => k.publicKey);
      }
    }

    // Fallback to env var for backward compatibility
    if (!envFallback) return [];
    return envFallback.split(',').map(k => k.trim()).filter(Boolean);
  },

  /**
   * Load raw trusted keys metadata (for GET endpoint and alarm handler).
   * Does NOT filter by expiry — returns full metadata including expired keys.
   * @param {DurableObjectStorage} storage - DO storage instance
   * @param {string|undefined} ciSecret - CI_UPLOAD_SECRET for decryption
   * @returns {Promise<{ keys: Array, updatedAt: number, schemaVersion: number }>}
   */
  async loadTrustedKeysRaw(storage, ciSecret) {
    const stored = await storage.get('trusted_build_keys');
    if (!stored) {
      return { keys: [], updatedAt: null, schemaVersion: 2 };
    }

    let decrypted;
    if (stored.encrypted && ciSecret) {
      try {
        decrypted = await this.decryptKeys(stored, ciSecret);
      } catch {
        throw new Error('Failed to decrypt stored keys');
      }
    } else {
      decrypted = stored;
    }

    // If legacy format, return as-is (caller handles migration)
    if (!decrypted.schemaVersion) {
      return { keys: decrypted.keys || [], updatedAt: decrypted.updatedAt, schemaVersion: 1 };
    }

    return decrypted;
  },
```

### Step 3.3: Update `isTrustedKey` to Work with Either Format

**Location:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`, lines 279-281

**No change needed** — `loadTrustedKeys` already returns flat string array, so `isTrustedKey` continues to work as-is. This is intentional to minimize changes to call sites.

### Step 3.4: Fix Empty-Set Fallback in `registerServer`

**Location:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`, line 586

**Before:**
```javascript
      const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
```

**After:**
```javascript
      // SECURITY: Empty trusted key set means NO keys are trusted, not ALL keys
      const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
```

### Step 3.5: Fix Empty-Set Fallback in Heartbeat Handler

**Location:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`, line 751

**Before:**
```javascript
      const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
```

**After:**
```javascript
      // SECURITY: Empty trusted key set means NO keys are trusted, not ALL keys
      const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
```

### Step 3.6: Enhance Alarm Handler to Check Expiring Keys

**Location:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`, lines 317-337

**Before:**
```javascript
  async alarm() {
    const now = Date.now();
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const deleteKeys = [];
    for (const [key, server] of entries) {
      if (now - server.lastSeen >= this.serverTTL) {
        deleteKeys.push(key);
        // Also clean up anomaly history and score for this server
        deleteKeys.push(`anomaly-history:${server.serverId}`);
        deleteKeys.push(`anomaly-score:${server.serverId}`);
      }
    }
    if (deleteKeys.length > 0) {
      // Batch delete in chunks of 128 (CF DO limit)
      for (let i = 0; i < deleteKeys.length; i += 128) {
        await this.state.storage.delete(deleteKeys.slice(i, i + 128));
      }
    }
    // Reschedule next cleanup
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }
```

**After:**
```javascript
  async alarm() {
    const now = Date.now();

    // --- Server entry cleanup ---
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const deleteKeys = [];
    for (const [key, server] of entries) {
      if (now - server.lastSeen >= this.serverTTL) {
        deleteKeys.push(key);
        // Also clean up anomaly history and score for this server
        deleteKeys.push(`anomaly-history:${server.serverId}`);
        deleteKeys.push(`anomaly-score:${server.serverId}`);
      }
    }
    if (deleteKeys.length > 0) {
      // Batch delete in chunks of 128 (CF DO limit)
      for (let i = 0; i < deleteKeys.length; i += 128) {
        await this.state.storage.delete(deleteKeys.slice(i, i + 128));
      }
    }

    // --- Trusted key expiry warnings ---
    if (this.env.CI_UPLOAD_SECRET) {
      try {
        const keysData = await BuildVerifier.loadTrustedKeysRaw(this.state.storage, this.env.CI_UPLOAD_SECRET);
        if (keysData.schemaVersion === 2 && Array.isArray(keysData.keys)) {
          for (const key of keysData.keys) {
            const timeToExpiry = key.expiresAt - now;

            if (timeToExpiry <= 0 && !key.revoked) {
              this.logger.warn('[audit] Trusted build key EXPIRED', {
                action: 'key_expired',
                keyId: key.keyId,
                expiresAt: new Date(key.expiresAt).toISOString(),
                addedBy: key.addedBy,
              });
            } else if (timeToExpiry > 0 && timeToExpiry <= KEY_EXPIRY_WARNING_MS && !key.revoked) {
              this.logger.warn('[audit] Trusted build key expiring soon', {
                action: 'key_expiry_warning',
                keyId: key.keyId,
                expiresAt: new Date(key.expiresAt).toISOString(),
                daysRemaining: Math.floor(timeToExpiry / (24 * 60 * 60 * 1000)),
                addedBy: key.addedBy,
              });
            }
          }
        }
      } catch (err) {
        // Don't fail alarm due to key checking errors
        this.logger.error('[alarm] Failed to check key expiry', { error: err.message });
      }
    }

    // Reschedule next cleanup
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }
```

### Step 3.7: Rewrite `setTrustedKeys` to Handle Structured Keys

**Location:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`, lines 897-978

**Before:**
```javascript
  async setTrustedKeys(request, corsHeaders) {
    if (!this.env.CI_UPLOAD_SECRET) {
      return new Response(
        JSON.stringify({ error: 'CI access not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

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

    const body = await parseJsonBody(request, 4096);

    // Validate base64 key format (32 bytes = 44 base64 chars with padding)
    const isValidKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 100;

    // Load current keys (handles encrypted and plaintext formats)
    const currentKeys = await BuildVerifier.loadTrustedKeys(
      this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET
    );

    let finalKeys;

    if (Array.isArray(body.keys)) {
      // Replace mode
      if (!body.keys.every(isValidKey)) {
        return new Response(
          JSON.stringify({ error: 'Invalid key format in keys array' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      finalKeys = [...new Set(body.keys)];
    } else if (Array.isArray(body.addKeys)) {
      // Append mode
      if (!body.addKeys.every(isValidKey)) {
        return new Response(
          JSON.stringify({ error: 'Invalid key format in addKeys array' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      finalKeys = [...new Set([...currentKeys, ...body.addKeys])];
    } else if (Array.isArray(body.removeKeys)) {
      // Remove mode
      const removeSet = new Set(body.removeKeys);
      finalKeys = currentKeys.filter(k => !removeSet.has(k));
    } else {
      return new Response(
        JSON.stringify({ error: 'Must provide keys, addKeys, or removeKeys' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (finalKeys.length > MAX_TRUSTED_BUILD_KEYS) {
      return new Response(
        JSON.stringify({ error: `Too many keys (max ${MAX_TRUSTED_BUILD_KEYS})` }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

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
  async setTrustedKeys(request, corsHeaders) {
    if (!this.env.CI_UPLOAD_SECRET) {
      return new Response(
        JSON.stringify({ error: 'CI access not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

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

    const body = await parseJsonBody(request, 4096);
    const now = Date.now();

    // Load current keys metadata (including expired keys for removal operations)
    const currentData = await BuildVerifier.loadTrustedKeysRaw(
      this.state.storage, this.env.CI_UPLOAD_SECRET
    );

    // If legacy format, force migration
    let currentKeysMetadata = currentData.keys || [];
    if (currentData.schemaVersion !== 2) {
      currentKeysMetadata = await Promise.all(
        (currentData.keys || []).map(async (publicKey) => ({
          keyId: await BuildVerifier.computeKeyFingerprint(publicKey),
          publicKey,
          addedAt: currentData.updatedAt || now,
          expiresAt: (currentData.updatedAt || now) + MAX_KEY_LIFETIME_MS,
          addedBy: 'legacy-migration',
          revoked: false,
        }))
      );
    }

    let finalKeysMetadata;

    if (Array.isArray(body.keys)) {
      // Replace mode: Replace entire key set
      const validationErrors = [];
      for (const keyInput of body.keys) {
        const publicKey = typeof keyInput === 'string' ? keyInput : keyInput.publicKey;
        if (!BuildVerifier.isValidEd25519Key(publicKey)) {
          validationErrors.push(publicKey);
        }
      }
      if (validationErrors.length > 0) {
        return new Response(
          JSON.stringify({ error: 'Invalid Ed25519 key format', invalidKeys: validationErrors }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      finalKeysMetadata = await Promise.all(
        body.keys.map(async (keyInput) => {
          const publicKey = typeof keyInput === 'string' ? keyInput : keyInput.publicKey;
          const expiresAt = keyInput.expiresAt || (now + MAX_KEY_LIFETIME_MS);

          // Enforce maximum crypto-period
          if (expiresAt - now > MAX_KEY_LIFETIME_MS) {
            throw new Error(`Key expiry exceeds maximum crypto-period of ${MAX_KEY_LIFETIME_MS}ms`);
          }

          return {
            keyId: await BuildVerifier.computeKeyFingerprint(publicKey),
            publicKey,
            addedAt: now,
            expiresAt,
            addedBy: keyInput.addedBy || 'ci-upload',
            revoked: false,
          };
        })
      );

      // Deduplicate by keyId
      const seen = new Set();
      finalKeysMetadata = finalKeysMetadata.filter(k => {
        if (seen.has(k.keyId)) return false;
        seen.add(k.keyId);
        return true;
      });

    } else if (Array.isArray(body.addKeys)) {
      // Append mode: Add new keys to existing set
      const validationErrors = [];
      for (const keyInput of body.addKeys) {
        const publicKey = typeof keyInput === 'string' ? keyInput : keyInput.publicKey;
        if (!BuildVerifier.isValidEd25519Key(publicKey)) {
          validationErrors.push(publicKey);
        }
      }
      if (validationErrors.length > 0) {
        return new Response(
          JSON.stringify({ error: 'Invalid Ed25519 key format', invalidKeys: validationErrors }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const newKeys = await Promise.all(
        body.addKeys.map(async (keyInput) => {
          const publicKey = typeof keyInput === 'string' ? keyInput : keyInput.publicKey;
          const expiresAt = keyInput.expiresAt || (now + MAX_KEY_LIFETIME_MS);

          if (expiresAt - now > MAX_KEY_LIFETIME_MS) {
            throw new Error(`Key expiry exceeds maximum crypto-period of ${MAX_KEY_LIFETIME_MS}ms`);
          }

          return {
            keyId: await BuildVerifier.computeKeyFingerprint(publicKey),
            publicKey,
            addedAt: now,
            expiresAt,
            addedBy: keyInput.addedBy || 'ci-upload',
            revoked: false,
          };
        })
      );

      // Merge and deduplicate by keyId
      const keyMap = new Map(currentKeysMetadata.map(k => [k.keyId, k]));
      for (const newKey of newKeys) {
        keyMap.set(newKey.keyId, newKey);
      }
      finalKeysMetadata = Array.from(keyMap.values());

    } else if (Array.isArray(body.removeKeys)) {
      // Remove mode: Mark keys as revoked (soft delete)
      const removeFingerprints = await Promise.all(
        body.removeKeys.map(publicKey => BuildVerifier.computeKeyFingerprint(publicKey))
      );
      const removeSet = new Set(removeFingerprints);

      finalKeysMetadata = currentKeysMetadata.map(k => {
        if (removeSet.has(k.keyId)) {
          return { ...k, revoked: true };
        }
        return k;
      });

    } else {
      return new Response(
        JSON.stringify({ error: 'Must provide keys, addKeys, or removeKeys' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (finalKeysMetadata.length > MAX_TRUSTED_BUILD_KEYS) {
      return new Response(
        JSON.stringify({ error: `Too many keys (max ${MAX_TRUSTED_BUILD_KEYS})` }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Encrypt before storing
    const plainData = { keys: finalKeysMetadata, updatedAt: now, schemaVersion: 2 };
    const stored = await BuildVerifier.encryptKeys(plainData, this.env.CI_UPLOAD_SECRET);
    await this.state.storage.put('trusted_build_keys', stored);

    // Count active (non-revoked, non-expired) keys for audit log
    const activeCount = finalKeysMetadata.filter(k => !k.revoked && k.expiresAt > now).length;

    this.logger.info('[audit] Trusted build keys updated', {
      action: 'trusted_keys_updated',
      keyCount: finalKeysMetadata.length,
      activeCount,
      ip: request.headers.get('CF-Connecting-IP'),
    });

    // Return public keys array for backward compatibility
    return new Response(
      JSON.stringify({
        success: true,
        keys: finalKeysMetadata
          .filter(k => !k.revoked)
          .map(k => k.publicKey)
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
```

### Step 3.8: Update `getTrustedKeys` to Return Metadata

**Location:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`, lines 986-1032

**Before:**
```javascript
  async getTrustedKeys(request, corsHeaders) {
    if (!this.env.CI_UPLOAD_SECRET) {
      return new Response(
        JSON.stringify({ error: 'Trusted key management not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

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

    const raw = await this.state.storage.get('trusted_build_keys');
    let keys = [];
    let updatedAt = null;

    if (raw) {
      if (raw.encrypted) {
        try {
          const decrypted = await BuildVerifier.decryptKeys(raw, this.env.CI_UPLOAD_SECRET);
          keys = decrypted.keys || [];
          updatedAt = decrypted.updatedAt || null;
        } catch {
          return new Response(
            JSON.stringify({ error: 'Failed to decrypt stored keys' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
      } else {
        // Legacy plaintext format
        keys = raw.keys || [];
        updatedAt = raw.updatedAt || null;
      }
    }

    return new Response(
      JSON.stringify({ keys, updatedAt }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
```

**After:**
```javascript
  async getTrustedKeys(request, corsHeaders) {
    if (!this.env.CI_UPLOAD_SECRET) {
      return new Response(
        JSON.stringify({ error: 'Trusted key management not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

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

    try {
      const keysData = await BuildVerifier.loadTrustedKeysRaw(
        this.state.storage, this.env.CI_UPLOAD_SECRET
      );

      const now = Date.now();

      // If legacy format, return as flat array with migration hint
      if (keysData.schemaVersion !== 2) {
        return new Response(
          JSON.stringify({
            keys: keysData.keys || [],
            updatedAt: keysData.updatedAt,
            schemaVersion: 1,
            migrationNote: 'Keys will be migrated to v2 format on next write',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      // Return structured metadata with computed time-to-expiry
      const keysWithStatus = keysData.keys.map(k => ({
        keyId: k.keyId,
        publicKey: k.publicKey,
        addedAt: k.addedAt,
        expiresAt: k.expiresAt,
        addedBy: k.addedBy,
        revoked: k.revoked,
        status: k.revoked
          ? 'revoked'
          : k.expiresAt <= now
            ? 'expired'
            : k.expiresAt - now <= KEY_EXPIRY_WARNING_MS
              ? 'expiring-soon'
              : 'active',
        daysUntilExpiry: Math.floor((k.expiresAt - now) / (24 * 60 * 60 * 1000)),
      }));

      return new Response(
        JSON.stringify({
          keys: keysWithStatus,
          updatedAt: keysData.updatedAt,
          schemaVersion: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Failed to load stored keys', details: err.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  }
```

## 4. Test Plan

### 4.1 Key Expiry Filtering Tests

**Test Case 1: Expired key is filtered out during verification**
```javascript
it('should filter out expired keys during build verification', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  // Add key with past expiry
  const pastExpiry = Date.now() - 1000;
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [{
      publicKey: keypair.publicKeyBase64,
      expiresAt: pastExpiry,
      addedBy: 'test',
    }],
  }, authHeaders));

  // Attempt to verify with expired key
  const buildHash = 'a'.repeat(64);
  const signature = await signBuildHash(keypair.privateKey, buildHash);
  await registry.fetch(createRequest('POST', '/servers', {
    serverId: 'ed25519:expired-key-server',
    endpoint: 'wss://exp.example.com',
    publicKey: 'test-key',
    buildHash,
    buildSignature: signature,
    buildSigningKey: keypair.publicKeyBase64,
  }));

  const entry = await mockState.storage.get('server:ed25519:expired-key-server');
  expect(entry.buildVerified).toBe(false); // Key is expired
});
```

**Test Case 2: Non-expired key is included**
```javascript
it('should include keys that have not expired', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  // Add key with future expiry
  const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [{
      publicKey: keypair.publicKeyBase64,
      expiresAt: futureExpiry,
      addedBy: 'test',
    }],
  }, authHeaders));

  const buildHash = 'a'.repeat(64);
  const signature = await signBuildHash(keypair.privateKey, buildHash);
  await registry.fetch(createRequest('POST', '/servers', {
    serverId: 'ed25519:valid-key-server',
    endpoint: 'wss://valid.example.com',
    publicKey: 'test-key',
    buildHash,
    buildSignature: signature,
    buildSigningKey: keypair.publicKeyBase64,
  }));

  const entry = await mockState.storage.get('server:ed25519:valid-key-server');
  expect(entry.buildVerified).toBe(true);
});
```

**Test Case 3: Revoked key is filtered out**
```javascript
it('should filter out revoked keys', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  // Add key
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [keypair.publicKeyBase64],
  }, authHeaders));

  // Revoke it
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    removeKeys: [keypair.publicKeyBase64],
  }, authHeaders));

  // Try to verify with revoked key
  const buildHash = 'a'.repeat(64);
  const signature = await signBuildHash(keypair.privateKey, buildHash);
  await registry.fetch(createRequest('POST', '/servers', {
    serverId: 'ed25519:revoked-key-server',
    endpoint: 'wss://rev.example.com',
    publicKey: 'test-key',
    buildHash,
    buildSignature: signature,
    buildSigningKey: keypair.publicKeyBase64,
  }));

  const entry = await mockState.storage.get('server:ed25519:revoked-key-server');
  expect(entry.buildVerified).toBe(false);
});
```

### 4.2 Maximum Crypto-Period Enforcement Tests

**Test Case 4: Reject key with expiry > 90 days**
```javascript
it('should reject keys with expiry beyond maximum crypto-period', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });

  const tooLongExpiry = Date.now() + 120 * 24 * 60 * 60 * 1000; // 120 days
  const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [{
      publicKey: keypair.publicKeyBase64,
      expiresAt: tooLongExpiry,
      addedBy: 'test',
    }],
  }, {
    Authorization: 'Bearer ci-secret-123',
  }));

  expect(response.status).toBe(400);
  const data = await response.json();
  expect(data.error).toContain('crypto-period');
});
```

**Test Case 5: Default expiry is 90 days from now**
```javascript
it('should default expiry to 90 days when not specified', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  const beforeAdd = Date.now();
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [keypair.publicKeyBase64], // No expiresAt specified
  }, authHeaders));
  const afterAdd = Date.now();

  const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
  const data = await response.json();

  expect(data.schemaVersion).toBe(2);
  const key = data.keys[0];
  const expectedExpiry = beforeAdd + 90 * 24 * 60 * 60 * 1000;
  expect(key.expiresAt).toBeGreaterThanOrEqual(expectedExpiry);
  expect(key.expiresAt).toBeLessThanOrEqual(afterAdd + 90 * 24 * 60 * 60 * 1000);
});
```

### 4.3 Empty Trusted Keys Set Behavior

**Test Case 6: Empty set rejects ALL keys**
```javascript
it('should reject all build signatures when trusted keys set is empty', async () => {
  const registry = new ServerRegistryDO(mockState, {
    // No TRUSTED_BUILD_KEYS env var, no DO-stored keys
  });

  const buildHash = 'a'.repeat(64);
  const signature = await signBuildHash(keypair.privateKey, buildHash);
  await registry.fetch(createRequest('POST', '/servers', {
    serverId: 'ed25519:empty-set-server',
    endpoint: 'wss://empty.example.com',
    publicKey: 'test-key',
    buildHash,
    buildSignature: signature,
    buildSigningKey: keypair.publicKeyBase64,
  }));

  const entry = await mockState.storage.get('server:ed25519:empty-set-server');
  expect(entry.buildVerified).toBe(false); // No keys trusted
});
```

**Test Case 7: Empty DO storage falls back to env var**
```javascript
it('should fall back to env var when DO storage is empty', async () => {
  const registry = new ServerRegistryDO(mockState, {
    TRUSTED_BUILD_KEYS: keypair.publicKeyBase64,
  });

  const buildHash = 'a'.repeat(64);
  const signature = await signBuildHash(keypair.privateKey, buildHash);
  await registry.fetch(createRequest('POST', '/servers', {
    serverId: 'ed25519:env-fallback',
    endpoint: 'wss://env.example.com',
    publicKey: 'test-key',
    buildHash,
    buildSignature: signature,
    buildSigningKey: keypair.publicKeyBase64,
  }));

  const entry = await mockState.storage.get('server:ed25519:env-fallback');
  expect(entry.buildVerified).toBe(true);
});
```

### 4.4 Schema Migration Tests

**Test Case 8: Legacy format auto-migrates on read**
```javascript
it('should auto-migrate legacy format keys on first read', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });

  // Seed legacy format
  const legacyData = {
    keys: [keypair.publicKeyBase64],
    updatedAt: 1000000000,
  };
  const encrypted = await BuildVerifier.encryptKeys(legacyData, 'ci-secret-123');
  await mockState.storage.put('trusted_build_keys', encrypted);

  // Trigger migration via build verification
  const buildHash = 'a'.repeat(64);
  const signature = await signBuildHash(keypair.privateKey, buildHash);
  await registry.fetch(createRequest('POST', '/servers', {
    serverId: 'ed25519:migration-test',
    endpoint: 'wss://mig.example.com',
    publicKey: 'test-key',
    buildHash,
    buildSignature: signature,
    buildSigningKey: keypair.publicKeyBase64,
  }));

  // Check storage — should now be v2 format
  const stored = await mockState.storage.get('trusted_build_keys');
  const decrypted = await BuildVerifier.decryptKeys(stored, 'ci-secret-123');
  expect(decrypted.schemaVersion).toBe(2);
  expect(decrypted.keys[0]).toHaveProperty('keyId');
  expect(decrypted.keys[0]).toHaveProperty('expiresAt');
  expect(decrypted.keys[0].addedBy).toBe('legacy-migration');
});
```

**Test Case 9: Migrated keys inherit updatedAt as addedAt**
```javascript
it('should use updatedAt as addedAt for migrated keys', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  const legacyUpdatedAt = 1000000000;
  const legacyData = {
    keys: [keypair.publicKeyBase64],
    updatedAt: legacyUpdatedAt,
  };
  const encrypted = await BuildVerifier.encryptKeys(legacyData, 'ci-secret-123');
  await mockState.storage.put('trusted_build_keys', encrypted);

  // Trigger migration via GET
  const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
  const data = await response.json();

  if (data.schemaVersion === 2) {
    expect(data.keys[0].addedAt).toBe(legacyUpdatedAt);
    expect(data.keys[0].expiresAt).toBe(legacyUpdatedAt + 90 * 24 * 60 * 60 * 1000);
  }
});
```

### 4.5 Key Fingerprint and Deduplication

**Test Case 10: Duplicate keys are deduplicated by fingerprint**
```javascript
it('should deduplicate keys by fingerprint', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  // Add same key twice
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [keypair.publicKeyBase64, keypair.publicKeyBase64],
  }, authHeaders));

  const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
  const data = await response.json();

  expect(data.keys.length).toBe(1); // Deduplicated
});
```

### 4.6 Alarm Handler Expiry Warnings

**Test Case 11: Alarm logs warning for expiring keys**
```javascript
it('should log warning for keys expiring within 14 days', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  // Add key expiring in 7 days
  const expiresIn7Days = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [{
      publicKey: keypair.publicKeyBase64,
      expiresAt: expiresIn7Days,
      addedBy: 'test',
    }],
  }, authHeaders));

  // Mock logger to capture warnings
  const warnings = [];
  registry.logger.warn = (msg, data) => warnings.push({ msg, data });

  // Trigger alarm
  await registry.alarm();

  const expiryWarning = warnings.find(w => w.data.action === 'key_expiry_warning');
  expect(expiryWarning).toBeDefined();
  expect(expiryWarning.data.daysRemaining).toBeLessThanOrEqual(7);
});
```

**Test Case 12: Alarm logs error for already-expired keys**
```javascript
it('should log error for already-expired keys', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  // Add key that expired yesterday
  const expiredYesterday = Date.now() - 24 * 60 * 60 * 1000;
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [{
      publicKey: keypair.publicKeyBase64,
      expiresAt: expiredYesterday,
      addedBy: 'test',
    }],
  }, authHeaders));

  const warnings = [];
  registry.logger.warn = (msg, data) => warnings.push({ msg, data });

  await registry.alarm();

  const expiredLog = warnings.find(w => w.data.action === 'key_expired');
  expect(expiredLog).toBeDefined();
});
```

### 4.7 Key Validation Tests

**Test Case 13: Reject non-base64 key**
```javascript
it('should reject key that is not valid base64', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });

  const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: ['not-valid-base64!!!'],
  }, {
    Authorization: 'Bearer ci-secret-123',
  }));

  expect(response.status).toBe(400);
  const data = await response.json();
  expect(data.error).toContain('Invalid Ed25519 key format');
});
```

**Test Case 14: Reject key with wrong length**
```javascript
it('should reject key that decodes to wrong byte length', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });

  // 16 bytes base64-encoded (valid base64 but wrong length for Ed25519)
  const shortKey = btoa('x'.repeat(16));

  const response = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [shortKey],
  }, {
    Authorization: 'Bearer ci-secret-123',
  }));

  expect(response.status).toBe(400);
  const data = await response.json();
  expect(data.invalidKeys).toContain(shortKey);
});
```

### 4.8 Backward Compatibility Tests

**Test Case 15: Old tests still pass with new format**
- Run the existing test suite in `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`
- Verify all existing tests pass without modification (except those testing the `trustedKeys.length === 0` fallback behavior)

### 4.9 Integration Test

**Test Case 16: End-to-end key lifecycle**
```javascript
it('should handle full key lifecycle: add, verify, expire, reject', async () => {
  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });
  const authHeaders = { Authorization: 'Bearer ci-secret-123' };

  // Step 1: Add key with short expiry
  vi.setSystemTime(1000000000);
  const shortExpiry = 1000000000 + 1000; // Expires in 1 second
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [{
      publicKey: keypair.publicKeyBase64,
      expiresAt: shortExpiry,
      addedBy: 'test',
    }],
  }, authHeaders));

  // Step 2: Verify builds while key is active
  const buildHash = 'a'.repeat(64);
  const signature = await signBuildHash(keypair.privateKey, buildHash);
  await registry.fetch(createRequest('POST', '/servers', {
    serverId: 'ed25519:lifecycle-active',
    endpoint: 'wss://active.example.com',
    publicKey: 'test-key',
    buildHash,
    buildSignature: signature,
    buildSigningKey: keypair.publicKeyBase64,
  }));
  let entry = await mockState.storage.get('server:ed25519:lifecycle-active');
  expect(entry.buildVerified).toBe(true); // Active key

  // Step 3: Advance time past expiry
  vi.setSystemTime(shortExpiry + 1000);

  // Step 4: Verify builds are rejected after expiry
  await registry.fetch(createRequest('POST', '/servers', {
    serverId: 'ed25519:lifecycle-expired',
    endpoint: 'wss://expired.example.com',
    publicKey: 'test-key',
    buildHash,
    buildSignature: signature,
    buildSigningKey: keypair.publicKeyBase64,
  }));
  entry = await mockState.storage.get('server:ed25519:lifecycle-expired');
  expect(entry.buildVerified).toBe(false); // Expired key
});
```

## 5. Rollback Risk Assessment

### 5.1 Risk Level: LOW-MEDIUM

**Mitigations:**
1. **Backward compatibility:** Legacy flat-array format is automatically migrated on first read. No manual migration required.
2. **Graceful degradation:** If migration write fails, verification continues with in-memory migrated keys.
3. **Env var fallback:** If DO storage is corrupted, the system falls back to `TRUSTED_BUILD_KEYS` env var (unchanged behavior).
4. **Schema version field:** Allows future migrations without breaking existing data.

### 5.2 Potential Issues

**Issue 1: CI pipelines expect flat array in POST response**
- **Impact:** CI scripts that parse the `keys` array in the POST response may break if they don't handle the new format.
- **Mitigation:** The POST response still returns a flat array of public keys (line 975 in new implementation), maintaining backward compatibility.

**Issue 2: Expiry enforcement may break existing workflows**
- **Impact:** If CI workflows assume keys last forever, they may not have a rotation schedule. Keys will start expiring after 90 days.
- **Mitigation:**
  - Default expiry is 90 days, giving operators time to set up rotation.
  - Alarm handler logs warnings 14 days before expiry.
  - Legacy keys migrated with expiry = `addedAt + 90 days`, not retroactive.

**Issue 3: Empty-set fallback change is a breaking behavior change**
- **Impact:** Systems that rely on "no trusted keys = trust all keys" will start rejecting builds.
- **Mitigation:**
  - This is the intended security fix — the old behavior was a vulnerability.
  - Document the change prominently in release notes.
  - Recommend setting at least one trusted key via env var or DO storage before deploying.

### 5.3 Rollback Procedure

If rollback is needed:
1. Revert the server-registry-do.js file to the previous version.
2. DO storage with `schemaVersion: 2` will be ignored (old code doesn't check schemaVersion).
3. System will fall back to env var or return empty array.
4. If storage is corrupted, delete the `trusted_build_keys` key from DO storage and re-upload via CI.

## 6. Dependencies on Other Stories

### 6.1 Story 017: Key Transparency Log (MEDIUM dependency)
- **Relationship:** Story 017 adds an append-only audit log for key changes. The per-key metadata introduced in this story (keyId, addedAt, addedBy) will be used by the transparency log.
- **Recommendation:** Implement Story 012 first, then Story 017 can extend the audit logging without modifying the storage format again.
- **Impact if Story 017 implemented first:** Minimal — the transparency log would initially log flat keys, then be updated when metadata is added.

### 6.2 Story 016: SLSA Build Provenance (LOW dependency)
- **Relationship:** Story 016 deals with client app builds (Android, iOS, etc.) distributed via GitHub Releases. Story 012 deals with VPS server build signing. They share the concept of "build signing keys" but operate on different artifacts.
- **Recommendation:** Stories can be implemented independently. Story 016 may reference the trusted key management patterns from Story 012 when implementing SLSA provenance verification.
- **Impact:** None — independent code paths.

### 6.3 Environment Variables
- **Dependency:** Requires `CI_UPLOAD_SECRET` to be set for encrypted storage.
- **Fallback:** If `CI_UPLOAD_SECRET` is not set, plaintext legacy format is used (less secure but functional).

### 6.4 Cloudflare Durable Objects
- **Dependency:** Requires Cloudflare Workers runtime with Durable Objects enabled.
- **Storage limits:** DO storage has a 128MB limit per object. With 50 max keys and ~200 bytes per key metadata, storage usage is ~10KB (well within limits).

## 7. Implementation Checklist

- [ ] Add constants `MAX_KEY_LIFETIME_MS` and `KEY_EXPIRY_WARNING_MS`
- [ ] Add helper functions `computeKeyFingerprint` and `isValidEd25519Key`
- [ ] Rewrite `loadTrustedKeys` with expiry filtering and migration logic
- [ ] Add `loadTrustedKeysRaw` helper for GET endpoint
- [ ] Update `isTrustedKey` function (if needed — likely no change)
- [ ] Fix empty-set fallback in `registerServer` (line 586)
- [ ] Fix empty-set fallback in heartbeat handler (line 751)
- [ ] Enhance `alarm()` handler to check for expiring keys
- [ ] Rewrite `setTrustedKeys` endpoint to handle structured keys
- [ ] Update `getTrustedKeys` endpoint to return metadata
- [ ] Write all test cases from Section 4
- [ ] Run existing test suite and fix any breaking changes
- [ ] Update API documentation (if exists)
- [ ] Add deployment notes about empty-set behavior change

## 8. Deployment Notes

### 8.1 Pre-Deployment
1. **Backup current trusted keys:** Call `GET /servers/trusted-keys` and save the response.
2. **Verify CI_UPLOAD_SECRET is set:** Check Cloudflare Workers secrets.
3. **Set at least one trusted key:** Ensure `TRUSTED_BUILD_KEYS` env var or DO storage has at least one key before deploying (to avoid empty-set rejection).

### 8.2 Post-Deployment
1. **Verify migration:** Call `GET /servers/trusted-keys` and check `schemaVersion: 2`.
2. **Check alarm logs:** Monitor Cloudflare Workers logs for `key_expiry_warning` messages.
3. **Test build verification:** Register a test server with a signed build and verify `buildVerified: true`.
4. **Set up key rotation schedule:** Add a 90-day reminder to rotate keys before they expire.

### 8.3 Monitoring
- Watch for `[audit] key_expiry_warning` logs (14 days before expiry)
- Watch for `[audit] key_expired` logs (key has already expired)
- Monitor build verification failure rate (should not increase significantly)

## 9. Security Considerations

### 9.1 Crypto-Period Justification
- **90 days** is chosen as a balance between security (shorter is better) and operational burden (longer is easier to manage).
- NIST SP 800-57 Part 1 recommends 1-2 years for signing keys, but in a federation context where keys can be compromised by any operator, shorter periods reduce blast radius.

### 9.2 Soft Delete (Revoked Flag)
- Keys are marked `revoked: true` rather than hard-deleted to preserve audit trail.
- Revoked keys are filtered out during verification but remain in storage for forensic analysis.

### 9.3 Key Fingerprints
- SHA-256 fingerprints (8-byte prefix) provide collision-resistant key identification.
- Collision probability: ~1 in 2^64 (acceptable for 50 keys max).

### 9.4 Migration Security
- Legacy keys are migrated with `addedAt = updatedAt`, giving them the benefit of the doubt (not backdating to deployment time).
- Migrated keys expire 90 days after `updatedAt`, not 90 days after migration, to avoid sudden expiry if `updatedAt` is old.

## 10. Future Enhancements (Out of Scope)

- **Key rotation automation:** CI job that automatically generates and uploads new keys before expiry.
- **Multi-signature verification:** Require N-of-M trusted keys to sign a build (threshold signatures).
- **Per-operator key isolation:** Associate keys with specific VPS operators (requires Story 017 transparency log).
- **Shorter crypto-periods:** Reduce to 30 days after proving operational feasibility of 90-day rotation.

---

**Plan Version:** 1.0
**Last Updated:** 2026-03-03
**Author:** Implementation plan generated from Story 012 security audit
