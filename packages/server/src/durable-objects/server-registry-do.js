/**
 * ServerRegistry Durable Object
 *
 * Simple registry for VPS servers to discover each other.
 * VPS servers register here on startup and query for peers.
 * Includes anomaly detection to flag misbehaving servers.
 *
 * This is the ONLY functionality of the CF Workers server.
 */

import { getCorsHeaders } from '../cors.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';
import { parseJsonBody, BodyTooLargeError } from '../utils/request-validation.js';
import { createLogger } from '../logger.js';
import { TransparencyLog } from '../utils/transparency-log.js';
import { verifySelfSignedRegistration, verifyAdminSignatures } from '../crypto/registration-auth.js';

/** Maximum number of server entries allowed in the registry */
const MAX_SERVER_ENTRIES = 1000;

/** Number of heartbeat snapshots to retain per server for anomaly analysis */
const ANOMALY_HISTORY_SIZE = 30;

/** Anomaly score threshold to flag a server */
const ANOMALY_FLAG_THRESHOLD = 5;

/** Anomaly score threshold to quarantine (hide from public listing) */
const ANOMALY_QUARANTINE_THRESHOLD = 10;

/** Maximum age for heartbeat/registration timestamps (2 minutes in the past) */
const HEARTBEAT_MAX_AGE_MS = 2 * 60 * 1000;

/** Maximum future offset for timestamps (30 seconds ahead of server clock) */
const HEARTBEAT_MAX_FUTURE_MS = 30 * 1000;

/** How long to keep nonces in storage before pruning (5 minutes) */
const NONCE_EXPIRY_MS = 5 * 60 * 1000;

/** Minimum nonce length (UUIDs are 36 chars, accept >= 16 for flexibility) */
const MIN_NONCE_LENGTH = 16;

/**
 * Anomaly detection for federation server metrics.
 *
 * Detects:
 * - metric_spike: connections jump >3x in one heartbeat
 * - metric_drop: connections drop >80% in one heartbeat
 * - metric_inconsistency: connections != relay + signaling
 * - ghost_server: heartbeating but always 0 connections (>10 heartbeats)
 * - fleet_outlier: metrics >3 standard deviations from fleet mean
 */
const AnomalyDetector = {
  /**
   * Analyze a server's latest metrics against its history and the fleet.
   * Returns an array of detected anomalies.
   *
   * @param {object} current - Current metrics snapshot { connections, relayConnections, signalingConnections, activeCodes }
   * @param {object[]} history - Array of previous snapshots for this server
   * @param {object[]} fleetServers - All active server entries for fleet-wide comparison
   * @returns {{ type: string, severity: 'low'|'medium'|'high', score: number, detail: string }[]}
   */
  analyze(current, history, fleetServers) {
    const anomalies = [];

    // --- Per-server anomalies (require history) ---
    if (history.length >= 2) {
      const prev = history[history.length - 1];

      // Metric spike: connections jump >3x
      if (prev.connections > 0 && current.connections > prev.connections * 3) {
        anomalies.push({
          type: 'metric_spike',
          severity: 'medium',
          score: 3,
          detail: `Connections spiked from ${prev.connections} to ${current.connections}`,
        });
      }

      // Metric drop: connections drop >80%
      if (prev.connections >= 5 && current.connections < prev.connections * 0.2) {
        anomalies.push({
          type: 'metric_drop',
          severity: 'medium',
          score: 3,
          detail: `Connections dropped from ${prev.connections} to ${current.connections}`,
        });
      }
    }

    // Metric inconsistency: connections should equal relay + signaling
    const expectedTotal = current.relayConnections + current.signalingConnections;
    if (current.connections > 0 && expectedTotal > 0 && Math.abs(current.connections - expectedTotal) > 1) {
      anomalies.push({
        type: 'metric_inconsistency',
        severity: 'low',
        score: 2,
        detail: `Reported connections=${current.connections} but relay+signaling=${expectedTotal}`,
      });
    }

    // Ghost server: heartbeating but always 0 connections for extended period
    if (history.length >= 10) {
      const recentZero = history.slice(-10).every(h => h.connections === 0) && current.connections === 0;
      if (recentZero) {
        anomalies.push({
          type: 'ghost_server',
          severity: 'low',
          score: 1,
          detail: `Server has reported 0 connections for ${history.length + 1} consecutive heartbeats`,
        });
      }
    }

    // --- Fleet-wide anomalies (require multiple servers) ---
    if (fleetServers.length >= 3) {
      const connValues = fleetServers.map(s => s.connections);
      const mean = connValues.reduce((a, b) => a + b, 0) / connValues.length;
      const variance = connValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / connValues.length;
      const stddev = Math.sqrt(variance);

      // Only flag if there's meaningful variation
      if (stddev > 0 && Math.abs(current.connections - mean) > stddev * 3) {
        anomalies.push({
          type: 'fleet_outlier',
          severity: 'high',
          score: 4,
          detail: `Connections ${current.connections} is >3σ from fleet mean ${Math.round(mean)} (σ=${Math.round(stddev)})`,
        });
      }
    }

    return anomalies;
  },

  /**
   * Calculate total anomaly score from a list of anomalies.
   * @param {{ score: number }[]} anomalies
   * @returns {number}
   */
  totalScore(anomalies) {
    return anomalies.reduce((sum, a) => sum + a.score, 0);
  },
};

/** Maximum trusted build keys allowed */
const MAX_TRUSTED_BUILD_KEYS = 50;

/**
 * Compute a SHA-256 hash of a key set for audit logging.
 * Keys are sorted before hashing to ensure deterministic output.
 *
 * Note: When called with an empty array (e.g., when keys are first set
 * and no previous keys exist), this produces the SHA-256 hash of the
 * JSON string "[]", which is a valid sentinel value for the initial state.
 *
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

/**
 * Build signature verification for federation server binaries.
 *
 * Verifies Ed25519 signatures on build hashes to ensure servers run
 * authentic, untampered builds from trusted operators.
 *
 * Trusted keys are managed by CI via POST /servers/trusted-keys and
 * persisted in DO storage. Falls back to TRUSTED_BUILD_KEYS env var.
 */
