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

/** Maximum number of server entries allowed in the registry */
const MAX_SERVER_ENTRIES = 1000;

/** Number of heartbeat snapshots to retain per server for anomaly analysis */
const ANOMALY_HISTORY_SIZE = 30;

/** Anomaly score threshold to flag a server */
const ANOMALY_FLAG_THRESHOLD = 5;

/** Anomaly score threshold to quarantine (hide from public listing) */
const ANOMALY_QUARANTINE_THRESHOLD = 10;

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

/**
 * Build signature verification for federation server binaries.
 *
 * Verifies Ed25519 signatures on build hashes to ensure servers run
 * authentic, untampered builds from trusted operators.
 *
 * Trusted keys are configured via TRUSTED_BUILD_KEYS env var
 * (comma-separated base64-encoded Ed25519 public keys).
 */
const BuildVerifier = {
  /**
   * Parse the TRUSTED_BUILD_KEYS environment variable.
   * @param {string|undefined} envValue - Comma-separated base64 public keys
   * @returns {string[]} Array of base64-encoded public keys
   */
  parseTrustedKeys(envValue) {
    if (!envValue) return [];
    return envValue.split(',').map(k => k.trim()).filter(Boolean);
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
      });
    }
  }

  /**
   * Periodic alarm for cleaning up stale server entries and their anomaly data.
   */
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

  /**
   * Verify server authentication using the SERVER_REGISTRY_SECRET.
   * Uses constant-time comparison to prevent timing attacks.
   *
   * @param {Request} request - The incoming request
   * @returns {boolean} Whether the request is authenticated
   */
  verifyServerAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.SERVER_REGISTRY_SECRET) return false;
    if (!authHeader) return false;
    return timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
  }

  async fetch(request) {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request, this.env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // POST /servers - Register a server (requires auth)
      if (request.method === 'POST' && url.pathname === '/servers') {
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        return await this.registerServer(request, corsHeaders);
      }

      // GET /servers - List all servers (public)
      if (request.method === 'GET' && url.pathname === '/servers') {
        return await this.listServers(corsHeaders);
      }

      // DELETE /servers/:serverId - Unregister a server (requires auth)
      if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
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
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        return await this.heartbeat(request, corsHeaders);
      }

      // GET /servers/anomalies - View anomaly scores for all servers (requires auth)
      if (request.method === 'GET' && url.pathname === '/servers/anomalies') {
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        return await this.listAnomalies(corsHeaders);
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
    const { serverId, endpoint, publicKey, region } = body;

    if (!serverId || !endpoint || !publicKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
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

      // Check if the signing key is trusted (if TRUSTED_BUILD_KEYS is configured)
      const trustedKeys = BuildVerifier.parseTrustedKeys(this.env.TRUSTED_BUILD_KEYS);
      const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);

      buildVerified = sigValid && keyTrusted;

      this.logger.info('[audit] Build signature checked', {
        action: 'build_verify',
        serverId,
        buildHash: buildHash.slice(0, 12),
        signatureValid: sigValid,
        keyTrusted,
        buildVerified,
        buildVersion,
      });
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
    };

    await this.state.storage.put(`server:${serverId}`, serverEntry);

    this.logger.info('[audit] Server registered', {
      action: 'server_register',
      serverId,
      region: validRegion,
      buildVerified,
      ip: request.headers.get('CF-Connecting-IP'),
    });

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

    // When SERVER_REGISTRY_SECRET is configured, auth is verified in fetch().
    // When not configured, verify ownership via publicKey in Authorization header
    // if one is provided (defense in depth without breaking non-auth deployments).
    if (!this.env.SERVER_REGISTRY_SECRET) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const providedKey = authHeader.substring(7);
        if (providedKey !== server.publicKey) {
          return new Response(
            JSON.stringify({ error: 'Not authorized to delete this server' }),
            { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
      }
    }

    await this.state.storage.delete(`server:${serverId}`);

    this.logger.info('[audit] Server unregistered', {
      action: 'server_unregister',
      serverId,
    });

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

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
      const trustedKeys = BuildVerifier.parseTrustedKeys(this.env.TRUSTED_BUILD_KEYS);
      const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
      server.buildVerified = sigValid && keyTrusted;
      server.buildHash = body.buildHash;

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

    // Gather fleet data for cross-server analysis
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const now = Date.now();
    const fleetServers = [];
    const peers = [];

    for (const [key, peer] of entries) {
      if (now - peer.lastSeen < this.serverTTL) {
        fleetServers.push(peer);
        if (peer.serverId !== serverId) {
          peers.push(peer);
        }
      }
    }

    // Run anomaly detection (exclude self from fleet to avoid self-inflation of stats)
    const fleetWithoutSelf = fleetServers.filter(s => s.serverId !== serverId);
    const anomalies = AnomalyDetector.analyze(currentMetrics, history, fleetWithoutSelf);
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
}
