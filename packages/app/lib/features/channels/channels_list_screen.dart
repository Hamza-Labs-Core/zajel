import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'models/channel.dart';
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
        actions: [
          IconButton(
            icon: const Icon(Icons.add_link),
            tooltip: 'Subscribe to channel',
            onPressed: () => _showSubscribeDialog(context, ref),
          ),
        ],
      ),
      body: channelsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(
          child: Text('Error loading channels: $error'),
        ),
        data: (channels) {
          if (channels.isEmpty) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.rss_feed, size: 64, color: Colors.grey),
                  const SizedBox(height: 16),
                  const Text(
                    'No channels yet',
                    style: TextStyle(fontSize: 18, color: Colors.grey),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Create a channel to broadcast messages\nor subscribe to an existing one.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey),
                  ),
                  const SizedBox(height: 24),
                  FilledButton.icon(
                    onPressed: () => _showCreateChannelDialog(context, ref),
                    icon: const Icon(Icons.add),
                    label: const Text('Create Channel'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: () => _showSubscribeDialog(context, ref),
                    icon: const Icon(Icons.add_link),
                    label: const Text('Subscribe'),
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
                leading: CircleAvatar(
                  backgroundColor: channel.role == ChannelRole.owner
                      ? Theme.of(context).colorScheme.primaryContainer
                      : Theme.of(context).colorScheme.surfaceContainerHighest,
                  child: Icon(
                    channel.role == ChannelRole.owner
                        ? Icons.campaign
                        : Icons.rss_feed,
                    color: channel.role == ChannelRole.owner
                        ? Theme.of(context).colorScheme.onPrimaryContainer
                        : Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                title: Text(channel.manifest.name),
                subtitle: Text(channel.role.name.toUpperCase()),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/channel/${channel.id}'),
              );
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showCreateChannelDialog(context, ref),
        tooltip: 'Create Channel',
        child: const Icon(Icons.add),
      ),
    );
  }

  Future<void> _showCreateChannelDialog(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final nameController = TextEditingController();
    final descriptionController = TextEditingController();

    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Create Channel'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameController,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'Channel Name',
                hintText: 'e.g. Project Updates',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: descriptionController,
              decoration: const InputDecoration(
                labelText: 'Description (optional)',
                hintText: 'What is this channel about?',
                border: OutlineInputBorder(),
              ),
              maxLines: 2,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Create'),
          ),
        ],
      ),
    );

    if (result == true && nameController.text.trim().isNotEmpty) {
      final channelService = ref.read(channelServiceProvider);
      await channelService.createChannel(
        name: nameController.text.trim(),
        description: descriptionController.text.trim(),
      );
      ref.invalidate(channelsProvider);
    }

    nameController.dispose();
    descriptionController.dispose();
  }

  Future<void> _showSubscribeDialog(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final manifestController = TextEditingController();
    final keyController = TextEditingController();

    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Subscribe to Channel'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Paste the channel manifest JSON shared by the owner.',
                style: TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: manifestController,
                decoration: const InputDecoration(
                  labelText: 'Channel Manifest (JSON)',
                  hintText: '{"channel_id": "...", ...}',
                  border: OutlineInputBorder(),
                ),
                maxLines: 4,
              ),
              const SizedBox(height: 16),
              const Text(
                'Paste the decryption key (shared separately).',
                style: TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: keyController,
                decoration: const InputDecoration(
                  labelText: 'Decryption Key (base64)',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Subscribe'),
          ),
        ],
      ),
    );

    if (result == true &&
        manifestController.text.trim().isNotEmpty &&
        keyController.text.trim().isNotEmpty) {
      try {
        final manifestJson =
            jsonDecode(manifestController.text.trim()) as Map<String, dynamic>;
        final manifest = ChannelManifest.fromJson(manifestJson);

        final channelService = ref.read(channelServiceProvider);
        await channelService.subscribe(
          manifest: manifest,
          encryptionPrivateKey: keyController.text.trim(),
        );
        ref.invalidate(channelsProvider);

        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Subscribed to "${manifest.name}"'),
            ),
          );
        }
      } on FormatException {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Invalid manifest JSON format')),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Subscribe failed: $e')),
          );
        }
      }
    }

    manifestController.dispose();
    keyController.dispose();
  }
}
