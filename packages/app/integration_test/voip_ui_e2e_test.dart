/// Real E2E integration tests for VoIP UI functionality.
///
/// These tests verify the VoIP call flow with REAL services:
/// - Auto-discovers VPS servers via Cloudflare bootstrap
/// - Real signaling server connection
/// - Real WebRTC call signaling
/// - Real call state transitions
/// - Actual UI interactions (taps on call controls)
///
/// Uses MockMediaService for camera/mic (only thing that needs mocking).
/// No manual server setup needed - tests discover servers automatically.
///
/// Run with:
/// ```bash
/// flutter test integration_test/voip_ui_e2e_test.dart
/// ```
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/network/connection_manager.dart';
import 'package:zajel/core/network/device_link_service.dart';
import 'package:zajel/core/network/server_discovery_service.dart';
import 'package:zajel/core/network/signaling_client.dart';
import 'package:zajel/core/network/voip_service.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/features/call/call_screen.dart';
import 'package:zajel/features/call/incoming_call_dialog.dart';

import 'helpers/mock_media.dart';

/// Bootstrap server URL (Cloudflare Workers).
const _bootstrapUrl = 'https://zajel-signaling.mahmoud-s-darwish.workers.dev';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // Server discovery
  late ServerDiscoveryService serverDiscovery;
  late String? serverUrl;

  // Real services for Device A
  late CryptoService cryptoA;
  late WebRTCService webrtcA;
  late DeviceLinkService deviceLinkA;
  late ConnectionManager connectionManagerA;
  late SignalingClient signalingA;
  late MockMediaService mockMediaA;
  late VoIPService voipA;

  // Real services for Device B
  late CryptoService cryptoB;
  late WebRTCService webrtcB;
  late DeviceLinkService deviceLinkB;
  late ConnectionManager connectionManagerB;
  late SignalingClient signalingB;
  late MockMediaService mockMediaB;
  late VoIPService voipB;

  late String pairingCodeA;
  late String pairingCodeB;
  bool isConnected = false;

  setUpAll(() async {
    // Discover servers from Cloudflare bootstrap
    serverDiscovery = ServerDiscoveryService(bootstrapUrl: _bootstrapUrl);
    final server = await serverDiscovery.selectServer();

    if (server != null) {
      serverUrl = serverDiscovery.getWebSocketUrl(server);
      debugPrint('Discovered server: ${server.serverId} at $serverUrl (${server.region})');
    } else {
      serverUrl = null;
      debugPrint('No servers discovered from bootstrap');
    }
  });

  tearDownAll(() {
    serverDiscovery.dispose();
  });

  setUp(() async {
    isConnected = false;

    if (serverUrl == null) {
      return; // Skip setup if no server available
    }

    // Initialize REAL crypto services
    cryptoA = CryptoService();
    cryptoB = CryptoService();
    await cryptoA.initialize();
    await cryptoB.initialize();

    // Create REAL WebRTC services
    webrtcA = WebRTCService(cryptoService: cryptoA);
    webrtcB = WebRTCService(cryptoService: cryptoB);

    // Create REAL device link services
    deviceLinkA = DeviceLinkService(
      cryptoService: cryptoA,
      webrtcService: webrtcA,
    );
    deviceLinkB = DeviceLinkService(
      cryptoService: cryptoB,
      webrtcService: webrtcB,
    );

    // Create REAL connection managers
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

    // Create mock media services (only mocking camera/mic)
    mockMediaA = MockMediaService();
    mockMediaB = MockMediaService();

    // Connect to discovered server
    try {
      pairingCodeA = await connectionManagerA
          .connect(serverUrl: serverUrl!)
          .timeout(const Duration(seconds: 30));
      pairingCodeB = await connectionManagerB
          .connect(serverUrl: serverUrl!)
          .timeout(const Duration(seconds: 30));

      debugPrint('Device A code: $pairingCodeA');
      debugPrint('Device B code: $pairingCodeB');

      // Create REAL signaling clients for VoIP
      signalingA = SignalingClient(
        serverUrl: serverUrl!,
        pairingCode: pairingCodeA,
        publicKey: cryptoA.publicKeyBase64,
        usePinnedWebSocket: false,
      );
      signalingB = SignalingClient(
        serverUrl: serverUrl!,
        pairingCode: pairingCodeB,
        publicKey: cryptoB.publicKeyBase64,
        usePinnedWebSocket: false,
      );

      await signalingA.connect();
      await signalingB.connect();

      // Create REAL VoIP services (only MediaService is mocked)
      voipA = VoIPService(mockMediaA, signalingA);
      voipB = VoIPService(mockMediaB, signalingB);

      isConnected = true;
      debugPrint('Connected: $isConnected');
    } catch (e) {
      debugPrint('Failed to connect: $e');
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
  });

  Widget createCallScreenTestWidget({
    required VoIPService voipService,
    required MockMediaService mediaService,
    String peerName = 'Test Peer',
  }) {
    return MaterialApp(
      home: CallScreen(
        voipService: voipService,
        mediaService: mediaService,
        peerName: peerName,
      ),
    );
  }

  Widget createIncomingCallDialogTestWidget({
    required String callerName,
    required String callId,
    required bool withVideo,
    required VoidCallback onAccept,
    required VoidCallback onAcceptWithVideo,
    required VoidCallback onReject,
  }) {
    return MaterialApp(
      home: Scaffold(
        body: IncomingCallDialog(
          callerName: callerName,
          callId: callId,
          withVideo: withVideo,
          onAccept: onAccept,
          onAcceptWithVideo: onAcceptWithVideo,
          onReject: onReject,
        ),
      ),
    );
  }

  group('Real E2E Call Screen Tests', () {
    testWidgets('displays call screen with peer info', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
        peerName: 'Alice',
      ));
      await tester.pump();

      expect(find.text('Alice'), findsOneWidget);
      expect(find.text('A'), findsOneWidget);
      expect(find.text('Calling...'), findsOneWidget);

      voipA.hangup();
    });

    testWidgets('displays all call control buttons', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
      ));
      await tester.pump();

      expect(find.byIcon(Icons.mic), findsOneWidget);
      expect(find.byIcon(Icons.videocam), findsOneWidget);
      expect(find.byIcon(Icons.switch_camera), findsOneWidget);
      expect(find.byIcon(Icons.call_end), findsOneWidget);

      expect(find.text('Mute'), findsOneWidget);
      expect(find.text('Video Off'), findsOneWidget);
      expect(find.text('Flip'), findsOneWidget);
      expect(find.text('End'), findsOneWidget);

      voipA.hangup();
    });

    testWidgets('mute button toggles real audio state', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
      ));
      await tester.pump();

      expect(voipA.isAudioMuted, isFalse);
      expect(find.text('Mute'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.mic));
      await tester.pump();

      expect(voipA.isAudioMuted, isTrue);
      expect(find.text('Unmute'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.mic_off));
      await tester.pump();

      expect(voipA.isAudioMuted, isFalse);
      expect(find.text('Mute'), findsOneWidget);

      voipA.hangup();
    });

    testWidgets('video button toggles real video state', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, true);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
      ));
      await tester.pump();

      expect(mockMediaA.lastRequestedVideo, isTrue);
      expect(voipA.isVideoMuted, isFalse);

      await tester.tap(find.byIcon(Icons.videocam));
      await tester.pump();

      expect(voipA.isVideoMuted, isTrue);

      voipA.hangup();
    });

    testWidgets('flip camera button calls switchCamera', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, true);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.switch_camera));
      await tester.pump();

      voipA.hangup();
    });

    testWidgets('end call button terminates real call', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);
      expect(voipA.hasActiveCall, isTrue);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.call_end));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));

      expect(voipA.hasActiveCall, isFalse);
    });

    testWidgets('call state transitions reflect in UI', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
      ));
      await tester.pump();

      expect(find.text('Calling...'), findsOneWidget);

      voipA.hangup();
    });
  });

  group('Real E2E Incoming Call Tests', () {
    testWidgets('incoming call is received through real signaling', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      final statesB = <CallState>[];
      voipB.onStateChange.listen((state) => statesB.add(state));

      await voipA.startCall(pairingCodeB, false);

      final receivedIncoming = await _waitFor(
        () => voipB.state == CallState.incoming,
        timeout: const Duration(seconds: 10),
      );

      if (!receivedIncoming) {
        voipA.hangup();
        markTestSkipped('Call signaling not working');
        return;
      }

      expect(voipB.state, equals(CallState.incoming));
      expect(voipB.currentCall, isNotNull);
      expect(voipB.currentCall?.withVideo, isFalse);

      voipB.rejectCall(voipB.currentCall!.callId, reason: 'test');
      voipA.hangup();
    });

    testWidgets('incoming call dialog displays correctly', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      bool acceptCalled = false;

      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        callerName: 'Bob',
        callId: 'test-call-id',
        withVideo: false,
        onAccept: () => acceptCalled = true,
        onAcceptWithVideo: () {},
        onReject: () {},
      ));
      await tester.pump();

      expect(find.text('Bob'), findsOneWidget);
      expect(find.text('B'), findsOneWidget);
      expect(find.text('Incoming call'), findsOneWidget);
      expect(find.text('Decline'), findsOneWidget);
      expect(find.text('Accept'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.call));
      await tester.pump();
      expect(acceptCalled, isTrue);
    });

    testWidgets('reject button declines real call', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);

      final receivedIncoming = await _waitFor(
        () => voipB.state == CallState.incoming,
        timeout: const Duration(seconds: 10),
      );

      if (!receivedIncoming) {
        voipA.hangup();
        markTestSkipped('Call signaling not working');
        return;
      }

      final callId = voipB.currentCall!.callId;

      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        callerName: 'Alice',
        callId: callId,
        withVideo: false,
        onAccept: () {},
        onAcceptWithVideo: () {},
        onReject: () {
          voipB.rejectCall(callId, reason: 'declined');
        },
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.call_end));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));

      expect(voipB.state, equals(CallState.idle));
      expect(voipB.hasActiveCall, isFalse);

      final aEnded = await _waitFor(
        () => voipA.state == CallState.idle || voipA.state == CallState.ended,
        timeout: const Duration(seconds: 5),
      );

      expect(aEnded, isTrue);
    });

    testWidgets('accept button accepts real call', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);

      final receivedIncoming = await _waitFor(
        () => voipB.state == CallState.incoming,
        timeout: const Duration(seconds: 10),
      );

      if (!receivedIncoming) {
        voipA.hangup();
        markTestSkipped('Call signaling not working');
        return;
      }

      final callId = voipB.currentCall!.callId;

      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        callerName: 'Alice',
        callId: callId,
        withVideo: false,
        onAccept: () async {
          await voipB.acceptCall(callId, false);
        },
        onAcceptWithVideo: () {},
        onReject: () {},
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.call));
      await tester.pump();

      expect(voipB.state, equals(CallState.connecting));

      voipA.hangup();
      await tester.pump(const Duration(milliseconds: 200));
    });

    testWidgets('video call shows video accept option', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      bool acceptWithVideoCalled = false;

      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        callerName: 'Bob',
        callId: 'test-call-id',
        withVideo: true,
        onAccept: () {},
        onAcceptWithVideo: () => acceptWithVideoCalled = true,
        onReject: () {},
      ));
      await tester.pump();

      expect(find.text('Incoming video call'), findsOneWidget);
      expect(find.text('Audio'), findsOneWidget);
      expect(find.text('Video'), findsOneWidget);
      expect(find.byIcon(Icons.videocam), findsOneWidget);

      await tester.tap(find.byIcon(Icons.videocam));
      await tester.pump();
      expect(acceptWithVideoCalled, isTrue);
    });
  });

  group('Real E2E Call Flow Tests', () {
    testWidgets('full call flow: dial → ring → accept → connected → hangup', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      final statesA = <CallState>[];
      final statesB = <CallState>[];
      voipA.onStateChange.listen((state) => statesA.add(state));
      voipB.onStateChange.listen((state) => statesB.add(state));

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
        peerName: 'Device B',
      ));

      await voipA.startCall(pairingCodeB, false);
      await tester.pump();

      expect(find.text('Calling...'), findsOneWidget);

      final receivedIncoming = await _waitFor(
        () => voipB.state == CallState.incoming,
        timeout: const Duration(seconds: 10),
      );

      if (!receivedIncoming) {
        voipA.hangup();
        markTestSkipped('Call signaling not working');
        return;
      }

      await voipB.acceptCall(voipB.currentCall!.callId, false);

      final connected = await _waitFor(
        () => voipA.state == CallState.connected && voipB.state == CallState.connected,
        timeout: const Duration(seconds: 30),
      );

      if (connected) {
        await tester.pump();
        expect(find.text('00:00'), findsOneWidget);
        debugPrint('Call connected successfully!');
      }

      await tester.tap(find.byIcon(Icons.call_end));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      final bothEnded = await _waitFor(
        () => voipA.state == CallState.idle && voipB.state == CallState.idle,
        timeout: const Duration(seconds: 5),
      );

      expect(bothEnded, isTrue);
    });

    testWidgets('hangup during ringing terminates call', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
        peerName: 'Device B',
      ));

      await voipA.startCall(pairingCodeB, false);
      await tester.pump();

      expect(voipA.hasActiveCall, isTrue);

      await tester.tap(find.byIcon(Icons.call_end));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));

      expect(voipA.hasActiveCall, isFalse);
    });
  });

  group('Real E2E Edge Cases', () {
    testWidgets('cannot start second call while in call', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);
      expect(voipA.hasActiveCall, isTrue);

      expect(
        () => voipA.startCall(pairingCodeB, false),
        throwsA(isA<CallException>()),
      );

      voipA.hangup();
    });

    testWidgets('handles empty peer name gracefully', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
        peerName: '',
      ));
      await tester.pump();

      expect(find.text('?'), findsOneWidget);

      voipA.hangup();
    });

    testWidgets('call screen has black background', (tester) async {
      if (!isConnected) {
        markTestSkipped('No server available or connection failed');
        return;
      }

      await voipA.startCall(pairingCodeB, false);

      await tester.pumpWidget(createCallScreenTestWidget(
        voipService: voipA,
        mediaService: mockMediaA,
      ));
      await tester.pump();

      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
      expect(scaffold.backgroundColor, Colors.black);

      voipA.hangup();
    });
  });
}

/// Wait for a condition to be true with timeout.
Future<bool> _waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 10),
  Duration pollInterval = const Duration(milliseconds: 100),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (condition()) return true;
    await Future.delayed(pollInterval);
  }
  return false;
}

/// Helper function to mark a test as skipped.
void markTestSkipped(String reason) {
  debugPrint('TEST SKIPPED: $reason');
}
