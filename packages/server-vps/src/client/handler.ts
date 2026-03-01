/**
 * Client WebSocket Handler
 *
 * Thin facade that receives WebSocket messages, applies rate limiting,
 * validates payloads, and delegates to the appropriate sub-handler:
 *
 *   - SignalingHandler  — pairing codes, pair request/response, WebRTC & call forwarding
 *   - LinkHandler       — device linking (web <-> mobile)
 *   - ChannelHandler    — channel owner/subscribe, upstream, streaming
 *   - ChunkRelay        — chunk announce/request/push
 *   - RelayHandler      — relay registration, load updates, heartbeat, rendezvous, getRelays
 *   - AttestationHandler— attestation request/response, gating
 *
 * Shared state (clients map, wsToClient map, etc.) is exposed via HandlerContext.
 */

import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import type { ServerIdentity, ServerMetadata } from '../types.js';
import { RelayRegistry } from '../registry/relay-registry.js';
import { DistributedRendezvous } from '../registry/distributed-rendezvous.js';
import { logger } from '../utils/logger.js';

import { WEBSOCKET, RATE_LIMIT, PAIRING, CHUNK_LIMITS, PEER_ID } from '../constants.js';
import { ChunkRelay } from './chunk-relay.js';
import { ChannelHandler } from './channel-handler.js';
import { SignalingHandler } from './signaling-handler.js';
import { LinkHandler } from './link-handler.js';
import { RelayHandler } from './relay-handler.js';
import { AttestationHandler } from './attestation-handler.js';
import type { HandlerContext } from './context.js';
import type { Storage } from '../storage/interface.js';
import { AttestationManager, type AttestationConfig } from '../attestation/attestation-manager.js';
import type { FederationManager } from '../federation/federation-manager.js';

// Re-export types for backward compatibility
export type { ClientHandlerConfig, ClientInfo, ClientHandlerEvents } from './types.js';
export type { EntropyMetrics } from './types.js';

import type {
  ClientHandlerConfig,
  ClientInfo,
  ClientMessage,
  EntropyMetrics,
  RateLimitInfo,
  PairRequestRateLimitInfo,
  RegisterMessage,
  UpdateLoadMessage,
  RegisterRendezvousMessage,
  GetRelaysMessage,
  HeartbeatMessage,
  SignalingRegisterMessage,
  PairRequestMessage,
  PairResponseMessage,
  SignalingOfferMessage,
  SignalingAnswerMessage,
  SignalingIceCandidateMessage,
  CallOfferMessage,
  CallAnswerMessage,
  CallRejectMessage,
  CallHangupMessage,
  CallIceMessage,
  LinkRequestMessage,
  LinkResponseMessage,
  UpstreamMessageData,
  StreamStartMessage,
  StreamFrameMessage,
  StreamEndMessage,
  ChannelSubscribeMessage,
  ChannelOwnerRegisterMessage,
  ChunkAnnounceMessage,
  ChunkRequestMessage,
  ChunkPushMessage,
  AttestRequestMessage,
  AttestResponseMessage,
} from './types.js';

/**
 * Validate peerId format: must be a string of 1-128 alphanumeric characters,
 * hyphens, or underscores.
 */
function isValidPeerId(peerId: unknown): peerId is string {
  return (
    typeof peerId === 'string' &&
    peerId.length > 0 &&
    peerId.length <= PEER_ID.MAX_LENGTH &&
    PEER_ID.PATTERN.test(peerId)
  );
}

export class ClientHandler extends EventEmitter {
  private identity: ServerIdentity;
  private endpoint: string;
  private metadata: ServerMetadata;
  private config: ClientHandlerConfig;
  private relayRegistry: RelayRegistry;
  private distributedRendezvous: DistributedRendezvous;
  private clients: Map<string, ClientInfo> = new Map();
  private wsToClient: Map<WebSocket, string> = new Map();

