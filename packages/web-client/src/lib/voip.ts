/**
 * VoIP Service for Call Orchestration
 *
 * This service orchestrates WebRTC calls by coordinating MediaService for
 * local media management and SignalingClient for call signaling.
 *
 * Features:
 * - Outgoing call initiation with offer/answer exchange
 * - Incoming call handling (accept/reject)
 * - ICE candidate exchange
 * - Connection state monitoring
 * - Ringing timeout handling
 * - Remote stream event emission
 */

import { MediaService } from './media';
import { SignalingClient } from './signaling';
import { CALL, WEBRTC } from './constants';
import { logger } from './logger';
import { ZajelError, ErrorCodes } from './errors';
import type {
  CallOfferReceivedMessage,
  CallAnswerReceivedMessage,
  CallRejectReceivedMessage,
  CallHangupReceivedMessage,
  CallIceReceivedMessage,
} from './protocol';

// VoIP Error Codes
export const VoIPErrorCodes = {
  VOIP_NO_ACTIVE_CALL: 'VOIP_001',
  VOIP_ALREADY_IN_CALL: 'VOIP_002',
  VOIP_CALL_NOT_FOUND: 'VOIP_003',
  VOIP_INVALID_STATE: 'VOIP_004',
  VOIP_PEER_CONNECTION_FAILED: 'VOIP_005',
  VOIP_MEDIA_FAILED: 'VOIP_006',
  VOIP_SIGNALING_FAILED: 'VOIP_007',
  VOIP_TIMEOUT: 'VOIP_008',
} as const;

export type VoIPErrorCode = (typeof VoIPErrorCodes)[keyof typeof VoIPErrorCodes];

// User-friendly error messages
export const VoIPUserMessages: Record<string, string> = {
  [VoIPErrorCodes.VOIP_NO_ACTIVE_CALL]: 'No active call.',
  [VoIPErrorCodes.VOIP_ALREADY_IN_CALL]: 'Already in a call. Please hang up first.',
  [VoIPErrorCodes.VOIP_CALL_NOT_FOUND]: 'Call not found.',
  [VoIPErrorCodes.VOIP_INVALID_STATE]: 'Invalid call state for this operation.',
  [VoIPErrorCodes.VOIP_PEER_CONNECTION_FAILED]: 'Failed to establish connection with peer.',
  [VoIPErrorCodes.VOIP_MEDIA_FAILED]: 'Failed to access camera/microphone.',
  [VoIPErrorCodes.VOIP_SIGNALING_FAILED]: 'Failed to send call signal.',
  [VoIPErrorCodes.VOIP_TIMEOUT]: 'Call timed out. No answer received.',
};

/**
 * Custom error class for VoIP-related errors.
 */
export class VoIPError extends ZajelError {
  constructor(
    message: string,
    code: VoIPErrorCode = VoIPErrorCodes.VOIP_PEER_CONNECTION_FAILED,
    context?: Record<string, unknown>
  ) {
    super(message, code as unknown as (typeof ErrorCodes)[keyof typeof ErrorCodes], true, context);
    this.name = 'VoIPError';
  }

  override get userMessage(): string {
    return VoIPUserMessages[this.code] || this.message;
  }
}

/**
 * Call state transitions:
 * - idle: No active call
 * - outgoing: Initiated outgoing call, waiting for answer
 * - incoming: Received incoming call, waiting for user action
 * - connecting: Both parties accepted, establishing WebRTC connection
 * - connected: Call is active
 * - ended: Call ended (terminal state, transitions back to idle)
 */
export type CallState = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'ended';

/**
 * Information about the current call.
 */
export interface CallInfo {
  /** Unique identifier for this call */
  callId: string;
  /** Peer's identifier (pairing code or ID) */
  peerId: string;
  /** Whether this is a video call */
  withVideo: boolean;
  /** Current state of the call */
  state: CallState;
  /** Timestamp when the call connected (undefined until connected) */
  startTime?: number;
  /** Remote peer's media stream */
  remoteStream?: MediaStream;
  /** SDP offer for incoming calls (stored until accepted) */
  pendingOffer?: string;
}

