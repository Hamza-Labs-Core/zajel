/**
 * WebSocket Handler for Real-time Admin Metrics
 *
 * Streams metrics updates to connected admin dashboards.
 */

import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { verifyJwt, extractToken } from './auth.js';
import type { MetricsCollector } from './metrics.js';
import type { AdminWsMessage } from './types.js';

export class AdminWebSocketHandler {
  private wss: WebSocketServer;
  private metricsCollector: MetricsCollector;
  private jwtSecret: string;
  private clients: Set<WebSocket> = new Set();
  private metricsInterval: ReturnType<typeof setInterval> | null = null;
  private lastFederationHash: string = '';

  constructor(
    wss: WebSocketServer,
    metricsCollector: MetricsCollector,
    jwtSecret: string
  ) {
    this.wss = wss;
    this.metricsCollector = metricsCollector;
    this.jwtSecret = jwtSecret;
  }

  /**
   * Start the WebSocket handler
   */
  start(): void {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Start metrics broadcast interval (every second)
    this.metricsInterval = setInterval(() => {
      this.broadcastMetrics();
    }, 1000);
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Authenticate
    const token = extractToken(req);
    if (!token) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    const payload = verifyJwt(token, this.jwtSecret);
    if (!payload) {
      ws.close(4401, 'Invalid or expired token');
      return;
    }

    // Add to clients
    this.clients.add(ws);
    console.log(`[Admin WS] Client connected: ${payload.username} (${this.clients.size} total)`);

    // Send initial metrics snapshot
    const snapshot = this.metricsCollector.takeSnapshot();
    this.sendMessage(ws, { type: 'metrics', data: snapshot });

    // Send initial federation topology
    const topology = this.metricsCollector.getFederationTopology();
    this.sendMessage(ws, { type: 'federation', data: topology });

    // Handle messages from client
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type: string };
        this.handleClientMessage(ws, message);
      } catch {
        // Ignore malformed messages
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      this.clients.delete(ws);
      console.log(`[Admin WS] Client disconnected (${this.clients.size} remaining)`);
    });

    ws.on('error', (error) => {
      console.error('[Admin WS] WebSocket error:', error);
      this.clients.delete(ws);
    });
  }

  /**
   * Handle message from client
   */
  private handleClientMessage(ws: WebSocket, message: { type: string }): void {
    switch (message.type) {
      case 'ping':
        this.sendMessage(ws, { type: 'metrics', data: this.metricsCollector.takeSnapshot() });
        break;

      case 'get_topology':
        this.sendMessage(ws, {
          type: 'federation',
          data: this.metricsCollector.getFederationTopology(),
        });
        break;

      default:
        // Unknown message type, ignore
        break;
    }
  }

  /**
   * Broadcast metrics to all connected clients
   */
  private broadcastMetrics(): void {
    if (this.clients.size === 0) return;

    const snapshot = this.metricsCollector.takeSnapshot();
    const message: AdminWsMessage = { type: 'metrics', data: snapshot };

    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        this.sendMessage(client, message);
      }
    }

    // Check for federation topology changes
    const topology = this.metricsCollector.getFederationTopology();
    const topologyHash = JSON.stringify(topology.nodes.map((n) => `${n.id}:${n.status}`).sort());

    if (topologyHash !== this.lastFederationHash) {
      this.lastFederationHash = topologyHash;
      const fedMessage: AdminWsMessage = { type: 'federation', data: topology };
      for (const client of this.clients) {
        if (client.readyState === client.OPEN) {
          this.sendMessage(client, fedMessage);
        }
      }
    }

    // Check for alerts
    const scaling = this.metricsCollector.getScalingRecommendation();
    if (scaling.level !== 'normal') {
      const alertMessage: AdminWsMessage = {
        type: 'alert',
        data: {
          level: scaling.level === 'critical' ? 'error' : 'warning',
          message: scaling.message + ' ' + scaling.recommendations[0],
        },
      };
      for (const client of this.clients) {
        if (client.readyState === client.OPEN) {
          this.sendMessage(client, alertMessage);
        }
      }
    }
  }

  /**
   * Send message to a client
   */
  private sendMessage(ws: WebSocket, message: AdminWsMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[Admin WS] Failed to send message:', error);
    }
  }

  /**
   * Send alert to all clients
   */
  sendAlert(level: 'info' | 'warning' | 'error', message: string): void {
    const alertMessage: AdminWsMessage = {
      type: 'alert',
      data: { level, message },
    };

    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        this.sendMessage(client, alertMessage);
      }
    }
  }

  /**
   * Shutdown the handler
   */
  shutdown(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }
}
