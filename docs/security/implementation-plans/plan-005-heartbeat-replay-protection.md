# Implementation Plan 005: Add Heartbeat Timestamp/Replay Protection

## Summary

This plan implements replay protection for federation heartbeat messages in the Zajel bootstrap server registry. Currently, heartbeat requests from VPS servers to the Cloudflare Workers bootstrap registry contain no timestamp, nonce, or sequence number. This allows an attacker who captures a valid heartbeat request to replay it indefinitely, keeping stale or compromised server entries alive in the registry, polluting anomaly detection metrics, and subverting quarantine mechanisms.

The implementation adds three layers of replay protection:
1. **Timestamp validation** - Reject heartbeats older than 2 minutes or more than 30 seconds in the future
2. **Nonce deduplication** - Reject heartbeats with previously-seen nonces within a 5-minute window
3. **Sequence number enforcement** - Reject heartbeats with sequence numbers less than or equal to the last accepted one

Additionally, this plan addresses a critical companion issue: the VPS client currently does NOT send the `Authorization` header with `SERVER_REGISTRY_SECRET` on heartbeat, register, or unregister requests. Without authentication, replay protection alone is insufficient since an attacker can craft arbitrary fresh requests.

**Severity**: HIGH
**Priority**: THIS WEEK
**Estimated Effort**: 6-8 hours (including tests)

---

## Files to Modify

### 1. `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts`
**Purpose**: Add timestamp, nonce, and sequence number to heartbeat and register requests. Add Authorization header.

**Lines affected**:
- Lines 42-43: Add `heartbeatSeq` counter and `registrationNonce` storage
- Lines 49-88: Modify `register()` to include timestamp and nonce
- Lines 71-75: Add Authorization header to register request
- Lines 90-106: Modify `unregister()` to include Authorization header
- Lines 126-168: Modify `heartbeat()` to include timestamp, nonce, sequence number, and Authorization header

### 2. `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`
**Purpose**: Validate timestamp freshness, nonce uniqueness, and sequence number monotonicity. Add nonce cleanup.

**Lines affected**:
- Lines 16-20: Add replay protection constants (after existing constants)
- Lines 295-312: Modify constructor to initialize nonce cleanup state
- Lines 317-337: Modify `alarm()` to include nonce cleanup
- Lines 464-631: Modify `registerServer()` to validate timestamp and nonce
- Lines 706-842: Modify `heartbeat()` to validate timestamp, nonce, and sequence number

### 3. `/home/meywd/zajel-ddos/packages/server-vps/src/config.ts`
**Purpose**: Add configuration option for SERVER_REGISTRY_SECRET.

**Lines affected**: Lines 48-57 (bootstrap config section)

### 4. `/home/meywd/zajel-ddos/packages/server-vps/src/types.ts`
**Purpose**: Add registrySecret field to bootstrap config type.

**Lines affected**: Lines 252-258 (ServerConfig.bootstrap interface)

---

## Implementation Steps

### Step 1: Add constants for replay protection (server-registry-do.js)

**Location**: `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` at line 18

**Before**:
```javascript
/** Maximum number of server entries allowed in the registry */
const MAX_SERVER_ENTRIES = 1000;

/** Number of heartbeat snapshots to retain per server for anomaly analysis */
const ANOMALY_HISTORY_SIZE = 30;
```

**After**:
```javascript
/** Maximum number of server entries allowed in the registry */
const MAX_SERVER_ENTRIES = 1000;

/** Number of heartbeat snapshots to retain per server for anomaly analysis */
const ANOMALY_HISTORY_SIZE = 30;

/** Maximum age for heartbeat/registration timestamps (2 minutes in the past) */
const HEARTBEAT_MAX_AGE_MS = 2 * 60 * 1000;

/** Maximum future offset for timestamps (30 seconds ahead of server clock) */
const HEARTBEAT_MAX_FUTURE_MS = 30 * 1000;

/** How long to keep nonces in storage before pruning (5 minutes) */
const NONCE_EXPIRY_MS = 5 * 60 * 1000;

/** Minimum nonce length (UUIDs are 36 chars, accept >= 16 for flexibility) */
const MIN_NONCE_LENGTH = 16;
```

---

### Step 2: Add sequence number tracking and nonce cleanup to constructor (server-registry-do.js)

**Location**: `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` at line 295

