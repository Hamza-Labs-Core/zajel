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

import { WEBSOCKET, CRYPTO, RATE_LIMIT, PAIRING, PAIRING_CODE, ENTROPY, CALL_SIGNALING, ATTESTATION, RENDEZVOUS_LIMITS, CHUNK_LIMITS, PEER_ID, RELAY } from '../constants.js';
import { ChunkRelay } from './chunk-relay.js';
import type { Storage } from '../storage/interface.js';
import { AttestationManager, type AttestationConfig } from '../attestation/attestation-manager.js';
import type { FederationManager } from '../federation/federation-manager.js';

export interface ClientHandlerConfig {
  heartbeatInterval: number;   // Expected heartbeat interval from clients
  heartbeatTimeout: number;    // Time before considering client dead
  maxConnectionsPerPeer: number;
  pairRequestTimeout?: number; // Timeout for pair request approval (default: 120000ms / 2 minutes)
  pairRequestWarningTime?: number; // Time before timeout to send warning (default: 30000ms / 30 seconds)
}

export interface ClientInfo {
  peerId: string;
  ws: WebSocket;
  connectedAt: number;
  lastSeen: number;
  isRelay: boolean;
}

export interface ClientHandlerEvents {
  'client-connected': (info: ClientInfo) => void;
  'client-disconnected': (peerId: string) => void;
  'message-error': (peerId: string | null, error: Error) => void;
}

// Message types from clients
interface RegisterMessage {
  type: 'register';
  peerId: string;
  maxConnections?: number;
  publicKey?: string;
}

interface UpdateLoadMessage {
  type: 'update_load';
  peerId: string;
  connectedCount: number;
}

interface RegisterRendezvousMessage {
  type: 'register_rendezvous';
  peerId: string;
  // Support both naming conventions for backward compatibility
  dailyPoints?: string[];
  daily_points?: string[];
  hourlyTokens?: string[];
  hourly_tokens?: string[];
  // Support both single dead drop (legacy) and map (new)
  deadDrop?: string;
  deadDrops?: Record<string, string>;  // point -> encrypted payload
  dead_drops?: Record<string, string>; // snake_case variant
  relayId: string;
}

interface GetRelaysMessage {
  type: 'get_relays';
  peerId: string;
  count?: number;
}

interface HeartbeatMessage {
  type: 'heartbeat';
  peerId: string;
}

interface PingMessage {
  type: 'ping';
}

// WebRTC signaling messages (for pairing code-based connections)
interface SignalingRegisterMessage {
  type: 'register';
  pairingCode: string;
  publicKey: string;  // Public key for E2E encryption
}

interface PairRequestMessage {
  type: 'pair_request';
  targetCode: string;
  proposedName?: string;
}

interface PairResponseMessage {
  type: 'pair_response';
  targetCode: string;
  accepted: boolean;
}

interface SignalingOfferMessage {
  type: 'offer';
  target: string;  // Target pairing code
  payload: Record<string, unknown>;
}

interface SignalingAnswerMessage {
  type: 'answer';
  target: string;
  payload: Record<string, unknown>;
}

interface SignalingIceCandidateMessage {
  type: 'ice_candidate';
  target: string;
  payload: Record<string, unknown>;
}

// VoIP call signaling messages
interface CallOfferMessage {
  type: 'call_offer';
  target: string;
  payload: Record<string, unknown>;
}

interface CallAnswerMessage {
  type: 'call_answer';
  target: string;
  payload: Record<string, unknown>;
}

interface CallRejectMessage {
  type: 'call_reject';
  target: string;
  payload: Record<string, unknown>;
}

interface CallHangupMessage {
  type: 'call_hangup';
  target: string;
  payload: Record<string, unknown>;
}

interface CallIceMessage {
  type: 'call_ice';
  target: string;
  payload: Record<string, unknown>;
}

// Device linking messages (web client linking to mobile app)
interface LinkRequestMessage {
  type: 'link_request';
  linkCode: string;      // The link code from the mobile app's QR
  publicKey: string;     // Web client's public key
  deviceName?: string;   // Browser name (e.g., "Chrome on Windows")
}

interface LinkResponseMessage {
  type: 'link_response';
  linkCode: string;
  accepted: boolean;
  deviceId?: string;     // Assigned device ID if accepted
}

// Channel upstream message (subscriber -> VPS -> owner)
interface UpstreamMessageData {
  type: 'upstream-message';
  channelId: string;
  message: Record<string, unknown>;
  ephemeralPublicKey: string;
}

// Channel stream messages
interface StreamStartMessage {
  type: 'stream-start';
  streamId: string;
  channelId: string;
  title: string;
}

interface StreamFrameMessage {
  type: 'stream-frame';
  streamId: string;
  channelId: string;
  frame: Record<string, unknown>;
}

interface StreamEndMessage {
  type: 'stream-end';
  streamId: string;
  channelId: string;
}

// Channel subscription registration (subscriber registers interest)
interface ChannelSubscribeMessage {
  type: 'channel-subscribe';
  channelId: string;
}

// Channel owner registration (owner registers as the owner)
interface ChannelOwnerRegisterMessage {
  type: 'channel-owner-register';
  channelId: string;
}

// Chunk relay messages
interface ChunkAnnounceMessage {
  type: 'chunk_announce';
  peerId: string;
  channelId?: string;
  chunks: Array<{ chunkId: string; routingHash?: string }>;
}

interface ChunkRequestMessage {
  type: 'chunk_request';
  chunkId: string;
  channelId: string;
}

interface ChunkPushMessage {
  type: 'chunk_push';
  chunkId: string;
  channelId: string;
  data: string | Record<string, unknown>; // JSON object (from client) or string (legacy)
}

// Attestation messages
interface AttestRequestMessage {
  type: 'attest_request';
  build_token: string;
  device_id: string;
}

interface AttestResponseMessage {
  type: 'attest_response';
  nonce: string;
  responses: Array<{ region_index: number; hmac: string }>;
}

// Pending pair request tracking
interface PendingPairRequest {
  requesterCode: string;
  requesterPublicKey: string;
  targetCode: string;
  timestamp: number;
}

// Rate limiting tracking per WebSocket connection
interface RateLimitInfo {
  messageCount: number;
  windowStart: number;
}

// Pair request rate limiting tracking per WebSocket connection
interface PairRequestRateLimitInfo {
  requestCount: number;
  windowStart: number;
}

// Entropy metrics for pairing code monitoring (Issue #41)
interface EntropyMetrics {
  activeCodes: number;
  peakActiveCodes: number;
  totalRegistrations: number;
  collisionAttempts: number;
  collisionRisk: 'low' | 'medium' | 'high';
}

