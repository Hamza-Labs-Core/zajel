/**
 * Federation Manager
 *
 * Orchestrates the gossip protocol and server-to-server transport.
 * Handles bootstrapping, peer discovery, and membership management.
 */

import { EventEmitter } from 'events';
import type { WebSocketServer } from 'ws';
import type {
  ServerIdentity,
  MembershipEntry,
  GossipMessage,
  ServerMetadata,
} from '../types.js';
import { GossipProtocol, type GossipConfig } from './gossip/protocol.js';
import { ServerConnectionManager, type ServerConnectionConfig } from './transport/server-connection.js';
import { HashRing, RoutingTable } from './dht/hash-ring.js';
import type { Storage } from '../storage/interface.js';
import { logger } from '../utils/logger.js';

export interface FederationConfig {
  gossip: GossipConfig;
  transport: ServerConnectionConfig;
  dht: {
    replicationFactor: number;
    virtualNodes: number;
  };
  bootstrap: {
    nodes: string[];
    retryInterval: number;
    maxRetries: number;
  };
}

export interface FederationEvents {
  'member-join': (entry: MembershipEntry) => void;
  'member-leave': (serverId: string) => void;
  'member-suspect': (entry: MembershipEntry) => void;
  'member-failed': (entry: MembershipEntry) => void;
  'member-alive': (entry: MembershipEntry) => void;
  'ready': () => void;
  'shutdown': () => void;
}

export class FederationManager extends EventEmitter {
  private identity: ServerIdentity;
  private endpoint: string;
  private metadata: ServerMetadata;
  private config: FederationConfig;
  private storage: Storage;

  private gossip: GossipProtocol;
  private transport: ServerConnectionManager;
  private ring: HashRing;
  private routingTable: RoutingTable;

  private bootstrapAttempts = 0;
  private bootstrapTimer: NodeJS.Timeout | null = null;
  private isShutdown = false;

  constructor(
    identity: ServerIdentity,
    endpoint: string,
    config: FederationConfig,
    storage: Storage,
    metadata: ServerMetadata = {}
  ) {
    super();
    this.identity = identity;
    this.endpoint = endpoint;
    this.config = config;
    this.storage = storage;
    this.metadata = metadata;

    // Initialize gossip protocol
    this.gossip = new GossipProtocol(
      identity,
      endpoint,
      config.gossip,
      metadata
    );
    this.setupGossipEvents();

    // Initialize transport
    this.transport = new ServerConnectionManager(
      identity,
      endpoint,
      config.transport,
      metadata
    );
    this.setupTransportEvents();

    // Initialize DHT ring
    this.ring = new HashRing(config.dht.virtualNodes);
    this.routingTable = new RoutingTable(
      this.ring,
      identity.serverId,
      config.dht.replicationFactor
    );
  }

  /**
   * Start the federation (listen for connections and bootstrap)
   */
  async start(wss: WebSocketServer): Promise<void> {
    if (this.isShutdown) {
      throw new Error('FederationManager has been shutdown');
    }

    // Load known servers from storage
    await this.loadPersistedServers();

    // Start transport server
    this.transport.startServer(wss);

    // Start gossip protocol
    this.gossip.start();

    // Add ourselves to the ring
    this.ring.addNode({
      serverId: this.identity.serverId,
      nodeId: this.identity.nodeId,
      endpoint: this.endpoint,
      status: 'alive',
      metadata: this.metadata,
    });

    // Start bootstrap process
    if (this.config.bootstrap.nodes.length > 0) {
      this.bootstrap();
    } else {
      // Solo mode - we're ready immediately
      this.emit('ready');
    }
  }

  /**
   * Gracefully shutdown the federation
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }

    // Broadcast leave message
    await this.gossip.leave();

    // Persist known servers
    await this.persistServers();

    // Close all connections
    this.transport.shutdown();

    this.emit('shutdown');
  }

  /**
   * Get the gossip protocol instance
   */
  getGossip(): GossipProtocol {
    return this.gossip;
  }

  /**
   * Get the transport manager
   */
  getTransport(): ServerConnectionManager {
    return this.transport;
  }

  /**
   * Get the hash ring
   */
  getRing(): HashRing {
    return this.ring;
  }

  /**
   * Get the routing table
   */
  getRoutingTable(): RoutingTable {
    return this.routingTable;
  }

  /**
   * Get alive member count
   */
  getAliveCount(): number {
    return this.gossip.getAliveCount();
  }

  /**
   * Check if we should handle a hash locally
   */
  shouldHandleLocally(hash: string): boolean {
    return this.routingTable.shouldHandleLocally(hash);
  }

  /**
   * Get redirect targets for hashes we don't own
   */
  getRedirectTargets(hashes: string[]): Array<{ serverId: string; endpoint: string; hashes: string[] }> {
    return this.routingTable.getRedirectTargets(hashes);
  }

