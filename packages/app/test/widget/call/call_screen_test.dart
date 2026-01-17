import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/media/media_service.dart';
import 'package:zajel/core/network/voip_service.dart';
import 'package:zajel/features/call/call_screen.dart';

class MockVoIPService extends Mock implements VoIPService {}

class MockMediaService extends Mock implements MediaService {}

class MockMediaStream extends Mock implements MediaStream {}

void main() {
  late MockVoIPService mockVoIPService;
  late MockMediaService mockMediaService;
  late StreamController<CallState> stateController;
  late StreamController<MediaStream> remoteStreamController;

  setUp(() {
    mockVoIPService = MockVoIPService();
    mockMediaService = MockMediaService();
    stateController = StreamController<CallState>.broadcast();
    remoteStreamController = StreamController<MediaStream>.broadcast();

    // Default setup for VoIPService
    when(() => mockVoIPService.state).thenReturn(CallState.outgoing);
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

    // Default setup for MediaService
    when(() => mockMediaService.localStream).thenReturn(null);
  });

  tearDown(() {
    stateController.close();
    remoteStreamController.close();
  });

  Widget createTestWidget({
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

  group('CallScreen', () {
    testWidgets('displays peer name in avatar placeholder', (tester) async {
      await tester.pumpWidget(createTestWidget(peerName: 'Alice'));
      await tester.pump();

      expect(find.text('Alice'), findsOneWidget);
      expect(find.text('A'), findsOneWidget); // Initial in avatar
    });

    testWidgets('displays "Calling..." for outgoing call state',
        (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.outgoing);

      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Calling...'), findsOneWidget);
    });

    testWidgets('displays "Connecting..." for connecting state',
        (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connecting);

      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Connecting...'), findsOneWidget);
    });

    testWidgets('displays duration for connected state', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.connected);

      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Initial duration should be 00:00
      expect(find.text('00:00'), findsOneWidget);
    });

    testWidgets('increments duration timer when connected', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.outgoing);

      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Simulate state change to connected
      when(() => mockVoIPService.state).thenReturn(CallState.connected);
      stateController.add(CallState.connected);
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));

      // Duration should have increased
      expect(find.text('00:02'), findsOneWidget);
    });

    testWidgets('displays control buttons', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Check for control labels
      expect(find.text('Mute'), findsOneWidget);
      expect(find.text('Video Off'), findsOneWidget);
      expect(find.text('Flip'), findsOneWidget);
      expect(find.text('End'), findsOneWidget);
    });

    testWidgets('displays control icons', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.byIcon(Icons.mic), findsOneWidget);
      expect(find.byIcon(Icons.videocam), findsOneWidget);
      expect(find.byIcon(Icons.switch_camera), findsOneWidget);
      expect(find.byIcon(Icons.call_end), findsOneWidget);
    });

    testWidgets('calls toggleMute when mute button is pressed', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Find the FAB with mic icon and tap it
      await tester.tap(find.byIcon(Icons.mic));
      await tester.pump();

      verify(() => mockVoIPService.toggleMute()).called(1);
    });

    testWidgets('calls toggleVideo when video button is pressed',
        (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Find the FAB with videocam icon and tap it
      await tester.tap(find.byIcon(Icons.videocam));
      await tester.pump();

      verify(() => mockVoIPService.toggleVideo()).called(1);
    });

    testWidgets('calls switchCamera when flip button is pressed',
        (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Find the FAB with switch_camera icon and tap it
      await tester.tap(find.byIcon(Icons.switch_camera));
      await tester.pump();

      verify(() => mockVoIPService.switchCamera()).called(1);
    });

    testWidgets('calls hangup when end button is pressed', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Find the FAB with call_end icon and tap it
      await tester.tap(find.byIcon(Icons.call_end));
      await tester.pump();

      verify(() => mockVoIPService.hangup()).called(1);
    });

    testWidgets('updates mute button label after toggling', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Initial state should show 'Mute'
      expect(find.text('Mute'), findsOneWidget);

      // Toggle mute by tapping the mic icon
      await tester.tap(find.byIcon(Icons.mic));
      await tester.pump();

      // After mute, should show 'Unmute'
      expect(find.text('Unmute'), findsOneWidget);
    });

    testWidgets('updates video button label after toggling', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Initial state should show 'Video Off'
      expect(find.text('Video Off'), findsOneWidget);

      // Toggle video by tapping the videocam icon
      await tester.tap(find.byIcon(Icons.videocam));
      await tester.pump();

      // After toggle, should show 'Video On'
      expect(find.text('Video On'), findsOneWidget);
    });

    testWidgets('displays back button', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.byIcon(Icons.arrow_back), findsOneWidget);
    });

    testWidgets('has black background', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
      expect(scaffold.backgroundColor, Colors.black);
    });

    testWidgets('pops screen when call state becomes ended', (tester) async {
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

    testWidgets('handles empty peer name gracefully', (tester) async {
      await tester.pumpWidget(createTestWidget(peerName: ''));
      await tester.pump();

      // Should show '?' for empty name
      expect(find.text('?'), findsOneWidget);
    });

    testWidgets('displays "Incoming call..." for incoming state',
        (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.incoming);

      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Incoming call...'), findsOneWidget);
    });

    testWidgets('displays "Call ended" for ended state', (tester) async {
      when(() => mockVoIPService.state).thenReturn(CallState.ended);

      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Call ended'), findsOneWidget);
    });
  });
}
