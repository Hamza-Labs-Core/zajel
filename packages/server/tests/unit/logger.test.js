/**
 * Unit tests for logger utilities.
 *
 * Covers:
 * - redactPairingCode function
 * - createLogger with different environments
 * - Log level filtering
 * - Pairing event logging with automatic redaction
 * - Production vs development behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { redactPairingCode, createLogger } from '../../src/logger.js';

describe('Logger Utilities', () => {
  describe('redactPairingCode', () => {
    it('should redact middle characters of code', () => {
      expect(redactPairingCode('ABC123')).toBe('A****3');
      expect(redactPairingCode('TEST')).toBe('T****T');
    });

    it('should handle short codes', () => {
      expect(redactPairingCode('AB')).toBe('****');
      expect(redactPairingCode('A')).toBe('****');
      expect(redactPairingCode('')).toBe('****');
    });

    it('should handle three character code', () => {
      expect(redactPairingCode('ABC')).toBe('A****C');
    });

    it('should handle long codes', () => {
      expect(redactPairingCode('ABCDEFGHIJ')).toBe('A****J');
    });

    it('should handle null/undefined input', () => {
      expect(redactPairingCode(null)).toBe('****');
      expect(redactPairingCode(undefined)).toBe('****');
    });
  });

  describe('createLogger', () => {
    let consoleSpies;

    beforeEach(() => {
      consoleSpies = {
        debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('Environment Detection', () => {
      it('should detect production environment', () => {
        const logger = createLogger({ ENVIRONMENT: 'production' });
        expect(logger.shouldRedact).toBe(true);
      });

      it('should detect development environment', () => {
        const logger = createLogger({ ENVIRONMENT: 'development' });
        expect(logger.shouldRedact).toBe(false);
      });

      it('should default to development when no env provided', () => {
        const logger = createLogger();
        expect(logger.shouldRedact).toBe(false);
      });

      it('should support NODE_ENV for production detection', () => {
        const logger = createLogger({ NODE_ENV: 'production' });
        expect(logger.shouldRedact).toBe(true);
      });
    });

    describe('Pairing Code Redaction', () => {
      it('should redact pairing codes in production', () => {
        const logger = createLogger({ ENVIRONMENT: 'production' });
        expect(logger.pairingCode('ABC123')).toBe('A****3');
      });

      it('should not redact pairing codes in development', () => {
        const logger = createLogger({ ENVIRONMENT: 'development' });
        expect(logger.pairingCode('ABC123')).toBe('ABC123');
      });
    });

    describe('Log Level Filtering', () => {
      it('should log debug messages when level is debug', () => {
        const logger = createLogger({ LOG_LEVEL: 'debug' });
        logger.debug('test message');
        expect(consoleSpies.debug).toHaveBeenCalledWith('[DEBUG] test message');
      });

      it('should not log debug messages when level is info', () => {
        const logger = createLogger({ LOG_LEVEL: 'info' });
        logger.debug('test message');
        expect(consoleSpies.debug).not.toHaveBeenCalled();
      });

      it('should log info messages when level is info', () => {
        const logger = createLogger({ LOG_LEVEL: 'info' });
        logger.info('test message');
        expect(consoleSpies.log).toHaveBeenCalledWith('[INFO] test message');
      });

      it('should not log info messages when level is warn', () => {
        const logger = createLogger({ LOG_LEVEL: 'warn' });
        logger.info('test message');
        expect(consoleSpies.log).not.toHaveBeenCalled();
      });

      it('should log warn messages when level is warn', () => {
        const logger = createLogger({ LOG_LEVEL: 'warn' });
        logger.warn('test message');
        expect(consoleSpies.warn).toHaveBeenCalledWith('[WARN] test message');
      });

      it('should always log error messages', () => {
        const logger = createLogger({ LOG_LEVEL: 'error' });
        logger.error('test message');
        expect(consoleSpies.error).toHaveBeenCalledWith('[ERROR] test message', '');
      });

      it('should default to info level in production', () => {
        const logger = createLogger({ ENVIRONMENT: 'production' });
        logger.debug('test');
        expect(consoleSpies.debug).not.toHaveBeenCalled();
        logger.info('test');
        expect(consoleSpies.log).toHaveBeenCalled();
      });

      it('should default to debug level in development', () => {
        const logger = createLogger({ ENVIRONMENT: 'development' });
        logger.debug('test');
        expect(consoleSpies.debug).toHaveBeenCalled();
      });
    });

    describe('Log Messages with Metadata', () => {
      it('should log debug with metadata', () => {
        const logger = createLogger({ LOG_LEVEL: 'debug' });
        logger.debug('test', { key: 'value' });
        expect(consoleSpies.debug).toHaveBeenCalledWith('[DEBUG] test', { key: 'value' });
      });

      it('should log info with metadata', () => {
        const logger = createLogger({ LOG_LEVEL: 'info' });
        logger.info('test', { key: 'value' });
        expect(consoleSpies.log).toHaveBeenCalledWith('[INFO] test', { key: 'value' });
      });

      it('should log warn with metadata', () => {
        const logger = createLogger({ LOG_LEVEL: 'warn' });
        logger.warn('test', { key: 'value' });
        expect(consoleSpies.warn).toHaveBeenCalledWith('[WARN] test', { key: 'value' });
      });

      it('should log error with Error object', () => {
        const logger = createLogger({ LOG_LEVEL: 'error' });
        const error = new Error('test error');
        logger.error('test', error);
        expect(consoleSpies.error).toHaveBeenCalledWith('[ERROR] test', error);
      });
    });

    describe('Pairing Event Logging', () => {
      it('should log pairing event with redacted code in production', () => {
        const logger = createLogger({ ENVIRONMENT: 'production', LOG_LEVEL: 'debug' });
        logger.pairingEvent('registered', 'ABC123');
        expect(consoleSpies.debug).toHaveBeenCalledWith(
          '[DEBUG] [Pairing] registered',
          { code: 'A****3' }
        );
      });

      it('should log pairing event with plain code in development', () => {
        const logger = createLogger({ ENVIRONMENT: 'development', LOG_LEVEL: 'debug' });
        logger.pairingEvent('registered', 'ABC123');
        expect(consoleSpies.debug).toHaveBeenCalledWith(
          '[DEBUG] [Pairing] registered',
          { code: 'ABC123' }
        );
      });

      it('should log pairing event with target code', () => {
        const logger = createLogger({ ENVIRONMENT: 'production', LOG_LEVEL: 'debug' });
        logger.pairingEvent('signaling', 'ABC123', 'XYZ789');
        expect(consoleSpies.debug).toHaveBeenCalledWith(
          '[DEBUG] [Pairing] signaling',
          { code: 'A****3', target: 'X****9' }
        );
      });
    });
  });
});
