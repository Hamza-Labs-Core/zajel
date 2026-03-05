/**
 * LogBuffer — Circular buffer for structured server log entries.
 *
 * Maintains the most recent 10,000 log entries in-memory.
 * Supports querying by severity, keyword, time range, and module.
 * Periodically flushes new entries to diagnostics-cf via POST /diagnostics/server-logs.
 */

/** Maximum number of entries in the circular buffer */
const MAX_BUFFER_SIZE = 10_000;

/** Flush interval in milliseconds (60 seconds) */
const FLUSH_INTERVAL_MS = 60_000;

/** Log severity levels ordered by priority */
const SEVERITY_LEVELS = ['debug', 'info', 'warn', 'error', 'critical'] as const;

export type LogSeverity = typeof SEVERITY_LEVELS[number];

/**
 * A structured log entry stored in the buffer.
 */
export interface LogEntry {
  timestamp: number;
  severity: LogSeverity;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Options for querying the log buffer.
 */
export interface LogQueryOptions {
  /** Minimum severity level (inclusive, e.g. 'warn' includes warn + error + critical) */
  severity?: LogSeverity;
  /** Only entries after this timestamp (Unix ms) */
  since?: number;
  /** Only entries before this timestamp (Unix ms) */
  until?: number;
  /** Substring search in message (case-insensitive) */
  keyword?: string;
  /** Filter by category */
  category?: string;
  /** Max entries to return (default 100, max 500) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/**
 * Result from a log query.
 */
export interface LogQueryResult {
  entries: LogEntry[];
  total: number;
  hasMore: boolean;
  bufferSize: number;
  oldestTimestamp: number;
}

/**
 * Configuration for the log buffer flush.
 */
export interface LogBufferFlushConfig {
  /** URL of the diagnostics-cf worker */
  diagnosticsUrl: string;
  /** Shared secret for server-to-server auth */
  pushSecret: string;
  /** This server's ID */
  serverId: string;
}

/**
 * Get the numeric priority for a severity level.
 * Higher number = higher priority.
 */
function severityPriority(severity: LogSeverity): number {
  return SEVERITY_LEVELS.indexOf(severity);
}

export class LogBuffer {
  private buffer: LogEntry[] = [];
  private writeIndex = 0;
  private count = 0;
  private flushConfig: LogBufferFlushConfig | null = null;
  private flushIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastFlushIndex = 0;

  /**
   * Add a log entry to the buffer.
   */
  add(entry: LogEntry): void {
    if (this.count < MAX_BUFFER_SIZE) {
      this.buffer.push(entry);
      this.count++;
    } else {
      // Overwrite the oldest entry
      this.buffer[this.writeIndex] = entry;
    }
    this.writeIndex = (this.writeIndex + 1) % MAX_BUFFER_SIZE;
  }

  /**
   * Query the buffer with optional filters.
   * Results are returned newest-first.
   */
  query(options: LogQueryOptions = {}): LogQueryResult {
    const {
      severity,
      since,
      until,
      keyword,
      category,
      limit: rawLimit,
      offset: rawOffset,
    } = options;

    const limit = Math.min(Math.max(rawLimit ?? 100, 1), 500);
    const offset = Math.max(rawOffset ?? 0, 0);

    const minPriority = severity !== undefined ? severityPriority(severity) : 0;
    const lowerKeyword = keyword?.toLowerCase();

    // Filter entries
    const filtered: LogEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const entry = this.buffer[i]!;

      // Severity filter
      if (severityPriority(entry.severity) < minPriority) continue;

      // Time range filters
      if (since !== undefined && entry.timestamp < since) continue;
      if (until !== undefined && entry.timestamp > until) continue;

      // Category filter
      if (category !== undefined && entry.category !== category) continue;

      // Keyword filter (case-insensitive)
      if (lowerKeyword !== undefined && !entry.message.toLowerCase().includes(lowerKeyword)) continue;

      filtered.push(entry);
    }

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    const total = filtered.length;
    const entries = filtered.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    let oldestTimestamp = 0;
    if (this.count > 0) {
      oldestTimestamp = this.buffer[0]!.timestamp;
      for (let i = 1; i < this.count; i++) {
        if (this.buffer[i]!.timestamp < oldestTimestamp) {
          oldestTimestamp = this.buffer[i]!.timestamp;
        }
      }
    }

