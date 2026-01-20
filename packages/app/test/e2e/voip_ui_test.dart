/// E2E widget tests for VoIP UI functionality.
///
/// These tests verify the VoIP call flow from the user interface:
/// - Call screen display states
/// - Incoming call dialog display and interaction
/// - In-call controls (mute, video toggle, hangup)
/// - Call state transitions
///
/// Run with:
/// ```bash
/// flutter test test/e2e/voip_ui_test.dart
/// ```
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:mocktail/mocktail.dart';

import 'package:zajel/core/media/media_service.dart';
import 'package:zajel/core/network/voip_service.dart';
import 'package:zajel/features/call/call_screen.dart';
import 'package:zajel/features/call/incoming_call_dialog.dart';

// Mock classes
class MockVoIPService extends Mock implements VoIPService {}

class MockMediaService extends Mock implements MediaService {}

class MockMediaStream extends Mock implements MediaStream {}

void main() {
  late MockVoIPService mockVoIPService;
  late MockMediaService mockMediaService;
  late StreamController<CallState> stateController;
  late StreamController<MediaStream> remoteStreamController;

  setUpAll(() async {
    // Register fallback values for mocktail
    registerFallbackValue(CallState.idle);
  });

  setUp(() async {
    mockVoIPService = MockVoIPService();
    mockMediaService = MockMediaService();
    stateController = StreamController<CallState>.broadcast();
    remoteStreamController = StreamController<MediaStream>.broadcast();

    // Default setup for VoIPService
    when(() => mockVoIPService.state).thenReturn(CallState.idle);
    when(() => mockVoIPService.onStateChange)
        .thenAnswer((_) => stateController.stream);
    when(() => mockVoIPService.onRemoteStream)
        .thenAnswer((_) => remoteStreamController.stream);
    when(() => mockVoIPService.addListener(any())).thenReturn(null);
    when(() => mockVoIPService.removeListener(any())).thenReturn(null);
    when(() => mockVoIPService.toggleMute()).thenReturn(true);
    when(() => mockVoIPService.toggleVideo()).thenReturn(false);
    when(() => mockVoIPService.switchCamera()).thenAnswer((_) async {});
    when(() => mockVoIPService.hangup()).thenReturn(null);
    when(() => mockVoIPService.currentCall).thenReturn(null);
    when(() => mockVoIPService.hasActiveCall).thenReturn(false);
    when(() => mockVoIPService.isAudioMuted).thenReturn(false);
    when(() => mockVoIPService.isVideoMuted).thenReturn(true);
    when(() => mockVoIPService.startCall(any(), any()))
        .thenAnswer((_) async => 'test-call-id');
    when(() => mockVoIPService.acceptCall(any(), any()))
        .thenAnswer((_) async {});
    when(() => mockVoIPService.rejectCall(any(), reason: any(named: 'reason')))
        .thenReturn(null);

    // Default setup for MediaService
    when(() => mockMediaService.localStream).thenReturn(null);
  });

  tearDown(() {
    stateController.close();
    remoteStreamController.close();
  });

  Widget createCallScreenTestWidget({
    VoIPService? voipService,
    MediaService? mediaService,
    String peerName = 'Test Peer',
  }) {
    return MaterialApp(
      home: CallScreen(
        voipService: voipService ?? mockVoIPService,
        mediaService: mediaService ?? mockMediaService,
        peerName: peerName,
      ),
    );
  }

  Widget createIncomingCallDialogTestWidget({
    String callerName = 'John Doe',
    String callId = 'test-call-id',
    bool withVideo = false,
    VoidCallback? onAccept,
    VoidCallback? onAcceptWithVideo,
    VoidCallback? onReject,
  }) {
    return MaterialApp(
      home: Scaffold(
        body: IncomingCallDialog(
          callerName: callerName,
          callId: callId,
          withVideo: withVideo,
          onAccept: onAccept ?? () {},
          onAcceptWithVideo: onAcceptWithVideo ?? () {},
          onReject: onReject ?? () {},
        ),
      ),
    );
  }

  group('Call Screen Display Tests', () {
    testWidgets('displays peer name and initial avatar', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.outgoing);

      await tester.pumpWidget(createCallScreenTestWidget(peerName: 'Alice'));
      await tester.pump();

      expect(find.text('Alice'), findsOneWidget);
      expect(find.text('A'), findsOneWidget); // Initial in avatar
    });

    testWidgets('displays "Calling..." for outgoing call state', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.outgoing);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      expect(find.text('Calling...'), findsOneWidget);
    });

    testWidgets('displays "Connecting..." for connecting state', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connecting);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      expect(find.text('Connecting...'), findsOneWidget);
    });

    testWidgets('displays "Incoming call..." for incoming state', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.incoming);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      expect(find.text('Incoming call...'), findsOneWidget);
    });

    testWidgets('displays duration timer when connected', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      // Initial duration should be 00:00
      expect(find.text('00:00'), findsOneWidget);
    });

    testWidgets('duration timer increments when connected', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.outgoing);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      // Simulate state change to connected
      when(() => mockVoIPService.state).thenReturn(CallState.connected);
      stateController.add(CallState.connected);
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));

      // Duration should have increased
      expect(find.text('00:02'), findsOneWidget);
    });
  });

  group('Call Screen Control Tests', () {
    testWidgets('displays all control buttons', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      // Check for control labels
      expect(find.text('Mute'), findsOneWidget);
      expect(find.text('Video Off'), findsOneWidget);
      expect(find.text('Flip'), findsOneWidget);
      expect(find.text('End'), findsOneWidget);
    });

    testWidgets('displays control icons', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      expect(find.byIcon(Icons.mic), findsOneWidget);
      expect(find.byIcon(Icons.videocam), findsOneWidget);
      expect(find.byIcon(Icons.switch_camera), findsOneWidget);
      expect(find.byIcon(Icons.call_end), findsOneWidget);
    });

    testWidgets('mute button toggles and updates label', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      // Initial state should show 'Mute'
      expect(find.text('Mute'), findsOneWidget);

      // Toggle mute by tapping the mic icon
      await tester.tap(find.byIcon(Icons.mic));
      await tester.pump();

      verify(() => mockVoIPService.toggleMute()).called(1);
      // After mute, should show 'Unmute'
      expect(find.text('Unmute'), findsOneWidget);
    });

    testWidgets('video button toggles and updates label', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);
      when(() => mockVoIPService.toggleVideo()).thenReturn(true);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      // Initial state should show 'Video Off'
      expect(find.text('Video Off'), findsOneWidget);

      // Toggle video by tapping the videocam icon
      await tester.tap(find.byIcon(Icons.videocam));
      await tester.pump();

      verify(() => mockVoIPService.toggleVideo()).called(1);
    });

    testWidgets('flip camera button calls switchCamera', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      await tester.tap(find.byIcon(Icons.switch_camera));
      await tester.pump();

      verify(() => mockVoIPService.switchCamera()).called(1);
    });

    testWidgets('end call button calls hangup', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      await tester.tap(find.byIcon(Icons.call_end));
      await tester.pump();

      verify(() => mockVoIPService.hangup()).called(1);
    });
  });

  group('Call State Transitions', () {
    testWidgets('screen pops when call state becomes ended', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.outgoing);

      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => CallScreen(
                    voipService: mockVoIPService,
                    mediaService: mockMediaService,
                    peerName: 'Test',
                  ),
                ),
              );
            },
            child: const Text('Open Call'),
          ),
        ),
      ));

      // Navigate to call screen
      await tester.tap(find.text('Open Call'));
      await tester.pumpAndSettle();

      // Verify we're on the call screen
      expect(find.byType(CallScreen), findsOneWidget);

      // Simulate call ended
      when(() => mockVoIPService.state).thenReturn(CallState.ended);
      stateController.add(CallState.ended);
      await tester.pumpAndSettle();

      // Should have popped back
      expect(find.byType(CallScreen), findsNothing);
    });
  });

  group('Incoming Call Dialog Tests', () {
    testWidgets('displays caller name and initial', (tester) async {
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        callerName: 'Alice',
      ));
      await tester.pump();

      expect(find.text('Alice'), findsOneWidget);
      expect(find.text('A'), findsOneWidget); // Initial in avatar
    });

    testWidgets('displays "Incoming call" for audio calls', (tester) async {
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        withVideo: false,
      ));
      await tester.pump();

      expect(find.text('Incoming call'), findsOneWidget);
    });

    testWidgets('displays "Incoming video call" for video calls', (tester) async {
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        withVideo: true,
      ));
      await tester.pump();

      expect(find.text('Incoming video call'), findsOneWidget);
    });

    testWidgets('shows Decline and Accept buttons for audio call', (tester) async {
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        withVideo: false,
      ));
      await tester.pump();

      expect(find.text('Decline'), findsOneWidget);
      expect(find.text('Accept'), findsOneWidget);
      expect(find.byIcon(Icons.call_end), findsOneWidget);
      expect(find.byIcon(Icons.call), findsOneWidget);
    });

    testWidgets('shows Audio and Video buttons for video call', (tester) async {
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        withVideo: true,
      ));
      await tester.pump();

      expect(find.text('Decline'), findsOneWidget);
      expect(find.text('Audio'), findsOneWidget);
      expect(find.text('Video'), findsOneWidget);
      expect(find.byIcon(Icons.call_end), findsOneWidget);
      expect(find.byIcon(Icons.call), findsOneWidget);
      expect(find.byIcon(Icons.videocam), findsOneWidget);
    });

    testWidgets('Decline button calls onReject callback', (tester) async {
      bool rejectCalled = false;
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        onReject: () => rejectCalled = true,
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.call_end));
      await tester.pump();

      expect(rejectCalled, isTrue);
    });

    testWidgets('Accept button calls onAccept for audio call', (tester) async {
      bool acceptCalled = false;
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        withVideo: false,
        onAccept: () => acceptCalled = true,
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.call));
      await tester.pump();

      expect(acceptCalled, isTrue);
    });

    testWidgets('Audio button calls onAccept for video call', (tester) async {
      bool acceptCalled = false;
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        withVideo: true,
        onAccept: () => acceptCalled = true,
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.call));
      await tester.pump();

      expect(acceptCalled, isTrue);
    });

    testWidgets('Video button calls onAcceptWithVideo', (tester) async {
      bool acceptWithVideoCalled = false;
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        withVideo: true,
        onAcceptWithVideo: () => acceptWithVideoCalled = true,
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.videocam));
      await tester.pump();

      expect(acceptWithVideoCalled, isTrue);
    });

    testWidgets('handles empty caller name gracefully', (tester) async {
      await tester.pumpWidget(createIncomingCallDialogTestWidget(
        callerName: '',
      ));
      await tester.pump();

      // Should show '?' for empty name
      expect(find.text('?'), findsOneWidget);
    });
  });

  group('Call Screen Edge Cases', () {
    testWidgets('handles empty peer name gracefully', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.outgoing);

      await tester.pumpWidget(createCallScreenTestWidget(peerName: ''));
      await tester.pump();

      // Should show '?' for empty name
      expect(find.text('?'), findsOneWidget);
    });

    testWidgets('has black background', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
      expect(scaffold.backgroundColor, Colors.black);
    });

    testWidgets('displays back button', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      expect(find.byIcon(Icons.arrow_back), findsOneWidget);
    });

    testWidgets('displays "Call ended" for ended state', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.ended);

      await tester.pumpWidget(createCallScreenTestWidget());
      await tester.pump();

      expect(find.text('Call ended'), findsOneWidget);
    });
  });
}