**Before**:
```javascript
export class ServerRegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env);
    // TTL for server entries (5 minutes)
    this.serverTTL = 5 * 60 * 1000;

    // Schedule periodic cleanup alarm
    if (state.blockConcurrencyWhile) {
      state.blockConcurrencyWhile(async () => {
        const currentAlarm = await state.storage.getAlarm();
        if (!currentAlarm) {
          await state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
        }
      });
    }
  }
```

**After**:
```javascript
export class ServerRegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env);
    // TTL for server entries (5 minutes)
    this.serverTTL = 5 * 60 * 1000;

    // Schedule periodic cleanup alarm for stale servers AND expired nonces
    if (state.blockConcurrencyWhile) {
      state.blockConcurrencyWhile(async () => {
        const currentAlarm = await state.storage.getAlarm();
        if (!currentAlarm) {
          await state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
        }
      });
    }
  }
```

---

### Step 3: Add nonce cleanup to alarm handler (server-registry-do.js)

**Location**: `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` at line 317

**Before**:
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

**After**:
```javascript
  async alarm() {
    const now = Date.now();
    const deleteKeys = [];

    // Clean up stale server entries
    const entries = await this.state.storage.list({ prefix: 'server:' });
    for (const [key, server] of entries) {
      if (now - server.lastSeen >= this.serverTTL) {
        deleteKeys.push(key);
        // Also clean up anomaly history and score for this server
        deleteKeys.push(`anomaly-history:${server.serverId}`);
        deleteKeys.push(`anomaly-score:${server.serverId}`);
      }
    }

    // Clean up expired nonces (prevent unbounded storage growth)
    const nonces = await this.state.storage.list({ prefix: 'nonce:' });
    for (const [key, data] of nonces) {
      if (now - data.timestamp >= NONCE_EXPIRY_MS) {
        deleteKeys.push(key);
      }
    }

    // Batch delete all expired items in chunks of 128 (CF DO limit)
    if (deleteKeys.length > 0) {
      for (let i = 0; i < deleteKeys.length; i += 128) {
        await this.state.storage.delete(deleteKeys.slice(i, i + 128));
      }
      this.logger.info('[cleanup] Alarm deleted expired entries', {
        action: 'alarm_cleanup',
        deletedCount: deleteKeys.length,
      });
    }

    // Reschedule next cleanup
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }
```

---

### Step 4: Add timestamp and nonce validation to registerServer (server-registry-do.js)

**Location**: `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` at line 464

