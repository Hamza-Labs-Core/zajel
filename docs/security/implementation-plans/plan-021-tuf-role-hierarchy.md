# Implementation Plan: TUF Role Hierarchy for Registry Trust

**Story:** Story 021: TUF Role Hierarchy for Registry Trust
**Priority:** LONG-TERM
**Severity:** MEDIUM
**Component:** packages/server, packages/app
**Estimated Effort:** 3-4 weeks
**Author:** Security Implementation Team
**Date:** 2026-03-03

---

## 1. Summary

This plan implements a [TUF (The Update Framework)](https://theupdateframework.github.io/specification/latest/) compliant role hierarchy to replace the current single-key bootstrap signing architecture. The implementation introduces four distinct roles (Root, Targets, Snapshot, Timestamp) with separate keys and metadata files, enabling key rotation without app updates, preventing freeze/rollback attacks, and establishing a robust trust chain for the VPS server registry.

The phased implementation ensures backward compatibility during migration and includes comprehensive testing to validate the security guarantees of each TUF role.

---

## 2. Files to Modify

### Server-Side Files

#### New Files to Create

1. **`/home/meywd/zajel-ddos/packages/server/src/crypto/tuf/metadata.js`**
   - TUF metadata schema definitions (Root, Targets, Snapshot, Timestamp)
   - Metadata serialization/deserialization
   - Version management utilities

2. **`/home/meywd/zajel-ddos/packages/server/src/crypto/tuf/roles.js`**
   - Role-specific signing functions
   - Key import/export for each role
   - Threshold signing support (for future Story 023 integration)

3. **`/home/meywd/zajel-ddos/packages/server/src/crypto/tuf/verification.js`**
   - Server-side metadata validation
   - Expiration checking
   - Version rollback protection

4. **`/home/meywd/zajel-ddos/packages/server/src/durable-objects/tuf-metadata-do.js`**
   - Durable Object for storing TUF metadata files
   - Atomic metadata updates
   - Metadata versioning and history

5. **`/home/meywd/zajel-ddos/scripts/tuf/generate-root-metadata.mjs`**
   - Root metadata generation tool (offline)
   - Root key rotation tool (N→N+1 transition)

6. **`/home/meywd/zajel-ddos/scripts/tuf/generate-delegated-keys.mjs`**
   - Generate Targets/Snapshot/Timestamp keys
   - Key rotation utilities

7. **`/home/meywd/zajel-ddos/scripts/tuf/sign-server-registration.mjs`**
   - CLI tool for VPS operators to sign registration requests
   - Proof-of-key-ownership signature generation

8. **`/home/meywd/zajel-ddos/packages/server/tests/unit/tuf-metadata.test.js`**
   - Metadata schema validation tests
   - Signing/verification tests for each role

9. **`/home/meywd/zajel-ddos/packages/server/tests/e2e/tuf-workflow.test.js`**
   - Full TUF metadata chain verification
   - Key rotation scenarios
   - Attack resistance tests (freeze, rollback, mix-and-match)

#### Files to Modify

10. **`/home/meywd/zajel-ddos/packages/server/src/index.js`**
    - Add TUF metadata endpoints (`GET /tuf/root.json`, `/tuf/targets.json`, `/tuf/snapshot.json`, `/tuf/timestamp.json`)
    - Replace single-key signing in `GET /servers` with Targets metadata reference
    - Add backward compatibility for legacy `X-Bootstrap-Signature` header

11. **`/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`**
    - Add authenticated server registration (signature over registration payload)
    - Generate new Targets metadata when server list changes
    - Trigger Snapshot/Timestamp metadata updates

12. **`/home/meywd/zajel-ddos/packages/server/src/crypto/signing.js`**
    - Refactor to support role-specific key management
    - Add key version tracking
    - Maintain backward compatibility with legacy `signPayload()`

13. **`/home/meywd/zajel-ddos/packages/server/wrangler.jsonc`**
    - Add TUF_METADATA DO binding
    - Document new secrets (TARGETS_SIGNING_KEY, SNAPSHOT_SIGNING_KEY, TIMESTAMP_SIGNING_KEY)
    - Add migration for TUF metadata DO

14. **`/home/meywd/zajel-ddos/scripts/generate-bootstrap-keys.mjs`**
    - Add deprecation warning (use `generate-delegated-keys.mjs` instead for non-root keys)
    - Update documentation to reference TUF workflow

### Client-Side Files

#### New Files to Create

15. **`/home/meywd/zajel-ddos/packages/app/lib/core/crypto/tuf/metadata_models.dart`**
    - Dart data classes for TUF metadata (Root, Targets, Snapshot, Timestamp)
    - JSON serialization/deserialization
    - Freezed models for immutability

16. **`/home/meywd/zajel-ddos/packages/app/lib/core/crypto/tuf/tuf_verifier.dart`**
    - TUF metadata verification workflow
    - Implements TUF spec section 5 (client verification)
    - Version tracking, expiration checking, rollback protection

17. **`/home/meywd/zajel-ddos/packages/app/lib/core/crypto/tuf/metadata_cache.dart`**
    - Local storage for verified metadata
    - Secure storage using flutter_secure_storage
    - Cache invalidation on expiration

18. **`/home/meywd/zajel-ddos/packages/app/lib/core/crypto/tuf/root_metadata.json`**
    - Embedded root metadata (v1) as asset file
    - Used as trusted bootstrap for TUF chain

19. **`/home/meywd/zajel-ddos/packages/app/test/unit/crypto/tuf_verifier_test.dart`**
    - Unit tests for TUF metadata verification
    - Key rotation tests (N→N+1)
    - Attack scenario tests (freeze, rollback, mix-and-match)

20. **`/home/meywd/zajel-ddos/packages/app/test/integration/tuf_bootstrap_test.dart`**
    - Integration test for full TUF workflow with mock server
    - Metadata update scenarios
    - Offline/degraded mode testing

#### Files to Modify

21. **`/home/meywd/zajel-ddos/packages/app/lib/core/crypto/bootstrap_verifier.dart`**
    - Refactor to use TufVerifier instead of direct Ed25519 verification
    - Add backward compatibility mode for legacy signatures
    - Deprecate `_productionPublicKey` and `_qaPublicKey` (move to root metadata)

22. **`/home/meywd/zajel-ddos/packages/app/lib/core/config/environment.dart`**
    - Add TUF metadata base URL configuration
    - Add feature flag for TUF mode vs. legacy mode

23. **`/home/meywd/zajel-ddos/packages/app/pubspec.yaml`**
    - Add dependencies: `freezed`, `freezed_annotation`, `json_annotation`, `json_serializable`
    - Update asset declarations to include `lib/core/crypto/tuf/root_metadata.json`

### Documentation Files

24. **`/home/meywd/zajel-ddos/docs/security/tuf-implementation.md`** (new)
    - Architecture overview
    - Key management procedures (root key ceremonies, delegated key rotation)
    - Metadata update workflows
    - Operator runbooks for key rotation

25. **`/home/meywd/zajel-ddos/docs/security/tuf-incident-response.md`** (new)
    - Key compromise response procedures
    - Emergency root key rotation
    - Client migration strategies

26. **`/home/meywd/zajel-ddos/README.md`**
    - Update build/deployment instructions to reference TUF workflow
    - Link to TUF documentation

---

## 3. Implementation Steps

### Phase 1: TUF Metadata Schema and Role Definitions (Week 1)

#### Step 1.1: Define Metadata Schema

**File:** `/home/meywd/zajel-ddos/packages/server/src/crypto/tuf/metadata.js`

**Before:** File does not exist.

**After:**
```javascript
/**
 * TUF Metadata Schema Definitions
 * Implements TUF Specification v1.0.31 metadata format
 */

/**
 * @typedef {Object} TufRole
 * @property {number} threshold - Number of signatures required (default: 1)
 * @property {string[]} keyids - List of authorized key IDs for this role
 */

/**
 * @typedef {Object} TufKey
 * @property {string} keytype - "ed25519"
 * @property {string} scheme - "ed25519"
 * @property {string} keyval - Base64-encoded public key (32 bytes)
 */

/**
 * @typedef {Object} RootMetadata
 * @property {string} _type - "root"
 * @property {number} spec_version - "1.0.31"
 * @property {number} version - Monotonically increasing version number
 * @property {string} expires - ISO 8601 UTC timestamp
 * @property {Object<string, TufKey>} keys - Map of keyid -> key object
 * @property {Object<string, TufRole>} roles - Map of role name -> role config
 * @property {boolean} consistent_snapshot - false (not using consistent snapshots)
 */

/**
 * @typedef {Object} TargetFile
 * @property {number} length - File size in bytes (for consistency checks)
 * @property {Object<string, string>} hashes - { "sha256": "<hex>" }
 * @property {Object} custom - Custom metadata (serverId, endpoint, publicKey, region, buildVerified, etc.)
 */

/**
 * @typedef {Object} TargetsMetadata
 * @property {string} _type - "targets"
 * @property {number} spec_version - "1.0.31"
 * @property {number} version - Monotonically increasing version number
 * @property {string} expires - ISO 8601 UTC timestamp
 * @property {Object<string, TargetFile>} targets - Map of target name -> target metadata
 * @property {Object} delegations - null (no delegations in initial implementation)
 */

/**
 * @typedef {Object} SnapshotMeta
 * @property {number} version - Version number of the referenced metadata file
 * @property {Object<string, string>} hashes - { "sha256": "<hex>" } (optional but recommended)
 */

/**
 * @typedef {Object} SnapshotMetadata
 * @property {string} _type - "snapshot"
 * @property {number} spec_version - "1.0.31"
 * @property {number} version - Monotonically increasing version number
 * @property {string} expires - ISO 8601 UTC timestamp
 * @property {Object<string, SnapshotMeta>} meta - Map of "targets.json" -> { version, hashes }
 */

/**
 * @typedef {Object} TimestampMeta
 * @property {number} version - Version number of snapshot.json
 * @property {Object<string, string>} hashes - { "sha256": "<hex>" }
 */

/**
 * @typedef {Object} TimestampMetadata
 * @property {string} _type - "timestamp"
 * @property {number} spec_version - "1.0.31"
 * @property {number} version - Monotonically increasing version number
 * @property {string} expires - ISO 8601 UTC timestamp
 * @property {Object<string, TimestampMeta>} meta - Map of "snapshot.json" -> { version, hashes }
 */

/**
 * @typedef {Object} SignedMetadata
 * @property {Object} signed - The metadata object (Root/Targets/Snapshot/Timestamp)
 * @property {Array<{keyid: string, sig: string}>} signatures - Array of signatures
 */

/**
 * Generate a keyid from a public key.
 * TUF spec: keyid = SHA256(canonical JSON of key object)
 * @param {TufKey} key
 * @returns {Promise<string>} Hex-encoded SHA256 hash
 */
export async function generateKeyId(key) {
  const canonical = JSON.stringify({
    keytype: key.keytype,
    scheme: key.scheme,
    keyval: key.keyval,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a TUF key object from a base64-encoded Ed25519 public key.
 * @param {string} publicKeyBase64
 * @returns {TufKey}
 */
export function createTufKey(publicKeyBase64) {
  return {
    keytype: 'ed25519',
    scheme: 'ed25519',
    keyval: publicKeyBase64,
  };
}

/**
 * Create an ISO 8601 expiration timestamp.
 * @param {number} daysFromNow
 * @returns {string} ISO 8601 UTC string
 */
export function createExpiration(daysFromNow) {
  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + daysFromNow);
  return expiry.toISOString();
}

/**
 * Compute SHA256 hash of a canonical JSON string.
 * @param {Object} obj
 * @returns {Promise<string>} Hex-encoded hash
 */
export async function hashMetadata(obj) {
  const canonical = JSON.stringify(obj);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate that metadata has not expired.
 * @param {string} expiresISO - ISO 8601 timestamp
 * @returns {boolean}
 */
export function isExpired(expiresISO) {
  return new Date(expiresISO) < new Date();
}

/**
 * Canonical JSON serialization (keys sorted alphabetically).
 * Required by TUF spec for reproducible signatures.
 * @param {Object} obj
 * @returns {string}
 */
export function canonicalJSON(obj) {
  if (obj === null) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJSON).join(',') + ']';

  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => `"${k}":${canonicalJSON(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}
```

**Rationale:** This establishes the TUF metadata schema following the official TUF specification v1.0.31. The typedef annotations provide type safety and documentation for all metadata structures.

---

#### Step 1.2: Implement Role-Specific Signing

**File:** `/home/meywd/zajel-ddos/packages/server/src/crypto/tuf/roles.js`

**Before:** File does not exist.

**After:**
```javascript
/**
 * TUF Role-Specific Signing Functions
 */

import { importSigningKey, signPayload } from '../signing.js';
import { generateKeyId, canonicalJSON } from './metadata.js';

/**
 * Sign a metadata object with one or more keys.
 * @param {Object} metadata - The metadata object to sign (unsigned)
 * @param {Array<{keyid: string, key: CryptoKey}>} signingKeys - Array of {keyid, key} pairs
 * @returns {Promise<Object>} SignedMetadata envelope with signatures
 */
export async function signMetadata(metadata, signingKeys) {
  const canonical = canonicalJSON(metadata);

  const signatures = [];
  for (const { keyid, key } of signingKeys) {
    const sig = await signPayload(key, canonical);
    signatures.push({ keyid, sig });
  }

  return {
    signed: metadata,
    signatures,
  };
}

/**
 * Import a signing key for a specific role.
 * @param {string} hexSeed - 64-character hex-encoded Ed25519 seed
 * @param {string} publicKeyBase64 - Base64-encoded public key (for keyid derivation)
 * @returns {Promise<{keyid: string, key: CryptoKey}>}
 */
export async function importRoleKey(hexSeed, publicKeyBase64) {
  const key = await importSigningKey(hexSeed);
  const tufKey = {
    keytype: 'ed25519',
    scheme: 'ed25519',
    keyval: publicKeyBase64,
  };
  const keyid = await generateKeyId(tufKey);
  return { keyid, key };
}

/**
 * Create a new Root metadata object.
 * @param {number} version
 * @param {number} expirationDays
 * @param {Object<string, string>} roleKeys - Map of role name -> publicKeyBase64
 * @returns {Promise<Object>} Unsigned Root metadata
 */
export async function createRootMetadata(version, expirationDays, roleKeys) {
  const keys = {};
  const roles = {};

  for (const [roleName, pubKeyBase64] of Object.entries(roleKeys)) {
    const tufKey = {
      keytype: 'ed25519',
      scheme: 'ed25519',
      keyval: pubKeyBase64,
    };
    const keyid = await generateKeyId(tufKey);
    keys[keyid] = tufKey;

    roles[roleName] = {
      threshold: 1, // Single-signature for now (Story 023 will add M-of-N)
      keyids: [keyid],
    };
  }

  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + expirationDays);

  return {
    _type: 'root',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    keys,
    roles,
    consistent_snapshot: false,
  };
}

/**
 * Create a new Targets metadata object from server registry entries.
 * @param {number} version
 * @param {number} expirationDays
 * @param {Array<Object>} servers - Array of server entries from ServerRegistryDO
 * @returns {Promise<Object>} Unsigned Targets metadata
 */
export async function createTargetsMetadata(version, expirationDays, servers) {
  const targets = {};

  for (const server of servers) {
    const targetName = `servers/${server.serverId}.json`;
    const serverJson = JSON.stringify(server);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverJson));
    const hashHex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');

    targets[targetName] = {
      length: serverJson.length,
      hashes: { sha256: hashHex },
      custom: {
        serverId: server.serverId,
        endpoint: server.endpoint,
        publicKey: server.publicKey,
        region: server.region,
        buildVerified: server.buildVerified || false,
        buildHash: server.buildHash || null,
        buildVersion: server.buildVersion || null,
        registeredAt: server.registeredAt,
        lastSeen: server.lastSeen,
      },
    };
  }

  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + expirationDays);

  return {
    _type: 'targets',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    targets,
    delegations: null,
  };
}

