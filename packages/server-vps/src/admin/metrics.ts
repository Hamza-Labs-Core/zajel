/**
 * Metrics Collector for VPS Admin Dashboard
 *
 * Collects and aggregates server metrics for real-time monitoring.
 * Maintains a rolling window of historical data.
 */

import type { ClientHandler } from '../client/handler.js';
import type { FederationManager } from '../federation/federation-manager.js';
import type {
  MetricsSnapshot,
  HistoricalMetrics,
  FederationTopology,
  FederationNode,
  FederationEdge,
  ScalingRecommendation,
} from './types.js';

// Thresholds for scaling recommendations
const THRESHOLDS = {
  CONNECTION_WARNING: 1000,
  CONNECTION_CRITICAL: 5000,
  ENTROPY_WARNING: 10000,  // Active codes
  ENTROPY_CRITICAL: 20000,
  FEDERATION_MINIMUM: 1,
};

export class MetricsCollector {
  private clientHandler: ClientHandler;
  private federation: FederationManager;
  private serverId: string;
  private history: MetricsSnapshot[] = [];
  private historyMaxSeconds: number;
  private messageCountWindow: number[] = [];
  private windowStartTime: number = Date.now();

  constructor(
    clientHandler: ClientHandler,
    federation: FederationManager,
    serverId: string,
    historyMaxSeconds = 3600 // 1 hour default
  ) {
    this.clientHandler = clientHandler;
    this.federation = federation;
    this.serverId = serverId;
    this.historyMaxSeconds = historyMaxSeconds;
  }

  /**
   * Record a message for rate tracking
   */
  recordMessage(): void {
    const now = Date.now();
    this.messageCountWindow.push(now);

    // Clean up old entries (older than 60 seconds)
    const cutoff = now - 60000;
    this.messageCountWindow = this.messageCountWindow.filter((t) => t > cutoff);
  }

  /**
   * Get current message rate
   */
  getMessageRate(): { perSecond: number; perMinute: number } {
    const now = Date.now();
    const lastSecond = this.messageCountWindow.filter((t) => t > now - 1000).length;
    const lastMinute = this.messageCountWindow.length;

    return {
      perSecond: lastSecond,
      perMinute: lastMinute,
    };
  }

  /**
   * Take a snapshot of current metrics
   */
  takeSnapshot(): MetricsSnapshot {
    const entropyMetrics = this.clientHandler.getEntropyMetrics();
    const messageRate = this.getMessageRate();
    const federationInfo = this.getFederationInfo();

    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      connections: {
        total: this.clientHandler.clientCount + this.clientHandler.signalingClientCount,
        relay: this.clientHandler.clientCount,
        signaling: this.clientHandler.signalingClientCount,
      },
      entropy: {
        activeCodes: entropyMetrics.activeCodes,
        peakActiveCodes: entropyMetrics.peakActiveCodes,
        collisionRisk: entropyMetrics.collisionRisk,
        collisionAttempts: entropyMetrics.collisionAttempts,
      },
      federation: federationInfo,
      messageRate,
    };

    // Add to history
    this.history.push(snapshot);

    // Trim history to max seconds
    const cutoff = Date.now() - this.historyMaxSeconds * 1000;
    this.history = this.history.filter((s) => s.timestamp > cutoff);

    return snapshot;
  }

  /**
   * Get historical metrics
   */
  getHistory(seconds?: number): HistoricalMetrics {
    const cutoff = seconds
      ? Date.now() - seconds * 1000
      : Date.now() - this.historyMaxSeconds * 1000;

    const snapshots = this.history.filter((s) => s.timestamp > cutoff);

    return {
      snapshots,
      startTime: snapshots[0]?.timestamp || Date.now(),
      endTime: snapshots[snapshots.length - 1]?.timestamp || Date.now(),
    };
  }

  /**
   * Get federation topology for visualization
   */
  getFederationTopology(): FederationTopology {
    const nodes: FederationNode[] = [];
    const edges: FederationEdge[] = [];

    // Add self
    nodes.push({
      id: this.serverId,
      region: 'local',
      status: 'alive',
      isLocal: true,
    });

    // Get members from federation
    const members = this.federation.getMembers();

    for (const member of members) {
      if (member.serverId === this.serverId) continue;

      nodes.push({
        id: member.serverId,
        region: (member.metadata as { region?: string })?.region || 'unknown',
        status: member.status,
        isLocal: false,
      });

      // Add edge from self to this member
      edges.push({
        source: this.serverId,
        target: member.serverId,
      });
    }

    return { nodes, edges };
  }

  /**
   * Get scaling recommendation
   */
  getScalingRecommendation(): ScalingRecommendation {
    const snapshot = this.history[this.history.length - 1] || this.takeSnapshot();
    const recommendations: string[] = [];
    let level: 'normal' | 'warning' | 'critical' = 'normal';

    // Calculate load metrics (0-100)
    const connectionLoad = Math.min(
      100,
      (snapshot.connections.total / THRESHOLDS.CONNECTION_CRITICAL) * 100
    );
    const entropyPressure = Math.min(
      100,
      (snapshot.entropy.activeCodes / THRESHOLDS.ENTROPY_CRITICAL) * 100
    );
    const federationHealth = snapshot.federation.aliveMembers >= THRESHOLDS.FEDERATION_MINIMUM
      ? 100
      : (snapshot.federation.aliveMembers / THRESHOLDS.FEDERATION_MINIMUM) * 100;

    // Check connection load
    if (snapshot.connections.total > THRESHOLDS.CONNECTION_CRITICAL) {
      level = 'critical';
      recommendations.push('Connection limit approaching. Scale horizontally by adding more VPS servers.');
    } else if (snapshot.connections.total > THRESHOLDS.CONNECTION_WARNING) {
      level = 'warning';
      recommendations.push('Connection count is elevated. Monitor closely.');
    }

    // Check entropy
    if (snapshot.entropy.activeCodes > THRESHOLDS.ENTROPY_CRITICAL) {
      level = 'critical';
      recommendations.push('Pairing code entropy is critical. Increase code length or add servers.');
    } else if (snapshot.entropy.activeCodes > THRESHOLDS.ENTROPY_WARNING) {
      if (level !== 'critical') level = 'warning';
      recommendations.push('Pairing code pool is under pressure. Consider scaling.');
    }

    // Check federation health
    if (snapshot.federation.aliveMembers < THRESHOLDS.FEDERATION_MINIMUM) {
      if (level !== 'critical') level = 'warning';
      recommendations.push(`Only ${snapshot.federation.aliveMembers} federation peers. Add more VPS servers for redundancy.`);
    }

    // Default message
    if (recommendations.length === 0) {
      recommendations.push('All metrics within normal parameters.');
    }

    const message = level === 'critical'
      ? 'Immediate action required!'
      : level === 'warning'
        ? 'Attention needed'
        : 'System healthy';

    return {
      level,
      message,
      metrics: {
        connectionLoad,
        entropyPressure,
        federationHealth,
      },
      recommendations,
    };
  }

  /**
   * Get federation info
   */
  private getFederationInfo(): MetricsSnapshot['federation'] {
    const members = this.federation.getMembers();
    const regions: Record<string, number> = {};

    let alive = 0;
    let suspect = 0;

    for (const member of members) {
      if (member.status === 'alive') alive++;
      else if (member.status === 'suspect') suspect++;

      const region = (member.metadata as { region?: string })?.region || 'unknown';
      regions[region] = (regions[region] || 0) + 1;
    }

    return {
      aliveMembers: alive,
      suspectMembers: suspect,
      totalMembers: members.length,
      regions,
    };
  }
}
