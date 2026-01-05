/**
 * SignalingRoom Durable Object
 *
 * Manages WebSocket connections for WebRTC signaling.
 * Each connection registers with a pairing code and can send
 * signaling messages to other registered peers.
 */

export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Map of pairing codes to WebSocket connections
    this.clients = new Map();
  }

  async fetch(request) {
    // Handle WebSocket upgrade
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      await this.handleMessage(ws, data);
    } catch (e) {
      this.sendError(ws, 'Invalid message format');
    }
  }

  async webSocketClose(ws, code, reason) {
    // Find and remove the disconnected client
    for (const [pairingCode, client] of this.clients.entries()) {
      if (client === ws) {
        this.clients.delete(pairingCode);
        console.log(`Client disconnected: ${pairingCode}`);
        this.broadcastPeerLeft(pairingCode);
        break;
      }
    }
  }

  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }

  async handleMessage(ws, message) {
    const { type } = message;

    switch (type) {
      case 'register':
        await this.handleRegister(ws, message);
        break;

      case 'offer':
      case 'answer':
      case 'ice_candidate':
        await this.handleSignaling(ws, message);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        this.sendError(ws, `Unknown message type: ${type}`);
    }
  }

  async handleRegister(ws, message) {
    const { pairingCode } = message;

    if (!pairingCode || typeof pairingCode !== 'string') {
      this.sendError(ws, 'Invalid pairing code');
      return;
    }

    // Check if code is already in use by another connection
    if (this.clients.has(pairingCode)) {
      const existingClient = this.clients.get(pairingCode);
      if (existingClient !== ws) {
        this.sendError(ws, 'Pairing code already in use');
        return;
      }
    }

    // Remove old registration if this socket was registered with a different code
    for (const [code, client] of this.clients.entries()) {
      if (client === ws && code !== pairingCode) {
        this.clients.delete(code);
        break;
      }
    }

    // Register new code
    this.clients.set(pairingCode, ws);
    console.log(`Client registered: ${pairingCode}`);

    // Send confirmation
    ws.send(JSON.stringify({
      type: 'registered',
      pairingCode,
    }));

    // Notify others that a new peer is available
    this.broadcastPeerJoined(pairingCode);
  }

  async handleSignaling(ws, message) {
    const { type, target, payload } = message;

    // Find sender's pairing code
    let senderCode = null;
    for (const [code, client] of this.clients.entries()) {
      if (client === ws) {
        senderCode = code;
        break;
      }
    }

    if (!senderCode) {
      this.sendError(ws, 'Not registered');
      return;
    }

    if (!target || !payload) {
      this.sendError(ws, 'Missing target or payload');
      return;
    }

    const targetClient = this.clients.get(target);
    if (!targetClient) {
      this.sendError(ws, 'Target peer not found');
      return;
    }

    // Forward the signaling message
    targetClient.send(JSON.stringify({
      type,
      from: senderCode,
      payload,
    }));

    console.log(`Signaling ${type}: ${senderCode} -> ${target}`);
  }

  broadcastPeerJoined(pairingCode) {
    const message = JSON.stringify({
      type: 'peer_joined',
      pairingCode,
    });

    for (const [code, client] of this.clients.entries()) {
      if (code !== pairingCode) {
        try {
          client.send(message);
        } catch (e) {
          // Client may have disconnected
        }
      }
    }
  }

  broadcastPeerLeft(pairingCode) {
    const message = JSON.stringify({
      type: 'peer_left',
      pairingCode,
    });

    for (const client of this.clients.values()) {
      try {
        client.send(message);
      } catch (e) {
        // Client may have disconnected
      }
    }
  }

  sendError(ws, message) {
    try {
      ws.send(JSON.stringify({
        type: 'error',
        message,
      }));
    } catch (e) {
      // WebSocket may be closed
    }
  }
}
