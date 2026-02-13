/**
 * RelayRegistryDO - Durable Object
 *
 * Cloudflare Durable Object wrapper for the RelayRegistry.
 * Provides persistent state management and WebSocket handling for relay peer tracking.
 */

import { RelayRegistry } from '../relay-registry.js';
import { RendezvousRegistry } from '../rendezvous-registry.js';
import { ChunkIndex } from '../chunk-index.js';
import { WebSocketHandler } from '../websocket-handler.js';

export class RelayRegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // Initialize registries
    this.relayRegistry = new RelayRegistry();
    this.rendezvousRegistry = new RendezvousRegistry();
    this.chunkIndex = new ChunkIndex();

    // Map of peerId to WebSocket
    this.wsConnections = new Map();

    // WebSocket handler
    this.handler = new WebSocketHandler({
      relayRegistry: this.relayRegistry,
      rendezvousRegistry: this.rendezvousRegistry,
      chunkIndex: this.chunkIndex,
      wsConnections: this.wsConnections,
    });

    // Map of WebSocket to peerId (for disconnect handling)
    this.wsToPeerId = new Map();

    // Periodic cleanup every 5 minutes
    this.state.blockConcurrencyWhile(async () => {
      // Schedule cleanup alarm
      const currentAlarm = await this.state.storage.getAlarm();
      if (!currentAlarm) {
        await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
      }
    });
  }

  /**
   * Handle alarm for periodic cleanup
   */
  async alarm() {
    // Cleanup expired entries
    this.rendezvousRegistry.cleanup();
    this.chunkIndex.cleanup();

    // Schedule next cleanup
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  /**
   * Handle HTTP requests (WebSocket upgrade)
   */
  async fetch(request) {
    const url = new URL(request.url);

    // Stats endpoint
    if (url.pathname === '/stats') {
      return new Response(JSON.stringify({
        relays: this.relayRegistry.getStats(),
        rendezvous: this.rendezvousRegistry.getStats(),
        chunks: this.chunkIndex.getStats(),
        connections: this.wsConnections.size,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      // Track peer ID for this WebSocket on registration
      if (data.type === 'register' && data.peerId) {
        this.wsToPeerId.set(ws, data.peerId);
      }

      this.handler.handleMessage(ws, message);
    } catch (e) {
      console.error('WebSocket message error:', e);
      this.handler.sendError(ws, 'Internal server error');
    }
  }

  /**
   * Handle WebSocket close
   */
  async webSocketClose(ws, code, reason) {
    const peerId = this.wsToPeerId.get(ws);
    if (peerId) {
      this.handler.handleDisconnect(ws, peerId);
      this.wsToPeerId.delete(ws);
    }
  }

  /**
   * Handle WebSocket error
   */
  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
    const peerId = this.wsToPeerId.get(ws);
    if (peerId) {
      this.handler.handleDisconnect(ws, peerId);
      this.wsToPeerId.delete(ws);
    }
  }
}
