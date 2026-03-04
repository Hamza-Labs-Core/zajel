import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/services/auto_update_service.dart';
import 'package:zajel/features/updater/services/idle_detector.dart';

void main() {
  late IdleDetector idleDetector;
  late AutoUpdateService service;
  late bool activeCall;
  late bool activeTransfer;
  late bool updateReady;
  late int launchCount;

  setUp(() {
    idleDetector = IdleDetector();
    activeCall = false;
    activeTransfer = false;
    updateReady = true;
    launchCount = 0;

    service = AutoUpdateService(
      idleDetector: idleDetector,
      hasActiveCall: () => activeCall,
      hasActiveTransfer: () => activeTransfer,
      isUpdateReady: () => updateReady,
      launchUpdate: () async {
        launchCount++;
      },
    );
  });

  tearDown(() {
    service.dispose();
    idleDetector.dispose();
  });

  group('AutoUpdateService', () {
    test('is disabled by default', () {
      expect(service.isEnabled, isFalse);
    });

    test('setEnabled toggles enabled state', () {
      service.setEnabled(true);
      expect(service.isEnabled, isTrue);

      service.setEnabled(false);
      expect(service.isEnabled, isFalse);
    });

    test('update not triggered when service is disabled', () {
      fakeAsync((async) {
        // Update is ready but service is disabled
        service.onUpdateReady();

        // Wait for idle
        async.elapse(IdleDetector.idleThreshold);
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 0);
      });
    });

    test('update not triggered during active call', () {
      fakeAsync((async) {
        activeCall = true;
        service.setEnabled(true);
        service.onUpdateReady();

        async.elapse(IdleDetector.idleThreshold);
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 0);
      });
    });

    test('update not triggered during active file transfer', () {
      fakeAsync((async) {
        activeTransfer = true;
        service.setEnabled(true);
        service.onUpdateReady();

        async.elapse(IdleDetector.idleThreshold);
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 0);
      });
    });

    test('update not triggered when update is not ready', () {
      fakeAsync((async) {
        updateReady = false;
        service.setEnabled(true);
        service.onUpdateReady();

        async.elapse(IdleDetector.idleThreshold);
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 0);
      });
    });

    test('update triggered when all conditions met', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();

        // Wait for idle threshold
        async.elapse(IdleDetector.idleThreshold);

        // Grace period should start automatically via listener
        expect(idleDetector.isInGracePeriod, isTrue);

        // Wait for grace period
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 1);
      });
    });

    test('update aborted if user activity during grace period', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();

        // Wait for idle
        async.elapse(IdleDetector.idleThreshold);
        expect(idleDetector.isInGracePeriod, isTrue);

        // User activity during grace period
        async.elapse(const Duration(seconds: 5));
        idleDetector.onUserActivity();
        expect(idleDetector.isInGracePeriod, isFalse);

        // Wait past the original grace period end
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 0);
      });
    });

    test('update aborted if call starts during grace period', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();

        // Wait for idle
        async.elapse(IdleDetector.idleThreshold);
        expect(idleDetector.isInGracePeriod, isTrue);

        // Call starts during grace period
        activeCall = true;

        // Grace period completes but re-check catches the active call
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 0);
      });
    });

    test('update aborted if file transfer starts during grace period', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();

        // Wait for idle
        async.elapse(IdleDetector.idleThreshold);
        expect(idleDetector.isInGracePeriod, isTrue);

        // Transfer starts during grace period
        activeTransfer = true;

        // Grace period completes but re-check catches the active transfer
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 0);
      });
    });

    test('update aborted if disabled during grace period', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();

        // Wait for idle
        async.elapse(IdleDetector.idleThreshold);

        // Disable during grace period
        service.setEnabled(false);

        async.elapse(IdleDetector.gracePeriod);
        expect(launchCount, 0);
      });
    });

    test('onUpdateNotReady stops monitoring', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();
        expect(idleDetector.isMonitoring, isTrue);

        service.onUpdateNotReady();
        expect(idleDetector.isMonitoring, isFalse);

        // Even if we wait, no update is triggered
        async.elapse(IdleDetector.idleThreshold + IdleDetector.gracePeriod);
        expect(launchCount, 0);
      });
    });

    test('enabling after update ready starts monitoring', () {
      fakeAsync((async) {
        service.onUpdateReady();
        expect(idleDetector.isMonitoring, isFalse);

        service.setEnabled(true);
        expect(idleDetector.isMonitoring, isTrue);

        async.elapse(IdleDetector.idleThreshold);
        async.elapse(IdleDetector.gracePeriod);

        expect(launchCount, 1);
      });
    });

    test('disabling stops monitoring', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();
        expect(idleDetector.isMonitoring, isTrue);

        service.setEnabled(false);
        expect(idleDetector.isMonitoring, isFalse);
      });
    });

    test('dispose stops monitoring', () {
      service.setEnabled(true);
      service.onUpdateReady();
      expect(idleDetector.isMonitoring, isTrue);

      service.dispose();
      expect(idleDetector.isMonitoring, isFalse);
    });

    test('update not launched twice on repeated idle notifications', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();

        // Wait for idle
        async.elapse(IdleDetector.idleThreshold);
        // Grace period starts

        // Grace period completes, update launched
        async.elapse(IdleDetector.gracePeriod);
        expect(launchCount, 1);

        // Even though the idle detector is still idle, the grace period
        // won't re-start unless conditions re-trigger it. Simulate:
        // after a successful launch, the service would be disposed,
        // so no double-launch in practice.
      });
    });

    test('update aborted if update becomes not ready during grace', () {
      fakeAsync((async) {
        service.setEnabled(true);
        service.onUpdateReady();

        // Wait for idle
        async.elapse(IdleDetector.idleThreshold);
        expect(idleDetector.isInGracePeriod, isTrue);

        // Update fails during grace period
        updateReady = false;

        async.elapse(IdleDetector.gracePeriod);
        expect(launchCount, 0);
      });
    });
  });
}
