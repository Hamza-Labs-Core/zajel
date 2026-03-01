/**
 * Signaling Handler
 *
 * Manages pairing code registration, pair request/response flows, WebRTC signaling
 * forwarding (offer/answer/ice), and VoIP call signaling.
 * Extracted from ClientHandler to separate signaling concerns.
 *
 * Device linking has been further extracted to LinkHandler.
 */

import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { CRYPTO, PAIRING, PAIRING_CODE, ENTROPY, CALL_SIGNALING } from '../constants.js';
import type {
  PendingPairRequest,
  EntropyMetrics,
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
} from './types.js';

export interface SignalingHandlerDeps {
  send: (ws: WebSocket, message: object) => boolean;
  sendError: (ws: WebSocket, message: string) => void;
  getServerId: () => string;
  getPairingCodeRedirects: (pairingCode: string) => Array<{ serverId: string; endpoint: string }>;
  pairRequestTimeout: number;
  pairRequestWarningTime: number;
}

export class SignalingHandler {
  // Pairing code-based client tracking for WebRTC signaling
  private pairingCodeToWs: Map<string, WebSocket> = new Map();
  private wsToPairingCode: Map<WebSocket, string> = new Map();
  private pairingCodeToPublicKey: Map<string, string> = new Map();
  // Pending pair requests: targetCode -> list of pending requests
  private pendingPairRequests: Map<string, PendingPairRequest[]> = new Map();

  // Timer references for pair request expiration (to prevent memory leaks)
  private pairRequestTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Timer references for pair request warnings (sent before timeout)
  private pairRequestWarningTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Entropy metrics tracking
  private entropyMetrics = {
    peakActiveCodes: 0,
    totalRegistrations: 0,
    collisionAttempts: 0,
  };

  private readonly send: (ws: WebSocket, message: object) => boolean;
  private readonly sendError: (ws: WebSocket, message: string) => void;
  private readonly getServerId: () => string;
  private readonly getPairingCodeRedirects: (pairingCode: string) => Array<{ serverId: string; endpoint: string }>;
  private readonly pairRequestTimeout: number;
  private readonly pairRequestWarningTime: number;

  constructor(deps: SignalingHandlerDeps) {
    this.send = deps.send;
    this.sendError = deps.sendError;
    this.getServerId = deps.getServerId;
    this.getPairingCodeRedirects = deps.getPairingCodeRedirects;
    this.pairRequestTimeout = deps.pairRequestTimeout;
    this.pairRequestWarningTime = deps.pairRequestWarningTime;
  }

  /**
   * Get pairing code WebSocket (used by cross-server pair requests and link handler).
   */
  getPairingCodeWs(code: string): WebSocket | undefined {
    return this.pairingCodeToWs.get(code);
  }

  /**
   * Get the pairing code for a WebSocket.
   */
  getWsPairingCode(ws: WebSocket): string | undefined {
    return this.wsToPairingCode.get(ws);
  }

  /**
   * Get the public key for a pairing code (used by link handler).
   */
  getPairingCodePublicKey(code: string): string | undefined {
    return this.pairingCodeToPublicKey.get(code);
  }

  /**
   * Get signaling client count.
   */
  get clientCount(): number {
    return this.pairingCodeToWs.size;
  }

  // ---------------------------------------------------------------------------
  // Timer helpers
  // ---------------------------------------------------------------------------

