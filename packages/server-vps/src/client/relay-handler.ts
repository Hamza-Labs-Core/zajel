/**
 * Relay & Rendezvous Handler
 *
 * Manages relay peer registration, load updates, heartbeats, relay listing,
 * and rendezvous point registration with routing awareness.
 * Extracted from ClientHandler to separate relay/rendezvous concerns.
 */

import type { WebSocket } from 'ws';
import type { DeadDropResult } from '../registry/rendezvous-registry.js';
import { RENDEZVOUS_LIMITS, PEER_ID, RELAY } from '../constants.js';
import type { HandlerContext } from './context.js';
import type {
  ClientInfo,
  RegisterMessage,
  UpdateLoadMessage,
  RegisterRendezvousMessage,
  GetRelaysMessage,
  HeartbeatMessage,
} from './types.js';

/**
 * Validate peerId format: must be a string of 1-128 alphanumeric characters,
 * hyphens, or underscores.
 */
function isValidPeerId(peerId: unknown): peerId is string {
  return (
    typeof peerId === 'string' &&
    peerId.length > 0 &&
    peerId.length <= PEER_ID.MAX_LENGTH &&
    PEER_ID.PATTERN.test(peerId)
  );
}

export class RelayHandler {
  private readonly ctx: HandlerContext;

