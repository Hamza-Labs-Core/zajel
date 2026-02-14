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

/** Maximum number of server entries allowed in the registry */
const MAX_SERVER_ENTRIES = 1000;

/**
 * Validate an ID string for use in storage keys.
 * Allows alphanumeric characters, dots, hyphens, underscores, and colons.
 * @param {string} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[\w:.-]+$/.test(id);
}

export class ServerRegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
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
      console.error('ServerRegistry error:', error.message, error.stack);
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
      region: region || 'unknown',
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    };

    await this.state.storage.put(`server:${serverId}`, serverEntry);

    return new Response(
      JSON.stringify({ success: true, server: serverEntry }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  async listServers(corsHeaders) {
    const now = Date.now();
    const servers = [];

    // Get all server entries
    const entries = await this.state.storage.list({ prefix: 'server:' });

    for (const [key, server] of entries) {
      // Filter out stale servers (not seen in TTL period)
      if (now - server.lastSeen < this.serverTTL) {
        servers.push(server);
      } else {
        // Clean up stale entry
        await this.state.storage.delete(key);
      }
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
