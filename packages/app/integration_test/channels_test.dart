/// Integration tests for the Channels feature.
///
/// Tests the channel list screen (empty state, with channels, create dialog,
/// subscribe dialog) and channel detail screen (owner and subscriber views,
/// compose bar, share dialog, info sheet).
///
/// These tests use provider overrides to supply mock data, avoiding the need
/// for real storage or network services. They run on all platforms via
/// `flutter test integration_test/channels_test.dart`.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/features/channels/channels_list_screen.dart';
import 'package:zajel/features/channels/channel_detail_screen.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/providers/channel_providers.dart';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

final _testManifest = ChannelManifest(
  channelId: 'test-channel-1',
  name: 'Test Channel',
  description: 'A channel for testing',
  ownerKey: 'owner-pub-key-base64',
  currentEncryptKey: 'encrypt-pub-key-base64',
  keyEpoch: 1,
  rules: const ChannelRules(),
);

final _testOwnerChannel = Channel(
  id: 'test-channel-1',
  role: ChannelRole.owner,
  manifest: _testManifest,
  ownerSigningKeyPrivate: 'owner-priv-key-base64',
  encryptionKeyPrivate: 'encrypt-priv-key-base64',
  encryptionKeyPublic: 'encrypt-pub-key-base64',
  createdAt: DateTime(2026, 1, 15),
);

final _testSubscriberChannel = Channel(
  id: 'test-channel-2',
  role: ChannelRole.subscriber,
  manifest: ChannelManifest(
    channelId: 'test-channel-2',
    name: 'News Feed',
    description: 'Latest news updates',
    ownerKey: 'other-owner-key',
    currentEncryptKey: 'other-encrypt-key',
    keyEpoch: 1,
    rules: const ChannelRules(),
  ),
  encryptionKeyPublic: 'sub-encrypt-pub-key',
  createdAt: DateTime(2026, 1, 20),
);

