/**
 * Device Link Service for Web Client
 *
 * Web browsers cannot implement certificate pinning, making them vulnerable
 * to MITM attacks on the signaling server connection. This service allows
 * web clients to link with a mobile app via QR code, similar to WhatsApp Web.
 *
 * Once linked, all messages are proxied through the mobile app's secure,
 * certificate-pinned connection. The web client becomes a UI terminal.
 *
 * Flow:
 * 1. Mobile app displays QR code: zajel-link://{code}:{pubkey}:{server_url}
 * 2. Web client scans QR or enters code manually
 * 3. Web client connects to the mobile's signaling server
 * 4. WebRTC P2P connection established between web and mobile
 * 5. Encrypted tunnel established for message proxying
 */

import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { CRYPTO, PAIRING_CODE } from './constants';

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

export interface LinkData {
  linkCode: string;
  publicKey: string;
  serverUrl: string;
}

export interface DeviceLinkCallbacks {
  onStateChange: (state: DeviceLinkState) => void;
  onMessage: (fromPeerId: string, plaintext: string) => void;
  onPeerStateChange: (peerId: string, state: 'connected' | 'disconnected') => void;
  onError: (error: string) => void;
}

export type DeviceLinkState =
  | 'unlinked'
  | 'connecting'
  | 'handshaking'
  | 'linked'
  | 'disconnected';

/**
 * Parse QR code data into link components.
 * Format: zajel-link://{code}:{pubkey}:{server_url}
 */
