/// Integration tests for the Groups feature.
///
/// Tests the groups list screen (empty state, with groups, create dialog)
/// and group detail screen (compose bar, messages, add member dialog,
/// members sheet).
///
/// These tests use provider overrides to supply mock data, avoiding the need
/// for real storage or network services. They run on all platforms via
/// `flutter test integration_test/groups_test.dart`.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/features/groups/groups_list_screen.dart';
import 'package:zajel/features/groups/group_detail_screen.dart';
import 'package:zajel/features/groups/models/group.dart';
import 'package:zajel/features/groups/models/group_message.dart';
import 'package:zajel/features/groups/providers/group_providers.dart';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

final _now = DateTime(2026, 2, 1, 12, 0);

final _testGroup = Group(
  id: 'group-1',
  name: 'Family Chat',
  selfDeviceId: 'my-device',
  members: [
    GroupMember(
      deviceId: 'my-device',
      displayName: 'Test User',
      publicKey: 'my-public-key-base64',
      joinedAt: _now,
    ),
    GroupMember(
      deviceId: 'alice-device',
      displayName: 'Alice',
      publicKey: 'alice-public-key-base64',
      joinedAt: _now,
    ),
    GroupMember(
      deviceId: 'bob-device',
      displayName: 'Bob',
      publicKey: 'bob-public-key-base64',
      joinedAt: _now,
    ),
  ],
  createdAt: _now,
  createdBy: 'my-device',
);

final _soloGroup = Group(
  id: 'group-2',
  name: 'Solo Group',
  selfDeviceId: 'my-device',
  members: [
    GroupMember(
      deviceId: 'my-device',
      displayName: 'Test User',
      publicKey: 'my-public-key-base64',
      joinedAt: _now,
    ),
  ],
  createdAt: _now,
  createdBy: 'my-device',
);

