/**
 * DDoSDetector — Detects connection spikes using a rolling 5-minute window.
 *
 * Tracks connection rates and alerts when the rate exceeds 5x the rolling average.
 * Uses hysteresis to prevent alert flapping (enter at 5x, exit at 2x).
 *
 * The detector piggybacks on the existing 1-second metrics broadcast loop.
 */

import type { SecurityEventReporter } from './security-events.js';

/** Rolling window size in seconds (5 minutes) */
const WINDOW_SIZE_SECONDS = 300;

/** Alert enter threshold: current rate must exceed this multiplier of baseline */
const ENTER_MULTIPLIER = 5.0;

/** Alert exit threshold: rate must drop below this multiplier to exit attack state */
const EXIT_MULTIPLIER = 2.0;

/** Minimum absolute rate to trigger alert (prevents false positives on low-traffic servers) */
const MIN_ABSOLUTE_RATE = 10;

/** Threat level classification */
export type ThreatLevel = 'normal' | 'elevated' | 'attack';

/**
 * Current state of the DDoS detector.
 */
export interface DDoSState {
  threatLevel: ThreatLevel;
  currentRate: number;
  baselineRate: number;
  multiplier: number;
  attackStartedAt: number | null;
  peakRate: number;
  totalConnectionsDuringAttack: number;
}

/**
 * Alert emitted when a DDoS threshold is crossed.
 */
export interface DDoSAlert {
  threatLevel: ThreatLevel;
  currentRate: number;
  baselineRate: number;
  multiplier: number;
  timestamp: number;
}

/**
 * Callback for DDoS alerts.
 */
export type DDoSAlertCallback = (alert: DDoSAlert) => void;

export class DDoSDetector {
  /** Circular buffer of connection rates per second */
  private rateWindow: number[] = [];
  /** Current write position in the rate window */
  private windowIndex = 0;
  /** Number of filled entries in the window (up to WINDOW_SIZE_SECONDS) */
  private windowFilled = 0;
  /** Running sum of all rates in the window (for efficient average calc) */
  private windowSum = 0;

  /** Current threat level */
  private threatLevel: ThreatLevel = 'normal';
  /** When the current attack started (null if not in attack state) */
  private attackStartedAt: number | null = null;
  /** Peak rate during current attack */
  private peakRate = 0;
  /** Total connections during current attack */
  private totalConnectionsDuringAttack = 0;

  /** Connections counted in the current second (incremented externally) */
  private connectionsThisSecond = 0;

  /** Security event reporter for recording connection_spike events */
  private securityReporter: SecurityEventReporter | null = null;

  /** Alert callback */
  private alertCallback: DDoSAlertCallback | null = null;

  /** Server ID for event recording */
  private serverId: string;

  constructor(serverId: string) {
    this.serverId = serverId;
    // Initialize rate window buffer
    this.rateWindow = new Array(WINDOW_SIZE_SECONDS).fill(0);
  }

  /**
   * Set the security event reporter for recording events.
   */
  setSecurityReporter(reporter: SecurityEventReporter): void {
    this.securityReporter = reporter;
  }

  /**
   * Set a callback to be called on DDoS alerts.
   */
  onAlert(callback: DDoSAlertCallback): void {
    this.alertCallback = callback;
  }

  /**
   * Record a new connection. Call this from the WebSocket connection handler.
   */
  recordConnection(): void {
    this.connectionsThisSecond++;
  }

