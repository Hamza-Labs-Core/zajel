import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import 'models/channel.dart';
import 'models/chunk.dart';
import 'providers/channel_providers.dart';
import 'services/channel_link_service.dart';

/// Screen showing details for a single channel.
///
/// For owners/admins: shows messages + compose bar to publish text content.
/// For subscribers: shows messages as they sync from the relay.
class ChannelDetailScreen extends ConsumerStatefulWidget {
  final String channelId;

  /// When true, renders without its own Scaffold/AppBar (for split-view embedding).
  final bool embedded;

  const ChannelDetailScreen({
    super.key,
    required this.channelId,
    this.embedded = false,
  });

  @override
  ConsumerState<ChannelDetailScreen> createState() =>
      _ChannelDetailScreenState();
}

class _ChannelDetailScreenState extends ConsumerState<ChannelDetailScreen> {
  final _messageController = TextEditingController();
  final _scrollController = ScrollController();
  bool _publishing = false;

  @override
  void dispose() {
    _messageController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final channelAsync = ref.watch(channelByIdProvider(widget.channelId));
    final messagesAsync = ref.watch(channelMessagesProvider(widget.channelId));

    Widget body = channelAsync.when(
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
            // Header bar in embedded mode (no Scaffold AppBar)
            if (widget.embedded) _buildEmbeddedHeader(context, channel),
            Expanded(
              child: messagesAsync.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (error, _) =>
                    Center(child: Text('Error loading messages: $error')),
                data: (messages) {
                  if (messages.isEmpty) {
                    return _buildEmptyState(context, channel, canPublish);
                  }
                  return _buildMessageList(context, messages);
                },
              ),
            ),
            if (canPublish) _buildComposeBar(context, channel),
          ],
        );
      },
    );

    if (widget.embedded) {
      return body;
    }

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
      body: body,
    );
  }

  Widget _buildEmbeddedHeader(BuildContext context, Channel channel) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border(
          bottom: BorderSide(color: Theme.of(context).dividerColor),
        ),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 18,
            backgroundColor: channel.role == ChannelRole.owner
                ? Theme.of(context).colorScheme.primaryContainer
                : Theme.of(context).colorScheme.surfaceContainerHighest,
            child: Icon(
              channel.role == ChannelRole.owner
                  ? Icons.campaign
                  : Icons.rss_feed,
              size: 18,
              color: channel.role == ChannelRole.owner
                  ? Theme.of(context).colorScheme.onPrimaryContainer
                  : Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  channel.manifest.name,
                  style: Theme.of(context).textTheme.titleMedium,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  channel.role.name.toUpperCase(),
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                ),
              ],
            ),
          ),
          if (channel.role == ChannelRole.owner)
            IconButton(
              icon: const Icon(Icons.share, size: 20),
              tooltip: 'Share channel',
              onPressed: () => _showShareDialog(context, channel),
            ),
          IconButton(
            icon: const Icon(Icons.info_outline, size: 20),
            tooltip: 'Channel info',
            onPressed: () => _showInfoSheet(context, channel),
          ),
        ],
      ),
    );
  }

  Widget _buildEmptyState(
      BuildContext context, Channel channel, bool canPublish) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              canPublish ? Icons.campaign : Icons.rss_feed,
              size: 48,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 12),
            Text(
              canPublish
                  ? 'No messages yet. Publish something!'
                  : 'No messages yet. Content will appear as it syncs.',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageList(
      BuildContext context, List<ChannelMessage> messages) {
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      itemCount: messages.length,
      itemBuilder: (context, index) {
        final message = messages[index];
        return _buildMessageBubble(context, message);
      },
    );
  }

  Widget _buildMessageBubble(BuildContext context, ChannelMessage message) {
    final timeFormat = DateFormat('MMM d, h:mm a');
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (message.author != null) ...[
                Text(
                  message.author!,
                  style: theme.textTheme.labelSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: theme.colorScheme.primary,
                  ),
                ),
                const SizedBox(width: 8),
              ],
              Text(
                timeFormat.format(message.timestamp),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: SelectableText(
              message.text,
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ],
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
              child: KeyboardListener(
                focusNode: FocusNode(),
                onKeyEvent: (event) {
                  if (event is KeyDownEvent &&
                      event.logicalKey == LogicalKeyboardKey.enter &&
                      !HardwareKeyboard.instance.isShiftPressed) {
                    _publish(channel);
                  }
                },
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
      // Verify the content type is allowed by channel rules
      if (!channel.manifest.rules.isContentTypeAllowed(ContentType.text.name)) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
                content: Text('Text content is not allowed in this channel')),
          );
        }
        return;
      }

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

      // Refresh the message list
      ref.invalidate(channelMessagesProvider(widget.channelId));

      // Scroll to bottom after a frame to show the new message
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
          );
        }
      });
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
            _infoRow('Allowed types',
                channel.manifest.rules.allowedTypes.join(', ')),
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
