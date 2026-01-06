/**
 * Zajel Signaling Server - Cloudflare Worker
 *
 * A WebSocket server that facilitates WebRTC connection establishment
 * and provides relay/rendezvous services for peer discovery.
 *
 * This server:
 * - Manages relay peer registration and load balancing
 * - Provides meeting point (rendezvous) services for peer discovery
 * - Routes SDP offers/answers between peers
 * - Routes ICE candidates
 * - Never sees actual message content (end-to-end encrypted)
 * - Uses Durable Objects for stateful WebSocket management
 */

// Export Durable Objects
export { SignalingRoom } from './signaling-room.js';
export { RelayRegistryDO } from './durable-objects/relay-registry-do.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
          service: 'zajel-signaling',
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
    if (url.pathname === '/api/info') {
      return new Response(
        JSON.stringify({
          name: 'Zajel Signaling Server',
          version: '2.0.0',
          endpoints: {
            websocket: '/ws',
            relay: '/relay',
            health: '/health',
            stats: '/stats',
          },
          features: [
            'relay-registry',
            'rendezvous-points',
            'dead-drops',
            'webrtc-signaling',
          ],
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }

    // Stats endpoint - proxy to Durable Object
    if (url.pathname === '/stats') {
      const id = env.RELAY_REGISTRY.idFromName('global');
      const stub = env.RELAY_REGISTRY.get(id);
      const statsUrl = new URL(request.url);
      statsUrl.pathname = '/stats';
      return stub.fetch(statsUrl.toString());
    }

    // WebSocket upgrade for relay registry (includes rendezvous)
    if (url.pathname === '/relay' || url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      // Use a single Durable Object instance for all connections
      const id = env.RELAY_REGISTRY.idFromName('global');
      const stub = env.RELAY_REGISTRY.get(id);

      return stub.fetch(request);
    }

    // Legacy signaling room support (for backward compatibility)
    if (url.pathname === '/signaling') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const id = env.SIGNALING_ROOM.idFromName('global');
      const room = env.SIGNALING_ROOM.get(id);

      return room.fetch(request);
    }

    // Default response
    return new Response(
      'Zajel Signaling Server. Connect via WebSocket at /ws or /relay',
      {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          ...corsHeaders,
        },
      }
    );
  },
};