final _testMessages = [
  GroupMessage(
    groupId: 'group-1',
    authorDeviceId: 'my-device',
    sequenceNumber: 1,
    content: 'Hello everyone!',
    timestamp: _now,
    status: GroupMessageStatus.sent,
    isOutgoing: true,
  ),
  GroupMessage(
    groupId: 'group-1',
    authorDeviceId: 'alice-device',
    sequenceNumber: 1,
    content: 'Hi there!',
    timestamp: _now.add(const Duration(minutes: 1)),
    status: GroupMessageStatus.delivered,
    isOutgoing: false,
  ),
  GroupMessage(
    groupId: 'group-1',
    authorDeviceId: 'bob-device',
    sequenceNumber: 1,
    content: 'Good morning!',
    timestamp: _now.add(const Duration(minutes: 2)),
    status: GroupMessageStatus.delivered,
    isOutgoing: false,
  ),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wrap a screen widget with providers overridden for testing.
Widget _buildTestWidget({
  required SharedPreferences prefs,
  required Widget child,
  List<Group> groups = const [],
  Group? groupById,
  List<GroupMessage> messages = const [],
}) {
  return ProviderScope(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(prefs),
      pairingCodeProvider.overrideWith((ref) => 'my-device'),
      usernameProvider.overrideWith((ref) => 'Test User'),
      groupsProvider.overrideWith((ref) async => groups),
      if (groupById != null)
        groupByIdProvider(groupById.id).overrideWith((ref) async => groupById),
      if (groupById != null)
        groupMessagesProvider(groupById.id)
            .overrideWith((ref) async => messages),
    ],
    child: MaterialApp(home: child),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late SharedPreferences prefs;

  setUp(() async {
    SharedPreferences.setMockInitialValues({
      'displayName': 'Test User',
      'hasSeenOnboarding': true,
    });
    prefs = await SharedPreferences.getInstance();
  });

  group('Groups List Screen', () {
    testWidgets('shows empty state when no groups exist', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const GroupsListScreen(),
        groups: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Groups'), findsOneWidget);
      expect(find.text('No groups yet'), findsOneWidget);
      expect(find.text('Create Group'), findsOneWidget);
    });

    testWidgets('shows group list when groups exist', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const GroupsListScreen(),
        groups: [_testGroup, _soloGroup],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Family Chat'), findsOneWidget);
      expect(find.text('Solo Group'), findsOneWidget);
      expect(find.text('3 members'), findsOneWidget);
      expect(find.text('1 members'), findsOneWidget);
    });

    testWidgets('FAB is present for creating groups', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const GroupsListScreen(),
        groups: [_testGroup],
      ));
      await tester.pumpAndSettle();

      expect(find.byType(FloatingActionButton), findsOneWidget);
      expect(find.byIcon(Icons.add), findsOneWidget);
    });

    testWidgets('shows first letter avatar for groups', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const GroupsListScreen(),
        groups: [_testGroup],
      ));
      await tester.pumpAndSettle();

      // First letter of "Family Chat" is "F"
      expect(find.text('F'), findsOneWidget);
    });

    testWidgets('create dialog opens and can be cancelled', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const GroupsListScreen(),
        groups: [],
      ));
      await tester.pumpAndSettle();

      // Tap the Create Group button in the empty state.
      // Use find.text instead of widgetWithText(FilledButton, ...) because
      // LiveTestWidgetsFlutterBinding (integration tests on desktop) may not
      // resolve the FilledButton ancestor correctly.
      await tester.tap(find.text('Create Group'));
      await tester.pumpAndSettle();

      // Dialog should be shown
      expect(find.text('Group Name'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);

      // Cancel the dialog
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // Dialog should be gone
      expect(find.text('Group Name'), findsNothing);
    });

    testWidgets('create dialog has name field with hint', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const GroupsListScreen(),
        groups: [],
      ));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Create Group'));
      await tester.pumpAndSettle();

      expect(find.text('e.g. Family Chat'), findsOneWidget);
    });
  });

  group('Group Detail Screen', () {
    testWidgets('shows group name in app bar', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Family Chat'), findsOneWidget);
    });

    testWidgets('shows compose bar', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Type a message...'), findsOneWidget);
      expect(find.byIcon(Icons.send), findsOneWidget);
    });

    testWidgets('shows empty message state', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('No messages yet.\nSend the first message!'),
          findsOneWidget);
    });

    testWidgets('shows add member button', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.person_add), findsOneWidget);
    });

    testWidgets('shows members button with count', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.people), findsOneWidget);
    });

    testWidgets('members sheet opens and shows all members', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: [],
      ));
      await tester.pumpAndSettle();

      // Tap members button
      await tester.tap(find.byIcon(Icons.people));
      await tester.pumpAndSettle();

      // Members sheet should show all members
      expect(find.text('Members (3)'), findsOneWidget);
      expect(find.text('Test User'), findsOneWidget);
      expect(find.text('Alice'), findsOneWidget);
      expect(find.text('Bob'), findsOneWidget);
      expect(find.text('You'), findsOneWidget);
    });

    testWidgets('shows messages from multiple authors', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: _testMessages,
      ));
      await tester.pumpAndSettle();

      expect(find.text('Hello everyone!'), findsOneWidget);
      expect(find.text('Hi there!'), findsOneWidget);
      expect(find.text('Good morning!'), findsOneWidget);
    });

    testWidgets('incoming messages show author name', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: _testMessages,
      ));
      await tester.pumpAndSettle();

      // Incoming messages (not outgoing) should show the author's display name
      expect(find.text('Alice'), findsWidgets);
      expect(find.text('Bob'), findsWidgets);
    });

    testWidgets('outgoing messages aligned right', (tester) async {
      final outgoingOnlyMessages = [
        GroupMessage(
          groupId: 'group-1',
          authorDeviceId: 'my-device',
          sequenceNumber: 1,
          content: 'My outgoing message',
          timestamp: _now,
          status: GroupMessageStatus.sent,
          isOutgoing: true,
        ),
      ];

      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _testGroup.id),
        groupById: _testGroup,
        messages: outgoingOnlyMessages,
      ));
      await tester.pumpAndSettle();

      // Find the Align widget wrapping the message
      final alignFinder = find.ancestor(
        of: find.text('My outgoing message'),
        matching: find.byType(Align),
      );
      expect(alignFinder, findsOneWidget);

      final alignWidget = tester.widget<Align>(alignFinder);
      expect(alignWidget.alignment, equals(Alignment.centerRight));
    });

    testWidgets('group not found shows error', (tester) async {
      await tester.pumpWidget(ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          groupByIdProvider('nonexistent').overrideWith((ref) async => null),
          groupMessagesProvider('nonexistent')
              .overrideWith((ref) async => <GroupMessage>[]),
        ],
        child: MaterialApp(
          home: GroupDetailScreen(groupId: 'nonexistent'),
        ),
      ));
      await tester.pumpAndSettle();

      expect(find.text('Group not found'), findsOneWidget);
    });
  });

  group('Group Detail Screen (Solo)', () {
    testWidgets('solo group shows 1 member in sheet', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: GroupDetailScreen(groupId: _soloGroup.id),
        groupById: _soloGroup,
        messages: [],
      ));
      await tester.pumpAndSettle();

      // Open members sheet
      await tester.tap(find.byIcon(Icons.people));
      await tester.pumpAndSettle();

      expect(find.text('Members (1)'), findsOneWidget);
      expect(find.text('You'), findsOneWidget);
    });
  });
}
