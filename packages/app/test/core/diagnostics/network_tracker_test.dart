import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/diagnostics/network_tracker.dart';

void main() {
  group('NetworkMetrics', () {
    test('toJson() includes only non-null fields', () {
      const metrics = NetworkMetrics(
        signalingConnectSuccessRate: 0.95,
        signalingConnectAttempts: 20,
      );

      final json = metrics.toJson();
      expect(json['signalingConnectSuccessRate'], 0.95);
      expect(json['signalingConnectAttempts'], 20);
      expect(json.containsKey('webrtcEstablishSuccessRate'), isFalse);
      expect(json.containsKey('webrtcEstablishAttempts'), isFalse);
      expect(json.containsKey('relayUsageRate'), isFalse);
      expect(json.containsKey('avgLatencyMs'), isFalse);
    });

    test('toJson() includes all fields when all are set', () {
      const metrics = NetworkMetrics(
        signalingConnectSuccessRate: 0.9,
        signalingConnectAttempts: 10,
        webrtcEstablishSuccessRate: 0.8,
        webrtcEstablishAttempts: 5,
        relayUsageRate: 0.3,
        avgLatencyMs: 42.5,
      );

      final json = metrics.toJson();
      expect(json.length, 6);
      expect(json['signalingConnectSuccessRate'], 0.9);
      expect(json['signalingConnectAttempts'], 10);
      expect(json['webrtcEstablishSuccessRate'], 0.8);
      expect(json['webrtcEstablishAttempts'], 5);
      expect(json['relayUsageRate'], 0.3);
      expect(json['avgLatencyMs'], 42.5);
    });

    test('toJson() returns empty map when all fields are null', () {
      const metrics = NetworkMetrics();
      expect(metrics.toJson(), isEmpty);
    });

    test('toString() contains key values', () {
      const metrics = NetworkMetrics(
        signalingConnectSuccessRate: 0.95,
        signalingConnectAttempts: 20,
        avgLatencyMs: 42.5,
      );
      final str = metrics.toString();
      expect(str, contains('0.95'));
      expect(str, contains('20'));
      expect(str, contains('42.5'));
    });
  });

  group('NetworkTracker', () {
    late NetworkTracker tracker;

    setUp(() {
      tracker = NetworkTracker();
    });

    tearDown(() {
      if (tracker.isRunning) {
        tracker.stop();
      }
    });

    group('lifecycle', () {
      test('start() sets isRunning to true', () {
        tracker.start();
        expect(tracker.isRunning, isTrue);
      });

      test('stop() sets isRunning to false', () {
        tracker.start();
        tracker.stop();
        expect(tracker.isRunning, isFalse);
      });

      test('start() is idempotent', () {
        tracker.start();
        tracker.start();
        expect(tracker.isRunning, isTrue);
      });

      test('stop() is idempotent', () {
        tracker.stop();
        tracker.stop();
        expect(tracker.isRunning, isFalse);
      });

      test('getMetrics() returns null before any recording', () {
        expect(tracker.getMetrics(), isNull);
      });

      test('getMetrics() returns non-null after start and recording', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: true);
        final metrics = tracker.getMetrics();
        expect(metrics, isNotNull);
      });
    });

    group('signaling tracking', () {
      test('records successful signaling attempts', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: true);
        tracker.recordSignalingAttempt(success: true);

        final metrics = tracker.getMetrics()!;
        expect(metrics.signalingConnectAttempts, 2);
        expect(metrics.signalingConnectSuccessRate, 1.0);
      });

      test('records failed signaling attempts', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: false);

        final metrics = tracker.getMetrics()!;
        expect(metrics.signalingConnectAttempts, 1);
        expect(metrics.signalingConnectSuccessRate, 0.0);
      });

      test('computes correct success rate with mixed results', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: true);
        tracker.recordSignalingAttempt(success: true);
        tracker.recordSignalingAttempt(success: false);
        tracker.recordSignalingAttempt(success: true);

        final metrics = tracker.getMetrics()!;
        expect(metrics.signalingConnectAttempts, 4);
        expect(metrics.signalingConnectSuccessRate, 0.75);
      });

      test('does not record when stopped', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: true);
        tracker.stop();
        tracker.recordSignalingAttempt(success: true);

        // Restart to read metrics (getMetrics returns null if never started
        // and no data, but we have data from before stop)
        tracker.start();
        final metrics = tracker.getMetrics()!;
        expect(metrics.signalingConnectAttempts, 1);
      });
    });

    group('webrtc tracking', () {
      test('records successful WebRTC attempts', () {
        tracker.start();
        tracker.recordWebRTCAttempt(success: true);

        final metrics = tracker.getMetrics()!;
        expect(metrics.webrtcEstablishAttempts, 1);
        expect(metrics.webrtcEstablishSuccessRate, 1.0);
      });

      test('records failed WebRTC attempts', () {
        tracker.start();
        tracker.recordWebRTCAttempt(success: false);
        tracker.recordWebRTCAttempt(success: false);

        final metrics = tracker.getMetrics()!;
        expect(metrics.webrtcEstablishAttempts, 2);
        expect(metrics.webrtcEstablishSuccessRate, 0.0);
      });

      test('computes correct success rate', () {
        tracker.start();
        tracker.recordWebRTCAttempt(success: true);
        tracker.recordWebRTCAttempt(success: false);

        final metrics = tracker.getMetrics()!;
        expect(metrics.webrtcEstablishSuccessRate, 0.5);
      });

      test('does not record when stopped', () {
        tracker.start();
        tracker.stop();
        tracker.recordWebRTCAttempt(success: true);

        // No data was recorded
        expect(tracker.getMetrics(), isNull);
      });
    });

    group('connection type tracking', () {
      test('tracks direct connections', () {
        tracker.start();
        tracker.recordConnectionType('direct_p2p');

        final metrics = tracker.getMetrics()!;
        expect(metrics.relayUsageRate, 0.0);
      });

      test('tracks relay connections', () {
        tracker.start();
        tracker.recordConnectionType('relay');

        final metrics = tracker.getMetrics()!;
        expect(metrics.relayUsageRate, 1.0);
      });

      test('computes correct relay usage rate with mixed types', () {
        tracker.start();
        tracker.recordConnectionType('direct_p2p');
        tracker.recordConnectionType('relay');
        tracker.recordConnectionType('direct_p2p');
        tracker.recordConnectionType('direct_p2p');

        final metrics = tracker.getMetrics()!;
        expect(metrics.relayUsageRate, 0.25);
      });

      test('does not record when stopped', () {
        tracker.start();
        tracker.stop();
        tracker.recordConnectionType('relay');

        expect(tracker.getMetrics(), isNull);
      });
    });

    group('latency tracking', () {
      test('records single latency sample', () {
        tracker.start();
        tracker.recordLatency(42.5);

        final metrics = tracker.getMetrics()!;
        expect(metrics.avgLatencyMs, 42.5);
      });

      test('computes average latency across multiple samples', () {
        tracker.start();
        tracker.recordLatency(10.0);
        tracker.recordLatency(20.0);
        tracker.recordLatency(30.0);

        final metrics = tracker.getMetrics()!;
        expect(metrics.avgLatencyMs, 20.0);
      });

      test('does not record when stopped', () {
        tracker.start();
        tracker.stop();
        tracker.recordLatency(100.0);

        expect(tracker.getMetrics(), isNull);
      });

      test('respects max latency samples limit', () {
        tracker.start();

        // Record more than _maxLatencySamples (100) samples
        for (var i = 0; i < 110; i++) {
          tracker.recordLatency(i.toDouble());
        }

        final metrics = tracker.getMetrics()!;
        // Average of 10..109 = (10+109)/2 = 59.5
        expect(metrics.avgLatencyMs, closeTo(59.5, 0.01));
      });
    });

    group('reset', () {
      test('clears all counters', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: true);
        tracker.recordWebRTCAttempt(success: false);
        tracker.recordConnectionType('relay');
        tracker.recordLatency(50.0);

        tracker.reset();

        // After reset, getMetrics should show no data
        // (still running but all counters are zero)
        final metrics = tracker.getMetrics()!;
        expect(metrics.signalingConnectAttempts, isNull);
        expect(metrics.webrtcEstablishAttempts, isNull);
        expect(metrics.relayUsageRate, isNull);
        expect(metrics.avgLatencyMs, isNull);
      });
    });

    group('metrics when no data for a category', () {
      test('signaling fields are null when no signaling attempts', () {
        tracker.start();
        tracker.recordWebRTCAttempt(success: true);

        final metrics = tracker.getMetrics()!;
        expect(metrics.signalingConnectSuccessRate, isNull);
        expect(metrics.signalingConnectAttempts, isNull);
      });

      test('webrtc fields are null when no webrtc attempts', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: true);

        final metrics = tracker.getMetrics()!;
        expect(metrics.webrtcEstablishSuccessRate, isNull);
        expect(metrics.webrtcEstablishAttempts, isNull);
      });

      test('relay usage is null when no connections tracked', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: true);

        final metrics = tracker.getMetrics()!;
        expect(metrics.relayUsageRate, isNull);
      });

      test('avg latency is null when no samples', () {
        tracker.start();
        tracker.recordSignalingAttempt(success: true);

        final metrics = tracker.getMetrics()!;
        expect(metrics.avgLatencyMs, isNull);
      });
    });
  });
}