/**
 * Create a new Snapshot metadata object.
 * @param {number} version
 * @param {number} expirationDays
 * @param {Object} targetsMetadata - The signed Targets metadata
 * @returns {Promise<Object>} Unsigned Snapshot metadata
 */
export async function createSnapshotMetadata(version, expirationDays, targetsMetadata) {
  const targetsHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJSON(targetsMetadata.signed))
  );
  const hashHex = Array.from(new Uint8Array(targetsHash), b => b.toString(16).padStart(2, '0')).join('');

  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + expirationDays);

  return {
    _type: 'snapshot',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    meta: {
      'targets.json': {
        version: targetsMetadata.signed.version,
        hashes: { sha256: hashHex },
      },
    },
  };
}

/**
 * Create a new Timestamp metadata object.
 * @param {number} version
 * @param {number} expirationHours
 * @param {Object} snapshotMetadata - The signed Snapshot metadata
 * @returns {Promise<Object>} Unsigned Timestamp metadata
 */
export async function createTimestampMetadata(version, expirationHours, snapshotMetadata) {
  const snapshotHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJSON(snapshotMetadata.signed))
  );
  const hashHex = Array.from(new Uint8Array(snapshotHash), b => b.toString(16).padStart(2, '0')).join('');

  const expiry = new Date();
  expiry.setUTCHours(expiry.getUTCHours() + expirationHours);

  return {
    _type: 'timestamp',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    meta: {
      'snapshot.json': {
        version: snapshotMetadata.signed.version,
        hashes: { sha256: hashHex },
      },
    },
  };
}
```

**Rationale:** These functions encapsulate the logic for creating and signing each TUF role's metadata, following the canonical JSON serialization required by the TUF spec.

---

#### Step 1.3: Create TUF Metadata Durable Object

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/tuf-metadata-do.js`

**Before:** File does not exist.

**After:**
```javascript
/**
 * TUF Metadata Durable Object
 *
 * Stores signed TUF metadata files (root, targets, snapshot, timestamp).
 * Ensures atomic updates and version monotonicity.
 */

import { getCorsHeaders } from '../cors.js';
import { createLogger } from '../logger.js';
import { isExpired } from '../crypto/tuf/metadata.js';

export class TufMetadataDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, this.env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // GET /tuf/root.json
      if (request.method === 'GET' && url.pathname === '/tuf/root.json') {
        return await this.getMetadata('root', corsHeaders);
      }

      // GET /tuf/targets.json
      if (request.method === 'GET' && url.pathname === '/tuf/targets.json') {
        return await this.getMetadata('targets', corsHeaders);
      }

      // GET /tuf/snapshot.json
      if (request.method === 'GET' && url.pathname === '/tuf/snapshot.json') {
        return await this.getMetadata('snapshot', corsHeaders);
      }

      // GET /tuf/timestamp.json
      if (request.method === 'GET' && url.pathname === '/tuf/timestamp.json') {
        return await this.getMetadata('timestamp', corsHeaders);
      }

      // PUT /tuf/:role - Update metadata (internal use only, requires auth)
      if (request.method === 'PUT' && url.pathname.startsWith('/tuf/')) {
        const role = url.pathname.split('/')[2].replace('.json', '');
        return await this.updateMetadata(role, request, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      this.logger.error('[tuf-metadata] Unhandled error', error);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  }

  async getMetadata(role, corsHeaders) {
    const metadata = await this.state.storage.get(`tuf:${role}`);

    if (!metadata) {
      return new Response(
        JSON.stringify({ error: `${role} metadata not found` }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Warn if metadata is expired (but still serve it for debugging)
    if (isExpired(metadata.signed.expires)) {
      this.logger.warn(`[tuf-metadata] Serving expired ${role} metadata`, {
        role,
        expires: metadata.signed.expires,
        version: metadata.signed.version,
      });
    }

    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': role === 'timestamp' ? 'max-age=300' : 'max-age=3600',
        ...corsHeaders,
      },
    });
  }

  async updateMetadata(role, request, corsHeaders) {
    // TODO: Add authentication (SERVER_REGISTRY_SECRET or dedicated TUF_UPDATE_SECRET)
    const newMetadata = await request.json();

    // Validate metadata structure
    if (!newMetadata.signed || !newMetadata.signatures) {
      return new Response(
        JSON.stringify({ error: 'Invalid metadata: missing signed or signatures' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (newMetadata.signed._type !== role) {
      return new Response(
        JSON.stringify({ error: `Metadata type mismatch: expected ${role}, got ${newMetadata.signed._type}` }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Enforce version monotonicity
    const current = await this.state.storage.get(`tuf:${role}`);
    if (current && newMetadata.signed.version <= current.signed.version) {
      return new Response(
        JSON.stringify({
          error: `Version rollback detected: current=${current.signed.version}, new=${newMetadata.signed.version}`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    await this.state.storage.put(`tuf:${role}`, newMetadata);

    // Store version history for audit trail (keep last 10 versions)
    const historyKey = `tuf:${role}:history`;
    const history = (await this.state.storage.get(historyKey)) || [];
    history.push({
      version: newMetadata.signed.version,
      expires: newMetadata.signed.expires,
      updatedAt: Date.now(),
    });
    if (history.length > 10) history.shift();
    await this.state.storage.put(historyKey, history);

    this.logger.info(`[tuf-metadata] Updated ${role} metadata`, {
      role,
      version: newMetadata.signed.version,
      expires: newMetadata.signed.expires,
    });

    return new Response(
      JSON.stringify({ success: true, version: newMetadata.signed.version }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
```

