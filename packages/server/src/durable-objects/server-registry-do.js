/**
 * ServerRegistry Durable Object
 *
 * Simple registry for VPS servers to discover each other.
 * VPS servers register here on startup and query for peers.
 *
 * This is the ONLY functionality of the CF Workers server.
 */

export class ServerRegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // TTL for server entries (5 minutes)
    this.serverTTL = 5 * 60 * 1000;
  }

  async fetch(request) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // POST /servers - Register a server
      if (request.method === 'POST' && url.pathname === '/servers') {
        return await this.registerServer(request, corsHeaders);
      }

      // GET /servers - List all servers
      if (request.method === 'GET' && url.pathname === '/servers') {
        return await this.listServers(corsHeaders);
      }

      // DELETE /servers/:serverId - Unregister a server
      if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
        const serverId = url.pathname.split('/')[2];
        return await this.unregisterServer(serverId, corsHeaders);
      }

      // POST /servers/heartbeat - Update server timestamp
      if (request.method === 'POST' && url.pathname === '/servers/heartbeat') {
        return await this.heartbeat(request, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  }

  async registerServer(request, corsHeaders) {
    const body = await request.json();
    const { serverId, endpoint, publicKey, region } = body;

    if (!serverId || !endpoint || !publicKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: serverId, endpoint, publicKey' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
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

  async unregisterServer(serverId, corsHeaders) {
    await this.state.storage.delete(`server:${serverId}`);

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  async heartbeat(request, corsHeaders) {
    const body = await request.json();
    const { serverId } = body;

    if (!serverId) {
      return new Response(
        JSON.stringify({ error: 'Missing serverId' }),
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
