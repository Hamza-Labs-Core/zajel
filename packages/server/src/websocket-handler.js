/**
 * WebSocketHandler
 *
 * Handles WebSocket messages for the Zajel signaling server.
 * Routes messages to appropriate registries and manages peer connections.
 */

/** Maximum chunk payload size in bytes (4KB) */
const MAX_TEXT_CHUNK_PAYLOAD = 4096;

export class WebSocketHandler {
  /**
   * Create a WebSocket handler
   * @param {Object} options - Handler dependencies
   * @param {import('./relay-registry.js').RelayRegistry} options.relayRegistry
   * @param {import('./rendezvous-registry.js').RendezvousRegistry} options.rendezvousRegistry
   * @param {import('./chunk-index.js').ChunkIndex} [options.chunkIndex]
   * @param {Map<string, WebSocket>} options.wsConnections
   */
  constructor({ relayRegistry, rendezvousRegistry, chunkIndex, wsConnections }) {
    this.relayRegistry = relayRegistry;
    this.rendezvousRegistry = rendezvousRegistry;
    this.chunkIndex = chunkIndex || null;
    this.wsConnections = wsConnections;

    // Set up match notification callback
    this.rendezvousRegistry.onMatch = (peerId, match) => {
      this.notifyPeer(peerId, {
        type: 'rendezvous_match',
        match,
      });
    };

    // Set up chunk availability callback
    if (this.chunkIndex) {
      this.chunkIndex.onChunkAvailable = (chunkId, waitingPeerIds) => {
        for (const peerId of waitingPeerIds) {
          this.notifyPeer(peerId, {
            type: 'chunk_available',
            chunkId,
          });
        }
      };
    }
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

      case 'chunk_announce':
        this.handleChunkAnnounce(ws, message);
        break;

      case 'chunk_request':
        this.handleChunkRequest(ws, message);
        break;

      case 'chunk_push':
        this.handleChunkPush(ws, message);
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

  // ---------------------------------------------------------------------------
  // Chunk message handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle chunk-announce: peer tells server which chunks it has.
   * This is used by both owners (initial publish) and subscribers (swarm seeding).
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Announce message with chunks array
   */
  handleChunkAnnounce(ws, message) {
    if (!this.chunkIndex) {
      this.sendError(ws, 'Chunk indexing not available');
      return;
    }

    const { peerId, chunks } = message;

    if (!peerId) {
      this.sendError(ws, 'Missing required field: peerId');
      return;
    }

    if (!Array.isArray(chunks) || chunks.length === 0) {
      this.sendError(ws, 'Missing or empty chunks array');
      return;
    }

    const result = this.chunkIndex.announceChunks(peerId, chunks);

    this.send(ws, {
      type: 'chunk_announce_ack',
      registered: result.registered,
    });

    // Check if any announced chunks have pending requests from other peers.
    // If so, request the chunk data from the announcer.
    for (const chunk of chunks) {
      if (this.chunkIndex.hasPendingRequests(chunk.chunkId) &&
          !this.chunkIndex.isChunkCached(chunk.chunkId)) {
        // Request the chunk data from this peer so we can cache and serve
        this.send(ws, {
          type: 'chunk_pull',
          chunkId: chunk.chunkId,
        });
      }
    }
  }

  /**
   * Handle chunk-request: subscriber asks for a specific chunk.
   * Server checks cache first, then finds an online source to pull from.
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Request message with chunkId
   */
  handleChunkRequest(ws, message) {
    if (!this.chunkIndex) {
      this.sendError(ws, 'Chunk indexing not available');
      return;
    }

    const { peerId, chunkId } = message;

    if (!peerId || !chunkId) {
      this.sendError(ws, 'Missing required fields: peerId, chunkId');
      return;
    }

    // Step 1: Check server cache
    const cachedData = this.chunkIndex.getCachedChunk(chunkId);
    if (cachedData) {
      this.send(ws, {
        type: 'chunk_data',
        chunkId,
        data: cachedData,
        source: 'cache',
      });
      return;
    }

    // Step 2: Find an online peer source
    const sources = this.chunkIndex.getChunkSources(chunkId);
    const onlineSources = sources.filter(
      s => s.peerId !== '__server_cache__' && this.wsConnections.has(s.peerId)
    );

    if (onlineSources.length === 0) {
      // No sources available - register pending request and inform the client
      this.chunkIndex.addPendingRequest(chunkId, peerId);
      this.send(ws, {
        type: 'chunk_not_found',
        chunkId,
        message: 'No online sources available. You will be notified when available.',
      });
      return;
    }

    // Step 3: Add pending request (for multicast: pull once, serve many)
    const isFirst = this.chunkIndex.addPendingRequest(chunkId, peerId);

    if (isFirst) {
      // This is the first request for this chunk - pull from a source
      const source = onlineSources[0];
      const sourceWs = this.wsConnections.get(source.peerId);
      if (sourceWs) {
        this.send(sourceWs, {
          type: 'chunk_pull',
          chunkId,
        });
      }
    }
    // If not first, another pull is already in progress - this peer will
    // be notified when the chunk arrives via the pending requests mechanism
  }

  /**
   * Handle chunk-push: a peer sends chunk data to the server.
   * This happens in response to a chunk_pull request from the server.
   * The server caches the chunk and serves all pending requesters.
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Push message with chunk data
   */
  handleChunkPush(ws, message) {
    if (!this.chunkIndex) {
      this.sendError(ws, 'Chunk indexing not available');
      return;
    }

    const { peerId, chunkId, data } = message;

    if (!chunkId || !data) {
      this.sendError(ws, 'Missing required fields: chunkId, data');
      return;
    }

    // Validate chunk payload size
    const payloadSize = JSON.stringify(data).length;
    if (payloadSize > MAX_TEXT_CHUNK_PAYLOAD) {
      this.sendError(ws, `Chunk payload too large: ${payloadSize} bytes exceeds ${MAX_TEXT_CHUNK_PAYLOAD} byte limit`);
      return;
    }

    // Cache the chunk
    this.chunkIndex.cacheChunk(chunkId, data);

    this.send(ws, {
      type: 'chunk_push_ack',
      chunkId,
    });

    // Serve all pending requesters (multicast)
    const pendingRequests = this.chunkIndex.consumePendingRequests(chunkId);
    for (const request of pendingRequests) {
      const requestWs = this.wsConnections.get(request.peerId);
      if (requestWs) {
        this.send(requestWs, {
          type: 'chunk_data',
          chunkId,
          data,
          source: 'relay',
        });
      }
    }
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

      // Remove from chunk index
      if (this.chunkIndex) {
        this.chunkIndex.unregisterPeer(peerId);
      }

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
