import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/network/signaling_client.dart';

import '../mocks/mocks.dart';

void main() {
  group('SignalingConnectionState enum', () {
    test('has the expected values', () {
      expect(SignalingConnectionState.values, hasLength(4));
      expect(
        SignalingConnectionState.values,
        containsAll([
          SignalingConnectionState.disconnected,
          SignalingConnectionState.connecting,
          SignalingConnectionState.connected,
          SignalingConnectionState.failed,
        ]),
      );
    });

    test('disconnected has index 0', () {
      expect(SignalingConnectionState.disconnected.index, 0);
    });

    test('connecting has index 1', () {
      expect(SignalingConnectionState.connecting.index, 1);
    });

    test('connected has index 2', () {
      expect(SignalingConnectionState.connected.index, 2);
    });

    test('failed has index 3', () {
      expect(SignalingConnectionState.failed.index, 3);
    });
  });

  group('Mock signaling client connection state stream', () {
    late MockSignalingClient mockSignalingClient;
    late StreamController<SignalingConnectionState> stateController;

    setUp(() {
      mockSignalingClient = MockSignalingClient();
      stateController = StreamController<SignalingConnectionState>.broadcast();

      when(() => mockSignalingClient.connectionState)
          .thenAnswer((_) => stateController.stream);
    });

    tearDown(() async {
      await stateController.close();
    });

    test('emits connection state changes through the mock', () async {
      final states = <SignalingConnectionState>[];
      final subscription =
          mockSignalingClient.connectionState.listen(states.add);

      stateController.add(SignalingConnectionState.connecting);
      stateController.add(SignalingConnectionState.connected);

      // Allow microtasks to complete so listeners fire.
      await Future<void>.delayed(Duration.zero);

      expect(states, [
        SignalingConnectionState.connecting,
        SignalingConnectionState.connected,
      ]);

      await subscription.cancel();
    });

    test('emits disconnected state when disconnect occurs', () async {
      final states = <SignalingConnectionState>[];
      final subscription =
          mockSignalingClient.connectionState.listen(states.add);

      stateController.add(SignalingConnectionState.connected);
      await Future<void>.delayed(Duration.zero);

      // Simulate disconnect
      stateController.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(Duration.zero);

      expect(states, [
        SignalingConnectionState.connected,
        SignalingConnectionState.disconnected,
      ]);

      await subscription.cancel();
    });

    test('emits failed state on connection error', () async {
      final states = <SignalingConnectionState>[];
      final subscription =
          mockSignalingClient.connectionState.listen(states.add);

      stateController.add(SignalingConnectionState.connecting);
      await Future<void>.delayed(Duration.zero);

      // Simulate failure
      stateController.add(SignalingConnectionState.failed);
      await Future<void>.delayed(Duration.zero);

      expect(states, [
        SignalingConnectionState.connecting,
        SignalingConnectionState.failed,
      ]);

      await subscription.cancel();
    });

    test('connected -> disconnected transition triggers reconnect-worthy state',
        () async {
      final reconnectTriggerStates = <SignalingConnectionState>[];
      final subscription =
          mockSignalingClient.connectionState.listen((state) {
        if (state == SignalingConnectionState.disconnected ||
            state == SignalingConnectionState.failed) {
          reconnectTriggerStates.add(state);
        }
      });

      stateController.add(SignalingConnectionState.connected);
      await Future<void>.delayed(Duration.zero);
      expect(reconnectTriggerStates, isEmpty);

      stateController.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(Duration.zero);
      expect(reconnectTriggerStates, [SignalingConnectionState.disconnected]);

      await subscription.cancel();
    });

    test('connected -> failed transition triggers reconnect-worthy state',
        () async {
      final reconnectTriggerStates = <SignalingConnectionState>[];
      final subscription =
          mockSignalingClient.connectionState.listen((state) {
        if (state == SignalingConnectionState.disconnected ||
            state == SignalingConnectionState.failed) {
          reconnectTriggerStates.add(state);
        }
      });

      stateController.add(SignalingConnectionState.connected);
      await Future<void>.delayed(Duration.zero);
      expect(reconnectTriggerStates, isEmpty);

      stateController.add(SignalingConnectionState.failed);
      await Future<void>.delayed(Duration.zero);
      expect(reconnectTriggerStates, [SignalingConnectionState.failed]);

      await subscription.cancel();
    });

    test('connecting and connected states do not trigger reconnect', () async {
      final reconnectTriggerStates = <SignalingConnectionState>[];
      final subscription =
          mockSignalingClient.connectionState.listen((state) {
        if (state == SignalingConnectionState.disconnected ||
            state == SignalingConnectionState.failed) {
          reconnectTriggerStates.add(state);
        }
      });

      stateController.add(SignalingConnectionState.connecting);
      stateController.add(SignalingConnectionState.connected);
      await Future<void>.delayed(Duration.zero);

      expect(reconnectTriggerStates, isEmpty);

      await subscription.cancel();
    });

    test('multiple disconnects emit multiple reconnect triggers', () async {
      final reconnectTriggerStates = <SignalingConnectionState>[];
      final subscription =
          mockSignalingClient.connectionState.listen((state) {
        if (state == SignalingConnectionState.disconnected ||
            state == SignalingConnectionState.failed) {
          reconnectTriggerStates.add(state);
        }
      });

      // First cycle: connect then disconnect
      stateController.add(SignalingConnectionState.connected);
      stateController.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(Duration.zero);

      // Second cycle: reconnect then fail
      stateController.add(SignalingConnectionState.connecting);
      stateController.add(SignalingConnectionState.failed);
      await Future<void>.delayed(Duration.zero);

      // Third cycle: reconnect, connect, disconnect again
      stateController.add(SignalingConnectionState.connecting);
      stateController.add(SignalingConnectionState.connected);
      stateController.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(Duration.zero);

      expect(reconnectTriggerStates, [
        SignalingConnectionState.disconnected,
        SignalingConnectionState.failed,
        SignalingConnectionState.disconnected,
      ]);

      await subscription.cancel();
    });

    test('broadcast stream supports multiple listeners', () async {
      final statesA = <SignalingConnectionState>[];
      final statesB = <SignalingConnectionState>[];

      final subA = mockSignalingClient.connectionState.listen(statesA.add);
      final subB = mockSignalingClient.connectionState.listen(statesB.add);

      stateController.add(SignalingConnectionState.connected);
      stateController.add(SignalingConnectionState.disconnected);
      await Future<void>.delayed(Duration.zero);

      expect(statesA, [
        SignalingConnectionState.connected,
        SignalingConnectionState.disconnected,
      ]);
      expect(statesB, [
        SignalingConnectionState.connected,
        SignalingConnectionState.disconnected,
      ]);

      await subA.cancel();
      await subB.cancel();
    });
  });
}