const BuildVerifier = {
  /**
   * Derive an AES-256-GCM key from CI_UPLOAD_SECRET via HKDF.
   * Used to encrypt trusted keys at rest in DO storage.
   * @param {string} secret - The CI_UPLOAD_SECRET value
   * @returns {Promise<CryptoKey>}
   */
  async deriveStorageKey(secret) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      'HKDF',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('zajel-trusted-keys-v1'),
        info: new Uint8Array(0),
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  /**
   * Encrypt a keys payload before storing in DO storage.
   * @param {{ keys: string[], updatedAt: number }} data - Plaintext key data
   * @param {string} secret - CI_UPLOAD_SECRET for key derivation
   * @returns {Promise<{ encrypted: true, iv: string, data: string }>}
   */
  async encryptKeys(data, secret) {
    const key = await this.deriveStorageKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
    );
    return {
      encrypted: true,
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...ciphertext)),
    };
  },

  /**
   * Decrypt a keys payload read from DO storage.
   * @param {{ encrypted: true, iv: string, data: string }} stored - Encrypted envelope
   * @param {string} secret - CI_UPLOAD_SECRET for key derivation
   * @returns {Promise<{ keys: string[], updatedAt: number }>}
   */
  async decryptKeys(stored, secret) {
    const key = await this.deriveStorageKey(secret);
    const iv = Uint8Array.from(atob(stored.iv), c => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(stored.data), c => c.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  },

  /**
   * Load trusted keys from DO storage, falling back to env var.
   * Handles both encrypted (new) and plaintext (legacy) storage formats.
   * @param {object} storage - Durable Object storage
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

  /**
   * Verify an Ed25519 build signature using Web Crypto API.
   * @param {string} buildHash - The SHA-256 hash that was signed (hex string)
   * @param {string} signatureBase64 - Base64-encoded Ed25519 signature
   * @param {string} publicKeyBase64 - Base64-encoded Ed25519 public key
   * @returns {Promise<boolean>}
   */
  async verifySignature(buildHash, signatureBase64, publicKeyBase64) {
    try {
      // Decode the public key
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

      // Decode the signature
      const sigBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
      if (sigBytes.length !== 64) return false;

      // The signed message is the build hash as UTF-8 bytes
      const data = new TextEncoder().encode(buildHash);

      return await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, data);
    } catch {
      return false;
    }
  },

  /**
   * Check if a public key is in the trusted set.
   * @param {string} publicKeyBase64 - Base64-encoded public key
   * @param {string[]} trustedKeys - Array of trusted base64 public keys
   * @returns {boolean}
   */
  isTrustedKey(publicKeyBase64, trustedKeys) {
    return trustedKeys.includes(publicKeyBase64);
  },
};

