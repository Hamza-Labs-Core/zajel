/**
 * Metrics Push — Periodically sends server metric snapshots
 * to the diagnostics-cf worker for centralized storage.
 *
 * Fire-and-forget: push failures are logged but never block
 * server operation. The next push (60 seconds later) will succeed.
 */

import type { MetricsCollector } from './metrics.js';

/** Push interval in milliseconds (60 seconds). */
const PUSH_INTERVAL_MS = 60_000;

/** Gossip latency stats shape (mirrors RttStats from failure-detector). */
export interface GossipLatencyStats {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  pingCount: number;
}

export interface MetricsPushConfig {
  /** URL of the diagnostics-cf worker (e.g., https://diagnostics.zajel.hamzalabs.dev) */
  diagnosticsUrl: string;
  /** Shared secret for server-to-server authentication */
  pushSecret: string;
  /** This server's ID */
  serverId: string;
  /** This server's region */
  region: string;
  /**
   * Optional callback that returns gossip RTT statistics.
   * When provided, gossipLatency will be included in each push payload.
   */
  getGossipLatency?: () => GossipLatencyStats;
}

export interface MetricsPushHandle {
  /** Stop the periodic push */
  stop: () => void;
  /** Manually trigger a push (for testing) */
  pushNow: () => Promise<void>;
}

/**
 * Compute CPU usage percentage between two samples of process.cpuUsage().
 *
 * process.cpuUsage() returns cumulative user + system microseconds.
 * We compute the percentage of CPU time used over the elapsed wall-clock interval.
 */
function computeCpuPercent(
  prev: NodeJS.CpuUsage,
  current: NodeJS.CpuUsage,
  elapsedMs: number,
): number {
  const userDelta = current.user - prev.user;     // microseconds
  const systemDelta = current.system - prev.system; // microseconds
  const totalCpuUs = userDelta + systemDelta;
  const elapsedUs = elapsedMs * 1000;
  if (elapsedUs <= 0) return 0;
  // Cap at 100% (can exceed on multi-core but we normalize to single-core equivalent)
  return Math.min(100, (totalCpuUs / elapsedUs) * 100);
}

/**
 * Start periodic metrics pushing.
 *
 * Returns a handle to stop the push interval and a manual pushNow() function.
 */
export function startMetricsPush(
  metricsCollector: MetricsCollector,
  config: MetricsPushConfig,
): MetricsPushHandle {
  let prevCpuUsage = process.cpuUsage();
  let prevTimestamp = Date.now();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function pushMetrics(): Promise<void> {
    try {
      const snapshot = metricsCollector.takeSnapshot();

      // Compute CPU usage since last push
      const currentCpuUsage = process.cpuUsage();
      const now = Date.now();
      const elapsedMs = now - prevTimestamp;
      const cpuPercent = computeCpuPercent(prevCpuUsage, currentCpuUsage, elapsedMs);
      prevCpuUsage = currentCpuUsage;
      prevTimestamp = now;

      // Memory in MB
      const memoryMb = Math.round(process.memoryUsage().rss / (1024 * 1024) * 100) / 100;

      // Collect optional gossip latency stats
      const gossipLatency = config.getGossipLatency?.() ?? undefined;

      const payload = {
        serverId: config.serverId,
        region: config.region,
        timestamp: now,
        metrics: {
          connections: {
            total: snapshot.connections.total,
            relay: snapshot.connections.relay,
            signaling: snapshot.connections.signaling,
          },
          entropy: {
            activeCodes: snapshot.entropy.activeCodes,
            collisionRisk: snapshot.entropy.collisionRisk,
          },
          federation: {
            aliveMembers: snapshot.federation.aliveMembers,
            totalMembers: snapshot.federation.totalMembers,
          },
          messageRate: {
            perSecond: snapshot.messageRate.perSecond,
            perMinute: snapshot.messageRate.perMinute,
          },
          system: {
            cpuPercent: Math.round(cpuPercent * 100) / 100,
            memoryMb,
            uptimeSeconds: Math.floor(process.uptime()),
          },
          // Include gossip latency when available (non-zero pingCount)
          ...(gossipLatency && gossipLatency.pingCount > 0
            ? { gossipLatency }
            : {}),
        },
      };

      const url = `${config.diagnosticsUrl}/diagnostics/server-metrics`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.pushSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000), // 10 second timeout
      });

      if (!response.ok) {
        console.warn(`[MetricsPush] Push failed: HTTP ${response.status}`);
      }
    } catch (err) {
      // Fire-and-forget: log and continue
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[MetricsPush] Push error: ${errMsg}`);
    }
  }

  // Start the interval
  intervalId = setInterval(pushMetrics, PUSH_INTERVAL_MS);
  console.log(`[MetricsPush] Started pushing to ${config.diagnosticsUrl} every ${PUSH_INTERVAL_MS / 1000}s`);

  return {
    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
        console.log('[MetricsPush] Stopped');
      }
    },
    pushNow: pushMetrics,
  };
}