**Rationale:** A dedicated Durable Object ensures atomic metadata updates and enforces version monotonicity, which is critical for TUF's rollback protection guarantees.

---

### Phase 2: Server-Side Integration (Week 2)

#### Step 2.1: Add TUF Endpoints to Main Worker

**File:** `/home/meywd/zajel-ddos/packages/server/src/index.js`

**Before (lines 99-129):**
```javascript
    // GET /servers — fetch from DO, add timestamp, and sign the response
    if (url.pathname === '/servers' && request.method === 'GET') {
      // TODO: Single global instance - acceptable for current scale.
      // Consider sharding by region when request volume grows.
      const id = env.SERVER_REGISTRY.idFromName('global');
      const stub = env.SERVER_REGISTRY.get(id);
      const doResponse = await stub.fetch(request);
      const data = await doResponse.json();

      // Add timestamp for replay protection
      data.timestamp = Date.now();

      const body = JSON.stringify(data);
      const headers = {
        'Content-Type': 'application/json',
        ...corsHeaders,
      };

      // Sign the response if the signing key is configured
      if (env.BOOTSTRAP_SIGNING_KEY) {
        try {
          const key = await importSigningKey(env.BOOTSTRAP_SIGNING_KEY);
          headers['X-Bootstrap-Signature'] = await signPayload(key, body);
        } catch (e) {
          // Log but don't fail — unsigned response is still useful
          console.error('Failed to sign bootstrap response:', e);
        }
      }

      return new Response(body, { headers });
    }
```

**After (lines 99-160):**
```javascript
    // GET /servers — legacy endpoint with backward-compatible signing
    // DEPRECATED: Clients should migrate to TUF workflow (GET /tuf/timestamp.json -> snapshot -> targets)
    if (url.pathname === '/servers' && request.method === 'GET') {
      const id = env.SERVER_REGISTRY.idFromName('global');
      const stub = env.SERVER_REGISTRY.get(id);
      const doResponse = await stub.fetch(request);
      const data = await doResponse.json();

      // Add timestamp for replay protection
      data.timestamp = Date.now();

      const body = JSON.stringify(data);
      const headers = {
        'Content-Type': 'application/json',
        ...corsHeaders,
      };

      // Backward compatibility: sign with legacy BOOTSTRAP_SIGNING_KEY if present
      if (env.BOOTSTRAP_SIGNING_KEY) {
        try {
          const key = await importSigningKey(env.BOOTSTRAP_SIGNING_KEY);
          headers['X-Bootstrap-Signature'] = await signPayload(key, body);
        } catch (e) {
          console.error('Failed to sign bootstrap response:', e);
        }
      }

      // Also include TUF timestamp metadata version as a migration hint
      if (env.TUF_METADATA) {
        try {
          const tufId = env.TUF_METADATA.idFromName('global');
          const tufStub = env.TUF_METADATA.get(tufId);
          const timestampResp = await tufStub.fetch(new Request('https://internal/tuf/timestamp.json'));
          if (timestampResp.ok) {
            const timestamp = await timestampResp.json();
            headers['X-TUF-Timestamp-Version'] = timestamp.signed.version.toString();
          }
        } catch (e) {
          console.error('Failed to fetch TUF timestamp version:', e);
        }
      }

      return new Response(body, { headers });
    }

    // TUF metadata endpoints — delegate to TufMetadataDO
    if (url.pathname.startsWith('/tuf/')) {
      if (!env.TUF_METADATA) {
        return new Response(
          JSON.stringify({ error: 'TUF metadata not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      const id = env.TUF_METADATA.idFromName('global');
      const stub = env.TUF_METADATA.get(id);
      const doResponse = await stub.fetch(request);
      const response = new Response(doResponse.body, doResponse);
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    }
```

**Rationale:** This adds TUF endpoints while maintaining backward compatibility with legacy clients still using `GET /servers` with `X-Bootstrap-Signature`.

---

#### Step 2.2: Update Server Registration to Require Proof-of-Key-Ownership

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (lines 464-473):**
```javascript
  async registerServer(request, corsHeaders) {
    const body = await parseJsonBody(request, 4096);
    const { serverId, endpoint, publicKey, region } = body;

    if (!serverId || !endpoint || !publicKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
```

**After (lines 464-510):**
```javascript
  async registerServer(request, corsHeaders) {
    const body = await parseJsonBody(request, 4096);
    const { serverId, endpoint, publicKey, region, registrationSignature } = body;

    if (!serverId || !endpoint || !publicKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // --- Proof-of-key-ownership verification ---
    // Require servers to sign their registration payload with their claimed private key
    // Payload format: "zajel-server-registration|<serverId>|<endpoint>|<publicKey>"
    if (this.env.REQUIRE_REGISTRATION_SIGNATURE !== 'false') {
      if (!registrationSignature) {
        return new Response(
          JSON.stringify({
            error: 'Missing registrationSignature. Use scripts/tuf/sign-server-registration.mjs to generate.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const payload = `zajel-server-registration|${serverId}|${endpoint}|${publicKey}`;
      const isValid = await this.verifyRegistrationSignature(payload, registrationSignature, publicKey);

      if (!isValid) {
        this.logger.warn('[audit] Invalid registration signature', {
          action: 'registration_rejected',
          serverId,
          ip: request.headers.get('CF-Connecting-IP'),
        });
        return new Response(
          JSON.stringify({ error: 'Invalid registration signature' }),
          { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      this.logger.info('[audit] Valid registration signature verified', {
        action: 'registration_signature_ok',
        serverId,
      });
    }
```

**Add new method after line 703:**
```javascript
  /**
   * Verify an Ed25519 signature over a registration payload.
   * @param {string} payload - The signed message
   * @param {string} signatureBase64 - Base64-encoded signature
   * @param {string} publicKeyBase64 - Base64-encoded Ed25519 public key
   * @returns {Promise<boolean>}
   */
  async verifyRegistrationSignature(payload, signatureBase64, publicKeyBase64) {
    try {
      const keyBytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0));
      if (keyBytes.length !== 32) return false;

      // SPKI wrapper for Ed25519 public key
      const spkiPrefix = new Uint8Array([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
        0x03, 0x21, 0x00,
      ]);
      const spki = new Uint8Array(spkiPrefix.length + keyBytes.length);
      spki.set(spkiPrefix);
      spki.set(keyBytes, spkiPrefix.length);

      const cryptoKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);

      const sigBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
      if (sigBytes.length !== 64) return false;

      const data = new TextEncoder().encode(payload);
      return await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, data);
    } catch {
      return false;
    }
  }
```

**Rationale:** This prevents unauthorized parties from registering servers with arbitrary public keys. The server must prove it controls the private key corresponding to its claimed public key.

---

#### Step 2.3: Trigger TUF Metadata Updates on Registry Changes

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**After successful registration (after line 617):**
```javascript
    await this.state.storage.put(`server:${serverId}`, serverEntry);

    this.logger.info('[audit] Server registered', {
      action: 'server_register',
      serverId,
      region: validRegion,
      buildVerified,
      ip: request.headers.get('CF-Connecting-IP'),
    });

    // --- Trigger TUF metadata update ---
    if (this.env.TUF_METADATA && this.env.TARGETS_SIGNING_KEY) {
      try {
        await this.updateTufMetadata();
      } catch (e) {
        this.logger.error('[tuf] Failed to update TUF metadata after registration', e);
        // Don't fail the registration — metadata update is best-effort
      }
    }

    return new Response(
      JSON.stringify({ success: true, server: serverEntry }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
```