/**
 * Event handlers for VoIP service events.
 */
export interface VoIPEvents {
  /** Emitted when call state changes */
  'state-change': (state: CallState, call: CallInfo | null) => void;
  /** Emitted when remote stream is received */
  'remote-stream': (stream: MediaStream) => void;
  /** Emitted when an error occurs */
  'error': (error: VoIPError) => void;
  /** Emitted when an incoming call is received */
  'incoming-call': (call: CallInfo) => void;
}

/**
 * Generates a UUID v4 for call identification.
 */
function generateCallId(): string {
  return crypto.randomUUID();
}

/**
 * Signaling interface for call-related operations.
 * This allows VoIPService to work with different signaling implementations.
 */
export interface VoIPSignaling {
  sendCallOffer(callId: string, targetId: string, sdp: string, withVideo: boolean): void;
  sendCallAnswer(callId: string, targetId: string, sdp: string): void;
  sendCallReject(callId: string, targetId: string, reason?: 'busy' | 'declined' | 'timeout'): void;
  sendCallHangup(callId: string, targetId: string): void;
  sendCallIce(callId: string, targetId: string, candidate: RTCIceCandidate): void;
}

/**
 * VoIPService orchestrates calls using MediaService and a signaling interface.
 *
 * Usage:
 * ```typescript
 * const mediaService = new MediaService();
 * const voip = new VoIPService(mediaService, signaling);
 *
 * // Wire up signaling events to VoIP handlers
 * // (in your SignalingEvents configuration)
 * const signalingEvents: SignalingEvents = {
 *   ...otherEvents,
 *   onCallOffer: voip.getCallOfferHandler(),
 *   onCallAnswer: voip.getCallAnswerHandler(),
 *   onCallReject: voip.getCallRejectHandler(),
 *   onCallHangup: voip.getCallHangupHandler(),
 *   onCallIce: voip.getCallIceHandler(),
 * };
 *
 * // Start an outgoing call
 * const callId = await voip.startCall('PEER123', true);
 *
 * // Listen for events
 * voip.on('state-change', (state, call) => {
 *   console.log('Call state:', state);
 * });
 *
 * voip.on('remote-stream', (stream) => {
 *   videoElement.srcObject = stream;
 * });
 *
 * // End the call
 * voip.hangup();
 * ```
 */
export class VoIPService {
  private peerConnection: RTCPeerConnection | null = null;
  private currentCall: CallInfo | null = null;
  private ringingTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingIceCandidates: RTCIceCandidate[] = [];
  private eventHandlers: Map<keyof VoIPEvents, Set<VoIPEvents[keyof VoIPEvents]>> = new Map();

  constructor(
    private mediaService: MediaService,
    private signaling: VoIPSignaling
  ) {}

