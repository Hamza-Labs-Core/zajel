import type {
  ClientMessage,
  ServerMessage,
  ConnectionState,
} from './protocol';

const PING_INTERVAL = 25000; // 25 seconds
const RECONNECT_DELAY = 3000;
const PAIRING_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface SignalingEvents {
  onStateChange: (state: ConnectionState) => void;
  onPairIncoming: (fromCode: string, fromPublicKey: string) => void;
  onPairMatched: (peerCode: string, peerPublicKey: string, isInitiator: boolean) => void;
  onPairRejected: (peerCode: string) => void;
  onPairTimeout: (peerCode: string) => void;
  onPairError: (error: string) => void;
  onOffer: (from: string, payload: RTCSessionDescriptionInit) => void;
  onAnswer: (from: string, payload: RTCSessionDescriptionInit) => void;
  onIceCandidate: (from: string, payload: RTCIceCandidateInit) => void;
  onError: (error: string) => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private myCode: string = '';
  private myPublicKey: string = '';
  private pingInterval: number | null = null;
  private reconnectTimeout: number | null = null;
  private state: ConnectionState = 'disconnected';
  private events: SignalingEvents;

  constructor(serverUrl: string, events: SignalingEvents) {
    this.serverUrl = serverUrl;
    this.events = events;
  }

  private generatePairingCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes)
      .map((b) => PAIRING_CODE_CHARS[b % PAIRING_CODE_CHARS.length])
      .join('');
  }

  private setState(state: ConnectionState): void {
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
    this.setState('connecting');

    this.ws = new WebSocket(this.serverUrl);

    this.ws.onopen = () => {
      this.register();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        this.handleMessage(message);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
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
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.state === 'disconnected' && this.myPublicKey) {
        this.connect(this.myPublicKey);
      }
    }, RECONNECT_DELAY);
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'registered':
        this.setState('registered');
        break;

      case 'pair_incoming':
        this.setState('pending_approval');
        this.events.onPairIncoming(message.fromCode, message.fromPublicKey);
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
    }
  }

  // Public methods for pairing
  requestPairing(targetCode: string): void {
    this.setState('waiting_approval');
    this.send({ type: 'pair_request', targetCode });
  }

  respondToPairing(targetCode: string, accepted: boolean): void {
    this.send({ type: 'pair_response', targetCode, accepted });
    if (!accepted) {
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
}
