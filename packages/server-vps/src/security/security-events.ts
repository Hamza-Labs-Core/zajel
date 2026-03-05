/**
 * SecurityEventReporter — Collects and batches security events
 * for periodic push to diagnostics-cf via POST /diagnostics/security-events.
 *
 * Event types:
 * - rate_limit_violation: Client exceeded rate limits
 * - connection_spike: DDoS indicator (unusual connection rate)
 * - bad_client: Malformed messages, protocol violations
 * - brute_force_attempt: Failed pairing code guessing
 */

/** Maximum number of events held in memory before oldest are evicted */
const MAX_BUFFER_SIZE = 10_000;

/** Flush interval in milliseconds (60 seconds) */
const FLUSH_INTERVAL_MS = 60_000;

/** Valid security event types */
export const SECURITY_EVENT_TYPES = [
  'rate_limit_violation',
  'connection_spike',
  'bad_client',
  'brute_force_attempt',
] as const;

export type SecurityEventType = typeof SECURITY_EVENT_TYPES[number];

/** Valid severity levels */
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * A security event recorded in memory.
 */
export interface SecurityEvent {
  eventType: SecurityEventType;
  timestamp: number;
  sourceIp?: string;
  endpoint?: string;
  details?: Record<string, unknown>;
  severity: SecuritySeverity;
  count: number;
}

/**
 * Configuration for security event reporter.
 */
export interface SecurityEventReporterConfig {
  /** URL of the diagnostics-cf worker */
  diagnosticsUrl: string;
  /** Shared secret for server-to-server auth */
  pushSecret: string;
  /** This server's ID */
  serverId: string;
  /** This server's region */
  region: string;
}

export class SecurityEventReporter {
  private buffer: SecurityEvent[] = [];
  private writeIndex = 0;
  private count = 0;
  private config: SecurityEventReporterConfig | null = null;
  private flushIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastFlushIndex = 0;

  /**
   * Record a security event.
   */
  record(event: Omit<SecurityEvent, 'timestamp' | 'count'> & { timestamp?: number; count?: number }): void {
    const fullEvent: SecurityEvent = {
      eventType: event.eventType,
      timestamp: event.timestamp ?? Date.now(),
      sourceIp: event.sourceIp,
      endpoint: event.endpoint,
      details: event.details,
      severity: event.severity,
      count: event.count ?? 1,
    };

    if (this.count < MAX_BUFFER_SIZE) {
      this.buffer.push(fullEvent);
      this.count++;
    } else {
      this.buffer[this.writeIndex] = fullEvent;
    }
    this.writeIndex = (this.writeIndex + 1) % MAX_BUFFER_SIZE;
  }

  /**
   * Get the current number of events in the buffer.
   */
  get size(): number {
    return this.count;
  }

  /**
   * Get all unflushed events.
   */
  getUnflushedEvents(): SecurityEvent[] {
    if (this.count === 0) return [];

    const unflushed: SecurityEvent[] = [];

    if (this.writeIndex > this.lastFlushIndex) {
      for (let i = this.lastFlushIndex; i < this.writeIndex; i++) {
        unflushed.push(this.buffer[i]!);
      }
    } else if (this.writeIndex < this.lastFlushIndex) {
      for (let i = this.lastFlushIndex; i < this.count; i++) {
        unflushed.push(this.buffer[i]!);
      }
      for (let i = 0; i < this.writeIndex; i++) {
        unflushed.push(this.buffer[i]!);
      }
    }

    return unflushed;
  }

  /**
   * Mark all current events as flushed.
   */
  markFlushed(): void {
    this.lastFlushIndex = this.writeIndex;
  }

  /**
   * Get recent events of a specific type (for local queries).
   */
  getRecentByType(eventType: SecurityEventType, maxAge: number = 3600_000): SecurityEvent[] {
    const cutoff = Date.now() - maxAge;
    const result: SecurityEvent[] = [];

    for (let i = 0; i < this.count; i++) {
      const event = this.buffer[i]!;
      if (event.eventType === eventType && event.timestamp > cutoff) {
        result.push(event);
      }
    }

    return result;
  }

  /**
   * Count events matching criteria within a time window.
   */
  countEvents(eventType: SecurityEventType, sourceIp?: string, windowMs: number = 3600_000): number {
    const cutoff = Date.now() - windowMs;
    let total = 0;

    for (let i = 0; i < this.count; i++) {
      const event = this.buffer[i]!;
      if (event.eventType !== eventType) continue;
      if (event.timestamp < cutoff) continue;
      if (sourceIp !== undefined && event.sourceIp !== sourceIp) continue;
      total += event.count;
    }

    return total;
  }

  /**
   * Start periodic flushing to diagnostics-cf.
   */
  start(config: SecurityEventReporterConfig): void {
    this.config = config;

    this.flushIntervalId = setInterval(() => {
      this.flush().catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[SecurityEvents] Flush error: ${errMsg}`);
      });
    }, FLUSH_INTERVAL_MS);

    console.log(`[SecurityEvents] Started pushing to ${config.diagnosticsUrl} every ${FLUSH_INTERVAL_MS / 1000}s`);
  }

  /**
   * Stop periodic flushing.
   */
  stop(): void {
    if (this.flushIntervalId !== null) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
      console.log('[SecurityEvents] Stopped');
    }
  }

  /**
   * Manually trigger a flush (for testing).
   */
  async flush(): Promise<void> {
    if (!this.config) return;

    const events = this.getUnflushedEvents();
    if (events.length === 0) return;

    const payload = {
      serverId: this.config.serverId,
      events: events.map((e) => ({
        eventType: e.eventType,
        timestamp: e.timestamp,
        serverId: this.config!.serverId,
        region: this.config!.region,
        sourceIp: e.sourceIp,
        endpoint: e.endpoint,
        details: e.details ? JSON.stringify(e.details) : undefined,
        severity: e.severity,
        count: e.count,
      })),
    };

    try {
      const url = `${this.config.diagnosticsUrl}/diagnostics/security-events`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.pushSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        this.markFlushed();
      } else {
        console.warn(`[SecurityEvents] Flush failed: HTTP ${response.status}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[SecurityEvents] Flush error: ${errMsg}`);
    }
  }
}