  // Rate limiting
  private wsRateLimits: Map<WebSocket, RateLimitInfo> = new Map();
  // Pair request rate limiting (stricter limit for expensive operations)
  private wsPairRequestRateLimits: Map<WebSocket, PairRequestRateLimitInfo> = new Map();

  // Sub-handlers
  private signalingHandler: SignalingHandler;
  private linkHandler: LinkHandler;
  private channelHandler: ChannelHandler;
  private relayHandler: RelayHandler;
  private attestationHandler: AttestationHandler;

  // Chunk relay service (optional - only initialized when storage is provided)
  private chunkRelay: ChunkRelay | null = null;

  // Attestation manager (optional - only initialized when attestation config is provided)
  private attestationManager: AttestationManager | null = null;
  // WebSocket -> attestation connection ID mapping
  private wsToConnectionId: Map<WebSocket, string> = new Map();
  // Guard: track WebSockets that have already been disconnected (prevents double cleanup)
  private disconnectedSockets: WeakSet<WebSocket> = new WeakSet();

  // Federation manager for DHT redirect info (optional)
  private federation: FederationManager | null = null;

  constructor(
    identity: ServerIdentity,
    endpoint: string,
    config: ClientHandlerConfig,
    relayRegistry: RelayRegistry,
    distributedRendezvous: DistributedRendezvous,
    metadata: ServerMetadata = {},
    storage?: Storage,
    attestationConfig?: AttestationConfig,
    federation?: FederationManager
  ) {
    super();
    this.identity = identity;
    this.endpoint = endpoint;
    this.config = config;
    this.relayRegistry = relayRegistry;
    this.distributedRendezvous = distributedRendezvous;
    this.metadata = metadata;

    // Initialize chunk relay if storage is provided
    if (storage) {
      this.chunkRelay = new ChunkRelay(storage);
      this.chunkRelay.setSendCallback((peerId, message) => this.notifyClient(peerId, message));
      this.chunkRelay.startCleanup();
    }

    // Initialize attestation manager if config is provided
    if (attestationConfig) {
      this.attestationManager = new AttestationManager(attestationConfig);
    }

    // Store federation reference for DHT redirect lookups
    if (federation) {
      this.federation = federation;
    }

    // Initialize signaling handler
    this.signalingHandler = new SignalingHandler({
      send: (ws, message) => this.send(ws, message),
      sendError: (ws, message) => this.sendError(ws, message),
      getServerId: () => this.identity.serverId,
      getPairingCodeRedirects: (code) => this.getPairingCodeRedirects(code),
      pairRequestTimeout: config.pairRequestTimeout ?? PAIRING.DEFAULT_REQUEST_TIMEOUT,
      pairRequestWarningTime: config.pairRequestWarningTime ?? PAIRING.DEFAULT_REQUEST_WARNING_TIME,
    });

    // Initialize link handler
    this.linkHandler = new LinkHandler({
      send: (ws, message) => this.send(ws, message),
      sendError: (ws, message) => this.sendError(ws, message),
      getPairingCodeWs: (code) => this.signalingHandler.getPairingCodeWs(code),
      getWsPairingCode: (ws) => this.signalingHandler.getWsPairingCode(ws),
      getPairingCodePublicKey: (code) => this.signalingHandler.getPairingCodePublicKey(code),
      linkRequestTimeout: config.pairRequestTimeout ?? PAIRING.DEFAULT_REQUEST_TIMEOUT,
    });

    // Initialize channel handler
    this.channelHandler = new ChannelHandler({
      send: (ws, message) => this.send(ws, message),
      sendError: (ws, message) => this.sendError(ws, message),
      chunkRelay: this.chunkRelay,
    });

    // Build the HandlerContext for context-based sub-handlers
    const ctx: HandlerContext = {
      identity: this.identity,
      endpoint: this.endpoint,
      metadata: this.metadata,
      config: this.config,
      relayRegistry: this.relayRegistry,
      distributedRendezvous: this.distributedRendezvous,
      attestationManager: this.attestationManager,
      federation: this.federation,
      chunkRelay: this.chunkRelay,
      signalingHandler: this.signalingHandler,
      channelHandler: this.channelHandler,
      clients: this.clients,
      wsToClient: this.wsToClient,
      wsToConnectionId: this.wsToConnectionId,
      send: (ws, message) => this.send(ws, message),
      sendError: (ws, message) => this.sendError(ws, message),
      notifyClient: (peerId, message) => this.notifyClient(peerId, message),
    };

    // Initialize relay handler
    this.relayHandler = new RelayHandler(ctx);

    // Initialize attestation handler
    this.attestationHandler = new AttestationHandler(ctx);

    // Forward match notifications to clients
    this.distributedRendezvous.on('match', (peerId, match) => {
      this.notifyClient(peerId, {
        type: 'rendezvous_match',
        match,
      });
    });
  }

