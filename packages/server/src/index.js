/**
 * Zajel Bootstrap Server - Cloudflare Worker
 *
 * A simple server registry that helps VPS servers discover each other.
 * This is the ONLY purpose of the CF Worker - all client functionality
 * is handled by the federated VPS servers.
 *
 * Endpoints:
 * - POST /servers - Register a VPS server
 * - GET /servers - List all active VPS servers
 * - DELETE /servers/:id - Unregister a server
 * - POST /servers/heartbeat - Keep-alive for registered servers
 */

export { ServerRegistryDO } from './durable-objects/server-registry-do.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'zajel-bootstrap',
          timestamp: new Date().toISOString(),
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }

    // API info
    if (url.pathname === '/' || url.pathname === '/api/info') {
      return new Response(
        JSON.stringify({
          name: 'Zajel Bootstrap Server',
          version: '3.0.0',
          description: 'VPS server discovery service',
          endpoints: {
            health: 'GET /health',
            listServers: 'GET /servers',
            registerServer: 'POST /servers',
            unregisterServer: 'DELETE /servers/:serverId',
            heartbeat: 'POST /servers/heartbeat',
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }

    // All /servers/* routes go to the ServerRegistry Durable Object
    if (url.pathname.startsWith('/servers')) {
      const id = env.SERVER_REGISTRY.idFromName('global');
      const stub = env.SERVER_REGISTRY.get(id);
      return stub.fetch(request);
    }

    // Default - not found
    return new Response(
      JSON.stringify({
        error: 'Not Found',
        hint: 'Use GET /servers to list VPS servers',
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  },
};
