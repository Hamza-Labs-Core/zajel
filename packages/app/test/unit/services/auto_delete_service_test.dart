import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/services/auto_delete_service.dart';

void main() {
  group('AutoDeleteService', () {
    late List<(String, DateTime)> deleteCalls;
    late List<String> activePeerIds;
    late AutoDeleteDuration currentDuration;
    late AutoDeleteService service;

    setUp(() {
      deleteCalls = [];
      activePeerIds = [];
      currentDuration = AutoDeleteDuration.off;
    });

    AutoDeleteService buildService() {
      return AutoDeleteService(
        deleteMessagesBefore: (peerId, before) async {
          deleteCalls.add((peerId, before));
        },
        getActivePeerIds: () async => activePeerIds,
        getAutoDeleteDuration: () => currentDuration,
      );
    }

    group('AutoDeleteDuration', () {
      test('off has null duration', () {
        expect(AutoDeleteDuration.off.duration, isNull);
      });

      test('oneHour has 1 hour duration', () {
        expect(AutoDeleteDuration.oneHour.duration,
            equals(const Duration(hours: 1)));
      });

      test('oneDay has 1 day duration', () {
        expect(AutoDeleteDuration.oneDay.duration,
            equals(const Duration(days: 1)));
      });

      test('sevenDays has 7 day duration', () {
        expect(AutoDeleteDuration.sevenDays.duration,
            equals(const Duration(days: 7)));
      });

      test('thirtyDays has 30 day duration', () {
        expect(AutoDeleteDuration.thirtyDays.duration,
            equals(const Duration(days: 30)));
      });

      test('labels are human readable', () {
        expect(AutoDeleteDuration.off.label, equals('Off'));
        expect(AutoDeleteDuration.oneHour.label, equals('1 hour'));
        expect(AutoDeleteDuration.oneDay.label, equals('1 day'));
        expect(AutoDeleteDuration.sevenDays.label, equals('7 days'));
        expect(AutoDeleteDuration.thirtyDays.label, equals('30 days'));
      });
    });

    group('runCleanup', () {
      test('does nothing when auto-delete is off', () async {
        currentDuration = AutoDeleteDuration.off;
        activePeerIds = ['peer1', 'peer2'];
        service = buildService();

        final cleaned = await service.runCleanup();

        expect(cleaned, equals(0));
        expect(deleteCalls, isEmpty);
      });

      test('does nothing when no active peers', () async {
        currentDuration = AutoDeleteDuration.oneDay;
        activePeerIds = [];
        service = buildService();

        final cleaned = await service.runCleanup();

        expect(cleaned, equals(0));
        expect(deleteCalls, isEmpty);
      });

      test('deletes messages for all active peers', () async {
        currentDuration = AutoDeleteDuration.oneDay;
        activePeerIds = ['peer1', 'peer2', 'peer3'];
        service = buildService();

        final before = DateTime.now();
        final cleaned = await service.runCleanup();

        expect(cleaned, equals(3));
        expect(deleteCalls.length, equals(3));
        expect(deleteCalls.map((c) => c.$1).toList(),
            equals(['peer1', 'peer2', 'peer3']));

        // Verify cutoff times are approximately 1 day ago
        for (final (_, cutoff) in deleteCalls) {
          final diff = before.difference(cutoff);
          // Should be approximately 1 day (within a few seconds tolerance)
          expect(diff.inHours, closeTo(24, 1));
        }
      });

      test('uses correct cutoff for oneHour', () async {
        currentDuration = AutoDeleteDuration.oneHour;
        activePeerIds = ['peer1'];
        service = buildService();

        final before = DateTime.now();
        await service.runCleanup();

        expect(deleteCalls.length, equals(1));
        final diff = before.difference(deleteCalls[0].$2);
        expect(diff.inMinutes, closeTo(60, 1));
      });

      test('uses correct cutoff for sevenDays', () async {
        currentDuration = AutoDeleteDuration.sevenDays;
        activePeerIds = ['peer1'];
        service = buildService();

        final before = DateTime.now();
        await service.runCleanup();

        expect(deleteCalls.length, equals(1));
        final diff = before.difference(deleteCalls[0].$2);
        expect(diff.inDays, closeTo(7, 1));
      });

      test('continues processing on per-peer failure', () async {
        currentDuration = AutoDeleteDuration.oneDay;
        activePeerIds = ['peer1', 'peer2', 'peer3'];

        service = AutoDeleteService(
          deleteMessagesBefore: (peerId, before) async {
            if (peerId == 'peer2') {
              throw Exception('DB error for peer2');
            }
            deleteCalls.add((peerId, before));
          },
          getActivePeerIds: () async => activePeerIds,
          getAutoDeleteDuration: () => currentDuration,
        );

        final cleaned = await service.runCleanup();

        // peer1 and peer3 should be cleaned, peer2 failed
        expect(cleaned, equals(2));
        expect(deleteCalls.length, equals(2));
        expect(
            deleteCalls.map((c) => c.$1).toList(), equals(['peer1', 'peer3']));
      });
    });

    group('start/stop', () {
      test('isRunning is false initially', () {
        service = buildService();
        expect(service.isRunning, isFalse);
      });

      test('isRunning is true after start', () {
        service = buildService();
        service.start();
        expect(service.isRunning, isTrue);
        service.stop();
      });

      test('isRunning is false after stop', () {
        service = buildService();
        service.start();
        service.stop();
        expect(service.isRunning, isFalse);
      });

      test('dispose stops the timer', () {
        service = buildService();
        service.start();
        service.dispose();
        expect(service.isRunning, isFalse);
      });

      test('start can be called multiple times safely', () {
        service = buildService();
        service.start();
        service.start();
        expect(service.isRunning, isTrue);
        service.stop();
      });
    });
  });
}
