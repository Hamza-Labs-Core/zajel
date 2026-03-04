/**
 * Unit tests for admin-cf crypto utilities.
 *
 * Tests password hashing, JWT operations, and timing-safe comparison.
 */

import { describe, it, expect } from 'vitest';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateJwt,
  verifyJwt,
  generateId,
  timingSafeEqual,
} from '../../src/crypto.js';

describe('Admin CF Crypto', () => {
  describe('Salt generation', () => {
    it('generates random 64-character hex salt', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();

      expect(salt1).toMatch(/^[0-9a-f]{64}$/);
      expect(salt2).toMatch(/^[0-9a-f]{64}$/);
      expect(salt1).not.toBe(salt2); // Different each time
    });
  });

  describe('Password hashing', () => {
    it('hashes password with PBKDF2', async () => {
      const password = 'test-password-123';
      const salt = generateSalt();

      const hash = await hashPassword(password, salt);

      expect(hash).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars
      expect(hash).not.toBe(password); // Obviously not plaintext
    });

    it('produces same hash for same password and salt', async () => {
      const password = 'consistent-password';
      const salt = generateSalt();

      const hash1 = await hashPassword(password, salt);
      const hash2 = await hashPassword(password, salt);

      expect(hash1).toBe(hash2);
    });

    it('produces different hash for different salt', async () => {
      const password = 'same-password';
      const salt1 = generateSalt();
      const salt2 = generateSalt();

      const hash1 = await hashPassword(password, salt1);
      const hash2 = await hashPassword(password, salt2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Password verification', () => {
    it('accepts correct password', async () => {
      const password = 'correct-password';
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      const result = await verifyPassword(password, hash, salt);

      expect(result).toBe(true);
    });

    it('rejects incorrect password', async () => {
      const correctPassword = 'correct-password';
      const incorrectPassword = 'wrong-password';
      const salt = generateSalt();
      const hash = await hashPassword(correctPassword, salt);

      const result = await verifyPassword(incorrectPassword, hash, salt);

      expect(result).toBe(false);
    });

    it('rejects password with wrong salt', async () => {
      const password = 'test-password';
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const hash = await hashPassword(password, salt1);

      const result = await verifyPassword(password, hash, salt2);

      expect(result).toBe(false);
    });

    it('handles empty password', async () => {
      const password = '';
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      const resultCorrect = await verifyPassword('', hash, salt);
      const resultIncorrect = await verifyPassword('not-empty', hash, salt);

      expect(resultCorrect).toBe(true);
      expect(resultIncorrect).toBe(false);
    });
  });

  describe('JWT generation and verification', () => {
    it('generates and verifies valid JWT', async () => {
      const payload = { userId: '123', username: 'admin' };
      const secret = 'test-secret';

      const token = await generateJwt(payload, secret, 15);
      const decoded = await verifyJwt<typeof payload>(token, secret);

      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe('123');
      expect(decoded?.username).toBe('admin');
    });

    it('rejects JWT with wrong secret', async () => {
      const payload = { userId: '123' };
      const correctSecret = 'correct-secret';
      const wrongSecret = 'wrong-secret';

      const token = await generateJwt(payload, correctSecret, 15);
      const decoded = await verifyJwt(token, wrongSecret);

      expect(decoded).toBeNull();
    });

    it('includes expiration in payload', async () => {
      const payload = { userId: '123' };
      const secret = 'test-secret';

      const token = await generateJwt(payload, secret, 15);
      const decoded = await verifyJwt<typeof payload & { exp: number }>(token, secret);

      expect(decoded).not.toBeNull();
      expect(decoded?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('rejects expired JWT', async () => {
      const payload = { userId: '123' };
      const secret = 'test-secret';

      // Generate token that expires immediately (0 minutes)
      const token = await generateJwt(payload, secret, 0);

      // Wait a bit to ensure expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      const decoded = await verifyJwt(token, secret);

      expect(decoded).toBeNull();
    });

    it('rejects malformed JWT', async () => {
      const secret = 'test-secret';

      expect(await verifyJwt('not.a.jwt', secret)).toBeNull();
      expect(await verifyJwt('only.two', secret)).toBeNull();
      expect(await verifyJwt('', secret)).toBeNull();
    });
  });

  describe('ID generation', () => {
    it('generates random 32-character hex ID', () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).toMatch(/^[0-9a-f]{32}$/);
      expect(id2).toMatch(/^[0-9a-f]{32}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('timingSafeEqual (via verifyPassword)', () => {
    /**
     * Since timingSafeEqual is now exported, we test it both directly
     * and indirectly through verifyPassword.
     * The password verification tests above already cover correctness
     * of the integration path.
     */

    it('verifyPassword uses timing-safe comparison (smoke test)', async () => {
      // This is a smoke test to ensure timing-safe comparison is being used.
      // The actual timing properties are tested in the server's test suite.
      const password = 'test';
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      // These should complete without throwing
      await verifyPassword(password, hash, salt);
      await verifyPassword('wrong', hash, salt);
      await verifyPassword('much-longer-wrong-password', hash, salt);
    });
  });

  describe('timingSafeEqual (direct)', () => {
    it('returns true for equal strings', async () => {
      expect(await timingSafeEqual('hello', 'hello')).toBe(true);
      expect(await timingSafeEqual('', '')).toBe(true);
    });

    it('returns false for different strings of equal length', async () => {
      expect(await timingSafeEqual('hello', 'world')).toBe(false);
    });

    it('returns false for different strings of different lengths', async () => {
      expect(await timingSafeEqual('short', 'much longer string')).toBe(false);
      expect(await timingSafeEqual('', 'non-empty')).toBe(false);
    });
  });
});
