import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/call/incoming_call_dialog.dart';

void main() {
  group('IncomingCallDialog', () {
    Widget createTestWidget({
      String callerName = 'John Doe',
      String? callerAvatar,
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
            callerAvatar: callerAvatar,
            callId: callId,
            withVideo: withVideo,
            onAccept: onAccept ?? () {},
            onAcceptWithVideo: onAcceptWithVideo ?? () {},
            onReject: onReject ?? () {},
          ),
        ),
      );
    }

    testWidgets('displays caller name', (tester) async {
      await tester.pumpWidget(createTestWidget(callerName: 'Alice'));
      await tester.pump();

      expect(find.text('Alice'), findsOneWidget);
    });

    testWidgets('displays caller initial when no avatar', (tester) async {
      await tester.pumpWidget(createTestWidget(callerName: 'Bob'));
      await tester.pump();

      // CircleAvatar should show 'B' as the initial
      expect(find.text('B'), findsOneWidget);
    });

    testWidgets('displays "Incoming call" for audio calls', (tester) async {
      await tester.pumpWidget(createTestWidget(withVideo: false));
      await tester.pump();

      expect(find.text('Incoming call'), findsOneWidget);
    });

    testWidgets('displays "Incoming video call" for video calls',
        (tester) async {
      await tester.pumpWidget(createTestWidget(withVideo: true));
      await tester.pump();

      expect(find.text('Incoming video call'), findsOneWidget);
    });

    testWidgets('displays Decline button', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Decline'), findsOneWidget);
      expect(find.byIcon(Icons.call_end), findsOneWidget);
    });

    testWidgets('displays Accept button for audio calls', (tester) async {
      await tester.pumpWidget(createTestWidget(withVideo: false));
      await tester.pump();

      expect(find.text('Accept'), findsOneWidget);
      expect(find.byIcon(Icons.call), findsOneWidget);
    });

    testWidgets('displays Audio and Video buttons for video calls',
        (tester) async {
      await tester.pumpWidget(createTestWidget(withVideo: true));
      await tester.pump();

      expect(find.text('Audio'), findsOneWidget);
      expect(find.text('Video'), findsOneWidget);
      expect(find.byIcon(Icons.call), findsOneWidget);
      expect(find.byIcon(Icons.videocam), findsOneWidget);
    });

    testWidgets('calls onReject when Decline is pressed', (tester) async {
      bool rejectCalled = false;
      await tester.pumpWidget(createTestWidget(
        onReject: () => rejectCalled = true,
      ));
      await tester.pump();

      // Find the FAB with call_end icon and tap it
      await tester.tap(find.byIcon(Icons.call_end));
      await tester.pump();

      expect(rejectCalled, isTrue);
    });

    testWidgets('calls onAccept when Accept is pressed for audio call',
        (tester) async {
      bool acceptCalled = false;
      await tester.pumpWidget(createTestWidget(
        withVideo: false,
        onAccept: () => acceptCalled = true,
      ));
      await tester.pump();

      // Find the FAB with call icon and tap it
      await tester.tap(find.byIcon(Icons.call));
      await tester.pump();

      expect(acceptCalled, isTrue);
    });

    testWidgets('calls onAccept when Audio is pressed for video call',
        (tester) async {
      bool acceptCalled = false;
      await tester.pumpWidget(createTestWidget(
        withVideo: true,
        onAccept: () => acceptCalled = true,
      ));
      await tester.pump();

      // Find the FAB with call icon (Audio button) and tap it
      await tester.tap(find.byIcon(Icons.call));
      await tester.pump();

      expect(acceptCalled, isTrue);
    });

    testWidgets('calls onAcceptWithVideo when Video is pressed',
        (tester) async {
      bool acceptWithVideoCalled = false;
      await tester.pumpWidget(createTestWidget(
        withVideo: true,
        onAcceptWithVideo: () => acceptWithVideoCalled = true,
      ));
      await tester.pump();

      // Find the FAB with videocam icon and tap it
      await tester.tap(find.byIcon(Icons.videocam));
      await tester.pump();

      expect(acceptWithVideoCalled, isTrue);
    });

    testWidgets('handles empty caller name gracefully', (tester) async {
      await tester.pumpWidget(createTestWidget(callerName: ''));
      await tester.pump();

      // Should show '?' for empty name
      expect(find.text('?'), findsOneWidget);
    });

    testWidgets('has themed surface dialog background', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      final dialog = tester.widget<Dialog>(find.byType(Dialog));
      // Dialog uses theme surface color instead of transparent to avoid
      // GTK compositor issues on Linux desktop
      expect(dialog.backgroundColor, isNot(Colors.transparent));
      expect(dialog.backgroundColor, isNotNull);
    });
  });
}
