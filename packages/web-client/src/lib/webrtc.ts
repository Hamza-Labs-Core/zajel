import type { SignalingClient } from './signaling';
import type { HandshakeMessage } from './protocol';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const MESSAGE_CHANNEL = 'messages';
const FILE_CHANNEL = 'files';

export interface WebRTCEvents {
  onStateChange: (state: RTCPeerConnectionState) => void;
  onHandshake: (publicKey: string) => void;
  onMessage: (data: string) => void;
  onFileStart: (fileId: string, fileName: string, totalSize: number, totalChunks: number) => void;
  onFileChunk: (fileId: string, chunkIndex: number, data: string) => void;
  onFileComplete: (fileId: string) => void;
}

export class WebRTCService {
  private pc: RTCPeerConnection | null = null;
  private messageChannel: RTCDataChannel | null = null;
  private fileChannel: RTCDataChannel | null = null;
  private signaling: SignalingClient;
  private peerCode: string = '';
  private events: WebRTCEvents;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(signaling: SignalingClient, events: WebRTCEvents) {
    this.signaling = signaling;
    this.events = events;
  }

  async connect(peerCode: string, isInitiator: boolean): Promise<void> {
    this.peerCode = peerCode;
    this.close();

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

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
      if (channel.label === MESSAGE_CHANNEL) {
        this.messageChannel = channel;
        this.setupMessageChannel(channel);
      } else if (channel.label === FILE_CHANNEL) {
        this.fileChannel = channel;
        this.setupFileChannel(channel);
      }
    };

    if (isInitiator) {
      // Create data channels as initiator
      this.messageChannel = this.pc.createDataChannel(MESSAGE_CHANNEL, {
        ordered: true,
      });
      this.setupMessageChannel(this.messageChannel);

      this.fileChannel = this.pc.createDataChannel(FILE_CHANNEL, {
        ordered: true,
      });
      this.setupFileChannel(this.fileChannel);

      // Create and send offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.sendOffer(peerCode, offer);
    }

    // Add any pending ICE candidates
    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingCandidates = [];
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;

    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendAnswer(this.peerCode, answer);
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(answer);
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) {
      // Queue candidate if connection not ready
      this.pendingCandidates.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn('Failed to add ICE candidate:', e);
    }
  }

  private setupMessageChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log('Message channel open');
    };

    channel.onmessage = (event) => {
      try {
        // Check if it's a handshake message
        const data = JSON.parse(event.data);
        if (data.type === 'handshake') {
          this.events.onHandshake(data.publicKey);
        } else {
          // Regular encrypted message
          this.events.onMessage(event.data);
        }
      } catch {
        // Not JSON, treat as encrypted message
        this.events.onMessage(event.data);
      }
    };

    channel.onerror = (error) => {
      console.error('Message channel error:', error);
    };
  }

  private setupFileChannel(channel: RTCDataChannel): void {
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'file_start':
            this.events.onFileStart(
              data.fileId,
              data.fileName,
              data.totalSize,
              data.totalChunks
            );
            break;
          case 'file_chunk':
            this.events.onFileChunk(data.fileId, data.chunkIndex, data.data);
            break;
          case 'file_complete':
            this.events.onFileComplete(data.fileId);
            break;
        }
      } catch (e) {
        console.error('Failed to parse file message:', e);
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

  sendFileStart(
    fileId: string,
    fileName: string,
    totalSize: number,
    totalChunks: number
  ): void {
    if (this.fileChannel?.readyState === 'open') {
      this.fileChannel.send(
        JSON.stringify({
          type: 'file_start',
          fileId,
          fileName,
          totalSize,
          totalChunks,
        })
      );
    }
  }

  sendFileChunk(fileId: string, chunkIndex: number, data: string): void {
    if (this.fileChannel?.readyState === 'open') {
      this.fileChannel.send(
        JSON.stringify({
          type: 'file_chunk',
          fileId,
          chunkIndex,
          data,
        })
      );
    }
  }

  sendFileComplete(fileId: string): void {
    if (this.fileChannel?.readyState === 'open') {
      this.fileChannel.send(JSON.stringify({ type: 'file_complete', fileId }));
    }
  }

  get isConnected(): boolean {
    return this.pc?.connectionState === 'connected';
  }

  get messageChannelOpen(): boolean {
    return this.messageChannel?.readyState === 'open';
  }

  close(): void {
    this.messageChannel?.close();
    this.fileChannel?.close();
    this.pc?.close();
    this.messageChannel = null;
    this.fileChannel = null;
    this.pc = null;
    this.pendingCandidates = [];
  }
}
