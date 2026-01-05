/**
 * Zajel Signaling Server - Cloudflare Worker
 *
 * A WebSocket server that facilitates WebRTC connection establishment.
 * Uses Durable Objects for WebSocket state management.
 *
 * This server:
 * - Routes SDP offers/answers between peers
 * - Routes ICE candidates
 * - Never sees actual message content (end-to-end encrypted)
 * - Stores no persistent data
 */

export { SignalingRoom } from './signaling-room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'zajel-signaling' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade for signaling
    if (url.pathname === '/ws' || url.pathname === '/') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      // Use a single Durable Object instance for all connections
      // This keeps all peers in the same "room" for discovery
      const id = env.SIGNALING_ROOM.idFromName('global');
      const room = env.SIGNALING_ROOM.get(id);

      return room.fetch(request);
    }

    // API info
    if (url.pathname === '/api/info') {
      return new Response(JSON.stringify({
        name: 'Zajel Signaling Server',
        version: '1.0.0',
        websocket: '/ws',
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Zajel Signaling Server. Connect via WebSocket at /ws', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
