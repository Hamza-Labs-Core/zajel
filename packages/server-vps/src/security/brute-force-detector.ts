/**
 * BruteForceDetector — Tracks failed pairing attempts per source.
 *
 * Alerts when 20+ failures per source per 10 minutes.
 * Classifies patterns as 'scanning' (many distinct targets),
 * 'targeted' (few targets, many attempts), or 'mixed'.
 *
 * Integrates with QuarantineManager for auto-quarantine.
 */

import type { SecurityEventReporter } from './security-events.js';
import type { QuarantineManager } from './quarantine.js';

/** Default failure threshold per source per window */
const DEFAULT_FAILURE_THRESHOLD = 20;

/** Default window size in milliseconds (10 minutes) */
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/** Cleanup interval for expired window entries (every 60 seconds) */
const CLEANUP_INTERVAL_MS = 60_000;

/** Brute force pattern classification */
export type BruteForcePattern = 'scanning' | 'targeted' | 'mixed';

/**
 * A failed pairing attempt record.
 */
export interface FailedPairAttempt {
  timestamp: number;
  targetCodeHash: string;
}

/**
 * Per-source sliding window tracker.
 */
interface SourceWindow {
  attempts: FailedPairAttempt[];
  alertTriggered: boolean;
}

/**
 * Brute force alert emitted when threshold is crossed.
 */
export interface BruteForceAlert {
  sourceHash: string;
  pattern: BruteForcePattern;
  failedAttempts: number;
  distinctTargets: number;
  windowMinutes: number;
  timestamp: number;
}

/**
 * Callback for brute force alerts.
 */
export type BruteForceAlertCallback = (alert: BruteForceAlert) => void;

/**
 * Configuration for the brute force detector.
 */
export interface BruteForceDetectorConfig {
  /** Number of failures in the window that triggers an alert */
  failureThreshold: number;
  /** Sliding window size in milliseconds */
  windowMs: number;
  /** Enable auto-quarantine integration */
  autoQuarantineEnabled: boolean;
}

const DEFAULT_CONFIG: BruteForceDetectorConfig = {
  failureThreshold: DEFAULT_FAILURE_THRESHOLD,
  windowMs: DEFAULT_WINDOW_MS,
  autoQuarantineEnabled: false,
};

export class BruteForceDetector {
  private sourceWindows = new Map<string, SourceWindow>();
  private config: BruteForceDetectorConfig;
  private securityReporter: SecurityEventReporter | null = null;
  private quarantineManager: QuarantineManager | null = null;
  private alertCallback: BruteForceAlertCallback | null = null;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<BruteForceDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the security event reporter for recording events.
   */
  setSecurityReporter(reporter: SecurityEventReporter): void {
    this.securityReporter = reporter;
  }

  /**
   * Set the quarantine manager for auto-quarantine.
   */
  setQuarantineManager(manager: QuarantineManager): void {
    this.quarantineManager = manager;
  }

  /**
   * Set a callback for brute force alerts.
   */
  onAlert(callback: BruteForceAlertCallback): void {
    this.alertCallback = callback;
  }

  /**
   * Record a failed pairing attempt.
   *
   * @param sourceHash Hashed source IP
   * @param targetCodeHash Hashed target pairing code (not the actual code)
   */
  recordFailure(sourceHash: string, targetCodeHash: string): BruteForceAlert | undefined {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    // Get or create the source window
    let window = this.sourceWindows.get(sourceHash);
    if (!window) {
      window = { attempts: [], alertTriggered: false };
      this.sourceWindows.set(sourceHash, window);
    }

    // Add the attempt
    window.attempts.push({ timestamp: now, targetCodeHash });

    // Prune expired attempts
    window.attempts = window.attempts.filter(a => a.timestamp > cutoff);

    // Check threshold
    const failedAttempts = window.attempts.length;

    // Record a brute_force_attempt security event at significant thresholds
    // (1st, 5th, 10th, then every 10th) to avoid flooding the event buffer
    if (this.securityReporter && (failedAttempts === 1 || failedAttempts === 5 || failedAttempts % 10 === 0)) {
      this.securityReporter.record({
        eventType: 'brute_force_attempt',
        sourceIp: sourceHash,
        severity: failedAttempts >= this.config.failureThreshold ? 'high' : 'medium',
        endpoint: '/pair',
        details: { targetCodeHash, attemptCount: failedAttempts },
      });
    }
    if (failedAttempts >= this.config.failureThreshold && !window.alertTriggered) {
      window.alertTriggered = true;

      const distinctTargets = new Set(window.attempts.map(a => a.targetCodeHash)).size;
      const pattern = this.classifyPattern(failedAttempts, distinctTargets);

      const alert: BruteForceAlert = {
        sourceHash,
        pattern,
        failedAttempts,
        distinctTargets,
        windowMinutes: Math.round(this.config.windowMs / 60_000),
        timestamp: now,
      };

      // Emit alert callback
      if (this.alertCallback) {
        try {
          this.alertCallback(alert);
        } catch (err) {
          console.error('[BruteForceDetector] Alert callback error:', err);
        }
      }

      // Auto-quarantine if enabled
      if (this.config.autoQuarantineEnabled && this.quarantineManager) {
        this.quarantineManager.quarantine(
          sourceHash,
          undefined, // use default duration
          'auto',
          'brute_force_detector',
        );
      }

      return alert;
    }

    return undefined;
  }

