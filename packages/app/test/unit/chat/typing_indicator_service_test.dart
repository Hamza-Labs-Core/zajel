import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/features/chat/services/typing_indicator_service.dart';

import '../../mocks/mocks.dart';

void main() {
  late MockConnectionManager mockCM;
  late StreamController<(String, String)> typingController;
  late TypingIndicatorService service;

  setUp(() {
    mockCM = MockConnectionManager();
    typingController = StreamController<(String, String)>.broadcast();

    when(() => mockCM.typingEvents).thenAnswer((_) => typingController.stream);
    when(() => mockCM.sendMessage(any(), any())).thenAnswer((_) async {});

    service = TypingIndicatorService(connectionManager: mockCM);
  });

  tearDown(() {
    service.dispose();
    typingController.close();
  });

  group('start()', () {
    test('subscribes to typingEvents stream', () {
      expect(typingController.hasListener, isFalse);
      service.start();
      expect(typingController.hasListener, isTrue);
    });
  });

  group('incoming typing events', () {
    test('receiving "start" payload sets peer as typing', () async {
      service.start();
      typingController.add(('peer-1', 'start'));

      await Future<void>.delayed(Duration.zero);

      expect(service.isTyping('peer-1'), isTrue);
    });

    test('isTyping() returns false for unknown peer', () {
      expect(service.isTyping('unknown-peer'), isFalse);
    });

    test('typingStates stream emits updated map', () async {
      service.start();

      final emissions = <Map<String, bool>>[];
      service.typingStates.listen(emissions.add);

      typingController.add(('peer-1', 'start'));
      await Future<void>.delayed(Duration.zero);

      expect(emissions, hasLength(1));
      expect(emissions.first['peer-1'], isTrue);
    });

    test('typing state auto-expires after 5 seconds', () {
      fakeAsync((async) {
        service.start();
        typingController.add(('peer-1', 'start'));
        async.flushMicrotasks();

        expect(service.isTyping('peer-1'), isTrue);

        async.elapse(const Duration(seconds: 5));

        expect(service.isTyping('peer-1'), isFalse);
      });
    });

    test('consecutive "start" events reset the 5-second timer', () {
      fakeAsync((async) {
        service.start();

        typingController.add(('peer-1', 'start'));
        async.flushMicrotasks();

        // Wait 3 seconds then send another start
        async.elapse(const Duration(seconds: 3));
        expect(service.isTyping('peer-1'), isTrue);

        typingController.add(('peer-1', 'start'));
        async.flushMicrotasks();

        // 3 more seconds (6 total from first, 3 from second)
        async.elapse(const Duration(seconds: 3));
        expect(service.isTyping('peer-1'), isTrue);

        // 2 more seconds (5 total from second event)
        async.elapse(const Duration(seconds: 2));
        expect(service.isTyping('peer-1'), isFalse);
      });
    });

    test('non-"start" payloads are ignored', () async {
      service.start();
      typingController.add(('peer-1', 'stop'));

      await Future<void>.delayed(Duration.zero);

      expect(service.isTyping('peer-1'), isFalse);
    });
  });

  group('sendTyping()', () {
    test('sends typ:start on first call', () {
      service.sendTyping('peer-1');

      verify(() => mockCM.sendMessage('peer-1', 'typ:start')).called(1);
    });

    test('debounces — second call within 3 seconds suppressed', () {
      service.sendTyping('peer-1');
      service.sendTyping('peer-1');
      service.sendTyping('peer-1');

      verify(() => mockCM.sendMessage('peer-1', 'typ:start')).called(1);
    });

    test('sends to different peers independently', () {
      service.sendTyping('peer-1');
      service.sendTyping('peer-2');

      verify(() => mockCM.sendMessage('peer-1', 'typ:start')).called(1);
      verify(() => mockCM.sendMessage('peer-2', 'typ:start')).called(1);
    });
  });

  group('dispose()', () {
    test('cancels subscription and clears state', () {
      service.start();
      service.dispose();

      expect(typingController.hasListener, isFalse);
    });

    test('closes typingStates stream after dispose', () {
      final done = expectLater(
        service.typingStates,
        emitsDone,
      );

      service.dispose();

      return done;
    });
  });
}
