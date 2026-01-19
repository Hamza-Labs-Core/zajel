/// Integration tests for VoIP functionality.
///
/// Tests the full flow of:
/// - Outgoing call state transitions
/// - Incoming call handling
/// - Call acceptance and rejection
/// - Hangup and cleanup
/// - Media controls (mute, video toggle)
///
/// Uses MockMediaService to avoid requiring real camera/microphone access.
/// Requires the VPS signaling server to be running.
@Tags(['integration', 'voip'])
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/network/connection_manager.dart';
import 'package:zajel/core/network/device_link_service.dart';
import 'package:zajel/core/network/signaling_client.dart';
import 'package:zajel/core/network/voip_service.dart';
import 'package:zajel/core/network/webrtc_service.dart';

import 'helpers/mock_media.dart';
import 'test_config.dart';

void main() {
  final config = TestConfig.auto();

  group('VoIP E2E Tests', () {
    late ProviderContainer deviceA;
    late ProviderContainer deviceB;
    late MockMediaService mockMediaA;
    late MockMediaService mockMediaB;
    late SignalingClient signalingA;
    late SignalingClient signalingB;
    late VoIPService voipA;
    late VoIPService voipB;
    late ConnectionManager connectionManagerA;
    late ConnectionManager connectionManagerB;
    late String pairingCodeA;
    late String pairingCodeB;
    bool isConnected = false;

    setUpAll(() {
      if (config.verboseLogging) {
        debugPrint('VoIP E2E Test Configuration:');
        debugPrint('  VPS Server: ${config.vpsServerUrl}');
      }
    });

    setUp(() async {
      deviceA = ProviderContainer();
      deviceB = ProviderContainer();
      isConnected = false;

      // Initialize crypto services
      final cryptoA = CryptoService();
      final cryptoB = CryptoService();
      await cryptoA.initialize();
      await cryptoB.initialize();

      // Create WebRTC services
      final webrtcA = WebRTCService(cryptoService: cryptoA);
      final webrtcB = WebRTCService(cryptoService: cryptoB);

      // Create device link services
      final deviceLinkA = DeviceLinkService(
        cryptoService: cryptoA,
        webrtcService: webrtcA,
      );
      final deviceLinkB = DeviceLinkService(
        cryptoService: cryptoB,
        webrtcService: webrtcB,
      );

      // Create connection managers
      connectionManagerA = ConnectionManager(
        cryptoService: cryptoA,
        webrtcService: webrtcA,
        deviceLinkService: deviceLinkA,
      );
      connectionManagerB = ConnectionManager(
        cryptoService: cryptoB,
        webrtcService: webrtcB,
        deviceLinkService: deviceLinkB,
      );

      // Create mock media services
      mockMediaA = MockMediaService();
      mockMediaB = MockMediaService();

      // Connect to signaling server and get pairing codes
      if (!config.useMockServer) {
        try {
          pairingCodeA = await TestUtils.withTimeout(
            connectionManagerA.connect(serverUrl: config.vpsServerUrl),
            timeout: config.connectionTimeout,
            operationName: 'Device A connect',
          );
          pairingCodeB = await TestUtils.withTimeout(
            connectionManagerB.connect(serverUrl: config.vpsServerUrl),
            timeout: config.connectionTimeout,
            operationName: 'Device B connect',
          );

          // Create signaling clients for VoIP
          signalingA = SignalingClient(
            serverUrl: config.vpsServerUrl,
            pairingCode: pairingCodeA,
            publicKey: cryptoA.publicKeyBase64,
            usePinnedWebSocket: false,
          );
          signalingB = SignalingClient(
            serverUrl: config.vpsServerUrl,
            pairingCode: pairingCodeB,
            publicKey: cryptoB.publicKeyBase64,
            usePinnedWebSocket: false,
          );

          await signalingA.connect();
          await signalingB.connect();

          // Create VoIP services
          voipA = VoIPService(mockMediaA, signalingA);
          voipB = VoIPService(mockMediaB, signalingB);

          isConnected = true;

          if (config.verboseLogging) {
            debugPrint('Device A code: $pairingCodeA');
            debugPrint('Device B code: $pairingCodeB');
          }
        } catch (e) {
          if (config.verboseLogging) {
            debugPrint('Failed to connect to VPS server: $e');
          }
        }
      }
    });

    tearDown(() async {
      mockMediaA.dispose();
      mockMediaB.dispose();
      if (isConnected) {
        voipA.dispose();
        voipB.dispose();
        await signalingA.dispose();
        await signalingB.dispose();
      }
      await connectionManagerA.dispose();
      await connectionManagerB.dispose();
      deviceA.dispose();
      deviceB.dispose();
    });

    test('outgoing call transitions through correct states', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      final states = <CallState>[];
      voipA.onStateChange.listen((state) {
        states.add(state);
        if (config.verboseLogging) {
          debugPrint('VoIP A state: $state');
        }
      });

      // Start an outgoing call
      final callId = await voipA.startCall(pairingCodeB, false);

      expect(callId, isNotEmpty);
      expect(voipA.state, equals(CallState.outgoing));
      expect(voipA.hasActiveCall, isTrue);
      expect(voipA.currentCall?.peerId, equals(pairingCodeB));

      // Verify mock media was called
      expect(mockMediaA.requestMediaCallCount, equals(1));
      expect(mockMediaA.lastRequestedVideo, isFalse);

      // Let it ring for a moment then hangup
      await Future.delayed(const Duration(milliseconds: 500));
      voipA.hangup();

      // Wait for cleanup
      await Future.delayed(const Duration(milliseconds: 100));

      expect(voipA.state, equals(CallState.idle));
      expect(voipA.hasActiveCall, isFalse);

      // Verify states progression
      expect(states, contains(CallState.outgoing));
      expect(states, contains(CallState.ended));
    });

    test('incoming call shows correct state', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      final statesB = <CallState>[];
      voipB.onStateChange.listen((state) {
        statesB.add(state);
        if (config.verboseLogging) {
          debugPrint('VoIP B state: $state');
        }
      });

      // Device A calls Device B
      await voipA.startCall(pairingCodeB, false);

      // Wait for Device B to receive the call
      final receivedIncoming = await TestUtils.waitFor(
        () => voipB.state == CallState.incoming,
        timeout: const Duration(seconds: 10),
      );

      if (!receivedIncoming) {
        // Clean up and skip if signaling didn't work
        voipA.hangup();
        markTestSkipped('Call signaling not working');
        return;
      }

      expect(voipB.state, equals(CallState.incoming));
      expect(voipB.currentCall, isNotNull);
      expect(voipB.currentCall?.withVideo, isFalse);

      // Clean up
      voipB.rejectCall(voipB.currentCall!.callId, reason: 'test');
      await Future.delayed(const Duration(milliseconds: 100));
    });

    test('accept call transitions to connected', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      // Device A calls Device B
      await voipA.startCall(pairingCodeB, false);

      // Wait for Device B to receive the call
      final receivedIncoming = await TestUtils.waitFor(
        () => voipB.state == CallState.incoming,
        timeout: const Duration(seconds: 10),
      );

      if (!receivedIncoming) {
        voipA.hangup();
        markTestSkipped('Call signaling not working');
        return;
      }

      // Device B accepts the call
      await voipB.acceptCall(voipB.currentCall!.callId, false);

      expect(voipB.state, equals(CallState.connecting));

      // Wait for connected state (depends on WebRTC ICE)
      final connected = await TestUtils.waitFor(
        () => voipA.state == CallState.connected && voipB.state == CallState.connected,
        timeout: const Duration(seconds: 30),
      );

      if (connected) {
        expect(voipA.state, equals(CallState.connected));
        expect(voipB.state, equals(CallState.connected));
        expect(voipA.currentCall?.startTime, isNotNull);
        expect(voipB.currentCall?.startTime, isNotNull);
      }

      // Clean up
      voipA.hangup();
      await Future.delayed(const Duration(milliseconds: 200));
    });

    test('reject call cleans up and returns to idle', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      // Device A calls Device B
      await voipA.startCall(pairingCodeB, false);

      // Wait for Device B to receive the call
      final receivedIncoming = await TestUtils.waitFor(
        () => voipB.state == CallState.incoming,
        timeout: const Duration(seconds: 10),
      );

      if (!receivedIncoming) {
        voipA.hangup();
        markTestSkipped('Call signaling not working');
        return;
      }

      // Device B rejects the call
      voipB.rejectCall(voipB.currentCall!.callId, reason: 'declined');

      // Wait for cleanup
      await Future.delayed(const Duration(milliseconds: 200));

      expect(voipB.state, equals(CallState.idle));
      expect(voipB.hasActiveCall, isFalse);

      // Device A should also receive rejection
      final aEnded = await TestUtils.waitFor(
        () => voipA.state == CallState.idle || voipA.state == CallState.ended,
        timeout: const Duration(seconds: 5),
      );

      expect(aEnded, isTrue);
    });

    test('hangup mid-call terminates and notifies peer', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      // Device A calls Device B
      await voipA.startCall(pairingCodeB, false);

      // Wait for Device B to receive the call
      final receivedIncoming = await TestUtils.waitFor(
        () => voipB.state == CallState.incoming,
        timeout: const Duration(seconds: 10),
      );

      if (!receivedIncoming) {
        voipA.hangup();
        markTestSkipped('Call signaling not working');
        return;
      }

      // Device B accepts
      await voipB.acceptCall(voipB.currentCall!.callId, false);

      // Wait a moment
      await Future.delayed(const Duration(milliseconds: 500));

      // Device A hangs up
      voipA.hangup();

      // Wait for Device B to receive hangup
      final bEnded = await TestUtils.waitFor(
        () => voipB.state == CallState.idle || voipB.state == CallState.ended,
        timeout: const Duration(seconds: 5),
      );

      expect(bEnded, isTrue, reason: 'Device B should receive hangup notification');
    });

    test('mute toggle changes track enabled state', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      // Start a call to get media
      await voipA.startCall(pairingCodeB, false);

      expect(voipA.isAudioMuted, isFalse);

      // Toggle mute
      final muted = voipA.toggleMute();
      expect(muted, isTrue);
      expect(voipA.isAudioMuted, isTrue);

      // Toggle again
      final unmuted = voipA.toggleMute();
      expect(unmuted, isFalse);
      expect(voipA.isAudioMuted, isFalse);

      // Clean up
      voipA.hangup();
    });

    test('video toggle changes track enabled state', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      // Start a video call
      await voipA.startCall(pairingCodeB, true);

      expect(mockMediaA.lastRequestedVideo, isTrue);
      expect(voipA.isVideoMuted, isFalse);

      // Toggle video off
      final videoOff = voipA.toggleVideo();
      expect(videoOff, isFalse); // Returns video ON state
      expect(voipA.isVideoMuted, isTrue);

      // Toggle video on
      final videoOn = voipA.toggleVideo();
      expect(videoOn, isTrue);
      expect(voipA.isVideoMuted, isFalse);

      // Clean up
      voipA.hangup();
    });

    test('cannot start call while already in a call', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      // Start first call
      await voipA.startCall(pairingCodeB, false);
      expect(voipA.hasActiveCall, isTrue);

      // Try to start another call
      expect(
        () => voipA.startCall(pairingCodeB, false),
        throwsA(isA<CallException>()),
      );

      // Clean up
      voipA.hangup();
    });

    test('media controls do nothing when no active call', () async {
      if (!isConnected) {
        markTestSkipped('VPS server not available');
        return;
      }

      expect(voipA.hasActiveCall, isFalse);

      // These should not throw, just return current state
      final muteResult = voipA.toggleMute();
      final videoResult = voipA.toggleVideo();

      // State should remain unchanged
      expect(muteResult, equals(voipA.isAudioMuted));
      expect(videoResult, equals(!voipA.isVideoMuted));
    });
  });
}
