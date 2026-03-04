/**
 * TransparencyLog Unit Tests
 *
 * Tests for the append-only audit log with hash-chaining.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TransparencyLog } from '../../src/utils/transparency-log.js';

class MockStorage {
  constructor() {
    this.data = new Map();
  }
  async get(key) { return this.data.get(key); }
  async put(keyOrMap, value) {
    // Support atomic writes via Map argument
    if (keyOrMap instanceof Map) {
      for (const [k, v] of keyOrMap) {
        this.data.set(k, v);
      }
    } else {
      this.data.set(keyOrMap, value);
    }
  }
  async list({ prefix, start, limit }) {
    const results = new Map();
    // Sort keys lexicographically to match DO storage behavior
    const sortedKeys = [...this.data.keys()].sort();
    for (const key of sortedKeys) {
      if (start && key < start) continue;
      if (key.startsWith(prefix) && results.size < (limit || Infinity)) {
        results.set(key, this.data.get(key));
      }
    }
    return results;
  }
  clear() { this.data.clear(); }
}

describe('TransparencyLog', () => {
  let storage;
  let log;

  beforeEach(() => {
    storage = new MockStorage();
    log = new TransparencyLog(storage, 'test-audit');
  });

  describe('append', () => {
    it('should append first entry with genesis hash', async () => {
      const entry = await log.append({
        action: 'test_action',
        data: 'test_data',
      });

      expect(entry.sequence).toBe(1);
      expect(entry.previousHash).toBe('genesis');
      expect(entry.entryHash).toBeTruthy();
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(entry.action).toBe('test_action');
    });

    it('should chain subsequent entries', async () => {
      const entry1 = await log.append({ action: 'first' });
      const entry2 = await log.append({ action: 'second' });

      expect(entry2.sequence).toBe(2);
      expect(entry2.previousHash).toBe(entry1.entryHash);
    });

    it('should increment sequence numbers correctly', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      const entry3 = await log.append({ action: 'c' });

      expect(entry3.sequence).toBe(3);
    });

    it('should store entry with zero-padded key', async () => {
      await log.append({ action: 'test' });

      const raw = await storage.get('test-audit:00000001');
      expect(raw).toBeTruthy();
      expect(raw.sequence).toBe(1);
    });

    it('should write entry and metadata atomically', async () => {
      // Verify that both the entry and metadata are stored after append
      await log.append({ action: 'test' });

      const entry = await storage.get('test-audit:00000001');
      const meta = await storage.get('test-audit:meta:sequence');

      expect(entry).toBeTruthy();
      expect(meta).toBeTruthy();
      expect(meta.sequence).toBe(1);
      expect(meta.lastHash).toBe(entry.entryHash);
    });
  });

  describe('getEntries', () => {
    it('should return empty array for empty log', async () => {
      const entries = await log.getEntries();
      expect(entries).toEqual([]);
    });

    it('should return all entries by default', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      await log.append({ action: 'c' });

      const entries = await log.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].action).toBe('a');
      expect(entries[2].action).toBe('c');
    });

    it('should respect fromSequence parameter', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      await log.append({ action: 'c' });

      const entries = await log.getEntries(2);
      expect(entries).toHaveLength(2);
      expect(entries[0].sequence).toBe(2);
      expect(entries[1].sequence).toBe(3);
    });

    it('should respect limit parameter', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      await log.append({ action: 'c' });

      const entries = await log.getEntries(0, 2);
      expect(entries).toHaveLength(2);
    });

    it('should exclude meta keys from results', async () => {
      await log.append({ action: 'test' });
      const entries = await log.getEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('test');
    });

    it('should correctly paginate with fromSequence and limit combined', async () => {
      // Create 10 entries
      for (let i = 1; i <= 10; i++) {
        await log.append({ action: `action_${i}` });
      }

      // Request entries 5-7 (fromSequence=5, limit=3)
      const entries = await log.getEntries(5, 3);
      expect(entries).toHaveLength(3);
      expect(entries[0].sequence).toBe(5);
      expect(entries[1].sequence).toBe(6);
      expect(entries[2].sequence).toBe(7);
    });

    it('should return correct results when fromSequence is beyond existing entries', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });

      const entries = await log.getEntries(100);
      expect(entries).toHaveLength(0);
    });

    it('should handle large entry count with pagination correctly', async () => {
      // Create 50 entries to test pagination at scale
      for (let i = 1; i <= 50; i++) {
        await log.append({ action: `action_${i}` });
      }

      // Request entries from sequence 25 with limit 20
      const entries = await log.getEntries(25, 20);
      expect(entries).toHaveLength(20);
      expect(entries[0].sequence).toBe(25);
      expect(entries[19].sequence).toBe(44);

      // Verify all entries are in correct order
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].sequence).toBe(entries[i - 1].sequence + 1);
      }
    });
  });

  describe('verify', () => {
    it('should verify valid chain', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });
      await log.append({ action: 'c' });

      const result = await log.verify();
      expect(result.valid).toBe(true);
      expect(result.entries).toBe(3);
      expect(result.brokenAt).toBeUndefined();
    });

    it('should detect broken chain (tampered previousHash)', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });

      // Tamper with entry 2's previousHash
      const entry2 = await storage.get('test-audit:00000002');
      entry2.previousHash = 'tampered-hash';
      await storage.put('test-audit:00000002', entry2);

      const result = await log.verify();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('should detect tampered entry content', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });

      // Tamper with entry 2's action (but keep hashes)
      const entry2 = await storage.get('test-audit:00000002');
      entry2.action = 'tampered-action';
      await storage.put('test-audit:00000002', entry2);

      const result = await log.verify();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('should verify empty log', async () => {
      const result = await log.verify();
      expect(result.valid).toBe(true);
      expect(result.entries).toBe(0);
    });
  });

  describe('getCurrentSequence', () => {
    it('should return 0 for empty log', async () => {
      const seq = await log.getCurrentSequence();
      expect(seq).toBe(0);
    });

    it('should return current sequence after appends', async () => {
      await log.append({ action: 'a' });
      await log.append({ action: 'b' });

      const seq = await log.getCurrentSequence();
      expect(seq).toBe(2);
    });
  });
});
