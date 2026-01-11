import type { SignalingClient } from './signaling';
import type {
  HandshakeMessage,
  ChunkAckMessage,
  ChunkRetryRequestMessage,
  FileStartAckMessage,
  FileCompleteAckMessage,
  TransferCancelMessage,
} from './protocol';
import { validateHandshake, validateDataChannelMessage, safeJsonParse } from './validation';
import { WEBRTC, MESSAGE_LIMITS } from './constants';


// Buffer management constants for backpressure handling
// Based on WebRTC best practices: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount
const HIGH_WATER_MARK = 1024 * 1024;      // 1MB - pause sending when buffer exceeds this
const LOW_WATER_MARK = 256 * 1024;        // 256KB - resume sending when buffer drops below this
const BUFFER_DRAIN_TIMEOUT = 30000;       // 30s timeout to prevent infinite waits

export interface WebRTCEvents {
  onStateChange: (state: RTCPeerConnectionState) => void;
  onHandshake: (publicKey: string) => void;
  onMessage: (data: string) => void;
  // Legacy file transfer events (still supported)
  onFileStart: (fileId: string, fileName: string, totalSize: number, totalChunks: number, chunkHashes?: string[]) => void;
  onFileChunk: (fileId: string, chunkIndex: number, data: string, hash?: string) => void;
  onFileComplete: (fileId: string, fileHash?: string) => void;
  onFileError: (fileId: string, error: string) => void;
  // New reliable transfer protocol events
  onFileStartAck?: (msg: FileStartAckMessage) => void;
  onChunkAck?: (msg: ChunkAckMessage) => void;
  onChunkRetryRequest?: (msg: ChunkRetryRequestMessage) => void;
  onFileCompleteAck?: (msg: FileCompleteAckMessage) => void;
  onTransferCancel?: (msg: TransferCancelMessage) => void;
}

export class WebRTCService {
  private pc: RTCPeerConnection | null = null;
  private messageChannel: RTCDataChannel | null = null;
  private fileChannel: RTCDataChannel | null = null;
  private signaling: SignalingClient;
  private peerCode: string = '';
  private events: WebRTCEvents;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  constructor(signaling: SignalingClient, events: WebRTCEvents) {
    this.signaling = signaling;
    this.events = events;
  }

