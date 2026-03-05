/**
 * Unit tests for DDoSDetector (US-7.3)
 *
 * Tests the rolling window, baseline calculation, hysteresis state machine,
 * alert generation, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DDoSDetector, type DDoSAlert } from '../../src/security/ddos-detector.js';

describe('DDoSDetector', () => {
  describe('baseline calculation', () => {
    it('starts with zero baseline', () => {
      const detector = new DDoSDetector('srv-01');
      const state = detector.evaluate();
      expect(state.baselineRate).toBe(0);
      expect(state.currentRate).toBe(0);
    });

    it('calculates rolling average correctly', () => {
      const detector = new DDoSDetector('srv-01');

      // Simulate 10 seconds of 5 connections/sec
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 5; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      const state = detector.evaluate();
      // Baseline should be close to 5 (average of 5s from the window)
      // Note: the 11th evaluate() also adds 0 connections,
      // so baseline = (10*5 + 0) / 11 = 50/11 ≈ 4.55
      expect(state.baselineRate).toBeGreaterThan(4);
      expect(state.baselineRate).toBeLessThan(5.1);
    });
  });

  describe('threat level transitions', () => {
    it('stays normal when rate is below threshold', () => {
      const detector = new DDoSDetector('srv-01');

      // Build up baseline with 2 connections/sec for 10 seconds
      for (let i = 0; i < 10; i++) {
        detector.recordConnection();
        detector.recordConnection();
        detector.evaluate();
      }

      // Add 3 connections (below 5x threshold)
      detector.recordConnection();
      detector.recordConnection();
      detector.recordConnection();
      const state = detector.evaluate();

      expect(state.threatLevel).toBe('normal');
    });

    it('enters attack state when rate exceeds 5x baseline and min absolute rate', () => {
      const detector = new DDoSDetector('srv-01');
      const alerts: DDoSAlert[] = [];
      detector.onAlert(alert => alerts.push(alert));

      // Build up baseline with 3 connections/sec for 10 seconds
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 3; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      // Spike: 20 connections (>5x baseline of ~3, and >10 absolute)
      for (let j = 0; j < 20; j++) {
        detector.recordConnection();
      }
      const state = detector.evaluate();

      expect(state.threatLevel).toBe('attack');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.threatLevel).toBe('attack');
      expect(alerts[0]!.currentRate).toBe(20);
    });

    it('does not enter attack state if below min absolute rate', () => {
      const detector = new DDoSDetector('srv-01');

      // Very low baseline: 1 connection/sec for 10 seconds
      for (let i = 0; i < 10; i++) {
        detector.recordConnection();
        detector.evaluate();
      }

      // Spike of 6 connections (6x baseline but below absolute min of 10)
      for (let j = 0; j < 6; j++) {
        detector.recordConnection();
      }
      const state = detector.evaluate();

      expect(state.threatLevel).toBe('normal');
    });

    it('exits attack state when rate drops below 2x baseline', () => {
      const detector = new DDoSDetector('srv-01');
      const alerts: DDoSAlert[] = [];
      detector.onAlert(alert => alerts.push(alert));

      // Build up baseline
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 3; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      // Trigger attack
      for (let j = 0; j < 20; j++) {
        detector.recordConnection();
      }
      detector.evaluate();
      expect(alerts).toHaveLength(1);

      // Rate drops to 1 (below 2x baseline)
      detector.recordConnection();
      const state = detector.evaluate();

      expect(state.threatLevel).toBe('normal');
      expect(alerts).toHaveLength(2);
      expect(alerts[1]!.threatLevel).toBe('normal');
    });

    it('stays in attack state if rate stays above 2x baseline (hysteresis)', () => {
      const detector = new DDoSDetector('srv-01');

      // Build up a large baseline with many data points (~3 conn/sec for 100 ticks)
      // so that single spike does not distort baseline significantly
      for (let i = 0; i < 100; i++) {
        for (let j = 0; j < 3; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      // Trigger attack with 20
      for (let j = 0; j < 20; j++) {
        detector.recordConnection();
      }
      detector.evaluate();
      expect(detector.getState().threatLevel).toBe('attack');

      // Rate at 15 (still above 2x baseline of ~3, even with slight baseline inflation)
      // Baseline after spike: (100*3 + 20)/101 = 320/101 ≈ 3.17
      // 15 > 3.17 * 2 = 6.34 -> stays in attack
      for (let j = 0; j < 15; j++) {
        detector.recordConnection();
      }
      const state = detector.evaluate();

      expect(state.threatLevel).toBe('attack');
    });
  });

  describe('attack tracking', () => {
    it('tracks peak rate during attack', () => {
      const detector = new DDoSDetector('srv-01');

      // Build up baseline
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 3; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      // Spike 1: 20 connections
      for (let j = 0; j < 20; j++) {
        detector.recordConnection();
      }
      detector.evaluate();

      // Spike 2: 30 connections (higher peak)
      for (let j = 0; j < 30; j++) {
        detector.recordConnection();
      }
      const state = detector.evaluate();

      expect(state.peakRate).toBe(30);
    });

    it('tracks total connections during attack', () => {
      const detector = new DDoSDetector('srv-01');

      // Build up baseline
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 3; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      // Spike 1: 20 connections
      for (let j = 0; j < 20; j++) {
        detector.recordConnection();
      }
      detector.evaluate();

      // Spike 2: 15 connections
      for (let j = 0; j < 15; j++) {
        detector.recordConnection();
      }
      const state = detector.evaluate();

      expect(state.totalConnectionsDuringAttack).toBe(35);
    });

    it('sets attackStartedAt when entering attack state', () => {
      vi.useFakeTimers();
      const detector = new DDoSDetector('srv-01');

      // Build up baseline
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 3; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      const timeBeforeAttack = Date.now();
      for (let j = 0; j < 20; j++) {
        detector.recordConnection();
      }
      const state = detector.evaluate();

      expect(state.attackStartedAt).not.toBeNull();
      expect(state.attackStartedAt).toBeGreaterThanOrEqual(timeBeforeAttack);

      vi.useRealTimers();
    });

    it('resets tracking when attack ends', () => {
      const detector = new DDoSDetector('srv-01');

      // Build up baseline
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 3; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      // Trigger attack
      for (let j = 0; j < 20; j++) {
        detector.recordConnection();
      }
      detector.evaluate();

      // End attack (rate drops)
      detector.recordConnection();
      const state = detector.evaluate();

      expect(state.attackStartedAt).toBeNull();
      expect(state.peakRate).toBe(0);
      expect(state.totalConnectionsDuringAttack).toBe(0);
    });
  });

  describe('recordConnection', () => {
    it('increments connections for the current second', () => {
      const detector = new DDoSDetector('srv-01');
      detector.recordConnection();
      detector.recordConnection();
      detector.recordConnection();

      const state = detector.evaluate();
      expect(state.currentRate).toBe(3);
    });

    it('resets counter after evaluate', () => {
      const detector = new DDoSDetector('srv-01');
      detector.recordConnection();
      detector.recordConnection();
      detector.evaluate(); // Should consume the 2 connections

      // Now add 1 more
      detector.recordConnection();
      const state = detector.evaluate();
      expect(state.currentRate).toBe(1);
    });
  });

  describe('getState', () => {
    it('returns current state without evaluating', () => {
      const detector = new DDoSDetector('srv-01');
      const state = detector.getState();

      expect(state.threatLevel).toBe('normal');
      expect(state.currentRate).toBe(0);
      expect(state.baselineRate).toBe(0);
    });
  });

  describe('reset', () => {
    it('resets all state', () => {
      const detector = new DDoSDetector('srv-01');

      // Build up some state
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 5; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      detector.reset();
      const state = detector.getState();

      expect(state.threatLevel).toBe('normal');
      expect(state.baselineRate).toBe(0);
      expect(state.attackStartedAt).toBeNull();
      expect(state.peakRate).toBe(0);
    });
  });

  describe('security reporter integration', () => {
    it('records connection_spike event when attack ends', () => {
      const mockReporter = {
        record: vi.fn(),
      };

      const detector = new DDoSDetector('srv-01');
      detector.setSecurityReporter(mockReporter as any);

      // Build up baseline
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 3; j++) {
          detector.recordConnection();
        }
        detector.evaluate();
      }

      // Trigger attack
      for (let j = 0; j < 20; j++) {
        detector.recordConnection();
      }
      detector.evaluate();

      // End attack
      detector.recordConnection();
      detector.evaluate();

      // Should have recorded a connection_spike event
      expect(mockReporter.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'connection_spike',
        })
      );
    });
  });
});
