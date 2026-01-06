/**
 * Server-to-Server Transport
 *
 * Manages WebSocket connections between federation servers.
 * Handles handshakes with signature verification, message routing,
 * and automatic reconnection.
 */

import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type {
  ServerIdentity,
  MembershipEntry,
  GossipMessage,
  ServerMetadata,
} from '../../types.js';
import { signMessage, verifyMessage, publicKeyFromServerId } from '../../identity/server-identity.js';

export interface ServerConnectionConfig {
  handshakeTimeout: number;     // Time to complete handshake (ms)
  reconnectInterval: number;    // Base reconnect delay (ms)
  reconnectMaxInterval: number; // Max reconnect delay (ms)
  pingInterval: number;         // WebSocket ping interval (ms)
  maxReconnectAttempts: number; // 0 = infinite
}

export interface HandshakePayload {
  type: 'handshake';
  serverId: string;
  nodeId: string;
  endpoint: string;
  publicKey: string;
  metadata: ServerMetadata;
  timestamp: number;
  signature: string;
}

export interface HandshakeAck {
  type: 'handshake_ack';
  serverId: string;
  nodeId: string;
  endpoint: string;
  publicKey: string;
  metadata: ServerMetadata;
  timestamp: number;
  signature: string;
}

export interface ServerConnectionEvents {
  'connected': (entry: MembershipEntry) => void;
  'disconnected': (serverId: string, code: number, reason: string) => void;
  'message': (serverId: string, message: GossipMessage) => void;
  'error': (serverId: string, error: Error) => void;
}

interface PeerConnection {
  ws: WebSocket;
  entry: MembershipEntry;
  isOutgoing: boolean;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  handshakeTimeout: NodeJS.Timeout | null;
}

export class ServerConnectionManager extends EventEmitter {
  private identity: ServerIdentity;
  private endpoint: string;
  private metadata: ServerMetadata;
  private config: ServerConnectionConfig;
  private connections: Map<string, PeerConnection> = new Map();
  private pendingOutgoing: Set<string> = new Set();
  private wss: WebSocketServer | null = null;

  constructor(
    identity: ServerIdentity,
    endpoint: string,
    config: ServerConnectionConfig,
    metadata: ServerMetadata = {}
  ) {
    super();
    this.identity = identity;
    this.endpoint = endpoint;
    this.config = config;
    this.metadata = metadata;
  }

  /**
   * Start listening for incoming connections
   */
  startServer(wss: WebSocketServer): void {
    this.wss = wss;

    wss.on('connection', (ws, req) => {
      this.handleIncomingConnection(ws, req.socket.remoteAddress || 'unknown');
    });
  }

  /**
   * Connect to a peer server
   */
  async connect(entry: MembershipEntry): Promise<void> {
    if (entry.serverId === this.identity.serverId) {
      return; // Don't connect to ourselves
    }

    if (this.connections.has(entry.serverId) || this.pendingOutgoing.has(entry.serverId)) {
      return; // Already connected or connecting
    }

    this.pendingOutgoing.add(entry.serverId);

    try {
      await this.initiateConnection(entry);
    } catch (error) {
      this.pendingOutgoing.delete(entry.serverId);
      throw error;
    }
  }

  /**
   * Disconnect from a peer
   */
  disconnect(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    this.cleanupConnection(serverId, conn);
    conn.ws.close(1000, 'Disconnecting');
    this.connections.delete(serverId);
  }

