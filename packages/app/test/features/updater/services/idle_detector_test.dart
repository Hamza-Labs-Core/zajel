import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/services/idle_detector.dart';

void main() {
  late IdleDetector detector;

  setUp(() {
    detector = IdleDetector();
  });

  tearDown(() {
    detector.dispose();
  });

  group('IdleDetector', () {
    test('initial state is not idle and not in grace period', () {
      expect(detector.isIdle, isFalse);
      expect(detector.isInGracePeriod, isFalse);
      expect(detector.isMonitoring, isFalse);
      expect(detector.lastActivity, isNull);
    });

    test('startMonitoring sets monitoring flag', () {
      detector.startMonitoring();
      expect(detector.isMonitoring, isTrue);
    });

    test('stopMonitoring clears monitoring flag and idle state', () {
      fakeAsync((async) {
        detector.startMonitoring();
        async.elapse(IdleDetector.idleThreshold);
        expect(detector.isIdle, isTrue);

        detector.stopMonitoring();
        expect(detector.isMonitoring, isFalse);
        expect(detector.isIdle, isFalse);
      });
    });

    test('idle timer fires after threshold when monitoring', () {
      fakeAsync((async) {
        detector.startMonitoring();
        expect(detector.isIdle, isFalse);

        // Advance just under threshold
        async.elapse(IdleDetector.idleThreshold - const Duration(seconds: 1));
        expect(detector.isIdle, isFalse);

        // Advance past threshold
        async.elapse(const Duration(seconds: 1));
        expect(detector.isIdle, isTrue);
      });
    });

    test('user activity resets idle timer', () {
      fakeAsync((async) {
        detector.startMonitoring();

        // Wait 4 minutes
        async.elapse(const Duration(minutes: 4));
        expect(detector.isIdle, isFalse);

        // User activity resets
        detector.onUserActivity();
        expect(detector.lastActivity, isNotNull);

        // Wait another 4 minutes (total would be 8 from start, but only 4 from reset)
        async.elapse(const Duration(minutes: 4));
        expect(detector.isIdle, isFalse);

        // Wait 1 more minute (5 total from last activity)
        async.elapse(const Duration(minutes: 1));
        expect(detector.isIdle, isTrue);
      });
    });

    test('user activity sets isIdle to false', () {
      fakeAsync((async) {
        detector.startMonitoring();
        async.elapse(IdleDetector.idleThreshold);
        expect(detector.isIdle, isTrue);

        detector.onUserActivity();
        expect(detector.isIdle, isFalse);
      });
    });

    test('grace period completes when user stays idle', () {
      fakeAsync((async) {
        var graceCompleted = false;

        detector.startMonitoring();
        async.elapse(IdleDetector.idleThreshold);
        expect(detector.isIdle, isTrue);

        detector.startGracePeriod(() {
          graceCompleted = true;
        });
        expect(detector.isInGracePeriod, isTrue);
        expect(graceCompleted, isFalse);

        async.elapse(IdleDetector.gracePeriod);
        expect(graceCompleted, isTrue);
        expect(detector.isInGracePeriod, isFalse);
      });
    });

    test('grace period aborted by user activity', () {
      fakeAsync((async) {
        var graceCompleted = false;

        detector.startMonitoring();
        async.elapse(IdleDetector.idleThreshold);
        expect(detector.isIdle, isTrue);

        detector.startGracePeriod(() {
          graceCompleted = true;
        });
        expect(detector.isInGracePeriod, isTrue);

        // Simulate user activity during grace period
        async.elapse(const Duration(seconds: 5));
        detector.onUserActivity();
        expect(detector.isInGracePeriod, isFalse);
        expect(detector.isIdle, isFalse);

        // Let the original timer fire
        async.elapse(const Duration(seconds: 10));
        expect(graceCompleted, isFalse);
      });
    });

    test('grace period does not complete if user became active', () {
      fakeAsync((async) {
        var graceCompleted = false;

        detector.startMonitoring();
        async.elapse(IdleDetector.idleThreshold);

        detector.startGracePeriod(() {
          graceCompleted = true;
        });

        // User becomes active before grace timer fires
        detector.onUserActivity();

        // Grace timer would fire now but the callback is never called
        // because the grace was cancelled
        async.elapse(IdleDetector.gracePeriod);
        expect(graceCompleted, isFalse);
      });
    });

    test('stopMonitoring cancels grace period', () {
      fakeAsync((async) {
        var graceCompleted = false;

        detector.startMonitoring();
        async.elapse(IdleDetector.idleThreshold);

        detector.startGracePeriod(() {
          graceCompleted = true;
        });
        expect(detector.isInGracePeriod, isTrue);

        detector.stopMonitoring();
        expect(detector.isInGracePeriod, isFalse);

        async.elapse(IdleDetector.gracePeriod);
        expect(graceCompleted, isFalse);
      });
    });

    test('notifies listeners when idle state changes', () {
      fakeAsync((async) {
        var notifyCount = 0;
        detector.addListener(() => notifyCount++);

        detector.startMonitoring();
        // startMonitoring calls notifyListeners
        expect(notifyCount, 1);

        async.elapse(IdleDetector.idleThreshold);
        // idle timer fires and notifies
        expect(notifyCount, 2);

        detector.onUserActivity();
        // activity resets and notifies
        expect(notifyCount, 3);
      });
    });

    test('multiple startMonitoring calls are idempotent', () {
      detector.startMonitoring();
      detector.startMonitoring();
      expect(detector.isMonitoring, isTrue);
    });

    test('multiple stopMonitoring calls are idempotent', () {
      detector.startMonitoring();
      detector.stopMonitoring();
      detector.stopMonitoring();
      expect(detector.isMonitoring, isFalse);
    });

    test('onUserActivity works without monitoring (no idle timer reset)', () {
      fakeAsync((async) {
        // Not monitoring, but activity should still record timestamp
        detector.onUserActivity();
        expect(detector.lastActivity, isNotNull);
        expect(detector.isIdle, isFalse);

        // Since not monitoring, idle timer is never set
        async.elapse(IdleDetector.idleThreshold * 2);
        expect(detector.isIdle, isFalse);
      });
    });

    test('duplicate startGracePeriod calls are ignored', () {
      fakeAsync((async) {
        var graceCount = 0;

        detector.startMonitoring();
        async.elapse(IdleDetector.idleThreshold);

        detector.startGracePeriod(() {
          graceCount++;
        });

        // Second call should be ignored
        detector.startGracePeriod(() {
          graceCount += 100;
        });

        async.elapse(IdleDetector.gracePeriod);
        expect(graceCount, 1);
      });
    });
  });
}
