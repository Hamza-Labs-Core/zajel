import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/voip_service.dart';
import 'package:zajel/core/notifications/call_foreground_service.dart';
import 'package:zajel/core/services/voip_call_handler.dart';

/// Minimal fake VoIPService for testing state transitions.
///
/// We only need the onStateChange stream and currentCall getter.
/// Cannot extend the real VoIPService (it needs SignalingClient + MediaService),
/// so we use `implements` with `noSuchMethod` to stub the rest.
class FakeVoIPService implements VoIPService {
  final _stateController = StreamController<CallState>.broadcast();
  CallInfo? _currentCall;

  @override
  Stream<CallState> get onStateChange => _stateController.stream;

  @override
  CallInfo? get currentCall => _currentCall;

  set currentCall(CallInfo? call) => _currentCall = call;

  void emitState(CallState state) => _stateController.add(state);

  List<(String, bool)> acceptCallCalls = [];
  List<String> rejectCallCalls = [];

  @override
  Future<void> acceptCall(String callId, bool withVideo) async {
    acceptCallCalls.add((callId, withVideo));
  }

  @override
  void rejectCall(String callId, {String? reason}) {
    rejectCallCalls.add(callId);
  }

  @override
  void dispose() => _stateController.close();

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// Extends CallForegroundService and overrides start/stop to track calls
/// without triggering platform channels.
class FakeCallForegroundService extends CallForegroundService {
  List<(String, bool)> startCalls = [];
  int stopCallCount = 0;

  @override
  Future<void> start({required String peerName, bool withVideo = false}) async {
    startCalls.add((peerName, withVideo));
  }

  @override
  Future<void> stop() async {
    stopCallCount++;
  }
}

void main() {
  group('VoipCallHandler', () {
    late FakeVoIPService fakeVoip;
    late FakeCallForegroundService fakeForeground;
    late List<(String, String, bool)> showCallNotifCalls;
    late List<String> resolveNameCalls;
    VoipCallHandler? handler;

    setUp(() {
      fakeVoip = FakeVoIPService();
      fakeForeground = FakeCallForegroundService();
      showCallNotifCalls = [];
      resolveNameCalls = [];
    });

    tearDown(() {
      handler?.dispose();
      fakeVoip.dispose();
    });

    VoipCallHandler createHandler() {
      handler = VoipCallHandler(
        getContext: () => null, // No context = dialog won't show
        getVoipService: () => fakeVoip,
        getMediaService: () => throw UnimplementedError('Not needed'),
        resolvePeerName: (peerId) {
          resolveNameCalls.add(peerId);
          return 'User_$peerId';
        },
        showCallNotification: ({
          required String peerId,
          required String peerName,
          required bool withVideo,
        }) {
          showCallNotifCalls.add((peerId, peerName, withVideo));
        },
        callForegroundService: fakeForeground,
      );
      return handler!;
    }

    test('subscribeToService subscribes to state changes', () async {
      createHandler();
      handler!.subscribeToService(fakeVoip);

      fakeVoip.currentCall = CallInfo(
        callId: 'call1',
        peerId: 'peer1',
        withVideo: true,
      );

      fakeVoip.emitState(CallState.incoming);
      await Future<void>.delayed(Duration.zero);

      // Should have resolved peer name and shown notification
      expect(resolveNameCalls, contains('peer1'));
      expect(showCallNotifCalls, hasLength(1));
      expect(showCallNotifCalls[0].$1, 'peer1');
      expect(showCallNotifCalls[0].$2, 'User_peer1');
      expect(showCallNotifCalls[0].$3, true);
    });

    test('does not show notification when currentCall is null', () async {
      createHandler();
      handler!.subscribeToService(fakeVoip);

      fakeVoip.currentCall = null;
      fakeVoip.emitState(CallState.incoming);
      await Future<void>.delayed(Duration.zero);

      expect(showCallNotifCalls, isEmpty);
    });

    test('starts foreground service on connected state', () async {
      createHandler();
      handler!.subscribeToService(fakeVoip);

      fakeVoip.currentCall = CallInfo(
        callId: 'call2',
        peerId: 'peer2',
        withVideo: false,
      );

      fakeVoip.emitState(CallState.connected);
      await Future<void>.delayed(Duration.zero);

      expect(fakeForeground.startCalls, hasLength(1));
      expect(fakeForeground.startCalls[0].$1, 'peer2');
      expect(fakeForeground.startCalls[0].$2, false);
    });

    test('stops foreground service on ended state', () async {
      createHandler();
      handler!.subscribeToService(fakeVoip);

      fakeVoip.emitState(CallState.ended);
      await Future<void>.delayed(Duration.zero);

      expect(fakeForeground.stopCallCount, 1);
    });

    test('stops foreground service on idle state', () async {
      createHandler();
      handler!.subscribeToService(fakeVoip);

      fakeVoip.emitState(CallState.idle);
      await Future<void>.delayed(Duration.zero);

      expect(fakeForeground.stopCallCount, 1);
    });

    test('cancels previous subscription when subscribing to new service',
        () async {
      createHandler();
      handler!.subscribeToService(fakeVoip);

      final fakeVoip2 = FakeVoIPService();
      handler!.subscribeToService(fakeVoip2);

      // Event on old service should be ignored
      fakeVoip.currentCall = CallInfo(
        callId: 'call_old',
        peerId: 'old_peer',
        withVideo: false,
      );
      fakeVoip.emitState(CallState.incoming);
      await Future<void>.delayed(Duration.zero);

      expect(showCallNotifCalls, isEmpty);

      // Event on new service should be handled
      fakeVoip2.currentCall = CallInfo(
        callId: 'call_new',
        peerId: 'new_peer',
        withVideo: true,
      );
      fakeVoip2.emitState(CallState.incoming);
      await Future<void>.delayed(Duration.zero);

      expect(showCallNotifCalls, hasLength(1));
      expect(showCallNotifCalls[0].$1, 'new_peer');

      fakeVoip2.dispose();
    });

    test('subscribing to null service cancels subscription', () async {
      createHandler();
      handler!.subscribeToService(fakeVoip);
      handler!.subscribeToService(null);

      fakeVoip.currentCall = CallInfo(
        callId: 'call3',
        peerId: 'peer3',
        withVideo: false,
      );
      fakeVoip.emitState(CallState.incoming);
      await Future<void>.delayed(Duration.zero);

      expect(showCallNotifCalls, isEmpty);
    });

    test('dispose cancels subscription', () async {
      createHandler();
      handler!.subscribeToService(fakeVoip);
      handler!.dispose();
      handler = null; // prevent double dispose in tearDown

      fakeVoip.currentCall = CallInfo(
        callId: 'call4',
        peerId: 'peer4',
        withVideo: false,
      );
      fakeVoip.emitState(CallState.incoming);
      await Future<void>.delayed(Duration.zero);

      expect(showCallNotifCalls, isEmpty);
    });

    test('isIncomingCallDialogOpen is false initially', () {
      createHandler();
      expect(handler!.isIncomingCallDialogOpen, false);
    });
  });
}
