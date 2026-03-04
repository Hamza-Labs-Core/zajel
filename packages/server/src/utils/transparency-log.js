/**
 * Append-only transparency log with hash-chaining.
 *
 * Provides tamper-evident audit logging in Cloudflare Durable Object storage.
 * Each entry is assigned a sequential number and includes the hash of the
 * previous entry, creating a verifiable chain.
 *
 * Storage schema:
 * - `{prefix}:meta:sequence` → { sequence: number, lastHash: string }
 * - `{prefix}:{sequence}` → { ...entry, previousHash, entryHash }
 *
 * Note: computeKeySetHash([]) produces a valid deterministic hash of the
 * JSON string "[]". This serves as a sentinel value for the initial state
 * when no keys exist yet.
 */

/**
 * TransparencyLog provides append-only, hash-chained audit logging.
 */
export class TransparencyLog {
  /**
   * @param {DurableObjectStorage} storage - Durable Object storage instance
   * @param {string} prefix - Key prefix for log entries (default: 'audit-log')
   */
  constructor(storage, prefix = 'audit-log') {
    this.storage = storage;
    this.prefix = prefix;
  }

  /**
   * Append a new entry to the log.
   *
   * Uses atomic writes (single storage.put with a Map) to ensure
   * both the log entry and sequence metadata are written together.
   * This prevents inconsistency if the Worker crashes mid-write.
   *
   * @param {object} entry - Log entry data (action, ip, etc.)
   * @returns {Promise<object>} The complete log entry with sequence, hash, etc.
   */
  async append(entry) {
    const seqKey = `${this.prefix}:meta:sequence`;
    const meta = (await this.storage.get(seqKey)) || { sequence: 0, lastHash: 'genesis' };

    const sequence = meta.sequence + 1;
    const logEntry = {
      sequence,
      timestamp: Date.now(),
      previousHash: meta.lastHash,
      ...entry,
    };

    // Hash the entry (excluding entryHash field itself)
    const entryBytes = new TextEncoder().encode(JSON.stringify(logEntry));
    const hashBuffer = await crypto.subtle.digest('SHA-256', entryBytes);
    const entryHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    logEntry.entryHash = entryHash;

    // Store the log entry and update sequence metadata atomically
    const key = `${this.prefix}:${String(sequence).padStart(8, '0')}`;
    await this.storage.put(new Map([
      [key, logEntry],
      [seqKey, { sequence, lastHash: entryHash }],
    ]));

    return logEntry;
  }

  /**
   * Retrieve log entries starting from a given sequence number.
   *
   * Uses the `start` option of `storage.list()` to skip directly to the
   * desired range, avoiding scanning and discarding earlier entries.
   *
   * @param {number} fromSequence - Start sequence (default: 0 = all entries)
   * @param {number} limit - Maximum entries to return (default: 100)
   * @returns {Promise<object[]>} Array of log entries, sorted by sequence
   */
  async getEntries(fromSequence = 0, limit = 100) {
    const entries = [];

    // Use start key to skip directly to the desired range
    const startKey = fromSequence > 0
      ? `${this.prefix}:${String(fromSequence).padStart(8, '0')}`
      : `${this.prefix}:`;

    const results = await this.storage.list({
      start: startKey,
      prefix: `${this.prefix}:`,
      limit: limit + 1, // +1 to account for potential meta key within range
    });

    for (const [key, value] of results) {
      if (key.startsWith(`${this.prefix}:meta:`)) continue;
      if (entries.length < limit) {
        entries.push(value);
      }
    }

    // Sort by sequence (should already be sorted, but ensure it)
    return entries.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Verify the integrity of the log's hash chain.
   *
   * Recomputes hashes and checks that each entry's previousHash matches
   * the prior entry's entryHash.
   *
   * @returns {Promise<{ valid: boolean, entries: number, brokenAt?: number }>}
   */
  async verify() {
    const entries = await this.getEntries(0, 10000);
    let prevHash = 'genesis';

    for (const entry of entries) {
      // Check hash chain continuity
      if (entry.previousHash !== prevHash) {
        return { valid: false, entries: entries.length, brokenAt: entry.sequence };
      }

      // Recompute hash (excluding entryHash field)
      const { entryHash, ...rest } = entry;
      const bytes = new TextEncoder().encode(JSON.stringify(rest));
      const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
      const computedHash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      if (computedHash !== entryHash) {
        return { valid: false, entries: entries.length, brokenAt: entry.sequence };
      }

      prevHash = entry.entryHash;
    }

    return { valid: true, entries: entries.length };
  }

  /**
   * Get the current sequence number (0 if no entries).
   * @returns {Promise<number>}
   */
  async getCurrentSequence() {
    const seqKey = `${this.prefix}:meta:sequence`;
    const meta = await this.storage.get(seqKey);
    return meta ? meta.sequence : 0;
  }
}