  /**
   * Connect to bootstrap nodes
   */
  private async bootstrap(): Promise<void> {
    this.bootstrapAttempts++;

    let connected = false;

    for (const endpoint of this.config.bootstrap.nodes) {
      try {
        // Create a temporary entry for bootstrap
        const entry: MembershipEntry = {
          serverId: `bootstrap-${endpoint}`, // Temporary, will be replaced after handshake
          nodeId: '',
          endpoint,
          publicKey: new Uint8Array(0),
          status: 'alive',
          incarnation: 0,
          lastSeen: Date.now(),
          metadata: {},
        };

        // Try to connect (this will fail fast if unreachable)
        await this.connectToBootstrap(endpoint);
        connected = true;
        break;
      } catch (error) {
        console.warn(`[Federation] Failed to connect to bootstrap ${endpoint}:`, error);
      }
    }

    if (connected) {
      this.emit('ready');
    } else if (
      this.config.bootstrap.maxRetries === 0 ||
      this.bootstrapAttempts < this.config.bootstrap.maxRetries
    ) {
      // Retry after interval
      this.bootstrapTimer = setTimeout(() => {
        this.bootstrap();
      }, this.config.bootstrap.retryInterval);
    } else {
      console.error('[Federation] Failed to bootstrap after max retries');
      // Still emit ready so the server can run standalone
      this.emit('ready');
    }
  }

  /**
   * Connect to a bootstrap node
   */
  private async connectToBootstrap(endpoint: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const WebSocket = require('ws');
      const ws = new WebSocket(endpoint);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Bootstrap connection timeout'));
      }, this.config.transport.handshakeTimeout);

      ws.on('open', async () => {
        try {
          // Send join message
          const joinMessage = await this.gossip.createJoinMessage();
          ws.send(JSON.stringify(joinMessage));
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          // Process the response (should be state_sync with members)
          if (message.type === 'gossip' && message.subtype === 'state_sync') {
            clearTimeout(timeout);
            ws.close();

            // Handle the state sync response
            await this.gossip.handleMessage(message);

            // Now connect to discovered members
            const membership = this.gossip.getMembership();
            for (const member of membership.getAlive()) {
              if (member.serverId !== this.identity.serverId) {
                this.transport.connect(member).catch(() => {
                  // Ignore connection failures during bootstrap
                });
              }
            }

            resolve();
          }
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Setup gossip protocol event handlers
   */
  private setupGossipEvents(): void {
    this.gossip.on('member-join', (entry) => {
      // Add to ring
      this.ring.addNode({
        serverId: entry.serverId,
        nodeId: entry.nodeId,
        endpoint: entry.endpoint,
        status: entry.status,
        metadata: entry.metadata,
      });

      // Try to connect
      this.transport.connect(entry).catch(() => {
        // Will retry later
      });

      this.emit('member-join', entry);
    });

    this.gossip.on('member-leave', (serverId) => {
      this.ring.removeNode(serverId);
      this.transport.disconnect(serverId);
      this.emit('member-leave', serverId);
    });

    this.gossip.on('member-suspect', (entry) => {
      this.ring.updateNodeStatus(entry.serverId, 'suspect');
      this.emit('member-suspect', entry);
    });

    this.gossip.on('member-failed', (entry) => {
      this.ring.updateNodeStatus(entry.serverId, 'failed');
      this.transport.disconnect(entry.serverId);
      this.emit('member-failed', entry);
    });

    this.gossip.on('member-alive', (entry) => {
      this.ring.updateNodeStatus(entry.serverId, 'alive');
      this.emit('member-alive', entry);
    });

    // Handle outgoing gossip messages
    this.gossip.on('send-ping', async (target, message) => {
      await this.transport.send(target.serverId, message);
    });

    this.gossip.on('send-ping-req', async (via, target, message) => {
      await this.transport.send(via.serverId, message);
    });

    this.gossip.on('send-state-sync', async (target, message) => {
      await this.transport.send(target.serverId, message);
    });
  }

  /**
   * Setup transport event handlers
   */
  private setupTransportEvents(): void {
    this.transport.on('connected', (entry) => {
      // The gossip protocol will handle the membership update
      logger.federationEvent('connected', entry.serverId);
    });

    this.transport.on('disconnected', (serverId, code, reason) => {
      logger.federationEvent('disconnected', serverId);
    });

    this.transport.on('message', async (serverId, message) => {
      // Route message through gossip protocol
      const response = await this.gossip.handleMessage(message);

      if (response) {
        await this.transport.send(serverId, response);
      }
    });

    this.transport.on('error', (serverId, error) => {
      logger.error(`[Federation] Transport error with ${logger.serverId(serverId)}`, error);
    });
  }

  /**
   * Load persisted server list from storage
   */
  private async loadPersistedServers(): Promise<void> {
    try {
      const servers = await this.storage.getAllServers();
      const membership = this.gossip.getMembership();

      for (const server of servers) {
        if (server.status === 'alive' || server.status === 'suspect') {
          // Add to gossip membership for potential reconnection
          const entry: MembershipEntry = {
            serverId: server.serverId,
            nodeId: server.nodeId,
            endpoint: server.endpoint,
            publicKey: server.publicKey,
            status: server.status as 'alive' | 'suspect',
            incarnation: server.incarnation,
            lastSeen: server.lastSeen,
            metadata: server.metadata,
          };
          membership.upsert(entry);
        }
      }
    } catch (error) {
      console.error('[Federation] Failed to load persisted servers:', error);
    }
  }

  /**
   * Persist current server list to storage
   */
  private async persistServers(): Promise<void> {
    try {
      const membership = this.gossip.getMembership();
      const servers = membership.getAll();

      for (const server of servers) {
        await this.storage.upsertServer({
          serverId: server.serverId,
          nodeId: server.nodeId,
          endpoint: server.endpoint,
          publicKey: server.publicKey,
          status: server.status,
          incarnation: server.incarnation,
          lastSeen: server.lastSeen,
          metadata: server.metadata,
        });
      }
    } catch (error) {
      console.error('[Federation] Failed to persist servers:', error);
    }
  }
}