export function parseLinkQrData(qrData: string): LinkData | null {
  const protocol = 'zajel-link://';
  if (!qrData.startsWith(protocol)) {
    return null;
  }

  const data = qrData.substring(protocol.length);
  const parts = data.split(':');

  if (parts.length < 3) {
    return null;
  }

  // The server URL might contain colons, so rejoin everything after pubkey
  const serverUrlEncoded = parts.slice(2).join(':');

  try {
    return {
      linkCode: parts[0],
      publicKey: parts[1],
      serverUrl: decodeURIComponent(serverUrlEncoded),
    };
  } catch (error) {
    // URL decoding failed - log for debugging and return null to indicate invalid QR data
    console.warn('Failed to parse QR link data:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Device Link Client
 *
 * Manages the connection between a web client and a mobile app.
 * All messages sent by the web client are encrypted and sent through
 * the tunnel to the mobile app, which then re-encrypts and sends to peers.
 */
export class DeviceLinkClient {
  private state: DeviceLinkState = 'unlinked';
  private callbacks: DeviceLinkCallbacks;

  // Crypto keys for the tunnel
  private privateKey: Uint8Array | null = null;
  private publicKey: Uint8Array | null = null;
  private sessionKey: Uint8Array | null = null;

  // WebRTC connection to mobile app
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;

  // Signaling WebSocket
  private websocket: WebSocket | null = null;

  // Link info
  private linkCode: string | null = null;
  private mobilePublicKey: string | null = null;

  // Sequence counters for replay protection
  private sendCounter = 0;
  private receiveCounter = 0;

  constructor(callbacks: DeviceLinkCallbacks) {
    this.callbacks = callbacks;
    this.generateKeyPair();
  }

  get currentState(): DeviceLinkState {
    return this.state;
  }

  get isLinked(): boolean {
    return this.state === 'linked';
  }

  /**
   * Get our public key as base64 for displaying in UI.
   */
  getPublicKeyBase64(): string {
    if (!this.publicKey) {
      throw new Error('Keys not initialized');
    }
    return btoa(String.fromCharCode(...this.publicKey));
  }

  /**
   * Link to a mobile app using QR code data or manual link code.
   */
  async link(linkData: LinkData): Promise<void> {
    this.setState('connecting');

    this.linkCode = linkData.linkCode;
    this.mobilePublicKey = linkData.publicKey;

    try {
      // Connect to the mobile app's signaling server
      await this.connectToSignaling(linkData.serverUrl);

      // Send link request
      this.sendLinkRequest(linkData.linkCode);
    } catch (error) {
      this.setState('unlinked');
      throw error;
    }
  }

  /**
   * Send a message to a peer (proxied through mobile app).
   */
  async sendMessage(peerId: string, plaintext: string): Promise<void> {
    if (!this.isLinked || !this.dataChannel || !this.sessionKey) {
      throw new Error('Not linked to mobile app');
    }

    // Encrypt message for tunnel
    const encrypted = this.encryptForTunnel(
      JSON.stringify({
        type: 'send_message',
        peerId,
        plaintext,
      })
    );

    // Send as ArrayBuffer to satisfy TypeScript strict typing
    const buffer = new ArrayBuffer(encrypted.byteLength);
    new Uint8Array(buffer).set(encrypted);
    this.dataChannel.send(buffer);
  }

  /**
   * Request peer list from mobile app.
   */
  async requestPeerList(): Promise<void> {
    if (!this.isLinked || !this.dataChannel || !this.sessionKey) {
      throw new Error('Not linked to mobile app');
    }

    const encrypted = this.encryptForTunnel(
      JSON.stringify({ type: 'get_peers' })
    );

    // Send as ArrayBuffer to satisfy TypeScript strict typing
    const buffer = new ArrayBuffer(encrypted.byteLength);
    new Uint8Array(buffer).set(encrypted);
    this.dataChannel.send(buffer);
  }

  /**
   * Disconnect from mobile app.
   */
  disconnect(): void {
    this.cleanup();
    this.setState('unlinked');
  }

  // Private methods

  private generateKeyPair(): void {
    this.privateKey = x25519.utils.randomPrivateKey();
    this.publicKey = x25519.getPublicKey(this.privateKey);
  }

  private setState(newState: DeviceLinkState): void {
    this.state = newState;
    this.callbacks.onStateChange(newState);
  }

  private async connectToSignaling(serverUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Convert HTTP URL to WebSocket URL
      const wsUrl = serverUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:');

      this.websocket = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        this.websocket?.close();
        reject(new Error('Connection timeout'));
      }, 10000);

      // Track if we've received registration confirmation
      let registered = false;

      this.websocket.onopen = () => {
        // Register with a temporary pairing code first
        // The server requires registration before any other messages
        this.registerWithServer();
      };

      this.websocket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to connect to signaling server'));
      };

      this.websocket.onclose = () => {
        if (this.state !== 'unlinked') {
          this.setState('disconnected');
        }
      };

      this.websocket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'registered' && !registered) {
            registered = true;
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch (parseError) {
          // JSON parse error - expected for some message types
          // Only log unexpected errors (not SyntaxError from invalid JSON)
          if (!(parseError instanceof SyntaxError)) {
            console.warn('Unexpected error parsing signaling message:', parseError instanceof Error ? parseError.message : String(parseError));
          }
        }
        this.handleSignalingMessage(event.data);
      };
    });
  }

  /**
   * Register with the signaling server using our pairing code and public key.
   * Required before sending link_request or any other messages.
   */
  private registerWithServer(): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    // Generate a temporary pairing code for registration
    // This is different from the mobile's link code - it's our identifier
    const tempCode = this.generateTempPairingCode();

    this.websocket.send(
      JSON.stringify({
        type: 'register',
        pairingCode: tempCode,
        publicKey: this.getPublicKeyBase64(),
      })
    );
  }

  /**
   * Generate a random 6-character pairing code for web client registration.
   * Uses rejection sampling to avoid modulo bias.
   */
  private generateTempPairingCode(): string {
    return Array.from({ length: PAIRING_CODE.LENGTH }, () =>
      getUnbiasedRandomChar(PAIRING_CODE.CHARS)
    ).join('');
  }

  private sendLinkRequest(linkCode: string): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to signaling server');
    }

    // Send link request with our public key
    const message = {
      type: 'link_request',
      linkCode,
      publicKey: this.getPublicKeyBase64(),
      deviceName: this.getDeviceName(),
    };

    this.websocket.send(JSON.stringify(message));
  }

  private getDeviceName(): string {
    // Detect browser and OS for device name
    const ua = navigator.userAgent;
    let browser = 'Browser';
    let os = 'Unknown';

    if (ua.includes('Chrome')) browser = 'Chrome';
    else if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Safari')) browser = 'Safari';
    else if (ua.includes('Edge')) browser = 'Edge';

    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

    return `${browser} on ${os}`;
  }

  private async handleSignalingMessage(data: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data);
    } catch {
      console.error('Invalid signaling message');
      return;
    }

    const type = message.type as string;

    switch (type) {
      case 'link_matched':
        // Mobile app accepted our link request
        await this.handleLinkMatched(
          message.isInitiator as boolean
        );
        break;

      case 'link_rejected':
        this.callbacks.onError('Link request was rejected');
        this.setState('unlinked');
        break;

      case 'link_timeout':
        this.callbacks.onError('Link request timed out');
        this.setState('unlinked');
        break;

      case 'link_error':
        this.callbacks.onError(message.error as string || 'Link error');
        this.setState('unlinked');
        break;

      case 'offer':
        await this.handleOffer(message.payload as RTCSessionDescriptionInit);
        break;

      case 'answer':
        await this.handleAnswer(message.payload as RTCSessionDescriptionInit);
        break;

      case 'ice_candidate':
        await this.handleIceCandidate(message.payload as RTCIceCandidateInit);
        break;
    }
  }

  private async handleLinkMatched(isInitiator: boolean): Promise<void> {
    this.setState('handshaking');

    // Establish crypto session with mobile app
    this.establishTunnelSession();

    // Create WebRTC connection
    await this.createPeerConnection();

    if (isInitiator) {
      // We create the data channel and send offer
      this.createDataChannel();
      await this.createAndSendOffer();
    }
    // Otherwise wait for offer from mobile app
  }

  private establishTunnelSession(): void {
    if (!this.privateKey || !this.mobilePublicKey) {
      throw new Error('Keys not initialized');
    }

    // Decode mobile's public key
    const mobileKeyBytes = Uint8Array.from(atob(this.mobilePublicKey), (c) =>
      c.charCodeAt(0)
    );

    // Perform ECDH
    const sharedSecret = x25519.getSharedSecret(this.privateKey, mobileKeyBytes);

    // Derive session key using HKDF
    const info = new TextEncoder().encode(`zajel_link_tunnel_${this.linkCode}`);
    this.sessionKey = hkdf(sha256, sharedSecret, undefined, info, 32);
  }

  private async createPeerConnection(): Promise<void> {
    const config: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };

    this.peerConnection = new RTCPeerConnection(config);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.websocket) {
        this.websocket.send(
          JSON.stringify({
            type: 'ice_candidate',
            payload: event.candidate.toJSON(),
          })
        );
      }
    };

    this.peerConnection.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      if (state === 'connected') {
        // Connection established - wait for handshake completion
      } else if (state === 'disconnected' || state === 'failed') {
        this.setState('disconnected');
      }
    };
  }

  private createDataChannel(): void {
    if (!this.peerConnection) {
      throw new Error('Peer connection not created');
    }

    const channel = this.peerConnection.createDataChannel('zajel_link_tunnel', {
      ordered: true,
    });

    this.setupDataChannel(channel);
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;

    channel.onopen = () => {
      // Send handshake to verify keys
      this.sendHandshake();
    };

    channel.onmessage = (event) => {
      this.handleTunnelMessage(event.data);
    };

    channel.onclose = () => {
      if (this.state === 'linked') {
        this.setState('disconnected');
      }
    };
  }

  private sendHandshake(): void {
    if (!this.dataChannel || !this.sessionKey) return;

    const handshake = {
      type: 'handshake',
      publicKey: this.getPublicKeyBase64(),
    };

    // Send unencrypted for initial handshake
    this.dataChannel.send(JSON.stringify(handshake));
  }

  private handleTunnelMessage(data: string | ArrayBuffer): void {
    // Handle handshake messages (unencrypted)
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message.type === 'handshake') {
          // Verify key matches what we got from signaling
          if (message.publicKey === this.mobilePublicKey) {
            this.setState('linked');
          } else {
            this.callbacks.onError('Key verification failed');
            this.disconnect();
          }
          return;
        }
      } catch (parseError) {
        // Not JSON - this is expected for encrypted binary messages
        // Only log at debug level since this is normal operation
        if (parseError instanceof SyntaxError) {
          // Expected: encrypted data is not valid JSON, proceed to decryption
        } else {
          console.warn('Unexpected error parsing tunnel message:', parseError instanceof Error ? parseError.message : String(parseError));
        }
      }
    }

    // Handle encrypted tunnel messages
    try {
      const decrypted = this.decryptFromTunnel(
        typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer)
      );
      const message = JSON.parse(decrypted);

      switch (message.type) {
        case 'message':
          // Message from a peer, forwarded by mobile app
          this.callbacks.onMessage(message.from, message.plaintext);
          break;

        case 'peer_state':
          this.callbacks.onPeerStateChange(message.peerId, message.state);
          break;

        case 'error':
          this.callbacks.onError(message.error);
          break;
      }
    } catch (error) {
      // Decryption or parsing failed - report to user as this indicates a serious issue
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Failed to decrypt tunnel message:', errorMessage);
      // Notify user of decryption failure - this could indicate tampering or key mismatch
      this.callbacks.onError(`Failed to decrypt message: ${errorMessage}`);
    }
  }

  private async createAndSendOffer(): Promise<void> {
    if (!this.peerConnection || !this.websocket) return;

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    this.websocket.send(
      JSON.stringify({
        type: 'offer',
        payload: { type: offer.type, sdp: offer.sdp },
      })
    );
  }

  private async handleOffer(
    payload: RTCSessionDescriptionInit
  ): Promise<void> {
    if (!this.peerConnection || !this.websocket) return;

    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(payload)
    );

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    this.websocket.send(
      JSON.stringify({
        type: 'answer',
        payload: { type: answer.type, sdp: answer.sdp },
      })
    );
  }

  private async handleAnswer(
    payload: RTCSessionDescriptionInit
  ): Promise<void> {
    if (!this.peerConnection) return;

    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(payload)
    );
  }

  private async handleIceCandidate(
    payload: RTCIceCandidateInit
  ): Promise<void> {
    if (!this.peerConnection) return;

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(payload));
    } catch (error) {
      // ICE candidate failures are common during connection negotiation
      // Log for debugging but don't report to user unless connection fails
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('Failed to add ICE candidate (connection may still succeed):', errorMessage);
    }
  }

  private encryptForTunnel(plaintext: string): Uint8Array {
    if (!this.sessionKey) {
      throw new Error('Session not established');
    }

    // Increment sequence counter
    this.sendCounter++;

    // Prepend 4-byte sequence number
    const seqBytes = new Uint8Array(4);
    new DataView(seqBytes.buffer).setUint32(0, this.sendCounter, false);

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const combined = new Uint8Array(4 + plaintextBytes.length);
    combined.set(seqBytes);
    combined.set(plaintextBytes, 4);

    const nonce = crypto.getRandomValues(new Uint8Array(CRYPTO.NONCE_SIZE));
    const cipher = chacha20poly1305(this.sessionKey, nonce);
    const ciphertext = cipher.encrypt(combined);

    // Combine: nonce + ciphertext
    const result = new Uint8Array(nonce.length + ciphertext.length);
    result.set(nonce);
    result.set(ciphertext, nonce.length);

    return result;
  }

  private decryptFromTunnel(data: string | Uint8Array): string {
    if (!this.sessionKey) {
      throw new Error('Session not established');
    }

    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    } else {
      bytes = data;
    }

    const nonce = bytes.slice(0, CRYPTO.NONCE_SIZE);
    const ciphertext = bytes.slice(CRYPTO.NONCE_SIZE);

    const cipher = chacha20poly1305(this.sessionKey, nonce);
    const combined = cipher.decrypt(ciphertext);

    // Verify sequence number (basic replay protection)
    const seq = new DataView(combined.buffer, combined.byteOffset, 4).getUint32(
      0,
      false
    );
    if (seq <= this.receiveCounter) {
      throw new Error('Replay attack detected');
    }
    this.receiveCounter = seq;

    // Extract plaintext
    const plaintextBytes = combined.slice(4);
    return new TextDecoder().decode(plaintextBytes);
  }

  private cleanup(): void {
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.websocket?.close();

    this.dataChannel = null;
    this.peerConnection = null;
    this.websocket = null;
    this.sessionKey = null;
    this.linkCode = null;
    this.mobilePublicKey = null;
    this.sendCounter = 0;
    this.receiveCounter = 0;
  }
}

// Check if there's a stored link session in localStorage
export function getStoredLinkSession(): { deviceId: string } | null {
  try {
    const stored = localStorage.getItem('zajel_link_session');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    // Log storage/parse errors for debugging but don't propagate
    // This is a non-critical operation - users can still link manually
    console.warn('Failed to retrieve stored link session:', error instanceof Error ? error.message : String(error));
  }
  return null;
}

// Store link session for reconnection
export function storeLinkSession(deviceId: string): void {
  try {
    localStorage.setItem(
      'zajel_link_session',
      JSON.stringify({ deviceId })
    );
  } catch (error) {
    // Log storage errors for debugging but don't propagate
    // This is a non-critical operation - the session will work but won't persist
    console.warn('Failed to store link session:', error instanceof Error ? error.message : String(error));
  }
}

// Clear stored link session
export function clearLinkSession(): void {
  try {
    localStorage.removeItem('zajel_link_session');
  } catch (error) {
    // Log storage errors for debugging but don't propagate
    // This is a non-critical operation - session may persist unexpectedly
    console.warn('Failed to clear link session:', error instanceof Error ? error.message : String(error));
  }
}