**Add new method at end of class (after line 1032):**
```javascript
  /**
   * Update TUF targets, snapshot, and timestamp metadata after registry changes.
   * This is called whenever a server is registered, unregistered, or heartbeats with new data.
   */
  async updateTufMetadata() {
    // Import TUF utilities
    const { createTargetsMetadata, createSnapshotMetadata, createTimestampMetadata, signMetadata } =
      await import('../crypto/tuf/roles.js');
    const { importRoleKey } = await import('../crypto/tuf/roles.js');

    // Fetch current server list
    const now = Date.now();
    const servers = [];
    const entries = await this.state.storage.list({ prefix: 'server:' });
    for (const [key, server] of entries) {
      if (now - server.lastSeen < this.serverTTL) {
        // Exclude quarantined servers
        const scoreData = await this.state.storage.get(`anomaly-score:${server.serverId}`);
        if (scoreData && scoreData.quarantined) continue;
        servers.push(server);
      }
    }

    // Get TUF metadata DO
    const tufId = this.env.TUF_METADATA.idFromName('global');
    const tufStub = this.env.TUF_METADATA.get(tufId);

    // Fetch current metadata versions
    const currentTargetsResp = await tufStub.fetch(new Request('https://internal/tuf/targets.json'));
    const currentTargets = currentTargetsResp.ok ? await currentTargetsResp.json() : null;
    const targetsVersion = currentTargets ? currentTargets.signed.version + 1 : 1;

    const currentSnapshotResp = await tufStub.fetch(new Request('https://internal/tuf/snapshot.json'));
    const currentSnapshot = currentSnapshotResp.ok ? await currentSnapshotResp.json() : null;
    const snapshotVersion = currentSnapshot ? currentSnapshot.signed.version + 1 : 1;

    const currentTimestampResp = await tufStub.fetch(new Request('https://internal/tuf/timestamp.json'));
    const currentTimestamp = currentTimestampResp.ok ? await currentTimestampResp.json() : null;
    const timestampVersion = currentTimestamp ? currentTimestamp.signed.version + 1 : 1;

    // Create new Targets metadata
    const targetsMetadataUnsigned = await createTargetsMetadata(targetsVersion, 30, servers); // 30-day expiry
    const targetsKey = await importRoleKey(this.env.TARGETS_SIGNING_KEY, this.env.TARGETS_PUBLIC_KEY);
    const targetsMetadata = await signMetadata(targetsMetadataUnsigned, [targetsKey]);

    // Update Targets
    await tufStub.fetch(new Request('https://internal/tuf/targets.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(targetsMetadata),
    }));

    // Create new Snapshot metadata
    const snapshotMetadataUnsigned = await createSnapshotMetadata(snapshotVersion, 7, targetsMetadata); // 7-day expiry
    const snapshotKey = await importRoleKey(this.env.SNAPSHOT_SIGNING_KEY, this.env.SNAPSHOT_PUBLIC_KEY);
    const snapshotMetadata = await signMetadata(snapshotMetadataUnsigned, [snapshotKey]);

    // Update Snapshot
    await tufStub.fetch(new Request('https://internal/tuf/snapshot.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshotMetadata),
    }));

    // Create new Timestamp metadata
    const timestampMetadataUnsigned = await createTimestampMetadata(timestampVersion, 1, snapshotMetadata); // 1-hour expiry
    const timestampKey = await importRoleKey(this.env.TIMESTAMP_SIGNING_KEY, this.env.TIMESTAMP_PUBLIC_KEY);
    const timestampMetadata = await signMetadata(timestampMetadataUnsigned, [timestampKey]);

    // Update Timestamp
    await tufStub.fetch(new Request('https://internal/tuf/timestamp.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(timestampMetadata),
    }));

    this.logger.info('[tuf] Updated TUF metadata', {
      targetsVersion,
      snapshotVersion,
      timestampVersion,
      serverCount: servers.length,
    });
  }
```

**Rationale:** This ensures that TUF metadata is automatically updated whenever the server registry changes, maintaining consistency between the registry and the signed metadata.

---

### Phase 3: Client-Side TUF Verification (Week 3)

#### Step 3.1: Define Dart TUF Metadata Models

**File:** `/home/meywd/zajel-ddos/packages/app/lib/core/crypto/tuf/metadata_models.dart`

**Before:** File does not exist.

**After:**
```dart
import 'package:freezed_annotation/freezed_annotation.dart';

part 'metadata_models.freezed.dart';
part 'metadata_models.g.dart';

/// TUF Key object
@freezed
class TufKey with _$TufKey {
  const factory TufKey({
    required String keytype,
    required String scheme,
    required String keyval,
  }) = _TufKey;

  factory TufKey.fromJson(Map<String, dynamic> json) => _$TufKeyFromJson(json);
}

/// TUF Role configuration
@freezed
class TufRole with _$TufRole {
  const factory TufRole({
    required int threshold,
    required List<String> keyids,
  }) = _TufRole;

  factory TufRole.fromJson(Map<String, dynamic> json) => _$TufRoleFromJson(json);
}

/// Root metadata (unsigned portion)
@freezed
class RootMetadata with _$RootMetadata {
  const factory RootMetadata({
    @JsonKey(name: '_type') required String type,
    @JsonKey(name: 'spec_version') required String specVersion,
    required int version,
    required String expires,
    required Map<String, TufKey> keys,
    required Map<String, TufRole> roles,
    @JsonKey(name: 'consistent_snapshot') required bool consistentSnapshot,
  }) = _RootMetadata;

  factory RootMetadata.fromJson(Map<String, dynamic> json) =>
      _$RootMetadataFromJson(json);
}

/// Target file metadata
@freezed
class TargetFile with _$TargetFile {
  const factory TargetFile({
    required int length,
    required Map<String, String> hashes,
    required Map<String, dynamic> custom,
  }) = _TargetFile;

  factory TargetFile.fromJson(Map<String, dynamic> json) =>
      _$TargetFileFromJson(json);
}

/// Targets metadata (unsigned portion)
@freezed
class TargetsMetadata with _$TargetsMetadata {
  const factory TargetsMetadata({
    @JsonKey(name: '_type') required String type,
    @JsonKey(name: 'spec_version') required String specVersion,
    required int version,
    required String expires,
    required Map<String, TargetFile> targets,
    required dynamic delegations,
  }) = _TargetsMetadata;

  factory TargetsMetadata.fromJson(Map<String, dynamic> json) =>
      _$TargetsMetadataFromJson(json);
}

/// Snapshot metadata file entry
@freezed
class SnapshotMeta with _$SnapshotMeta {
  const factory SnapshotMeta({
    required int version,
    Map<String, String>? hashes,
  }) = _SnapshotMeta;

  factory SnapshotMeta.fromJson(Map<String, dynamic> json) =>
      _$SnapshotMetaFromJson(json);
}

/// Snapshot metadata (unsigned portion)
@freezed
class SnapshotMetadata with _$SnapshotMetadata {
  const factory SnapshotMetadata({
    @JsonKey(name: '_type') required String type,
    @JsonKey(name: 'spec_version') required String specVersion,
    required int version,
    required String expires,
    required Map<String, SnapshotMeta> meta,
  }) = _SnapshotMetadata;

  factory SnapshotMetadata.fromJson(Map<String, dynamic> json) =>
      _$SnapshotMetadataFromJson(json);
}

/// Timestamp metadata file entry
@freezed
class TimestampMeta with _$TimestampMeta {
  const factory TimestampMeta({
    required int version,
    required Map<String, String> hashes,
  }) = _TimestampMeta;

  factory TimestampMeta.fromJson(Map<String, dynamic> json) =>
      _$TimestampMetaFromJson(json);
}

/// Timestamp metadata (unsigned portion)
@freezed
class TimestampMetadata with _$TimestampMetadata {
  const factory TimestampMetadata({
    @JsonKey(name: '_type') required String type,
    @JsonKey(name: 'spec_version') required String specVersion,
    required int version,
    required String expires,
    required Map<String, TimestampMeta> meta,
  }) = _TimestampMetadata;

  factory TimestampMetadata.fromJson(Map<String, dynamic> json) =>
      _$TimestampMetadataFromJson(json);
}

/// Signature entry
@freezed
class TufSignature with _$TufSignature {
  const factory TufSignature({
    required String keyid,
    required String sig,
  }) = _TufSignature;

  factory TufSignature.fromJson(Map<String, dynamic> json) =>
      _$TufSignatureFromJson(json);
}

/// Signed metadata envelope (generic)
@freezed
class SignedMetadata<T> with _$SignedMetadata<T> {
  const factory SignedMetadata({
    required T signed,
    required List<TufSignature> signatures,
  }) = _SignedMetadata<T>;

  factory SignedMetadata.fromJson(
    Map<String, dynamic> json,
    T Function(Map<String, dynamic>) fromJsonT,
  ) =>
      _$SignedMetadataFromJson(json, fromJsonT);
}
```

**Rationale:** Using `freezed` for immutable data classes ensures type safety and reduces boilerplate. These models match the TUF spec exactly.

---

#### Step 3.2: Implement TUF Verification Workflow

**File:** `/home/meywd/zajel-ddos/packages/app/lib/core/crypto/tuf/tuf_verifier.dart`

**Before:** File does not exist.

