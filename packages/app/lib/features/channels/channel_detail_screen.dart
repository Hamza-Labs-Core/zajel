import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers/channel_providers.dart';

/// Screen showing details for a single channel.
class ChannelDetailScreen extends ConsumerWidget {
  final String channelId;

  const ChannelDetailScreen({super.key, required this.channelId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channelAsync = ref.watch(channelByIdProvider(channelId));

    return Scaffold(
      appBar: AppBar(
        title: channelAsync.when(
          loading: () => const Text('Channel'),
          error: (_, __) => const Text('Channel'),
          data: (channel) => Text(channel?.manifest.name ?? 'Unknown Channel'),
        ),
      ),
      body: channelAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(
          child: Text('Error loading channel: $error'),
        ),
        data: (channel) {
          if (channel == null) {
            return const Center(
              child: Text('Channel not found'),
            );
          }

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        channel.manifest.name,
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        channel.manifest.description,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Chip(
                            label: Text(channel.role.name.toUpperCase()),
                            backgroundColor:
                                Theme.of(context).colorScheme.primaryContainer,
                          ),
                          const SizedBox(width: 8),
                          Text(
                            'Key epoch: ${channel.manifest.keyEpoch}',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (channel.manifest.adminKeys.isNotEmpty) ...[
                Text(
                  'Admins',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                ...channel.manifest.adminKeys.map(
                  (admin) => ListTile(
                    leading: const Icon(Icons.admin_panel_settings),
                    title: Text(admin.label),
                    subtitle: Text(
                      admin.key.length > 16
                          ? '${admin.key.substring(0, 16)}...'
                          : admin.key,
                      style: const TextStyle(fontFamily: 'monospace'),
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 16),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Rules',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      _buildRuleRow(
                        'Replies',
                        channel.manifest.rules.repliesEnabled,
                      ),
                      _buildRuleRow(
                        'Polls',
                        channel.manifest.rules.pollsEnabled,
                      ),
                      Text(
                        'Max upstream size: ${channel.manifest.rules.maxUpstreamSize} bytes',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildRuleRow(String label, bool enabled) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Icon(
            enabled ? Icons.check_circle : Icons.cancel,
            size: 16,
            color: enabled ? Colors.green : Colors.red,
          ),
          const SizedBox(width: 8),
          Text(label),
        ],
      ),
    );
  }
}
