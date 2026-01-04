/**
 * Zajel Signaling Server
 *
 * A minimal WebSocket server that facilitates WebRTC connection establishment.
 * This server:
 * - Routes SDP offers/answers between peers
 * - Routes ICE candidates
 * - Never sees actual message content (end-to-end encrypted)
 * - Stores no persistent data
 *
 * Run: node server.js
 * Default port: 8080 (set PORT env var to change)
 */

import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 8080;

// Map of pairing codes to WebSocket connections
const clients = new Map();

// Create WebSocket server
const wss = new WebSocketServer({ port: PORT });

console.log(`Zajel Signaling Server running on port ${PORT}`);

wss.on('connection', (ws) => {
  let pairingCode = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, message, pairingCode, (code) => {
        pairingCode = code;
      });
    } catch (e) {
      console.error('Invalid message:', e.message);
      sendError(ws, 'Invalid message format');
    }
  });

  ws.on('close', () => {
    if (pairingCode) {
      clients.delete(pairingCode);
      console.log(`Client disconnected: ${pairingCode}`);
      // Notify connected peers that this peer left
      broadcastPeerLeft(pairingCode);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

function handleMessage(ws, message, currentCode, setCode) {
  const { type } = message;

  switch (type) {
    case 'register':
      handleRegister(ws, message, currentCode, setCode);
      break;

    case 'offer':
    case 'answer':
    case 'ice_candidate':
      handleSignaling(ws, message, currentCode);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      sendError(ws, `Unknown message type: ${type}`);
  }
}

function handleRegister(ws, message, currentCode, setCode) {
  const { pairingCode } = message;

  if (!pairingCode || typeof pairingCode !== 'string') {
    sendError(ws, 'Invalid pairing code');
    return;
  }

  // Check if code is already in use
  if (clients.has(pairingCode)) {
    const existingClient = clients.get(pairingCode);
    if (existingClient !== ws && existingClient.readyState === WebSocket.OPEN) {
      sendError(ws, 'Pairing code already in use');
      return;
    }
  }

  // Unregister old code if re-registering
  if (currentCode && currentCode !== pairingCode) {
    clients.delete(currentCode);
  }

  // Register new code
  clients.set(pairingCode, ws);
  setCode(pairingCode);

  console.log(`Client registered: ${pairingCode}`);

  // Send confirmation
  ws.send(JSON.stringify({
    type: 'registered',
    pairingCode,
  }));

  // Notify others that a new peer is available
  broadcastPeerJoined(pairingCode);
}

function handleSignaling(ws, message, senderCode) {
  const { type, target, payload } = message;

  if (!senderCode) {
    sendError(ws, 'Not registered');
    return;
  }

  if (!target || !payload) {
    sendError(ws, 'Missing target or payload');
    return;
  }

  const targetClient = clients.get(target);
  if (!targetClient || targetClient.readyState !== WebSocket.OPEN) {
    sendError(ws, 'Target peer not found');
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

function broadcastPeerJoined(pairingCode) {
  const message = JSON.stringify({
    type: 'peer_joined',
    pairingCode,
  });

  clients.forEach((client, code) => {
    if (code !== pairingCode && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastPeerLeft(pairingCode) {
  const message = JSON.stringify({
    type: 'peer_left',
    pairingCode,
  });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function sendError(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'error',
      message,
    }));
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close(() => {
    process.exit(0);
  });
});