**Before**:
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

    // Validate serverId format
    if (!isValidId(serverId)) {
```

**After**:
```javascript
  async registerServer(request, corsHeaders) {
    const body = await parseJsonBody(request, 4096);
    const { serverId, endpoint, publicKey, region, timestamp, nonce } = body;

    if (!serverId || !endpoint || !publicKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // --- Replay protection: Validate timestamp freshness ---
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid timestamp' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const now = Date.now();
    const age = now - timestamp;
    if (age > HEARTBEAT_MAX_AGE_MS) {
      this.logger.warn('[security] Registration rejected: timestamp too old', {
        action: 'register_replay_detected',
        serverId,
        age,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Registration timestamp too old (max 2 minutes)' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
    if (age < -HEARTBEAT_MAX_FUTURE_MS) {
      this.logger.warn('[security] Registration rejected: timestamp too far in future', {
        action: 'register_clock_skew',
        serverId,
        skew: -age,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Registration timestamp too far in future (max 30 seconds)' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // --- Replay protection: Validate nonce uniqueness ---
    if (typeof nonce !== 'string' || nonce.length < MIN_NONCE_LENGTH) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid nonce (must be string >= 16 chars)' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const nonceKey = `nonce:${nonce}`;
    const existingNonce = await this.state.storage.get(nonceKey);
    if (existingNonce) {
      this.logger.warn('[security] Registration rejected: duplicate nonce (replay attack)', {
        action: 'register_nonce_replay',
        serverId,
        nonce: nonce.slice(0, 16),
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Replay detected: duplicate nonce' }),
        { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Store nonce with timestamp for expiry tracking (alarm will clean up)
    await this.state.storage.put(nonceKey, { timestamp: now });

    // Validate serverId format
    if (!isValidId(serverId)) {
```

---

### Step 5: Add timestamp, nonce, and sequence validation to heartbeat (server-registry-do.js)

**Location**: `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` at line 706

**Before**:
```javascript
  async heartbeat(request, corsHeaders) {
    const body = await parseJsonBody(request, 2048);
    const { serverId } = body;

    if (!serverId) {
      return new Response(
        JSON.stringify({ error: 'Missing serverId' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (!isValidId(serverId)) {
      return new Response(
        JSON.stringify({ error: 'Invalid serverId format' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const server = await this.state.storage.get(`server:${serverId}`);

    if (!server) {
      return new Response(
        JSON.stringify({ error: 'Server not registered' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    server.lastSeen = Date.now();
```

**After**:
```javascript
  async heartbeat(request, corsHeaders) {
    const body = await parseJsonBody(request, 2048);
    const { serverId, timestamp, nonce, sequenceNumber } = body;

    if (!serverId) {
      return new Response(
        JSON.stringify({ error: 'Missing serverId' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (!isValidId(serverId)) {
      return new Response(
        JSON.stringify({ error: 'Invalid serverId format' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // --- Replay protection: Validate timestamp freshness ---
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid timestamp' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const now = Date.now();
    const age = now - timestamp;
    if (age > HEARTBEAT_MAX_AGE_MS) {
      this.logger.warn('[security] Heartbeat rejected: timestamp too old', {
        action: 'heartbeat_replay_detected',
        serverId,
        age,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Heartbeat timestamp too old (max 2 minutes)' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
    if (age < -HEARTBEAT_MAX_FUTURE_MS) {
      this.logger.warn('[security] Heartbeat rejected: timestamp too far in future', {
        action: 'heartbeat_clock_skew',
        serverId,
        skew: -age,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Heartbeat timestamp too far in future (max 30 seconds)' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // --- Replay protection: Validate nonce uniqueness ---
    if (typeof nonce !== 'string' || nonce.length < MIN_NONCE_LENGTH) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid nonce (must be string >= 16 chars)' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const nonceKey = `nonce:${nonce}`;
    const existingNonce = await this.state.storage.get(nonceKey);
    if (existingNonce) {
      this.logger.warn('[security] Heartbeat rejected: duplicate nonce (replay attack)', {
        action: 'heartbeat_nonce_replay',
        serverId,
        nonce: nonce.slice(0, 16),
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Replay detected: duplicate nonce' }),
        { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Store nonce with timestamp for expiry tracking
    await this.state.storage.put(nonceKey, { timestamp: now });

    const server = await this.state.storage.get(`server:${serverId}`);

    if (!server) {
      return new Response(
        JSON.stringify({ error: 'Server not registered' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // --- Replay protection: Validate sequence number (monotonic increase) ---
    if (typeof sequenceNumber === 'number' && Number.isFinite(sequenceNumber)) {
      if (typeof server.lastSequenceNumber === 'number') {
        if (sequenceNumber <= server.lastSequenceNumber) {
          this.logger.warn('[security] Heartbeat rejected: stale sequence number', {
            action: 'heartbeat_sequence_replay',
            serverId,
            received: sequenceNumber,
            expected: server.lastSequenceNumber + 1,
            ip: request.headers.get('CF-Connecting-IP'),
          });
          return new Response(
            JSON.stringify({
              error: 'Replay detected: sequence number must be greater than last accepted',
              lastSequenceNumber: server.lastSequenceNumber,
            }),
            { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
      }
      server.lastSequenceNumber = sequenceNumber;
    }

    server.lastSeen = now;
```

---

### Step 6: Add config field for SERVER_REGISTRY_SECRET (config.ts)

**Location**: `/home/meywd/zajel-ddos/packages/server-vps/src/config.ts` at line 48

**Before**:
```typescript
  bootstrap: {
    serverUrl: envString('ZAJEL_BOOTSTRAP_URL', 'https://signal.zajel.hamzalabs.dev'),
    nodes: envString('ZAJEL_BOOTSTRAP_NODES', '').split(',').filter(Boolean),
    retryInterval: envNumber('ZAJEL_BOOTSTRAP_RETRY_INTERVAL', 10000),
    maxRetries: envNumber('ZAJEL_BOOTSTRAP_MAX_RETRIES', 5),
    heartbeatInterval: envNumber('ZAJEL_BOOTSTRAP_HEARTBEAT', 60000), // 1 minute
  },
```

**After**:
```typescript
  bootstrap: {
    serverUrl: envString('ZAJEL_BOOTSTRAP_URL', 'https://signal.zajel.hamzalabs.dev'),
    registrySecret: envString('ZAJEL_REGISTRY_SECRET', ''),
    nodes: envString('ZAJEL_BOOTSTRAP_NODES', '').split(',').filter(Boolean),
    retryInterval: envNumber('ZAJEL_BOOTSTRAP_RETRY_INTERVAL', 10000),
    maxRetries: envNumber('ZAJEL_BOOTSTRAP_MAX_RETRIES', 5),
    heartbeatInterval: envNumber('ZAJEL_BOOTSTRAP_HEARTBEAT', 60000), // 1 minute
  },
```

---

### Step 7: Add registrySecret to ServerConfig type (types.ts)

**Location**: `/home/meywd/zajel-ddos/packages/server-vps/src/types.ts` at line 252

**Before**:
```typescript
  bootstrap: {
    serverUrl: string;          // CF Workers bootstrap server URL
    heartbeatInterval: number;  // How often to ping CF
    nodes: string[];            // Legacy: direct peer nodes
    retryInterval: number;
    maxRetries: number;
  };
```

**After**:
```typescript
  bootstrap: {
    serverUrl: string;          // CF Workers bootstrap server URL
    registrySecret: string;     // SERVER_REGISTRY_SECRET for authentication
    heartbeatInterval: number;  // How often to ping CF
    nodes: string[];            // Legacy: direct peer nodes
    retryInterval: number;
    maxRetries: number;
  };
```

---

### Step 8: Add timestamp, nonce, sequence to client register() (bootstrap-client.ts)

**Location**: `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts` at line 36

**Before**:
```typescript
export function createBootstrapClient(
  config: ServerConfig,
  identity: ServerIdentity,
  getMetrics?: () => BootstrapMetrics,
  buildManifest?: BuildManifest | null,
): BootstrapClient {
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const baseUrl = config.bootstrap.serverUrl;

  async function register(): Promise<void> {
    const url = `${baseUrl}/servers`;

    const metrics = getMetrics?.();
    const body: Record<string, unknown> = {
      serverId: identity.serverId,
      endpoint: config.network.publicEndpoint,
      publicKey: base64Encode(identity.publicKey),
      region: config.network.region || 'unknown',
```

**After**:
```typescript
export function createBootstrapClient(
  config: ServerConfig,
  identity: ServerIdentity,
  getMetrics?: () => BootstrapMetrics,
  buildManifest?: BuildManifest | null,
): BootstrapClient {
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatSeq = 0;
  const baseUrl = config.bootstrap.serverUrl;

  async function register(): Promise<void> {
    const url = `${baseUrl}/servers`;

    const metrics = getMetrics?.();
    const body: Record<string, unknown> = {
      serverId: identity.serverId,
      timestamp: Date.now(),
      nonce: crypto.randomUUID(),
      endpoint: config.network.publicEndpoint,
      publicKey: base64Encode(identity.publicKey),
      region: config.network.region || 'unknown',
```

---

### Step 9: Add Authorization header to register() (bootstrap-client.ts)

**Location**: `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts` at line 70

**Before**:
```typescript
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
```

**After**:
```typescript
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.bootstrap.registrySecret) {
        headers['Authorization'] = `Bearer ${config.bootstrap.registrySecret}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
```

---

### Step 10: Add Authorization header to unregister() (bootstrap-client.ts)

**Location**: `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts` at line 90

**Before**:
```typescript
  async function unregister(): Promise<void> {
    const url = `${baseUrl}/servers/${encodeURIComponent(identity.serverId)}`;

    console.log(`[Bootstrap] Unregistering from ${baseUrl}...`);

    try {
      const response = await fetch(url, { method: 'DELETE' });
```

**After**:
```typescript
  async function unregister(): Promise<void> {
    const url = `${baseUrl}/servers/${encodeURIComponent(identity.serverId)}`;

    console.log(`[Bootstrap] Unregistering from ${baseUrl}...`);

    try {
      const headers: Record<string, string> = {};
      if (config.bootstrap.registrySecret) {
        headers['Authorization'] = `Bearer ${config.bootstrap.registrySecret}`;
      }

      const response = await fetch(url, {
        method: 'DELETE',
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
```

---

### Step 11: Add timestamp, nonce, sequence, and auth to heartbeat() (bootstrap-client.ts)

**Location**: `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts` at line 126

**Before**:
```typescript
  async function heartbeat(): Promise<BootstrapServerEntry[]> {
    const url = `${baseUrl}/servers/heartbeat`;

    try {
      const metrics = getMetrics?.();
      const heartbeatBody: Record<string, unknown> = {
        serverId: identity.serverId,
        connections: metrics?.connections ?? 0,
        relayConnections: metrics?.relayConnections ?? 0,
        signalingConnections: metrics?.signalingConnections ?? 0,
        activeCodes: metrics?.activeCodes ?? 0,
      };

      // Include build signing data on heartbeat for ongoing verification
      if (buildManifest) {
        heartbeatBody.buildHash = buildManifest.buildHash;
        heartbeatBody.buildSignature = buildManifest.signature;
        heartbeatBody.buildSigningKey = buildManifest.publicKey;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heartbeatBody),
      });
```

**After**:
```typescript
  async function heartbeat(): Promise<BootstrapServerEntry[]> {
    const url = `${baseUrl}/servers/heartbeat`;

    try {
      heartbeatSeq++;

      const metrics = getMetrics?.();
      const heartbeatBody: Record<string, unknown> = {
        serverId: identity.serverId,
        timestamp: Date.now(),
        nonce: crypto.randomUUID(),
        sequenceNumber: heartbeatSeq,
        connections: metrics?.connections ?? 0,
        relayConnections: metrics?.relayConnections ?? 0,
        signalingConnections: metrics?.signalingConnections ?? 0,
        activeCodes: metrics?.activeCodes ?? 0,
      };

      // Include build signing data on heartbeat for ongoing verification
      if (buildManifest) {
        heartbeatBody.buildHash = buildManifest.buildHash;
        heartbeatBody.buildSignature = buildManifest.signature;
        heartbeatBody.buildSigningKey = buildManifest.publicKey;
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.bootstrap.registrySecret) {
        headers['Authorization'] = `Bearer ${config.bootstrap.registrySecret}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(heartbeatBody),
      });
```

---

## Test Plan

### Unit Tests (server-registry-do.js)

Create new test file: `/home/meywd/zajel-ddos/packages/server/tests/unit/heartbeat-replay-protection.test.js`

**Test cases**:

1. **Timestamp validation - past boundary**
   - Send heartbeat with timestamp exactly 2 minutes old
   - Expect: 200 OK (within window)
   - Send heartbeat with timestamp 2 minutes + 1 second old
   - Expect: 400 Bad Request with error "timestamp too old"

2. **Timestamp validation - future boundary**
   - Send heartbeat with timestamp 30 seconds in future
   - Expect: 200 OK (within window)
   - Send heartbeat with timestamp 31 seconds in future
   - Expect: 400 Bad Request with error "timestamp too far in future"

3. **Nonce deduplication - same nonce twice**
   - Register server A
   - Send heartbeat with nonce "test-nonce-123"
   - Expect: 200 OK
   - Send heartbeat again with same nonce "test-nonce-123" immediately
   - Expect: 409 Conflict with error "duplicate nonce"

4. **Nonce deduplication - different nonces succeed**
   - Register server A
   - Send heartbeat with nonce "nonce-1"
   - Expect: 200 OK
   - Send heartbeat with nonce "nonce-2"
   - Expect: 200 OK

5. **Sequence number - monotonic increase enforced**
   - Register server A
   - Send heartbeat with sequenceNumber: 1
   - Expect: 200 OK
   - Send heartbeat with sequenceNumber: 5
   - Expect: 200 OK (jump allowed)
   - Send heartbeat with sequenceNumber: 3 (less than 5)
   - Expect: 409 Conflict with error "stale sequence number"

6. **Sequence number - equal rejected**
   - Register server A
   - Send heartbeat with sequenceNumber: 10
   - Expect: 200 OK
   - Send heartbeat with sequenceNumber: 10 (same)
   - Expect: 409 Conflict

7. **Missing timestamp field**
   - Send heartbeat without timestamp field
   - Expect: 400 Bad Request with error "Missing or invalid timestamp"

8. **Invalid timestamp type**
   - Send heartbeat with timestamp: "not-a-number"
   - Expect: 400 Bad Request

9. **Missing nonce field**
   - Send heartbeat without nonce field
   - Expect: 400 Bad Request with error "Missing or invalid nonce"

10. **Nonce too short**
    - Send heartbeat with nonce: "short" (< 16 chars)
    - Expect: 400 Bad Request

11. **Registration with replay protection**
    - Send registration with valid timestamp and nonce
    - Expect: 200 OK
    - Replay same registration (same nonce)
    - Expect: 409 Conflict

### Integration Tests (alarm cleanup)

Add to: `/home/meywd/zajel-ddos/packages/server/tests/e2e/bootstrap.test.js`

**Test case: Nonce expiry and cleanup**
```javascript
it('should clean up expired nonces after 5 minutes', async () => {
  const serverData = {
    serverId: 'ed25519:nonce-test',
    endpoint: 'wss://nonce.example.com',
    publicKey: 'nonce-key',
    timestamp: Date.now(),
    nonce: 'test-nonce-expires',
  };

  await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

  // Verify nonce is stored
  const storedNonce = await mockState.storage.get('nonce:test-nonce-expires');
  expect(storedNonce).toBeDefined();

  // Advance time by 6 minutes (past 5 minute expiry)
  vi.advanceTimersByTime(6 * 60 * 1000);

  // Trigger alarm
  await serverRegistry.alarm();

  // Verify nonce is removed
  const expiredNonce = await mockState.storage.get('nonce:test-nonce-expires');
  expect(expiredNonce).toBeUndefined();
});
```

**Test case: Fresh nonces not cleaned up**
```javascript
it('should keep nonces that are less than 5 minutes old', async () => {
  const serverData = {
    serverId: 'ed25519:fresh-nonce',
    endpoint: 'wss://fresh.example.com',
    publicKey: 'fresh-key',
    timestamp: Date.now(),
    nonce: 'fresh-nonce-123',
  };

  await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

  // Advance time by 4 minutes (within 5 minute window)
  vi.advanceTimersByTime(4 * 60 * 1000);

  await serverRegistry.alarm();

  // Verify nonce still exists
  const freshNonce = await mockState.storage.get('nonce:fresh-nonce-123');
  expect(freshNonce).toBeDefined();
});
```

### Integration Tests (client-side)

Add to: `/home/meywd/zajel-ddos/packages/server-vps/tests/integration/bootstrap-client.test.ts`

**Test case: Heartbeat includes replay protection fields**
```typescript
it('should include timestamp, nonce, and sequenceNumber in heartbeat', async () => {
  // Create mock bootstrap server that captures request body
  let capturedBody: any = null;

  const mockServer = http.createServer((req, res) => {
    if (req.url === '/servers/heartbeat' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, peers: [] }));
      });
    }
  });

  await new Promise(resolve => mockServer.listen(0, resolve));
  const port = (mockServer.address() as any).port;

  const config = {
    // ... config with bootstrap.serverUrl = `http://localhost:${port}`
  };

  const client = createBootstrapClient(config, identity, getMetrics);

  // Manually trigger heartbeat
  await client.startHeartbeat();
  await new Promise(resolve => setTimeout(resolve, 100));

  expect(capturedBody).toBeDefined();
  expect(typeof capturedBody.timestamp).toBe('number');
  expect(typeof capturedBody.nonce).toBe('string');
  expect(capturedBody.nonce.length).toBeGreaterThanOrEqual(16);
  expect(typeof capturedBody.sequenceNumber).toBe('number');
  expect(capturedBody.sequenceNumber).toBe(1);

  mockServer.close();
});
```

**Test case: Authorization header sent when secret configured**
```typescript
it('should send Authorization header when registrySecret is set', async () => {
  let capturedAuthHeader: string | null = null;

  const mockServer = http.createServer((req, res) => {
    if (req.url === '/servers' && req.method === 'POST') {
      capturedAuthHeader = req.headers['authorization'] || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, server: {} }));
    }
  });

  await new Promise(resolve => mockServer.listen(0, resolve));
  const port = (mockServer.address() as any).port;

  const config = {
    // ... config with bootstrap.registrySecret = 'test-secret-123'
  };

  const client = createBootstrapClient(config, identity);
  await client.register();

  expect(capturedAuthHeader).toBe('Bearer test-secret-123');

  mockServer.close();
});
```

### Manual Testing

1. **Deploy with replay protection**
   - Deploy updated server-registry-do.js to Cloudflare Workers
   - Deploy updated VPS server with new client code
   - Set `ZAJEL_REGISTRY_SECRET` environment variable
   - Verify VPS can register and send heartbeats successfully

2. **Capture and replay heartbeat**
   - Use network proxy (mitmproxy or Burp Suite) to capture a valid heartbeat request
   - Wait 3 minutes
   - Replay the captured request
   - Expected: 400 Bad Request with "timestamp too old"

3. **Replay with same nonce**
   - Capture heartbeat request
   - Modify timestamp to be current
   - Replay immediately (keeping same nonce)
   - Expected: 409 Conflict with "duplicate nonce"

4. **Test sequence number enforcement**
   - Register VPS server
   - Send heartbeat with sequenceNumber: 100 (artificially high)
   - Send heartbeat with sequenceNumber: 50
   - Expected: 409 Conflict with "stale sequence number"

5. **Test nonce cleanup**
   - Register server and send heartbeat
   - Check DO storage for `nonce:*` keys (via wrangler tail logs showing storage size)
   - Wait 6 minutes (trigger alarm)
   - Verify old nonces are removed but fresh ones remain

---

## Rollback Risk

**Risk Level**: MEDIUM-LOW

**Breaking Changes**:
- VPS clients running old code (without timestamp/nonce fields) will be rejected by the upgraded bootstrap server with HTTP 400 errors
- Registration and heartbeat will fail until VPS servers are updated

**Mitigation Strategy**:

1. **Phased rollout**:
   - Phase 1: Deploy server-side changes with GRACE_PERIOD flag
     - Add temporary grace period mode: accept heartbeats WITHOUT replay fields but log warnings
     - Duration: 48 hours
   - Phase 2: Deploy client-side changes to all VPS servers
   - Phase 3: Remove grace period mode after all clients upgraded

2. **Grace period implementation** (optional):
   ```javascript
   // In heartbeat() handler, after checking serverId:
   const REPLAY_PROTECTION_GRACE_PERIOD = this.env.REPLAY_GRACE_MODE === 'true';

   if (!timestamp && REPLAY_PROTECTION_GRACE_PERIOD) {
     this.logger.warn('[migration] Heartbeat without replay protection (grace period)', {
       action: 'heartbeat_legacy',
       serverId,
     });
     // Continue with legacy flow (no replay checks)
   } else if (!timestamp) {
     // Reject after grace period
     return new Response(...);
   }
   ```

3. **Monitoring**:
   - Add Cloudflare Workers analytics to track rejection rates
   - Set up alerts for sudden spike in 400/409 responses
   - Monitor VPS server logs for auth failures

**Rollback Procedure**:
1. Set `REPLAY_GRACE_MODE=true` in Cloudflare Workers environment
2. Redeploy server-registry-do.js with grace period enabled
3. Investigate failed VPS servers
4. Once all servers upgraded, disable grace period

**Data Impact**:
- None - no storage schema changes
- Nonces are additive (new storage keys with `nonce:` prefix)
- Sequence numbers are additive (new field on existing server entries)

---

## Dependencies on Other Stories

### Blocking Dependencies (must be implemented BEFORE this story):

**Story 004: SERVER_REGISTRY_SECRET Auth Bypass When Unset**
- **Reason**: The current server-side auth check pattern is `if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request))`, which fails open when the secret is not set. This means even with replay protection, an attacker can bypass authentication entirely if the secret is not configured.
- **Resolution**: Story 004 must fix the fail-open auth pattern to fail-closed BEFORE adding replay protection. Otherwise, replay protection is meaningless without authentication.
- **Specific changes needed from Story 004**:
  - Change auth pattern to reject when `SERVER_REGISTRY_SECRET` is not set
  - Return 503 Service Unavailable or 401 Unauthorized instead of allowing unauthenticated access
  - Both client and server must handle the presence/absence of the secret correctly

### Non-blocking Dependencies (nice to have):

**Story 011: Per-Endpoint Rate Limiting**
- **Reason**: Replay protection prevents reusing old requests, but does not prevent an attacker from generating many NEW valid requests (with fresh timestamps and nonces). Rate limiting adds defense in depth.
- **Impact if not done**: An attacker with a valid `SERVER_REGISTRY_SECRET` can still flood the registry with registrations or heartbeats.

**Story 013: NaN Input Validation**
- **Reason**: The timestamp validation uses `Number.isFinite()` checks, but should also validate that timestamps are not `NaN`, `Infinity`, or negative.
- **Impact if not done**: Edge cases around numeric validation may allow bypass.

### Stories that DEPEND ON this story:

**Story 020: IP Reputation Scoring**
- IP reputation can use the replay detection logs (`heartbeat_replay_detected`, `heartbeat_nonce_replay`) as signals for malicious behavior scoring.

**Story 018: SDP Signing** (WebRTC signaling message replay)
- Same timestamp/nonce pattern should be applied to WebRTC signaling messages between peers. This story establishes the pattern.

---

## Success Criteria

- [ ] All unit tests pass (timestamp, nonce, sequence validation)
- [ ] All integration tests pass (alarm cleanup, client sends fields)
- [ ] VPS client sends `timestamp`, `nonce`, `sequenceNumber` in heartbeat and register
- [ ] VPS client sends `Authorization: Bearer <SECRET>` header when configured
- [ ] Server rejects heartbeats with timestamps > 2 minutes old (HTTP 400)
- [ ] Server rejects heartbeats with timestamps > 30 seconds in future (HTTP 400)
- [ ] Server rejects heartbeats with duplicate nonces (HTTP 409)
- [ ] Server rejects heartbeats with stale sequence numbers (HTTP 409)
- [ ] Alarm handler cleans up nonces older than 5 minutes
- [ ] Alarm handler does NOT delete nonces less than 5 minutes old
- [ ] Manual replay attack test fails with 409 or 400
- [ ] No regression in existing bootstrap tests
- [ ] Documentation updated in server-registry-do.js comments
- [ ] Security audit log entries include replay detection events

---

## Security Audit Log Events

The following log entries will be emitted for security monitoring:

```javascript
// Timestamp too old
this.logger.warn('[security] Heartbeat rejected: timestamp too old', {
  action: 'heartbeat_replay_detected',
  serverId,
  age,  // milliseconds
  ip: request.headers.get('CF-Connecting-IP'),
});

// Timestamp too far in future (clock skew attack)
this.logger.warn('[security] Heartbeat rejected: timestamp too far in future', {
  action: 'heartbeat_clock_skew',
  serverId,
  skew,  // milliseconds
  ip: request.headers.get('CF-Connecting-IP'),
});

// Duplicate nonce (replay attack)
this.logger.warn('[security] Heartbeat rejected: duplicate nonce (replay attack)', {
  action: 'heartbeat_nonce_replay',
  serverId,
  nonce: nonce.slice(0, 16),  // truncated for log safety
  ip: request.headers.get('CF-Connecting-IP'),
});

// Stale sequence number
this.logger.warn('[security] Heartbeat rejected: stale sequence number', {
  action: 'heartbeat_sequence_replay',
  serverId,
  received: sequenceNumber,
  expected: server.lastSequenceNumber + 1,
  ip: request.headers.get('CF-Connecting-IP'),
});
```

These logs can be ingested into a SIEM system or monitored via Cloudflare Workers analytics.

---

## Additional Notes

1. **UUID vs Custom Nonce**: Using `crypto.randomUUID()` provides 122 bits of entropy (version 4 UUID). This is sufficient for the 5-minute replay window. For additional security, could use `crypto.getRandomValues(new Uint8Array(16))` and base64-encode.

2. **Sequence Number Reset**: When a VPS server restarts, the sequence counter resets to 0. The server-side will accept this as the new baseline. If an attacker replays an old high-sequence heartbeat after restart, it will set the baseline high, but subsequent legitimate heartbeats will increment from there.

3. **Clock Skew Tolerance**: The 30-second future tolerance accommodates reasonable clock drift. If stricter sync is needed, consider reducing to 10-15 seconds and requiring NTP sync on VPS servers.

4. **Nonce Storage Growth**: With default 1-minute heartbeat interval and 5-minute expiry, worst-case is 5 nonces per server. For 1000 servers (MAX_SERVER_ENTRIES), this is 5000 nonce entries. Each entry is ~100 bytes (key + timestamp), totaling ~500KB. This is well within Cloudflare Durable Object limits (128MB storage).

5. **Performance Impact**:
   - Each heartbeat adds 2 storage reads (nonce + server) and 2 writes (nonce + server)
   - Alarm cleanup adds 1 list operation per 5 minutes
   - Impact is negligible for expected load (<1000 servers)

6. **Alternative: HMAC-based Replay Protection**: Instead of storing nonces, could use HMAC with a sliding time window. However, this requires synchronized clocks and does not provide the same guarantee as nonce storage. Current approach is more robust.

---

**Plan Version**: 1.0
**Author**: Claude Sonnet 4.5
**Date**: 2026-03-03
**Related Story**: story-005-heartbeat-replay-protection.md
