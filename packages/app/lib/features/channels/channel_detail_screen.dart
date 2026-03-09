import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/providers/app_providers.dart';
import '../../core/storage/trusted_peers_storage.dart';
import '../../shared/widgets/compose_bar.dart';
import '../../shared/widgets/message_list_view.dart';
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
  final _messageFocusNode = FocusNode();
  bool _publishing = false;
  int _newMessageSignal = 0;
  int _lastMessageCount = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(activeScreenProvider.notifier).state =
          ActiveScreen(type: 'channel', id: widget.channelId);
    });
  }

  @override
  void dispose() {
    try {
      ref.read(activeScreenProvider.notifier).state = ActiveScreen.other;
    } catch (e) {
      debugPrint(
          '[ChannelDetailScreen] dispose error (may be expected during teardown): $e');
    }
    _messageController.dispose();
    _messageFocusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final channelAsync = ref.watch(channelByIdProvider(widget.channelId));
    final messages = ref.watch(channelMessagesProvider(widget.channelId));
    final notifier =
        ref.watch(channelMessagesProvider(widget.channelId).notifier);

    // Detect new incoming messages and bump the signal
    if (messages.length > _lastMessageCount && _lastMessageCount > 0) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          setState(() => _newMessageSignal++);
        }
      });
    }
    _lastMessageCount = messages.length;

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
            // Channel description + role banner
            if (channel.manifest.description.isNotEmpty ||
                channel.role != ChannelRole.subscriber)
              _buildChannelBanner(context, channel),
            Expanded(
              child: MessageListView<ChannelMessage>(
                messages: messages,
                messageBuilder: (context, msg) =>
                    _buildMessageBubble(context, msg),
                timestampExtractor: (msg) => msg.timestamp,
                onLoadMore: () => notifier.loadMore(),
                hasMore: notifier.hasMore,
                newMessageSignal: _newMessageSignal,
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                emptyState: _buildEmptyState(context, channel, canPublish),
              ),
            ),
            if (canPublish)
              ComposeBar(
                controller: _messageController,
                focusNode: _messageFocusNode,
                onSend: () => _publish(channel),
                isSending: _publishing,
                hintText: 'Publish to channel...',
                sendTooltip: 'Publish',
              ),
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

  Widget _buildChannelBanner(BuildContext context, Channel channel) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        border: Border(
          bottom: BorderSide(color: Theme.of(context).dividerColor),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (channel.manifest.description.isNotEmpty)
            Text(
              channel.manifest.description,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
          if (channel.manifest.description.isNotEmpty)
            const SizedBox(height: 4),
          Text(
            channel.role.name.toUpperCase(),
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  fontWeight: FontWeight.w600,
                  color: Theme.of(context).colorScheme.primary,
                ),
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
                timeFormat.format(message.timestamp.toLocal()),
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
                content: Text('Text content is not allowed in this channel'),
                duration: Duration(seconds: 3)),
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
        timestamp: DateTime.now().toUtc(),
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
        syncService.announceChunk(chunk, channelId: channel.id);
      }

      // Refresh the message list
      await ref
          .read(channelMessagesProvider(widget.channelId).notifier)
          .reload();
      if (mounted) setState(() => _newMessageSignal++);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Published (${chunks.length} chunk(s))'),
            duration: const Duration(seconds: 3),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to publish: $e'),
            duration: const Duration(seconds: 3),
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _publishing = false);
        _messageFocusNode.requestFocus();
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
                      color: Colors.black87,
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
                      content: Text('Invite link copied to clipboard'),
                      duration: Duration(seconds: 3)),
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
            if (channel.manifest.adminKeys.isNotEmpty ||
                channel.role == ChannelRole.owner) ...[
              const Divider(height: 32),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Admins (${channel.manifest.adminKeys.length})',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (channel.role == ChannelRole.owner)
                    TextButton.icon(
                      onPressed: () {
                        Navigator.pop(context);
                        _showManageAdminsSheet(context, channel);
                      },
                      icon: const Icon(Icons.settings, size: 18),
                      label: const Text('Manage'),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              if (channel.manifest.adminKeys.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    'No admins yet.',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                      fontStyle: FontStyle.italic,
                    ),
                  ),
                )
              else
                ...channel.manifest.adminKeys.map(
                  (admin) => ListTile(
                    dense: true,
                    leading: const Icon(Icons.admin_panel_settings, size: 20),
                    title: Text(admin.label),
                    subtitle: Text(
                      admin.key.length > 16
                          ? '${admin.key.substring(0, 16)}...'
                          : admin.key,
                      style: const TextStyle(
                          fontFamily: 'monospace', fontSize: 11),
                    ),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  void _showManageAdminsSheet(BuildContext context, Channel channel) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => _AdminManagementSheet(
        channel: channel,
        onAddAdmin: () {
          Navigator.pop(sheetContext);
          // Use addPostFrameCallback to ensure the sheet is fully dismissed
          // before showing the dialog, avoiding context lifecycle issues.
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) _showAddAdminDialog(context, channel);
          });
        },
        onRemoveAdmin: (admin) async {
          Navigator.pop(sheetContext);
          await _showRemoveAdminConfirmation(context, channel, admin);
        },
      ),
    );
  }

  Future<void> _showAddAdminDialog(
      BuildContext context, Channel channel) async {
    final trustedPeers =
        await ref.read(trustedPeersStorageProvider).getAllPeers();

    // Filter: must have a signing key, must not already be an admin
    final existingAdminKeys =
        channel.manifest.adminKeys.map((a) => a.key).toSet();
    final eligible = trustedPeers
        .where((p) =>
            p.signingPublicKey != null &&
            p.signingPublicKey!.isNotEmpty &&
            !existingAdminKeys.contains(p.signingPublicKey) &&
            p.signingPublicKey != channel.manifest.ownerKey)
        .toList();

    if (!context.mounted) return;

    if (eligible.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content:
              Text('No eligible contacts. Contacts need to reconnect first '
                  'to share their signing key.'),
          duration: Duration(seconds: 4),
        ),
      );
      return;
    }

    final selected = await showDialog<TrustedPeer>(
      context: context,
      builder: (dialogContext) => _AdminPeerPickerDialog(
        peers: eligible,
      ),
    );

    if (selected != null && mounted) {
      try {
        final adminService = ref.read(adminManagementServiceProvider);
        await adminService.appointAdmin(
          channel: channel,
          adminPublicKey: selected.signingPublicKey!,
          adminLabel: selected.alias ?? selected.displayName,
        );
        ref.invalidate(channelByIdProvider(widget.channelId));
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content:
                Text('Admin "${selected.alias ?? selected.displayName}" added'),
            duration: const Duration(seconds: 3),
          ),
        );
      } catch (e) {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to add admin: $e'),
            duration: const Duration(seconds: 3),
          ),
        );
      }
    }
  }

  Future<void> _showRemoveAdminConfirmation(
      BuildContext context, Channel channel, AdminKey admin) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Remove Admin'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Remove "${admin.label}" from admins?'),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(dialogContext)
                    .colorScheme
                    .errorContainer
                    .withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Icon(Icons.warning_amber_rounded,
                      color: Theme.of(dialogContext).colorScheme.error,
                      size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'This will rotate the channel encryption key. '
                      'The removed admin will not be able to decrypt '
                      'future content.',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(dialogContext).colorScheme.error,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );

    if (confirmed == true && mounted) {
      try {
        final adminService = ref.read(adminManagementServiceProvider);
        await adminService.removeAdmin(
          channel: channel,
          adminPublicKey: admin.key,
        );
        ref.invalidate(channelByIdProvider(widget.channelId));
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Admin "${admin.label}" removed successfully'),
            duration: const Duration(seconds: 3),
          ),
        );
      } catch (e) {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to remove admin: $e'),
            duration: const Duration(seconds: 3),
          ),
        );
      }
    }
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