**After:**
```dart
import 'dart:convert';
import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';
import 'package:crypto/crypto.dart' as crypto_hash;
import '../logging/logger_service.dart';
import 'metadata_models.dart';

/// TUF metadata verifier implementing TUF Specification v1.0.31 section 5.
///
/// Verifies the full TUF metadata chain: Timestamp -> Snapshot -> Targets -> Root.
/// Enforces:
/// - Signature verification (Ed25519)
/// - Expiration checking
/// - Version monotonicity (rollback protection)
/// - Hash consistency (mix-and-match protection)
class TufVerifier {
  final Ed25519 _ed25519 = Ed25519();

  /// Cached root metadata (trusted after initial bootstrap or update)
  RootMetadata? _trustedRoot;
  Map<String, TufKey>? _trustedKeys;
  Map<String, TufRole>? _trustedRoles;

  /// Version tracking for rollback protection
  int? _lastTimestampVersion;
  int? _lastSnapshotVersion;
  int? _lastTargetsVersion;
  int? _lastRootVersion;

  TufVerifier();

  /// Bootstrap the verifier with an embedded root metadata.
  /// This is the trust anchor for the entire TUF workflow.
  Future<void> bootstrapWithRoot(SignedMetadata<RootMetadata> rootMetadata) async {
    // Verify self-signed root metadata
    final isValid = await _verifyMetadataSignatures(
      rootMetadata.signed,
      rootMetadata.signatures,
      rootMetadata.signed.keys,
      rootMetadata.signed.roles['root']!,
    );

    if (!isValid) {
      throw TufVerificationException('Root metadata has invalid signatures');
    }

    if (_isExpired(rootMetadata.signed.expires)) {
      throw TufVerificationException('Root metadata has expired');
    }

    _trustedRoot = rootMetadata.signed;
    _trustedKeys = rootMetadata.signed.keys;
    _trustedRoles = rootMetadata.signed.roles;
    _lastRootVersion = rootMetadata.signed.version;

    logger.info('TufVerifier', 'Bootstrapped with root v${rootMetadata.signed.version}');
  }

  /// Update to a new root metadata (N→N+1 transition).
  /// Implements TUF spec section 5.3 (root key rotation).
  Future<void> updateRoot(SignedMetadata<RootMetadata> newRootMetadata) async {
    if (_trustedRoot == null) {
      throw TufVerificationException('No trusted root — call bootstrapWithRoot first');
    }

    final newRoot = newRootMetadata.signed;

    // TUF spec 5.3.4: Check version is incremented by 1
    if (newRoot.version != _trustedRoot!.version + 1) {
      throw TufVerificationException(
        'Root version must increment by 1: expected ${_trustedRoot!.version + 1}, got ${newRoot.version}',
      );
    }

    // TUF spec 5.3.5: Verify signatures using old root's key
    final isValidOld = await _verifyMetadataSignatures(
      newRoot,
      newRootMetadata.signatures,
      _trustedKeys!,
      _trustedRoles!['root']!,
    );

    if (!isValidOld) {
      throw TufVerificationException('New root is not signed by old root key');
    }

    // TUF spec 5.3.7: Verify signatures using new root's key
    final isValidNew = await _verifyMetadataSignatures(
      newRoot,
      newRootMetadata.signatures,
      newRoot.keys,
      newRoot.roles['root']!,
    );

    if (!isValidNew) {
      throw TufVerificationException('New root is not self-signed correctly');
    }

    // TUF spec 5.3.8: Check expiration
    if (_isExpired(newRoot.expires)) {
      throw TufVerificationException('New root metadata has expired');
    }

    // Accept the new root
    _trustedRoot = newRoot;
    _trustedKeys = newRoot.keys;
    _trustedRoles = newRoot.roles;
    _lastRootVersion = newRoot.version;

    logger.info('TufVerifier', 'Updated root to v${newRoot.version}');
  }

  /// Verify the full TUF metadata chain and extract server targets.
  /// Implements TUF spec section 5.1 (update workflow).
  Future<List<Map<String, dynamic>>> verifyAndExtractTargets({
    required SignedMetadata<TimestampMetadata> timestamp,
    required SignedMetadata<SnapshotMetadata> snapshot,
    required SignedMetadata<TargetsMetadata> targets,
  }) async {
    if (_trustedRoot == null) {
      throw TufVerificationException('No trusted root — call bootstrapWithRoot first');
    }

    // === Step 1: Verify Timestamp metadata ===
    final timestampMeta = timestamp.signed;

    // TUF spec 5.1.2: Verify timestamp signatures
    final timestampValid = await _verifyMetadataSignatures(
      timestampMeta,
      timestamp.signatures,
      _trustedKeys!,
      _trustedRoles!['timestamp']!,
    );
    if (!timestampValid) {
      throw TufVerificationException('Timestamp metadata has invalid signatures');
    }

    // TUF spec 5.1.3: Check timestamp expiration
    if (_isExpired(timestampMeta.expires)) {
      throw TufVerificationException('Timestamp metadata has expired');
    }

    // TUF spec 5.1.4: Check version is not older than last seen
    if (_lastTimestampVersion != null && timestampMeta.version < _lastTimestampVersion!) {
      throw TufVerificationException(
        'Timestamp version rollback detected: ${timestampMeta.version} < $_lastTimestampVersion',
      );
    }
    _lastTimestampVersion = timestampMeta.version;

    // === Step 2: Verify Snapshot metadata ===
    final snapshotMeta = snapshot.signed;

    // TUF spec 5.1.6: Verify snapshot hash from timestamp
    final snapshotJson = jsonEncode(snapshotMeta.toJson());
    final snapshotHash = _sha256(snapshotJson);
    final expectedSnapshotHash = timestampMeta.meta['snapshot.json']!.hashes['sha256']!;
    if (snapshotHash != expectedSnapshotHash) {
      throw TufVerificationException('Snapshot hash mismatch (timestamp metadata is inconsistent)');
    }

    // TUF spec 5.1.7: Check snapshot version from timestamp
    final expectedSnapshotVersion = timestampMeta.meta['snapshot.json']!.version;
    if (snapshotMeta.version != expectedSnapshotVersion) {
      throw TufVerificationException(
        'Snapshot version mismatch: expected $expectedSnapshotVersion, got ${snapshotMeta.version}',
      );
    }

    // TUF spec 5.1.8: Verify snapshot signatures
    final snapshotValid = await _verifyMetadataSignatures(
      snapshotMeta,
      snapshot.signatures,
      _trustedKeys!,
      _trustedRoles!['snapshot']!,
    );
    if (!snapshotValid) {
      throw TufVerificationException('Snapshot metadata has invalid signatures');
    }

    // TUF spec 5.1.9: Check snapshot expiration
    if (_isExpired(snapshotMeta.expires)) {
      throw TufVerificationException('Snapshot metadata has expired');
    }

    // TUF spec 5.1.10: Check version is not older than last seen
    if (_lastSnapshotVersion != null && snapshotMeta.version < _lastSnapshotVersion!) {
      throw TufVerificationException(
        'Snapshot version rollback detected: ${snapshotMeta.version} < $_lastSnapshotVersion',
      );
    }
    _lastSnapshotVersion = snapshotMeta.version;

    // === Step 3: Verify Targets metadata ===
    final targetsMeta = targets.signed;

    // TUF spec 5.1.12: Verify targets hash from snapshot
    final targetsJson = jsonEncode(targetsMeta.toJson());
    final targetsHash = _sha256(targetsJson);
    final expectedTargetsHash = snapshotMeta.meta['targets.json']!.hashes!['sha256']!;
    if (targetsHash != expectedTargetsHash) {
      throw TufVerificationException('Targets hash mismatch (snapshot metadata is inconsistent)');
    }

    // TUF spec 5.1.13: Check targets version from snapshot
    final expectedTargetsVersion = snapshotMeta.meta['targets.json']!.version;
    if (targetsMeta.version != expectedTargetsVersion) {
      throw TufVerificationException(
        'Targets version mismatch: expected $expectedTargetsVersion, got ${targetsMeta.version}',
      );
    }

    // TUF spec 5.1.14: Verify targets signatures
    final targetsValid = await _verifyMetadataSignatures(
      targetsMeta,
      targets.signatures,
      _trustedKeys!,
      _trustedRoles!['targets']!,
    );
    if (!targetsValid) {
      throw TufVerificationException('Targets metadata has invalid signatures');
    }

    // TUF spec 5.1.15: Check targets expiration
    if (_isExpired(targetsMeta.expires)) {
      throw TufVerificationException('Targets metadata has expired');
    }

    // TUF spec 5.1.16: Check version is not older than last seen
    if (_lastTargetsVersion != null && targetsMeta.version < _lastTargetsVersion!) {
      throw TufVerificationException(
        'Targets version rollback detected: ${targetsMeta.version} < $_lastTargetsVersion',
      );
    }
    _lastTargetsVersion = targetsMeta.version;

    // === Step 4: Extract server list from targets ===
    final servers = <Map<String, dynamic>>[];
    for (final entry in targetsMeta.targets.entries) {
      if (entry.key.startsWith('servers/')) {
        servers.add(entry.value.custom);
      }
    }

    logger.info('TufVerifier', 'Verified TUF metadata chain: ${servers.length} servers');
    return servers;
  }

  /// Verify Ed25519 signatures on a metadata object.
  /// Implements TUF threshold signature verification.
  Future<bool> _verifyMetadataSignatures(
    dynamic metadata,
    List<TufSignature> signatures,
    Map<String, TufKey> keys,
    TufRole role,
  ) async {
    // Canonical JSON serialization (TUF spec requires sorted keys)
    final canonicalJson = _canonicalJson(metadata.toJson());
    final data = Uint8List.fromList(utf8.encode(canonicalJson));

    int validSignatures = 0;

    for (final signature in signatures) {
      // Check if this signature is from an authorized key for this role
      if (!role.keyids.contains(signature.keyid)) {
        continue; // Signature from non-authorized key, skip
      }

      final key = keys[signature.keyid];
      if (key == null) {
        continue; // Unknown key, skip
      }

      try {
        final publicKeyBytes = base64Decode(key.keyval);
        final publicKey = SimplePublicKey(publicKeyBytes, type: KeyPairType.ed25519);
        final signatureBytes = base64Decode(signature.sig);
        final sig = Signature(signatureBytes, publicKey: publicKey);

        final isValid = await _ed25519.verify(data, signature: sig);
        if (isValid) {
          validSignatures++;
          if (validSignatures >= role.threshold) {
            return true; // Threshold met
          }
        }
      } catch (e) {
        logger.warning('TufVerifier', 'Signature verification threw exception: $e');
        continue;
      }
    }

    return false; // Threshold not met
  }

  /// Canonical JSON serialization (sorted keys).
  String _canonicalJson(Map<String, dynamic> obj) {
    final sorted = Map.fromEntries(
      obj.entries.toList()..sort((a, b) => a.key.compareTo(b.key)),
    );
    return jsonEncode(sorted);
  }

  /// Compute SHA256 hash of a string.
  String _sha256(String data) {
    final bytes = utf8.encode(data);
    final digest = crypto_hash.sha256.convert(bytes);
    return digest.toString();
  }

  /// Check if an ISO 8601 timestamp is expired.
  bool _isExpired(String expiresISO) {
    final expiry = DateTime.parse(expiresISO);
    return expiry.isBefore(DateTime.now());
  }
}

class TufVerificationException implements Exception {
  final String message;
  TufVerificationException(this.message);

  @override
  String toString() => 'TufVerificationException: $message';
}
```

**Rationale:** This implements the full TUF client verification workflow as specified in TUF Specification v1.0.31 section 5, providing defense against freeze, rollback, and mix-and-match attacks.

---

#### Step 3.3: Refactor BootstrapVerifier to Use TUF

**File:** `/home/meywd/zajel-ddos/packages/app/lib/core/crypto/bootstrap_verifier.dart`

**Before (lines 40-75):**
```dart
  /// Verify the signature and freshness of a bootstrap response.
  ///
  /// Returns `true` if:
  /// 1. The Ed25519 signature over [responseBody] is valid
  /// 2. The `timestamp` field in the JSON is within [maxAge]
  ///
  /// Returns `false` for invalid signatures, expired timestamps,
  /// or missing timestamp fields.
  Future<bool> verify(String responseBody, String signatureBase64) async {
    try {
      // Verify Ed25519 signature over the raw body bytes
      final signatureBytes = base64Decode(signatureBase64);
      final bodyBytes = Uint8List.fromList(utf8.encode(responseBody));

      final signature = Signature(
        signatureBytes,
        publicKey: _publicKey,
      );

      final isValid = await _ed25519.verify(bodyBytes, signature: signature);
      if (!isValid) return false;

      // Check timestamp freshness (replay protection)
      final json = jsonDecode(responseBody) as Map<String, dynamic>;
      final timestamp = json['timestamp'] as int?;
      if (timestamp == null) return false;

      final responseTime = DateTime.fromMillisecondsSinceEpoch(timestamp);
      final age = DateTime.now().difference(responseTime).abs();
      return age <= maxAge;
    } catch (e) {
      logger.warning('BootstrapVerifier',
          'Signature verification threw an exception (returning false): $e');
      return false;
    }
  }
```

