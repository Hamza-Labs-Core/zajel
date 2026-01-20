/// E2E widget tests for Chat UI functionality.
///
/// These tests verify the chat messaging flow from the user interface:
/// - Chat screen display with peer info
/// - Empty state with encryption info
/// - Message sending and receiving
/// - Message bubbles styling
/// - File attachment UI
/// - Call buttons in chat
///
/// Run with:
/// ```bash
/// flutter test test/e2e/chat_ui_test.dart
/// ```
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' hide MessageType;
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/media/media_service.dart';
import 'package:zajel/core/models/models.dart';
import 'package:zajel/core/network/connection_manager.dart';
import 'package:zajel/core/network/voip_service.dart';
import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/features/chat/chat_screen.dart';

// Mock classes
class MockConnectionManager extends Mock implements ConnectionManager {}

class MockVoIPService extends Mock implements VoIPService {}

class MockMediaService extends Mock implements MediaService {}

void main() {
  late MockConnectionManager mockConnectionManager;
  late MockVoIPService mockVoIPService;
  late MockMediaService mockMediaService;
  late StreamController<(String, String)> messagesController;
  late StreamController<List<Peer>> peersController;
  late StreamController<CallState> callStateController;
  late StreamController<MediaStream> remoteStreamController;
  late SharedPreferences prefs;

  const testPeerId = 'test-peer-123';
  final testPeer = Peer(
    id: testPeerId,
    displayName: 'Alice',
    connectionState: PeerConnectionState.connected,
    lastSeen: DateTime.now(),
    ipAddress: '192.168.1.100',
    isLocal: true,
  );

  setUpAll(() async {
    // Register fallback values for mocktail
    registerFallbackValue(CallState.idle);
    registerFallbackValue(Uint8List(0));
  });

  setUp(() async {
    mockConnectionManager = MockConnectionManager();
    mockVoIPService = MockVoIPService();
    mockMediaService = MockMediaService();
    messagesController = StreamController<(String, String)>.broadcast();
    peersController = StreamController<List<Peer>>.broadcast();
    callStateController = StreamController<CallState>.broadcast();
    remoteStreamController = StreamController<MediaStream>.broadcast();

    // Set up mock initial values
    SharedPreferences.setMockInitialValues({
      'displayName': 'Test User',
    });
    prefs = await SharedPreferences.getInstance();

    // Setup ConnectionManager mock
    when(() => mockConnectionManager.messages)
        .thenAnswer((_) => messagesController.stream);
    when(() => mockConnectionManager.peers)
        .thenAnswer((_) => peersController.stream);
    when(() => mockConnectionManager.sendMessage(any(), any()))
        .thenAnswer((_) async {});
    when(() => mockConnectionManager.sendFile(any(), any(), any()))
        .thenAnswer((_) async {});

    // Setup VoIPService mock
    when(() => mockVoIPService.state).thenReturn(CallState.idle);
    when(() => mockVoIPService.onStateChange)
        .thenAnswer((_) => callStateController.stream);
    when(() => mockVoIPService.onRemoteStream)
        .thenAnswer((_) => remoteStreamController.stream);
    when(() => mockVoIPService.currentCall).thenReturn(null);
    when(() => mockVoIPService.startCall(any(), any()))
        .thenAnswer((_) async => 'test-call-id');

    // Setup MediaService mock
    when(() => mockMediaService.localStream).thenReturn(null);
  });

  tearDown(() {
    messagesController.close();
    peersController.close();
    callStateController.close();
    remoteStreamController.close();
  });

  Widget createChatScreenTestWidget({
    required String peerId,
    Peer? selectedPeer,
    List<Message>? initialMessages,
  }) {
    return ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        connectionManagerProvider.overrideWithValue(mockConnectionManager),
        voipServiceProvider.overrideWith((ref) => mockVoIPService),
        mediaServiceProvider.overrideWith((ref) => mockMediaService),
        selectedPeerProvider.overrideWith((ref) => selectedPeer),
        if (initialMessages != null)
          chatMessagesProvider(peerId).overrideWith(
            (ref) {
              final notifier = ChatMessagesNotifier(peerId);
              for (final msg in initialMessages) {
                notifier.addMessage(msg);
              }
              return notifier;
            },
          ),
      ],
      child: MaterialApp(
        home: ChatScreen(peerId: peerId),
      ),
    );
  }

  group('Chat Screen Display Tests', () {
    testWidgets('displays peer name in AppBar', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.text('Alice'), findsOneWidget);
    });

    testWidgets('displays peer initial in avatar', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.text('A'), findsOneWidget);
    });

    testWidgets('displays connection status for connected peer', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.text('Connected - E2E Encrypted'), findsOneWidget);
    });

    testWidgets('displays "Connecting..." for connecting peer', (tester) async {
      final connectingPeer = testPeer.copyWith(
        connectionState: PeerConnectionState.connecting,
      );
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: connectingPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.text('Connecting...'), findsOneWidget);
    });

    testWidgets('displays "Unknown" for null peer', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: null,
      ));
      await tester.pumpAndSettle();

      // "Unknown" appears in both title and subtitle
      expect(find.text('Unknown'), findsWidgets);
    });

    testWidgets('displays "?" avatar for peer with empty name', (tester) async {
      final emptyNamePeer = testPeer.copyWith(displayName: '');
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: emptyNamePeer,
      ));
      await tester.pumpAndSettle();

      expect(find.text('?'), findsOneWidget);
    });
  });

  group('Empty State Tests', () {
    testWidgets('shows encryption info in empty state', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.text('End-to-End Encrypted'), findsOneWidget);
      expect(find.byIcon(Icons.lock_outline), findsOneWidget);
    });

    testWidgets('shows encryption description in empty state', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('Messages are encrypted using X25519'),
        findsOneWidget,
      );
    });
  });

  group('Message Input Tests', () {
    testWidgets('displays message input field', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Type a message...'), findsOneWidget);
    });

    testWidgets('displays send button', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.send), findsOneWidget);
    });

    testWidgets('displays attach file button', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.attach_file), findsOneWidget);
    });

    testWidgets('can enter text in message field', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      final textField = find.byType(TextField);
      await tester.enterText(textField, 'Hello, World!');
      await tester.pump();

      expect(find.text('Hello, World!'), findsOneWidget);
    });

    testWidgets('send button sends message when text is present', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      // Enter a message
      await tester.enterText(find.byType(TextField), 'Hello!');
      await tester.pump();

      // Tap send button
      await tester.tap(find.byIcon(Icons.send));
      await tester.pumpAndSettle();

      // Verify message was sent via connection manager
      verify(() => mockConnectionManager.sendMessage(testPeerId, 'Hello!'))
          .called(1);
    });

    testWidgets('send button does not send when text is empty', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      // Tap send without entering text
      await tester.tap(find.byIcon(Icons.send));
      await tester.pump();

      // Verify message was NOT sent
      verifyNever(() => mockConnectionManager.sendMessage(any(), any()));
    });

    testWidgets('text field clears after sending message', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      // Enter and send a message
      await tester.enterText(find.byType(TextField), 'Hello!');
      await tester.pump();
      await tester.tap(find.byIcon(Icons.send));
      await tester.pumpAndSettle();

      // Text field should be cleared (placeholder should be visible)
      expect(find.text('Type a message...'), findsOneWidget);
    });
  });

  group('Message List Tests', () {
    testWidgets('displays messages when present', (tester) async {
      final messages = [
        Message(
          localId: 'msg-1',
          peerId: testPeerId,
          content: 'Hello from Alice',
          timestamp: DateTime.now().subtract(const Duration(minutes: 5)),
          isOutgoing: false,
          status: MessageStatus.delivered,
        ),
        Message(
          localId: 'msg-2',
          peerId: testPeerId,
          content: 'Hello from me',
          timestamp: DateTime.now().subtract(const Duration(minutes: 4)),
          isOutgoing: true,
          status: MessageStatus.sent,
        ),
      ];

      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
        initialMessages: messages,
      ));
      await tester.pumpAndSettle();

      expect(find.text('Hello from Alice'), findsOneWidget);
      expect(find.text('Hello from me'), findsOneWidget);
    });

    testWidgets('outgoing messages show status indicator', (tester) async {
      final messages = [
        Message(
          localId: 'msg-1',
          peerId: testPeerId,
          content: 'Sent message',
          timestamp: DateTime.now(),
          isOutgoing: true,
          status: MessageStatus.sent,
        ),
      ];

      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
        initialMessages: messages,
      ));
      await tester.pumpAndSettle();

      // Single check mark for sent status
      expect(find.byIcon(Icons.check), findsOneWidget);
    });

    testWidgets('delivered messages show double check', (tester) async {
      final messages = [
        Message(
          localId: 'msg-1',
          peerId: testPeerId,
          content: 'Delivered message',
          timestamp: DateTime.now(),
          isOutgoing: true,
          status: MessageStatus.delivered,
        ),
      ];

      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
        initialMessages: messages,
      ));
      await tester.pumpAndSettle();

      // Double check mark for delivered status
      expect(find.byIcon(Icons.done_all), findsOneWidget);
    });

    testWidgets('failed messages show error icon', (tester) async {
      final messages = [
        Message(
          localId: 'msg-1',
          peerId: testPeerId,
          content: 'Failed message',
          timestamp: DateTime.now(),
          isOutgoing: true,
          status: MessageStatus.failed,
        ),
      ];

      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
        initialMessages: messages,
      ));
      await tester.pumpAndSettle();

      // Error icon for failed status
      expect(find.byIcon(Icons.error_outline), findsOneWidget);
    });

    testWidgets('messages display timestamps', (tester) async {
      final now = DateTime.now();
      final messages = [
        Message(
          localId: 'msg-1',
          peerId: testPeerId,
          content: 'Test message',
          timestamp: DateTime(now.year, now.month, now.day, 14, 30),
          isOutgoing: false,
          status: MessageStatus.delivered,
        ),
      ];

      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
        initialMessages: messages,
      ));
      await tester.pumpAndSettle();

      expect(find.text('14:30'), findsOneWidget);
    });

    testWidgets('displays date divider for messages on different days',
        (tester) async {
      final yesterday = DateTime.now().subtract(const Duration(days: 1));
      final messages = [
        Message(
          localId: 'msg-1',
          peerId: testPeerId,
          content: 'Old message',
          timestamp: yesterday,
          isOutgoing: false,
          status: MessageStatus.delivered,
        ),
        Message(
          localId: 'msg-2',
          peerId: testPeerId,
          content: 'New message',
          timestamp: DateTime.now(),
          isOutgoing: true,
          status: MessageStatus.sent,
        ),
      ];

      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
        initialMessages: messages,
      ));
      await tester.pumpAndSettle();

      // Should show "Yesterday" and "Today" dividers
      expect(find.text('Yesterday'), findsOneWidget);
      expect(find.text('Today'), findsOneWidget);
    });
  });

  group('File Message Tests', () {
    testWidgets('displays file message with file icon', (tester) async {
      final messages = [
        Message(
          localId: 'msg-1',
          peerId: testPeerId,
          content: 'Sending file: document.pdf',
          type: MessageType.file,
          timestamp: DateTime.now(),
          isOutgoing: true,
          status: MessageStatus.sent,
          attachmentName: 'document.pdf',
          attachmentSize: 1024 * 1024, // 1 MB
        ),
      ];

      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
        initialMessages: messages,
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.hourglass_empty), findsOneWidget);
      expect(find.text('document.pdf'), findsOneWidget);
      expect(find.text('1.0 MB'), findsOneWidget);
    });

    testWidgets('displays received file with open button', (tester) async {
      final messages = [
        Message(
          localId: 'msg-1',
          peerId: testPeerId,
          content: 'Received file: photo.jpg',
          type: MessageType.file,
          timestamp: DateTime.now(),
          isOutgoing: false,
          status: MessageStatus.delivered,
          attachmentName: 'photo.jpg',
          attachmentPath: '/path/to/photo.jpg',
          attachmentSize: 512 * 1024, // 512 KB
        ),
      ];

      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
        initialMessages: messages,
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.insert_drive_file), findsOneWidget);
      expect(find.byIcon(Icons.open_in_new), findsOneWidget);
      expect(find.text('photo.jpg'), findsOneWidget);
    });
  });

  group('Call Buttons Tests', () {
    testWidgets('displays voice call button in AppBar', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.call), findsOneWidget);
    });

    testWidgets('displays video call button in AppBar', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.videocam), findsOneWidget);
    });

    testWidgets('displays info button in AppBar', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.info_outline), findsOneWidget);
    });

    testWidgets('voice call button starts voice call', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      // Tap voice call button
      await tester.tap(find.byIcon(Icons.call));
      await tester.pump(); // Don't wait for navigation animations

      // Verify voice call was started (withVideo: false)
      verify(() => mockVoIPService.startCall(testPeerId, false)).called(1);
    });

    testWidgets('video call button starts video call', (tester) async {
      await tester.pumpWidget(createChatScreenTestWidget(
        peerId: testPeerId,
        selectedPeer: testPeer,
      ));
      await tester.pumpAndSettle();

      // Tap video call button
      await tester.tap(find.byIcon(Icons.videocam));
      await tester.pump(); // Don't wait for navigation animations

      // Verify video call was started (withVideo: true)
      verify(() => mockVoIPService.startCall(testPeerId, true)).called(1);
    });
  });

}
