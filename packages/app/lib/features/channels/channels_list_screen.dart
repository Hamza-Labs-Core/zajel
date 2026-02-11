import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'providers/channel_providers.dart';

/// Screen showing the list of all channels (owned + subscribed).
class ChannelsListScreen extends ConsumerWidget {
  const ChannelsListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channelsAsync = ref.watch(channelsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Channels'),
      ),
      body: channelsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(
          child: Text('Error loading channels: $error'),
        ),
        data: (channels) {
          if (channels.isEmpty) {
            return const Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.rss_feed, size: 64, color: Colors.grey),
                  SizedBox(height: 16),
                  Text(
                    'No channels yet',
                    style: TextStyle(fontSize: 18, color: Colors.grey),
                  ),
                  SizedBox(height: 8),
                  Text(
                    'Create a channel to broadcast messages\nor subscribe to an existing one.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey),
                  ),
                ],
              ),
            );
          }

          return ListView.builder(
            itemCount: channels.length,
            itemBuilder: (context, index) {
              final channel = channels[index];
              return ListTile(
                leading: const Icon(Icons.rss_feed),
                title: Text(channel.id),
                subtitle: Text(channel.role.name),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/channel/${channel.id}'),
              );
            },
          );
        },
      ),
    );
  }
}
