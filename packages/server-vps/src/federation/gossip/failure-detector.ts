/**
 * Failure Detector
 *
 * Implements SWIM-style failure detection with direct and indirect pings.
 * Manages suspicion and failure timeouts.
 */

import { EventEmitter } from 'events';
import type { MembershipEntry } from '../../types.js';

export interface FailureDetectorConfig {
  pingInterval: number;        // How often to ping (ms)
  pingTimeout: number;         // Direct ping timeout (ms)
  indirectPingCount: number;   // Number of peers to use for indirect ping
  suspicionTimeout: number;    // Time before suspect -> failed (ms)
}

export interface FailureDetectorEvents {
  'ping': (target: MembershipEntry) => void;
  'ping-req': (target: MembershipEntry, via: MembershipEntry[]) => void;
  'suspect': (target: MembershipEntry) => void;
  'failed': (target: MembershipEntry) => void;
  'alive': (target: MembershipEntry, incarnation: number) => void;
}

interface PendingPing {
  target: MembershipEntry;
  startTime: number;
  timeout: NodeJS.Timeout;
  isIndirect: boolean;
  indirectResponses: Set<string>;
}

interface SuspicionTimer {
  target: MembershipEntry;
  startTime: number;
  timeout: NodeJS.Timeout;
}

/** RTT statistics from the sliding window. */
export interface RttStats {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  pingCount: number;
}

/** Default sliding window size for RTT samples. */
const RTT_WINDOW_SIZE = 200;

export class FailureDetector extends EventEmitter {
  private config: FailureDetectorConfig;
  private pendingPings: Map<string, PendingPing> = new Map();
  private suspicionTimers: Map<string, SuspicionTimer> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;
  private getRandomPeers: (count: number, exclude: string[]) => MembershipEntry[];
  private getAllPeers: () => MembershipEntry[];

  /** Sliding window of recent RTT measurements (milliseconds). */
  private rttSamples: number[] = [];
  /** Total number of successful pings since start (not just window). */
  private totalPingCount = 0;

  constructor(
    config: FailureDetectorConfig,
    getRandomPeers: (count: number, exclude: string[]) => MembershipEntry[],
    getAllPeers: () => MembershipEntry[]
  ) {
    super();
    this.config = config;
    this.getRandomPeers = getRandomPeers;
    this.getAllPeers = getAllPeers;
  }

  /**
   * Start the failure detector
   */
  start(): void {
    if (this.pingInterval) return;

    this.pingInterval = setInterval(() => {
      this.pingRound();
    }, this.config.pingInterval);
  }

  /**
   * Stop the failure detector
   */
  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Clear all pending pings
    for (const pending of this.pendingPings.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingPings.clear();

    // Clear all suspicion timers
    for (const timer of this.suspicionTimers.values()) {
      clearTimeout(timer.timeout);
    }
    this.suspicionTimers.clear();
  }

  /**
   * Perform a ping round - pick a random peer and ping it
   */
  private pingRound(): void {
    const peers = this.getRandomPeers(1, []);
    if (peers.length === 0) return;

    const target = peers[0]!;
    this.ping(target);
  }

  /**
   * Send a direct ping to a target
   */
  ping(target: MembershipEntry): void {
    if (this.pendingPings.has(target.serverId)) {
      return; // Already pinging this target
    }

    const timeout = setTimeout(() => {
      this.onPingTimeout(target.serverId);
    }, this.config.pingTimeout);

    this.pendingPings.set(target.serverId, {
      target,
      startTime: Date.now(),
      timeout,
      isIndirect: false,
      indirectResponses: new Set(),
    });

    this.emit('ping', target);
  }

  /**
   * Handle ping acknowledgment
   */
  ack(serverId: string, incarnation: number): void {
    const pending = this.pendingPings.get(serverId);
    if (!pending) return;

    // Record RTT for direct (non-indirect) pings
    if (!pending.isIndirect) {
      const rtt = Date.now() - pending.startTime;
      this.recordRtt(rtt);
    }

    clearTimeout(pending.timeout);
    this.pendingPings.delete(serverId);

    // Clear any suspicion
    this.clearSuspicion(serverId);

    // Notify that the server is alive
    this.emit('alive', pending.target, incarnation);
  }

  /**
   * Handle indirect ping acknowledgment (ping-req response)
   */
  indirectAck(serverId: string, via: string, incarnation: number): void {
    const pending = this.pendingPings.get(serverId);
    if (!pending || !pending.isIndirect) return;

    pending.indirectResponses.add(via);

    // One successful response is enough
    clearTimeout(pending.timeout);
    this.pendingPings.delete(serverId);

    // Clear any suspicion
    this.clearSuspicion(serverId);

    // Notify that the server is alive
    this.emit('alive', pending.target, incarnation);
  }