  /**
   * Record a successful pairing attempt.
   * Resets the alert trigger for the source so future brute-force can be re-detected.
   */
  recordSuccess(sourceHash: string): void {
    const window = this.sourceWindows.get(sourceHash);
    if (window) {
      window.alertTriggered = false;
    }
  }

  /**
   * Get the number of failed attempts for a source in the current window.
   */
  getFailureCount(sourceHash: string): number {
    const window = this.sourceWindows.get(sourceHash);
    if (!window) return 0;

    const cutoff = Date.now() - this.config.windowMs;
    return window.attempts.filter(a => a.timestamp > cutoff).length;
  }

  /**
   * Get a summary of all tracked sources.
   */
  getSummary(): Array<{
    sourceHash: string;
    failedAttempts: number;
    distinctTargets: number;
    pattern: BruteForcePattern;
    alertTriggered: boolean;
  }> {
    const cutoff = Date.now() - this.config.windowMs;
    const result: Array<{
      sourceHash: string;
      failedAttempts: number;
      distinctTargets: number;
      pattern: BruteForcePattern;
      alertTriggered: boolean;
    }> = [];

    for (const [sourceHash, window] of this.sourceWindows) {
      const validAttempts = window.attempts.filter(a => a.timestamp > cutoff);
      if (validAttempts.length === 0) continue;

      const distinctTargets = new Set(validAttempts.map(a => a.targetCodeHash)).size;

      result.push({
        sourceHash,
        failedAttempts: validAttempts.length,
        distinctTargets,
        pattern: this.classifyPattern(validAttempts.length, distinctTargets),
        alertTriggered: window.alertTriggered,
      });
    }

    return result.sort((a, b) => b.failedAttempts - a.failedAttempts);
  }

  /**
   * Classify the brute force pattern based on target diversity.
   */
  classifyPattern(failedAttempts: number, distinctTargets: number): BruteForcePattern {
    if (failedAttempts === 0) return 'mixed';

    const targetRatio = distinctTargets / failedAttempts;

    if (targetRatio > 0.8) return 'scanning';
    if (targetRatio < 0.2) return 'targeted';
    return 'mixed';
  }

  /**
   * Start periodic cleanup of expired sliding windows.
   */
  startCleanup(): void {
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Remove expired entries from all source windows.
   */
  cleanupExpired(): number {
    const cutoff = Date.now() - this.config.windowMs;
    let removed = 0;

    for (const [sourceHash, window] of this.sourceWindows) {
      window.attempts = window.attempts.filter(a => a.timestamp > cutoff);

      if (window.attempts.length === 0) {
        this.sourceWindows.delete(sourceHash);
        removed++;
      } else if (window.alertTriggered && window.attempts.length < this.config.failureThreshold) {
        // Reset alert flag when count drops below threshold
        window.alertTriggered = false;
      }
    }

    return removed;
  }

  /**
   * Update the detector configuration.
   */
  updateConfig(config: Partial<BruteForceDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get the current configuration.
   */
  getConfig(): BruteForceDetectorConfig {
    return { ...this.config };
  }

  /**
   * Shutdown the brute force detector.
   */
  shutdown(): void {
    this.stopCleanup();
    this.sourceWindows.clear();
  }
}
