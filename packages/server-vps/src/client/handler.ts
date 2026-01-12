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

import { WEBSOCKET, CRYPTO, RATE_LIMIT, PAIRING, PAIRING_CODE, ENTROPY } from '../constants.js';

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
  dailyPoints?: string[];
  hourlyTokens?: string[];
  deadDrop?: string;
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
  | LinkRequestMessage
  | LinkResponseMessage;

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

  constructor(
    identity: ServerIdentity,
    endpoint: string,
    config: ClientHandlerConfig,
    relayRegistry: RelayRegistry,
    distributedRendezvous: DistributedRendezvous,
    metadata: ServerMetadata = {}
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

    // Forward match notifications to clients
    this.distributedRendezvous.on('match', (peerId, match) => {
      this.notifyClient(peerId, {
        type: 'rendezvous_match',
        match,
      });
    });
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

        case 'link_request':
          this.handleLinkRequest(ws, message as LinkRequestMessage);
          break;

        case 'link_response':
          this.handleLinkResponse(ws, message as LinkResponseMessage);
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

    if (!peerId) {
      this.sendError(ws, 'Missing required field: peerId');
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
      maxConnections,
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

    // Update client's last seen
    const client = this.clients.get(peerId);
    if (client) {
      client.lastSeen = Date.now();
    }

    this.relayRegistry.updateLoad(peerId, connectedCount);

    this.send(ws, {
      type: 'load_updated',
      peerId,
      connectedCount,
    });
  }

  /**
   * Handle rendezvous point registration with routing awareness
   */
  private async handleRegisterRendezvous(
    ws: WebSocket,
    message: RegisterRendezvousMessage
  ): Promise<void> {
    const {
      peerId,
      dailyPoints = [],
      hourlyTokens = [],
      deadDrop = '',
      relayId,
    } = message;

    // Update client's last seen
    const client = this.clients.get(peerId);
    if (client) {
      client.lastSeen = Date.now();
    }

    // Register daily points (with routing)
    const dailyResult = await this.distributedRendezvous.registerDailyPoints(peerId, {
      points: dailyPoints,
      deadDrop,
      relayId,
    });

    // Register hourly tokens (with routing)
    const hourlyResult = await this.distributedRendezvous.registerHourlyTokens(peerId, {
      tokens: hourlyTokens,
      relayId,
    });

    // Check if we need to send redirects
    const hasRedirects = dailyResult.redirects.length > 0 || hourlyResult.redirects.length > 0;

    if (hasRedirects) {
      // Send partial result with redirect information
      this.send(ws, {
        type: 'rendezvous_partial',
        local: {
          liveMatches: hourlyResult.local.liveMatches,
          deadDrops: dailyResult.local.deadDrops,
        },
        redirects: this.mergeRedirects(dailyResult.redirects, hourlyResult.redirects),
      });
    } else {
      // All points handled locally - send regular result
      this.send(ws, {
        type: 'rendezvous_result',
        liveMatches: hourlyResult.local.liveMatches,
        deadDrops: dailyResult.local.deadDrops,
      });
    }
  }

  /**
   * Handle get relays request
   */
  private handleGetRelays(ws: WebSocket, message: GetRelaysMessage): void {
    const { peerId, count = 10 } = message;

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

    // Send confirmation
    this.send(ws, {
      type: 'registered',
      pairingCode,
      serverId: this.identity.serverId,
    });
  }

  /**
   * Handle pair request (mutual approval flow)
   */
  private handlePairRequest(ws: WebSocket, message: PairRequestMessage): void {
    const { targetCode } = message;
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
    // SECURITY: Use generic error message to prevent enumeration attacks
    // Don't reveal whether the target code exists or not
    if (!targetWs) {
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

    // Check for DoS: limit pending requests per target
    const pending = this.pendingPairRequests.get(targetCode) || [];

    // Remove any existing request from the same requester (in-place modification)
    const existingIndex = pending.findIndex(r => r.requesterCode === requesterCode);
    if (existingIndex !== -1) {
      // Clear the existing timer for this request
      const timerKey = `${requesterCode}:${targetCode}`;
      const existingTimer = this.pairRequestTimers.get(timerKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.pairRequestTimers.delete(timerKey);
      }
      pending.splice(existingIndex, 1);
    }

    // SECURITY: Limit pending requests per target to prevent DoS
    if (pending.length >= PAIRING.MAX_PENDING_REQUESTS_PER_TARGET) {
      this.send(ws, {
        type: 'pair_error',
        error: 'Pair request could not be processed',
      });
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
    });

    logger.pairingEvent('request', { requester: requesterCode, target: targetCode });

    // Set timeout for this request and store the timer reference
    const timerKey = `${requesterCode}:${targetCode}`;
    const timer = setTimeout(() => {
      this.expirePairRequest(requesterCode, targetCode);
      this.pairRequestTimers.delete(timerKey);
      // Also clean up warning timer if it exists
      const warningTimer = this.pairRequestWarningTimers.get(timerKey);
      if (warningTimer) {
        clearTimeout(warningTimer);
        this.pairRequestWarningTimers.delete(timerKey);
      }
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

    // We know request exists because requestIndex !== -1
    const request = pending[requestIndex]!;

    // Clear the timer for this request
    const timerKey = `${targetCode}:${responderCode}`;
    const existingTimer = this.pairRequestTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pairRequestTimers.delete(timerKey);
    }

    // Remove the request from pending

    // Clear the warning timer for this request
    const existingWarningTimer = this.pairRequestWarningTimers.get(timerKey);
    if (existingWarningTimer) {
      clearTimeout(existingWarningTimer);
      this.pairRequestWarningTimers.delete(timerKey);
    }
    pending.splice(requestIndex, 1);
    if (pending.length === 0) {
      this.pendingPairRequests.delete(responderCode);
    } else {
      this.pendingPairRequests.set(responderCode, pending);
    }

    const requesterWs = this.pairingCodeToWs.get(targetCode);

    if (accepted) {
      // Get responder's public key
      const responderPublicKey = this.pairingCodeToPublicKey.get(responderCode);
      if (!responderPublicKey) {
        this.sendError(ws, 'Public key not found');
        return;
      }

      // Notify both peers about the match
      // The requester is the initiator (creates WebRTC offer)
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

    // Find target WebSocket
    const targetWs = this.pairingCodeToWs.get(target);

    if (!targetWs) {
      logger.pairingEvent('not_found', { target, type });
      this.send(ws, {
        type: 'error',
        message: `Peer not found: ${target}`,
      });
      return;
    }

    // Forward the message to target with sender info
    const forwarded = this.send(targetWs, {
      type,
      from: senderPairingCode,
      payload,
    });

    if (forwarded) {
      logger.pairingEvent('forwarded', { requester: senderPairingCode, target, type });
    } else {
      logger.pairingEvent('forward_failed', { requester: senderPairingCode, target, type });
      this.send(ws, {
        type: 'error',
        message: `Failed to forward ${type} to ${target}`,
      });
    }
  }

  /**
   * Handle WebSocket disconnect
   */
  async handleDisconnect(ws: WebSocket): Promise<void> {
    // Clean up rate limiting tracking
    this.wsRateLimits.delete(ws);
    this.wsPairRequestRateLimits.delete(ws);

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
        
        const timer = this.pairRequestTimers.get(timerKey);
        if (timer) {
          clearTimeout(timer);
          this.pairRequestTimers.delete(timerKey);
        }
      }
      this.pendingPairRequests.delete(pairingCode);

      // Also remove requests where this peer was the requester and clean up timers
      for (const [targetCode, requests] of this.pendingPairRequests) {
        const filtered = requests.filter(r => {
          if (r.requesterCode === pairingCode) {
            // Clear the timer for this request
            const timerKey = `${pairingCode}:${targetCode}`;
            
        const timer = this.pairRequestTimers.get(timerKey);
            if (timer) {
              clearTimeout(timer);
              this.pairRequestTimers.delete(timerKey);
            }
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

    // Remove from registries
    this.relayRegistry.unregister(peerId);
    await this.distributedRendezvous.unregisterPeer(peerId);

    // Clean up mappings
    this.clients.delete(peerId);
    this.wsToClient.delete(ws);

    this.emit('client-disconnected', peerId);
  }

  /**
   * Notify a specific client
   */
  notifyClient(peerId: string, message: object): boolean {
    const client = this.clients.get(peerId);
    if (!client) return false;

    return this.send(client.ws, message);
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
