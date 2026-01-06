/**
 * WebSocketHandler
 *
 * Handles WebSocket messages for the Zajel signaling server.
 * Routes messages to appropriate registries and manages peer connections.
 */

export class WebSocketHandler {
  /**
   * Create a WebSocket handler
   * @param {Object} options - Handler dependencies
   * @param {import('./relay-registry.js').RelayRegistry} options.relayRegistry
   * @param {import('./rendezvous-registry.js').RendezvousRegistry} options.rendezvousRegistry
   * @param {Map<string, WebSocket>} options.wsConnections
   */
  constructor({ relayRegistry, rendezvousRegistry, wsConnections }) {
    this.relayRegistry = relayRegistry;
    this.rendezvousRegistry = rendezvousRegistry;
    this.wsConnections = wsConnections;

    // Set up match notification callback
    this.rendezvousRegistry.onMatch = (peerId, match) => {
      this.notifyPeer(peerId, {
        type: 'rendezvous_match',
        match,
      });
    };
  }

  /**
   * Handle incoming WebSocket message
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} data - Raw message data
   */
  handleMessage(ws, data) {
    let message;

    try {
      message = JSON.parse(data);
    } catch (e) {
      this.sendError(ws, 'Invalid message format: JSON parse error');
      return;
    }

    const { type } = message;

    switch (type) {
      case 'register':
        this.handleRegister(ws, message);
        break;

      case 'update_load':
        this.handleUpdateLoad(ws, message);
        break;

      case 'register_rendezvous':
        this.handleRegisterRendezvous(ws, message);
        break;

      case 'get_relays':
        this.handleGetRelays(ws, message);
        break;

      case 'ping':
        this.send(ws, { type: 'pong' });
        break;

      case 'heartbeat':
        this.handleHeartbeat(ws, message);
        break;

      default:
        this.sendError(ws, `Unknown message type: ${type}`);
    }
  }

  /**
   * Handle peer registration
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Registration message
   */
  handleRegister(ws, message) {
    const { peerId, maxConnections = 20, publicKey } = message;

    if (!peerId) {
      this.sendError(ws, 'Missing required field: peerId');
      return;
    }

    // Store WebSocket connection
    this.wsConnections.set(peerId, ws);

    // Register in relay registry
    this.relayRegistry.register(peerId, {
      maxConnections,
      publicKey,
    });

    // Get available relays (excluding self)
    const relays = this.relayRegistry.getAvailableRelays(peerId, 10);

    this.send(ws, {
      type: 'registered',
      peerId,
      relays,
    });
  }

  /**
   * Handle load update from a relay peer
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Load update message
   */
  handleUpdateLoad(ws, message) {
    const { peerId, connectedCount } = message;

    this.relayRegistry.updateLoad(peerId, connectedCount);

    this.send(ws, {
      type: 'load_updated',
      peerId,
      connectedCount,
    });
  }

  /**
   * Handle rendezvous point registration
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Rendezvous registration message
   */
  handleRegisterRendezvous(ws, message) {
    const {
      peerId,
      dailyPoints = [],
      hourlyTokens = [],
      deadDrop = '',
      relayId,
    } = message;

    // Register daily points and get dead drops
    const dailyResult = this.rendezvousRegistry.registerDailyPoints(peerId, {
      points: dailyPoints,
      deadDrop,
      relayId,
    });

    // Register hourly tokens and get live matches
    const hourlyResult = this.rendezvousRegistry.registerHourlyTokens(peerId, {
      tokens: hourlyTokens,
      relayId,
    });

    this.send(ws, {
      type: 'rendezvous_result',
      liveMatches: hourlyResult.liveMatches,
      deadDrops: dailyResult.deadDrops,
    });
  }

  /**
   * Handle get relays request
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Get relays message
   */
  handleGetRelays(ws, message) {
    const { peerId, count = 10 } = message;

    const relays = this.relayRegistry.getAvailableRelays(peerId, count);

    this.send(ws, {
      type: 'relays',
      relays,
    });
  }

  /**
   * Handle heartbeat message
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Heartbeat message
   */
  handleHeartbeat(ws, message) {
    const { peerId } = message;

    // Update last seen time by updating load with current value
    const peer = this.relayRegistry.getPeer(peerId);
    if (peer) {
      this.relayRegistry.updateLoad(peerId, peer.connectedCount);
    }

    this.send(ws, {
      type: 'heartbeat_ack',
      timestamp: Date.now(),
    });
  }

  /**
   * Handle peer disconnect
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} peerId - Disconnecting peer's ID
   */
  handleDisconnect(ws, peerId) {
    if (peerId) {
      // Remove from relay registry
      this.relayRegistry.unregister(peerId);

      // Remove from rendezvous registry
      this.rendezvousRegistry.unregisterPeer(peerId);

      // Remove WebSocket mapping
      this.wsConnections.delete(peerId);
    }
  }

  /**
   * Send a message to a specific peer
   * @param {string} peerId - Target peer ID
   * @param {Object} message - Message to send
   */
  notifyPeer(peerId, message) {
    const ws = this.wsConnections.get(peerId);
    if (ws) {
      this.send(ws, message);
    }
  }

  /**
   * Send a message to a WebSocket
   * @param {WebSocket} ws - Target WebSocket
   * @param {Object} message - Message to send
   */
  send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      // WebSocket may be closed
      console.error('Failed to send message:', e);
    }
  }

  /**
   * Send an error message to a WebSocket
   * @param {WebSocket} ws - Target WebSocket
   * @param {string} message - Error message
   */
  sendError(ws, message) {
    this.send(ws, {
      type: 'error',
      message,
    });
  }
}