  /**
   * Get DHT redirect targets for a pairing code.
   * Returns servers that are also responsible for this code in the hash ring.
   */
  private getPairingCodeRedirects(pairingCode: string): Array<{ serverId: string; endpoint: string }> {
    if (!this.federation) return [];
    const targets = this.federation.getRedirectTargets([pairingCode]);
    return targets.map(t => ({ serverId: t.serverId, endpoint: t.endpoint }));
  }

  /**
   * Handle new WebSocket connection
   */
  handleConnection(ws: WebSocket): void {
    // Send server info immediately
    this.send(ws, {
      type: 'server_info',
      serverId: this.identity.serverId,
      endpoint: this.endpoint,
      region: this.metadata.region || null,
    });

    // Create attestation session if attestation is configured
    if (this.attestationManager) {
      const connectionId = this.attestationManager.createSession();
      this.wsToConnectionId.set(ws, connectionId);

      // Send server identity proof (Phase 4: Server Identity)
      const identityProof = this.attestationManager.generateServerIdentityProof();
      this.send(ws, identityProof);
    }
  }

  /**
   * Check and update rate limit for a WebSocket connection
   * Returns true if the message should be allowed, false if rate limited
   */
  private checkRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    let rateLimitInfo = this.wsRateLimits.get(ws);

    if (!rateLimitInfo) {
      rateLimitInfo = { messageCount: 1, windowStart: now };
      this.wsRateLimits.set(ws, rateLimitInfo);
      return true;
    }

    if (now - rateLimitInfo.windowStart >= RATE_LIMIT.WINDOW_MS) {
      rateLimitInfo.messageCount = 1;
      rateLimitInfo.windowStart = now;
      return true;
    }

    rateLimitInfo.messageCount++;

    if (rateLimitInfo.messageCount > RATE_LIMIT.MAX_MESSAGES) {
      return false;
    }