/**
 * Validate an ID string for use in storage keys.
 * Allows alphanumeric characters, dots, hyphens, underscores, colons,
 * plus, forward slash, and equals (for base64-encoded keys in serverIds).
 * @param {string} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[\w:.+/=-]+$/.test(id);
}

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

        // Check for migration from global shard (one-time)
        await this.migrateFromGlobalIfNeeded();
      });
    }
  }

  /**
   * Periodic alarm for cleaning up stale server entries and their anomaly data.
   */
  async alarm() {
    const now = Date.now();
    const deleteKeys = [];

    // Clean up stale server entries
    const entries = await this.state.storage.list({ prefix: 'server:' });
    for (const [key, server] of entries) {
      if (now - server.lastSeen >= this.serverTTL) {
        deleteKeys.push(key);
        // Also clean up anomaly history, score, and heartbeat rate limit for this server
        deleteKeys.push(`anomaly-history:${server.serverId}`);
        deleteKeys.push(`anomaly-score:${server.serverId}`);
        deleteKeys.push(`heartbeat-rl:${server.serverId}`);
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
    }
    // Reschedule next cleanup
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  /**
   * Migration helper: Check if this is the legacy 'global' shard.
   * If so, mark data for backward-compatible reads via 'region:default'.
   * This is a one-time migration executed on first access after sharding deployment.
   */
  async migrateFromGlobalIfNeeded() {
    const migrationMarker = await this.state.storage.get('_migrated_to_shards');
    if (migrationMarker) {
      return;
    }

    const hasData = await this.state.storage.list({ prefix: 'server:', limit: 1 });
    if (hasData.size === 0) {
      return;
    }

    await this.state.storage.put('_legacy_global_shard', true);
  }

  /**
   * Verify server authentication using the SERVER_REGISTRY_SECRET.
   * Uses constant-time comparison to prevent timing attacks.
   *
   * @param {Request} request - The incoming request
   * @returns {Promise<boolean>} Whether the request is authenticated
   */
  async verifyServerAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.SERVER_REGISTRY_SECRET) return false;
    if (!authHeader) return false;
    return await timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
  }

  /**
   * Require server authentication for protected endpoints.
   * Fail-closed: returns 503 when SERVER_REGISTRY_SECRET is not configured,
   * 401 when credentials are missing or invalid, null when auth passes.
   *
   * @param {Request} request - The incoming request
   * @param {object} corsHeaders - CORS headers to include in error responses
   * @returns {Promise<Response|null>} Error response if auth fails, null if auth passes
   */
  async requireServerAuth(request, corsHeaders) {
    if (!this.env.SERVER_REGISTRY_SECRET) {
      this.logger.warn('[audit] Protected endpoint accessed without SERVER_REGISTRY_SECRET configured', {
        action: 'auth_unconfigured',
        method: request.method,
        path: new URL(request.url).pathname,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Server authentication not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
    if (!(await this.verifyServerAuth(request))) {
      this.logger.warn('[audit] Unauthorized server registry access attempt', {
        action: 'auth_failed',
        method: request.method,
        path: new URL(request.url).pathname,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
    return null;
  }

  /**
   * Verify CI authentication using CI_UPLOAD_SECRET.
   * Same pattern as the attestation registry.
   */
  async verifyCIAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.CI_UPLOAD_SECRET) return false;
    if (!authHeader) return false;
    return await timingSafeEqual(authHeader, `Bearer ${this.env.CI_UPLOAD_SECRET}`);
  }

  async fetch(request) {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request, this.env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Lightweight server lookup for shard routing (used by findServerRegion)
      if (url.pathname === '/servers/lookup' && request.method === 'GET') {
        const serverId = url.searchParams.get('serverId');
        if (!serverId) {
          return new Response(JSON.stringify({ found: false }), { status: 200 });
        }
        const server = await this.state.storage.get(`server:${serverId}`);
        return new Response(JSON.stringify({ found: !!server }), { status: 200 });
      }

      // POST /servers - Register a server (requires auth)
      if (request.method === 'POST' && url.pathname === '/servers') {
        const authError = await this.requireServerAuth(request, corsHeaders);
        if (authError) return authError;
        return await this.registerServer(request, corsHeaders);
      }

      // GET /servers - List all servers (public)
      if (request.method === 'GET' && url.pathname === '/servers') {
        return await this.listServers(corsHeaders);
      }

      // DELETE /servers/:serverId - Unregister a server (requires auth)
      if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
        const authError = await this.requireServerAuth(request, corsHeaders);
        if (authError) return authError;
        const pathParts = url.pathname.split('/').filter(Boolean);
        // Expect exactly ['servers', '<serverId>']
        if (pathParts.length !== 2 || pathParts[0] !== 'servers') {
          return new Response(
            JSON.stringify({ error: 'Invalid path format' }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        const serverId = decodeURIComponent(pathParts[1]);
        if (!serverId || !isValidId(serverId)) {
          return new Response(
            JSON.stringify({ error: 'Invalid server ID' }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        return await this.unregisterServer(serverId, request, corsHeaders);
      }

      // POST /servers/heartbeat - Update server timestamp (requires auth)
      if (request.method === 'POST' && url.pathname === '/servers/heartbeat') {
        const authError = await this.requireServerAuth(request, corsHeaders);
        if (authError) return authError;
        return await this.heartbeat(request, corsHeaders);
      }

      // POST /servers/:id/revoke - Emergency revocation (2-of-N operators)
      if (request.method === 'POST' && /^\/servers\/([^/]+)\/revoke$/.test(url.pathname)) {
        const match = url.pathname.match(/^\/servers\/([^/]+)\/revoke$/);
        const serverId = decodeURIComponent(match[1]);
        return await this.revokeServer(serverId, request, corsHeaders);
      }

      // GET /servers/anomalies - View anomaly scores for all servers (requires auth)
      if (request.method === 'GET' && url.pathname === '/servers/anomalies') {
        const authError = await this.requireServerAuth(request, corsHeaders);
        if (authError) return authError;
        return await this.listAnomalies(corsHeaders);
      }

      // POST /servers/trusted-keys - Update trusted build keys (CI_UPLOAD_SECRET)
      if (request.method === 'POST' && url.pathname === '/servers/trusted-keys') {
        return await this.setTrustedKeys(request, corsHeaders);
      }

      // GET /servers/trusted-keys - Read current trusted build keys (authenticated)
      if (request.method === 'GET' && url.pathname === '/servers/trusted-keys') {
        return await this.getTrustedKeys(request, corsHeaders);
      }

      // GET /servers/trusted-keys/audit-log - Read transparency log (authenticated)
      if (request.method === 'GET' && url.pathname === '/servers/trusted-keys/audit-log') {
        return await this.getKeyAuditLog(request, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return new Response(
          JSON.stringify({ error: 'Request body too large' }),
          { status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      this.logger.error('[server-registry] Unhandled error', error);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  }

  async registerServer(request, corsHeaders) {
    const body = await parseJsonBody(request, 4096);
    const { serverId, endpoint, publicKey, region, timestamp, nonce } = body;

    if (!serverId || !endpoint || !publicKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // --- Replay protection: grace period for legacy clients ---
    const graceMode = this.env.REPLAY_GRACE_MODE === 'true';
    const hasReplayFields = typeof timestamp === 'number' && typeof nonce === 'string';

    if (!hasReplayFields && graceMode) {
      this.logger.warn('[migration] Registration without replay protection (grace period)', {
        action: 'register_legacy',
        serverId,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      // Skip replay checks, continue with legacy flow
    } else {
      // --- Replay protection: Validate timestamp freshness ---
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        return new Response(
          JSON.stringify({ error: 'Missing or invalid timestamp' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const regNow = Date.now();
      const age = regNow - timestamp;
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
      await this.state.storage.put(nonceKey, { timestamp: regNow });
    }

    // Validate serverId format
    if (!isValidId(serverId)) {
      return new Response(
        JSON.stringify({ error: 'Invalid serverId format' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Validate endpoint URL
    let endpointUrl;
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid endpoint: must be a valid URL' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Require secure protocols (relaxed in dev mode for local testing)
    const isDev = this.env.DEV_MODE === 'true';
    if (!isDev && !['https:', 'wss:'].includes(endpointUrl.protocol)) {
      return new Response(
        JSON.stringify({ error: 'Invalid endpoint: must use HTTPS or WSS protocol' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Reject private/internal addresses (relaxed in dev mode for local testing)
    if (!isDev) {
    const hostname = endpointUrl.hostname;
    const privatePatterns = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '[::1]',
    ];
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^fc00:/i,
      /^fd[0-9a-f]{2}:/i,
    ];

    if (privatePatterns.includes(hostname) || privateRanges.some(r => r.test(hostname))) {
      return new Response(
        JSON.stringify({ error: 'Invalid endpoint: must not point to private or internal addresses' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
    }

    // Enforce maximum URL length
    if (endpoint.length > 2048) {
      return new Response(
        JSON.stringify({ error: 'Invalid endpoint: URL too long (max 2048 characters)' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Validate publicKey length
    if (publicKey.length > 1024) {
      return new Response(
        JSON.stringify({ error: 'Invalid publicKey: too long' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Validate and sanitize region
    const validRegion = typeof region === 'string' && region.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(region)
      ? region
      : 'unknown';

    // Enforce maximum server entry count
    const existing = await this.state.storage.list({ prefix: 'server:' });
    if (existing.size >= MAX_SERVER_ENTRIES && !existing.has(`server:${serverId}`)) {
      return new Response(
        JSON.stringify({ error: 'Server registry full' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const connections = typeof body.connections === 'number' && Number.isFinite(body.connections)
      ? Math.max(0, Math.floor(body.connections))
      : 0;
    const relayConnections = typeof body.relayConnections === 'number' && Number.isFinite(body.relayConnections)
      ? Math.max(0, Math.floor(body.relayConnections))
      : 0;
    const signalingConnections = typeof body.signalingConnections === 'number' && Number.isFinite(body.signalingConnections)
      ? Math.max(0, Math.floor(body.signalingConnections))
      : 0;
    const activeCodes = typeof body.activeCodes === 'number' && Number.isFinite(body.activeCodes)
      ? Math.max(0, Math.floor(body.activeCodes))
      : 0;

    // --- Build signature verification ---
    let buildVerified = false;
    const buildHash = typeof body.buildHash === 'string' ? body.buildHash : null;
    const buildSignature = typeof body.buildSignature === 'string' ? body.buildSignature : null;
    const buildSigningKey = typeof body.buildSigningKey === 'string' ? body.buildSigningKey : null;
    const buildVersion = typeof body.buildVersion === 'string' ? body.buildVersion : null;

    if (buildHash && buildSignature && buildSigningKey) {
      // Verify the Ed25519 signature over the build hash
      const sigValid = await BuildVerifier.verifySignature(buildHash, buildSignature, buildSigningKey);

      // Check if the signing key is trusted (DO storage first, env var fallback)
      const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
      const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);

      buildVerified = sigValid && keyTrusted;

      // Audit log when no trusted keys are configured
      if (trustedKeys.length === 0) {
        this.logger.warn('[audit] Build verification skipped: no trusted keys configured', {
          action: 'build_verify_no_keys',
          serverId,
          buildHash: buildHash.slice(0, 12),
          signatureValid: sigValid,
        });
      }

      this.logger.info('[audit] Build signature checked', {
        action: 'build_verify',
        serverId,
        buildHash: buildHash.slice(0, 12),
        signatureValid: sigValid,
        keyTrusted,
        buildVerified,
        buildVersion,
      });

      // Log build verification outcome to transparency log
      try {
        const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
        await auditLog.append({
          action: 'build_verification',
          serverId: serverId || 'unknown',
          buildVerified,
          signatureValid: sigValid,
          keyTrusted,
          buildHash: buildHash || null,
          trustedKeyCount: trustedKeys.length,
          ip: request.headers.get('CF-Connecting-IP'),
        });
      } catch (err) {
        this.logger.error('[audit] Failed to write build verification to transparency log', err);
      }
    }

    // --- Cryptographic registration authentication ---
    // In addition to SERVER_REGISTRY_SECRET (checked in fetch()),
    // optionally verify self-signatures or M-of-N operator signatures.
    const selfSignature = body.signature; // Server signs its own registration
    const adminSignatures = body.adminSignatures; // Or M-of-N operators sign

    let authenticated = true; // fetch()-level SERVER_REGISTRY_SECRET auth already passed

    // Mode 1: Self-signed registration (server proves key ownership)
    if (selfSignature) {
      const registrationPayload = {
        serverId,
        endpoint,
        publicKey,
        region: validRegion,
        timestamp: body.timestamp,
      };
      const selfVerified = await verifySelfSignedRegistration(registrationPayload, selfSignature);
      if (selfVerified) {
        authenticated = true;
        this.logger.info('[audit] Self-signed server registration verified', {
          action: 'server_register_self',
          serverId,
          ip: request.headers.get('CF-Connecting-IP'),
        });
      }
    }

    // Mode 2: Administrative registration (M-of-N operators sign)
    if (adminSignatures && Array.isArray(adminSignatures)) {
      const operatorKeys = this.env.OPERATOR_PUBLIC_KEYS
        ? this.env.OPERATOR_PUBLIC_KEYS.split(',').map(k => k.trim()).filter(Boolean)
        : [];
      const threshold = parseInt(this.env.ADMIN_THRESHOLD || '2', 10);

      if (operatorKeys.length > 0) {
        const registrationPayload = {
          serverId,
          endpoint,
          publicKey,
          region: validRegion,
          timestamp: body.timestamp,
        };

        const adminVerified = await verifyAdminSignatures(
          registrationPayload,
          adminSignatures,
          operatorKeys,
          threshold
        );

        if (adminVerified) {
          authenticated = true;
          this.logger.info('[audit] Admin-signed server registration verified', {
            action: 'server_register_admin',
            serverId,
            signatureCount: adminSignatures.length,
            threshold,
            ip: request.headers.get('CF-Connecting-IP'),
          });
        }
      }
    }

    // If explicit registration auth is required, reject unless cryptographically verified
    if (this.env.REQUIRE_REGISTRATION_AUTH === 'true') {
      const hasCryptoAuth = (selfSignature && authenticated) ||
        (adminSignatures && Array.isArray(adminSignatures) && authenticated);

      // When REQUIRE_REGISTRATION_AUTH is enabled, at least one crypto signature must be present
      if (!selfSignature && !(adminSignatures && Array.isArray(adminSignatures))) {
        this.logger.warn('[audit] Rejected registration: no cryptographic signature provided', {
          action: 'server_register_rejected',
          serverId,
          ip: request.headers.get('CF-Connecting-IP'),
        });
        return new Response(
          JSON.stringify({ error: 'Registration signature required (self-signed or admin-signed)' }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      if (!hasCryptoAuth) {
        this.logger.warn('[audit] Rejected registration: invalid cryptographic signature', {
          action: 'server_register_rejected',
          serverId,
          ip: request.headers.get('CF-Connecting-IP'),
        });
        return new Response(
          JSON.stringify({ error: 'Registration signature verification failed' }),
          { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }

    const serverEntry = {
      serverId,
      endpoint,
      publicKey,
      region: validRegion,
      connections,
      relayConnections,
      signalingConnections,
      activeCodes,
      buildVerified,
      buildHash,
      buildVersion,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      lastSequenceNumber: undefined, // Reset on re-registration (VPS restart)
      authenticated,
    };

    await this.state.storage.put(`server:${serverId}`, serverEntry);

    this.logger.info('[audit] Server registered', {
      action: 'server_register',
      serverId,
      region: validRegion,
      buildVerified,
      authenticated,
      ip: request.headers.get('CF-Connecting-IP'),
    });

    // Log to audit trail
    await this.logAuditEvent({
      action: 'server_register',
      serverId,
      metadata: { authenticated, ip: request.headers.get('CF-Connecting-IP') },
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

  async listServers(corsHeaders) {
    const now = Date.now();
    const servers = [];
    const staleKeys = [];

    // Get all server entries
    const entries = await this.state.storage.list({ prefix: 'server:' });

    for (const [key, server] of entries) {
      // Filter out stale servers (not seen in TTL period)
      if (now - server.lastSeen < this.serverTTL) {
        // Exclude quarantined servers from public listing
        const scoreData = await this.state.storage.get(`anomaly-score:${server.serverId}`);
        if (scoreData && scoreData.quarantined) {
          continue;
        }
        servers.push(server);
      } else {
        staleKeys.push(key);
      }
    }

    // Batch delete all stale entries in a single operation
    if (staleKeys.length > 0) {
      await this.state.storage.delete(staleKeys);
    }

    return new Response(
      JSON.stringify({ servers }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  async unregisterServer(serverId, request, corsHeaders) {
    // Look up the server to verify it exists
    const server = await this.state.storage.get(`server:${serverId}`);
    if (!server) {
      // Return success for idempotent DELETE even if server doesn't exist
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Defense-in-depth: This method should only be reached if auth passed in fetch(),
    // but as an extra safety check, deny if SERVER_REGISTRY_SECRET is not configured.
    // This is intentionally dead code under normal execution — it guards against future
    // refactors that might call unregisterServer() without the fetch-level auth gate.
    if (!this.env.SERVER_REGISTRY_SECRET) {
      this.logger.warn('[audit] unregisterServer called without SERVER_REGISTRY_SECRET configured', {
        action: 'unregister_no_auth',
        serverId,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Server authentication not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    await this.state.storage.delete(`server:${serverId}`);

    this.logger.info('[audit] Server unregistered', {
      action: 'server_unregister',
      serverId,
      ip: request.headers.get('CF-Connecting-IP'),
    });

    // Log to audit trail
    await this.logAuditEvent({
      action: 'server_unregister',
      serverId,
      metadata: { ip: request.headers.get('CF-Connecting-IP') },
    });

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

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

    // --- Heartbeat signature verification ---
    // When REQUIRE_HEARTBEAT_AUTH is enabled, the heartbeat must be signed
    // by the server's registered publicKey to prevent keep-alive attacks
    // (where an attacker who knows a valid serverId can keep a stale or
    // compromised server entry alive indefinitely).
    if (this.env.REQUIRE_HEARTBEAT_AUTH === 'true') {
      if (!body.signature) {
        this.logger.warn('[security] Heartbeat rejected: signature required', {
          action: 'heartbeat_auth_missing',
          serverId,
          ip: request.headers.get('CF-Connecting-IP'),
        });
        return new Response(
          JSON.stringify({ error: 'Heartbeat signature required' }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const server = await this.state.storage.get(`server:${serverId}`);
      if (server) {
        const heartbeatPayload = {
          serverId,
          timestamp,
          publicKey: server.publicKey,
        };
        if (typeof nonce === 'string') {
          heartbeatPayload.nonce = nonce;
        }
        if (typeof sequenceNumber === 'number') {
          heartbeatPayload.sequenceNumber = sequenceNumber;
        }

        const verified = await verifySelfSignedRegistration(heartbeatPayload, body.signature);
        if (!verified) {
          this.logger.warn('[security] Heartbeat rejected: invalid signature', {
            action: 'heartbeat_auth_failed',
            serverId,
            ip: request.headers.get('CF-Connecting-IP'),
          });
          return new Response(
            JSON.stringify({ error: 'Heartbeat signature verification failed' }),
            { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
      }
    }

    // --- Replay protection: grace period for legacy clients ---
    const graceMode = this.env.REPLAY_GRACE_MODE === 'true';
    const hasReplayFields = typeof timestamp === 'number' && typeof nonce === 'string';

    let hbNow;
    if (!hasReplayFields && graceMode) {
      this.logger.warn('[migration] Heartbeat without replay protection (grace period)', {
        action: 'heartbeat_legacy',
        serverId,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      hbNow = Date.now();
      // Skip replay checks, continue with legacy flow
    } else {
      // --- Replay protection: Validate timestamp freshness ---
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        return new Response(
          JSON.stringify({ error: 'Missing or invalid timestamp' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      hbNow = Date.now();
      const age = hbNow - timestamp;
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

      // Check nonce before server existence (early rejection for known replays)
      const nonceKey = `nonce:${serverId}:${nonce}`;
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
    }

    const server = await this.state.storage.get(`server:${serverId}`);

    if (!server) {
      return new Response(
        JSON.stringify({ error: 'Server not registered' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Per-serverId heartbeat rate limiting: max 2 per 60s, min 30s between requests
    // Uses DO storage to persist across isolate eviction
    const hbRateLimitKey = `heartbeat-rl:${serverId}`;
    const hbEntry = await this.state.storage.get(hbRateLimitKey);

    if (hbEntry) {
      const elapsed = hbNow - hbEntry.lastRequestAt;

      // Enforce minimum 30s interval between heartbeats
      if (elapsed < 30000) {
        const retryAfter = Math.ceil((30000 - elapsed) / 1000);
        return new Response(
          JSON.stringify({ error: 'Heartbeat rate limit exceeded (min 30s interval)' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': retryAfter.toString(),
              ...corsHeaders,
            },
          }
        );
      }

      // Enforce max 2 per 60s sliding window
      if (hbNow - hbEntry.windowStart < 60000 && hbEntry.count >= 2) {
        const retryAfter = Math.ceil((60000 - (hbNow - hbEntry.windowStart)) / 1000);
        return new Response(
          JSON.stringify({ error: 'Heartbeat rate limit exceeded' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': retryAfter.toString(),
              ...corsHeaders,
            },
          }
        );
      }

      // Update counters
      if (hbNow - hbEntry.windowStart >= 60000) {
        // Window expired, start new window
        await this.state.storage.put(hbRateLimitKey, {
          count: 1,
          windowStart: hbNow,
          lastRequestAt: hbNow,
        });
      } else {
        // Increment within window
        await this.state.storage.put(hbRateLimitKey, {
          count: hbEntry.count + 1,
          windowStart: hbEntry.windowStart,
          lastRequestAt: hbNow,
        });
      }
    } else {
      // First heartbeat ever for this serverId
      await this.state.storage.put(hbRateLimitKey, {
        count: 1,
        windowStart: hbNow,
        lastRequestAt: hbNow,
      });
    }

    // Store nonce AFTER server existence check (prevents storage pollution from non-existent servers)
    if (hasReplayFields && !graceMode || hasReplayFields) {
      const nonceKey = `nonce:${serverId}:${nonce}`;
      await this.state.storage.put(nonceKey, { timestamp: hbNow });
    }

    // --- Replay protection: Validate sequence number (monotonic increase) ---
    if (hasReplayFields && typeof sequenceNumber === 'number' && Number.isFinite(sequenceNumber)) {
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

    server.lastSeen = hbNow;
    if (typeof body.connections === 'number' && Number.isFinite(body.connections)) {
      server.connections = Math.max(0, Math.floor(body.connections));
    }
    if (typeof body.relayConnections === 'number' && Number.isFinite(body.relayConnections)) {
      server.relayConnections = Math.max(0, Math.floor(body.relayConnections));
    }
    if (typeof body.signalingConnections === 'number' && Number.isFinite(body.signalingConnections)) {
      server.signalingConnections = Math.max(0, Math.floor(body.signalingConnections));
    }
    if (typeof body.activeCodes === 'number' && Number.isFinite(body.activeCodes)) {
      server.activeCodes = Math.max(0, Math.floor(body.activeCodes));
    }

    // Re-verify build signature if provided in heartbeat
    if (typeof body.buildHash === 'string' && typeof body.buildSignature === 'string' && typeof body.buildSigningKey === 'string') {
      const sigValid = await BuildVerifier.verifySignature(body.buildHash, body.buildSignature, body.buildSigningKey);
      const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
      const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
      server.buildVerified = sigValid && keyTrusted;
      server.buildHash = body.buildHash;

      // Audit log when no trusted keys are configured
      if (trustedKeys.length === 0) {
        this.logger.warn('[audit] Build verification skipped in heartbeat: no trusted keys configured', {
          action: 'heartbeat_build_verify_no_keys',
          serverId,
          buildHash: body.buildHash.slice(0, 12),
          signatureValid: sigValid,
        });
      }

      // Detect build hash change (possible hot-swap attack)
      const prevHash = server.buildHash;
      if (prevHash && prevHash !== body.buildHash) {
        this.logger.info('[anomaly] Build hash changed between heartbeats', {
          action: 'build_hash_changed',
          serverId,
          previousHash: prevHash.slice(0, 12),
          newHash: body.buildHash.slice(0, 12),
        });
      }
    }

    await this.state.storage.put(`server:${serverId}`, server);

    // --- Anomaly detection ---
    const currentMetrics = {
      connections: server.connections,
      relayConnections: server.relayConnections,
      signalingConnections: server.signalingConnections,
      activeCodes: server.activeCodes,
      timestamp: server.lastSeen,
    };

    // Load history for this server
    const historyKey = `anomaly-history:${serverId}`;
    const history = (await this.state.storage.get(historyKey)) || [];

    // NOTE: Fleet-wide anomaly detection is removed from heartbeat hot path.
    // With regional sharding, cross-region fleet analysis requires aggregation.
    // Keep regional peers for the heartbeat response and for per-shard anomaly detection.

    // Gather regional fleet data (peers within this shard only)
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const now = Date.now();
    const peers = [];

    for (const [key, peer] of entries) {
      if (now - peer.lastSeen < this.serverTTL) {
        if (peer.serverId !== serverId) {
          peers.push(peer);
        }
      }
    }

    // Run anomaly detection with regional peers (same shard) for fleet comparison.
    // Cross-region comparison was removed by sharding, but intra-shard detection is preserved.
    const anomalies = AnomalyDetector.analyze(currentMetrics, history, peers);
    const score = AnomalyDetector.totalScore(anomalies);

    // Update rolling history
    history.push(currentMetrics);
    if (history.length > ANOMALY_HISTORY_SIZE) {
      history.splice(0, history.length - ANOMALY_HISTORY_SIZE);
    }
    await this.state.storage.put(historyKey, history);

    // Persist anomaly score and recent anomalies
    const scoreKey = `anomaly-score:${serverId}`;
    const existing = (await this.state.storage.get(scoreKey)) || { score: 0, anomalies: [], flagged: false, quarantined: false };

    // Exponential decay: reduce old score by 20% each heartbeat, then add new
    const decayedScore = Math.max(0, existing.score * 0.8);
    const newScore = decayedScore + score;
    const flagged = newScore >= ANOMALY_FLAG_THRESHOLD;
    const quarantined = newScore >= ANOMALY_QUARANTINE_THRESHOLD;

    await this.state.storage.put(scoreKey, {
      score: newScore,
      anomalies: anomalies.length > 0 ? anomalies : existing.anomalies,
      flagged,
      quarantined,
      lastChecked: now,
    });

    if (anomalies.length > 0) {
      this.logger.info('[anomaly] Anomalies detected', {
        action: 'anomaly_detected',
        serverId,
        score: newScore,
        flagged,
        quarantined,
        anomalies: anomalies.map(a => a.type),
      });
    }

    return new Response(
      JSON.stringify({ success: true, peers }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  /**
   * List anomaly scores and flags for all registered servers.
   * Admin-only endpoint.
   */
  async listAnomalies(corsHeaders) {
    const now = Date.now();
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const results = [];

    for (const [key, server] of entries) {
      if (now - server.lastSeen >= this.serverTTL) continue;

      const scoreData = (await this.state.storage.get(`anomaly-score:${server.serverId}`)) || {
        score: 0, anomalies: [], flagged: false, quarantined: false,
      };

      results.push({
        serverId: server.serverId,
        endpoint: server.endpoint,
        region: server.region,
        score: Math.round(scoreData.score * 100) / 100,
        flagged: scoreData.flagged,
        quarantined: scoreData.quarantined,
        anomalies: scoreData.anomalies,
        lastChecked: scoreData.lastChecked || null,
        buildVerified: server.buildVerified || false,
        buildHash: server.buildHash || null,
        buildVersion: server.buildVersion || null,
      });
    }

    // Sort by score descending (most suspicious first)
    results.sort((a, b) => b.score - a.score);

    return new Response(
      JSON.stringify({ servers: results }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  /**
   * POST /servers/trusted-keys
   *
   * Update the set of trusted build signing keys. Called by CI after a
   * successful build to register the public key used for signing.
   * Authenticated with CI_UPLOAD_SECRET (same as POST /attest/versions).
   *
   * Body: { keys: string[], addKeys?: string[], removeKeys?: string[] }
   *   - keys: replace the entire set
   *   - addKeys: append to the existing set
   *   - removeKeys: remove from the existing set
   * Only one mode per request. If `keys` is provided, it replaces all.
   */
  async setTrustedKeys(request, corsHeaders) {
    if (!this.env.CI_UPLOAD_SECRET) {
      return new Response(
        JSON.stringify({ error: 'CI access not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (!(await this.verifyCIAuth(request))) {
      this.logger.warn('[audit] Unauthorized trusted-keys update attempt', {
        action: 'trusted_keys_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });

      // Log failed auth to transparency log
      try {
        const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
        await auditLog.append({
          action: 'trusted_keys_update_failed',
          reason: 'unauthorized',
          ip: request.headers.get('CF-Connecting-IP'),
          userAgent: request.headers.get('User-Agent'),
        });
      } catch (err) {
        this.logger.error('[audit] Failed to write transparency log', err);
      }

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
    try {
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
    } catch (err) {
      this.logger.error('[audit] Failed to write transparency log', err);
    }

    return new Response(
      JSON.stringify({ success: true, keys: finalKeys }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  /**
   * GET /servers/trusted-keys
   *
   * Returns the current set of trusted build signing public keys.
   * Requires CI_UPLOAD_SECRET authentication.
   */
  async getTrustedKeys(request, corsHeaders) {
    if (!this.env.CI_UPLOAD_SECRET) {
      return new Response(
        JSON.stringify({ error: 'Trusted key management not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (!(await this.verifyCIAuth(request))) {
      this.logger.warn('[audit] Unauthorized trusted-keys read attempt', {
        action: 'trusted_keys_read_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });

      // Log failed auth to transparency log
      try {
        const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
        await auditLog.append({
          action: 'trusted_keys_read_failed',
          reason: 'unauthorized',
          ip: request.headers.get('CF-Connecting-IP'),
          userAgent: request.headers.get('User-Agent'),
        });
      } catch (err) {
        this.logger.error('[audit] Failed to write transparency log', err);
      }

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
        } catch (err) {
          // Audit log: decryption failure (possible secret rotation or compromise)
          this.logger.error('[audit] Failed to decrypt trusted build keys', {
            action: 'trusted_keys_decrypt_failed',
            ip: request.headers.get('CF-Connecting-IP'),
            error: err?.message || 'unknown',
          });
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

    // Log successful read to transparency log
    try {
      const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
      await auditLog.append({
        action: 'trusted_keys_read',
        keyCount: keys.length,
        keySetHash: await computeKeySetHash(keys),
        ip: request.headers.get('CF-Connecting-IP'),
        userAgent: request.headers.get('User-Agent'),
      });
    } catch (err) {
      this.logger.error('[audit] Failed to write transparency log', err);
    }

    // Audit log: successful read
    this.logger.info('[audit] Trusted build keys read', {
      action: 'trusted_keys_read',
      keyCount: keys.length,
      updatedAt,
      ip: request.headers.get('CF-Connecting-IP'),
    });

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

    if (!(await this.verifyCIAuth(request))) {
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

  /**
   * Update TUF targets, snapshot, and timestamp metadata after registry changes.
   */
  async updateTufMetadata() {
    const { createTargetsMetadata, createSnapshotMetadata, createTimestampMetadata, signMetadata, importRoleKey } =
      await import('../crypto/tuf/roles.js');

    const now = Date.now();
    const servers = [];
    const allEntries = await this.state.storage.list({ prefix: 'server:' });
    for (const [, server] of allEntries) {
      if (now - server.lastSeen < this.serverTTL) {
        const scoreData = await this.state.storage.get(`anomaly-score:${server.serverId}`);
        if (scoreData && scoreData.quarantined) continue;
        servers.push(server);
      }
    }

    const tufId = this.env.TUF_METADATA.idFromName('global');
    const tufStub = this.env.TUF_METADATA.get(tufId);

    const currentTargetsResp = await tufStub.fetch(new Request('https://internal/tuf/targets.json'));
    const currentTargets = currentTargetsResp.ok ? await currentTargetsResp.json() : null;
    const targetsVersion = currentTargets ? currentTargets.signed.version + 1 : 1;

    const currentSnapshotResp = await tufStub.fetch(new Request('https://internal/tuf/snapshot.json'));
    const currentSnapshot = currentSnapshotResp.ok ? await currentSnapshotResp.json() : null;
    const snapshotVersion = currentSnapshot ? currentSnapshot.signed.version + 1 : 1;

    const currentTimestampResp = await tufStub.fetch(new Request('https://internal/tuf/timestamp.json'));
    const currentTimestamp = currentTimestampResp.ok ? await currentTimestampResp.json() : null;
    const timestampVersion = currentTimestamp ? currentTimestamp.signed.version + 1 : 1;

    const targetsUnsigned = await createTargetsMetadata(targetsVersion, 30, servers);
    const targetsKey = await importRoleKey(this.env.TARGETS_SIGNING_KEY, this.env.TARGETS_PUBLIC_KEY);
    const targetsMetadata = await signMetadata(targetsUnsigned, [targetsKey]);

    const tufSecret = this.env.TUF_UPDATE_SECRET || this.env.SERVER_REGISTRY_SECRET;
    const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tufSecret}` };

    const targetsResp = await tufStub.fetch(new Request('https://internal/tuf/targets.json', {
      method: 'PUT', headers: authHeaders, body: JSON.stringify(targetsMetadata),
    }));
    if (!targetsResp.ok) throw new Error(`Failed to update targets: ${await targetsResp.text()}`);

    const snapshotUnsigned = await createSnapshotMetadata(snapshotVersion, 7, targetsMetadata);
    const snapshotKey = await importRoleKey(this.env.SNAPSHOT_SIGNING_KEY, this.env.SNAPSHOT_PUBLIC_KEY);
    const snapshotMetadata = await signMetadata(snapshotUnsigned, [snapshotKey]);

    const snapshotResp = await tufStub.fetch(new Request('https://internal/tuf/snapshot.json', {
      method: 'PUT', headers: authHeaders, body: JSON.stringify(snapshotMetadata),
    }));
    if (!snapshotResp.ok) throw new Error(`Failed to update snapshot: ${await snapshotResp.text()}`);

    const timestampUnsigned = await createTimestampMetadata(timestampVersion, 24, snapshotMetadata);
    const timestampKey = await importRoleKey(this.env.TIMESTAMP_SIGNING_KEY, this.env.TIMESTAMP_PUBLIC_KEY);
    const timestampMetadata = await signMetadata(timestampUnsigned, [timestampKey]);

    const timestampResp = await tufStub.fetch(new Request('https://internal/tuf/timestamp.json', {
      method: 'PUT', headers: authHeaders, body: JSON.stringify(timestampMetadata),
    }));
    if (!timestampResp.ok) throw new Error(`Failed to update timestamp: ${await timestampResp.text()}`);

    this.logger.info('[tuf] Updated TUF metadata', {
      targetsVersion, snapshotVersion, timestampVersion, serverCount: servers.length,
    });
  }

  /**
   * Verify an Ed25519 signature over a registration payload.
   */
  async verifyRegistrationSignature(payload, signatureBase64, publicKeyBase64) {
    try {
      const keyBytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0));
      if (keyBytes.length !== 32) return false;

      const spkiPrefix = new Uint8Array([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
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

  /**
   * Emergency server revocation. Requires 2-of-N operator signatures
   * (lower threshold than normal admin operations for faster incident response).
   *
   * After revocation, normal M-of-N ceremony is required to re-register.
   */
  async revokeServer(serverId, request, corsHeaders) {
    const server = await this.state.storage.get(`server:${serverId}`);
    if (!server) {
      return new Response(
        JSON.stringify({ error: 'Server not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const body = await parseJsonBody(request, 4096);
    const { adminSignatures, reason } = body;

    if (!adminSignatures || !Array.isArray(adminSignatures) || adminSignatures.length < 2) {
      return new Response(
        JSON.stringify({ error: 'Emergency revocation requires at least 2 operator signatures' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (!body.timestamp || typeof body.timestamp !== 'number') {
      return new Response(
        JSON.stringify({ error: 'timestamp is required for revocation' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const operatorKeys = this.env.OPERATOR_PUBLIC_KEYS
      ? this.env.OPERATOR_PUBLIC_KEYS.split(',').map(k => k.trim())
      : [];

    if (operatorKeys.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Operator keys not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Emergency revocation uses a fixed threshold of 2 (lower than normal ADMIN_THRESHOLD)
    const revocationThreshold = Math.min(2, operatorKeys.length);

    const revocationPayload = {
      action: 'revoke',
      serverId,
      timestamp: body.timestamp,
    };

    const verified = await verifyAdminSignatures(
      revocationPayload,
      adminSignatures,
      operatorKeys,
      revocationThreshold
    );

    if (!verified) {
      this.logger.warn('[audit] Rejected emergency revocation - insufficient valid signatures', {
        action: 'server_revoke_rejected',
        serverId,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Insufficient valid operator signatures' }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Delete the server entry
    await this.state.storage.delete(`server:${serverId}`);

    // Log to audit trail
    await this.logAuditEvent({
      action: 'server_revoke',
      serverId,
      metadata: {
        reason: reason || 'emergency revocation',
        signatureCount: adminSignatures.length,
        ip: request.headers.get('CF-Connecting-IP'),
      },
    });

    this.logger.info('[audit] Emergency server revocation', {
      action: 'server_revoke',
      serverId,
      reason: reason || 'emergency revocation',
    });

    return new Response(
      JSON.stringify({ success: true, action: 'revoked', serverId }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  /**
   * Log an event to the audit log Durable Object.
   */
  async logAuditEvent(event) {
    if (!this.env.AUDIT_LOG) return; // Graceful degradation if not configured

    try {
      const id = this.env.AUDIT_LOG.idFromName('global');
      const stub = this.env.AUDIT_LOG.get(id);
      const headers = { 'Content-Type': 'application/json' };

      // Include internal auth token if configured
      if (this.env.AUDIT_LOG_INTERNAL_TOKEN) {
        headers['X-Internal-Token'] = this.env.AUDIT_LOG_INTERNAL_TOKEN;
      }

      await stub.fetch(new Request('https://audit-log/log', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: event.action,
          serverId: event.serverId || null,
          timestamp: Date.now(),
          metadata: event.metadata || {},
        }),
      }));
    } catch (error) {
      this.logger.error('[audit] Failed to log event', error);
      // Don't fail the operation if audit logging fails
    }
  }
}