type ClientMessage =
  | RegisterMessage
  | UpdateLoadMessage
  | RegisterRendezvousMessage
  | GetRelaysMessage
  | HeartbeatMessage
  | PingMessage
  | SignalingRegisterMessage
  | PairRequestMessage
  | PairResponseMessage
  | SignalingOfferMessage
  | SignalingAnswerMessage
  | SignalingIceCandidateMessage
  | CallOfferMessage
  | CallAnswerMessage
  | CallRejectMessage
  | CallHangupMessage
  | CallIceMessage
  | LinkRequestMessage
  | LinkResponseMessage
  | UpstreamMessageData
  | StreamStartMessage
  | StreamFrameMessage
  | StreamEndMessage
  | ChannelSubscribeMessage
  | ChannelOwnerRegisterMessage
  | ChunkAnnounceMessage
  | ChunkRequestMessage
  | ChunkPushMessage
  | AttestRequestMessage
  | AttestResponseMessage;

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
  // Pairing code-based client tracking for WebRTC signaling
  private pairingCodeToWs: Map<string, WebSocket> = new Map();
  private wsToPairingCode: Map<WebSocket, string> = new Map();
  private pairingCodeToPublicKey: Map<string, string> = new Map();
  // Pending pair requests: targetCode -> list of pending requests
  private pendingPairRequests: Map<string, PendingPairRequest[]> = new Map();
  // Default timeout: 120 seconds (2 minutes) to allow for fingerprint verification
  // Default warning time: 30 seconds before timeout

  // Pending device link requests: linkCode -> request info
  private pendingLinkRequests: Map<string, {
    webClientCode: string;   // The web client's pairing code
    webPublicKey: string;    // The web client's public key
    deviceName: string;      // Browser name
    timestamp: number;
  }> = new Map();

  // Timer references for link request expiration (Issue #9: Memory leak fix)
  // Key: linkCode
  private linkRequestTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Configurable timeout values (set in constructor from config)
  private readonly pairRequestTimeout: number;
  private readonly pairRequestWarningTime: number;

  // Timer references for pair request expiration (to prevent memory leaks)
  // Key: "requesterCode:targetCode"
  private pairRequestTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Timer references for pair request warnings (sent before timeout)
  // Key: "requesterCode:targetCode"
  private pairRequestWarningTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Rate limiting
  private wsRateLimits: Map<WebSocket, RateLimitInfo> = new Map();
  // Pair request rate limiting (stricter limit for expensive operations)
  private wsPairRequestRateLimits: Map<WebSocket, PairRequestRateLimitInfo> = new Map();

  // Entropy monitoring thresholds (Issue #41)
  // Based on birthday paradox analysis: collision risk increases at ~33k active codes

  // Entropy metrics tracking
  private entropyMetrics = {
    peakActiveCodes: 0,
    totalRegistrations: 0,
    collisionAttempts: 0,
  };

  // Channel owner tracking: channelId -> WebSocket of the owner
  private channelOwners: Map<string, WebSocket> = new Map();
  // Channel subscriber tracking: channelId -> Set of subscriber WebSockets
  private channelSubscribers: Map<string, Set<WebSocket>> = new Map();
  // Active stream tracking: channelId -> stream metadata
  private activeStreams: Map<string, { streamId: string; title: string; ownerWs: WebSocket }> = new Map();
  // Upstream rate limiting per WebSocket: ws -> { count, windowStart }
  private upstreamRateLimits: Map<WebSocket, RateLimitInfo> = new Map();
  // Upstream message queue for offline owners: channelId -> queued messages
  private upstreamQueues: Map<string, Array<{ data: object; timestamp: number }>> = new Map();

  // Chunk relay service (optional - only initialized when storage is provided)
  private chunkRelay: ChunkRelay | null = null;
  // Maximum queued upstream messages per channel
  private static readonly MAX_UPSTREAM_QUEUE_SIZE = 100;
  // Upstream rate limit: max messages per window
  private static readonly MAX_UPSTREAM_PER_WINDOW = 30;

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

    // Initialize configurable timeout values
    this.pairRequestTimeout = config.pairRequestTimeout ?? PAIRING.DEFAULT_REQUEST_TIMEOUT;
    this.pairRequestWarningTime = config.pairRequestWarningTime ?? PAIRING.DEFAULT_REQUEST_WARNING_TIME;

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

    // Forward match notifications to clients
    this.distributedRendezvous.on('match', (peerId, match) => {
      this.notifyClient(peerId, {
        type: 'rendezvous_match',
        match,
      });
    });
  }

  /**
   * Clear a pair request timer and remove it from the map
   */
  private clearPairRequestTimer(timerKey: string): void {
    const timer = this.pairRequestTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.pairRequestTimers.delete(timerKey);
    }
  }

  /**
   * Clear a pair request warning timer and remove it from the map
   */
  private clearPairRequestWarningTimer(timerKey: string): void {
    const timer = this.pairRequestWarningTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.pairRequestWarningTimers.delete(timerKey);
    }
  }

  /**
   * Clear both pair request and warning timers for a given key
   */
  private clearPairRequestTimers(timerKey: string): void {
    this.clearPairRequestTimer(timerKey);
    this.clearPairRequestWarningTimer(timerKey);
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
            this.handlePairingCodeRegister(ws, message as SignalingRegisterMessage);
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
          this.handlePairRequest(ws, message as PairRequestMessage);
          break;

        case 'pair_response':
          this.handlePairResponse(ws, message as PairResponseMessage);
          break;

        case 'offer':
          this.handleSignalingForward(ws, message as SignalingOfferMessage);
          break;

        case 'answer':
          this.handleSignalingForward(ws, message as SignalingAnswerMessage);
          break;

        case 'ice_candidate':
          this.handleSignalingForward(ws, message as SignalingIceCandidateMessage);
          break;

        // VoIP call signaling messages - relay to paired peer
        case 'call_offer':
          this.handleCallSignalingForward(ws, message as CallOfferMessage);
          break;

        case 'call_answer':
          this.handleCallSignalingForward(ws, message as CallAnswerMessage);
          break;

        case 'call_reject':
          this.handleCallSignalingForward(ws, message as CallRejectMessage);
          break;

        case 'call_hangup':
          this.handleCallSignalingForward(ws, message as CallHangupMessage);
          break;

        case 'call_ice':
          this.handleCallSignalingForward(ws, message as CallIceMessage);
          break;

        case 'link_request':
          this.handleLinkRequest(ws, message as LinkRequestMessage);
          break;

        case 'link_response':
          this.handleLinkResponse(ws, message as LinkResponseMessage);
          break;

        // Channel upstream and streaming messages
        case 'upstream-message':
          this.handleUpstreamMessage(ws, message as UpstreamMessageData);
          break;

        case 'stream-start':
          this.handleStreamStart(ws, message as StreamStartMessage);
          break;

        case 'stream-frame':
          this.handleStreamFrame(ws, message as StreamFrameMessage);
          break;

        case 'stream-end':
          this.handleStreamEnd(ws, message as StreamEndMessage);
          break;

        case 'channel-subscribe':
          await this.handleChannelSubscribe(ws, message as ChannelSubscribeMessage);
          break;

        case 'channel-owner-register':
          this.handleChannelOwnerRegister(ws, message as ChannelOwnerRegisterMessage);
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

  /**
   * Handle pairing code registration (for WebRTC signaling)
   */
  private handlePairingCodeRegister(ws: WebSocket, message: SignalingRegisterMessage): void {
    const { pairingCode, publicKey } = message;

    if (!pairingCode) {
      this.sendError(ws, 'Missing required field: pairingCode');
      return;
    }

    // Validate pairing code format (Issue #17)
    if (!PAIRING_CODE.REGEX.test(pairingCode)) {
      this.sendError(ws, 'Invalid pairing code format');
      return;
    }

    if (!publicKey) {
      this.sendError(ws, 'Missing required field: publicKey');
      return;
    }

    // Validate public key format (must be valid base64)
    if (!/^[A-Za-z0-9+/]+=*$/.test(publicKey)) {
      this.sendError(ws, 'Invalid public key format');
      return;
    }

    // Validate public key length (X25519 keys are 32 bytes)
    try {
      const decoded = Buffer.from(publicKey, 'base64');
      if (decoded.length !== CRYPTO.X25519_KEY_SIZE) {
        this.sendError(ws, 'Invalid public key length');
        return;
      }
    } catch (error) {
      // Base64 decoding failed - log for debugging, send generic error to client
      console.warn('[ClientHandler] Invalid public key base64 encoding:', error);
      this.sendError(ws, 'Invalid public key encoding');
      return;
    }

    // Issue #41: Collision detection
    // Check if pairing code already exists (collision)
    if (this.pairingCodeToWs.has(pairingCode)) {
      this.entropyMetrics.collisionAttempts++;
      logger.warn(`Pairing code collision detected: ${logger.pairingCode(pairingCode)} (total collisions: ${this.entropyMetrics.collisionAttempts})`);

      // Notify client to regenerate code and reconnect
      this.send(ws, {
        type: 'code_collision',
        message: 'Pairing code already in use. Please reconnect with a new code.',
      });
      return;
    }

    // Store pairing code -> WebSocket and public key mappings
    this.pairingCodeToWs.set(pairingCode, ws);
    this.wsToPairingCode.set(ws, pairingCode);
    this.pairingCodeToPublicKey.set(pairingCode, publicKey);

    // Issue #41: Update entropy metrics
    this.entropyMetrics.totalRegistrations++;
    const currentActiveCount = this.pairingCodeToWs.size;

    // Track peak active codes
    if (currentActiveCount > this.entropyMetrics.peakActiveCodes) {
      this.entropyMetrics.peakActiveCodes = currentActiveCount;
    }

    // Log warnings at threshold crossings
    if (currentActiveCount === ENTROPY.COLLISION_HIGH_THRESHOLD) {
      logger.warn(`HIGH collision risk: ${currentActiveCount} active codes - consider extending code length`);
    } else if (currentActiveCount === ENTROPY.COLLISION_MEDIUM_THRESHOLD) {
      logger.warn(`MEDIUM collision risk: ${currentActiveCount} active codes - monitor closely`);
    } else if (currentActiveCount === ENTROPY.COLLISION_LOW_THRESHOLD) {
      logger.info(`Approaching collision threshold: ${currentActiveCount} active codes`);
    }

    logger.pairingEvent('registered', { code: pairingCode, activeCodes: currentActiveCount });

    // Compute DHT redirects: other servers that should also know about this code
    const redirects = this.getPairingCodeRedirects(pairingCode);

    // Send confirmation with optional redirects for cross-server pairing
    this.send(ws, {
      type: 'registered',
      pairingCode,
      serverId: this.identity.serverId,
      ...(redirects.length > 0 ? { redirects } : {}),
    });
  }

  /**
   * Handle pair request (mutual approval flow)
   */
  private handlePairRequest(ws: WebSocket, message: PairRequestMessage): void {
    const { targetCode, proposedName } = message;
    const requesterCode = this.wsToPairingCode.get(ws);

    if (!requesterCode) {
      this.sendError(ws, 'Not registered. Send register message first.');
      return;
    }

    if (!targetCode) {
      this.sendError(ws, 'Missing required field: targetCode');
      return;
    }

    // Validate target code format (Issue #17)
    if (!PAIRING_CODE.REGEX.test(targetCode)) {
      this.sendError(ws, 'Invalid target code format');
      return;
    }

    if (targetCode === requesterCode) {
      // Use generic error to prevent enumeration attacks
      this.send(ws, {
        type: 'pair_error',
        error: 'Pair request could not be processed',
      });
      return;
    }

    const targetWs = this.pairingCodeToWs.get(targetCode);

    if (!targetWs) {
      // Target not found locally — with DHT redirects, the client should have
      // registered on all responsible servers. If it's not here, it's not available.
      // SECURITY: Use generic error message to prevent enumeration attacks
      this.send(ws, {
        type: 'pair_error',
        error: 'Pair request could not be processed',
      });
      return;
    }

    const requesterPublicKey = this.pairingCodeToPublicKey.get(requesterCode);
    if (!requesterPublicKey) {
      // Use generic error to prevent information leakage
      this.send(ws, {
        type: 'pair_error',
        error: 'Pair request could not be processed',
      });
      return;
    }

    this.processPairRequest(requesterCode, requesterPublicKey, targetCode, targetWs, proposedName);
  }

  /**
   * Process a pair request (used for both local and cross-server requests).
   * The target must be a local WebSocket connection.
   */
  private processPairRequest(
    requesterCode: string,
    requesterPublicKey: string,
    targetCode: string,
    targetWs: WebSocket,
    proposedName?: string
  ): void {
    // Check for DoS: limit pending requests per target
    const pending = this.pendingPairRequests.get(targetCode) || [];

    // Remove any existing request from the same requester (in-place modification)
    const existingIndex = pending.findIndex(r => r.requesterCode === requesterCode);
    if (existingIndex !== -1) {
      // Clear the existing timers for this request
      const timerKey = `${requesterCode}:${targetCode}`;
      this.clearPairRequestTimers(timerKey);
      pending.splice(existingIndex, 1);
    }

    // SECURITY: Limit pending requests per target to prevent DoS
    if (pending.length >= PAIRING.MAX_PENDING_REQUESTS_PER_TARGET) {
      const requesterWs = this.pairingCodeToWs.get(requesterCode);
      if (requesterWs) {
        this.send(requesterWs, {
          type: 'pair_error',
          error: 'Pair request could not be processed',
        });
      }
      return;
    }

    // Create pending pair request
    const request: PendingPairRequest = {
      requesterCode,
      requesterPublicKey,
      targetCode,
      timestamp: Date.now(),
    };

    // Store pending request
    pending.push(request);
    this.pendingPairRequests.set(targetCode, pending);

    // Notify target about incoming pair request (include timeout for UI countdown)
    this.send(targetWs, {
      type: 'pair_incoming',
      fromCode: requesterCode,
      fromPublicKey: requesterPublicKey,
      expiresIn: this.pairRequestTimeout, // Include timeout for client-side countdown
      ...(proposedName ? { proposedName } : {}),
    });

    logger.pairingEvent('request', { requester: requesterCode, target: targetCode });

    // Set timeout for this request and store the timer reference
    const timerKey = `${requesterCode}:${targetCode}`;
    const timer = setTimeout(() => {
      this.expirePairRequest(requesterCode, targetCode);
      // Clean up both timers
      this.clearPairRequestTimers(timerKey);
    }, this.pairRequestTimeout);
    this.pairRequestTimers.set(timerKey, timer);

    // Set warning timer (fires before timeout to warn users)
    // Only set if warning time is less than total timeout
    if (this.pairRequestWarningTime < this.pairRequestTimeout) {
      const warningDelay = this.pairRequestTimeout - this.pairRequestWarningTime;
      const warningTimer = setTimeout(() => {
        this.sendPairExpiringWarning(requesterCode, targetCode);
        this.pairRequestWarningTimers.delete(timerKey);
      }, warningDelay);
      this.pairRequestWarningTimers.set(timerKey, warningTimer);
    }
  }

  /**
   * Send warning to both peers that the pair request is about to expire
   */
  private sendPairExpiringWarning(requesterCode: string, targetCode: string): void {
    const remainingSeconds = Math.ceil(this.pairRequestWarningTime / 1000);

    // Warn the requester (who is waiting for approval)
    const requesterWs = this.pairingCodeToWs.get(requesterCode);
    if (requesterWs) {
      this.send(requesterWs, {
        type: 'pair_expiring',
        peerCode: targetCode,
        remainingSeconds,
      });
    }

    // Warn the target (who needs to approve)
    const targetWs = this.pairingCodeToWs.get(targetCode);
    if (targetWs) {
      this.send(targetWs, {
        type: 'pair_expiring',
        peerCode: requesterCode,
        remainingSeconds,
      });
    }

    logger.debug(`[Pairing] expiring warning`, { remainingSeconds });
  }

  /**
   * Handle pair response (accept/reject)
   */
  private handlePairResponse(ws: WebSocket, message: PairResponseMessage): void {
    const { targetCode, accepted } = message;
    const responderCode = this.wsToPairingCode.get(ws);

    if (!responderCode) {
      this.sendError(ws, 'Not registered. Send register message first.');
      return;
    }

    // Validate target code format (Issue #17)
    if (!targetCode || !PAIRING_CODE.REGEX.test(targetCode)) {
      this.sendError(ws, 'Invalid target code format');
      return;
    }

    // Find the pending request
    const pending = this.pendingPairRequests.get(responderCode) || [];
    const requestIndex = pending.findIndex(r => r.requesterCode === targetCode);

    if (requestIndex === -1) {
      this.send(ws, {
        type: 'pair_error',
        error: 'No pending request from this peer',
      });
      return;
    }

    // Get the request with explicit undefined check for safety
    const request = pending[requestIndex];
    if (!request) {
      this.send(ws, {
        type: 'pair_error',
        error: 'Request not found',
      });
      return;
    }

    // Clear the timers for this request
    const timerKey = `${targetCode}:${responderCode}`;
    this.clearPairRequestTimers(timerKey);

    // Remove the request from pending
    pending.splice(requestIndex, 1);
    if (pending.length === 0) {
      this.pendingPairRequests.delete(responderCode);
    } else {
      this.pendingPairRequests.set(responderCode, pending);
    }

    if (accepted) {
      // Get responder's public key
      const responderPublicKey = this.pairingCodeToPublicKey.get(responderCode);
      if (!responderPublicKey) {
        this.sendError(ws, 'Public key not found');
        return;
      }

      // Notify both peers about the match
      // The requester is the initiator (creates WebRTC offer)
      const requesterWs = this.pairingCodeToWs.get(targetCode);
      if (requesterWs) {
        this.send(requesterWs, {
          type: 'pair_matched',
          peerCode: responderCode,
          peerPublicKey: responderPublicKey,
          isInitiator: true,
        });
      }

      this.send(ws, {
        type: 'pair_matched',
        peerCode: targetCode,
        peerPublicKey: request.requesterPublicKey,
        isInitiator: false,
      });

      logger.pairingEvent('matched', { requester: targetCode, target: responderCode });
    } else {
      // Notify requester about rejection
      const requesterWs = this.pairingCodeToWs.get(targetCode);
      if (requesterWs) {
        this.send(requesterWs, {
          type: 'pair_rejected',
          peerCode: responderCode,
        });
      }

      logger.pairingEvent('rejected', { requester: targetCode, target: responderCode });
    }
  }

  /**
   * Expire a pending pair request
   */
  private expirePairRequest(requesterCode: string, targetCode: string): void {
    const pending = this.pendingPairRequests.get(targetCode) || [];
    const requestIndex = pending.findIndex(r => r.requesterCode === requesterCode);

    if (requestIndex !== -1) {
      // Request is still pending, expire it
      pending.splice(requestIndex, 1);
      if (pending.length === 0) {
        this.pendingPairRequests.delete(targetCode);
      } else {
        this.pendingPairRequests.set(targetCode, pending);
      }

      // Notify requester about timeout
      const requesterWs = this.pairingCodeToWs.get(requesterCode);
      if (requesterWs) {
        this.send(requesterWs, {
          type: 'pair_timeout',
          peerCode: targetCode,
        });
      }

      logger.pairingEvent('expired', { requester: requesterCode, target: targetCode });
    }
  }

  /**
   * Handle device link request (web client wanting to link to mobile app).
   *
   * The link flow is:
   * 1. Mobile app generates link code and displays QR
   * 2. Web client scans QR and sends link_request with the link code
   * 3. Server forwards request to mobile app (via pairing code match)
   * 4. Mobile app approves/rejects
   * 5. On approval, both sides get link_matched to start WebRTC
   */
  private handleLinkRequest(ws: WebSocket, message: LinkRequestMessage): void {
    const { linkCode, publicKey, deviceName = 'Unknown Browser' } = message;
    const webClientCode = this.wsToPairingCode.get(ws);

    if (!webClientCode) {
      this.sendError(ws, 'Not registered. Send register message first.');
      return;
    }

    if (!linkCode) {
      this.sendError(ws, 'Missing required field: linkCode');
      return;
    }

    // Validate link code format (Issue #17)
    if (!PAIRING_CODE.REGEX.test(linkCode)) {
      this.sendError(ws, 'Invalid link code format');
      return;
    }

    if (!publicKey) {
      this.sendError(ws, 'Missing required field: publicKey');
      return;
    }

    // The linkCode IS the mobile app's pairing code
    // Find the mobile app's WebSocket
    const mobileWs = this.pairingCodeToWs.get(linkCode);

    if (!mobileWs) {
      // Use generic error to prevent enumeration attacks
      this.send(ws, {
        type: 'link_error',
        error: 'Link request could not be processed',
      });
      return;
    }

    // Clear any existing timer for this link code (in case of duplicate request)
    const existingLinkTimer = this.linkRequestTimers.get(linkCode);
    if (existingLinkTimer) {
      clearTimeout(existingLinkTimer);
      this.linkRequestTimers.delete(linkCode);
    }

    // Store pending link request
    this.pendingLinkRequests.set(linkCode, {
      webClientCode,
      webPublicKey: publicKey,
      deviceName,
      timestamp: Date.now(),
    });

    // Set timeout for this link request (reuse pairRequestTimeout - 120s default)
    // Issue #9: Prevents memory leak if mobile app never responds
    const linkTimer = setTimeout(() => {
      this.expireLinkRequest(linkCode);
      this.linkRequestTimers.delete(linkCode);
    }, this.pairRequestTimeout);
    this.linkRequestTimers.set(linkCode, linkTimer);

    // Forward request to mobile app (include timeout for UI countdown)
    this.send(mobileWs, {
      type: 'link_request',
      linkCode,
      publicKey,
      deviceName,
      expiresIn: this.pairRequestTimeout,
    });

    logger.debug(`[Link] Request: web ${logger.pairingCode(webClientCode)} -> mobile ${logger.pairingCode(linkCode)}`);
  }

  /**
   * Handle device link response from mobile app.
   */
  private handleLinkResponse(ws: WebSocket, message: LinkResponseMessage): void {
    const { linkCode, accepted, deviceId } = message;
    const mobileCode = this.wsToPairingCode.get(ws);

    if (!mobileCode) {
      this.sendError(ws, 'Not registered. Send register message first.');
      return;
    }

    // Validate link code format (Issue #17)
    if (!linkCode || !PAIRING_CODE.REGEX.test(linkCode)) {
      this.sendError(ws, 'Invalid link code format');
      return;
    }

    // Verify this is the mobile app that owns the link code
    if (mobileCode !== linkCode) {
      this.sendError(ws, 'Cannot respond to link request for another device');
      return;
    }

    // Find the pending request
    const pending = this.pendingLinkRequests.get(linkCode);
    if (!pending) {
      this.send(ws, {
        type: 'link_error',
        error: 'No pending link request found',
      });
      return;
    }

    // Clear the timer for this request (Issue #9)
    const existingLinkTimer = this.linkRequestTimers.get(linkCode);
    if (existingLinkTimer) {
      clearTimeout(existingLinkTimer);
      this.linkRequestTimers.delete(linkCode);
    }

    // Remove the pending request
    this.pendingLinkRequests.delete(linkCode);

    // Find the web client
    const webWs = this.pairingCodeToWs.get(pending.webClientCode);

    if (!webWs) {
      // Web client disconnected
      return;
    }

    if (accepted) {
      // Get mobile app's public key
      const mobilePublicKey = this.pairingCodeToPublicKey.get(mobileCode);
      if (!mobilePublicKey) {
        this.sendError(ws, 'Public key not found');
        return;
      }

      // Notify both sides about the match
      // Web client is initiator (creates WebRTC offer)
      this.send(webWs, {
        type: 'link_matched',
        linkCode,
        peerPublicKey: mobilePublicKey,
        isInitiator: true,
        deviceId,
      });

      // Mobile app is responder
      this.send(ws, {
        type: 'link_matched',
        linkCode,
        peerPublicKey: pending.webPublicKey,
        isInitiator: false,
        webClientCode: pending.webClientCode,
        deviceName: pending.deviceName,
      });

      logger.debug(`[Link] Matched: web ${logger.pairingCode(pending.webClientCode)} <-> mobile ${logger.pairingCode(mobileCode)}`);
    } else {
      // Notify web client about rejection
      this.send(webWs, {
        type: 'link_rejected',
        linkCode,
      });

      logger.debug(`[Link] Rejected: web ${logger.pairingCode(pending.webClientCode)} by mobile ${logger.pairingCode(mobileCode)}`);
    }
  }

  /**
   * Expire a pending link request (Issue #9: Memory leak fix)
   *
   * Called when the mobile app does not respond within the timeout period.
   * Notifies both parties that the request has expired.
   */
  private expireLinkRequest(linkCode: string): void {
    const pending = this.pendingLinkRequests.get(linkCode);

    if (pending) {
      // Request is still pending, expire it
      this.pendingLinkRequests.delete(linkCode);

      // Notify web client about timeout
      const webWs = this.pairingCodeToWs.get(pending.webClientCode);
      if (webWs) {
        this.send(webWs, {
          type: 'link_timeout',
          linkCode,
        });
      }

      // Notify mobile app about timeout (in case they have stale UI state)
      const mobileWs = this.pairingCodeToWs.get(linkCode);
      if (mobileWs) {
        this.send(mobileWs, {
          type: 'link_timeout',
          linkCode,
        });
      }

      logger.debug(`[Link] Expired: web ${logger.pairingCode(pending.webClientCode)} -> mobile ${logger.pairingCode(linkCode)}`);
    }
  }

  /**
   * Handle signaling message forwarding (offer, answer, ice_candidate)
   */
  private handleSignalingForward(
    ws: WebSocket,
    message: SignalingOfferMessage | SignalingAnswerMessage | SignalingIceCandidateMessage
  ): void {
    const { type, target, payload } = message;
    const senderPairingCode = this.wsToPairingCode.get(ws);

    if (!senderPairingCode) {
      this.sendError(ws, 'Not registered. Send register message first.');
      return;
    }

    if (!target) {
      this.sendError(ws, 'Missing required field: target');
      return;
    }

    // Validate target code format (Issue #17)
    if (!PAIRING_CODE.REGEX.test(target)) {
      this.sendError(ws, 'Invalid target code format');
      return;
    }

    // Forward the message to target
    const targetWs = this.pairingCodeToWs.get(target);
    if (targetWs) {
      this.send(targetWs, {
        type,
        from: senderPairingCode,
        payload,
      });
      logger.pairingEvent('forwarded', { requester: senderPairingCode, target, type });
    } else {
      logger.pairingEvent('not_found', { target, type });
      this.send(ws, {
        type: 'error',
        message: `Peer not found: ${target}`,
      });
    }
  }

  /**
   * Validate call signaling payload based on message type.
   * Returns error message if invalid, undefined if valid.
   */
  private validateCallSignalingPayload(
    type: string,
    payload: Record<string, unknown>
  ): string | undefined {
    if (!payload || typeof payload !== 'object') {
      return 'Missing or invalid payload';
    }

    // All call messages require callId
    const callId = payload['callId'];
    if (typeof callId !== 'string' || !CALL_SIGNALING.UUID_REGEX.test(callId)) {
      return 'Invalid or missing callId (must be UUID v4 format)';
    }

    switch (type) {
      case 'call_offer':
      case 'call_answer': {
        // Require sdp field with content
        const sdp = payload['sdp'];
        if (typeof sdp !== 'string' || sdp.length === 0) {
          return `Missing or invalid sdp in ${type}`;
        }
        if (sdp.length > CALL_SIGNALING.MAX_SDP_LENGTH) {
          return `SDP too large (max ${CALL_SIGNALING.MAX_SDP_LENGTH} bytes)`;
        }
        break;
      }

      case 'call_ice': {
        // Require candidate field with content
        const candidate = payload['candidate'];
        if (typeof candidate !== 'string' || candidate.length === 0) {
          return 'Missing or invalid candidate in call_ice';
        }
        if (candidate.length > CALL_SIGNALING.MAX_ICE_CANDIDATE_LENGTH) {
          return `ICE candidate too large (max ${CALL_SIGNALING.MAX_ICE_CANDIDATE_LENGTH} bytes)`;
        }
        break;
      }

      case 'call_reject':
      case 'call_hangup':
        // Only callId is required, which is already validated above
        break;

      default:
        return `Unknown call signaling type: ${type}`;
    }

    return undefined; // Valid
  }

  /**
   * Handle VoIP call signaling message forwarding (call_offer, call_answer, call_reject, call_hangup, call_ice)
   *
   * Uses the same validation and forwarding pattern as WebRTC data channel signaling.
   * The server acts as a simple relay - no call state tracking needed.
   */
  private handleCallSignalingForward(
    ws: WebSocket,
    message: CallOfferMessage | CallAnswerMessage | CallRejectMessage | CallHangupMessage | CallIceMessage
  ): void {
    const { type, target, payload } = message;
    const senderPairingCode = this.wsToPairingCode.get(ws);

    if (!senderPairingCode) {
      this.sendError(ws, 'Not registered. Send register message first.');
      return;
    }

    if (!target) {
      this.sendError(ws, 'Missing required field: target');
      return;
    }

    // Validate target code format
    if (!PAIRING_CODE.REGEX.test(target)) {
      this.sendError(ws, 'Invalid target code format');
      return;
    }

    // Validate payload structure based on message type
    const payloadError = this.validateCallSignalingPayload(type, payload);
    if (payloadError) {
      this.sendError(ws, payloadError);
      return;
    }

    // Forward the message to target
    const targetWs = this.pairingCodeToWs.get(target);
    if (targetWs) {
      this.send(targetWs, {
        type,
        from: senderPairingCode,
        payload,
      });
      logger.pairingEvent('forwarded', { requester: senderPairingCode, target, type });
    } else {
      logger.pairingEvent('not_found', { target, type });
      this.send(ws, {
        type: 'error',
        message: `Peer not found: ${target}`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Channel upstream and streaming handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle channel owner registration.
   * The owner registers to receive upstream messages for their channel.
   */
  private handleChannelOwnerRegister(ws: WebSocket, message: ChannelOwnerRegisterMessage): void {
    const { channelId } = message;

    if (!channelId) {
      this.sendError(ws, 'Missing required field: channelId');
      return;
    }

    this.channelOwners.set(channelId, ws);

    // Flush any queued upstream messages
    const queue = this.upstreamQueues.get(channelId);
    if (queue && queue.length > 0) {
      for (const item of queue) {
        this.send(ws, item.data);
      }
      this.upstreamQueues.delete(channelId);
    }

    this.send(ws, {
      type: 'channel-owner-registered',
      channelId,
    });
  }

  /**
   * Handle channel subscription registration.
   * Subscribers register to receive stream frames and broadcasts.
   */
  private async handleChannelSubscribe(ws: WebSocket, message: ChannelSubscribeMessage): Promise<void> {
    const { channelId } = message;

    if (!channelId) {
      this.sendError(ws, 'Missing required field: channelId');
      return;
    }

    let subscribers = this.channelSubscribers.get(channelId);
    if (!subscribers) {
      subscribers = new Set();
      this.channelSubscribers.set(channelId, subscribers);
    }
    subscribers.add(ws);

    this.send(ws, {
      type: 'channel-subscribed',
      channelId,
    });

    // If there's an active stream, notify the new subscriber
    const activeStream = this.activeStreams.get(channelId);
    if (activeStream) {
      this.send(ws, {
        type: 'stream-start',
        streamId: activeStream.streamId,
        channelId,
        title: activeStream.title,
      });
    }

    // Send existing cached chunks so late-joining subscribers can fetch content.
    if (this.chunkRelay) {
      const chunkIds = await this.chunkRelay.getCachedChunkIdsForChannel(channelId);
      if (chunkIds.length > 0) {
        this.send(ws, {
          type: 'chunk_available',
          channelId,
          chunkIds,
        });
      }
    }
  }

  /**
   * Check upstream rate limit for a WebSocket connection.
   * Returns true if the upstream message should be allowed.
   */
  private checkUpstreamRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    let rateLimitInfo = this.upstreamRateLimits.get(ws);

    if (!rateLimitInfo) {
      rateLimitInfo = { messageCount: 1, windowStart: now };
      this.upstreamRateLimits.set(ws, rateLimitInfo);
      return true;
    }

    if (now - rateLimitInfo.windowStart >= RATE_LIMIT.WINDOW_MS) {
      rateLimitInfo.messageCount = 1;
      rateLimitInfo.windowStart = now;
      return true;
    }

    rateLimitInfo.messageCount++;

    if (rateLimitInfo.messageCount > ClientHandler.MAX_UPSTREAM_PER_WINDOW) {
      return false;
    }

    return true;
  }

  /**
   * Handle upstream message (subscriber -> VPS -> owner).
   *
   * The VPS routes the message to the channel owner only.
   * Rate limited per peer to prevent spam.
   * Messages are queued if the owner is offline (up to MAX_UPSTREAM_QUEUE_SIZE).
   */
  private handleUpstreamMessage(ws: WebSocket, message: UpstreamMessageData): void {
    const { channelId } = message;

    if (!channelId) {
      this.sendError(ws, 'Missing required field: channelId');
      return;
    }

    if (!message.message) {
      this.sendError(ws, 'Missing required field: message');
      return;
    }

    // Rate limit upstream messages
    if (!this.checkUpstreamRateLimit(ws)) {
      this.sendError(ws, 'Upstream rate limit exceeded. Please slow down.');
      return;
    }

    const ownerWs = this.channelOwners.get(channelId);

    const forwardData = {
      type: 'upstream-message',
      channelId,
      message: message.message,
      ephemeralPublicKey: message.ephemeralPublicKey,
    };

    if (ownerWs && ownerWs.readyState === ownerWs.OPEN) {
      // Owner is online, forward directly
      this.send(ownerWs, forwardData);
    } else {
      // Owner is offline, queue the message
      let queue = this.upstreamQueues.get(channelId);
      if (!queue) {
        queue = [];
        this.upstreamQueues.set(channelId, queue);
      }

      if (queue.length < ClientHandler.MAX_UPSTREAM_QUEUE_SIZE) {
        queue.push({ data: forwardData, timestamp: Date.now() });
      }
      // Silently drop if queue is full (DoS protection)
    }

    // Acknowledge receipt to the sender
    this.send(ws, {
      type: 'upstream-ack',
      channelId,
      messageId: (message.message as Record<string, unknown>)['id'] || null,
    });
  }

  /**
   * Handle stream-start from the channel owner.
   *
   * Notifies all subscribed peers about the new live stream.
   * VPS tracks the active stream to notify late-joining subscribers.
   */
  private handleStreamStart(ws: WebSocket, message: StreamStartMessage): void {
    const { streamId, channelId, title } = message;

    if (!streamId || !channelId) {
      this.sendError(ws, 'Missing required fields: streamId, channelId');
      return;
    }

    // Verify this is the channel owner
    const ownerWs = this.channelOwners.get(channelId);
    if (ownerWs !== ws) {
      this.sendError(ws, 'Only the channel owner can start a stream');
      return;
    }

    // Track the active stream
    this.activeStreams.set(channelId, { streamId, title, ownerWs: ws });

    // Fan out to all subscribers
    const subscribers = this.channelSubscribers.get(channelId);
    if (subscribers) {
      const notification = {
        type: 'stream-start',
        streamId,
        channelId,
        title,
      };
      for (const subWs of subscribers) {
        this.send(subWs, notification);
      }
    }

    // Acknowledge
    this.send(ws, {
      type: 'stream-started',
      streamId,
      channelId,
      subscriberCount: subscribers?.size || 0,
    });
  }

  /**
   * Handle stream-frame from the channel owner.
   *
   * VPS acts as SFU: receives encrypted frame, fans out to all subscribers.
   * No store-and-forward delay -- pure streaming relay.
   */
  private handleStreamFrame(ws: WebSocket, message: StreamFrameMessage): void {
    const { streamId, channelId, frame } = message;

    if (!streamId || !channelId || !frame) {
      return; // Silently drop malformed frames for performance
    }

    // Verify the stream is active and the sender is the owner
    const activeStream = this.activeStreams.get(channelId);
    if (!activeStream || activeStream.ownerWs !== ws) {
      return; // Silently drop unauthorized frames
    }

    // Fan out to all subscribers (SFU pattern)
    const subscribers = this.channelSubscribers.get(channelId);
    if (subscribers) {
      const frameMsg = {
        type: 'stream-frame',
        streamId,
        channelId,
        frame,
      };
      for (const subWs of subscribers) {
        this.send(subWs, frameMsg);
      }
    }
  }

  /**
   * Handle stream-end from the channel owner.
   *
   * Notifies all subscribers and cleans up the active stream.
   */
  private handleStreamEnd(ws: WebSocket, message: StreamEndMessage): void {
    const { streamId, channelId } = message;

    if (!streamId || !channelId) {
      this.sendError(ws, 'Missing required fields: streamId, channelId');
      return;
    }

    // Verify the stream is active and the sender is the owner
    const activeStream = this.activeStreams.get(channelId);
    if (!activeStream || activeStream.ownerWs !== ws) {
      this.sendError(ws, 'Cannot end stream: not the owner or no active stream');
      return;
    }

    // Clean up the active stream
    this.activeStreams.delete(channelId);

    // Notify all subscribers
    const subscribers = this.channelSubscribers.get(channelId);
    if (subscribers) {
      const endMsg = {
        type: 'stream-end',
        streamId,
        channelId,
      };
      for (const subWs of subscribers) {
        this.send(subWs, endMsg);
      }
    }

    // Acknowledge
    this.send(ws, {
      type: 'stream-ended',
      streamId,
      channelId,
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
      const subscribers = this.channelSubscribers.get(channelId);
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
    const peerId = this.wsToClient.get(ws) || this.wsToPairingCode.get(ws);
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
    const peerId = this.wsToClient.get(ws) || this.wsToPairingCode.get(ws);
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
    // Clean up attestation session
    const connectionId = this.wsToConnectionId.get(ws);
    if (connectionId && this.attestationManager) {
      this.attestationManager.removeSession(connectionId);
    }
    this.wsToConnectionId.delete(ws);

    // Clean up rate limiting tracking
    this.wsRateLimits.delete(ws);
    this.wsPairRequestRateLimits.delete(ws);
    this.upstreamRateLimits.delete(ws);

    // Clean up channel owner registrations
    for (const [channelId, ownerWs] of this.channelOwners) {
      if (ownerWs === ws) {
        this.channelOwners.delete(channelId);
        // End any active streams for this owner
        const activeStream = this.activeStreams.get(channelId);
        if (activeStream && activeStream.ownerWs === ws) {
          this.activeStreams.delete(channelId);
          // Notify subscribers that stream ended
          const subscribers = this.channelSubscribers.get(channelId);
          if (subscribers) {
            const endMsg = { type: 'stream-end', streamId: activeStream.streamId, channelId };
            for (const subWs of subscribers) {
              this.send(subWs, endMsg);
            }
          }
        }
      }
    }

    // Clean up channel subscriber registrations
    for (const [, subscribers] of this.channelSubscribers) {
      subscribers.delete(ws);
    }

    // Clean up pairing code mappings (for signaling clients)
    const pairingCode = this.wsToPairingCode.get(ws);
    if (pairingCode) {
      this.pairingCodeToWs.delete(pairingCode);
      this.wsToPairingCode.delete(ws);
      this.pairingCodeToPublicKey.delete(pairingCode);

      // Clean up timers for requests where this peer was the target
      const pendingAsTarget = this.pendingPairRequests.get(pairingCode) || [];
      for (const request of pendingAsTarget) {
        const timerKey = `${request.requesterCode}:${pairingCode}`;
        this.clearPairRequestTimers(timerKey);
      }
      this.pendingPairRequests.delete(pairingCode);

      // Also remove requests where this peer was the requester and clean up timers
      for (const [targetCode, requests] of this.pendingPairRequests) {
        const filtered = requests.filter(r => {
          if (r.requesterCode === pairingCode) {
            // Clear the timers for this request
            const timerKey = `${pairingCode}:${targetCode}`;
            this.clearPairRequestTimers(timerKey);
            return false;
          }
          return true;
        });
        if (filtered.length === 0) {
          this.pendingPairRequests.delete(targetCode);
        } else if (filtered.length !== requests.length) {
          this.pendingPairRequests.set(targetCode, filtered);
        }
      }

      // Clean up pending link requests where this peer was the mobile app (Issue #9)
      const mobileTimer = this.linkRequestTimers.get(pairingCode);
      if (mobileTimer) {
        clearTimeout(mobileTimer);
        this.linkRequestTimers.delete(pairingCode);
      }
      this.pendingLinkRequests.delete(pairingCode);

      // Also clean up link requests where this peer was the web client
      for (const [linkCode, request] of this.pendingLinkRequests) {
        if (request.webClientCode === pairingCode) {
          // Clear the timer for this link request (Issue #9)
          const webClientTimer = this.linkRequestTimers.get(linkCode);
          if (webClientTimer) {
            clearTimeout(webClientTimer);
            this.linkRequestTimers.delete(linkCode);
          }
          this.pendingLinkRequests.delete(linkCode);
          // Notify mobile app that web client disconnected
          const mobileWs = this.pairingCodeToWs.get(linkCode);
          if (mobileWs) {
            this.send(mobileWs, {
              type: 'link_timeout',
              linkCode,
            });
          }
        }
      }

      logger.pairingEvent('disconnected', { code: pairingCode });
    }

    // Clean up peerId mappings (for relay clients)
    const peerId = this.wsToClient.get(ws);
    if (!peerId) return;

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

    // Always clean up the reverse mapping for this WebSocket
    this.wsToClient.delete(ws);
  }

  /**
   * Notify a specific client
   */
  notifyClient(peerId: string, message: object): boolean {
    // Check relay clients first
    const client = this.clients.get(peerId);
    if (client) return this.send(client.ws, message);

    // Fall back to signaling clients (pairing code registrations)
    const signalingWs = this.pairingCodeToWs.get(peerId);
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
    return stale.length;
  }

  /**
   * Shutdown - disconnect all clients
   */
  async shutdown(): Promise<void> {
    // Clear all pair request timers to prevent memory leaks
    for (const timer of this.pairRequestTimers.values()) {
      clearTimeout(timer);
    }
    this.pairRequestTimers.clear();

    // Clear all pair request warning timers
    for (const timer of this.pairRequestWarningTimers.values()) {
      clearTimeout(timer);
    }
    this.pairRequestWarningTimers.clear();

    // Clear all link request timers to prevent memory leaks (Issue #9)
    for (const timer of this.linkRequestTimers.values()) {
      clearTimeout(timer);
    }
    this.linkRequestTimers.clear();

    // Clear rate limiting data
    this.wsRateLimits.clear();
    this.wsPairRequestRateLimits.clear();
    this.upstreamRateLimits.clear();

    // Clear channel data
    this.channelOwners.clear();
    this.channelSubscribers.clear();
    this.activeStreams.clear();
    this.upstreamQueues.clear();

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
    for (const [peerId, client] of this.clients) {
      try {
        client.ws.close(1001, 'Server shutting down');
      } catch {
        // Intentionally ignored: WebSocket may already be closed or in invalid state
        // during shutdown. Best-effort cleanup is acceptable here.
      }
    }
    this.clients.clear();
    this.wsToClient.clear();

    // Close all signaling clients
    for (const [pairingCode, ws] of this.pairingCodeToWs) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch {
        // Intentionally ignored: WebSocket may already be closed or in invalid state
        // during shutdown. Best-effort cleanup is acceptable here.
      }
    }
    this.pairingCodeToWs.clear();
    this.wsToPairingCode.clear();
    this.pairingCodeToPublicKey.clear();
    this.pendingPairRequests.clear();
    this.pendingLinkRequests.clear();
  }

  /**
   * Get signaling client count
   */
  get signalingClientCount(): number {
    return this.pairingCodeToWs.size;
  }

  /**
   * Get entropy metrics for pairing codes (Issue #41)
   *
   * Returns metrics for monitoring pairing code entropy and collision risk.
   * Based on birthday paradox analysis:
   * - 30-bit entropy (6 chars from 32-char alphabet) = ~1 billion possible codes
   * - Collision risk increases at ~33k active codes (birthday bound)
   *
   * Risk levels:
   * - low: < 10,000 active codes (collision probability < 0.005%)
   * - medium: 10,000 - 30,000 active codes (collision probability 0.005% - 0.05%)
   * - high: > 30,000 active codes (collision probability > 0.05%)
   */
  getEntropyMetrics(): EntropyMetrics {
    const activeCodes = this.pairingCodeToWs.size;

    let collisionRisk: 'low' | 'medium' | 'high';
    if (activeCodes >= ENTROPY.COLLISION_HIGH_THRESHOLD) {
      collisionRisk = 'high';
    } else if (activeCodes >= ENTROPY.COLLISION_LOW_THRESHOLD) {
      collisionRisk = 'medium';
    } else {
      collisionRisk = 'low';
    }

    return {
      activeCodes,
      peakActiveCodes: this.entropyMetrics.peakActiveCodes,
      totalRegistrations: this.entropyMetrics.totalRegistrations,
      collisionAttempts: this.entropyMetrics.collisionAttempts,
      collisionRisk,
    };
  }
}

// Export EntropyMetrics type for use in index.ts
export type { EntropyMetrics };
