/**
 * ServerRegistry Durable Object
 *
 * Simple registry for VPS servers to discover each other.
 * VPS servers register here on startup and query for peers.
 *
 * This is the ONLY functionality of the CF Workers server.
 */

import { getCorsHeaders } from '../cors.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';
import { parseJsonBody, BodyTooLargeError } from '../utils/request-validation.js';
import { createLogger } from '../logger.js';

/** Maximum number of server entries allowed in the registry */
const MAX_SERVER_ENTRIES = 1000;

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
   * Periodic alarm for cleaning up stale server entries.
   */
  async alarm() {
    const now = Date.now();
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const deleteKeys = [];
    for (const [key, server] of entries) {
      if (now - server.lastSeen >= this.serverTTL) {
        deleteKeys.push(key);
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

    const serverEntry = {
      serverId,
      endpoint,
      publicKey,
      region: validRegion,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    };

    await this.state.storage.put(`server:${serverId}`, serverEntry);

    this.logger.info('[audit] Server registered', {
      action: 'server_register',
      serverId,
      region: validRegion,
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
    const body = await parseJsonBody(request, 1024);
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
    await this.state.storage.put(`server:${serverId}`, server);

    // Return current peer list with heartbeat response
    const peers = [];
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const now = Date.now();

    for (const [key, peer] of entries) {
      if (peer.serverId !== serverId && now - peer.lastSeen < this.serverTTL) {
        peers.push(peer);
      }
    }

    return new Response(
      JSON.stringify({ success: true, peers }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
