/**
 * SWIM Gossip Protocol Implementation
 *
 * Scalable Weakly-consistent Infection-style Membership protocol.
 * Provides failure detection and membership dissemination.
 */

import { EventEmitter } from 'events';
import type {
  ServerIdentity,
  MembershipEntry,
  GossipMessage,
  MembershipUpdate,
  ServerStatus,
  ServerMetadata,
} from '../../types.js';
import { Membership } from './membership.js';
import { FailureDetector, type FailureDetectorConfig } from './failure-detector.js';
import { signMessage, verifyMessage, publicKeyFromServerId } from '../../identity/server-identity.js';

export interface GossipConfig {
  pingInterval: number;
  pingTimeout: number;
  suspicionTimeout: number;
  failureTimeout: number;
  indirectPingCount: number;
  stateExchangeInterval: number;
}

export interface GossipProtocolEvents {
  'member-join': (entry: MembershipEntry) => void;
  'member-leave': (serverId: string) => void;
  'member-suspect': (entry: MembershipEntry) => void;
  'member-failed': (entry: MembershipEntry) => void;
  'member-alive': (entry: MembershipEntry) => void;
  'send-ping': (target: MembershipEntry, message: GossipMessage) => void;
  'send-ping-req': (via: MembershipEntry, target: MembershipEntry, message: GossipMessage) => void;
  'send-state-sync': (target: MembershipEntry, message: GossipMessage) => void;
  'joined': () => void;
  'left': () => void;
}

export class GossipProtocol extends EventEmitter {
  private identity: ServerIdentity;
  private config: GossipConfig;
  private membership: Membership;
  private failureDetector: FailureDetector;
  private sequenceNumber = 0;
  private stateExchangeInterval: NodeJS.Timeout | null = null;
  private running = false;
  private endpoint: string;
  private metadata: ServerMetadata;

  constructor(
    identity: ServerIdentity,
    endpoint: string,
    config: GossipConfig,
    metadata: ServerMetadata = {}
  ) {
    super();
    this.identity = identity;
    this.endpoint = endpoint;
    this.config = config;
    this.metadata = metadata;

    // Initialize membership
    this.membership = new Membership(identity.serverId);
    this.setupMembershipListeners();

    // Initialize failure detector
    const fdConfig: FailureDetectorConfig = {
      pingInterval: config.pingInterval,
      pingTimeout: config.pingInterval / 2, // Half the interval for ping timeout
      indirectPingCount: config.indirectPingCount,
      suspicionTimeout: config.suspicionTimeout,
    };

    this.failureDetector = new FailureDetector(
      fdConfig,
      (count, exclude) => this.membership.getRandomAlive(count, exclude),
      () => this.membership.getAlive()
    );
    this.setupFailureDetectorListeners();
  }

  /**
   * Start the gossip protocol
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Add ourselves to membership
    const selfEntry: MembershipEntry = {
      serverId: this.identity.serverId,
      nodeId: this.identity.nodeId,
      endpoint: this.endpoint,
      publicKey: this.identity.publicKey,
      status: 'alive',
      incarnation: this.membership.incarnation,
      lastSeen: Date.now(),
      metadata: this.metadata,
    };
    this.membership.upsert(selfEntry);

    // Start failure detector
    this.failureDetector.start();

    // Start periodic state exchange
    this.stateExchangeInterval = setInterval(() => {
      this.performStateExchange();
    }, this.config.stateExchangeInterval);
  }

  /**
   * Stop the gossip protocol
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.failureDetector.stop();

    if (this.stateExchangeInterval) {
      clearInterval(this.stateExchangeInterval);
      this.stateExchangeInterval = null;
    }

    this.emit('left');
  }

  /**
   * Join the network via bootstrap nodes
   */
  async join(bootstrapEndpoints: string[]): Promise<void> {
    // The actual connection is handled externally
    // This just prepares the state for joining
    this.start();
    this.emit('joined');
  }

  /**
   * Gracefully leave the network
   */
  async leave(): Promise<void> {
    // Broadcast leave to known peers
    const leaveMessage = await this.createMessage('leave', {
      serverId: this.identity.serverId,
    });

    // Emit for external sending
    for (const peer of this.membership.getAlive()) {
      if (peer.serverId !== this.identity.serverId) {
        this.emit('send-state-sync', peer, leaveMessage);
      }
    }

    this.stop();
  }

