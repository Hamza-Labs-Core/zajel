/**
 * Channel Handler
 *
 * Manages channel ownership, subscriptions, upstream messages, and live streaming.
 * Extracted from ClientHandler to separate channel concerns from the main message router.
 */

import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { RATE_LIMIT, UPSTREAM_QUEUE } from '../constants.js';
import type { ChunkRelay } from './chunk-relay.js';
import type {
  RateLimitInfo,
  ChannelOwnerRegisterMessage,
  ChannelSubscribeMessage,
  UpstreamMessageData,
  StreamStartMessage,
  StreamFrameMessage,
  StreamEndMessage,
} from './types.js';

export interface ChannelHandlerDeps {
  send: (ws: WebSocket, message: object) => boolean;
  sendError: (ws: WebSocket, message: string) => void;
  chunkRelay: ChunkRelay | null;
}

export class ChannelHandler {
  // Channel owner tracking: channelId -> WebSocket of the owner
  private channelOwners: Map<string, WebSocket> = new Map();
  // Channel subscriber tracking: channelId -> Set of subscriber WebSockets
  private channelSubscribers: Map<string, Set<WebSocket>> = new Map();
  // Active stream tracking: channelId -> stream metadata
  private activeStreams: Map<string, { streamId: string; title: string; ownerWs: WebSocket }> = new Map();
  // Upstream rate limiting per WebSocket: ws -> { count, windowStart }
  private upstreamRateLimits: Map<WebSocket, RateLimitInfo> = new Map();
  // Upstream message queue for offline owners: channelId -> queued messages
  private upstreamQueues: Map<string, Array<{ data: object; timestamp: number }>> = new Map();

  // Maximum queued upstream messages per channel (from constants)
  private static readonly MAX_UPSTREAM_QUEUE_SIZE = UPSTREAM_QUEUE.MAX_QUEUE_SIZE;
  // Upstream rate limit: max messages per window
  private static readonly MAX_UPSTREAM_PER_WINDOW = 30;

  private readonly send: (ws: WebSocket, message: object) => boolean;
  private readonly sendError: (ws: WebSocket, message: string) => void;
  private readonly chunkRelay: ChunkRelay | null;

  constructor(deps: ChannelHandlerDeps) {
    this.send = deps.send;
    this.sendError = deps.sendError;
    this.chunkRelay = deps.chunkRelay;
  }

  /**
   * Get subscribers for a channel (used by chunk announce handler).
   */
  getSubscribers(channelId: string): Set<WebSocket> | undefined {
    return this.channelSubscribers.get(channelId);
  }

  /**
   * Handle channel owner registration.
   * Flushes any queued upstream messages to the newly-registered owner.
   */
  handleChannelOwnerRegister(ws: WebSocket, message: ChannelOwnerRegisterMessage): void {
    const { channelId } = message;

    if (!channelId) {
      this.sendError(ws, 'Missing required field: channelId');
      return;
    }

    // Prevent hijacking: reject if channel already has an active owner
    const existingOwner = this.channelOwners.get(channelId);
    if (existingOwner && existingOwner !== ws && existingOwner.readyState === existingOwner.OPEN) {
      this.sendError(ws, 'Channel already has an active owner');
      return;
    }

    this.channelOwners.set(channelId, ws);

    // Flush any queued upstream messages (filter out expired ones)
    const queue = this.upstreamQueues.get(channelId);
    if (queue && queue.length > 0) {
      const now = Date.now();
      const valid = queue.filter(item => now - item.timestamp < UPSTREAM_QUEUE.TTL_MS);
      for (const item of valid) {
        this.send(ws, item.data);
      }
      this.upstreamQueues.delete(channelId);
    }

    this.send(ws, {
      type: 'channel-owner-registered',
      channelId,
    });
  }

