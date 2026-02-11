import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'features/channels/channel_detail_screen.dart';
import 'features/channels/channels_list_screen.dart';
import 'features/chat/chat_screen.dart';
import 'features/connection/connect_screen.dart';
import 'features/contacts/contact_detail_screen.dart';
import 'features/contacts/contacts_screen.dart';
import 'features/groups/group_detail_screen.dart';
import 'features/groups/groups_list_screen.dart';
import 'features/help/help_article_screen.dart';
import 'features/help/help_screen.dart';
import 'features/home/home_screen.dart';
import 'features/home/main_layout.dart';
import 'features/onboarding/onboarding_screen.dart';
import 'features/settings/blocked_peers_screen.dart';
import 'features/settings/media_settings_screen.dart';
import 'features/settings/notification_settings_screen.dart';
import 'features/settings/settings_screen.dart';
import 'core/providers/app_providers.dart';

/// Root navigator key for showing dialogs from anywhere in the app.
final rootNavigatorKey = GlobalKey<NavigatorState>();

/// Shell navigator key for the main layout shell.
final _shellNavigatorKey = GlobalKey<NavigatorState>();

/// App router configuration.
/// Uses a ShellRoute to wrap the home and chat routes in MainLayout,
/// enabling the responsive sidebar + chat split-view on wide screens.
final appRouter = GoRouter(
  navigatorKey: rootNavigatorKey,
  initialLocation: '/',
  redirect: (context, state) {
    // Only redirect the home route; skip provider reads for all other routes.
    if (state.matchedLocation != '/') return null;
    // Safe to read synchronously: sharedPreferencesProvider is overridden with
    // an already-resolved value in main.dart before MaterialApp builds, so
    // hasSeenOnboardingProvider (which derives from it) is always available.
    final container = ProviderScope.containerOf(context);
    final seen = container.read(hasSeenOnboardingProvider);
    if (!seen) return '/onboarding';
    return null;
  },
  routes: [
    ShellRoute(
      navigatorKey: _shellNavigatorKey,
      builder: (context, state, child) => MainLayout(child: child),
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => const HomeScreen(),
        ),
        GoRoute(
          path: '/chat/:peerId',
          builder: (context, state) {
            final peerId = state.pathParameters['peerId']!;
            return ChatScreen(peerId: peerId);
          },
        ),
      ],
    ),
    GoRoute(
      path: '/connect',
      builder: (context, state) => const ConnectScreen(),
    ),
    GoRoute(
      path: '/settings',
      builder: (context, state) => const SettingsScreen(),
    ),
    GoRoute(
      path: '/settings/blocked',
      builder: (context, state) => const BlockedPeersScreen(),
    ),
    GoRoute(
      path: '/settings/notifications',
      builder: (context, state) => const NotificationSettingsScreen(),
    ),
    GoRoute(
      path: '/settings/media',
      builder: (context, state) => const MediaSettingsScreen(),
    ),
    GoRoute(
      path: '/contacts',
      builder: (context, state) => const ContactsScreen(),
    ),
    GoRoute(
      path: '/contacts/:peerId',
      builder: (context, state) {
        final peerId = state.pathParameters['peerId']!;
        return ContactDetailScreen(peerId: peerId);
      },
    ),
    GoRoute(
      path: '/channels',
      builder: (context, state) => const ChannelsListScreen(),
    ),
    GoRoute(
      path: '/channel/:channelId',
      builder: (context, state) {
        final channelId = state.pathParameters['channelId']!;
        return ChannelDetailScreen(channelId: channelId);
      },
    ),
    GoRoute(
      path: '/groups',
      builder: (context, state) => const GroupsListScreen(),
    ),
    GoRoute(
      path: '/group/:groupId',
      builder: (context, state) {
        final groupId = state.pathParameters['groupId']!;
        return GroupDetailScreen(groupId: groupId);
      },
    ),
    GoRoute(
      path: '/help',
      builder: (context, state) => const HelpScreen(),
    ),
    GoRoute(
      path: '/help/:articleId',
      builder: (context, state) {
        final articleId = state.pathParameters['articleId']!;
        return HelpArticleScreen(articleId: articleId);
      },
    ),
    GoRoute(
      path: '/onboarding',
      builder: (context, state) => const OnboardingScreen(),
    ),
  ],
  errorBuilder: (context, state) => Scaffold(
    body: Center(
      child: Text('Page not found: ${state.uri}'),
    ),
  ),
);