  /**
   * Evaluate the connection rate. Called once per second from the metrics broadcast loop.
   * Returns the current DDoS state.
   */
  evaluate(): DDoSState {
    const currentRate = this.connectionsThisSecond;

    // Reset the per-second counter
    this.connectionsThisSecond = 0;

    // Calculate baseline BEFORE adding current rate to the window.
    // This ensures the spike itself does not inflate the baseline.
    const baselineRate = this.windowFilled > 0 ? this.windowSum / this.windowFilled : 0;
    const multiplier = baselineRate > 0 ? currentRate / baselineRate : 0;

    // Update the rolling window (after baseline calculation)
    // M3 fix: Freeze baseline during attack state to prevent the spike
    // from inflating the average it's measured against
    if (this.threatLevel === 'normal') {
      if (this.windowFilled < WINDOW_SIZE_SECONDS) {
        this.rateWindow[this.windowFilled] = currentRate;
        this.windowSum += currentRate;
        this.windowFilled++;
      } else {
        // Subtract the old value, add the new one
        const oldValue = this.rateWindow[this.windowIndex]!;
        this.windowSum -= oldValue;
        this.rateWindow[this.windowIndex] = currentRate;
        this.windowSum += currentRate;
      }
      this.windowIndex = (this.windowIndex + 1) % WINDOW_SIZE_SECONDS;
    }

    // Track peak and total during attack
    if (this.threatLevel !== 'normal') {
      if (currentRate > this.peakRate) {
        this.peakRate = currentRate;
      }
      this.totalConnectionsDuringAttack += currentRate;
    }

    // State machine with hysteresis
    const previousLevel = this.threatLevel;

    if (this.threatLevel === 'normal') {
      if (currentRate > baselineRate * ENTER_MULTIPLIER && currentRate >= MIN_ABSOLUTE_RATE) {
        // Jump straight to attack
        this.threatLevel = 'attack';
        this.attackStartedAt = Date.now();
        this.peakRate = currentRate;
        this.totalConnectionsDuringAttack = currentRate;

        this.emitAlert({
          threatLevel: 'attack',
          currentRate,
          baselineRate,
          multiplier,
          timestamp: Date.now(),
        });
      } else if (currentRate > baselineRate * EXIT_MULTIPLIER && currentRate >= MIN_ABSOLUTE_RATE) {
        // Intermediate warning state
        this.threatLevel = 'elevated';

        this.emitAlert({
          threatLevel: 'elevated',
          currentRate,
          baselineRate,
          multiplier,
          timestamp: Date.now(),
        });
      }
    } else if (this.threatLevel === 'elevated') {
      if (currentRate > baselineRate * ENTER_MULTIPLIER && currentRate >= MIN_ABSOLUTE_RATE) {
        // Escalate to attack
        this.threatLevel = 'attack';
        this.attackStartedAt = Date.now();
        this.peakRate = currentRate;
        this.totalConnectionsDuringAttack = currentRate;

        this.emitAlert({
          threatLevel: 'attack',
          currentRate,
          baselineRate,
          multiplier,
          timestamp: Date.now(),
        });
      } else if (baselineRate > 0 && currentRate < baselineRate * EXIT_MULTIPLIER) {
        // De-escalate back to normal
        this.threatLevel = 'normal';

        this.emitAlert({
          threatLevel: 'normal',
          currentRate,
          baselineRate,
          multiplier,
          timestamp: Date.now(),
        });
      }
    } else if (this.threatLevel === 'attack') {
      // Exit attack state if rate drops below exit threshold
      // M6 fix: Don't exit on baselineRate === 0 (cold-start) — require an actual rate drop
      if (baselineRate > 0 && currentRate < baselineRate * EXIT_MULTIPLIER) {
        // Record the attack event before transitioning
        this.recordAttackEvent(currentRate, baselineRate);

        this.threatLevel = 'normal';
        this.attackStartedAt = null;
        this.peakRate = 0;
        this.totalConnectionsDuringAttack = 0;

        this.emitAlert({
          threatLevel: 'normal',
          currentRate,
          baselineRate,
          multiplier,
          timestamp: Date.now(),
        });
      }
    }

    return {
      threatLevel: this.threatLevel,
      currentRate,
      baselineRate: Math.round(baselineRate * 100) / 100,
      multiplier: Math.round(multiplier * 100) / 100,
      attackStartedAt: this.attackStartedAt,
      peakRate: this.peakRate,
      totalConnectionsDuringAttack: this.totalConnectionsDuringAttack,
    };
  }

  /**
   * Get the current DDoS state without evaluating.
   */
  getState(): DDoSState {
    const baselineRate = this.windowFilled > 0 ? this.windowSum / this.windowFilled : 0;
    const currentRate = this.connectionsThisSecond;
    const multiplier = baselineRate > 0 ? currentRate / baselineRate : 0;

    return {
      threatLevel: this.threatLevel,
      currentRate,
      baselineRate: Math.round(baselineRate * 100) / 100,
      multiplier: Math.round(multiplier * 100) / 100,
      attackStartedAt: this.attackStartedAt,
      peakRate: this.peakRate,
      totalConnectionsDuringAttack: this.totalConnectionsDuringAttack,
    };
  }

  /**
   * Emit a DDoS alert.
   */
  private emitAlert(alert: DDoSAlert): void {
    if (this.alertCallback) {
      try {
        this.alertCallback(alert);
      } catch (err) {
        console.error('[DDoSDetector] Alert callback error:', err);
      }
    }
  }

  /**
   * Record a connection_spike security event when an attack ends.
   */
  private recordAttackEvent(currentRate: number, baselineRate: number): void {
    if (!this.securityReporter) return;

    this.securityReporter.record({
      eventType: 'connection_spike',
      severity: this.peakRate > baselineRate * 10 ? 'critical' : 'high',
      details: {
        peakRate: this.peakRate,
        baselineRate: Math.round(baselineRate * 100) / 100,
        multiplier: baselineRate > 0
          ? Math.round((this.peakRate / baselineRate) * 100) / 100
          : 0,
        durationMs: this.attackStartedAt ? Date.now() - this.attackStartedAt : 0,
        totalConnections: this.totalConnectionsDuringAttack,
      },
    });
  }

  /**
   * Reset the detector (useful for testing).
   */
  reset(): void {
    this.rateWindow = new Array(WINDOW_SIZE_SECONDS).fill(0);
    this.windowIndex = 0;
    this.windowFilled = 0;
    this.windowSum = 0;
    this.threatLevel = 'normal';
    this.attackStartedAt = null;
    this.peakRate = 0;
    this.totalConnectionsDuringAttack = 0;
    this.connectionsThisSecond = 0;
  }
}
