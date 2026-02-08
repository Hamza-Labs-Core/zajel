import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/pinned_websocket.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('CertificatePins', () {
    test('has correct Zajel app pins configured', () {
      expect(CertificatePins.zajelApp, isNotEmpty);
      expect(CertificatePins.zajelApp.length, equals(2));
      // All pins should be base64-encoded SHA-256 hashes
      for (final pin in CertificatePins.zajelApp) {
        expect(pin.length, greaterThanOrEqualTo(43));
        expect(pin, endsWith('='));
      }
    });

    group('getPinsForUrl', () {
      test('returns empty for workers.dev domains (no longer pinned)', () {
        final pins = CertificatePins.getPinsForUrl('wss://my-worker.workers.dev/ws');
        expect(pins, isEmpty);
      });

      test('returns empty for hamzalabs.dev domains (no longer pinned)', () {
        final pins = CertificatePins.getPinsForUrl('wss://signal.zajel.hamzalabs.dev/ws');
        expect(pins, isEmpty);
      });

      test('returns Zajel pins for zajel.app domains', () {
        final pins = CertificatePins.getPinsForUrl('wss://signaling.zajel.app/ws');
        expect(pins, equals(CertificatePins.zajelApp));
      });

      test('returns Zajel pins for subdomains of zajel.app', () {
        final pins = CertificatePins.getPinsForUrl('wss://api.relay.zajel.app/ws');
        expect(pins, equals(CertificatePins.zajelApp));
      });

      test('returns empty list for unknown domains', () {
        final pins = CertificatePins.getPinsForUrl('wss://example.com/ws');
        expect(pins, isEmpty);
      });

      test('returns empty list for localhost', () {
        final pins = CertificatePins.getPinsForUrl('wss://localhost:8080/ws');
        expect(pins, isEmpty);
      });

      test('handles case-insensitive domain matching', () {
        final pins = CertificatePins.getPinsForUrl('wss://Signaling.Zajel.App/ws');
        expect(pins, equals(CertificatePins.zajelApp));
      });
    });
  });

  group('PinnedWebSocketState', () {
    test('has all expected values', () {
      expect(PinnedWebSocketState.values, hasLength(4));
      expect(PinnedWebSocketState.values, contains(PinnedWebSocketState.disconnected));
      expect(PinnedWebSocketState.values, contains(PinnedWebSocketState.connecting));
      expect(PinnedWebSocketState.values, contains(PinnedWebSocketState.connected));
      expect(PinnedWebSocketState.values, contains(PinnedWebSocketState.error));
    });
  });

  group('PinnedWebSocketException', () {
    test('stores message correctly', () {
      final exception = PinnedWebSocketException('Test error message');
      expect(exception.message, equals('Test error message'));
    });

    test('toString includes class name and message', () {
      final exception = PinnedWebSocketException('Connection failed');
      expect(exception.toString(), equals('PinnedWebSocketException: Connection failed'));
    });

    test('is an Exception', () {
      final exception = PinnedWebSocketException('Error');
      expect(exception, isA<Exception>());
    });
  });

  group('PinnedWebSocket', () {
    late List<MethodCall> methodCalls;
    late StreamController<Map<dynamic, dynamic>> eventController;

    setUp(() {
      methodCalls = [];
      eventController = StreamController<Map<dynamic, dynamic>>.broadcast();

      // Set up mock method channel
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('zajel/pinned_websocket'),
        (MethodCall call) async {
          methodCalls.add(call);
          switch (call.method) {
            case 'connect':
              return {
                'success': true,
                'connectionId': 'test-connection-123',
              };
            case 'send':
              return true;
            case 'close':
              return true;
            default:
              throw MissingPluginException();
          }
        },
      );

      // Set up mock event channel
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        const EventChannel('zajel/pinned_websocket_events'),
        MockStreamHandler.inline(
          onListen: (arguments, events) {
            eventController.stream.listen(
              (data) => events.success(data),
              onError: (error) => events.error(code: 'ERROR', message: error.toString()),
            );
          },
          onCancel: (arguments) {},
        ),
      );
    });

    tearDown(() async {
      // Clear mock handlers
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('zajel/pinned_websocket'),
        null,
      );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
        const EventChannel('zajel/pinned_websocket_events'),
        null,
      );
      await eventController.close();
    });

    group('constructor', () {
      test('initializes with correct URL', () {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        expect(socket.url, equals('wss://test.example.com/ws'));
      });

      test('auto-detects pins for known domains', () {
        final socket = PinnedWebSocket(url: 'wss://signaling.zajel.app/ws');
        expect(socket.pins, equals(CertificatePins.zajelApp));
      });

      test('uses provided pins when specified', () {
        final customPins = ['customPin1=', 'customPin2='];
        final socket = PinnedWebSocket(
          url: 'wss://my-worker.workers.dev/ws',
          pins: customPins,
        );
        expect(socket.pins, equals(customPins));
      });

      test('uses default timeout of 30 seconds', () {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        expect(socket.connectionTimeout, equals(const Duration(seconds: 30)));
      });

      test('allows custom timeout', () {
        final socket = PinnedWebSocket(
          url: 'wss://test.example.com/ws',
          connectionTimeout: const Duration(seconds: 60),
        );
        expect(socket.connectionTimeout, equals(const Duration(seconds: 60)));
      });

      test('initial state is disconnected', () {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        expect(socket.state, equals(PinnedWebSocketState.disconnected));
      });

      test('initial isConnected is false', () {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        expect(socket.isConnected, isFalse);
      });
    });

    group('connect', () {
      test('transitions to connecting state', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final states = <PinnedWebSocketState>[];
        socket.stateStream.listen(states.add);

        await socket.connect();

        expect(states.contains(PinnedWebSocketState.connecting), isTrue);
        await socket.dispose();
      });

      test('transitions to connected state on success', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();

        expect(socket.state, equals(PinnedWebSocketState.connected));
        expect(socket.isConnected, isTrue);
        await socket.dispose();
      });

      test('calls native connect with correct parameters', () async {
        final socket = PinnedWebSocket(
          url: 'wss://signaling.zajel.app/ws',
          connectionTimeout: const Duration(seconds: 45),
        );
        await socket.connect();

        expect(methodCalls, hasLength(1));
        expect(methodCalls[0].method, equals('connect'));
        expect(methodCalls[0].arguments['url'], equals('wss://signaling.zajel.app/ws'));
        expect(methodCalls[0].arguments['pins'], equals(CertificatePins.zajelApp));
        expect(methodCalls[0].arguments['timeoutMs'], equals(45000));
        await socket.dispose();
      });

      test('skips if already connecting', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();
        methodCalls.clear();

        // Should not call native again
        await socket.connect();
        expect(methodCalls, isEmpty);
        await socket.dispose();
      });

      test('skips if already connected', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();
        methodCalls.clear();

        await socket.connect();
        expect(methodCalls, isEmpty);
        await socket.dispose();
      });

      test('handles connection failure', () async {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
          const MethodChannel('zajel/pinned_websocket'),
          (MethodCall call) async {
            if (call.method == 'connect') {
              return {'success': false, 'error': 'Connection refused'};
            }
            return null;
          },
        );

        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');

        await expectLater(
          socket.connect(),
          throwsA(isA<PinnedWebSocketException>()),
        );
        expect(socket.state, equals(PinnedWebSocketState.error));
        await socket.dispose();
      });

      test('handles MissingPluginException', () async {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
          const MethodChannel('zajel/pinned_websocket'),
          (MethodCall call) async {
            throw MissingPluginException();
          },
        );

        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');

        await expectLater(
          socket.connect(),
          throwsA(isA<PinnedWebSocketException>().having(
            (e) => e.message,
            'message',
            contains('plugin not registered'),
          )),
        );
        expect(socket.state, equals(PinnedWebSocketState.error));
        await socket.dispose();
      });

      test('handles PlatformException', () async {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
          const MethodChannel('zajel/pinned_websocket'),
          (MethodCall call) async {
            throw PlatformException(code: 'SSL_ERROR', message: 'Certificate validation failed');
          },
        );

        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');

        await expectLater(
          socket.connect(),
          throwsA(isA<PlatformException>().having(
            (e) => e.message,
            'message',
            equals('Certificate validation failed'),
          )),
        );
        expect(socket.state, equals(PinnedWebSocketState.error));
        await socket.dispose();
      });
    });

    group('send', () {
      test('calls native send with correct parameters', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();
        methodCalls.clear();

        await socket.send('test message');

        expect(methodCalls, hasLength(1));
        expect(methodCalls[0].method, equals('send'));
        expect(methodCalls[0].arguments['connectionId'], equals('test-connection-123'));
        expect(methodCalls[0].arguments['message'], equals('test message'));
        await socket.dispose();
      });

      test('throws if not connected', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');

        expect(
          () => socket.send('test message'),
          throwsA(isA<PinnedWebSocketException>().having(
            (e) => e.message,
            'message',
            equals('Not connected'),
          )),
        );
        await socket.dispose();
      });

      test('handles send failure', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();

        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
          const MethodChannel('zajel/pinned_websocket'),
          (MethodCall call) async {
            if (call.method == 'send') {
              throw PlatformException(code: 'SEND_FAILED', message: 'Failed to send');
            }
            return {'success': true, 'connectionId': 'test-connection-123'};
          },
        );

        await expectLater(
          socket.send('test message'),
          throwsA(isA<PlatformException>()),
        );
        await socket.dispose();
      });
    });

    group('close', () {
      test('calls native close with connection ID', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();
        methodCalls.clear();

        await socket.close();

        expect(methodCalls, hasLength(1));
        expect(methodCalls[0].method, equals('close'));
        expect(methodCalls[0].arguments['connectionId'], equals('test-connection-123'));
      });

      test('transitions to disconnected state', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();
        expect(socket.state, equals(PinnedWebSocketState.connected));

        await socket.close();
        expect(socket.state, equals(PinnedWebSocketState.disconnected));
        expect(socket.isConnected, isFalse);
      });

      test('does nothing if already disconnected', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.close();
        expect(methodCalls, isEmpty);
      });

      test('handles close errors gracefully', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();

        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
          const MethodChannel('zajel/pinned_websocket'),
          (MethodCall call) async {
            if (call.method == 'close') {
              throw PlatformException(code: 'ERROR', message: 'Close failed');
            }
            return {'success': true, 'connectionId': 'test-connection-123'};
          },
        );

        // Should not throw
        await socket.close();
        expect(socket.state, equals(PinnedWebSocketState.disconnected));
      });
    });

    group('dispose', () {
      test('closes connection and streams', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();

        await socket.dispose();

        expect(socket.state, equals(PinnedWebSocketState.disconnected));
      });

      test('can be called multiple times', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();

        await socket.dispose();
        await socket.dispose(); // Should not throw
      });
    });

    group('event handling', () {
      test('handles message events', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final messages = <String>[];
        socket.messages.listen(messages.add);

        await socket.connect();

        // Simulate receiving a message
        eventController.add({
          'type': 'message',
          'connectionId': 'test-connection-123',
          'data': 'Hello, World!',
        });

        await Future.delayed(Duration.zero);

        expect(messages, contains('Hello, World!'));
        await socket.dispose();
      });

      test('ignores messages for other connections', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final messages = <String>[];
        socket.messages.listen(messages.add);

        await socket.connect();

        // Simulate receiving a message for different connection
        eventController.add({
          'type': 'message',
          'connectionId': 'different-connection',
          'data': 'Wrong message',
        });

        await Future.delayed(Duration.zero);

        expect(messages, isEmpty);
        await socket.dispose();
      });

      test('handles connected events', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final states = <PinnedWebSocketState>[];
        socket.stateStream.listen(states.add);

        await socket.connect();
        states.clear();

        eventController.add({
          'type': 'connected',
          'connectionId': 'test-connection-123',
        });

        await Future.delayed(Duration.zero);

        expect(states, contains(PinnedWebSocketState.connected));
        await socket.dispose();
      });

      test('handles disconnected events', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();

        eventController.add({
          'type': 'disconnected',
          'connectionId': 'test-connection-123',
        });

        await Future.delayed(Duration.zero);

        expect(socket.state, equals(PinnedWebSocketState.disconnected));
        await socket.dispose();
      });

      test('handles error events', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final errors = <String>[];
        socket.errors.listen(errors.add);

        await socket.connect();

        eventController.add({
          'type': 'error',
          'connectionId': 'test-connection-123',
          'error': 'Network timeout',
        });

        await Future.delayed(Duration.zero);

        expect(errors, contains('Network timeout'));
        expect(socket.state, equals(PinnedWebSocketState.error));
        await socket.dispose();
      });

      test('handles error events with default message', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final errors = <String>[];
        socket.errors.listen(errors.add);

        await socket.connect();

        eventController.add({
          'type': 'error',
          'connectionId': 'test-connection-123',
        });

        await Future.delayed(Duration.zero);

        expect(errors, contains('Unknown error'));
        await socket.dispose();
      });

      test('handles pinning_failed events', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final errors = <String>[];
        socket.errors.listen(errors.add);

        await socket.connect();

        eventController.add({
          'type': 'pinning_failed',
          'connectionId': 'test-connection-123',
          'error': 'Pin mismatch: expected xyz, got abc',
        });

        await Future.delayed(Duration.zero);

        expect(errors.any((e) => e.contains('PINNING_FAILED')), isTrue);
        expect(socket.state, equals(PinnedWebSocketState.error));
        await socket.dispose();
      });

      test('handles pinning_failed events with default message', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final errors = <String>[];
        socket.errors.listen(errors.add);

        await socket.connect();

        eventController.add({
          'type': 'pinning_failed',
          'connectionId': 'test-connection-123',
        });

        await Future.delayed(Duration.zero);

        expect(errors.any((e) => e.contains('Certificate pinning failed')), isTrue);
        await socket.dispose();
      });

      test('handles stream errors', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        final errors = <String>[];
        socket.errors.listen(errors.add);

        await socket.connect();

        eventController.addError('Stream error');

        await Future.delayed(Duration.zero);

        expect(errors, isNotEmpty);
        expect(socket.state, equals(PinnedWebSocketState.error));
        await socket.dispose();
      });
    });

    group('streams', () {
      test('exposes stateStream', () {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        expect(socket.stateStream, isA<Stream<PinnedWebSocketState>>());
      });

      test('exposes messages stream', () {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        expect(socket.messages, isA<Stream<String>>());
      });

      test('exposes errors stream', () {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        expect(socket.errors, isA<Stream<String>>());
      });

      test('stateStream is broadcast', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');

        // Multiple listeners should work
        final states1 = <PinnedWebSocketState>[];
        final states2 = <PinnedWebSocketState>[];

        socket.stateStream.listen(states1.add);
        socket.stateStream.listen(states2.add);

        await socket.connect();

        expect(states1, isNotEmpty);
        expect(states2, isNotEmpty);
        await socket.dispose();
      });

      test('messages stream is broadcast', () async {
        final socket = PinnedWebSocket(url: 'wss://test.example.com/ws');
        await socket.connect();

        final messages1 = <String>[];
        final messages2 = <String>[];

        socket.messages.listen(messages1.add);
        socket.messages.listen(messages2.add);

        eventController.add({
          'type': 'message',
          'connectionId': 'test-connection-123',
          'data': 'test',
        });

        await Future.delayed(Duration.zero);

        expect(messages1, equals(['test']));
        expect(messages2, equals(['test']));
        await socket.dispose();
      });
    });
  });
}
