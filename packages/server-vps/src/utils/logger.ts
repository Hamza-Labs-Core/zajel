/**
 * Secure Logger Utility
 *
 * Provides structured logging with automatic redaction of sensitive data
 * like pairing codes, IP addresses, and server IDs in production environments.
 *
 * Based on OWASP guidelines and CWE-532 prevention strategies.
 */

import type { LogBuffer as AdminLogBuffer, LogSeverity as AdminLogSeverity } from '../admin/log-buffer.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A buffered log entry awaiting push to diagnostics-cf. */
export interface BufferedLogEntry {
  timestamp: number;
  severity: string;
  category: string;
  message: string;
  metadata?: string;
}

/** Configuration for log push to diagnostics-cf. */
export interface LogPushConfig {
  /** URL of the diagnostics-cf worker */
  diagnosticsUrl: string;
  /** Shared secret for server-to-server authentication */
  pushSecret: string;
  /** This server's ID */
  serverId: string;
}

/** Handle returned by startLogPush() */
export interface LogPushHandle {
  /** Stop the periodic push and flush remaining entries */
  stop: () => void;
  /** Manually trigger a push (for testing) */
  pushNow: () => Promise<void>;
  /** Current buffer size */
  bufferSize: () => number;
}

/** Maximum entries held in the buffer before oldest are dropped. */
const LOG_BUFFER_MAX = 500;

/** Push interval in milliseconds (10 seconds). */
const LOG_PUSH_INTERVAL_MS = 10_000;

/** Push immediately when buffer reaches this size. */
const LOG_PUSH_THRESHOLD = 100;

/** Maximum entries sent per push (matches diagnostics-cf MAX_ENTRIES_PER_PUSH). */
const LOG_PUSH_BATCH_SIZE = 200;

interface LoggerConfig {
  level: LogLevel;
  redactSensitive: boolean;
  environment: 'development' | 'production';
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Redact a sensitive value, showing only first and last characters
 * @param value The value to redact
 * @param showChars Number of characters to show at start and end
 */
export function redact(value: string, showChars = 2): string {
  if (!value || value.length <= showChars * 2) return '****';
  return `${value.slice(0, showChars)}****${value.slice(-showChars)}`;
}

/**
 * Redact a pairing code for logging
 * Shows first and last character only
 */
export function redactPairingCode(code: string): string {
  if (!code || code.length < 3) return '****';
  return `${code[0]}****${code[code.length - 1]}`;
}

/**
 * Redact an IP address for logging
 * For IPv4: shows first octet only
 * For IPv6: shows first segment only
 */
export function redactIp(ip: string): string {
  if (!ip) return '****';

  // IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return `${parts[0]}.*.*.*`;
  }