  constructor(ctx: HandlerContext) {
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  // Peer registration
  // ---------------------------------------------------------------------------

  async handleRegister(ws: WebSocket, message: RegisterMessage): Promise<void> {
    const { peerId, maxConnections = 20, publicKey } = message;

    if (!isValidPeerId(peerId)) {
      this.ctx.sendError(ws, 'Invalid peerId: must be 1-128 alphanumeric characters, hyphens, or underscores');
      return;
    }

    // Validate maxConnections
    const maxConn = Number(maxConnections);
    if (!Number.isFinite(maxConn) || maxConn < RELAY.MIN_MAX_CONNECTIONS || maxConn > RELAY.MAX_MAX_CONNECTIONS) {
      this.ctx.sendError(ws, `maxConnections must be a finite number between ${RELAY.MIN_MAX_CONNECTIONS} and ${RELAY.MAX_MAX_CONNECTIONS}`);
      return;
    }

    // Check if peerId is already registered by a different WebSocket
    const existingClient = this.ctx.clients.get(peerId);
    if (existingClient && existingClient.ws !== ws) {
      this.ctx.sendError(ws, 'Peer ID already in use by another connection');
      return;
    }

    // Check if this WebSocket is already registered with a different peerId
    const existingPeerId = this.ctx.wsToClient.get(ws);
    if (existingPeerId && existingPeerId !== peerId) {
      this.ctx.sendError(ws, 'Cannot re-register with a different peerId');
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
    this.ctx.clients.set(peerId, info);
    this.ctx.wsToClient.set(ws, peerId);

    // Register in relay registry
    this.ctx.relayRegistry.register(peerId, {
      maxConnections: maxConn,
      publicKey,
    });

    // Get available relays (excluding self)
    const relays = this.ctx.relayRegistry.getAvailableRelays(peerId, 10);

    this.ctx.send(ws, {
      type: 'registered',
      peerId,
      serverId: this.ctx.identity.serverId,
      relays,
    });

    return;
  }

  // ---------------------------------------------------------------------------
  // Load update
  // ---------------------------------------------------------------------------

  handleUpdateLoad(ws: WebSocket, message: UpdateLoadMessage): void {
    const { peerId, connectedCount } = message;

    if (!isValidPeerId(peerId)) {
      this.ctx.sendError(ws, 'Invalid peerId');
      return;
    }

    // Verify WebSocket owns this peerId
    const client = this.ctx.clients.get(peerId);
    if (!client || client.ws !== ws) {
      // Ignore load update from non-owner
      return;
    }

    const count = Number(connectedCount);
    if (!Number.isFinite(count) || count < 0 || count > RELAY.MAX_CONNECTED_COUNT) {
      this.ctx.sendError(ws, 'Invalid connectedCount');
      return;
    }

    // Update client's last seen
    client.lastSeen = Date.now();

    this.ctx.relayRegistry.updateLoad(peerId, count);

    this.ctx.send(ws, {
      type: 'load_updated',
      peerId,
      connectedCount: count,
    });
  }

  // ---------------------------------------------------------------------------
  // Rendezvous registration
  // ---------------------------------------------------------------------------

  async handleRegisterRendezvous(
    ws: WebSocket,
    message: RegisterRendezvousMessage
  ): Promise<void> {
    const { peerId, relayId } = message;

    if (!isValidPeerId(peerId)) {
      this.ctx.sendError(ws, 'Invalid peerId');
      return;
    }

    // Support both naming conventions
    const dailyPoints = message.dailyPoints || message.daily_points || [];
    const hourlyTokens = message.hourlyTokens || message.hourly_tokens || [];

    // Validate array sizes
    if (!Array.isArray(dailyPoints) || dailyPoints.length > RENDEZVOUS_LIMITS.MAX_POINTS_PER_MESSAGE) {
      this.ctx.sendError(ws, `Too many daily points (max ${RENDEZVOUS_LIMITS.MAX_POINTS_PER_MESSAGE})`);
      return;
    }
    if (!Array.isArray(hourlyTokens) || hourlyTokens.length > RENDEZVOUS_LIMITS.MAX_TOKENS_PER_MESSAGE) {
      this.ctx.sendError(ws, `Too many hourly tokens (max ${RENDEZVOUS_LIMITS.MAX_TOKENS_PER_MESSAGE})`);
      return;
    }

    // Validate array element types and lengths
    if (!dailyPoints.every(p => typeof p === 'string' && p.length <= RENDEZVOUS_LIMITS.MAX_HASH_LENGTH)) {
      this.ctx.sendError(ws, 'Invalid daily points format');
      return;
    }
    if (!hourlyTokens.every(t => typeof t === 'string' && t.length <= RENDEZVOUS_LIMITS.MAX_HASH_LENGTH)) {
      this.ctx.sendError(ws, 'Invalid hourly tokens format');
      return;
    }

    // Validate relayId field size
    if (relayId && (typeof relayId !== 'string' || relayId.length > RENDEZVOUS_LIMITS.MAX_RELAY_ID_LENGTH)) {
      this.ctx.sendError(ws, 'Invalid relayId');
      return;
    }

    // Support both single dead drop (legacy) and map (new format)
    // Priority: dead_drops > deadDrops > deadDrop (legacy)
    const deadDropsMap: Record<string, string> =
      message.dead_drops || message.deadDrops || {};
    const legacyDeadDrop = message.deadDrop || '';

    // Validate dead drops map size and values
    if (Object.keys(deadDropsMap).length > RENDEZVOUS_LIMITS.MAX_POINTS_PER_MESSAGE) {
      this.ctx.sendError(ws, 'Too many dead drops');
      return;
    }
    for (const [key, value] of Object.entries(deadDropsMap)) {
      if (typeof key !== 'string' || key.length > RENDEZVOUS_LIMITS.MAX_HASH_LENGTH) {
        this.ctx.sendError(ws, 'Invalid dead drop key');
        return;
      }
      if (typeof value !== 'string' || value.length > RENDEZVOUS_LIMITS.MAX_DEAD_DROP_SIZE) {
        this.ctx.sendError(ws, 'Dead drop payload too large (max 4KB)');
        return;
      }
    }

    // Validate legacy dead drop size
    if (legacyDeadDrop && (typeof legacyDeadDrop !== 'string' || legacyDeadDrop.length > RENDEZVOUS_LIMITS.MAX_DEAD_DROP_SIZE)) {
      this.ctx.sendError(ws, 'Dead drop payload too large (max 4KB)');
      return;
    }

    // Update client's last seen
    const client = this.ctx.clients.get(peerId);
    if (client) {
      client.lastSeen = Date.now();
    }

    // Aggregate dead drops results
    const allDeadDrops: DeadDropResult[] = [];
    const allDailyRedirects: Array<{ serverId: string; endpoint: string; items: string[] }> = [];

    // If we have per-point dead drops, register each point with its specific dead drop
    const hasPerPointDeadDrops = Object.keys(deadDropsMap).length > 0;

    if (hasPerPointDeadDrops) {
      // Group points by whether they have a dead drop
      const pointsWithDeadDrop: string[] = [];
      const pointsWithoutDeadDrop: string[] = [];

      for (const point of dailyPoints) {
        if (deadDropsMap[point]) {
          pointsWithDeadDrop.push(point);
        } else {
          pointsWithoutDeadDrop.push(point);
        }
      }

      // Register points that have dead drops - each with its own dead drop
      for (const point of pointsWithDeadDrop) {
        const deadDrop = deadDropsMap[point]!;
        const result = await this.ctx.distributedRendezvous.registerDailyPoints(peerId, {
          points: [point],
          deadDrop,
          relayId,
        });
        allDeadDrops.push(...result.local.deadDrops);
        allDailyRedirects.push(...result.redirects);
      }

      // Register points without dead drops (if any)
      if (pointsWithoutDeadDrop.length > 0) {
        const result = await this.ctx.distributedRendezvous.registerDailyPoints(peerId, {
          points: pointsWithoutDeadDrop,
          deadDrop: '', // No dead drop for these points
          relayId,
        });
        allDeadDrops.push(...result.local.deadDrops);
        allDailyRedirects.push(...result.redirects);
      }
    } else {
      // Legacy mode: single dead drop for all points
      const dailyResult = await this.ctx.distributedRendezvous.registerDailyPoints(peerId, {
        points: dailyPoints,
        deadDrop: legacyDeadDrop,
        relayId,
      });
      allDeadDrops.push(...dailyResult.local.deadDrops);
      allDailyRedirects.push(...dailyResult.redirects);
    }

    // Register hourly tokens (with routing)
    const hourlyResult = await this.ctx.distributedRendezvous.registerHourlyTokens(peerId, {
      tokens: hourlyTokens,
      relayId,
    });

    // Check if we need to send redirects
    const hasRedirects = allDailyRedirects.length > 0 || hourlyResult.redirects.length > 0;

    if (hasRedirects) {
      // Send partial result with redirect information
      this.ctx.send(ws, {
        type: 'rendezvous_partial',
        local: {
          liveMatches: hourlyResult.local.liveMatches,
          deadDrops: allDeadDrops,
        },
        redirects: this.mergeRedirects(allDailyRedirects, hourlyResult.redirects),
      });
    } else {
      // All points handled locally - send regular result
      this.ctx.send(ws, {
        type: 'rendezvous_result',
        liveMatches: hourlyResult.local.liveMatches,
        deadDrops: allDeadDrops,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Get relays
  // ---------------------------------------------------------------------------

  handleGetRelays(ws: WebSocket, message: GetRelaysMessage): void {
    const { peerId, count = 10 } = message;

    if (!isValidPeerId(peerId)) {
      this.ctx.sendError(ws, 'Invalid peerId');
      return;
    }

    const safeCount = Math.min(Math.max(1, count), 100);
    const relays = this.ctx.relayRegistry.getAvailableRelays(peerId, safeCount);

    this.ctx.send(ws, {
      type: 'relays',
      relays,
    });
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  handleHeartbeat(ws: WebSocket, message: HeartbeatMessage): void {
    const { peerId } = message;

    if (!isValidPeerId(peerId)) {
      this.ctx.sendError(ws, 'Invalid peerId');
      return;
    }

    // Verify WebSocket owns this peerId
    const client = this.ctx.clients.get(peerId);
    if (!client || client.ws !== ws) {
      // Ignore heartbeat from non-owner
      return;
    }

    // Update last seen
    client.lastSeen = Date.now();

    // Update relay registry
    const peer = this.ctx.relayRegistry.getPeer(peerId);
    if (peer) {
      this.ctx.relayRegistry.updateLoad(peerId, peer.connectedCount);
    }

    this.ctx.send(ws, {
      type: 'heartbeat_ack',
      timestamp: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
}