  /**
   * Handle direct ping timeout - escalate to indirect ping
   */
  private onPingTimeout(serverId: string): void {
    const pending = this.pendingPings.get(serverId);
    if (!pending) return;

    if (!pending.isIndirect) {
      // Escalate to indirect ping
      const proxies = this.getRandomPeers(this.config.indirectPingCount, [serverId]);

      if (proxies.length === 0) {
        // No peers to use as proxies - mark as suspect
        this.pendingPings.delete(serverId);
        this.startSuspicion(pending.target);
        return;
      }

      // Start indirect ping phase
      pending.isIndirect = true;
      pending.startTime = Date.now();
      pending.timeout = setTimeout(() => {
        this.onIndirectPingTimeout(serverId);
      }, this.config.pingTimeout);

      this.emit('ping-req', pending.target, proxies);
    }
  }

  /**
   * Handle indirect ping timeout - mark as suspect
   */
  private onIndirectPingTimeout(serverId: string): void {
    const pending = this.pendingPings.get(serverId);
    if (!pending) return;

    this.pendingPings.delete(serverId);
    this.startSuspicion(pending.target);
  }

  /**
   * Start suspicion timer for a server
   */
  private startSuspicion(target: MembershipEntry): void {
    if (this.suspicionTimers.has(target.serverId)) {
      return; // Already suspecting
    }

    const timeout = setTimeout(() => {
      this.onSuspicionTimeout(target.serverId);
    }, this.config.suspicionTimeout);

    this.suspicionTimers.set(target.serverId, {
      target,
      startTime: Date.now(),
      timeout,
    });

    this.emit('suspect', target);
  }

  /**
   * Handle suspicion timeout - mark as failed
   */
  private onSuspicionTimeout(serverId: string): void {
    const timer = this.suspicionTimers.get(serverId);
    if (!timer) return;

    this.suspicionTimers.delete(serverId);
    this.emit('failed', timer.target);
  }

  /**
   * Clear suspicion for a server (they proved they're alive)
   */
  private clearSuspicion(serverId: string): void {
    const timer = this.suspicionTimers.get(serverId);
    if (timer) {
      clearTimeout(timer.timeout);
      this.suspicionTimers.delete(serverId);
    }
  }

  /**
   * Handle refute - a higher incarnation was received
   */
  refute(serverId: string, incarnation: number): void {
    this.clearSuspicion(serverId);

    const pending = this.pendingPings.get(serverId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingPings.delete(serverId);
      this.emit('alive', pending.target, incarnation);
    }
  }

  /**
   * Check if a server is currently being pinged
   */
  isPinging(serverId: string): boolean {
    return this.pendingPings.has(serverId);
  }

  /**
   * Check if a server is currently suspected
   */
  isSuspected(serverId: string): boolean {
    return this.suspicionTimers.has(serverId);
  }

  /**
   * Get suspicion duration for a server (if suspected)
   */
  getSuspicionDuration(serverId: string): number | null {
    const timer = this.suspicionTimers.get(serverId);
    if (!timer) return null;
    return Date.now() - timer.startTime;
  }

  // ─── RTT tracking ───────────────────────────────────────

  /**
   * Record an RTT sample into the sliding window.
   */
  private recordRtt(rttMs: number): void {
    this.totalPingCount++;
    this.rttSamples.push(rttMs);
    // Keep only the most recent RTT_WINDOW_SIZE samples
    if (this.rttSamples.length > RTT_WINDOW_SIZE) {
      this.rttSamples = this.rttSamples.slice(-RTT_WINDOW_SIZE);
    }
  }

  /**
   * Compute a percentile value from a sorted array.
   * Uses nearest-rank method.
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx]!;
  }

  /**
   * Get the P50 (median) RTT in milliseconds.
   * Returns 0 if no samples are available.
   */
  getRttP50(): number {
    if (this.rttSamples.length === 0) return 0;
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    return this.percentile(sorted, 50);
  }

  /**
   * Get the P95 RTT in milliseconds.
   * Returns 0 if no samples are available.
   */
  getRttP95(): number {
    if (this.rttSamples.length === 0) return 0;
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    return this.percentile(sorted, 95);
  }

  /**
   * Get the P99 RTT in milliseconds.
   * Returns 0 if no samples are available.
   */
  getRttP99(): number {
    if (this.rttSamples.length === 0) return 0;
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    return this.percentile(sorted, 99);
  }

  /**
   * Get aggregate RTT statistics.
   */
  getRttStats(): RttStats {
    if (this.rttSamples.length === 0) {
      return { p50Ms: 0, p95Ms: 0, p99Ms: 0, pingCount: this.totalPingCount };
    }
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    return {
      p50Ms: this.percentile(sorted, 50),
      p95Ms: this.percentile(sorted, 95),
      p99Ms: this.percentile(sorted, 99),
      pingCount: this.totalPingCount,
    };
  }

  /**
   * Get the total number of successful pings since start.
   */
  getPingCount(): number {
    return this.totalPingCount;
  }
}