/// Bottom sheet widget for managing channel admins.
///
/// Shows the list of current admins with remove buttons and an "Add Admin"
/// button at the bottom. Used only by the channel owner.
class _AdminManagementSheet extends StatelessWidget {
  final Channel channel;
  final VoidCallback onAddAdmin;
  final void Function(AdminKey admin) onRemoveAdmin;

  const _AdminManagementSheet({
    required this.channel,
    required this.onAddAdmin,
    required this.onRemoveAdmin,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final admins = channel.manifest.adminKeys;

    return DraggableScrollableSheet(
      initialChildSize: 0.5,
      minChildSize: 0.3,
      maxChildSize: 0.8,
      expand: false,
      builder: (context, scrollController) => Column(
        children: [
          // Handle bar
          Padding(
            padding: const EdgeInsets.only(top: 12, bottom: 8),
            child: Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: Colors.grey.shade300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ),
          // Title
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                Icon(Icons.admin_panel_settings,
                    color: theme.colorScheme.primary),
                const SizedBox(width: 8),
                Text(
                  'Manage Admins',
                  style: theme.textTheme.titleLarge,
                ),
              ],
            ),
          ),
          const Divider(),
          // Admin list
          Expanded(
            child: admins.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.person_add_alt,
                            size: 48,
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'No admins yet. Add an admin to allow '
                            'them to publish content to this channel.',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  )
                : ListView.builder(
                    controller: scrollController,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    itemCount: admins.length,
                    itemBuilder: (context, index) {
                      final admin = admins[index];
                      return ListTile(
                        leading: CircleAvatar(
                          backgroundColor: theme.colorScheme.primaryContainer,
                          child: Icon(
                            Icons.admin_panel_settings,
                            color: theme.colorScheme.onPrimaryContainer,
                            size: 20,
                          ),
                        ),
                        title: Text(admin.label),
                        subtitle: Text(
                          admin.key.length > 24
                              ? '${admin.key.substring(0, 24)}...'
                              : admin.key,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 11,
                          ),
                        ),
                        trailing: IconButton(
                          icon: Icon(Icons.close,
                              color: theme.colorScheme.error, size: 20),
                          tooltip: 'Remove admin',
                          onPressed: () => onRemoveAdmin(admin),
                        ),
                      );
                    },
                  ),
          ),
          // Add admin button
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: SafeArea(
              top: false,
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: onAddAdmin,
                  icon: const Icon(Icons.person_add),
                  label: const Text('Add Admin'),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Dialog that shows trusted contacts for selecting a channel admin.
class _AdminPeerPickerDialog extends StatefulWidget {
  final List<TrustedPeer> peers;

  const _AdminPeerPickerDialog({required this.peers});

  @override
  State<_AdminPeerPickerDialog> createState() => _AdminPeerPickerDialogState();
}

class _AdminPeerPickerDialogState extends State<_AdminPeerPickerDialog> {
  String _search = '';

  List<TrustedPeer> get _filtered {
    if (_search.isEmpty) return widget.peers;
    final q = _search.toLowerCase();
    return widget.peers
        .where((p) =>
            p.displayName.toLowerCase().contains(q) ||
            (p.alias?.toLowerCase().contains(q) ?? false) ||
            (p.username?.toLowerCase().contains(q) ?? false))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Select Admin'),
      content: SizedBox(
        width: double.maxFinite,
        height: 400,
        child: Column(
          children: [
            TextField(
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Search contacts...',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              onChanged: (v) => setState(() => _search = v),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: _filtered.isEmpty
                  ? const Center(child: Text('No matching contacts'))
                  : ListView.builder(
                      itemCount: _filtered.length,
                      itemBuilder: (context, index) {
                        final peer = _filtered[index];
                        return ListTile(
                          leading: CircleAvatar(
                            child: Text(
                              (peer.alias ?? peer.displayName)
                                  .substring(0, 1)
                                  .toUpperCase(),
                            ),
                          ),
                          title: Text(peer.alias ?? peer.displayName),
                          subtitle: peer.username != null
                              ? Text(peer.username!)
                              : null,
                          onTap: () => Navigator.pop(context, peer),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}
