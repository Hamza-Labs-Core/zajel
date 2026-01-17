/**
 * Signaling Client for WebRTC Connection Establishment
 *
 * SECURITY MODEL:
 * ================
 * This signaling client uses WSS (WebSocket Secure) to communicate with the
 * signaling server. However, certificate pinning is NOT implemented because:
 *
 * 1. Browser Limitation: The browser's WebSocket API does not expose any mechanism
 *    to access, inspect, or verify server certificates from JavaScript code.
 *    All TLS negotiation happens at the browser level, completely opaque to JS.
 *
 * 2. HPKP Deprecated: HTTP Public Key Pinning was deprecated in 2017 and removed
 *    from browsers in 2018 due to operational risks.
 *
 * MITIGATIONS:
 * =============
 * The lack of certificate pinning is mitigated by multiple security layers:
 *
 * 1. End-to-End Encryption (E2E): All message content is encrypted using X25519
 *    key exchange and ChaCha20-Poly1305. Even if the signaling server is
 *    compromised, message content remains encrypted and unreadable.
 *
 * 2. Public Key Fingerprint Verification: Users can verify each other's public
 *    key fingerprints through an out-of-band channel (phone call, in person)
 *    to detect MITM attacks during key exchange.
 *
 * 3. WebRTC DTLS Protection: Once WebRTC is established, DTLS-SRTP provides
 *    additional encryption and certificate fingerprint verification via SDP.
 *
 * 4. Ephemeral Keys: New key pairs are generated per session, limiting exposure
 *    if keys are somehow compromised.
 *
 * THREAT MODEL:
 * ==============
 * The signaling server is treated as an untrusted relay. It only facilitates
 * connection establishment and never sees decrypted message content. The real
 * security comes from E2E encryption with verified key fingerprints.
 *
 * For high-security scenarios, users SHOULD verify key fingerprints out-of-band.
 *
 * See: /SECURITY.md for full security architecture documentation.
 */

import type {
  ClientMessage,
  ServerMessage,
  ConnectionState,
  CallOfferReceivedMessage,
  CallAnswerReceivedMessage,
  CallRejectReceivedMessage,
  CallHangupReceivedMessage,
  CallIceReceivedMessage,
} from './protocol';
import { validateServerMessage, safeJsonParse } from './validation';
import { TIMEOUTS, PAIRING_CODE, PAIRING_CODE_REGEX, MESSAGE_LIMITS } from './constants';
import { logger, mask } from './logger';
import { handleError, ErrorCodes } from './errors';


/**
 * Generates an unbiased random character from the given character set using rejection sampling.
 *
 * This avoids modulo bias by rejecting random bytes that would cause uneven distribution.
 * For a character set of length N, we calculate the largest multiple of N that fits in 256
 * and reject any bytes >= that value.
 *
 * @param chars - The character set to select from
 * @returns A single random character from the set with uniform probability
 */
function getUnbiasedRandomChar(chars: string): string {
  const charsetLength = chars.length;
  // Calculate the largest multiple of charsetLength that fits in 256 (byte range)
  const maxValid = Math.floor(256 / charsetLength) * charsetLength;

  let byte: number;
  do {
    byte = crypto.getRandomValues(new Uint8Array(1))[0];
  } while (byte >= maxValid);

  return chars[byte % charsetLength];
}

/**
 * Generates a random pairing code using unbiased random character selection.
 *
 * Uses rejection sampling to ensure each character has exactly equal probability,
 * protecting against modulo bias even if the character set is changed in the future.
 *
 * @returns A random pairing code of PAIRING_CODE.LENGTH characters
 */
function generatePairingCode(): string {
  return Array.from({ length: PAIRING_CODE.LENGTH }, () =>
    getUnbiasedRandomChar(PAIRING_CODE.CHARS)
  ).join('');
}

/**
 * Validates a pairing code format.
 * Pairing codes must be exactly 6 characters from the allowed character set.
 */
function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_REGEX.test(code);
}