  /**
   * Create and configure an RTCPeerConnection.
   */
  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: WEBRTC.ICE_SERVERS,
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && this.currentCall) {
        logger.debug('VoIP', 'Sending ICE candidate');
        this.signaling.sendCallIce(
          this.currentCall.callId,
          this.currentCall.peerId,
          event.candidate
        );
      }
    };

    pc.ontrack = (event) => {
      logger.info('VoIP', 'Received remote track:', event.track.kind);
      if (event.streams[0] && this.currentCall) {
        this.currentCall.remoteStream = event.streams[0];
        this.emit('remote-stream', event.streams[0]);
      }
    };

    pc.onconnectionstatechange = () => {
      logger.info('VoIP', `Connection state changed: ${pc.connectionState}`);
      switch (pc.connectionState) {
        case 'connected':
          this.clearRingingTimeout();
          this.setState('connected');
          if (this.currentCall) {
            this.currentCall.startTime = Date.now();
          }
          break;
        case 'failed':
          logger.error('VoIP', 'Connection failed');
          this.emitError(new VoIPError(
            'Peer connection failed',
            VoIPErrorCodes.VOIP_PEER_CONNECTION_FAILED
          ));
          this.cleanup();
          break;
        case 'disconnected':
          logger.warn('VoIP', 'Connection disconnected');
          // Give it some time to reconnect before ending
          break;
        case 'closed':
          logger.info('VoIP', 'Connection closed');
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      logger.debug('VoIP', `ICE connection state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        logger.error('VoIP', 'ICE connection failed');
        this.emitError(new VoIPError(
          'ICE connection failed',
          VoIPErrorCodes.VOIP_PEER_CONNECTION_FAILED,
          { iceState: pc.iceConnectionState }
        ));
      }
    };

    return pc;
  }

  /**
   * Add local media tracks to the peer connection.
   */
  private addLocalTracks(pc: RTCPeerConnection): void {
    const localStream = this.mediaService.getLocalStream();
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        logger.debug('VoIP', `Adding local track: ${track.kind}`);
        pc.addTrack(track, localStream);
      });
    }
  }

  /**
   * Process any ICE candidates that arrived before the peer connection was ready.
   */
  private async processPendingIceCandidates(): Promise<void> {
    if (!this.peerConnection) return;

    while (this.pendingIceCandidates.length > 0) {
      const candidate = this.pendingIceCandidates.shift();
      if (candidate) {
        try {
          await this.peerConnection.addIceCandidate(candidate);
          logger.debug('VoIP', 'Added pending ICE candidate');
        } catch (error) {
          logger.warn('VoIP', 'Failed to add pending ICE candidate:', error);
        }
      }
    }
  }

  /**
   * Start the ringing timeout. If no answer within CALL.RINGING_TIMEOUT_MS,
   * the call will be automatically ended.
   */
  private startRingingTimeout(): void {
    this.clearRingingTimeout();
    this.ringingTimeout = setTimeout(() => {
      logger.info('VoIP', 'Ringing timeout - no answer');
      if (this.currentCall && this.currentCall.state === 'outgoing') {
        this.signaling.sendCallReject(
          this.currentCall.callId,
          this.currentCall.peerId,
          'timeout'
        );
        this.emitError(new VoIPError(
          'Call timed out',
          VoIPErrorCodes.VOIP_TIMEOUT
        ));
        this.cleanup();
      }
    }, CALL.RINGING_TIMEOUT_MS);
  }

  /**
   * Clear the ringing timeout.
   */
  private clearRingingTimeout(): void {
    if (this.ringingTimeout) {
      clearTimeout(this.ringingTimeout);
      this.ringingTimeout = null;
    }
  }

  /**
   * Update the call state and emit state-change event.
   */
  private setState(state: CallState): void {
    if (this.currentCall) {
      this.currentCall.state = state;
    }
    logger.info('VoIP', `Call state changed: ${state}`);
    this.emit('state-change', state, this.currentCall ? { ...this.currentCall } : null);
  }

  /**
   * Clean up all resources after a call ends.
   */
  private cleanup(): void {
    logger.info('VoIP', 'Cleaning up call resources');

    this.clearRingingTimeout();

    // Stop all media tracks
    this.mediaService.stopAllTracks();

    // Close peer connection
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Clear pending ICE candidates
    this.pendingIceCandidates = [];

    // Set state to ended, then idle
    this.setState('ended');
    this.currentCall = null;
    this.setState('idle');
  }

  /**
   * Handle incoming call offer.
   */
  private handleOffer(message: CallOfferReceivedMessage): void {
    logger.info('VoIP', `Received call offer from ${message.from}`);

    // If already in a call, reject the incoming call
    if (this.currentCall && this.currentCall.state !== 'idle' && this.currentCall.state !== 'ended') {
      logger.info('VoIP', 'Already in call, rejecting incoming call');
      this.signaling.sendCallReject(message.callId, message.from, 'busy');
      return;
    }

    // Create call info for incoming call
    this.currentCall = {
      callId: message.callId,
      peerId: message.from,
      withVideo: message.withVideo,
      state: 'incoming',
      pendingOffer: message.sdp,
    };

    this.setState('incoming');
    this.emit('incoming-call', { ...this.currentCall });

    // Start timeout for answer
    this.startRingingTimeout();
  }

  /**
   * Handle call answer from peer.
   */
  private async handleAnswer(message: CallAnswerReceivedMessage): Promise<void> {
    logger.info('VoIP', `Received call answer from ${message.from}`);

    if (!this.currentCall || this.currentCall.callId !== message.callId) {
      logger.warn('VoIP', 'Received answer for unknown call');
      return;
    }

    if (this.currentCall.state !== 'outgoing') {
      logger.warn('VoIP', `Received answer in wrong state: ${this.currentCall.state}`);
      return;
    }

    this.clearRingingTimeout();
    this.setState('connecting');

    if (!this.peerConnection) {
      logger.error('VoIP', 'No peer connection when receiving answer');
      return;
    }

    try {
      const answer = new RTCSessionDescription({
        type: 'answer',
        sdp: message.sdp,
      });
      await this.peerConnection.setRemoteDescription(answer);
      logger.info('VoIP', 'Set remote description (answer)');

      // Process any pending ICE candidates
      await this.processPendingIceCandidates();
    } catch (error) {
      logger.error('VoIP', 'Failed to set remote description:', error);
      this.emitError(new VoIPError(
        'Failed to establish connection',
        VoIPErrorCodes.VOIP_PEER_CONNECTION_FAILED,
        { error: error instanceof Error ? error.message : String(error) }
      ));
      this.hangup();
    }
  }

  /**
   * Handle call rejection from peer.
   */
  private handleReject(message: CallRejectReceivedMessage): void {
    logger.info('VoIP', `Call rejected by ${message.from}, reason: ${message.reason}`);

    if (!this.currentCall || this.currentCall.callId !== message.callId) {
      logger.warn('VoIP', 'Received reject for unknown call');
      return;
    }

    this.emitError(new VoIPError(
      `Call rejected: ${message.reason || 'declined'}`,
      VoIPErrorCodes.VOIP_INVALID_STATE,
      { reason: message.reason }
    ));

    this.cleanup();
  }

  /**
   * Handle hangup from peer.
   */
  private handleHangup(message: CallHangupReceivedMessage): void {
    logger.info('VoIP', `Call hung up by ${message.from}`);

    if (!this.currentCall || this.currentCall.callId !== message.callId) {
      logger.warn('VoIP', 'Received hangup for unknown call');
      return;
    }

    this.cleanup();
  }

  /**
   * Handle ICE candidate from peer.
   */
  private async handleIce(message: CallIceReceivedMessage): Promise<void> {
    logger.debug('VoIP', `Received ICE candidate from ${message.from}`);

    if (!this.currentCall || this.currentCall.callId !== message.callId) {
      logger.warn('VoIP', 'Received ICE for unknown call');
      return;
    }

    try {
      const candidate = new RTCIceCandidate(JSON.parse(message.candidate));

      if (this.peerConnection && this.peerConnection.remoteDescription) {
        await this.peerConnection.addIceCandidate(candidate);
        logger.debug('VoIP', 'Added ICE candidate');
      } else {
        // Queue the candidate until remote description is set
        this.pendingIceCandidates.push(candidate);
        logger.debug('VoIP', 'Queued ICE candidate');
      }
    } catch (error) {
      logger.warn('VoIP', 'Failed to add ICE candidate:', error);
    }
  }

  /**
   * Emit an error event.
   */
  private emitError(error: VoIPError): void {
    logger.error('VoIP', error.message, error.context);
    this.emit('error', error);
  }

  /**
   * Emit an event to all registered handlers.
   */
  private emit<K extends keyof VoIPEvents>(
    event: K,
    ...args: Parameters<VoIPEvents[K]>
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          (handler as (...args: Parameters<VoIPEvents[K]>) => void)(...args);
        } catch (error) {
          logger.error('VoIP', `Error in event handler for ${event}:`, error);
        }
      });
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Start an outgoing call to a peer.
   *
   * @param peerId - The peer's identifier
   * @param withVideo - Whether to include video
   * @returns The call ID
   * @throws VoIPError if already in a call or media/connection fails
   */
  async startCall(peerId: string, withVideo: boolean): Promise<string> {
    // Check if already in a call
    if (this.currentCall && this.currentCall.state !== 'idle' && this.currentCall.state !== 'ended') {
      throw new VoIPError(
        'Already in a call',
        VoIPErrorCodes.VOIP_ALREADY_IN_CALL
      );
    }

    const callId = generateCallId();
    logger.info('VoIP', `Starting call ${callId} to ${peerId}, video: ${withVideo}`);

    // Create call info
    this.currentCall = {
      callId,
      peerId,
      withVideo,
      state: 'outgoing',
    };
    this.setState('outgoing');

    try {
      // Request local media
      await this.mediaService.requestMedia(withVideo);
      logger.info('VoIP', 'Local media acquired');

      // Create peer connection
      this.peerConnection = this.createPeerConnection();

      // Add local tracks
      this.addLocalTracks(this.peerConnection);

      // Create offer
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      logger.info('VoIP', 'Created and set local description (offer)');

      // Send offer via signaling
      this.signaling.sendCallOffer(
        callId,
        peerId,
        offer.sdp || '',
        withVideo
      );

      // Start ringing timeout
      this.startRingingTimeout();

      return callId;
    } catch (error) {
      logger.error('VoIP', 'Failed to start call:', error);
      this.cleanup();

      if (error instanceof VoIPError) {
        throw error;
      }

      throw new VoIPError(
        'Failed to start call',
        VoIPErrorCodes.VOIP_MEDIA_FAILED,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Accept an incoming call.
   *
   * @param callId - The call ID to accept
   * @param withVideo - Whether to include video (may override caller's request)
   * @throws VoIPError if call not found or not in incoming state
   */
  async acceptCall(callId: string, withVideo: boolean): Promise<void> {
    if (!this.currentCall || this.currentCall.callId !== callId) {
      throw new VoIPError(
        'Call not found',
        VoIPErrorCodes.VOIP_CALL_NOT_FOUND,
        { callId }
      );
    }

    if (this.currentCall.state !== 'incoming') {
      throw new VoIPError(
        'Cannot accept call in current state',
        VoIPErrorCodes.VOIP_INVALID_STATE,
        { state: this.currentCall.state }
      );
    }

    if (!this.currentCall.pendingOffer) {
      throw new VoIPError(
        'No pending offer for call',
        VoIPErrorCodes.VOIP_INVALID_STATE
      );
    }

    logger.info('VoIP', `Accepting call ${callId}, video: ${withVideo}`);

    this.clearRingingTimeout();
    this.setState('connecting');

    try {
      // Request local media
      await this.mediaService.requestMedia(withVideo);
      logger.info('VoIP', 'Local media acquired');

      // Create peer connection
      this.peerConnection = this.createPeerConnection();

      // Add local tracks
      this.addLocalTracks(this.peerConnection);

      // Set remote description (the offer)
      const offer = new RTCSessionDescription({
        type: 'offer',
        sdp: this.currentCall.pendingOffer,
      });
      await this.peerConnection.setRemoteDescription(offer);
      logger.info('VoIP', 'Set remote description (offer)');

      // Process any pending ICE candidates
      await this.processPendingIceCandidates();

      // Create answer
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      logger.info('VoIP', 'Created and set local description (answer)');

      // Send answer via signaling
      this.signaling.sendCallAnswer(
        callId,
        this.currentCall.peerId,
        answer.sdp || ''
      );

      // Clear pending offer
      delete this.currentCall.pendingOffer;
    } catch (error) {
      logger.error('VoIP', 'Failed to accept call:', error);
      this.cleanup();

      if (error instanceof VoIPError) {
        throw error;
      }

      throw new VoIPError(
        'Failed to accept call',
        VoIPErrorCodes.VOIP_MEDIA_FAILED,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Reject an incoming call.
   *
   * @param callId - The call ID to reject
   * @param reason - Optional rejection reason
   */
  rejectCall(callId: string, reason?: 'busy' | 'declined'): void {
    if (!this.currentCall || this.currentCall.callId !== callId) {
      logger.warn('VoIP', `Cannot reject unknown call: ${callId}`);
      return;
    }

    if (this.currentCall.state !== 'incoming') {
      logger.warn('VoIP', `Cannot reject call in state: ${this.currentCall.state}`);
      return;
    }

    logger.info('VoIP', `Rejecting call ${callId}, reason: ${reason || 'declined'}`);

    this.signaling.sendCallReject(
      callId,
      this.currentCall.peerId,
      reason || 'declined'
    );

    this.cleanup();
  }

  /**
   * End the current call.
   */
  hangup(): void {
    if (!this.currentCall || this.currentCall.state === 'idle' || this.currentCall.state === 'ended') {
      logger.info('VoIP', 'No active call to hang up');
      return;
    }

    logger.info('VoIP', `Hanging up call ${this.currentCall.callId}`);

    // Send hangup to peer
    this.signaling.sendCallHangup(
      this.currentCall.callId,
      this.currentCall.peerId
    );

    this.cleanup();
  }

  /**
   * Toggle audio mute state.
   *
   * @returns New muted state (true = muted)
   */
  toggleMute(): boolean {
    return this.mediaService.toggleMute();
  }

  /**
   * Toggle video on/off.
   *
   * @returns New video state (true = video on)
   */
  toggleVideo(): boolean {
    return this.mediaService.toggleVideo();
  }

  /**
   * Get the current call info.
   *
   * @returns Current call info or null if no active call
   */
  getCurrentCall(): CallInfo | null {
    return this.currentCall ? { ...this.currentCall } : null;
  }

  /**
   * Get the local media stream.
   *
   * @returns Local MediaStream or null
   */
  getLocalStream(): MediaStream | null {
    return this.mediaService.getLocalStream();
  }

  /**
   * Get the remote media stream.
   *
   * @returns Remote MediaStream or null
   */
  getRemoteStream(): MediaStream | null {
    return this.currentCall?.remoteStream || null;
  }

  /**
   * Subscribe to VoIP events.
   *
   * @param event - Event name
   * @param handler - Event handler
   * @returns Unsubscribe function
   */
  on<K extends keyof VoIPEvents>(event: K, handler: VoIPEvents[K]): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  /**
   * Remove an event handler.
   *
   * @param event - Event name
   * @param handler - Event handler to remove
   */
  off<K extends keyof VoIPEvents>(event: K, handler: VoIPEvents[K]): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Clean up the service. Call this when disposing of the service.
   */
  dispose(): void {
    this.hangup();
    this.eventHandlers.clear();
  }

  // ============================================================================
  // Signaling Event Handlers
  // These methods return bound handlers to be passed to SignalingClient events
  // ============================================================================

  /**
   * Get the handler for call offer events.
   * Wire this to SignalingEvents.onCallOffer.
   */
  getCallOfferHandler(): (message: CallOfferReceivedMessage) => void {
    return this.handleOffer.bind(this);
  }

  /**
   * Get the handler for call answer events.
   * Wire this to SignalingEvents.onCallAnswer.
   */
  getCallAnswerHandler(): (message: CallAnswerReceivedMessage) => void {
    return this.handleAnswer.bind(this);
  }

  /**
   * Get the handler for call reject events.
   * Wire this to SignalingEvents.onCallReject.
   */
  getCallRejectHandler(): (message: CallRejectReceivedMessage) => void {
    return this.handleReject.bind(this);
  }

  /**
   * Get the handler for call hangup events.
   * Wire this to SignalingEvents.onCallHangup.
   */
  getCallHangupHandler(): (message: CallHangupReceivedMessage) => void {
    return this.handleHangup.bind(this);
  }

  /**
   * Get the handler for call ICE candidate events.
   * Wire this to SignalingEvents.onCallIce.
   */
  getCallIceHandler(): (message: CallIceReceivedMessage) => void {
    return this.handleIce.bind(this);
  }
}