  private clearPairRequestTimer(timerKey: string): void {
    const timer = this.pairRequestTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.pairRequestTimers.delete(timerKey);
    }
  }

  private clearPairRequestWarningTimer(timerKey: string): void {
    const timer = this.pairRequestWarningTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.pairRequestWarningTimers.delete(timerKey);
    }
  }

  private clearPairRequestTimers(timerKey: string): void {
    this.clearPairRequestTimer(timerKey);
    this.clearPairRequestWarningTimer(timerKey);
  }

  // ---------------------------------------------------------------------------
  // Pairing code registration
  // ---------------------------------------------------------------------------

  handlePairingCodeRegister(ws: WebSocket, message: SignalingRegisterMessage): void {
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
      console.warn('[SignalingHandler] Invalid public key base64 encoding:', error);
      this.sendError(ws, 'Invalid public key encoding');
      return;
    }

    // Issue #41: Collision detection
    if (this.pairingCodeToWs.has(pairingCode)) {
      this.entropyMetrics.collisionAttempts++;
      logger.warn(`Pairing code collision detected: ${logger.pairingCode(pairingCode)} (total collisions: ${this.entropyMetrics.collisionAttempts})`);

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

    // Compute DHT redirects
    const redirects = this.getPairingCodeRedirects(pairingCode);

    this.send(ws, {
      type: 'registered',
      pairingCode,
      serverId: this.getServerId(),
      ...(redirects.length > 0 ? { redirects } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Pair request/response
  // ---------------------------------------------------------------------------

  handlePairRequest(ws: WebSocket, message: PairRequestMessage): void {
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
      this.send(ws, {
        type: 'pair_error',
        error: 'Pair request could not be processed',
      });
      return;
    }

    const targetWs = this.pairingCodeToWs.get(targetCode);

    if (!targetWs) {
      this.send(ws, {
        type: 'pair_error',
        error: 'Pair request could not be processed',
      });
      return;
    }

    const requesterPublicKey = this.pairingCodeToPublicKey.get(requesterCode);
    if (!requesterPublicKey) {
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
   */
  processPairRequest(
    requesterCode: string,
    requesterPublicKey: string,
    targetCode: string,
    targetWs: WebSocket,
    proposedName?: string
  ): void {
    const pending = this.pendingPairRequests.get(targetCode) || [];

    // Remove any existing request from the same requester
    const existingIndex = pending.findIndex(r => r.requesterCode === requesterCode);
    if (existingIndex !== -1) {
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

    const request: PendingPairRequest = {
      requesterCode,
      requesterPublicKey,
      targetCode,
      timestamp: Date.now(),
    };

    pending.push(request);
    this.pendingPairRequests.set(targetCode, pending);

    // Notify target about incoming pair request
    this.send(targetWs, {
      type: 'pair_incoming',
      fromCode: requesterCode,
      fromPublicKey: requesterPublicKey,
      expiresIn: this.pairRequestTimeout,
      ...(proposedName ? { proposedName } : {}),
    });

    logger.pairingEvent('request', { requester: requesterCode, target: targetCode });

    // Set timeout for this request
    const timerKey = `${requesterCode}:${targetCode}`;
    const timer = setTimeout(() => {
      this.expirePairRequest(requesterCode, targetCode);
      this.clearPairRequestTimers(timerKey);
    }, this.pairRequestTimeout);
    this.pairRequestTimers.set(timerKey, timer);

    // Set warning timer
    if (this.pairRequestWarningTime < this.pairRequestTimeout) {
      const warningDelay = this.pairRequestTimeout - this.pairRequestWarningTime;
      const warningTimer = setTimeout(() => {
        this.sendPairExpiringWarning(requesterCode, targetCode);
        this.pairRequestWarningTimers.delete(timerKey);
      }, warningDelay);
      this.pairRequestWarningTimers.set(timerKey, warningTimer);
    }
  }

  private sendPairExpiringWarning(requesterCode: string, targetCode: string): void {
    const remainingSeconds = Math.ceil(this.pairRequestWarningTime / 1000);

    const requesterWs = this.pairingCodeToWs.get(requesterCode);
    if (requesterWs) {
      this.send(requesterWs, {
        type: 'pair_expiring',
        peerCode: targetCode,
        remainingSeconds,
      });
    }

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

  handlePairResponse(ws: WebSocket, message: PairResponseMessage): void {
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
      const responderPublicKey = this.pairingCodeToPublicKey.get(responderCode);
      if (!responderPublicKey) {
        this.sendError(ws, 'Public key not found');
        return;
      }

      // Notify both peers about the match
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

  private expirePairRequest(requesterCode: string, targetCode: string): void {
    const pending = this.pendingPairRequests.get(targetCode) || [];
    const requestIndex = pending.findIndex(r => r.requesterCode === requesterCode);

    if (requestIndex !== -1) {
      pending.splice(requestIndex, 1);
      if (pending.length === 0) {
        this.pendingPairRequests.delete(targetCode);
      } else {
        this.pendingPairRequests.set(targetCode, pending);
      }

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

  // ---------------------------------------------------------------------------
  // WebRTC signaling forwarding
  // ---------------------------------------------------------------------------

  handleSignalingForward(
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

    if (!PAIRING_CODE.REGEX.test(target)) {
      this.sendError(ws, 'Invalid target code format');
      return;
    }

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
  // Call signaling forwarding
  // ---------------------------------------------------------------------------

  private validateCallSignalingPayload(
    type: string,
    payload: Record<string, unknown>
  ): string | undefined {
    if (!payload || typeof payload !== 'object') {
      return 'Missing or invalid payload';
    }

    const callId = payload['callId'];
    if (typeof callId !== 'string' || !CALL_SIGNALING.UUID_REGEX.test(callId)) {
      return 'Invalid or missing callId (must be UUID v4 format)';
    }

    switch (type) {
      case 'call_offer':
      case 'call_answer': {
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
        break;

      default:
        return `Unknown call signaling type: ${type}`;
    }

    return undefined;
  }

  handleCallSignalingForward(
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

    if (!PAIRING_CODE.REGEX.test(target)) {
      this.sendError(ws, 'Invalid target code format');
      return;
    }

    const payloadError = this.validateCallSignalingPayload(type, payload);
    if (payloadError) {
      this.sendError(ws, payloadError);
      return;
    }

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
  // Entropy metrics
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Disconnect cleanup
  // ---------------------------------------------------------------------------

  /**
   * Clean up signaling state when a WebSocket disconnects.
   * Returns the pairing code if one was registered (used by link handler cleanup).
   */
  handleDisconnect(ws: WebSocket): string | undefined {
    try {
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

        logger.pairingEvent('disconnected', { code: pairingCode });
        return pairingCode;
      }
    } catch (e) {
      logger.warn(`[SignalingHandler] Error cleaning up pairing code mappings: ${e}`);
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Shutdown: close all signaling WebSockets and clear state.
   */
  shutdown(): void {
    // Clear all pair request timers
    for (const timer of this.pairRequestTimers.values()) {
      clearTimeout(timer);
    }
    this.pairRequestTimers.clear();

    for (const timer of this.pairRequestWarningTimers.values()) {
      clearTimeout(timer);
    }
    this.pairRequestWarningTimers.clear();

    // Close all signaling WebSockets
    for (const [, ws] of this.pairingCodeToWs) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch {
        // Intentionally ignored: WebSocket may already be closed
      }
    }

    this.pairingCodeToWs.clear();
    this.wsToPairingCode.clear();
    this.pairingCodeToPublicKey.clear();
    this.pendingPairRequests.clear();
  }
}
