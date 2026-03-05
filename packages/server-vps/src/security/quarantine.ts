/**
 * QuarantineManager — In-memory quarantine map with TTL-based expiry.
 *
 * Tracks quarantined source hashes (hashed IPs) and auto-expires them.
 * Threshold-based auto-quarantine: 50 violations/hour -> 1 hour quarantine.
 *
 * Quarantined sources receive WebSocket close code 4403 on new connections.
 */

/** Default auto-quarantine threshold: violations per hour */
const DEFAULT_VIOLATION_THRESHOLD = 50;

/** Default quarantine duration in milliseconds (1 hour) */
const DEFAULT_QUARANTINE_DURATION_MS = 60 * 60 * 1000;

/** How often to clean up expired entries (every 60 seconds) */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * A quarantine entry in the map.
 */
export interface QuarantineEntry {
  sourceHash: string;
  reason: 'auto' | 'manual';
  quarantinedAt: number;
  expiresAt: number;
  quarantinedBy: string;
}

/**
 * Configuration for the quarantine manager.
 */
export interface QuarantineConfig {
  /** Enable auto-quarantine based on violation threshold */
  autoQuarantineEnabled: boolean;
  /** Number of violations in the window that triggers quarantine */
  violationThreshold: number;
  /** Window size in milliseconds for counting violations */
  thresholdWindowMs: number;
  /** Duration of quarantine in milliseconds */
  quarantineDurationMs: number;
}

const DEFAULT_CONFIG: QuarantineConfig = {
  autoQuarantineEnabled: true,
  violationThreshold: DEFAULT_VIOLATION_THRESHOLD,
  thresholdWindowMs: 60 * 60 * 1000, // 1 hour
  quarantineDurationMs: DEFAULT_QUARANTINE_DURATION_MS,
};

export class QuarantineManager {
  private entries = new Map<string, QuarantineEntry>();
  private config: QuarantineConfig;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<QuarantineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a source hash is currently quarantined.
   */
  isQuarantined(sourceHash: string): boolean {
    const entry = this.entries.get(sourceHash);
    if (!entry) return false;

    // Check TTL
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(sourceHash);
      return false;
    }

    return true;
  }

  /**
   * Get the quarantine entry for a source hash, or undefined if not quarantined.
   */
  getEntry(sourceHash: string): QuarantineEntry | undefined {
    const entry = this.entries.get(sourceHash);
    if (!entry) return undefined;

    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(sourceHash);
      return undefined;
    }

    return entry;
  }

  /**
   * Quarantine a source hash for the specified duration.
   */
  quarantine(
    sourceHash: string,
    durationMs?: number,
    reason: 'auto' | 'manual' = 'manual',
    quarantinedBy: string = 'system',
  ): QuarantineEntry {
    const now = Date.now();
    const duration = durationMs ?? this.config.quarantineDurationMs;

    const entry: QuarantineEntry = {
      sourceHash,
      reason,
      quarantinedAt: now,
      expiresAt: now + duration,
      quarantinedBy,
    };

    this.entries.set(sourceHash, entry);
    return entry;
  }

  /**
   * Remove a source hash from quarantine.
   */
  remove(sourceHash: string): boolean {
    return this.entries.delete(sourceHash);
  }

  /**
   * Get all currently quarantined entries (excluding expired).
   */
  getAll(): QuarantineEntry[] {
    const now = Date.now();
    const active: QuarantineEntry[] = [];

    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
      } else {
        active.push(entry);
      }
    }

    return active;
  }

  /**
   * Get the number of currently quarantined sources (no side effects).
   */
  get size(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.entries.values()) {
      if (now < entry.expiresAt) {
        count++;
      }
    }
    return count;
  }

  /**
   * Check if a source should be auto-quarantined based on violation count.
   * If so, quarantine it and return the entry. Otherwise return undefined.
   *
   * @param sourceHash The source hash to check
   * @param violationCount The number of violations in the current window
   */
  checkAutoQuarantine(
    sourceHash: string,
    violationCount: number,
  ): QuarantineEntry | undefined {
    if (!this.config.autoQuarantineEnabled) return undefined;
    if (this.isQuarantined(sourceHash)) return undefined;

    if (violationCount >= this.config.violationThreshold) {
      return this.quarantine(
        sourceHash,
        this.config.quarantineDurationMs,
        'auto',
        'system',
      );
    }

    return undefined;
  }

  /**
   * Update the quarantine configuration.
   */
  updateConfig(config: Partial<QuarantineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get the current configuration.
   */
  getConfig(): QuarantineConfig {
    return { ...this.config };
  }

  /**
   * Start automatic cleanup of expired entries.
   */
  startCleanup(): void {
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop automatic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Remove all expired entries from the map.
   */
  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Shutdown the quarantine manager.
   */
  shutdown(): void {
    this.stopCleanup();
    this.entries.clear();
  }
}
