/**
 * Secure Logger Utility for Cloudflare Workers
 *
 * Provides environment-aware logging with automatic redaction of sensitive data
 * like pairing codes in production environments.
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   logger.pairingEvent('registered', 'ABC123');
 *   logger.debug('Some debug info');
 */

/**
 * Redact a pairing code for logging
 * Shows first and last character only in production
 * @param {string} code - The pairing code
 * @returns {string} - Redacted code
 */
export function redactPairingCode(code) {
  if (!code || code.length < 3) return '****';
  return `${code[0]}****${code[code.length - 1]}`;
}

/**
 * Check if running in production environment
 * In Cloudflare Workers, check for ENVIRONMENT variable
 * @param {object} env - Worker environment bindings
 * @returns {boolean}
 */
function isProduction(env) {
  return env?.ENVIRONMENT === 'production' || env?.NODE_ENV === 'production';
}

/**
 * Create a logger with environment awareness
 * @param {object} env - Worker environment bindings
 * @returns {object} - Logger instance
 */
export function createLogger(env = {}) {
  const production = isProduction(env);
  const logLevel = env?.LOG_LEVEL || (production ? 'info' : 'debug');

  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[logLevel] ?? 1;

  return {
    /**
     * Check if we should redact sensitive data
     */
    get shouldRedact() {
      return production;
    },

    /**
     * Redact pairing code based on environment
     * @param {string} code
     * @returns {string}
     */
    pairingCode(code) {
      return production ? redactPairingCode(code) : code;
    },

    /**
     * Log a debug message (development only)
     * @param {string} message
     * @param {object} meta
     */
    debug(message, meta) {
      if (currentLevel <= 0) {
        if (meta) {
          console.debug(`[DEBUG] ${message}`, meta);
        } else {
          console.debug(`[DEBUG] ${message}`);
        }
      }
    },

    /**
     * Log an info message
     * @param {string} message
     * @param {object} meta
     */
    info(message, meta) {
      if (currentLevel <= 1) {
        if (meta) {
          console.log(`[INFO] ${message}`, meta);
        } else {
          console.log(`[INFO] ${message}`);
        }
      }
    },

    /**
     * Log a warning
     * @param {string} message
     * @param {object} meta
     */
    warn(message, meta) {
      if (currentLevel <= 2) {
        if (meta) {
          console.warn(`[WARN] ${message}`, meta);
        } else {
          console.warn(`[WARN] ${message}`);
        }
      }
    },

    /**
     * Log an error
     * @param {string} message
     * @param {Error} error
     */
    error(message, error) {
      if (currentLevel <= 3) {
        console.error(`[ERROR] ${message}`, error || '');
      }
    },

    /**
     * Log a pairing event with automatic redaction
     * @param {'registered'|'disconnected'|'signaling'} event
     * @param {string} code - Pairing code
     * @param {string} target - Target code (optional)
     */
    pairingEvent(event, code, target) {
      const redactedCode = this.pairingCode(code);
      const redactedTarget = target ? this.pairingCode(target) : undefined;

      this.debug(`[Pairing] ${event}`, {
        code: redactedCode,
        ...(redactedTarget && { target: redactedTarget }),
      });
    },
  };
}

// Default logger instance (for non-production use or when env not available)
export const logger = createLogger();