final _testMessages = [
  ChannelMessage(
    sequence: 1,
    type: ContentType.text,
    text: 'First message in the channel',
    timestamp: DateTime(2026, 1, 15, 10, 0),
    author: 'Owner',
  ),
  ChannelMessage(
    sequence: 2,
    type: ContentType.text,
    text: 'Second message',
    timestamp: DateTime(2026, 1, 15, 10, 5),
    author: 'Owner',
  ),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wrap a screen widget with providers overridden for testing.
Widget _buildTestWidget({
  required SharedPreferences prefs,
  required Widget child,
  List<Channel> channels = const [],
  Channel? channelById,
  List<ChannelMessage> messages = const [],
}) {
  return ProviderScope(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(prefs),
      channelsProvider.overrideWith((ref) async => channels),
      if (channelById != null)
        channelByIdProvider(channelById.id)
            .overrideWith((ref) async => channelById),
      if (channelById != null)
        channelMessagesProvider(channelById.id)
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

  group('Channels List Screen', () {
    testWidgets('shows empty state when no channels exist', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const ChannelsListScreen(),
        channels: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Channels'), findsOneWidget);
      expect(find.text('No channels yet'), findsOneWidget);
      expect(find.text('Create Channel'), findsOneWidget);
      expect(find.text('Subscribe'), findsOneWidget);
    });

    testWidgets('shows channel list when channels exist', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const ChannelsListScreen(),
        channels: [_testOwnerChannel, _testSubscriberChannel],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Test Channel'), findsOneWidget);
      expect(find.text('News Feed'), findsOneWidget);
      expect(find.text('OWNER'), findsOneWidget);
      expect(find.text('SUBSCRIBER'), findsOneWidget);
    });

    testWidgets('FAB is present for creating channels', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const ChannelsListScreen(),
        channels: [_testOwnerChannel],
      ));
      await tester.pumpAndSettle();

      expect(find.byType(FloatingActionButton), findsOneWidget);
      expect(find.byIcon(Icons.add), findsOneWidget);
    });

    testWidgets('subscribe button is in app bar', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const ChannelsListScreen(),
        channels: [_testOwnerChannel],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.add_link), findsOneWidget);
    });

    testWidgets('create dialog opens and can be cancelled', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const ChannelsListScreen(),
        channels: [],
      ));
      await tester.pumpAndSettle();

      // Tap the Create Channel button in the empty state
      await tester.tap(find.widgetWithText(FilledButton, 'Create Channel'));
      await tester.pumpAndSettle();

      // Dialog should be shown
      expect(find.text('Channel Name'), findsOneWidget);
      expect(find.text('Description (optional)'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);

      // Cancel the dialog
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // Dialog should be gone
      expect(find.text('Channel Name'), findsNothing);
    });

    testWidgets('subscribe dialog opens and can be cancelled', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const ChannelsListScreen(),
        channels: [],
      ));
      await tester.pumpAndSettle();

      // Tap the Subscribe button in the empty state
      await tester.tap(find.widgetWithText(OutlinedButton, 'Subscribe'));
      await tester.pumpAndSettle();

      // Dialog should be shown
      expect(find.text('Subscribe to Channel'), findsOneWidget);
      expect(find.text('Channel invite link'), findsOneWidget);

      // Cancel the dialog
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // Dialog should be gone
      expect(find.text('Channel invite link'), findsNothing);
    });

    testWidgets('owner channels show campaign icon', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const ChannelsListScreen(),
        channels: [_testOwnerChannel],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.campaign), findsOneWidget);
    });

    testWidgets('subscriber channels show rss_feed icon', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: const ChannelsListScreen(),
        channels: [_testSubscriberChannel],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.rss_feed), findsWidgets);
    });
  });

  group('Channel Detail Screen (Owner)', () {
    testWidgets('shows channel name in app bar', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Test Channel'), findsOneWidget);
    });

    testWidgets('shows compose bar for owner', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Publish to channel...'), findsOneWidget);
      expect(find.byIcon(Icons.send), findsOneWidget);
    });

    testWidgets('shows empty state with publish hint for owner',
        (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(
        find.text('No messages yet. Publish something!'),
        findsOneWidget,
      );
    });

    testWidgets('shows OWNER role banner', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('OWNER'), findsOneWidget);
    });

    testWidgets('shows share button for owner', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.share), findsOneWidget);
    });

    testWidgets('shows info button', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.info_outline), findsOneWidget);
    });

    testWidgets('info sheet opens and shows channel details', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      await tester.tap(find.byIcon(Icons.info_outline));
      await tester.pumpAndSettle();

      expect(find.text('Channel Info'), findsOneWidget);
      expect(find.text('A channel for testing'), findsOneWidget);
      expect(find.text('Rules'), findsOneWidget);
    });

    testWidgets('share dialog opens for owner', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      await tester.tap(find.byIcon(Icons.share));
      await tester.pumpAndSettle();

      expect(find.text('Share Channel'), findsOneWidget);
      expect(find.text('Copy'), findsOneWidget);
      expect(find.text('Done'), findsOneWidget);
    });

    testWidgets('shows messages when present', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testOwnerChannel.id),
        channelById: _testOwnerChannel,
        messages: _testMessages,
      ));
      await tester.pumpAndSettle();

      expect(find.text('First message in the channel'), findsOneWidget);
      expect(find.text('Second message'), findsOneWidget);
    });
  });

  group('Channel Detail Screen (Subscriber)', () {
    testWidgets('shows channel name', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testSubscriberChannel.id),
        channelById: _testSubscriberChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('News Feed'), findsOneWidget);
    });

    testWidgets('does not show compose bar for subscriber', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testSubscriberChannel.id),
        channelById: _testSubscriberChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Publish to channel...'), findsNothing);
      expect(find.byIcon(Icons.send), findsNothing);
    });

    testWidgets('shows sync hint for subscriber empty state', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testSubscriberChannel.id),
        channelById: _testSubscriberChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(
        find.text('No messages yet. Content will appear as it syncs.'),
        findsOneWidget,
      );
    });

    testWidgets('does not show share button for subscriber', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testSubscriberChannel.id),
        channelById: _testSubscriberChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.share), findsNothing);
    });

    testWidgets('still shows info button for subscriber', (tester) async {
      await tester.pumpWidget(_buildTestWidget(
        prefs: prefs,
        child: ChannelDetailScreen(channelId: _testSubscriberChannel.id),
        channelById: _testSubscriberChannel,
        messages: [],
      ));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.info_outline), findsOneWidget);
    });
  });
}
