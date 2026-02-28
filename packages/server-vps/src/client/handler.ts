/**
 * Client WebSocket Handler
 *
 * Handles WebSocket messages from Zajel peers/clients.
 * Routes messages to appropriate registries with federation awareness.
 * Provides redirect information when requests belong to other servers.
 */

import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import type { ServerIdentity, ServerMetadata } from '../types.js';
import { RelayRegistry } from '../registry/relay-registry.js';
import { DistributedRendezvous, type PartialResult } from '../registry/distributed-rendezvous.js';
import type { DeadDropResult, LiveMatchResult } from '../registry/rendezvous-registry.js';
import { logger } from '../utils/logger.js';

import { WEBSOCKET, RATE_LIMIT, PAIRING, ATTESTATION, RENDEZVOUS_LIMITS, CHUNK_LIMITS, PEER_ID, RELAY } from '../constants.js';
import { ChunkRelay } from './chunk-relay.js';
import { ChannelHandler } from './channel-handler.js';
import { SignalingHandler } from './signaling-handler.js';
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
  private channelHandler: ChannelHandler;

  // Chunk relay service (optional - only initialized when storage is provided)
  private chunkRelay: ChunkRelay | null = null;

  // Attestation manager (optional - only initialized when attestation config is provided)
  private attestationManager: AttestationManager | null = null;
  // WebSocket -> attestation connection ID mapping
  private wsToConnectionId: Map<WebSocket, string> = new Map();

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

    // Initialize signaling handler
    this.signalingHandler = new SignalingHandler({
      send: (ws, message) => this.send(ws, message),
      sendError: (ws, message) => this.sendError(ws, message),
      getServerId: () => this.identity.serverId,
      getPairingCodeRedirects: (code) => this.getPairingCodeRedirects(code),
      pairRequestTimeout: config.pairRequestTimeout ?? PAIRING.DEFAULT_REQUEST_TIMEOUT,
      pairRequestWarningTime: config.pairRequestWarningTime ?? PAIRING.DEFAULT_REQUEST_WARNING_TIME,
    });

    // Initialize channel handler
    this.channelHandler = new ChannelHandler({
      send: (ws, message) => this.send(ws, message),
      sendError: (ws, message) => this.sendError(ws, message),
      chunkRelay: this.chunkRelay,
    });

    // Initialize attestation manager if config is provided
    if (attestationConfig) {
      this.attestationManager = new AttestationManager(attestationConfig);
    }

    // Store federation reference for DHT redirect lookups
    if (federation) {
      this.federation = federation;
    }

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
      // First message from this connection
      rateLimitInfo = { messageCount: 1, windowStart: now };
      this.wsRateLimits.set(ws, rateLimitInfo);
      return true;
    }

    // Check if we're in a new window
    if (now - rateLimitInfo.windowStart >= RATE_LIMIT.WINDOW_MS) {
      // Reset the window
      rateLimitInfo.messageCount = 1;
      rateLimitInfo.windowStart = now;
      return true;
    }

    // Increment message count
    rateLimitInfo.messageCount++;

    // Check if over limit
    if (rateLimitInfo.messageCount > RATE_LIMIT.MAX_MESSAGES) {
      return false;
    }

    return true;
  }

  /**
   * Check and update pair request rate limit for a WebSocket connection
   * Returns true if the pair request should be allowed, false if rate limited
   */
  private checkPairRequestRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    let rateLimitInfo = this.wsPairRequestRateLimits.get(ws);

    if (!rateLimitInfo) {
      // First pair request from this connection
      rateLimitInfo = { requestCount: 1, windowStart: now };
      this.wsPairRequestRateLimits.set(ws, rateLimitInfo);
      return true;
    }

    // Check if we're in a new window
    if (now - rateLimitInfo.windowStart >= RATE_LIMIT.WINDOW_MS) {
      // Reset the window
      rateLimitInfo.requestCount = 1;
      rateLimitInfo.windowStart = now;
      return true;
    }

    // Increment request count
    rateLimitInfo.requestCount++;

    // Check if over limit
    if (rateLimitInfo.requestCount > RATE_LIMIT.MAX_PAIR_REQUESTS) {
      return false;
    }

    return true;
  }

  /**
   * Handle incoming WebSocket message
   */
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
        // Unknown types handled by the switch default case in handleMessage
        break;
    }
    return null;
  }

  async handleMessage(ws: WebSocket, data: string): Promise<void> {
    // Size validation (defense in depth - primary limit is at WebSocket level)
    // This catches any messages that slip through or are used in testing
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
    // If the WebSocket is bound to a peerId (relay client), enforce that subsequent
    // messages use the same peerId. This prevents identity spoofing across messages.
    if ('peerId' in message && message.type !== 'register') {
      const boundPeerId = this.wsToClient.get(ws);
      if (boundPeerId) {
        if ((message as { peerId: string }).peerId !== boundPeerId) {
          this.sendError(ws, 'peerId mismatch with registered identity');
          return;
        }
        // Override with bound peerId to prevent spoofing
        (message as { peerId: string }).peerId = boundPeerId;
      }
    }

    try {
      switch (message.type) {
        case 'register':
          // Check if this is a pairing code registration or a peerId registration
          if ('pairingCode' in message) {
            this.signalingHandler.handlePairingCodeRegister(ws, message as SignalingRegisterMessage);
          } else {
            await this.handleRegister(ws, message);
          }
          break;

        case 'pair_request':
          // Apply stricter rate limit for expensive pair_request operations
          if (!this.checkPairRequestRateLimit(ws)) {
            this.sendError(ws, 'Too many pair requests. Please slow down.');
            return;
          }
          this.signalingHandler.handlePairRequest(ws, message as PairRequestMessage);
          break;

        case 'pair_response':
          this.signalingHandler.handlePairResponse(ws, message as PairResponseMessage);
          break;

        case 'offer':
          this.signalingHandler.handleSignalingForward(ws, message as SignalingOfferMessage);
          break;

        case 'answer':
          this.signalingHandler.handleSignalingForward(ws, message as SignalingAnswerMessage);
          break;

        case 'ice_candidate':
          this.signalingHandler.handleSignalingForward(ws, message as SignalingIceCandidateMessage);
          break;

        // VoIP call signaling messages - relay to paired peer (delegated to SignalingHandler)
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

        case 'link_request':
          this.signalingHandler.handleLinkRequest(ws, message as LinkRequestMessage);
          break;

        case 'link_response':
          this.signalingHandler.handleLinkResponse(ws, message as LinkResponseMessage);
          break;

        // Channel upstream and streaming messages (delegated to ChannelHandler)
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

        // Chunk relay messages (attestation-gated)
        case 'chunk_announce':
          if (!this.checkAttestation(ws)) return;
          await this.handleChunkAnnounce(ws, message as ChunkAnnounceMessage);
          break;

        case 'chunk_request':
          if (!this.checkAttestation(ws)) return;
          await this.handleChunkRequest(ws, message as ChunkRequestMessage);
          break;

        case 'chunk_push':
          if (!this.checkAttestation(ws)) return;
          await this.handleChunkPush(ws, message as ChunkPushMessage);
          break;

        case 'update_load':
          this.handleUpdateLoad(ws, message);
          break;

        case 'register_rendezvous':
          await this.handleRegisterRendezvous(ws, message);
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

        // Attestation messages
        case 'attest_request':
          await this.handleAttestRequest(ws, message as AttestRequestMessage);
          break;

        case 'attest_response':
          await this.handleAttestResponse(ws, message as AttestResponseMessage);
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

  /**
   * Handle peer registration
   */
  private async handleRegister(ws: WebSocket, message: RegisterMessage): Promise<void> {
    const { peerId, maxConnections = 20, publicKey } = message;

    if (!isValidPeerId(peerId)) {
      this.sendError(ws, 'Invalid peerId: must be 1-128 alphanumeric characters, hyphens, or underscores');
      return;
    }

    // Validate maxConnections
    const maxConn = Number(maxConnections);
    if (!Number.isFinite(maxConn) || maxConn < RELAY.MIN_MAX_CONNECTIONS || maxConn > RELAY.MAX_MAX_CONNECTIONS) {
      this.sendError(ws, `maxConnections must be a finite number between ${RELAY.MIN_MAX_CONNECTIONS} and ${RELAY.MAX_MAX_CONNECTIONS}`);
      return;
    }

    // Check if peerId is already registered by a different WebSocket
    const existingClient = this.clients.get(peerId);
    if (existingClient && existingClient.ws !== ws) {
      this.sendError(ws, 'Peer ID already in use by another connection');
      return;
    }

    // Check if this WebSocket is already registered with a different peerId
    const existingPeerId = this.wsToClient.get(ws);
    if (existingPeerId && existingPeerId !== peerId) {
      this.sendError(ws, 'Cannot re-register with a different peerId');
      return;
    }

    const now = Date.now();

    // Create client info
    const info: ClientInfo = {
      peerId,
      ws,
      connectedAt: now,
      lastSeen: now,
      isRelay: true,
    };

    // Store mappings
    this.clients.set(peerId, info);
    this.wsToClient.set(ws, peerId);

    // Register in relay registry
    this.relayRegistry.register(peerId, {
      maxConnections: maxConn,
      publicKey,
    });

    // Get available relays (excluding self)
    const relays = this.relayRegistry.getAvailableRelays(peerId, 10);

    this.send(ws, {
      type: 'registered',
      peerId,
      serverId: this.identity.serverId,
      relays,
    });

    this.emit('client-connected', info);
  }

  /**
   * Handle load update from a relay peer
   */
  private handleUpdateLoad(ws: WebSocket, message: UpdateLoadMessage): void {
    const { peerId, connectedCount } = message;

    if (!isValidPeerId(peerId)) {
      this.sendError(ws, 'Invalid peerId');
      return;
    }

    const count = Number(connectedCount);
    if (!Number.isFinite(count) || count < 0 || count > RELAY.MAX_CONNECTED_COUNT) {
      this.sendError(ws, 'Invalid connectedCount');
      return;
    }

    // Update client's last seen
    const client = this.clients.get(peerId);
    if (client) {
      client.lastSeen = Date.now();
    }

    this.relayRegistry.updateLoad(peerId, count);

    this.send(ws, {
      type: 'load_updated',
      peerId,
      connectedCount: count,
    });
  }

  /**
   * Handle rendezvous point registration with routing awareness.
   *
   * Supports both legacy format (single deadDrop) and new format (deadDrops map).
   * Also supports both camelCase and snake_case field names for compatibility.
   */
  private async handleRegisterRendezvous(
    ws: WebSocket,
    message: RegisterRendezvousMessage
  ): Promise<void> {
    const { peerId, relayId } = message;

    if (!isValidPeerId(peerId)) {
      this.sendError(ws, 'Invalid peerId');
      return;
    }

    // Support both naming conventions
    const dailyPoints = message.dailyPoints || message.daily_points || [];
    const hourlyTokens = message.hourlyTokens || message.hourly_tokens || [];

    // Validate array sizes
    if (!Array.isArray(dailyPoints) || dailyPoints.length > RENDEZVOUS_LIMITS.MAX_POINTS_PER_MESSAGE) {
      this.sendError(ws, `Too many daily points (max ${RENDEZVOUS_LIMITS.MAX_POINTS_PER_MESSAGE})`);
      return;
    }
    if (!Array.isArray(hourlyTokens) || hourlyTokens.length > RENDEZVOUS_LIMITS.MAX_TOKENS_PER_MESSAGE) {
      this.sendError(ws, `Too many hourly tokens (max ${RENDEZVOUS_LIMITS.MAX_TOKENS_PER_MESSAGE})`);
      return;
    }

    // Validate array element types and lengths
    if (!dailyPoints.every(p => typeof p === 'string' && p.length <= RENDEZVOUS_LIMITS.MAX_HASH_LENGTH)) {
      this.sendError(ws, 'Invalid daily points format');
      return;
    }
    if (!hourlyTokens.every(t => typeof t === 'string' && t.length <= RENDEZVOUS_LIMITS.MAX_HASH_LENGTH)) {
      this.sendError(ws, 'Invalid hourly tokens format');
      return;
    }

    // Validate relayId field size
    if (relayId && (typeof relayId !== 'string' || relayId.length > RENDEZVOUS_LIMITS.MAX_RELAY_ID_LENGTH)) {
      this.sendError(ws, 'Invalid relayId');
      return;
    }

    // Support both single dead drop (legacy) and map (new format)
    // Priority: dead_drops > deadDrops > deadDrop (legacy)
    const deadDropsMap: Record<string, string> =
      message.dead_drops || message.deadDrops || {};
    const legacyDeadDrop = message.deadDrop || '';

    // Validate dead drops map size and values
    if (Object.keys(deadDropsMap).length > RENDEZVOUS_LIMITS.MAX_POINTS_PER_MESSAGE) {
      this.sendError(ws, 'Too many dead drops');
      return;
    }
    for (const [key, value] of Object.entries(deadDropsMap)) {
      if (typeof key !== 'string' || key.length > RENDEZVOUS_LIMITS.MAX_HASH_LENGTH) {
        this.sendError(ws, 'Invalid dead drop key');
        return;
      }
      if (typeof value !== 'string' || value.length > RENDEZVOUS_LIMITS.MAX_DEAD_DROP_SIZE) {
        this.sendError(ws, 'Dead drop payload too large (max 4KB)');
        return;
      }
    }

    // Validate legacy dead drop size
    if (legacyDeadDrop && (typeof legacyDeadDrop !== 'string' || legacyDeadDrop.length > RENDEZVOUS_LIMITS.MAX_DEAD_DROP_SIZE)) {
      this.sendError(ws, 'Dead drop payload too large (max 4KB)');
      return;
    }

    // Update client's last seen
    const client = this.clients.get(peerId);
    if (client) {
      client.lastSeen = Date.now();
    }

    // Aggregate dead drops results
    const allDeadDrops: DeadDropResult[] = [];
    const allDailyRedirects: Array<{ serverId: string; endpoint: string; items: string[] }> = [];

    // If we have per-point dead drops, register each point with its specific dead drop
    const hasPerPointDeadDrops = Object.keys(deadDropsMap).length > 0;

    if (hasPerPointDeadDrops) {
      // Group points by whether they have a dead drop
      const pointsWithDeadDrop: string[] = [];
      const pointsWithoutDeadDrop: string[] = [];

      for (const point of dailyPoints) {
        if (deadDropsMap[point]) {
          pointsWithDeadDrop.push(point);
        } else {
          pointsWithoutDeadDrop.push(point);
        }
      }

      // Register points that have dead drops - each with its own dead drop
      for (const point of pointsWithDeadDrop) {
        const deadDrop = deadDropsMap[point]!;
        const result = await this.distributedRendezvous.registerDailyPoints(peerId, {
          points: [point],
          deadDrop,
          relayId,
        });
        allDeadDrops.push(...result.local.deadDrops);
        allDailyRedirects.push(...result.redirects);
      }

      // Register points without dead drops (if any)
      if (pointsWithoutDeadDrop.length > 0) {
        const result = await this.distributedRendezvous.registerDailyPoints(peerId, {
          points: pointsWithoutDeadDrop,
          deadDrop: '', // No dead drop for these points
          relayId,
        });
        allDeadDrops.push(...result.local.deadDrops);
        allDailyRedirects.push(...result.redirects);
      }
    } else {
      // Legacy mode: single dead drop for all points
      const dailyResult = await this.distributedRendezvous.registerDailyPoints(peerId, {
        points: dailyPoints,
        deadDrop: legacyDeadDrop,
        relayId,
      });
      allDeadDrops.push(...dailyResult.local.deadDrops);
      allDailyRedirects.push(...dailyResult.redirects);
    }

    // Register hourly tokens (with routing)
    const hourlyResult = await this.distributedRendezvous.registerHourlyTokens(peerId, {
      tokens: hourlyTokens,
      relayId,
    });

    // Check if we need to send redirects
    const hasRedirects = allDailyRedirects.length > 0 || hourlyResult.redirects.length > 0;

    if (hasRedirects) {
      // Send partial result with redirect information
      this.send(ws, {
        type: 'rendezvous_partial',
        local: {
          liveMatches: hourlyResult.local.liveMatches,
          deadDrops: allDeadDrops,
        },
        redirects: this.mergeRedirects(allDailyRedirects, hourlyResult.redirects),
      });
    } else {
      // All points handled locally - send regular result
      this.send(ws, {
        type: 'rendezvous_result',
        liveMatches: hourlyResult.local.liveMatches,
        deadDrops: allDeadDrops,
      });
    }
  }

  /**
   * Handle get relays request
   */
  private handleGetRelays(ws: WebSocket, message: GetRelaysMessage): void {
    const { peerId, count = 10 } = message;

    if (!isValidPeerId(peerId)) {
      this.sendError(ws, 'Invalid peerId');
      return;
    }

    const relays = this.relayRegistry.getAvailableRelays(peerId, count);

    this.send(ws, {
      type: 'relays',
      relays,
    });
  }

  /**
   * Handle heartbeat message
   */
  private handleHeartbeat(ws: WebSocket, message: HeartbeatMessage): void {
    const { peerId } = message;

    if (!isValidPeerId(peerId)) {
      this.sendError(ws, 'Invalid peerId');
      return;
    }

    // Update last seen
    const client = this.clients.get(peerId);
    if (client) {
      client.lastSeen = Date.now();
    }

    // Update relay registry
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
  // Attestation handlers
  // ---------------------------------------------------------------------------

  /**
   * Check if the client is attested or within grace period.
   * If not, send an error and return false.
   * If attestation is not configured, always returns true.
   */
  private checkAttestation(ws: WebSocket): boolean {
    if (!this.attestationManager) return true;

    const connectionId = this.wsToConnectionId.get(ws);
    if (!connectionId) return true; // No attestation session = not tracked

    if (this.attestationManager.isAllowed(connectionId)) {
      return true;
    }

    // Client is not attested and grace period expired
    this.send(ws, {
      type: 'error',
      code: ATTESTATION.ERROR_CODE_NOT_ATTESTED,
      message: 'Attestation required',
    });
    return false;
  }

  /**
   * Handle attest_request: Client sends build_token and device_id.
   * VPS forwards to bootstrap's POST /attest/challenge.
   */
  private async handleAttestRequest(ws: WebSocket, message: AttestRequestMessage): Promise<void> {
    if (!this.attestationManager) {
      this.sendError(ws, 'Attestation not configured');
      return;
    }

    const { build_token, device_id } = message;

    if (!build_token) {
      this.sendError(ws, 'Missing required field: build_token');
      return;
    }

    if (!device_id) {
      this.sendError(ws, 'Missing required field: device_id');
      return;
    }

    const connectionId = this.wsToConnectionId.get(ws);
    if (!connectionId) {
      this.sendError(ws, 'No attestation session');
      return;
    }

    const challenge = await this.attestationManager.requestChallenge(
      connectionId,
      build_token,
      device_id
    );

    if (!challenge) {
      this.send(ws, {
        type: 'attest_error',
        message: 'Failed to get attestation challenge from bootstrap',
      });
      return;
    }

    this.send(ws, {
      type: 'attest_challenge',
      nonce: challenge.nonce,
      regions: challenge.regions,
    });
  }

  /**
   * Handle attest_response: Client sends HMAC responses for the challenge.
   * VPS forwards to bootstrap's POST /attest/verify.
   */
  private async handleAttestResponse(ws: WebSocket, message: AttestResponseMessage): Promise<void> {
    if (!this.attestationManager) {
      this.sendError(ws, 'Attestation not configured');
      return;
    }

    const { nonce, responses } = message;

    if (!nonce) {
      this.sendError(ws, 'Missing required field: nonce');
      return;
    }

    if (!responses || !Array.isArray(responses) || responses.length === 0) {
      this.sendError(ws, 'Missing or empty responses array');
      return;
    }

    const connectionId = this.wsToConnectionId.get(ws);
    if (!connectionId) {
      this.sendError(ws, 'No attestation session');
      return;
    }

    const result = await this.attestationManager.verifyAttestation(
      connectionId,
      nonce,
      responses
    );

    if (result.valid) {
      this.send(ws, {
        type: 'attest_success',
        session_token: result.session_token || null,
      });
    } else {
      this.send(ws, {
        type: 'attest_failed',
        message: 'Attestation verification failed',
      });
      // Disconnect client after attestation failure
      ws.close(ATTESTATION.WS_CLOSE_CODE_ATTESTATION_FAILED, 'Attestation failed');
    }
  }

  /**
   * Get the attestation manager (for testing or external access).
   */
  getAttestationManager(): AttestationManager | null {
    return this.attestationManager;
  }

  // ---------------------------------------------------------------------------
  // Chunk relay handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle chunk_announce: peer announces it has chunks.
   */
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

    // Validate chunk array length
    if (chunks.length > CHUNK_LIMITS.MAX_CHUNKS_PER_ANNOUNCE) {
      this.sendError(ws, `Too many chunks per announce (max ${CHUNK_LIMITS.MAX_CHUNKS_PER_ANNOUNCE})`);
      return;
    }

    // Validate individual chunk entries
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

    // Register the peer as online for chunk relay
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

    // Notify channel subscribers about new chunks so they can request them.
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

  /**
   * Handle chunk_request: peer requests a chunk.
   */
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

    // Identify the requesting peer
    const peerId = this.wsToClient.get(ws) || this.signalingHandler.getWsPairingCode(ws);
    if (!peerId) {
      this.sendError(ws, 'Not registered');
      return;
    }

    // Register this peer as online for relay purposes
    this.chunkRelay.registerPeer(peerId, ws);

    const result = await this.chunkRelay.handleRequest(peerId, ws, chunkId, channelId);

    if (result.error) {
      this.send(ws, {
        type: 'chunk_error',
        chunkId,
        error: result.error,
      });
    } else if (!result.served && result.pulling) {
      // Notify the requester that we're pulling the chunk
      this.send(ws, {
        type: 'chunk_pulling',
        chunkId,
      });
    }
    // If result.served is true, chunk_data was already sent by the relay
  }

  /**
   * Handle chunk_push: peer sends chunk data (response to chunk_pull).
   */
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

    // Identify the pushing peer
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

  /**
   * Get the chunk relay instance (for testing or external access).
   */
  getChunkRelay(): ChunkRelay | null {
    return this.chunkRelay;
  }

  /**
   * Handle WebSocket disconnect
   */
  async handleDisconnect(ws: WebSocket): Promise<void> {
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

      // Clean up channel state (delegated to ChannelHandler)
      this.channelHandler.handleDisconnect(ws);

      // Clean up signaling state (delegated to SignalingHandler)
      this.signalingHandler.handleDisconnect(ws);

      // Clean up peerId mappings (for relay clients)
      try {
        const peerId = this.wsToClient.get(ws);
        if (peerId) {
          // Only clean up if this WebSocket is still the registered one for this peerId
          const client = this.clients.get(peerId);
          if (client && client.ws === ws) {
            // Remove from registries
            this.relayRegistry.unregister(peerId);
            await this.distributedRendezvous.unregisterPeer(peerId);

            // Clean up chunk relay for this peer
            if (this.chunkRelay) {
              await this.chunkRelay.unregisterPeer(peerId);
            }

            // Clean up mappings
            this.clients.delete(peerId);

            this.emit('client-disconnected', peerId);
          }
        }
        // Always clean up the reverse mapping for this WebSocket
        this.wsToClient.delete(ws);
      } catch (e) {
        logger.warn(`[ClientHandler] Error cleaning up peerId mappings: ${e}`);
      }
    } catch (e) {
      // Outer catch: prevents any uncaught error from propagating as unhandled rejection
      logger.error('[ClientHandler] Unexpected error in handleDisconnect:', e);
    }
  }

  /**
   * Notify a specific client
   */
  notifyClient(peerId: string, message: object): boolean {
    // Check relay clients first
    const client = this.clients.get(peerId);
    if (client) return this.send(client.ws, message);

    // Fall back to signaling clients (pairing code registrations)
    const signalingWs = this.signalingHandler.getPairingCodeWs(peerId);
    if (signalingWs) return this.send(signalingWs, message);

    return false;
  }

  /**
   * Get connected client count
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Get client info
   */
  getClient(peerId: string): ClientInfo | undefined {
    return this.clients.get(peerId);
  }

  /**
   * Send a message to a WebSocket
   */
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

  /**
   * Send an error message
   */
  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, {
      type: 'error',
      message,
    });
  }

  /**
   * Merge redirect lists from daily and hourly results
   */
  private mergeRedirects(
    dailyRedirects: Array<{ serverId: string; endpoint: string; items: string[] }>,
    hourlyRedirects: Array<{ serverId: string; endpoint: string; items: string[] }>
  ): Array<{
    serverId: string;
    endpoint: string;
    dailyPoints: string[];
    hourlyTokens: string[];
  }> {
    const merged = new Map<string, {
      serverId: string;
      endpoint: string;
      dailyPoints: string[];
      hourlyTokens: string[];
    }>();

    for (const redirect of dailyRedirects) {
      if (!merged.has(redirect.serverId)) {
        merged.set(redirect.serverId, {
          serverId: redirect.serverId,
          endpoint: redirect.endpoint,
          dailyPoints: [],
          hourlyTokens: [],
        });
      }
      merged.get(redirect.serverId)!.dailyPoints.push(...redirect.items);
    }

    for (const redirect of hourlyRedirects) {
      if (!merged.has(redirect.serverId)) {
        merged.set(redirect.serverId, {
          serverId: redirect.serverId,
          endpoint: redirect.endpoint,
          dailyPoints: [],
          hourlyTokens: [],
        });
      }
      merged.get(redirect.serverId)!.hourlyTokens.push(...redirect.items);
    }

    return Array.from(merged.values());
  }

  /**
   * Cleanup stale clients (based on heartbeat timeout)
   */
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


    // Clean up stale rate limiter entries for signaling clients that may have
    // disconnected without triggering the WebSocket 'close' event (Issue #4)
    const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
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

    // Clean up expired upstream queue entries (delegated to ChannelHandler)
    this.channelHandler.cleanupExpiredQueues();

    return stale.length;
  }

  /**
   * Shutdown - disconnect all clients
   */
  async shutdown(): Promise<void> {
    // Clear rate limiting data
    this.wsRateLimits.clear();
    this.wsPairRequestRateLimits.clear();

    // Shutdown sub-handlers
    this.signalingHandler.shutdown();
    this.channelHandler.shutdown();

    // Shutdown chunk relay
    if (this.chunkRelay) {
      this.chunkRelay.shutdown();
    }

    // Shutdown attestation manager
    if (this.attestationManager) {
      this.attestationManager.shutdown();
    }
    this.wsToConnectionId.clear();

    // Close all relay clients
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

  /**
   * Get signaling client count
   */
  get signalingClientCount(): number {
    return this.signalingHandler.clientCount;
  }

  /**
   * Get entropy metrics for pairing codes (Issue #41)
   */
  getEntropyMetrics(): EntropyMetrics {
    return this.signalingHandler.getEntropyMetrics();
  }
}