  // IPv6
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts[0]}:****:****`;
  }

  return '****';
}

/**
 * Redact a server ID for logging
 * Shows first 4 and last 4 characters
 */
export function redactServerId(id: string): string {
  if (!id || id.length < 12) return '****';
  return `${id.substring(0, 4)}...${id.substring(id.length - 4)}`;
}

class Logger {
  private config: LoggerConfig;

  /** In-memory buffer for log entries awaiting push. */
  private logBuffer: BufferedLogEntry[] = [];

  /** Log push configuration (null when push is not active). */
  private pushConfig: LogPushConfig | null = null;

  /** Interval handle for periodic push. */
  private pushIntervalId: ReturnType<typeof setInterval> | null = null;

  /** Whether a push is currently in-flight (prevents overlapping pushes). */
  private pushing = false;

  /** Optional admin LogBuffer for local log querying via REST API. */
  private adminLogBuffer: AdminLogBuffer | null = null;

  constructor(config: Partial<LoggerConfig> = {}) {
    const nodeEnv = process.env['NODE_ENV'] || 'development';
    const isProduction = nodeEnv === 'production';

    this.config = {
      level: (process.env['LOG_LEVEL'] as LogLevel) || (isProduction ? 'info' : 'debug'),
      redactSensitive: process.env['REDACT_LOGS'] !== 'false' && isProduction,
      environment: isProduction ? 'production' : 'development',
      ...config,
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  /**
   * Set an admin LogBuffer so log entries are also written there
   * for querying via the admin REST API.
   */
  setLogBuffer(buffer: AdminLogBuffer): void {
    this.adminLogBuffer = buffer;
  }

  /**
   * Forward a log entry to the admin LogBuffer (if wired).
   */
  private forwardToAdminBuffer(severity: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.adminLogBuffer) return;

    // Map LogLevel to AdminLogSeverity (they overlap for debug/info/warn/error)
    const adminSeverity: AdminLogSeverity = severity as AdminLogSeverity;

    // Extract category from bracket prefix
    let category = 'general';
    const bracketMatch = message.match(/^\[([^\]]+)\]\s*/);
    if (bracketMatch) {
      category = bracketMatch[1]!.toLowerCase();
    }

    this.adminLogBuffer.add({
      timestamp: Date.now(),
      severity: adminSeverity,
      category,
      message,
      metadata: meta,
    });
  }

  // ─── Log Buffer & Push ─────────────────────────────

  /**
   * Buffer a log entry for push to diagnostics-cf.
   * Extracts the category from bracket-prefixed messages (e.g. "[Pairing] matched").
   */
  private bufferEntry(severity: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.pushConfig) return;

    // Extract category from bracket prefix, e.g. "[Pairing] matched" → category "Pairing"
    let category = 'general';
    const bracketMatch = message.match(/^\[([^\]]+)\]\s*/);
    if (bracketMatch) {
      category = bracketMatch[1]!.toLowerCase();
    }

    const entry: BufferedLogEntry = {
      timestamp: Date.now(),
      severity,
      category,
      message,
      metadata: meta ? JSON.stringify(meta) : undefined,
    };

    this.logBuffer.push(entry);

    // Drop oldest entries if buffer exceeds max
    if (this.logBuffer.length > LOG_BUFFER_MAX) {
      this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_MAX);
    }

    // Push immediately if threshold reached
    if (this.logBuffer.length >= LOG_PUSH_THRESHOLD && !this.pushing) {
      // Fire-and-forget (don't await)
      this.flushLogs().catch(() => {});
    }
  }

  /**
   * Flush buffered log entries to diagnostics-cf.
   * On failure, entries are placed back in the buffer so they aren't lost.
   */
  async flushLogs(): Promise<void> {
    if (!this.pushConfig || this.logBuffer.length === 0 || this.pushing) return;

    this.pushing = true;

    // Take up to BATCH_SIZE entries from the front of the buffer
    const batch = this.logBuffer.splice(0, LOG_PUSH_BATCH_SIZE);

    try {
      const payload = {
        serverId: this.pushConfig.serverId,
        entries: batch,
      };

      const url = `${this.pushConfig.diagnosticsUrl}/diagnostics/server-logs`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.pushConfig.pushSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        // Push failed — put entries back at the front so they aren't lost
        this.restoreBuffer(batch);
        console.warn(`[LogPush] Push failed: HTTP ${response.status}`);
      }
    } catch (err) {
      // Network error — put entries back
      this.restoreBuffer(batch);
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[LogPush] Push error: ${errMsg}`);
    } finally {
      this.pushing = false;
    }
  }

  /** Restore failed batch entries to the front of the buffer, respecting max size. */
  private restoreBuffer(batch: BufferedLogEntry[]): void {
    this.logBuffer.unshift(...batch);
    if (this.logBuffer.length > LOG_BUFFER_MAX) {
      // Drop oldest (front) entries to stay within limit
      this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_MAX);
    }
  }

  /**
   * Start periodic log pushing to diagnostics-cf.
   */
  startLogPush(config: LogPushConfig): LogPushHandle {
    this.pushConfig = config;

    this.pushIntervalId = setInterval(() => {
      this.flushLogs().catch(() => {});
    }, LOG_PUSH_INTERVAL_MS);

    console.log(`[LogPush] Started pushing to ${config.diagnosticsUrl} every ${LOG_PUSH_INTERVAL_MS / 1000}s`);

    return {
      stop: () => {
        if (this.pushIntervalId !== null) {
          clearInterval(this.pushIntervalId);
          this.pushIntervalId = null;
          console.log('[LogPush] Stopped');
        }
        // Final flush attempt (fire-and-forget)
        this.flushLogs().catch(() => {});
      },
      pushNow: () => this.flushLogs(),
      bufferSize: () => this.logBuffer.length,
    };
  }

  /**
   * Check if sensitive data should be redacted
   */
  get shouldRedact(): boolean {
    return this.config.redactSensitive;
  }

  /**
   * Redact pairing code based on environment
   */
  pairingCode(code: string): string {
    return this.config.redactSensitive ? redactPairingCode(code) : code;
  }

  /**
   * Redact IP address based on environment
   */
  ip(ip: string): string {
    return this.config.redactSensitive ? redactIp(ip) : ip;
  }

  /**
   * Redact server ID based on environment
   */
  serverId(id: string): string {
    return this.config.redactSensitive ? redactServerId(id) : id;
  }

  private timestamp(): string {
    return new Date().toISOString();
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      if (meta) {
        console.debug(`${this.timestamp()} [DEBUG] ${message}`, meta);
      } else {
        console.debug(`${this.timestamp()} [DEBUG] ${message}`);
      }
      this.bufferEntry('debug', message, meta);
      this.forwardToAdminBuffer('debug', message, meta);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      if (meta) {
        console.log(`${this.timestamp()} [INFO] ${message}`, meta);
      } else {
        console.log(`${this.timestamp()} [INFO] ${message}`);
      }
      this.bufferEntry('info', message, meta);
      this.forwardToAdminBuffer('info', message, meta);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      if (meta) {
        console.warn(`${this.timestamp()} [WARN] ${message}`, meta);
      } else {
        console.warn(`${this.timestamp()} [WARN] ${message}`);
      }
      this.bufferEntry('warn', message, meta);
      this.forwardToAdminBuffer('warn', message, meta);
    }
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      if (error && meta) {
        console.error(`${this.timestamp()} [ERROR] ${message}`, error, meta);
      } else if (error) {
        console.error(`${this.timestamp()} [ERROR] ${message}`, error);
      } else if (meta) {
        console.error(`${this.timestamp()} [ERROR] ${message}`, meta);
      } else {
        console.error(`${this.timestamp()} [ERROR] ${message}`);
      }
      // Merge error info into metadata for the push entry
      const errorMeta: Record<string, unknown> = { ...meta };
      if (error instanceof Error) {
        errorMeta['errorMessage'] = error.message;
        errorMeta['errorStack'] = error.stack;
      } else if (error !== undefined) {
        errorMeta['errorMessage'] = String(error);
      }
      this.bufferEntry('error', message, Object.keys(errorMeta).length > 0 ? errorMeta : undefined);
      this.forwardToAdminBuffer('error', message, Object.keys(errorMeta).length > 0 ? errorMeta : undefined);
    }
  }

  /**
   * Log a pairing event with automatic redaction
   */
  pairingEvent(
    event: 'registered' | 'request' | 'matched' | 'rejected' | 'expired' | 'disconnected' | 'forwarded' | 'not_found',
    codes: { requester?: string; target?: string; code?: string; type?: string; activeCodes?: number }
  ): void {
    const redactedCodes: Record<string, unknown> = {
      requester: codes.requester ? this.pairingCode(codes.requester) : undefined,
      target: codes.target ? this.pairingCode(codes.target) : undefined,
      code: codes.code ? this.pairingCode(codes.code) : undefined,
      type: codes.type,
      activeCodes: codes.activeCodes,
    };

    // Filter out undefined values
    const filteredCodes = Object.fromEntries(
      Object.entries(redactedCodes).filter(([, v]) => v !== undefined)
    );

    this.info(`[Pairing] ${event}`, filteredCodes);
  }

  /**
   * Log a client connection event with automatic IP redaction
   */
  clientConnection(event: 'connected' | 'disconnected', ip: string): void {
    this.info(`[Client] ${event}`, { ip: this.ip(ip) });
  }

  /**
   * Log a federation event with automatic server ID redaction
   */
  federationEvent(event: string, serverId: string): void {
    this.info(`[Federation] ${event}`, { serverId: this.serverId(serverId) });
  }
}

// Export a singleton instance
export const logger = new Logger();

// Also export the class for testing or custom configurations
export { Logger };