  /**
   * Handle channel subscription registration.
   * Subscribers register to receive stream frames and broadcasts.
   */
  async handleChannelSubscribe(ws: WebSocket, message: ChannelSubscribeMessage): Promise<void> {
    const { channelId } = message;

    if (!channelId) {
      this.sendError(ws, 'Missing required field: channelId');
      return;
    }

    let subscribers = this.channelSubscribers.get(channelId);
    if (!subscribers) {
      subscribers = new Set();
      this.channelSubscribers.set(channelId, subscribers);
    }
    subscribers.add(ws);

    this.send(ws, {
      type: 'channel-subscribed',
      channelId,
    });

    // If there's an active stream, notify the new subscriber
    const activeStream = this.activeStreams.get(channelId);
    if (activeStream) {
      this.send(ws, {
        type: 'stream-start',
        streamId: activeStream.streamId,
        channelId,
        title: activeStream.title,
      });
    }

    // Send existing cached chunks so late-joining subscribers can fetch content.
    if (this.chunkRelay) {
      const chunkIds = await this.chunkRelay.getCachedChunkIdsForChannel(channelId);
      if (chunkIds.length > 0) {
        this.send(ws, {
          type: 'chunk_available',
          channelId,
          chunkIds,
        });
      }
    }
  }

  /**
   * Check upstream rate limit for a WebSocket connection.
   * Returns true if the upstream message should be allowed.
   */
  private checkUpstreamRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    let rateLimitInfo = this.upstreamRateLimits.get(ws);

    if (!rateLimitInfo) {
      rateLimitInfo = { messageCount: 1, windowStart: now };
      this.upstreamRateLimits.set(ws, rateLimitInfo);
      return true;
    }

    if (now - rateLimitInfo.windowStart >= RATE_LIMIT.WINDOW_MS) {
      rateLimitInfo.messageCount = 1;
      rateLimitInfo.windowStart = now;
      return true;
    }

    rateLimitInfo.messageCount++;

    if (rateLimitInfo.messageCount > ChannelHandler.MAX_UPSTREAM_PER_WINDOW) {
      return false;
    }