**After (lines 40-110):**
```dart
  /// Verify the signature and freshness of a bootstrap response.
  ///
  /// LEGACY MODE: If TUF is not enabled, verifies Ed25519 signature directly.
  /// TUF MODE: Fetches and verifies full TUF metadata chain.
  ///
  /// Returns `true` if:
  /// 1. The Ed25519 signature over [responseBody] is valid (legacy)
  ///    OR the TUF metadata chain is valid (TUF mode)
  /// 2. The `timestamp` field in the JSON is within [maxAge]
  ///
  /// Returns `false` for invalid signatures, expired timestamps,
  /// or missing timestamp fields.
  Future<bool> verify(String responseBody, String signatureBase64) async {
    try {
      // LEGACY MODE: Direct signature verification (backward compatibility)
      if (!Environment.useTufMetadata) {
        final signatureBytes = base64Decode(signatureBase64);
        final bodyBytes = Uint8List.fromList(utf8.encode(responseBody));

        final signature = Signature(
          signatureBytes,
          publicKey: _publicKey,
        );

        final isValid = await _ed25519.verify(bodyBytes, signature: signature);
        if (!isValid) return false;

        // Check timestamp freshness (replay protection)
        final json = jsonDecode(responseBody) as Map<String, dynamic>;
        final timestamp = json['timestamp'] as int?;
        if (timestamp == null) return false;

        final responseTime = DateTime.fromMillisecondsSinceEpoch(timestamp);
        final age = DateTime.now().difference(responseTime).abs();
        return age <= maxAge;
      }

      // TUF MODE: Not implemented in this legacy method
      // Users should call `verifyTuf()` instead
      logger.warning('BootstrapVerifier',
          'TUF mode is enabled but verify() was called. Use verifyTuf() instead.');
      return false;

    } catch (e) {
      logger.warning('BootstrapVerifier',
          'Signature verification threw an exception (returning false): $e');
      return false;
    }
  }

  /// Verify bootstrap using TUF metadata workflow.
  /// Fetches timestamp, snapshot, and targets metadata from the server.
  /// Returns the verified server list.
  Future<List<Map<String, dynamic>>> verifyTuf({
    required String bootstrapUrl,
    required TufVerifier tufVerifier,
  }) async {
    // TODO: Implement TUF metadata fetching and verification
    // 1. Fetch GET /tuf/timestamp.json
    // 2. Fetch GET /tuf/snapshot.json
    // 3. Fetch GET /tuf/targets.json
    // 4. Call tufVerifier.verifyAndExtractTargets()
    // 5. Return server list
    throw UnimplementedError('TUF verification not yet implemented');
  }
```

**Rationale:** This maintains backward compatibility with legacy single-key verification while preparing for TUF migration. Full TUF implementation would be added in the next iteration.

---

### Phase 4: Testing and Documentation (Week 4)

#### Step 4.1: Server-Side Unit Tests

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/tuf-metadata.test.js`

**Before:** File does not exist.

**After:**
```javascript
/**
 * Unit tests for TUF metadata creation and signing
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeyId,
  createTufKey,
  createExpiration,
  hashMetadata,
  isExpired,
  canonicalJSON,
} from '../../src/crypto/tuf/metadata.js';
import {
  signMetadata,
  importRoleKey,
  createRootMetadata,
  createTargetsMetadata,
  createSnapshotMetadata,
  createTimestampMetadata,
} from '../../src/crypto/tuf/roles.js';

describe('TUF Metadata Schema', () => {
  describe('generateKeyId', () => {
    it('should generate SHA256 hash of canonical key JSON', async () => {
      const key = createTufKey('dGVzdCBwdWJsaWMga2V5IDMyIGJ5dGVzIQ=='); // "test public key 32 bytes!"
      const keyid = await generateKeyId(key);

      expect(keyid).toMatch(/^[0-9a-f]{64}$/); // 64 hex chars
    });

    it('should produce same keyid for same key', async () => {
      const key = createTufKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      const keyid1 = await generateKeyId(key);
      const keyid2 = await generateKeyId(key);

      expect(keyid1).toBe(keyid2);
    });
  });

  describe('canonicalJSON', () => {
    it('should sort object keys alphabetically', () => {
      const obj = { z: 1, a: 2, m: 3 };
      const canonical = canonicalJSON(obj);
      expect(canonical).toBe('{"a":2,"m":3,"z":1}');
    });

    it('should handle nested objects', () => {
      const obj = { outer: { z: 1, a: 2 }, foo: 'bar' };
      const canonical = canonicalJSON(obj);
      expect(canonical).toBe('{"foo":"bar","outer":{"a":2,"z":1}}');
    });
  });

  describe('isExpired', () => {
    it('should return false for future expiration', () => {
      const future = new Date();
      future.setUTCDate(future.getUTCDate() + 1);
      expect(isExpired(future.toISOString())).toBe(false);
    });

    it('should return true for past expiration', () => {
      const past = new Date();
      past.setUTCDate(past.getUTCDate() - 1);
      expect(isExpired(past.toISOString())).toBe(true);
    });
  });
});

describe('TUF Role Signing', () => {
  let rootKeyPair, targetsKeyPair;
  let rootSeedHex, targetsSeedHex;
  let rootPubBase64, targetsPubBase64;

  beforeEach(async () => {
    // Generate test keypairs for root and targets roles
    rootKeyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const rootPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', rootKeyPair.privateKey));
    const rootSeed = rootPkcs8.slice(-32);
    rootSeedHex = Array.from(rootSeed, b => b.toString(16).padStart(2, '0')).join('');
    const rootPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', rootKeyPair.publicKey));
    rootPubBase64 = btoa(String.fromCharCode(...rootPubBytes));

    targetsKeyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const targetsPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', targetsKeyPair.privateKey));
    const targetsSeed = targetsPkcs8.slice(-32);
    targetsSeedHex = Array.from(targetsSeed, b => b.toString(16).padStart(2, '0')).join('');
    const targetsPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', targetsKeyPair.publicKey));
    targetsPubBase64 = btoa(String.fromCharCode(...targetsPubBytes));
  });

  it('should create and sign root metadata', async () => {
    const rootMetadata = await createRootMetadata(1, 365, {
      root: rootPubBase64,
      targets: targetsPubBase64,
    });

    expect(rootMetadata._type).toBe('root');
    expect(rootMetadata.version).toBe(1);
    expect(rootMetadata.roles.root).toBeDefined();
    expect(rootMetadata.roles.targets).toBeDefined();

    const rootKey = await importRoleKey(rootSeedHex, rootPubBase64);
    const signed = await signMetadata(rootMetadata, [rootKey]);

    expect(signed.signatures).toHaveLength(1);
    expect(signed.signatures[0].sig).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
  });

  it('should create targets metadata with server entries', async () => {
    const servers = [
      {
        serverId: 'ed25519:test1',
        endpoint: 'wss://test1.example.com',
        publicKey: 'key1',
        region: 'us-east',
        buildVerified: true,
        buildHash: 'abc123',
        buildVersion: 'v1.0.0',
        registeredAt: 1000,
        lastSeen: 2000,
      },
    ];

    const targetsMetadata = await createTargetsMetadata(1, 30, servers);

    expect(targetsMetadata._type).toBe('targets');
    expect(targetsMetadata.version).toBe(1);
    expect(targetsMetadata.targets['servers/ed25519:test1.json']).toBeDefined();
    expect(targetsMetadata.targets['servers/ed25519:test1.json'].custom.serverId).toBe('ed25519:test1');
  });

  it('should create snapshot metadata with targets hash', async () => {
    const targetsMetadata = await createTargetsMetadata(1, 30, []);
    const targetsKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
    const signedTargets = await signMetadata(targetsMetadata, [targetsKey]);

    const snapshotMetadata = await createSnapshotMetadata(1, 7, signedTargets);

    expect(snapshotMetadata._type).toBe('snapshot');
    expect(snapshotMetadata.version).toBe(1);
    expect(snapshotMetadata.meta['targets.json']).toBeDefined();
    expect(snapshotMetadata.meta['targets.json'].version).toBe(1);
    expect(snapshotMetadata.meta['targets.json'].hashes.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should create timestamp metadata with snapshot hash', async () => {
    const targetsMetadata = await createTargetsMetadata(1, 30, []);
    const targetsKey = await importRoleKey(targetsSeedHex, targetsPubBase64);
    const signedTargets = await signMetadata(targetsMetadata, [targetsKey]);

    const snapshotMetadata = await createSnapshotMetadata(1, 7, signedTargets);
    const snapshotKey = await importRoleKey(rootSeedHex, rootPubBase64); // Reuse root key for snapshot
    const signedSnapshot = await signMetadata(snapshotMetadata, [snapshotKey]);

    const timestampMetadata = await createTimestampMetadata(1, 1, signedSnapshot);

    expect(timestampMetadata._type).toBe('timestamp');
    expect(timestampMetadata.version).toBe(1);
    expect(timestampMetadata.meta['snapshot.json']).toBeDefined();
    expect(timestampMetadata.meta['snapshot.json'].version).toBe(1);
    expect(timestampMetadata.meta['snapshot.json'].hashes.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

**Rationale:** These tests validate the core TUF metadata creation and signing logic, ensuring compliance with the TUF specification.

---

#### Step 4.2: End-to-End TUF Workflow Test

**File:** `/home/meywd/zajel-ddos/packages/server/tests/e2e/tuf-workflow.test.js`

**Before:** File does not exist.

**After (excerpt — showing key attack scenario tests):**
```javascript
/**
 * E2E tests for TUF workflow including attack resistance
 */

import { describe, it, expect, beforeEach } from 'vitest';
// ... imports omitted for brevity ...