  async connect(peerCode: string, isInitiator: boolean): Promise<void> {
    this.peerCode = peerCode;
    this.close();

    this.pc = new RTCPeerConnection({ iceServers: WEBRTC.ICE_SERVERS });

    // ICE candidate handling
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(this.peerCode, event.candidate.toJSON());
      }
    };

    // Connection state
    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        this.events.onStateChange(this.pc.connectionState);
      }
    };

    // Data channel handling for responder
    this.pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === WEBRTC.CHANNELS.MESSAGES) {
        this.messageChannel = channel;
        this.setupMessageChannel(channel);
      } else if (channel.label === WEBRTC.CHANNELS.FILES) {
        this.fileChannel = channel;
        this.setupFileChannel(channel);
      }
    };

    if (isInitiator) {
      // Create data channels as initiator
      this.messageChannel = this.pc.createDataChannel(WEBRTC.CHANNELS.MESSAGES, {
        ordered: true,
      });
      this.setupMessageChannel(this.messageChannel);

      this.fileChannel = this.pc.createDataChannel(WEBRTC.CHANNELS.FILES, {
        ordered: true,
      });
      this.setupFileChannel(this.fileChannel);

      // Create and send offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.sendOffer(peerCode, offer);
    }

    // NOTE: Pending ICE candidates are NOT processed here.
    // They will be processed when remote description is set in handleOffer() or handleAnswer().
    // This prevents the race condition where candidates arrive before setRemoteDescription() is called.
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;

    await this.pc.setRemoteDescription(offer);
    this.remoteDescriptionSet = true;

    // Process any pending ICE candidates now that remote description is set
    await this.processPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendAnswer(this.peerCode, answer);
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(answer);
    this.remoteDescriptionSet = true;

    // Process any pending ICE candidates now that remote description is set
    await this.processPendingCandidates();
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    // Queue candidate if connection not ready OR remote description not set
    if (!this.pc || !this.remoteDescriptionSet) {
      if (this.pendingCandidates.length >= WEBRTC.MAX_PENDING_ICE_CANDIDATES) {
        console.warn('ICE candidate queue full, dropping oldest candidate');
        this.pendingCandidates.shift();
      }
      this.pendingCandidates.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn('Failed to add ICE candidate:', e);
    }
  }

  /**
   * Processes any queued ICE candidates after remote description has been set.
   * This is called from handleOffer() and handleAnswer() to drain the queue.
   */
  private async processPendingCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates) {
      try {
        await this.pc?.addIceCandidate(candidate);
      } catch (e) {
        console.warn('Failed to add pending ICE candidate:', e);
      }
    }
    this.pendingCandidates = [];
  }

  private setupMessageChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log('Message channel open');
    };

    channel.onmessage = (event) => {
      // Check data size before processing
      const dataSize = typeof event.data === 'string'
        ? event.data.length
        : event.data.byteLength || 0;
      if (dataSize > MESSAGE_LIMITS.MAX_DATA_CHANNEL_MESSAGE_SIZE) {
        console.error('Rejected message channel data: exceeds 1MB size limit');
        return;
      }

      // Try to parse as JSON for handshake validation
      const parsed = safeJsonParse(event.data);
      if (parsed !== null) {
        // Check if it's a handshake message with proper validation
        const handshakeResult = validateHandshake(parsed);
        if (handshakeResult.success) {
          this.events.onHandshake(handshakeResult.data.publicKey);
          return;
        }
        // Not a valid handshake, could be some other JSON - treat as message
      }

      // Regular encrypted message (not JSON or not handshake)
      this.events.onMessage(event.data);
    };

    channel.onerror = (error) => {
      console.error('Message channel error:', error);
    };
  }

  private setupFileChannel(channel: RTCDataChannel): void {
    channel.onmessage = (event) => {
      // Check data size before processing
      const dataSize = typeof event.data === 'string'
        ? event.data.length
        : event.data.byteLength || 0;
      if (dataSize > MESSAGE_LIMITS.MAX_DATA_CHANNEL_MESSAGE_SIZE) {
        console.error('Rejected file channel data: exceeds 1MB size limit');
        return;
      }

      // Parse JSON safely
      const parsed = safeJsonParse(event.data);
      if (parsed === null) {
        console.error('Failed to parse file channel message as JSON');
        return;
      }

      // Validate message structure
      const result = validateDataChannelMessage(parsed);
      if (!result.success) {
        console.warn('Invalid file channel message:', result.error);
        return;
      }

      const message = result.data;
      switch (message.type) {
        case 'file_start':
          this.events.onFileStart(
            message.fileId,
            message.fileName,
            message.totalSize,
            message.totalChunks,
            message.chunkHashes
          );
          break;
        case 'file_chunk':
          this.events.onFileChunk(message.fileId, message.chunkIndex, message.data, message.hash);
          break;
        case 'file_complete':
          this.events.onFileComplete(message.fileId, message.fileHash);
          break;
        case 'file_error':
          this.events.onFileError(message.fileId, message.error);
          break;
        case 'file_start_ack':
          this.events.onFileStartAck?.(message as FileStartAckMessage);
          break;
        case 'chunk_ack':
          this.events.onChunkAck?.(message as ChunkAckMessage);
          break;
        case 'chunk_retry':
          this.events.onChunkRetryRequest?.(message as ChunkRetryRequestMessage);
          break;
        case 'file_complete_ack':
          this.events.onFileCompleteAck?.(message as FileCompleteAckMessage);
          break;
        case 'transfer_cancel':
          this.events.onTransferCancel?.(message as TransferCancelMessage);
          break;
        case 'handshake':
          // Handshake should not come on file channel, ignore
          console.warn('Received handshake on file channel, ignoring');
          break;
      }
    };
  }

  sendHandshake(publicKey: string): void {
    if (this.messageChannel?.readyState === 'open') {
      const msg: HandshakeMessage = { type: 'handshake', publicKey };
      this.messageChannel.send(JSON.stringify(msg));
    }
  }

  sendMessage(encryptedData: string): void {
    if (this.messageChannel?.readyState === 'open') {
      this.messageChannel.send(encryptedData);
    }
  }

  /**
   * Sends a file_start message to initiate a file transfer.
   * Returns true if sent successfully, false if channel not open.
   */
  sendFileStart(
    fileId: string,
    fileName: string,
    totalSize: number,
    totalChunks: number,
    chunkHashes?: string[]
  ): boolean {
    if (this.fileChannel?.readyState !== 'open') {
      return false;
    }
    try {
      this.fileChannel.send(
        JSON.stringify({
          type: 'file_start',
          fileId,
          fileName,
          totalSize,
          totalChunks,
          chunkHashes,
        })
      );
      return true;
    } catch (e) {
      console.error('Failed to send file_start:', e);
      return false;
    }
  }

  /**
   * Sends a file chunk with backpressure handling.
   * Returns a promise that resolves to true when sent, false if channel is not available.
   * The promise waits for the buffer to drain if it exceeds the high water mark.
   */
  async sendFileChunk(
    fileId: string,
    chunkIndex: number,
    data: string,
    hash?: string
  ): Promise<boolean> {
    if (this.fileChannel?.readyState !== 'open') {
      return false;
    }

    // Wait for buffer to drain if it's too full
    await this.waitForBufferDrain();

    // Check again after waiting - channel might have closed
    if (this.fileChannel?.readyState !== 'open') {
      return false;
    }

    try {
      this.fileChannel.send(
        JSON.stringify({
          type: 'file_chunk',
          fileId,
          chunkIndex,
          data,
          hash,
        })
      );
      return true;
    } catch (error) {
      console.error('Failed to send file chunk:', error);
      return false;
    }
  }

  /**
   * Waits for the file channel buffer to drain below the high water mark.
   * Uses the bufferedamountlow event for efficient waiting instead of polling.
   */
  private waitForBufferDrain(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.fileChannel) {
        resolve();
        return;
      }

      // Check if buffer is already below threshold
      if (this.fileChannel.bufferedAmount <= HIGH_WATER_MARK) {
        resolve();
        return;
      }

      // Set up threshold-based resume using bufferedamountlow event
      this.fileChannel.bufferedAmountLowThreshold = LOW_WATER_MARK;

      let resolved = false;

      const onBufferLow = () => {
        if (resolved) return;
        resolved = true;
        this.fileChannel?.removeEventListener('bufferedamountlow', onBufferLow);
        resolve();
      };

      this.fileChannel.addEventListener('bufferedamountlow', onBufferLow);

      // Safety timeout to prevent infinite wait if channel closes or event never fires
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.fileChannel?.removeEventListener('bufferedamountlow', onBufferLow);
        resolve();
      }, BUFFER_DRAIN_TIMEOUT);
    });
  }

  sendFileComplete(fileId: string, fileHash?: string): void {
    if (this.fileChannel?.readyState === 'open') {
      this.fileChannel.send(JSON.stringify({ type: 'file_complete', fileId, fileHash }));
    }
  }

  sendFileError(fileId: string, error: string): void {
    if (this.fileChannel?.readyState === 'open') {
      this.fileChannel.send(JSON.stringify({ type: 'file_error', fileId, error }));
    }
  }

  // New reliable transfer protocol methods

  sendFileStartAck(fileId: string, accepted: boolean, reason?: string): boolean {
    if (this.fileChannel?.readyState !== 'open') {
      return false;
    }
    try {
      const msg: FileStartAckMessage = { type: 'file_start_ack', fileId, accepted, reason };
      this.fileChannel.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error('Failed to send file_start_ack:', e);
      return false;
    }
  }

  sendChunkAck(
    fileId: string,
    chunkIndex: number,
    status: 'received' | 'failed',
    hash?: string
  ): boolean {
    if (this.fileChannel?.readyState !== 'open') {
      return false;
    }
    try {
      const msg: ChunkAckMessage = { type: 'chunk_ack', fileId, chunkIndex, status, hash };
      this.fileChannel.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error('Failed to send chunk_ack:', e);
      return false;
    }
  }

  sendChunkRetryRequest(fileId: string, chunkIndices: number[]): boolean {
    if (this.fileChannel?.readyState !== 'open') {
      return false;
    }
    try {
      const msg: ChunkRetryRequestMessage = { type: 'chunk_retry', fileId, chunkIndices };
      this.fileChannel.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error('Failed to send chunk_retry:', e);
      return false;
    }
  }

  sendFileCompleteAck(
    fileId: string,
    status: 'success' | 'failed',
    missingChunks?: number[],
    fileHash?: string
  ): boolean {
    if (this.fileChannel?.readyState !== 'open') {
      return false;
    }
    try {
      const msg: FileCompleteAckMessage = {
        type: 'file_complete_ack',
        fileId,
        status,
        missingChunks,
        fileHash,
      };
      this.fileChannel.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error('Failed to send file_complete_ack:', e);
      return false;
    }
  }

  sendTransferCancel(
    fileId: string,
    reason: 'user_cancelled' | 'error' | 'timeout'
  ): boolean {
    if (this.fileChannel?.readyState !== 'open') {
      return false;
    }
    try {
      const msg: TransferCancelMessage = { type: 'transfer_cancel', fileId, reason };
      this.fileChannel.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error('Failed to send transfer_cancel:', e);
      return false;
    }
  }

  get isConnected(): boolean {
    return this.pc?.connectionState === 'connected';
  }

  get messageChannelOpen(): boolean {
    return this.messageChannel?.readyState === 'open';
  }

  /**
   * Returns the current buffered amount for the file channel.
   * Useful for monitoring buffer state during transfers.
   */
  get fileChannelBufferedAmount(): number {
    return this.fileChannel?.bufferedAmount ?? 0;
  }

  /**
   * Returns true if the file channel buffer is above the high water mark.
   * When true, sending should be paused to allow the buffer to drain.
   */
  get isFileChannelBufferFull(): boolean {
    return (this.fileChannel?.bufferedAmount ?? 0) > HIGH_WATER_MARK;
  }

  close(): void {
    this.messageChannel?.close();
    this.fileChannel?.close();
    this.pc?.close();
    this.messageChannel = null;
    this.fileChannel = null;
    this.pc = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
  }
}