    return true;
  }

  /**
   * Check and update pair request rate limit for a WebSocket connection
   */
  private checkPairRequestRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    let rateLimitInfo = this.wsPairRequestRateLimits.get(ws);

    if (!rateLimitInfo) {
      rateLimitInfo = { requestCount: 1, windowStart: now };
      this.wsPairRequestRateLimits.set(ws, rateLimitInfo);
      return true;
    }

    if (now - rateLimitInfo.windowStart >= RATE_LIMIT.WINDOW_MS) {
      rateLimitInfo.requestCount = 1;
      rateLimitInfo.windowStart = now;
      return true;
    }

    rateLimitInfo.requestCount++;

    if (rateLimitInfo.requestCount > RATE_LIMIT.MAX_PAIR_REQUESTS) {
      return false;
    }

    return true;
  }

  /**
   * Validate required fields and types for incoming messages.
   * Returns an error string if invalid, or null if valid.
   */
  private validateMessage(msg: Record<string, unknown>): string | null {
    if (typeof msg !== 'object' || msg === null) {
      return 'Message must be a JSON object';
    }
    const type = msg['type'];
    if (typeof type !== 'string') {
      return 'Missing or invalid "type" field';
    }
    switch (type) {
      case 'register':
        if ('pairingCode' in msg) {
          if (typeof msg['pairingCode'] !== 'string') return 'register: pairingCode must be a string';
          if (typeof msg['publicKey'] !== 'string') return 'register: publicKey must be a string';
        } else {
          if (typeof msg['peerId'] !== 'string') return 'register: peerId must be a string';
        }
        break;
      case 'pair_request':
        if (typeof msg['targetCode'] !== 'string') return 'pair_request: targetCode must be a string';
        break;
      case 'pair_response':
        if (typeof msg['targetCode'] !== 'string') return 'pair_response: targetCode must be a string';
        if (typeof msg['accepted'] !== 'boolean') return 'pair_response: accepted must be a boolean';
        break;
      case 'offer':
      case 'answer':
      case 'ice_candidate':
        if (typeof msg['target'] !== 'string') return `${type}: target must be a string`;
        break;
      case 'call_offer':
      case 'call_answer':
      case 'call_reject':
      case 'call_hangup':
      case 'call_ice':
        if (typeof msg['target'] !== 'string') return `${type}: target must be a string`;
        break;
      case 'link_request':
        if (typeof msg['linkCode'] !== 'string') return 'link_request: linkCode must be a string';
        if (typeof msg['publicKey'] !== 'string') return 'link_request: publicKey must be a string';
        break;
      case 'link_response':
        if (typeof msg['linkCode'] !== 'string') return 'link_response: linkCode must be a string';
        if (typeof msg['accepted'] !== 'boolean') return 'link_response: accepted must be a boolean';
        break;
      case 'upstream-message':
        if (typeof msg['channelId'] !== 'string') return 'upstream-message: channelId must be a string';
        if (typeof msg['ephemeralPublicKey'] !== 'string') return 'upstream-message: ephemeralPublicKey must be a string';
        break;
      case 'stream-start':
      case 'stream-frame':
      case 'stream-end':
        if (typeof msg['streamId'] !== 'string') return `${type}: streamId must be a string`;
        if (typeof msg['channelId'] !== 'string') return `${type}: channelId must be a string`;
        break;
      case 'channel-subscribe':
      case 'channel-owner-register':
        if (typeof msg['channelId'] !== 'string') return `${type}: channelId must be a string`;
        break;
      case 'chunk_announce':
        if (typeof msg['peerId'] !== 'string') return 'chunk_announce: peerId must be a string';
        if (!Array.isArray(msg['chunks'])) return 'chunk_announce: chunks must be an array';
        break;
      case 'chunk_request':
      case 'chunk_push':
        if (typeof msg['chunkId'] !== 'string') return `${type}: chunkId must be a string`;
        if (typeof msg['channelId'] !== 'string') return `${type}: channelId must be a string`;
        break;
      case 'update_load':
        if (typeof msg['peerId'] !== 'string') return 'update_load: peerId must be a string';
        break;
      case 'register_rendezvous':
        if (typeof msg['peerId'] !== 'string') return 'register_rendezvous: peerId must be a string';
        if (typeof msg['relayId'] !== 'string') return 'register_rendezvous: relayId must be a string';
        break;
      case 'heartbeat':
        if (typeof msg['peerId'] !== 'string') return 'heartbeat: peerId must be a string';
        break;
      case 'attest_request':
        if (typeof msg['build_token'] !== 'string') return 'attest_request: build_token must be a string';
        if (typeof msg['device_id'] !== 'string') return 'attest_request: device_id must be a string';
        break;
      case 'attest_response':
        if (typeof msg['nonce'] !== 'string') return 'attest_response: nonce must be a string';
        if (!Array.isArray(msg['responses'])) return 'attest_response: responses must be an array';
        break;
      case 'ping':
      case 'get_relays':
        break; // no required fields
      default:
        break;
    }
    return null;
  }

  /**
   * Handle incoming WebSocket message
   */
  async handleMessage(ws: WebSocket, data: string): Promise<void> {
    // Size validation (defense in depth)
    if (data.length > WEBSOCKET.MAX_MESSAGE_SIZE) {
      console.warn(`[Security] Rejected oversized message: ${data.length} bytes (limit: ${WEBSOCKET.MAX_MESSAGE_SIZE})`);
      this.sendError(ws, 'Message too large');
      ws.close(1009, 'Message Too Big');
      return;
    }

    // Rate limiting check
    if (!this.checkRateLimit(ws)) {
      this.sendError(ws, 'Rate limit exceeded. Please slow down.');
      return;
    }

    let message: ClientMessage;

    try {
      message = JSON.parse(data);
    } catch (e) {
      this.sendError(ws, 'Invalid message format: JSON parse error');
      return;
    }

    // Validate required fields per message type
    const validationError = this.validateMessage(message as unknown as Record<string, unknown>);
    if (validationError) {
      this.sendError(ws, `Invalid message: ${validationError}`);
      return;
    }

    // Verify peerId consistency for non-register messages that include a peerId.
    if ('peerId' in message && message.type !== 'register') {
      const boundPeerId = this.wsToClient.get(ws);
      if (boundPeerId) {
        if ((message as { peerId: string }).peerId !== boundPeerId) {
          this.sendError(ws, 'peerId mismatch with registered identity');
          return;
        }
        (message as { peerId: string }).peerId = boundPeerId;
      }
    }

    try {
      switch (message.type) {
        // ----- Registration -----
        case 'register':
          if ('pairingCode' in message) {
            this.signalingHandler.handlePairingCodeRegister(ws, message as SignalingRegisterMessage);
          } else {
            await this.relayHandler.handleRegister(ws, message as RegisterMessage);
            // Emit client-connected event (relay handler stores the mapping)
            const peerId = (message as RegisterMessage).peerId;
            const client = this.clients.get(peerId);
            if (client) {
              this.emit('client-connected', client);
            }
          }
          break;

        // ----- Pairing -----
        case 'pair_request':
          if (!this.checkPairRequestRateLimit(ws)) {
            this.sendError(ws, 'Too many pair requests. Please slow down.');
            return;
          }
          this.signalingHandler.handlePairRequest(ws, message as PairRequestMessage);
          break;

        case 'pair_response':
          this.signalingHandler.handlePairResponse(ws, message as PairResponseMessage);
          break;

        // ----- WebRTC signaling -----
        case 'offer':
          this.signalingHandler.handleSignalingForward(ws, message as SignalingOfferMessage);
          break;

        case 'answer':
          this.signalingHandler.handleSignalingForward(ws, message as SignalingAnswerMessage);
          break;

        case 'ice_candidate':
          this.signalingHandler.handleSignalingForward(ws, message as SignalingIceCandidateMessage);
          break;

        // ----- VoIP call signaling -----
        case 'call_offer':
          this.signalingHandler.handleCallSignalingForward(ws, message as CallOfferMessage);
          break;

        case 'call_answer':
          this.signalingHandler.handleCallSignalingForward(ws, message as CallAnswerMessage);
          break;

        case 'call_reject':
          this.signalingHandler.handleCallSignalingForward(ws, message as CallRejectMessage);
          break;

        case 'call_hangup':
          this.signalingHandler.handleCallSignalingForward(ws, message as CallHangupMessage);
          break;

        case 'call_ice':
          this.signalingHandler.handleCallSignalingForward(ws, message as CallIceMessage);
          break;

        // ----- Device linking -----
        case 'link_request':
          this.linkHandler.handleLinkRequest(ws, message as LinkRequestMessage);
          break;

        case 'link_response':
          this.linkHandler.handleLinkResponse(ws, message as LinkResponseMessage);
          break;

        // ----- Channels -----
        case 'upstream-message':
          this.channelHandler.handleUpstreamMessage(ws, message as UpstreamMessageData);
          break;

        case 'stream-start':
          this.channelHandler.handleStreamStart(ws, message as StreamStartMessage);
          break;

        case 'stream-frame':
          this.channelHandler.handleStreamFrame(ws, message as StreamFrameMessage);
          break;

        case 'stream-end':
          this.channelHandler.handleStreamEnd(ws, message as StreamEndMessage);
          break;

        case 'channel-subscribe':
          await this.channelHandler.handleChannelSubscribe(ws, message as ChannelSubscribeMessage);
          break;

        case 'channel-owner-register':
          this.channelHandler.handleChannelOwnerRegister(ws, message as ChannelOwnerRegisterMessage);
          break;

        // ----- Chunk relay (attestation-gated) -----
        case 'chunk_announce':
          if (!this.attestationHandler.checkAttestation(ws)) return;
          await this.handleChunkAnnounce(ws, message as ChunkAnnounceMessage);
          break;

        case 'chunk_request':
          if (!this.attestationHandler.checkAttestation(ws)) return;
          await this.handleChunkRequest(ws, message as ChunkRequestMessage);
          break;

        case 'chunk_push':
          if (!this.attestationHandler.checkAttestation(ws)) return;
          await this.handleChunkPush(ws, message as ChunkPushMessage);
          break;

        // ----- Relay & rendezvous -----
        case 'update_load':
          this.relayHandler.handleUpdateLoad(ws, message as UpdateLoadMessage);
          break;

        case 'register_rendezvous':
          await this.relayHandler.handleRegisterRendezvous(ws, message as RegisterRendezvousMessage);
          break;

        case 'get_relays':
          this.relayHandler.handleGetRelays(ws, message as GetRelaysMessage);
          break;

        case 'ping':
          this.send(ws, { type: 'pong' });
          break;

        case 'heartbeat':
          this.relayHandler.handleHeartbeat(ws, message as HeartbeatMessage);
          break;

        // ----- Attestation -----
        case 'attest_request':
          await this.attestationHandler.handleAttestRequest(ws, message as AttestRequestMessage);
          break;

        case 'attest_response':
          await this.attestationHandler.handleAttestResponse(ws, message as AttestResponseMessage);
          break;

        default:
          this.sendError(ws, `Unknown message type: ${(message as { type: string }).type}`);
      }
    } catch (error) {
      const peerId = this.wsToClient.get(ws) || null;
      this.emit('message-error', peerId, error as Error);
      this.sendError(ws, 'Internal server error');
    }
  }

  // ---------------------------------------------------------------------------
  // Chunk relay handlers (still in handler.ts because they need cross-handler
  // lookups between channel subscribers and signaling pairing codes)
  // ---------------------------------------------------------------------------

  private async handleChunkAnnounce(ws: WebSocket, message: ChunkAnnounceMessage): Promise<void> {
    if (!this.chunkRelay) {
      this.sendError(ws, 'Chunk relay not available');
      return;
    }

    const { peerId, channelId, chunks } = message;

    if (!isValidPeerId(peerId)) {
      this.sendError(ws, 'Invalid peerId');
      return;
    }

    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      this.sendError(ws, 'Missing or empty chunks array');
      return;
    }

    if (chunks.length > CHUNK_LIMITS.MAX_CHUNKS_PER_ANNOUNCE) {
      this.sendError(ws, `Too many chunks per announce (max ${CHUNK_LIMITS.MAX_CHUNKS_PER_ANNOUNCE})`);
      return;
    }

    for (const chunk of chunks) {
      if (!chunk.chunkId || typeof chunk.chunkId !== 'string' || chunk.chunkId.length > CHUNK_LIMITS.MAX_CHUNK_ID_LENGTH) {
        this.sendError(ws, 'Invalid chunk entry: chunkId must be a string up to 256 chars');
        return;
      }
      if (chunk.routingHash !== undefined && (typeof chunk.routingHash !== 'string' || chunk.routingHash.length > CHUNK_LIMITS.MAX_ROUTING_HASH_LENGTH)) {
        this.sendError(ws, 'Invalid chunk entry: routingHash must be a string up to 256 chars');
        return;
      }
    }

    this.chunkRelay.registerPeer(peerId, ws);

    const result = await this.chunkRelay.handleAnnounce(peerId, chunks);

    if (result.error) {
      this.sendError(ws, result.error);
      return;
    }

    this.send(ws, {
      type: 'chunk_announce_ack',
      registered: result.registered,
    });

    // Notify channel subscribers about new chunks
    if (channelId) {
      const subscribers = this.channelHandler.getSubscribers(channelId);
      if (subscribers) {
        const chunkIds = chunks.map(c => c.chunkId);
        const notification = {
          type: 'chunk_available',
          channelId,
          chunkIds,
        };
        for (const subWs of subscribers) {
          if (subWs !== ws && subWs.readyState === subWs.OPEN) {
            this.send(subWs, notification);
          }
        }
      }
    }
  }

  private async handleChunkRequest(ws: WebSocket, message: ChunkRequestMessage): Promise<void> {
    if (!this.chunkRelay) {
      this.sendError(ws, 'Chunk relay not available');
      return;
    }

    const { chunkId, channelId } = message;

    if (!chunkId) {
      this.sendError(ws, 'Missing required field: chunkId');
      return;
    }

    if (!channelId) {
      this.sendError(ws, 'Missing required field: channelId');
      return;
    }

    const peerId = this.wsToClient.get(ws) || this.signalingHandler.getWsPairingCode(ws);
    if (!peerId) {
      this.sendError(ws, 'Not registered');
      return;
    }

    this.chunkRelay.registerPeer(peerId, ws);

    const result = await this.chunkRelay.handleRequest(peerId, ws, chunkId, channelId);

    if (result.error) {
      this.send(ws, {
        type: 'chunk_error',
        chunkId,
        error: result.error,
      });
    } else if (!result.served && result.pulling) {
      this.send(ws, {
        type: 'chunk_pulling',
        chunkId,
      });
    }
  }

  private async handleChunkPush(ws: WebSocket, message: ChunkPushMessage): Promise<void> {
    if (!this.chunkRelay) {
      this.sendError(ws, 'Chunk relay not available');
      return;
    }

    const { chunkId, channelId, data } = message;

    if (!chunkId) {
      this.sendError(ws, 'Missing required field: chunkId');
      return;
    }

    if (!channelId) {
      this.sendError(ws, 'Missing required field: channelId');
      return;
    }

    if (!data) {
      this.sendError(ws, 'Missing required field: data');
      return;
    }

    const peerId = this.wsToClient.get(ws) || this.signalingHandler.getWsPairingCode(ws);
    if (!peerId) {
      this.sendError(ws, 'Not registered');
      return;
    }

    const result = await this.chunkRelay.handlePush(peerId, chunkId, channelId, data);

    if (result.error) {
      this.sendError(ws, result.error);
      return;
    }

    this.send(ws, {
      type: 'chunk_push_ack',
      chunkId,
      cached: result.cached,
      servedCount: result.servedCount,
    });
  }

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  async handleDisconnect(ws: WebSocket): Promise<void> {
    // Idempotent guard: skip if already disconnected (e.g. cleanup() + ws 'close' event)
    if (this.disconnectedSockets.has(ws)) return;
    this.disconnectedSockets.add(ws);

    try {
      // Clean up attestation session
      try {
        const connectionId = this.wsToConnectionId.get(ws);
        if (connectionId && this.attestationManager) {
          this.attestationManager.removeSession(connectionId);
        }
        this.wsToConnectionId.delete(ws);
      } catch (e) {
        logger.warn(`[ClientHandler] Error cleaning up attestation session: ${e}`);
      }

      // Clean up rate limiting tracking (sync, safe)
      this.wsRateLimits.delete(ws);
      this.wsPairRequestRateLimits.delete(ws);

      // Clean up channel state
      this.channelHandler.handleDisconnect(ws);

      // Clean up signaling state (returns pairing code for link handler cleanup)
      const pairingCode = this.signalingHandler.handleDisconnect(ws);

      // Clean up link requests for the disconnected peer
      if (pairingCode) {
        this.linkHandler.handleDisconnect(pairingCode);
      }

      // Clean up peerId mappings (for relay clients)
      try {
        const peerId = this.wsToClient.get(ws);
        if (peerId) {
          const client = this.clients.get(peerId);
          if (client && client.ws === ws) {
            this.relayRegistry.unregister(peerId);
            await this.distributedRendezvous.unregisterPeer(peerId);

            if (this.chunkRelay) {
              await this.chunkRelay.unregisterPeer(peerId);
            }

            this.clients.delete(peerId);

            this.emit('client-disconnected', peerId);
          }
        }
        this.wsToClient.delete(ws);
      } catch (e) {
        logger.warn(`[ClientHandler] Error cleaning up peerId mappings: ${e}`);
      }
    } catch (e) {
      logger.error('[ClientHandler] Unexpected error in handleDisconnect:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  notifyClient(peerId: string, message: object): boolean {
    const client = this.clients.get(peerId);
    if (client) return this.send(client.ws, message);

    const signalingWs = this.signalingHandler.getPairingCodeWs(peerId);
    if (signalingWs) return this.send(signalingWs, message);

    return false;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  getClient(peerId: string): ClientInfo | undefined {
    return this.clients.get(peerId);
  }

  private send(ws: WebSocket, message: object): boolean {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
        return true;
      }
    } catch (e) {
      console.error('[ClientHandler] Failed to send message:', e);
    }
    return false;
  }

  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, {
      type: 'error',
      message,
    });
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async cleanup(): Promise<number> {
    const now = Date.now();
    const stale: string[] = [];

    for (const [peerId, client] of this.clients) {
      if (now - client.lastSeen > this.config.heartbeatTimeout) {
        stale.push(peerId);
      }
    }

    for (const peerId of stale) {
      const client = this.clients.get(peerId);
      if (client) {
        await this.handleDisconnect(client.ws);
        client.ws.close(1000, 'Heartbeat timeout');
      }
    }

    // Clean up stale rate limiter entries (Issue #4)
    const STALE_THRESHOLD = 5 * 60 * 1000;
    for (const [ws, rateLimitInfo] of this.wsRateLimits) {
      if (now - rateLimitInfo.windowStart > STALE_THRESHOLD) {
        this.wsRateLimits.delete(ws);
      }
    }
    for (const [ws, rateLimitInfo] of this.wsPairRequestRateLimits) {
      if (now - rateLimitInfo.windowStart > STALE_THRESHOLD) {
        this.wsPairRequestRateLimits.delete(ws);
      }
    }

    this.channelHandler.cleanupExpiredQueues();

    return stale.length;
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.wsRateLimits.clear();
    this.wsPairRequestRateLimits.clear();

    this.signalingHandler.shutdown();
    this.linkHandler.shutdown();
    this.channelHandler.shutdown();

    if (this.chunkRelay) {
      this.chunkRelay.shutdown();
    }

    if (this.attestationManager) {
      this.attestationManager.shutdown();
    }
    this.wsToConnectionId.clear();

    for (const [, client] of this.clients) {
      try {
        client.ws.close(1001, 'Server shutting down');
      } catch {
        // Intentionally ignored: WebSocket may already be closed or in invalid state
        // during shutdown. Best-effort cleanup is acceptable here.
      }
    }
    this.clients.clear();
    this.wsToClient.clear();
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get signalingClientCount(): number {
    return this.signalingHandler.clientCount;
  }

  getEntropyMetrics(): EntropyMetrics {
    return this.signalingHandler.getEntropyMetrics();
  }

  getAttestationManager(): AttestationManager | null {
    return this.attestationManager;
  }

  getChunkRelay(): ChunkRelay | null {
    return this.chunkRelay;
  }
}
