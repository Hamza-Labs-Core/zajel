import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/providers/app_providers.dart';
import '../../shared/widgets/app_toast.dart';
import 'models/channel.dart';
import 'providers/channel_providers.dart';
import 'services/channel_link_service.dart';

/// Screen showing the list of all channels (owned + subscribed).
///
/// Used on narrow screens (phones) with push navigation.
/// On wide screens, the [ChannelsMainScreen] split-view is used instead.
class ChannelsListScreen extends ConsumerWidget {
  const ChannelsListScreen({super.key});

  /// Show the create channel dialog. Exposed as static for reuse in sidebar.
  static Future<void> showCreateDialog(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final nameController = TextEditingController();
    final descriptionController = TextEditingController();

    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Create Channel'),
        content: SingleChildScrollView(
          child: Column(
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
      final channel = await channelService.createChannel(
        name: nameController.text.trim(),
        description: descriptionController.text.trim(),
      );
      ref.invalidate(channelsProvider);

      // Register ownership with VPS so it routes upstream messages to us
      final signalingClient = ref.read(signalingClientProvider);
      signalingClient?.send({
        'type': 'channel-owner-register',
        'channelId': channel.id,
      });
    }
  }

  /// Show the subscribe dialog. Exposed as static for reuse in sidebar.
  static Future<void> showSubscribeDialog(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final linkController = TextEditingController();

    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Subscribe to Channel'),
        content: SingleChildScrollView(
          child: TextField(
            controller: linkController,
            decoration: const InputDecoration(
              labelText: 'Channel invite link',
              hintText: 'zajel://channel/...',
              border: OutlineInputBorder(),
            ),
            maxLines: 4,
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

    if (result == true && linkController.text.trim().isNotEmpty) {
      try {
        final decoded = ChannelLinkService.decode(linkController.text);

        if (!context.mounted) return;
        final confirmed =
            await _confirmChannelSubscribe(context, decoded.manifest);
        if (confirmed != true) return;

        final channelService = ref.read(channelServiceProvider);
        await channelService.subscribe(
          manifest: decoded.manifest,
          encryptionPrivateKey: decoded.encryptionKey,
        );
        ref.invalidate(channelsProvider);

        // Register subscription with VPS so it routes chunks to us
        final signalingClient = ref.read(signalingClientProvider);
        signalingClient?.send({
          'type': 'channel-subscribe',
          'channelId': decoded.manifest.channelId,
        });

        if (context.mounted) {
          showAppToast(
            context,
            'Subscribed to "${decoded.manifest.name}"',
            duration: const Duration(seconds: 3),
          );
        }
      } on FormatException {
        if (context.mounted) {
          showAppToast(
            context,
            'Invalid channel invite link',
            duration: const Duration(seconds: 3),
            kind: AppToastKind.error,
          );
        }
      } catch (e) {
        if (context.mounted) {
          showAppToast(
            context,
            'Subscribe failed: $e',
            duration: const Duration(seconds: 3),
            kind: AppToastKind.error,
          );
        }
      }
    }
  }

  /// Confirm dialog shown after a channel invite link is parsed but before
  /// the actual subscribe call.
  ///
  /// Channel links are bearer tokens — anyone with the link can subscribe —
  /// so this isn't a security gate against attackers, it's a UX gate
  /// against a user accidentally pasting the wrong link or being tricked
  /// into subscribing to a channel they didn't recognize. Shows the
  /// channel's plaintext name + description + admin count so the user can
  /// sanity-check before committing.
  static Future<bool?> _confirmChannelSubscribe(
    BuildContext context,
    ChannelManifest manifest,
  ) {
    final adminCount = manifest.adminKeys.length;
    return showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.podcasts, color: Colors.blue),
            SizedBox(width: 8),
            Text('Subscribe to channel?'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    manifest.name,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  if (manifest.description.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      manifest.description,
                      style: const TextStyle(fontSize: 13),
                    ),
                  ],
                  const SizedBox(height: 8),
                  Text(
                    adminCount == 0
                        ? 'No additional admins'
                        : '$adminCount admin${adminCount == 1 ? '' : 's'}',
                    style: const TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.orange.shade200),
              ),
              child: const Row(
                children: [
                  Icon(Icons.warning_amber, color: Colors.orange, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Subscribe only if this channel matches what the '
                      'sender intended to share.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Subscribe'),
          ),
        ],
      ),
    );
  }

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
            onPressed: () => showSubscribeDialog(context, ref),
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
                    onPressed: () => showCreateDialog(context, ref),
                    icon: const Icon(Icons.add),
                    label: const Text('Create Channel'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: () => showSubscribeDialog(context, ref),
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
        onPressed: () => showCreateDialog(context, ref),
        tooltip: 'Create Channel',
        child: const Icon(Icons.add),
      ),
    );
  }
}