export interface SignalingEvents {
  onStateChange: (state: ConnectionState) => void;
  onPairIncoming: (fromCode: string, fromPublicKey: string, expiresIn?: number) => void;
  onPairExpiring: (peerCode: string, remainingSeconds: number) => void;
  onPairMatched: (peerCode: string, peerPublicKey: string, isInitiator: boolean) => void;
  onPairRejected: (peerCode: string) => void;
  onPairTimeout: (peerCode: string) => void;
  onPairError: (error: string) => void;
  onOffer: (from: string, payload: RTCSessionDescriptionInit) => void;
  onAnswer: (from: string, payload: RTCSessionDescriptionInit) => void;
  onIceCandidate: (from: string, payload: RTCIceCandidateInit) => void;
  onError: (error: string) => void;
  // Call signaling events
  onCallOffer?: (message: CallOfferReceivedMessage) => void;
  onCallAnswer?: (message: CallAnswerReceivedMessage) => void;
  onCallReject?: (message: CallRejectReceivedMessage) => void;
  onCallHangup?: (message: CallHangupReceivedMessage) => void;
  onCallIce?: (message: CallIceReceivedMessage) => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private myCode: string = '';
  private myPublicKey: string = '';
  private pingInterval: number | null = null;
  private reconnectTimeout: number | null = null;
  private reconnectAttempts: number = 0;
  private state: ConnectionState = 'disconnected';
  private events: SignalingEvents;

  constructor(serverUrl: string, events: SignalingEvents) {
    this.serverUrl = serverUrl;
    this.events = events;
  }

  private generatePairingCode(): string {
    return generatePairingCode();
  }

  private setState(state: ConnectionState): void {
    logger.info('Signaling', `State changed: ${this.state} -> ${state}`);
    this.state = state;
    this.events.onStateChange(state);
  }

