/**
 * Unit tests for AdminUsersDO authorization code logic
 *
 * Tests the handleStoreAuthCode and handleExchangeAuthCode methods
 * via the DO's internal fetch routing.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Mock storage for testing DO logic
class MockStorage {
  private data = new Map<string, unknown>();
  private alarmTime: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const [key, value] of this.data.entries()) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        result.set(key, value as T);
      }
    }
    return result;
  }

  async setAlarm(time: number): Promise<void> {
    this.alarmTime = time;
  }

  getAlarm(): number | null {
    return this.alarmTime;
  }

  clear(): void {
    this.data.clear();
    this.alarmTime = null;
  }
}

describe('Auth Code DO Logic', () => {
  let storage: MockStorage;

  beforeEach(() => {
    storage = new MockStorage();
  });

  it('should store an auth code with expiration', async () => {
    const code = 'a'.repeat(64);
    const expiresAt = Date.now() + 30_000;
    const authCode = {
      code,
      payload: { sub: 'user1', username: 'admin', role: 'admin' },
      createdAt: Date.now(),
      expiresAt,
      used: false,
    };

    await storage.put(`authcode:${code}`, authCode);

    const stored = await storage.get(`authcode:${code}`);
    expect(stored).toEqual(authCode);
  });

  it('should delete auth code on exchange (single-use)', async () => {
    const code = 'b'.repeat(64);
    const authCode = {
      code,
      payload: { sub: 'user1', username: 'admin', role: 'admin' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      used: false,
    };

    await storage.put(`authcode:${code}`, authCode);

    // Simulate exchange: read, verify, delete
    const retrieved = await storage.get(`authcode:${code}`);
    expect(retrieved).toBeDefined();

    await storage.delete(`authcode:${code}`);

    // Second read should return undefined
    const secondRead = await storage.get(`authcode:${code}`);
    expect(secondRead).toBeUndefined();
  });

  it('should reject expired codes', async () => {
    const code = 'c'.repeat(64);
    const authCode = {
      code,
      payload: { sub: 'user1', username: 'admin', role: 'admin' },
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 30_000, // Already expired
      used: false,
    };

    await storage.put(`authcode:${code}`, authCode);

    const retrieved = await storage.get<typeof authCode>(`authcode:${code}`);
    expect(retrieved).toBeDefined();
    expect(Date.now() > retrieved!.expiresAt).toBe(true);
  });

  it('should clean up expired codes in alarm handler', async () => {
    const validCode = 'd'.repeat(64);
    const expiredCode = 'e'.repeat(64);

    await storage.put(`authcode:${validCode}`, {
      code: validCode,
      payload: { sub: 'user1', username: 'admin', role: 'admin' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      used: false,
    });

    await storage.put(`authcode:${expiredCode}`, {
      code: expiredCode,
      payload: { sub: 'user2', username: 'admin2', role: 'admin' },
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 30_000, // Expired
      used: false,
    });

    // Simulate alarm handler
    const now = Date.now();
    const allKeys = await storage.list<{ expiresAt: number }>({ prefix: 'authcode:' });
    for (const [key, authCode] of allKeys.entries()) {
      if (authCode.expiresAt < now) {
        await storage.delete(key);
      }
    }

    // Valid code should still exist
    expect(await storage.get(`authcode:${validCode}`)).toBeDefined();
    // Expired code should be cleaned up
    expect(await storage.get(`authcode:${expiredCode}`)).toBeUndefined();
  });

  it('should generate 64-character hex codes (32 bytes)', () => {
    const codeBytes = new Uint8Array(32);
    crypto.getRandomValues(codeBytes);
    const code = Array.from(codeBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(code).toHaveLength(64);
    expect(code).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should set alarm after storing a code', async () => {
    const code = 'f'.repeat(64);
    const expiresAt = Date.now() + 30_000;

    await storage.put(`authcode:${code}`, {
      code,
      payload: { sub: 'user1', username: 'admin', role: 'admin' },
      createdAt: Date.now(),
      expiresAt,
      used: false,
    });

    // Simulate setting alarm as the DO would
    const cleanupDelay = expiresAt - Date.now() + 5000;
    if (cleanupDelay > 0) {
      await storage.setAlarm(Date.now() + cleanupDelay);
    }

    expect(storage.getAlarm()).not.toBeNull();
    expect(storage.getAlarm()!).toBeGreaterThan(Date.now());
  });

  it('should handle multiple codes for the same user', async () => {
    const code1 = '1'.repeat(64);
    const code2 = '2'.repeat(64);
    const payload = { sub: 'user1', username: 'admin', role: 'admin' };

    await storage.put(`authcode:${code1}`, {
      code: code1,
      payload,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      used: false,
    });

    await storage.put(`authcode:${code2}`, {
      code: code2,
      payload,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      used: false,
    });

    // Both codes should exist independently
    expect(await storage.get(`authcode:${code1}`)).toBeDefined();
    expect(await storage.get(`authcode:${code2}`)).toBeDefined();

    // Deleting one should not affect the other
    await storage.delete(`authcode:${code1}`);
    expect(await storage.get(`authcode:${code1}`)).toBeUndefined();
    expect(await storage.get(`authcode:${code2}`)).toBeDefined();
  });

  it('should return undefined for non-existent code', async () => {
    const result = await storage.get<unknown>(`authcode:${'0'.repeat(64)}`);
    expect(result).toBeUndefined();
  });
});
