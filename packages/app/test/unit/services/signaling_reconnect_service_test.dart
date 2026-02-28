import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/signaling_client.dart'
    show SignalingConnectionState;
import 'package:zajel/core/services/signaling_reconnect_service.dart';

void main() {
  group('SignalingReconnectService', () {
    late List<String> displayStates;
    late bool? signalingConnected;
    late int connectCallCount;
    late bool connectShouldFail;
    late SignalingReconnectService service;

    setUp(() {
      displayStates = [];
      signalingConnected = null;
      connectCallCount = 0;
      connectShouldFail = false;
    });

    SignalingReconnectService buildService({
      int maxRetries = 5,
      Duration initialDelay = Duration.zero,
      Duration maxDelay = const Duration(seconds: 1),
    }) {
      return SignalingReconnectService(
        connectSignaling: () async {
          connectCallCount++;
          if (connectShouldFail) {
            throw Exception('Connection failed');
          }
        },
        setDisplayStateConnecting: () => displayStates.add('connecting'),
        setDisplayStateDisconnected: () => displayStates.add('disconnected'),
        setSignalingConnected: (connected) => signalingConnected = connected,
        maxRetries: maxRetries,
        initialDelay: initialDelay,
        maxDelay: maxDelay,
      );
    }

    test('initial state is not reconnecting', () {
      service = buildService();
      expect(service.isReconnecting, isFalse);
    });

    test('returns null when stream is null', () {
      service = buildService();
      final sub = service.listen(
        connectionStateStream: null,
        isDisposed: () => false,
      );
      expect(sub, isNull);
    });

    test('reconnects on disconnect event', () async {
      service = buildService(initialDelay: Duration.zero);
      final controller = StreamController<SignalingConnectionState>();

      final sub = service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => false,
      );

      controller.add(SignalingConnectionState.disconnected);
      // Let async processing complete
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(signalingConnected, isFalse);
      expect(connectCallCount, equals(1));
      expect(displayStates, contains('connecting'));

      sub?.cancel();
      await controller.close();
    });

    test('reconnects on failed event', () async {
      service = buildService(initialDelay: Duration.zero);
      final controller = StreamController<SignalingConnectionState>();

      final sub = service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => false,
      );

      controller.add(SignalingConnectionState.failed);
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(signalingConnected, isFalse);
      expect(connectCallCount, equals(1));

      sub?.cancel();
      await controller.close();
    });

    test('does not reconnect on connected event', () async {
      service = buildService();
      final controller = StreamController<SignalingConnectionState>();

      final sub = service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => false,
      );

      controller.add(SignalingConnectionState.connected);
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(connectCallCount, equals(0));
      expect(displayStates, isEmpty);

      sub?.cancel();
      await controller.close();
    });

    test('does not reconnect when disposed', () async {
      service = buildService(initialDelay: Duration.zero);
      final controller = StreamController<SignalingConnectionState>();

      final sub = service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => true,
      );

      controller.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(connectCallCount, equals(0));

      sub?.cancel();
      await controller.close();
    });

    test('retries on connection failure', () async {
      connectShouldFail = true;
      service = buildService(
        maxRetries: 3,
        initialDelay: Duration.zero,
      );
      final controller = StreamController<SignalingConnectionState>();

      final sub = service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => false,
      );

      controller.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 200));

      expect(connectCallCount, equals(3));
      // Should end with disconnected after all retries fail
      expect(displayStates.last, equals('disconnected'));
      expect(service.isReconnecting, isFalse);

      sub?.cancel();
      await controller.close();
    });

    test('succeeds on second attempt', () async {
      var attempt = 0;
      service = SignalingReconnectService(
        connectSignaling: () async {
          attempt++;
          if (attempt < 2) {
            throw Exception('First attempt fails');
          }
        },
        setDisplayStateConnecting: () => displayStates.add('connecting'),
        setDisplayStateDisconnected: () => displayStates.add('disconnected'),
        setSignalingConnected: (connected) => signalingConnected = connected,
        maxRetries: 5,
        initialDelay: Duration.zero,
        maxDelay: const Duration(seconds: 1),
      );

      final controller = StreamController<SignalingConnectionState>();

      final sub = service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => false,
      );

      controller.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 100));

      expect(attempt, equals(2));
      expect(service.isReconnecting, isFalse);

      sub?.cancel();
      await controller.close();
    });

    test('stops reconnecting when disposed mid-retry', () async {
      connectShouldFail = true;
      var disposed = false;

      service = SignalingReconnectService(
        connectSignaling: () async {
          connectCallCount++;
          // Mark disposed after first attempt
          if (connectCallCount == 1) {
            disposed = true;
          }
          throw Exception('fail');
        },
        setDisplayStateConnecting: () => displayStates.add('connecting'),
        setDisplayStateDisconnected: () => displayStates.add('disconnected'),
        setSignalingConnected: (connected) => signalingConnected = connected,
        maxRetries: 5,
        initialDelay: Duration.zero,
        maxDelay: const Duration(seconds: 1),
      );

      final controller = StreamController<SignalingConnectionState>();

      final sub = service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => disposed,
      );

      controller.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 100));

      // Should stop after first attempt since isDisposed becomes true
      expect(connectCallCount, equals(1));

      sub?.cancel();
      await controller.close();
    });

    test('does not start duplicate reconnect attempts', () async {
      connectShouldFail = true;
      service = buildService(
        maxRetries: 2,
        initialDelay: const Duration(milliseconds: 50),
      );

      final controller = StreamController<SignalingConnectionState>();

      final sub = service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => false,
      );

      // Fire two disconnects in rapid succession
      controller.add(SignalingConnectionState.disconnected);
      controller.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 300));

      // Should only run one round of retries (maxRetries=2), not two
      expect(connectCallCount, equals(2));

      sub?.cancel();
      await controller.close();
    });

    test('dispose cancels subscription', () {
      service = buildService();
      final controller = StreamController<SignalingConnectionState>();

      service.listen(
        connectionStateStream: controller.stream,
        isDisposed: () => false,
      );

      service.dispose();

      // After dispose, adding events should not cause errors
      controller.add(SignalingConnectionState.disconnected);
      controller.close();
    });
  });
}
