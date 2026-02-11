import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'models/channel.dart';
import 'models/chunk.dart';
import 'providers/channel_providers.dart';
import 'services/channel_link_service.dart';

/// Screen showing details for a single channel.
///
/// For owners/admins: shows channel info + compose bar to publish text content.
/// For subscribers: shows channel info (content display will come with sync).
class ChannelDetailScreen extends ConsumerStatefulWidget {
  final String channelId;

  const ChannelDetailScreen({super.key, required this.channelId});

  @override
  ConsumerState<ChannelDetailScreen> createState() =>
      _ChannelDetailScreenState();
}

class _ChannelDetailScreenState extends ConsumerState<ChannelDetailScreen> {
  final _messageController = TextEditingController();
  bool _publishing = false;

  @override
  void dispose() {
    _messageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final channelAsync = ref.watch(channelByIdProvider(widget.channelId));

    return Scaffold(
      appBar: AppBar(
        title: channelAsync.when(
          loading: () => const Text('Channel'),
          error: (_, __) => const Text('Channel'),
          data: (channel) => Text(channel?.manifest.name ?? 'Unknown Channel'),
        ),
        actions: [
          channelAsync.when(
            loading: () => const SizedBox.shrink(),
            error: (_, __) => const SizedBox.shrink(),
            data: (channel) {
              if (channel == null) return const SizedBox.shrink();
              return Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (channel.role == ChannelRole.owner)
                    IconButton(
                      icon: const Icon(Icons.share),
                      tooltip: 'Share channel',
                      onPressed: () => _showShareDialog(context, channel),
                    ),
                  IconButton(
                    icon: const Icon(Icons.info_outline),
                    tooltip: 'Channel info',
                    onPressed: () => _showInfoSheet(context, channel),
                  ),
                ],
              );
            },
          ),
        ],
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

          final canPublish = channel.role == ChannelRole.owner ||
              channel.role == ChannelRole.admin;

          return Column(
            children: [
              Expanded(
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          canPublish ? Icons.campaign : Icons.rss_feed,
                          size: 64,
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          channel.manifest.name,
                          style: Theme.of(context).textTheme.headlineSmall,
                          textAlign: TextAlign.center,
                        ),
                        if (channel.manifest.description.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(
                            channel.manifest.description,
                            style: Theme.of(context).textTheme.bodyMedium,
                            textAlign: TextAlign.center,
                          ),
                        ],
                        const SizedBox(height: 16),
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Chip(
                              label: Text(channel.role.name.toUpperCase()),
                              backgroundColor: Theme.of(context)
                                  .colorScheme
                                  .primaryContainer,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'Key epoch: ${channel.manifest.keyEpoch}',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                        if (canPublish) ...[
                          const SizedBox(height: 24),
                          Text(
                            'Publish content using the compose bar below.',
                            style: TextStyle(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                          ),
                        ] else ...[
                          const SizedBox(height: 24),
                          Text(
                            'Content will appear here as it syncs from the relay.',
                            style: TextStyle(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              if (canPublish) _buildComposeBar(context, channel),
            ],
          );
        },
      ),
    );
  }

  Widget _buildComposeBar(BuildContext context, Channel channel) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border(
          top: BorderSide(
            color: Theme.of(context).dividerColor,
          ),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _messageController,
                decoration: const InputDecoration(
                  hintText: 'Publish to channel...',
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.symmetric(horizontal: 8),
                ),
                maxLines: null,
                textInputAction: TextInputAction.newline,
              ),
            ),
            IconButton(
              icon: _publishing
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send),
              onPressed: _publishing ? null : () => _publish(channel),
              tooltip: 'Publish',
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _publish(Channel channel) async {
    final text = _messageController.text.trim();
    if (text.isEmpty) return;

    setState(() => _publishing = true);
    _messageController.clear();

    try {
      final channelService = ref.read(channelServiceProvider);
      final routingService = ref.read(routingHashServiceProvider);
      final syncService = ref.read(channelSyncServiceProvider);
      final storageService = ref.read(channelStorageServiceProvider);

      // Get next sequence number
      final latestSequence = await storageService.getLatestSequence(channel.id);
      final sequence = latestSequence + 1;

      // Derive routing hash for current epoch
      final routingHash = await routingService.deriveRoutingHash(
        channelSecret: channel.encryptionKeyPrivate!,
      );

      // Create payload
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode(text)),
        timestamp: DateTime.now(),
      );

      // Split into chunks (encrypt + sign)
      final chunks = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: sequence,
        routingHash: routingHash,
      );

      // Save chunks locally
      await channelService.saveChunks(channel.id, chunks);

      // Announce chunks to relay for distribution
      for (final chunk in chunks) {
        syncService.announceChunk(chunk);
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Published (${chunks.length} chunk${chunks.length > 1 ? "s" : ""})',
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to publish: $e')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _publishing = false);
      }
    }
  }

  void _showShareDialog(BuildContext context, Channel channel) {
    String? channelLink;
    String? error;

    try {
      channelLink = ChannelLinkService.encode(channel);
    } catch (e) {
      error = e.toString();
    }

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Share Channel'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (error != null)
              Text('Cannot generate invite: $error',
                  style: const TextStyle(color: Colors.red))
            else ...[
              const Text(
                'Share this invite link. It contains everything '
                'needed to subscribe (manifest + decryption key).',
                style: TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                constraints: const BoxConstraints(maxHeight: 120),
                decoration: BoxDecoration(
                  color: Colors.grey.shade100,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: SingleChildScrollView(
                  child: SelectableText(
                    channelLink!,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
        actions: [
          if (channelLink != null)
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: channelLink!));
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                      content: Text('Invite link copied to clipboard')),
                );
              },
              child: const Text('Copy'),
            ),
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  void _showInfoSheet(BuildContext context, Channel channel) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        minChildSize: 0.3,
        maxChildSize: 0.9,
        expand: false,
        builder: (context, scrollController) => ListView(
          controller: scrollController,
          padding: const EdgeInsets.all(16),
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: Colors.grey.shade300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Text(
              'Channel Info',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 16),
            _infoRow('Name', channel.manifest.name),
            if (channel.manifest.description.isNotEmpty)
              _infoRow('Description', channel.manifest.description),
            _infoRow('Role', channel.role.name.toUpperCase()),
            _infoRow('Key Epoch', '${channel.manifest.keyEpoch}'),
            const Divider(height: 32),
            Text(
              'Rules',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            _ruleRow('Replies', channel.manifest.rules.repliesEnabled),
            _ruleRow('Polls', channel.manifest.rules.pollsEnabled),
            _infoRow('Max upstream',
                '${channel.manifest.rules.maxUpstreamSize} bytes'),
            if (channel.manifest.adminKeys.isNotEmpty) ...[
              const Divider(height: 32),
              Text(
                'Admins (${channel.manifest.adminKeys.length})',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              ...channel.manifest.adminKeys.map(
                (admin) => ListTile(
                  dense: true,
                  leading: const Icon(Icons.admin_panel_settings, size: 20),
                  title: Text(admin.label),
                  subtitle: Text(
                    admin.key.length > 16
                        ? '${admin.key.substring(0, 16)}...'
                        : admin.key,
                    style:
                        const TextStyle(fontFamily: 'monospace', fontSize: 11),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _infoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: const TextStyle(
                fontWeight: FontWeight.w500,
                color: Colors.grey,
              ),
            ),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }

  Widget _ruleRow(String label, bool enabled) {
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