  /**
   * Handle incoming gossip message
   */
  async handleMessage(message: GossipMessage): Promise<GossipMessage | null> {
    // Verify signature
    const isValid = await this.verifyMessageSignature(message);
    if (!isValid) {
      console.warn('[Gossip] Invalid message signature from', message.senderId);
      return null;
    }

    // Process piggybacked updates
    if (message.piggyback) {
      for (const update of message.piggyback) {
        this.membership.applyUpdate(update);
      }
    }

    // Handle message type
    switch (message.subtype) {
      case 'ping':
        return this.handlePing(message);

      case 'ping_ack':
        this.handlePingAck(message);
        return null;

      case 'ping_req':
        return this.handlePingReq(message);

      case 'join':
        return this.handleJoin(message);

      case 'leave':
        this.handleLeave(message);
        return null;

      case 'suspect':
        this.handleSuspect(message);
        return null;

      case 'confirm':
        this.handleConfirm(message);
        return null;

      case 'state_sync':
        return this.handleStateSync(message);

      default:
        console.warn('[Gossip] Unknown message subtype:', message.subtype);
        return null;
    }
  }

  /**
   * Handle ping request
   */
  private async handlePing(message: GossipMessage): Promise<GossipMessage> {
    // Update sender's status
    const sender = this.membership.get(message.senderId);
    if (sender) {
      this.membership.alive(message.senderId, sender.incarnation);
    }

    // Respond with ping_ack
    return this.createMessage('ping_ack', {
      incarnation: this.membership.incarnation,
    });
  }

  /**
   * Handle ping acknowledgment
   */
  private handlePingAck(message: GossipMessage): void {
    const payload = message.payload as { incarnation: number };
    this.failureDetector.ack(message.senderId, payload.incarnation);
  }

  /**
   * Handle ping request (indirect ping)
   */
  private async handlePingReq(message: GossipMessage): Promise<GossipMessage | null> {
    const payload = message.payload as { targetServerId: string };
    const target = this.membership.get(payload.targetServerId);

    if (!target) {
      return null;
    }

    // We need to ping the target and return the result
    // This is handled asynchronously by the caller
    this.emit('send-ping', target, await this.createMessage('ping', {}));

    return null;
  }

  /**
   * Handle join announcement
   */
  private async handleJoin(message: GossipMessage): Promise<GossipMessage> {
    const payload = message.payload as {
      serverId: string;
      nodeId: string;
      endpoint: string;
      publicKey: string;
      metadata?: ServerMetadata;
    };

    const entry: MembershipEntry = {
      serverId: payload.serverId,
      nodeId: payload.nodeId,
      endpoint: payload.endpoint,
      publicKey: new Uint8Array(Buffer.from(payload.publicKey, 'base64')),
      status: 'alive',
      incarnation: 0,
      lastSeen: Date.now(),
      metadata: payload.metadata || {},
    };

    this.membership.upsert(entry);

    // Respond with state sync
    return this.handleStateSync(message);
  }

  /**
   * Handle leave announcement
   */
  private handleLeave(message: GossipMessage): void {
    const payload = message.payload as { serverId: string };
    this.membership.remove(payload.serverId);
  }

  /**
   * Handle suspect announcement
   */
  private handleSuspect(message: GossipMessage): void {
    const payload = message.payload as { serverId: string; incarnation: number };

    // If it's about us, refute it
    if (payload.serverId === this.identity.serverId) {
      if (payload.incarnation >= this.membership.incarnation) {
        this.membership.incrementIncarnation();
      }
      // Our higher incarnation will be gossiped
      return;
    }

    this.membership.suspect(payload.serverId);
  }

  /**
   * Handle failure confirmation
   */
  private handleConfirm(message: GossipMessage): void {
    const payload = message.payload as { serverId: string };
    this.membership.fail(payload.serverId);
  }

  /**
   * Handle state sync request/response
   */
  private async handleStateSync(message: GossipMessage): Promise<GossipMessage> {
    const payload = message.payload as { members?: MembershipEntry[] };

    // Merge incoming state
    if (payload.members) {
      // Convert publicKey from base64 to Uint8Array
      const entries = payload.members.map(m => ({
        ...m,
        publicKey: typeof m.publicKey === 'string'
          ? new Uint8Array(Buffer.from(m.publicKey, 'base64'))
          : m.publicKey,
      }));
      this.membership.mergeState(entries);
    }

    // Respond with our state
    const ourMembers = this.membership.exportState().map(m => ({
      ...m,
      publicKey: Buffer.from(m.publicKey).toString('base64'),
    }));

    return this.createMessage('state_sync', { members: ourMembers });
  }