  /**
   * Send a message to a specific peer
   */
  async send(serverId: string, message: GossipMessage): Promise<boolean> {
    const conn = this.connections.get(serverId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      conn.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`[Transport] Failed to send to ${serverId}:`, error);
      return false;
    }
  }

  /**
   * Broadcast a message to all connected peers
   */
  async broadcast(message: GossipMessage, exclude: string[] = []): Promise<number> {
    let sent = 0;
    const promises: Promise<boolean>[] = [];

    for (const [serverId, conn] of this.connections) {
      if (exclude.includes(serverId)) continue;
      if (conn.ws.readyState === WebSocket.OPEN) {
        promises.push(this.send(serverId, message));
      }
    }

    const results = await Promise.all(promises);
    sent = results.filter(Boolean).length;
    return sent;
  }

  /**
   * Get connected server IDs
   */
  getConnectedServers(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Check if connected to a server
   */
  isConnected(serverId: string): boolean {
    const conn = this.connections.get(serverId);
    return conn !== undefined && conn.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection count
   */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Shutdown all connections
   */
  shutdown(): void {
    for (const [serverId, conn] of this.connections) {
      this.cleanupConnection(serverId, conn);
      conn.ws.close(1001, 'Server shutting down');
    }
    this.connections.clear();
    this.pendingOutgoing.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  /**
   * Initiate outgoing connection to a peer
   */
  private async initiateConnection(entry: MembershipEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(entry.endpoint);

      const handshakeTimer = setTimeout(() => {
        ws.close();
        this.pendingOutgoing.delete(entry.serverId);
        reject(new Error(`Handshake timeout connecting to ${entry.serverId}`));
      }, this.config.handshakeTimeout);

      ws.on('open', async () => {
        try {
          // Send our handshake
          const handshake = await this.createHandshake();
          ws.send(JSON.stringify(handshake));
        } catch (error) {
          clearTimeout(handshakeTimer);
          ws.close();
          this.pendingOutgoing.delete(entry.serverId);
          reject(error);
        }
      });

      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'handshake_ack') {
            clearTimeout(handshakeTimer);

            // Verify the handshake ack
            const verified = await this.verifyHandshake(message);
            if (!verified) {
              ws.close(4001, 'Invalid handshake signature');
              this.pendingOutgoing.delete(entry.serverId);
              reject(new Error('Invalid handshake signature'));
              return;
            }

            // Verify it matches who we expected
            if (message.serverId !== entry.serverId) {
              ws.close(4002, 'Server ID mismatch');
              this.pendingOutgoing.delete(entry.serverId);
              reject(new Error('Server ID mismatch'));
              return;
            }

            // Connection established
            this.pendingOutgoing.delete(entry.serverId);
            this.setupConnection(entry.serverId, ws, entry, true);
            resolve();
          }
        } catch (error) {
          clearTimeout(handshakeTimer);
          ws.close();
          this.pendingOutgoing.delete(entry.serverId);
          reject(error);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(handshakeTimer);
        this.pendingOutgoing.delete(entry.serverId);
        reject(error);
      });

      ws.on('close', () => {
        clearTimeout(handshakeTimer);
        this.pendingOutgoing.delete(entry.serverId);
      });
    });
  }

  /**
   * Handle incoming connection from a peer
   */
  private handleIncomingConnection(ws: WebSocket, remoteAddr: string): void {
    let serverId: string | null = null;

    const handshakeTimer = setTimeout(() => {
      ws.close(4000, 'Handshake timeout');
    }, this.config.handshakeTimeout);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'handshake' && !serverId) {
          // Verify incoming handshake
          const verified = await this.verifyHandshake(message);
          if (!verified) {
            clearTimeout(handshakeTimer);
            ws.close(4001, 'Invalid handshake signature');
            return;
          }

          const peerServerId = message.serverId;
          serverId = peerServerId;

          // Check for existing connection
          const existing = this.connections.get(peerServerId);
          if (existing) {
            // Connection tiebreaker: lower server ID wins outgoing
            if (this.identity.serverId < peerServerId) {
              // We should be the one with outgoing, close this incoming
              clearTimeout(handshakeTimer);
              ws.close(4003, 'Duplicate connection');
              return;
            } else {
              // They should have outgoing, close our existing
              this.cleanupConnection(peerServerId, existing);
              existing.ws.close(4003, 'Duplicate connection');
              this.connections.delete(peerServerId);
            }
          }

          // Send handshake ack
          const ack = await this.createHandshakeAck();
          ws.send(JSON.stringify(ack));

          clearTimeout(handshakeTimer);

          // Create membership entry from handshake
          const entry: MembershipEntry = {
            serverId: message.serverId,
            nodeId: message.nodeId,
            endpoint: message.endpoint,
            publicKey: new Uint8Array(Buffer.from(message.publicKey, 'base64')),
            status: 'alive',
            incarnation: 0,
            lastSeen: Date.now(),
            metadata: message.metadata || {},
          };

          this.setupConnection(peerServerId, ws, entry, false);
        } else if (serverId && message.type === 'gossip') {
          // Regular gossip message
          this.emit('message', serverId, message);
        }
      } catch (error) {
        console.error('[Transport] Error handling message:', error);
      }
    });

    ws.on('error', (error) => {
      console.error('[Transport] Incoming connection error:', error);
      clearTimeout(handshakeTimer);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(handshakeTimer);
      if (serverId) {
        this.handleDisconnect(serverId, code, reason.toString());
      }
    });
  }

  /**
   * Setup a verified connection
   */
  private setupConnection(
    serverId: string,
    ws: WebSocket,
    entry: MembershipEntry,
    isOutgoing: boolean
  ): void {
    // Start ping interval
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, this.config.pingInterval);

    const conn: PeerConnection = {
      ws,
      entry,
      isOutgoing,
      reconnectAttempts: 0,
      reconnectTimer: null,
      pingTimer,
      handshakeTimeout: null,
    };

    this.connections.set(serverId, conn);

    // Setup message handler for established connection
    ws.on('message', (data: RawData) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'gossip') {
          this.emit('message', serverId, message);
        }
      } catch (error) {
        console.error('[Transport] Error parsing message:', error);
      }
    });

    ws.on('close', (code, reason) => {
      this.handleDisconnect(serverId, code, reason.toString());
    });

    ws.on('error', (error) => {
      this.emit('error', serverId, error);
    });

    this.emit('connected', entry);
  }

  /**
   * Handle connection disconnect
   */
  private handleDisconnect(serverId: string, code: number, reason: string): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    this.cleanupConnection(serverId, conn);
    this.connections.delete(serverId);

    this.emit('disconnected', serverId, code, reason);

    // Only attempt reconnect for outgoing connections
    if (conn.isOutgoing && this.config.maxReconnectAttempts !== 0) {
      if (
        this.config.maxReconnectAttempts === 0 ||
        conn.reconnectAttempts < this.config.maxReconnectAttempts
      ) {
        this.scheduleReconnect(conn.entry, conn.reconnectAttempts + 1);
      }
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(entry: MembershipEntry, attempt: number): void {
    // Exponential backoff with jitter
    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(2, attempt - 1) + Math.random() * 1000,
      this.config.reconnectMaxInterval
    );

    setTimeout(async () => {
      try {
        await this.connect(entry);
      } catch (error) {
        console.error(`[Transport] Reconnect to ${entry.serverId} failed:`, error);
      }
    }, delay);
  }

  /**
   * Cleanup connection resources
   */
  private cleanupConnection(serverId: string, conn: PeerConnection): void {
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.handshakeTimeout) {
      clearTimeout(conn.handshakeTimeout);
      conn.handshakeTimeout = null;
    }
  }

  /**
   * Create handshake message
   */
  private async createHandshake(): Promise<HandshakePayload> {
    const timestamp = Date.now();
    const toSign = JSON.stringify({
      serverId: this.identity.serverId,
      nodeId: this.identity.nodeId,
      endpoint: this.endpoint,
      publicKey: Buffer.from(this.identity.publicKey).toString('base64'),
      metadata: this.metadata,
      timestamp,
    });

    const signature = await signMessage(this.identity, toSign);

    return {
      type: 'handshake',
      serverId: this.identity.serverId,
      nodeId: this.identity.nodeId,
      endpoint: this.endpoint,
      publicKey: Buffer.from(this.identity.publicKey).toString('base64'),
      metadata: this.metadata,
      timestamp,
      signature,
    };
  }

  /**
   * Create handshake acknowledgment
   */
  private async createHandshakeAck(): Promise<HandshakeAck> {
    const timestamp = Date.now();
    const toSign = JSON.stringify({
      serverId: this.identity.serverId,
      nodeId: this.identity.nodeId,
      endpoint: this.endpoint,
      publicKey: Buffer.from(this.identity.publicKey).toString('base64'),
      metadata: this.metadata,
      timestamp,
    });

    const signature = await signMessage(this.identity, toSign);

    return {
      type: 'handshake_ack',
      serverId: this.identity.serverId,
      nodeId: this.identity.nodeId,
      endpoint: this.endpoint,
      publicKey: Buffer.from(this.identity.publicKey).toString('base64'),
      metadata: this.metadata,
      timestamp,
      signature,
    };
  }

  /**
   * Verify handshake/handshake_ack signature
   */
  private async verifyHandshake(
    message: HandshakePayload | HandshakeAck
  ): Promise<boolean> {
    try {
      const { signature, type, ...rest } = message;
      const toVerify = JSON.stringify(rest);
      const publicKey = publicKeyFromServerId(message.serverId);
      return await verifyMessage(toVerify, signature, publicKey);
    } catch {
      return false;
    }
  }
}
