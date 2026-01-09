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

export interface ClientHandlerConfig {
  heartbeatInterval: number;   // Expected heartbeat interval from clients
  heartbeatTimeout: number;    // Time before considering client dead
  maxConnectionsPerPeer: number;
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

type ClientMessage =
  | RegisterMessage
  | UpdateLoadMessage
  | RegisterRendezvousMessage
  | GetRelaysMessage
  | HeartbeatMessage
  | PingMessage
  | SignalingRegisterMessage
  | SignalingOfferMessage
  | SignalingAnswerMessage
  | SignalingIceCandidateMessage;

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
   * Handle incoming WebSocket message
   */
  async handleMessage(ws: WebSocket, data: string): Promise<void> {
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

        case 'offer':
          this.handleSignalingForward(ws, message as SignalingOfferMessage);
          break;

        case 'answer':
          this.handleSignalingForward(ws, message as SignalingAnswerMessage);
          break;

        case 'ice_candidate':
          this.handleSignalingForward(ws, message as SignalingIceCandidateMessage);
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
    const { pairingCode } = message;

    if (!pairingCode) {
      this.sendError(ws, 'Missing required field: pairingCode');
      return;
    }

    // Store pairing code -> WebSocket mapping
    this.pairingCodeToWs.set(pairingCode, ws);
    this.wsToPairingCode.set(ws, pairingCode);

    console.log(`[ClientHandler] Registered pairing code: ${pairingCode}`);

    // Send confirmation
    this.send(ws, {
      type: 'registered',
      pairingCode,
      serverId: this.identity.serverId,
    });
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

    // Find target WebSocket
    const targetWs = this.pairingCodeToWs.get(target);

    if (!targetWs) {
      console.log(`[ClientHandler] Target not found for ${type}: ${target}`);
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
      console.log(`[ClientHandler] Forwarded ${type} from ${senderPairingCode} to ${target}`);
    } else {
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
    // Clean up pairing code mappings (for signaling clients)
    const pairingCode = this.wsToPairingCode.get(ws);
    if (pairingCode) {
      this.pairingCodeToWs.delete(pairingCode);
      this.wsToPairingCode.delete(ws);
      console.log(`[ClientHandler] Pairing code disconnected: ${pairingCode}`);
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

    return stale.length;
  }

  /**
   * Shutdown - disconnect all clients
   */
  async shutdown(): Promise<void> {
    // Close all relay clients
    for (const [peerId, client] of this.clients) {
      try {
        client.ws.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors
      }
    }
    this.clients.clear();
    this.wsToClient.clear();

    // Close all signaling clients
    for (const [pairingCode, ws] of this.pairingCodeToWs) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors
      }
    }
    this.pairingCodeToWs.clear();
    this.wsToPairingCode.clear();
  }

  /**
   * Get signaling client count
   */
  get signalingClientCount(): number {
    return this.pairingCodeToWs.size;
  }
}