  /**
   * Perform periodic state exchange with random peer
   */
  private async performStateExchange(): Promise<void> {
    const peers = this.membership.getRandomAlive(1, []);
    if (peers.length === 0) return;

    const target = peers[0]!;
    const members = this.membership.exportState().map(m => ({
      ...m,
      publicKey: Buffer.from(m.publicKey).toString('base64'),
    }));

    const message = await this.createMessage('state_sync', { members });
    this.emit('send-state-sync', target, message);
  }

  /**
   * Create a gossip message with signature
   */
  private async createMessage(subtype: GossipMessage['subtype'], payload: unknown): Promise<GossipMessage> {
    const message: Omit<GossipMessage, 'signature'> = {
      type: 'gossip',
      subtype,
      senderId: this.identity.serverId,
      sequenceNumber: ++this.sequenceNumber,
      timestamp: Date.now(),
      payload,
      piggyback: this.membership.getRecentUpdates(5),
    };

    const messageStr = JSON.stringify(message);
    const signature = await signMessage(this.identity, messageStr);

    return { ...message, signature };
  }

  /**
   * Verify message signature
   */
  private async verifyMessageSignature(message: GossipMessage): Promise<boolean> {
    try {
      const { signature, ...rest } = message;
      const messageStr = JSON.stringify(rest);
      const publicKey = publicKeyFromServerId(message.senderId);
      return await verifyMessage(messageStr, signature, publicKey);
    } catch {
      return false;
    }
  }

  /**
   * Setup membership event listeners
   */
  private setupMembershipListeners(): void {
    this.membership.on('member-join', (entry) => {
      this.emit('member-join', entry);
    });

    this.membership.on('member-leave', (serverId) => {
      this.emit('member-leave', serverId);
    });

    this.membership.on('member-suspect', (entry) => {
      this.emit('member-suspect', entry);
    });

    this.membership.on('member-failed', (entry) => {
      this.emit('member-failed', entry);
    });

    this.membership.on('member-alive', (entry) => {
      this.emit('member-alive', entry);
    });
  }

  /**
   * Setup failure detector event listeners
   */
  private setupFailureDetectorListeners(): void {
    this.failureDetector.on('ping', async (target: MembershipEntry) => {
      const message = await this.createMessage('ping', {});
      this.emit('send-ping', target, message);
    });

    this.failureDetector.on('ping-req', async (target: MembershipEntry, proxies: MembershipEntry[]) => {
      const message = await this.createMessage('ping_req', {
        targetServerId: target.serverId,
      });

      for (const proxy of proxies) {
        this.emit('send-ping-req', proxy, target, message);
      }
    });

    this.failureDetector.on('suspect', async (target: MembershipEntry) => {
      this.membership.suspect(target.serverId);

      // Broadcast suspicion
      const message = await this.createMessage('suspect', {
        serverId: target.serverId,
        incarnation: target.incarnation,
      });

      for (const peer of this.membership.getRandomAlive(3, [target.serverId])) {
        this.emit('send-state-sync', peer, message);
      }
    });

    this.failureDetector.on('failed', async (target: MembershipEntry) => {
      this.membership.fail(target.serverId);

      // Broadcast confirmation
      const message = await this.createMessage('confirm', {
        serverId: target.serverId,
      });

      for (const peer of this.membership.getRandomAlive(3, [target.serverId])) {
        this.emit('send-state-sync', peer, message);
      }
    });

    this.failureDetector.on('alive', (target: MembershipEntry, incarnation: number) => {
      this.membership.alive(target.serverId, incarnation);
    });
  }

  /**
   * Get current membership
   */
  getMembership(): Membership {
    return this.membership;
  }

  /**
   * Get alive member count
   */
  getAliveCount(): number {
    return this.membership.aliveCount;
  }

  /**
   * Check if we're running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Create a join message for bootstrap
   */
  async createJoinMessage(): Promise<GossipMessage> {
    return this.createMessage('join', {
      serverId: this.identity.serverId,
      nodeId: this.identity.nodeId,
      endpoint: this.endpoint,
      publicKey: Buffer.from(this.identity.publicKey).toString('base64'),
      metadata: this.metadata,
    });
  }
}