  get pairingCode(): string {
    return this.myCode;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(publicKey: string): void {
    if (this.ws) {
      this.ws.close();
    }

    this.myPublicKey = publicKey;
    this.myCode = this.generatePairingCode();
    logger.info('Signaling', `Connecting to server, pairing code: ${mask(this.myCode)}`);
    this.setState('connecting');

    this.ws = new WebSocket(this.serverUrl);

    this.ws.onopen = () => {
      this.register();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      // Check message size before processing
      const messageSize = typeof event.data === 'string'
        ? event.data.length
        : event.data.byteLength || 0;
      if (messageSize > MESSAGE_LIMITS.MAX_WEBSOCKET_MESSAGE_SIZE) {
        logger.error('Signaling', 'Rejected WebSocket message: exceeds 1MB size limit');
        // Close connection to prevent potential attacks
        this.disconnect();
        this.events.onError('Connection closed: message too large');
        return;
      }

      // Parse JSON safely
      const parsed = safeJsonParse(event.data);
      if (parsed === null) {
        logger.error('Signaling', 'Failed to parse WebSocket message as JSON');
        return;
      }

      // Validate message structure before processing
      const result = validateServerMessage(parsed);
      if (!result.success) {
        logger.warn('Signaling', 'Invalid signaling message:', result.error);
        return;
      }

      this.handleMessage(result.data);
    };

    this.ws.onerror = () => {
      logger.error('Signaling', 'WebSocket error');
      this.events.onError('Connection error');
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this.state !== 'disconnected') {
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    this.setState('disconnected');
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private register(): void {
    this.send({
      type: 'register',
      pairingCode: this.myCode,
      publicKey: this.myPublicKey,
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    // Exponential backoff: delay = base * 2^attempts, capped at max
    const delay = Math.min(
      TIMEOUTS.RECONNECT_DELAY_BASE_MS * Math.pow(2, this.reconnectAttempts),
      TIMEOUTS.RECONNECT_DELAY_MAX_MS
    );
    this.reconnectAttempts++;

    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.state === 'disconnected' && this.myPublicKey) {
        this.connect(this.myPublicKey);
      }
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, TIMEOUTS.PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private send(message: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
        logger.debug('Signaling', `Sent message: ${message.type}`);
        return true;
      } catch (error) {
        // Use centralized error handling for structured logging
        const zajelError = handleError(error, `signaling.send.${message.type}`, ErrorCodes.SIGNALING_SEND_FAILED);
        // Notify error handler for critical message types
        if (['pair_request', 'pair_response', 'offer', 'answer'].includes(message.type)) {
          this.events.onError(zajelError.userMessage);
        }
        return false;
      }
    }
    return false;
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'registered':
        this.reconnectAttempts = 0; // Reset backoff on successful connection
        this.setState('registered');
        break;

      case 'pair_incoming':
        this.setState('pending_approval');
        this.events.onPairIncoming(message.fromCode, message.fromPublicKey, message.expiresIn);
        break;

      case 'pair_expiring':
        // Warning that pair request is about to expire
        this.events.onPairExpiring(message.peerCode, message.remainingSeconds);
        break;

      case 'pair_matched':
        this.setState('matched');
        this.events.onPairMatched(
          message.peerCode,
          message.peerPublicKey,
          message.isInitiator
        );
        break;

      case 'pair_rejected':
        this.setState('registered');
        this.events.onPairRejected(message.peerCode);
        break;

      case 'pair_timeout':
        this.setState('registered');
        this.events.onPairTimeout(message.peerCode);
        break;

      case 'pair_error':
        this.setState('registered');
        this.events.onPairError(message.error);
        break;

      case 'offer':
        this.events.onOffer(message.from, message.payload);
        break;

      case 'answer':
        this.events.onAnswer(message.from, message.payload);
        break;

      case 'ice_candidate':
        this.events.onIceCandidate(message.from, message.payload);
        break;

      case 'pong':
        // Keepalive response, no action needed
        break;

      case 'error':
        this.events.onError(message.message);
        break;

      // Call signaling messages
      case 'call_offer':
        this.events.onCallOffer?.(message);
        break;

      case 'call_answer':
        this.events.onCallAnswer?.(message);
        break;

      case 'call_reject':
        this.events.onCallReject?.(message);
        break;

      case 'call_hangup':
        this.events.onCallHangup?.(message);
        break;

      case 'call_ice':
        this.events.onCallIce?.(message);
        break;
    }
  }

  // Public methods for pairing
  requestPairing(targetCode: string): void {
    // Validate pairing code format to prevent malformed requests
    if (!isValidPairingCode(targetCode)) {
      this.events.onError('Invalid pairing code format');
      return;
    }
    const sent = this.send({ type: 'pair_request', targetCode });
    if (sent) {
      this.setState('waiting_approval');
    }
  }

  respondToPairing(targetCode: string, accepted: boolean): void {
    // Validate pairing code format
    if (!isValidPairingCode(targetCode)) {
      this.events.onError('Invalid pairing code format');
      return;
    }
    const sent = this.send({ type: 'pair_response', targetCode, accepted });
    // Only update state if send succeeded and request was rejected
    if (sent && !accepted) {
      this.setState('registered');
    }
  }

  // WebRTC signaling methods
  sendOffer(target: string, payload: RTCSessionDescriptionInit): void {
    this.send({ type: 'offer', target, payload });
  }

  sendAnswer(target: string, payload: RTCSessionDescriptionInit): void {
    this.send({ type: 'answer', target, payload });
  }

  sendIceCandidate(target: string, payload: RTCIceCandidateInit): void {
    this.send({ type: 'ice_candidate', target, payload });
  }

  // Call signaling methods

  /**
   * Send call offer to peer
   */
  sendCallOffer(callId: string, targetId: string, sdp: string, withVideo: boolean): void {
    this.send({
      type: 'call_offer',
      callId,
      targetId,
      sdp,
      withVideo,
    });
  }

  /**
   * Send call answer to peer
   */
  sendCallAnswer(callId: string, targetId: string, sdp: string): void {
    this.send({
      type: 'call_answer',
      callId,
      targetId,
      sdp,
    });
  }

  /**
   * Reject incoming call
   */
  sendCallReject(callId: string, targetId: string, reason?: 'busy' | 'declined' | 'timeout'): void {
    this.send({
      type: 'call_reject',
      callId,
      targetId,
      reason,
    });
  }

  /**
   * End current call
   */
  sendCallHangup(callId: string, targetId: string): void {
    this.send({
      type: 'call_hangup',
      callId,
      targetId,
    });
  }

  /**
   * Send ICE candidate for call
   */
  sendCallIce(callId: string, targetId: string, candidate: RTCIceCandidate): void {
    this.send({
      type: 'call_ice',
      callId,
      targetId,
      candidate: JSON.stringify(candidate),
    });
  }
}