    return {
      entries,
      total,
      hasMore,
      bufferSize: this.count,
      oldestTimestamp,
    };
  }

  /**
   * Get the current number of entries in the buffer.
   */
  get size(): number {
    return this.count;
  }

  /**
   * Get all unflushed entries (entries added since the last flush).
   * Returns a copy. Caps at MAX_BUFFER_SIZE to handle wraparound safely —
   * if the buffer wrapped past lastFlushIndex, we can only return what's still in the buffer.
   */
  getUnflushedEntries(): LogEntry[] {
    if (this.count === 0) return [];

    const unflushed: LogEntry[] = [];

    if (this.writeIndex > this.lastFlushIndex) {
      // No wraparound
      for (let i = this.lastFlushIndex; i < this.writeIndex; i++) {
        unflushed.push(this.buffer[i]!);
      }
    } else if (this.writeIndex < this.lastFlushIndex) {
      // Wraparound occurred — some unflushed entries may have been overwritten
      // Only return entries that are still in the buffer
      if (this.count >= MAX_BUFFER_SIZE) {
        // Buffer is full — start from writeIndex (oldest surviving entry)
        for (let i = this.writeIndex; i < MAX_BUFFER_SIZE; i++) {
          unflushed.push(this.buffer[i]!);
        }
        for (let i = 0; i < this.writeIndex; i++) {
          unflushed.push(this.buffer[i]!);
        }
      } else {
        for (let i = this.lastFlushIndex; i < this.count; i++) {
          unflushed.push(this.buffer[i]!);
        }
        for (let i = 0; i < this.writeIndex; i++) {
          unflushed.push(this.buffer[i]!);
        }
      }
    }
    // If writeIndex === lastFlushIndex, no new entries

    return unflushed;
  }

  /**
   * Mark all current entries as flushed.
   */
  markFlushed(): void {
    this.lastFlushIndex = this.writeIndex;
  }

  /**
   * Start periodic flushing of new log entries to diagnostics-cf.
   */
  startFlush(config: LogBufferFlushConfig): void {
    this.flushConfig = config;

    this.flushIntervalId = setInterval(() => {
      this.flush().catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[LogBuffer] Flush error: ${errMsg}`);
      });
    }, FLUSH_INTERVAL_MS);

    console.log(`[LogBuffer] Started flushing to ${config.diagnosticsUrl} every ${FLUSH_INTERVAL_MS / 1000}s`);
  }

  /**
   * Stop periodic flushing.
   */
  stopFlush(): void {
    if (this.flushIntervalId !== null) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
      console.log('[LogBuffer] Stopped flushing');
    }
  }

  /**
   * Manually trigger a flush (for testing).
   */
  async flush(): Promise<void> {
    if (!this.flushConfig) return;

    const entries = this.getUnflushedEntries();
    if (entries.length === 0) return;

    const payload = {
      serverId: this.flushConfig.serverId,
      entries: entries.map((e) => ({
        timestamp: e.timestamp,
        severity: e.severity,
        category: e.category,
        message: e.message,
        metadata: e.metadata ? JSON.stringify(e.metadata) : undefined,
      })),
    };

    try {
      const url = `${this.flushConfig.diagnosticsUrl}/diagnostics/server-logs`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.flushConfig.pushSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        this.markFlushed();
      } else {
        console.warn(`[LogBuffer] Flush failed: HTTP ${response.status}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[LogBuffer] Flush error: ${errMsg}`);
    }
  }
}
