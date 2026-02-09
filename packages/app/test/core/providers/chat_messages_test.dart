import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/models/message.dart';
import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/core/storage/message_storage.dart';

class MockMessageStorage extends Mock implements MessageStorage {}

void main() {
  late MockMessageStorage mockStorage;
  late ChatMessagesNotifier notifier;
  const peerId = 'peer-abc';

  final testDate = DateTime(2024, 6, 1, 12, 0);

  setUpAll(() {
    registerFallbackValue(Message(
      localId: 'fallback',
      peerId: 'fallback',
      content: '',
      timestamp: DateTime(2000),
      isOutgoing: true,
    ));
    registerFallbackValue(MessageStatus.pending);
  });

  Message makeMessage({
    String? localId,
    String? content,
    String? peer,
    DateTime? timestamp,
  }) {
    return Message(
      localId: localId ?? 'msg-${DateTime.now().microsecondsSinceEpoch}',
      peerId: peer ?? peerId,
      content: content ?? 'hello',
      timestamp: timestamp ?? testDate,
      isOutgoing: true,
    );
  }

  setUp(() {
    mockStorage = MockMessageStorage();

    // By default, getMessages returns an empty list so the constructor's
    // _loadMessages() completes without error.
    when(() => mockStorage.getMessages(any(),
        limit: any(named: 'limit'),
        offset: any(named: 'offset'))).thenAnswer((_) async => []);

    when(() => mockStorage.saveMessage(any())).thenAnswer((_) async {});
    when(() => mockStorage.updateMessageStatus(any(), any()))
        .thenAnswer((_) async {});
    when(() => mockStorage.deleteMessages(any())).thenAnswer((_) async {});

    notifier = ChatMessagesNotifier(peerId, mockStorage);
  });

  tearDown(() {
    notifier.dispose();
  });

  group('ChatMessagesNotifier', () {
    test('initial state is empty list', () {
      expect(notifier.debugState, isEmpty);
    });

    group('addMessage', () {
      test('adds a new message to state and saves to storage', () {
        final msg = makeMessage(localId: 'msg-1', content: 'Hi there');

        notifier.addMessage(msg);

        expect(notifier.debugState, hasLength(1));
        expect(notifier.debugState.first.localId, 'msg-1');
        expect(notifier.debugState.first.content, 'Hi there');
        verify(() => mockStorage.saveMessage(msg)).called(1);
      });

      test('skips message with duplicate localId (dedup guard)', () {
        final msg1 = makeMessage(localId: 'dup-id', content: 'first');
        final msg2 = makeMessage(localId: 'dup-id', content: 'second');

        notifier.addMessage(msg1);
        notifier.addMessage(msg2);

        expect(notifier.debugState, hasLength(1));
        expect(notifier.debugState.first.content, 'first');
        // saveMessage should only be called once — the duplicate is skipped
        verify(() => mockStorage.saveMessage(any())).called(1);
      });

      test('allows messages with different localIds', () {
        final msg1 = makeMessage(localId: 'id-1');
        final msg2 = makeMessage(localId: 'id-2');
        final msg3 = makeMessage(localId: 'id-3');

        notifier.addMessage(msg1);
        notifier.addMessage(msg2);
        notifier.addMessage(msg3);

        expect(notifier.debugState, hasLength(3));
        expect(
          notifier.debugState.map((m) => m.localId).toList(),
          ['id-1', 'id-2', 'id-3'],
        );
        verify(() => mockStorage.saveMessage(any())).called(3);
      });
    });

    group('reload', () {
      test('refreshes state from storage', () async {
        final storedMessages = [
          makeMessage(localId: 'stored-1', content: 'from db 1'),
          makeMessage(localId: 'stored-2', content: 'from db 2'),
        ];

        when(() => mockStorage.getMessages(peerId,
            limit: any(named: 'limit'),
            offset: any(named: 'offset'))).thenAnswer((_) async => storedMessages);

        await notifier.reload();

        expect(notifier.debugState, hasLength(2));
        expect(notifier.debugState[0].localId, 'stored-1');
        expect(notifier.debugState[1].localId, 'stored-2');
      });

      test('replaces existing state on reload', () async {
        // Start by adding a message in-memory
        notifier.addMessage(makeMessage(localId: 'in-mem'));
        expect(notifier.debugState, hasLength(1));

        // Simulate storage returning a different set of messages
        final dbMessages = [
          makeMessage(localId: 'db-only-1'),
          makeMessage(localId: 'db-only-2'),
          makeMessage(localId: 'db-only-3'),
        ];
        when(() => mockStorage.getMessages(peerId,
            limit: any(named: 'limit'),
            offset: any(named: 'offset'))).thenAnswer((_) async => dbMessages);

        await notifier.reload();

        expect(notifier.debugState, hasLength(3));
        expect(
          notifier.debugState.map((m) => m.localId).toList(),
          ['db-only-1', 'db-only-2', 'db-only-3'],
        );
      });
    });

    group('updateMessageStatus', () {
      test('updates status for matching localId', () {
        final msg = makeMessage(localId: 'msg-1');
        notifier.addMessage(msg);

        notifier.updateMessageStatus('msg-1', MessageStatus.sent);

        expect(notifier.debugState.first.status, MessageStatus.sent);
        verify(() =>
                mockStorage.updateMessageStatus('msg-1', MessageStatus.sent))
            .called(1);
      });

      test('does not change other messages', () {
        notifier.addMessage(makeMessage(localId: 'a'));
        notifier.addMessage(makeMessage(localId: 'b'));

        notifier.updateMessageStatus('a', MessageStatus.delivered);

        expect(notifier.debugState[0].status, MessageStatus.delivered);
        expect(notifier.debugState[1].status, MessageStatus.pending);
      });
    });

    group('clearMessages', () {
      test('clears state and deletes from storage', () {
        notifier.addMessage(makeMessage(localId: 'x'));
        notifier.addMessage(makeMessage(localId: 'y'));
        expect(notifier.debugState, hasLength(2));

        notifier.clearMessages();

        expect(notifier.debugState, isEmpty);
        verify(() => mockStorage.deleteMessages(peerId)).called(1);
      });
    });
  });
}
