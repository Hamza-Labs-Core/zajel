import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/app_providers.dart';
import '../../shared/widgets/relative_time.dart';

/// Screen for managing blocked peers.
class BlockedPeersScreen extends ConsumerWidget {
  const BlockedPeersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final blockedPeers = ref.watch(blockedPeersProvider);
    final peerDetails = ref.watch(blockedPeerDetailsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Blocked Users'),
      ),
      body: blockedPeers.isEmpty
          ? _buildEmptyState(context)
          : _buildBlockedList(context, ref, blockedPeers, peerDetails),
    );
  }

  Widget _buildEmptyState(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.block_outlined,
              size: 64,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 16),
            Text(
              'No blocked users',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Users you block will appear here. Blocked users cannot send you messages or see when you\'re online.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBlockedList(
    BuildContext context,
    WidgetRef ref,
    Set<String> blockedPeers,
    Map<String, String> peerDetails,
  ) {
    final blockedList = blockedPeers.toList();
    final notifier = ref.watch(blockedPeersProvider.notifier);

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: blockedList.length,
      itemBuilder: (context, index) {
        final peerId = blockedList[index];
        final displayName = peerDetails[peerId] ?? 'Unknown User';
        final blockedAt = notifier.getBlockedAt(peerId);

        return Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: ListTile(
            leading: CircleAvatar(
              backgroundColor: Theme.of(context).colorScheme.errorContainer,
              child: Icon(
                Icons.person_off,
                color: Theme.of(context).colorScheme.onErrorContainer,
              ),
            ),
            title: Text(displayName),
            subtitle: Text(
              blockedAt != null
                  ? 'Blocked ${formatRelativeTime(blockedAt)}'
                  : 'Blocked',
              style: TextStyle(
                color: Theme.of(context).colorScheme.error,
                fontSize: 12,
              ),
            ),
            trailing: PopupMenuButton<String>(
              onSelected: (value) {
                if (value == 'unblock') {
                  _showUnblockDialog(context, ref, peerId, displayName);
                } else if (value == 'remove') {
                  _showRemovePermanentlyDialog(
                      context, ref, peerId, displayName);
                }
              },
              itemBuilder: (context) => [
                const PopupMenuItem(
                  value: 'unblock',
                  child: Row(
                    children: [
                      Icon(Icons.check_circle_outline),
                      SizedBox(width: 8),
                      Text('Unblock'),
                    ],
                  ),
                ),
                const PopupMenuItem(
                  value: 'remove',
                  child: Row(
                    children: [
                      Icon(Icons.delete_forever, color: Colors.red),
                      SizedBox(width: 8),
                      Text('Remove Permanently',
                          style: TextStyle(color: Colors.red)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _showUnblockDialog(
    BuildContext context,
    WidgetRef ref,
    String peerId,
    String displayName,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Unblock User?'),
        content: Text(
          'Unblock $displayName? They will be able to connect to you again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Unblock'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      await ref.read(blockedPeersProvider.notifier).unblock(peerId);
      ref.invalidate(blockedPeerDetailsProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$displayName unblocked')),
        );
      }
    }
  }

  Future<void> _showRemovePermanentlyDialog(
    BuildContext context,
    WidgetRef ref,
    String peerId,
    String displayName,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove Permanently?'),
        content: Text(
          'Remove $displayName permanently? This will unblock them and delete all stored data for this peer. They will need to re-pair to communicate.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      await ref.read(blockedPeersProvider.notifier).removePermanently(peerId);
      ref.invalidate(blockedPeerDetailsProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$displayName removed permanently')),
        );
      }
    }
  }
}