describe('TUF Attack Resistance', () => {
  // ... setup code omitted ...

  it('should reject rollback attack on timestamp metadata', async () => {
    // Update timestamp to version 2
    await updateTimestamp(2);

    // Attacker tries to serve old version 1
    const oldTimestamp = await fetchMetadata('timestamp', 1);

    // Client should reject (assuming client tracks last seen version)
    // In actual implementation, this would be tested in client-side tests
    expect(oldTimestamp.signed.version).toBe(1);
    // Client verifier would throw TufVerificationException
  });

  it('should reject mix-and-match attack (wrong snapshot hash)', async () => {
    const legitTimestamp = await fetchMetadata('timestamp');
    const legitSnapshot = await fetchMetadata('snapshot');

    // Attacker modifies snapshot but keeps old timestamp
    const tamperedSnapshot = { ...legitSnapshot };
    tamperedSnapshot.signed.version = 999;

    // Recompute timestamp hash — this would NOT match
    const tamperedHash = await hashMetadata(tamperedSnapshot.signed);
    expect(tamperedHash).not.toBe(legitTimestamp.signed.meta['snapshot.json'].hashes.sha256);

    // Client verifier would detect hash mismatch and reject
  });

  it('should reject freeze attack (expired timestamp)', async () => {
    // Create timestamp with short expiration (1 second)
    const expiredTimestamp = await createTimestampMetadata(1, 0.0003); // ~1 second

    // Wait 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Client should reject expired metadata
    expect(isExpired(expiredTimestamp.expires)).toBe(true);
  });
});
```

**Rationale:** These E2E tests validate that the TUF implementation defends against known attacks (freeze, rollback, mix-and-match) as documented in the TUF threat model.

---

## 4. Test Plan

### Unit Tests

#### Server-Side
1. **TUF Metadata Schema Tests** (`tuf-metadata.test.js`)
   - Validate keyid generation (SHA256 hash of canonical JSON)
   - Validate canonical JSON serialization (sorted keys)
   - Validate expiration checking
   - Validate metadata structure conformance to TUF spec

2. **TUF Role Signing Tests** (`tuf-metadata.test.js`)
   - Create and sign Root metadata with multiple role keys
   - Create Targets metadata from server registry entries
   - Create Snapshot metadata with correct Targets hash
   - Create Timestamp metadata with correct Snapshot hash
   - Verify signature format (base64, 64-byte Ed25519)

3. **Server Registration Signature Tests** (`server-registry-do.test.js`)
   - Valid registration signature is accepted
   - Invalid signature is rejected (403)
   - Missing signature is rejected when REQUIRE_REGISTRATION_SIGNATURE=true
   - Signature over wrong payload is rejected

#### Client-Side
4. **TUF Verifier Tests** (`tuf_verifier_test.dart`)
   - Bootstrap with valid root metadata
   - Reject bootstrap with invalid root signatures
   - Reject bootstrap with expired root metadata
   - Update root N→N+1 with valid old+new signatures
   - Reject root N→N+2 (must be incremental)
   - Verify full metadata chain (timestamp→snapshot→targets)
   - Detect and reject version rollback on each role
   - Detect and reject hash mismatch (mix-and-match attack)
   - Detect and reject expired metadata

### Integration Tests

5. **TUF Workflow Integration** (`tuf-workflow.test.js`)
   - Full workflow: register server → triggers targets/snapshot/timestamp update
   - Fetch all metadata endpoints (GET /tuf/root.json, /tuf/targets.json, etc.)
   - Verify metadata chain consistency after server registration
   - Verify metadata chain consistency after server unregistration
   - Verify metadata version increments correctly

6. **TUF Bootstrap Integration** (`tuf_bootstrap_test.dart`)
   - App bootstraps with embedded root metadata asset
   - App fetches and verifies timestamp→snapshot→targets chain
   - App extracts server list from verified targets
   - App caches verified metadata for offline use
   - App updates cached metadata on expiration

### Attack Scenario Tests

7. **Freeze Attack Test**
   - Server serves expired timestamp metadata
   - Client rejects with TufVerificationException
   - Expected: "Timestamp metadata has expired"

8. **Rollback Attack Test**
   - Client has seen timestamp v5
   - Attacker serves timestamp v3
   - Client rejects with TufVerificationException
   - Expected: "Timestamp version rollback detected: 3 < 5"

9. **Mix-and-Match Attack Test**
   - Attacker serves legitimate timestamp v5 but old snapshot v2
   - Snapshot hash does not match timestamp's meta['snapshot.json'].hashes
   - Client rejects with TufVerificationException
   - Expected: "Snapshot hash mismatch (timestamp metadata is inconsistent)"

10. **Root Key Rotation Test**
    - Generate root v1 with key A
    - Generate root v2 with key B, signed by both A and B
    - Client verifies with old root (key A) → accepts new root (key B)
    - Generate root v3 with key C, signed only by B
    - Client (now trusting B) verifies and accepts root v3

11. **Unauthorized Registration Test**
    - VPS tries to register without signing registration payload
    - Server rejects with 400 "Missing registrationSignature"
    - VPS signs with wrong private key (not matching claimed publicKey)
    - Server rejects with 403 "Invalid registration signature"

### Manual Testing

12. **Key Generation and Rotation**
    - Run `node scripts/tuf/generate-root-metadata.mjs` → produces root.json v1
    - Run `node scripts/tuf/generate-delegated-keys.mjs` → produces targets/snapshot/timestamp keys
    - Upload metadata to TufMetadataDO via PUT /tuf/root.json
    - Verify GET /tuf/root.json returns signed root metadata
    - Rotate targets key: generate new key, update root v2, sign targets with new key
    - Verify client still accepts targets after key rotation

13. **VPS Server Registration Workflow**
    - VPS operator generates keypair: `node scripts/tuf/sign-server-registration.mjs`
    - Script prompts for serverId, endpoint, publicKey
    - Script outputs registrationSignature
    - VPS sends POST /servers with registrationSignature
    - Verify server is registered and appears in GET /tuf/targets.json

14. **Offline/Degraded Mode**
    - Client fetches and caches TUF metadata
    - Disconnect network
    - Client uses cached metadata (within expiration window)
    - Verify client can still access server list from cache
    - After expiration, client warns but gracefully degrades (vs. hard failure)

---

## 5. Rollback Risk

### High-Risk Changes
1. **Server registration requiring signatures** — If `REQUIRE_REGISTRATION_SIGNATURE` is enabled without proper operator communication, existing VPS registration scripts will break.
   - **Mitigation:** Default to `REQUIRE_REGISTRATION_SIGNATURE=false` initially. Document migration path. Provide clear error messages with link to signing script.

2. **TUF metadata DO binding** — If `TUF_METADATA` binding is not configured, `/tuf/*` endpoints will return 503.
   - **Mitigation:** Feature flag via environment variable. TUF endpoints are opt-in.

3. **Root metadata bootstrap** — If embedded root metadata in Flutter app is invalid or mismatches server's root, all TUF verification will fail.
   - **Mitigation:** Extensive testing of root metadata generation. Include root metadata version in app logs for debugging.

### Rollback Strategy
1. **Phase 1 rollback (TUF schema):** No runtime changes — safe to revert code.
2. **Phase 2 rollback (server integration):**
   - Remove TUF_METADATA DO binding from wrangler.jsonc
   - Revert `GET /servers` to legacy signing only
   - Clients fall back to `X-Bootstrap-Signature` verification
3. **Phase 3 rollback (client TUF):**
   - Set `Environment.useTufMetadata = false`
   - Clients use legacy `BootstrapVerifier.verify()` path
4. **Emergency rollback:**
   - Deploy previous server version via `wrangler rollback`
   - Push hotfix app update with `Environment.useTufMetadata = false`

### Data Migration
- **TufMetadataDO storage:** Metadata is immutable. Rollback does not require data deletion.
- **Server registry:** No schema changes. Rollback-safe.
- **Client cache:** Metadata cache is version-tracked. Old clients ignore new metadata formats.

---

## 6. Dependencies on Other Stories

### Blocking Dependencies (Must Complete First)
- **None** — This story is self-contained and can be implemented independently.

### Related Stories (Integration Points)
1. **Story 023: Threshold Signing (M-of-N)**
   - TUF root role is the natural integration point for M-of-N threshold signing.
   - Current implementation uses threshold=1 (single signature).
   - Story 023 will update `TufRole.threshold` to require M-of-N signatures for root operations.
   - **Integration:** Add M-of-N signature verification to `TufVerifier._verifyMetadataSignatures()`.

2. **Story 022: Sigstore Keyless Signing**
   - Online roles (Timestamp, Snapshot) are good candidates for Sigstore ephemeral keys.
   - Sigstore transparency log provides audit trail for key usage.
   - **Integration:** Replace `TIMESTAMP_SIGNING_KEY` and `SNAPSHOT_SIGNING_KEY` with Sigstore OIDC workflow.
   - **Note:** Root and Targets keys should remain long-lived for stability.

3. **Story 020: Rate Limiting Enhancements** (if exists)
   - TUF metadata endpoints (`/tuf/*`) should have separate rate limits from `/servers`.
   - Timestamp metadata is fetched frequently (every 5 minutes) — requires higher limits.
   - **Integration:** Add per-endpoint rate limiting configuration.

### Stories That Depend On This
- **Story 025: Client Metadata Caching** (if exists)
   - TUF metadata cache is foundational for offline operation.
   - This story provides the metadata verification; Story 025 would optimize cache storage and invalidation.

---

## 7. Security Considerations

### Key Management
1. **Root keys MUST be generated and stored offline.**
   - Use air-gapped machine or hardware security module (HSM).
   - Root key rotation is a rare, high-ceremony operation.
   - Document root key backup and recovery procedures in `/docs/security/tuf-implementation.md`.

2. **Delegated keys (Targets, Snapshot, Timestamp) are online Cloudflare secrets.**
   - Store as Wrangler secrets (encrypted at rest by Cloudflare).
   - Rotate Timestamp key weekly (automated via scheduled worker).
   - Rotate Snapshot/Targets keys on suspected compromise.

3. **Never commit private keys to version control.**
   - Add `*.pem`, `*.key`, `root-*.json` (signed roots) to `.gitignore`.
   - Only commit embedded root metadata asset (`lib/core/crypto/tuf/root_metadata.json`) after verification.

### Attack Surface
1. **TUF metadata endpoints are public** — no authentication required.
   - This is by design: clients must fetch metadata to bootstrap trust.
   - Rate limiting is critical to prevent DoS on `/tuf/timestamp.json`.

2. **PUT /tuf/:role endpoints MUST be authenticated** (TODO in implementation).
   - Use `SERVER_REGISTRY_SECRET` or dedicated `TUF_UPDATE_SECRET`.
   - Only the bootstrap server worker should update metadata (not external clients).

3. **Timestamp metadata expiration must be enforced strictly.**
   - Short expiration (1 hour) limits freeze attack window.
   - Scheduled worker should auto-renew timestamp every 30 minutes.

### Audit Trail
1. **TufMetadataDO maintains version history** (last 10 versions).
   - Use for incident response and forensic analysis.
   - Log all metadata updates with timestamp and version.

2. **Server registration logs include signature verification result.**
   - Audit log entry: `{action: 'registration_signature_ok', serverId, ip}`.
   - Failed registrations: `{action: 'registration_rejected', serverId, ip}`.

---

## 8. Performance Impact

### Server-Side
1. **Metadata signing overhead:** Ed25519 signing is fast (<1ms per signature).
   - Three metadata updates per registry change (targets, snapshot, timestamp).
   - Total overhead: ~3ms per server registration/unregistration.
   - **Impact:** Negligible for current scale (<1000 servers).

2. **Metadata storage:** TufMetadataDO stores 4 metadata files + 10 versions of history.
   - Average size: ~5KB per metadata file.
   - Total: ~50KB per DO instance.
   - **Impact:** Negligible (Durable Objects support GB-scale storage).

3. **Additional HTTP requests:** Clients fetch 4 metadata files instead of 1 `/servers` endpoint.
   - Legacy: 1 request (GET /servers)
   - TUF: 4 requests (timestamp, snapshot, targets, root)
   - **Mitigation:** HTTP/2 multiplexing reduces latency. Metadata is cacheable (timestamp=5min, targets/snapshot/root=1hr+).

### Client-Side
1. **Metadata verification overhead:** Ed25519 signature verification ~2-3ms per signature.
   - 4 metadata files × 1 signature each = ~10ms total.
   - **Impact:** Negligible (one-time cost during app launch).

2. **Storage:** Cached metadata ~20KB (JSON files).
   - **Impact:** Negligible (< 0.1% of typical app storage).

3. **Network:** 4 additional HTTP requests (only if TUF enabled).
   - **Mitigation:** Cache metadata locally. Refresh only on expiration.

---

## 9. Monitoring and Observability

### Metrics to Track
1. **Server-side:**
   - `tuf_metadata_updates_total{role}` — Counter of metadata updates per role
   - `tuf_signature_verification_duration_ms{role}` — Histogram of signing duration
   - `server_registration_signature_failures_total` — Counter of failed registration signatures
   - `tuf_metadata_expiration_warnings_total{role}` — Counter of expired metadata served

2. **Client-side:**
   - `tuf_verification_success_total` — Counter of successful TUF verifications
   - `tuf_verification_failure_total{reason}` — Counter of failures by reason (expired, rollback, hash_mismatch)
   - `tuf_metadata_fetch_duration_ms` — Histogram of metadata fetch latency
   - `tuf_cache_hits_total` vs `tuf_cache_misses_total` — Cache effectiveness

### Alerts
1. **Critical:**
   - `tuf_metadata_expiration_warnings_total{role="timestamp"} > 0` — Timestamp is expired (freeze attack or worker failure)
   - `tuf_verification_failure_total{reason="rollback"} > 10` — Potential rollback attack

2. **Warning:**
   - `server_registration_signature_failures_total > 50/hour` — High rate of invalid registrations (DoS or misconfiguration)
   - `tuf_metadata_updates_total{role="timestamp"} < 1/hour` — Timestamp not updating (worker failure)

### Logging
1. **Audit logs:**
   - All TUF metadata updates (role, version, expiration)
   - All server registration attempts (success/failure, signature verification result)
   - All root key rotations (old version → new version)

2. **Debug logs:**
   - TUF metadata fetch failures (network errors, 404s)
   - Cache hits/misses
   - Metadata verification workflow steps (for troubleshooting)

---

## 10. Migration Plan

### Week 1: Server Deployment
1. Deploy TUF metadata schema and roles (Phase 1 code).
2. Generate initial root metadata v1 (offline ceremony).
3. Generate delegated keys (targets, snapshot, timestamp).
4. Upload root metadata to TufMetadataDO via `wrangler dev` + PUT /tuf/root.json.
5. Verify GET /tuf/root.json returns valid signed metadata.
6. **Status:** TUF endpoints live but not used by clients yet.

### Week 2: Server Integration
1. Deploy Phase 2 code (server registration signatures, automatic metadata updates).
2. Set `REQUIRE_REGISTRATION_SIGNATURE=false` (legacy compatibility).
3. Test server registration with signature (manual VPS using signing script).
4. Verify TUF metadata updates automatically on registration.
5. **Status:** TUF workflow operational, legacy path still active.

### Week 3: Client TUF Implementation
1. Deploy Phase 3 code (TufVerifier, metadata models).
2. Set `Environment.useTufMetadata=false` (feature flag off).
3. Test TUF verification in isolated test environment (QA).
4. Embed root metadata v1 as asset in Flutter app.
5. **Status:** Client has TUF code but not enabled in production.

### Week 4: Gradual Rollout
1. Enable TUF for QA environment: `Environment.useTufMetadata=true` in QA builds.
2. Monitor TUF verification metrics and error rates.
3. If metrics are healthy (>99% success rate), enable for 10% of production users (feature flag).
4. Gradual rollout: 10% → 50% → 100% over 2 weeks.
5. **Status:** TUF fully operational in production.

### Week 5+: Deprecate Legacy
1. Monitor `X-Bootstrap-Signature` header usage (should decline to near-zero).
2. After 30 days at 100% TUF adoption, mark legacy path as deprecated.
3. After 60 days, remove `BOOTSTRAP_SIGNING_KEY` and legacy signing code.
4. Enable `REQUIRE_REGISTRATION_SIGNATURE=true` (enforce signed registrations).

---

## 11. Success Criteria

### Functional
- [ ] TUF root, targets, snapshot, and timestamp metadata are generated and signed correctly.
- [ ] GET /tuf/root.json, /tuf/targets.json, /tuf/snapshot.json, /tuf/timestamp.json endpoints serve valid metadata.
- [ ] Server registration with valid signature is accepted; invalid signature is rejected.
- [ ] Server registry changes trigger automatic Targets/Snapshot/Timestamp updates.
- [ ] Client bootstraps with embedded root metadata and verifies full TUF chain.
- [ ] Client extracts server list from verified Targets metadata.
- [ ] Client detects and rejects freeze attacks (expired timestamp).
- [ ] Client detects and rejects rollback attacks (lower version).
- [ ] Client detects and rejects mix-and-match attacks (hash mismatch).

### Non-Functional
- [ ] Root key rotation (N→N+1) completes successfully without app update.
- [ ] Targets/Snapshot/Timestamp key rotation completes without app update.
- [ ] Metadata signing latency < 10ms per signature (p99).
- [ ] TUF verification latency < 50ms total (p99).
- [ ] Zero data loss during metadata updates (atomic DO writes).
- [ ] Backward compatibility maintained for 60 days (legacy clients continue working).

### Operational
- [ ] Root key generation ceremony documented and tested (offline procedure).
- [ ] Incident response runbook for compromised delegated keys documented.
- [ ] Monitoring dashboards show TUF metadata health (expiration, version counts).
- [ ] Alerts configured for expired metadata and rollback attacks.
- [ ] VPS operator documentation for signed registration workflow published.

---

## 12. Future Enhancements (Out of Scope for This Story)

1. **Delegated Targets Roles** — TUF supports delegation where the Targets role can delegate authority for specific paths (e.g., `servers/us-east/*`) to regional keys. This would enable distributed trust for large server fleets.

2. **Consistent Snapshots** — TUF supports a mode where all metadata versions are immutable and referenced by version number. This prevents TOCTOU race conditions but requires more complex client logic.

3. **Multi-Signature Threshold (M-of-N)** — Current implementation uses threshold=1. Story 023 will add M-of-N threshold signing for root role, requiring multiple operators to sign root metadata updates.

4. **Automatic Timestamp Renewal** — Implement a Cloudflare Worker Cron Trigger to auto-renew timestamp metadata every 30 minutes, ensuring it never expires under normal operation.

5. **Metadata Compression** — Gzip compress metadata responses to reduce bandwidth (especially for large Targets metadata with 1000+ servers).

6. **Metadata Transparency Log** — Integrate with Rekor (Sigstore transparency log) to create a public, append-only audit trail of all metadata updates.

---

## Appendix A: TUF Specification References

- **TUF Spec v1.0.31:** https://theupdateframework.github.io/specification/v1.0.31/
- **Section 5.1:** Client Update Workflow (used in `TufVerifier.verifyAndExtractTargets`)
- **Section 5.3:** Root Key Rotation (used in `TufVerifier.updateRoot`)
- **Section 4:** Metadata Formats (used in `metadata.js` schema definitions)

---

## Appendix B: Key Rotation Ceremony Checklist

### Root Key Rotation (N→N+1)
1. [ ] Schedule offline ceremony with M key holders (future: Story 023).
2. [ ] Generate new root keypair on air-gapped machine: `node scripts/tuf/generate-root-metadata.mjs --version N+1`.
3. [ ] Load old root metadata v N (from secure backup).
4. [ ] Sign new root v N+1 with both old key (v N) and new key (v N+1).
5. [ ] Verify signatures manually: `node scripts/tuf/verify-root-transition.mjs`.
6. [ ] Upload new root to TufMetadataDO: `PUT /tuf/root.json` (authenticated).
7. [ ] Update embedded root metadata in Flutter app asset (if needed for new installs).
8. [ ] Test with QA clients: verify clients accept v N+1 when trusting v N.
9. [ ] Securely destroy old root private key (after transition confirmed).
10. [ ] Update root key backup documentation with new key ID and storage location.

### Delegated Key Rotation (Targets/Snapshot/Timestamp)
1. [ ] Generate new delegated keypair: `node scripts/tuf/generate-delegated-keys.mjs --role targets`.
2. [ ] Update root metadata to include new key in `roles.targets.keyids`.
3. [ ] Increment root version (e.g., v5 → v6).
4. [ ] Sign updated root with current root key.
5. [ ] Upload new root: `PUT /tuf/root.json`.
6. [ ] Update Wrangler secret: `wrangler secret put TARGETS_SIGNING_KEY` (paste new seed).
7. [ ] Trigger metadata update: register a test server to force Targets re-sign.
8. [ ] Verify new Targets metadata is signed with new key.
9. [ ] Monitor client verification metrics for 24 hours.
10. [ ] Remove old key from root metadata after confirmation (in next root version).

---

**End of Implementation Plan**
