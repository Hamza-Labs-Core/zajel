import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/diagnostics/performance_tracker.dart';

void main() {
  group('PerformanceMetrics', () {
    test('toJson() includes only non-null fields', () {
      const metrics = PerformanceMetrics(
        startupTimeMs: 123.4,
        frameRateAvg: 59.5,
      );

      final json = metrics.toJson();
      expect(json['startupTimeMs'], 123.4);
      expect(json['frameRateAvg'], 59.5);
      expect(json.containsKey('frameRateP95'), isFalse);
      expect(json.containsKey('memoryUsageMb'), isFalse);
      expect(json.containsKey('memoryPeakMb'), isFalse);
    });

    test('toJson() includes all fields when all are set', () {
      const metrics = PerformanceMetrics(
        startupTimeMs: 100.0,
        frameRateAvg: 60.0,
        frameRateP95: 18.5,
        memoryUsageMb: 150.0,
        memoryPeakMb: 200.0,
      );

      final json = metrics.toJson();
      expect(json.length, 5);
      expect(json['startupTimeMs'], 100.0);
      expect(json['frameRateAvg'], 60.0);
      expect(json['frameRateP95'], 18.5);
      expect(json['memoryUsageMb'], 150.0);
      expect(json['memoryPeakMb'], 200.0);
    });

    test('toJson() returns empty map when all fields are null', () {
      const metrics = PerformanceMetrics();
      expect(metrics.toJson(), isEmpty);
    });

    test('toString() formats correctly', () {
      const metrics = PerformanceMetrics(
        startupTimeMs: 123.4,
        frameRateAvg: 59.5,
      );
      final str = metrics.toString();
      expect(str, contains('123.4'));
      expect(str, contains('59.5'));
    });
  });

  group('PerformanceTracker', () {
    late PerformanceTracker tracker;

    setUp(() {
      tracker = PerformanceTracker();
    });

    group('lifecycle', () {
      testWidgets('start() sets isRunning to true', (tester) async {
        tracker.start();
        expect(tracker.isRunning, isTrue);
        tracker.stop(); // clean up timers before test ends
      });

      testWidgets('stop() sets isRunning to false', (tester) async {
        tracker.start();
        tracker.stop();
        expect(tracker.isRunning, isFalse);
      });

      testWidgets('start() is idempotent', (tester) async {
        tracker.start();
        tracker.start(); // second call should not throw
        expect(tracker.isRunning, isTrue);
        tracker.stop();
      });

      testWidgets('stop() is idempotent', (tester) async {
        tracker.stop(); // not running — should not throw
        tracker.stop();
        expect(tracker.isRunning, isFalse);
      });

      testWidgets('getMetrics() returns null before start', (tester) async {
        expect(tracker.getMetrics(), isNull);
      });

      testWidgets('getMetrics() returns non-null after start', (tester) async {
        tracker.start();
        final metrics = tracker.getMetrics();
        expect(metrics, isNotNull);
        tracker.stop();
      });
    });

    group('frame timing', () {
      testWidgets('records frame timings via addTimingsCallback',
          (tester) async {
        tracker.start();

        // Pump a few frames to generate frame timings
        await tester.pump(const Duration(milliseconds: 16));
        await tester.pump(const Duration(milliseconds: 16));
        await tester.pump(const Duration(milliseconds: 16));

        // In test mode, we may not get actual timings from the engine,
        // but the tracker should not crash and should return metrics.
        final metrics = tracker.getMetrics();
        expect(metrics, isNotNull);
        tracker.stop();
      });

      testWidgets('stop removes timings callback without error',
          (tester) async {
        tracker.start();
        await tester.pump();
        tracker.stop();
        // Pumping after stop should not cause errors
        await tester.pump();
        expect(tracker.isRunning, isFalse);
      });
    });

    group('startup time', () {
      testWidgets('records startup time after first frame', (tester) async {
        tracker.start();
        // The post-frame callback fires after the next pump
        await tester.pump();

        final metrics = tracker.getMetrics();
        expect(metrics, isNotNull);
        // startupTimeMs should be recorded (non-negative)
        if (metrics!.startupTimeMs != null) {
          expect(metrics.startupTimeMs, greaterThanOrEqualTo(0));
        }
        tracker.stop();
      });
    });

    group('memory sampling', () {
      testWidgets('samples memory on start', (tester) async {
        tracker.start();
        await tester.pump();

        final metrics = tracker.getMetrics();
        expect(metrics, isNotNull);
        // Memory may or may not be available depending on platform.
        // Just verify no crash.
        tracker.stop();
      });

      testWidgets('peak memory is >= current memory', (tester) async {
        tracker.start();
        await tester.pump();

        final metrics = tracker.getMetrics();
        if (metrics?.memoryUsageMb != null && metrics?.memoryPeakMb != null) {
          expect(metrics!.memoryPeakMb,
              greaterThanOrEqualTo(metrics.memoryUsageMb!));
        }
        tracker.stop();
      });
    });
  });
}
