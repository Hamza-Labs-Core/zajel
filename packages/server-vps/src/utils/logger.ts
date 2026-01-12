/**
 * Secure Logger Utility
 *
 * Provides structured logging with automatic redaction of sensitive data
 * like pairing codes, IP addresses, and server IDs in production environments.
 *
 * Based on OWASP guidelines and CWE-532 prevention strategies.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      if (meta) {
        console.debug(`[DEBUG] ${message}`, meta);
      } else {
        console.debug(`[DEBUG] ${message}`);
      }
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      if (meta) {
        console.log(`[INFO] ${message}`, meta);
      } else {
        console.log(`[INFO] ${message}`);
      }
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      if (meta) {
        console.warn(`[WARN] ${message}`, meta);
      } else {
        console.warn(`[WARN] ${message}`);
      }
    }
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      if (error && meta) {
        console.error(`[ERROR] ${message}`, error, meta);
      } else if (error) {
        console.error(`[ERROR] ${message}`, error);
      } else if (meta) {
        console.error(`[ERROR] ${message}`, meta);
      } else {
        console.error(`[ERROR] ${message}`);
      }
    }
  }

  /**
   * Log a pairing event with automatic redaction
   */
  pairingEvent(
    event: 'registered' | 'request' | 'matched' | 'rejected' | 'expired' | 'disconnected' | 'forwarded' | 'forward_failed' | 'not_found',
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

    this.debug(`[Pairing] ${event}`, filteredCodes);
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
