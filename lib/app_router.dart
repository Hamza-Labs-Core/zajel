import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'features/chat/chat_screen.dart';
import 'features/connection/connect_screen.dart';
import 'features/home/home_screen.dart';
import 'features/settings/settings_screen.dart';

/// App router configuration.
final appRouter = GoRouter(
  initialLocation: '/',
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
    GoRoute(
      path: '/connect',
      builder: (context, state) => const ConnectScreen(),
    ),
    GoRoute(
      path: '/settings',
      builder: (context, state) => const SettingsScreen(),
    ),
  ],
  errorBuilder: (context, state) => Scaffold(
    body: Center(
      child: Text('Page not found: ${state.uri}'),
    ),
  ),
);