    return true;
  }

  /**
   * Handle upstream message (subscriber -> VPS -> owner).
   *
   * The VPS routes the message to the channel owner only.
   * Rate limited per peer to prevent spam.
   * Messages are queued if the owner is offline (up to MAX_UPSTREAM_QUEUE_SIZE).
   */
  handleUpstreamMessage(ws: WebSocket, message: UpstreamMessageData): void {
    const { channelId } = message;

    if (!channelId) {
      this.sendError(ws, 'Missing required field: channelId');
      return;
    }

    if (!message.message) {
      this.sendError(ws, 'Missing required field: message');
      return;
    }

    // Rate limit upstream messages
    if (!this.checkUpstreamRateLimit(ws)) {
      this.sendError(ws, 'Upstream rate limit exceeded. Please slow down.');
      return;
    }

    const ownerWs = this.channelOwners.get(channelId);

    const forwardData = {
      type: 'upstream-message',
      channelId,
      message: message.message,
      ephemeralPublicKey: message.ephemeralPublicKey,
    };

    if (ownerWs && ownerWs.readyState === ownerWs.OPEN) {
      // Owner is online, forward directly
      this.send(ownerWs, forwardData);
    } else {
      // Owner is offline, queue the message
      let queue = this.upstreamQueues.get(channelId);
      if (!queue) {
        queue = [];
        this.upstreamQueues.set(channelId, queue);
      }

      if (queue.length < ChannelHandler.MAX_UPSTREAM_QUEUE_SIZE) {
        queue.push({ data: forwardData, timestamp: Date.now() });
      }
      // Silently drop if queue is full (DoS protection)
    }

    // Acknowledge receipt to the sender
    this.send(ws, {
      type: 'upstream-ack',
      channelId,
      messageId: (message.message as Record<string, unknown>)['id'] || null,
    });
  }

  /**
   * Handle stream-start from the channel owner.
   *
   * Notifies all subscribed peers about the new live stream.
   * VPS tracks the active stream to notify late-joining subscribers.
   */
  handleStreamStart(ws: WebSocket, message: StreamStartMessage): void {
    const { streamId, channelId, title } = message;

    if (!streamId || !channelId) {
      this.sendError(ws, 'Missing required fields: streamId, channelId');
      return;
    }

    // Verify this is the channel owner
    const ownerWs = this.channelOwners.get(channelId);
    if (ownerWs !== ws) {
      this.sendError(ws, 'Only the channel owner can start a stream');
      return;
    }

    // Track the active stream
    this.activeStreams.set(channelId, { streamId, title, ownerWs: ws });

    // Fan out to all subscribers
    const subscribers = this.channelSubscribers.get(channelId);
    if (subscribers) {
      const notification = {
        type: 'stream-start',
        streamId,
        channelId,
        title,
      };
      for (const subWs of subscribers) {
        this.send(subWs, notification);
      }
    }

    // Acknowledge
    this.send(ws, {
      type: 'stream-started',
      streamId,
      channelId,
      subscriberCount: subscribers?.size || 0,
    });
  }

  /**
   * Handle stream-frame from the channel owner.
   *
   * VPS acts as SFU: receives encrypted frame, fans out to all subscribers.
   * No store-and-forward delay -- pure streaming relay.
   */
  handleStreamFrame(ws: WebSocket, message: StreamFrameMessage): void {
    const { streamId, channelId, frame } = message;

    if (!streamId || !channelId || !frame) {
      return; // Silently drop malformed frames for performance
    }

    // Verify the stream is active and the sender is the owner
    const activeStream = this.activeStreams.get(channelId);
    if (!activeStream || activeStream.ownerWs !== ws) {
      return; // Silently drop unauthorized frames
    }

    // Fan out to all subscribers (SFU pattern)
    const subscribers = this.channelSubscribers.get(channelId);
    if (subscribers) {
      const frameMsg = {
        type: 'stream-frame',
        streamId,
        channelId,
        frame,
      };
      for (const subWs of subscribers) {
        this.send(subWs, frameMsg);
      }
    }
  }

  /**
   * Handle stream-end from the channel owner.
   *
   * Notifies all subscribers and cleans up the active stream.
   */
  handleStreamEnd(ws: WebSocket, message: StreamEndMessage): void {
    const { streamId, channelId } = message;

    if (!streamId || !channelId) {
      this.sendError(ws, 'Missing required fields: streamId, channelId');
      return;
    }

    // Verify the stream is active and the sender is the owner
    const activeStream = this.activeStreams.get(channelId);
    if (!activeStream || activeStream.ownerWs !== ws) {
      this.sendError(ws, 'Cannot end stream: not the owner or no active stream');
      return;
    }

    // Clean up the active stream
    this.activeStreams.delete(channelId);

    // Notify all subscribers
    const subscribers = this.channelSubscribers.get(channelId);
    if (subscribers) {
      const endMsg = {
        type: 'stream-end',
        streamId,
        channelId,
      };
      for (const subWs of subscribers) {
        this.send(subWs, endMsg);
      }
    }

    // Acknowledge
    this.send(ws, {
      type: 'stream-ended',
      streamId,
      channelId,
    });
  }

  /**
   * Clean up channel state when a WebSocket disconnects.
   */
  handleDisconnect(ws: WebSocket): void {
    // Clean up upstream rate limits
    this.upstreamRateLimits.delete(ws);

    // Clean up channel owner registrations
    try {
      for (const [channelId, ownerWs] of this.channelOwners) {
        if (ownerWs === ws) {
          this.channelOwners.delete(channelId);
          // End any active streams for this owner
          const activeStream = this.activeStreams.get(channelId);
          if (activeStream && activeStream.ownerWs === ws) {
            this.activeStreams.delete(channelId);
            // Notify subscribers that stream ended
            const subscribers = this.channelSubscribers.get(channelId);
            if (subscribers) {
              const endMsg = { type: 'stream-end', streamId: activeStream.streamId, channelId };
              for (const subWs of subscribers) {
                this.send(subWs, endMsg);
              }
            }
          }
        }
      }
    } catch (e) {
      logger.warn(`[ChannelHandler] Error cleaning up channel owners: ${e}`);
    }

    // Clean up channel subscriber registrations
    try {
      for (const [, subscribers] of this.channelSubscribers) {
        subscribers.delete(ws);
      }
    } catch (e) {
      logger.warn(`[ChannelHandler] Error cleaning up channel subscribers: ${e}`);
    }
  }

  /**
   * Clean up expired upstream queue entries.
   */
  cleanupExpiredQueues(): void {
    const now = Date.now();
    for (const [channelId, queue] of this.upstreamQueues) {
      const valid = queue.filter(item => now - item.timestamp < UPSTREAM_QUEUE.TTL_MS);
      if (valid.length === 0) {
        this.upstreamQueues.delete(channelId);
      } else if (valid.length < queue.length) {
        this.upstreamQueues.set(channelId, valid);
      }
    }
  }

  /**
   * Clear all state on shutdown.
   */
  shutdown(): void {
    this.channelOwners.clear();
    this.channelSubscribers.clear();
    this.activeStreams.clear();
    this.upstreamQueues.clear();
    this.upstreamRateLimits.clear();
  }
}
