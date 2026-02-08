import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/models.dart';
import '../../core/providers/app_providers.dart';
import '../../shared/widgets/relative_time.dart';

/// Home screen showing discovered peers and connection options.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final peersAsync = ref.watch(visiblePeersProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Zajel'),
        actions: [
          IconButton(
            icon: const Icon(Icons.contacts),
            onPressed: () => context.push('/contacts'),
            tooltip: 'Contacts',
          ),
          IconButton(
            icon: const Icon(Icons.qr_code_scanner),
            onPressed: () => context.push('/connect'),
            tooltip: 'Connect to peer',
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () => context.push('/settings'),
            tooltip: 'Settings',
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildHeader(context, ref),
          Expanded(
            child: peersAsync.when(
              data: (peers) => _buildPeerList(context, ref, peers),
              loading: () => _buildPeerList(context, ref, []),
              error: (e, _) => Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.error_outline,
                        size: 48, color: Theme.of(context).colorScheme.error),
                    const SizedBox(height: 16),
                    Text('Error: $e'),
                    const SizedBox(height: 16),
                    ElevatedButton(
                      onPressed: () => ref.refresh(peersProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/connect'),
        icon: const Icon(Icons.add),
        label: const Text('Connect'),
      ),
    );
  }

  Widget _buildHeader(BuildContext context, WidgetRef ref) {
    final displayName = ref.watch(displayNameProvider);
    final pairingCode = ref.watch(pairingCodeProvider);
    final signalingState = ref.watch(signalingDisplayStateProvider);

    // Determine status indicator based on signaling connection state
    final (statusColor, statusBgColor, statusText) = switch (signalingState) {
      SignalingDisplayState.connected => (Colors.green, Colors.green.shade100, 'Online'),
      SignalingDisplayState.connecting => (Colors.orange, Colors.orange.shade100, 'Connecting...'),
      SignalingDisplayState.disconnected => (Colors.red, Colors.red.shade100, 'Offline'),
    };

    return Container(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                child: Text(
                  displayName.isNotEmpty ? displayName[0].toUpperCase() : '?',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onPrimaryContainer,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      displayName,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    if (pairingCode != null)
                      Text(
                        'Code: $pairingCode',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: Theme.of(context).colorScheme.primary,
                            ),
                      ),
                  ],
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: statusBgColor,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: statusColor,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      statusText,
                      style: TextStyle(
                        fontSize: 12,
                        color: statusColor,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Text(
            'Connected Peers',
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
        ],
      ),
    );
  }

  Widget _buildPeerList(
      BuildContext context, WidgetRef ref, List<Peer> peers) {
    if (peers.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.devices_other,
                size: 64,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 16),
              Text(
                'No devices found',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                'Make sure other devices with Zajel are on the same network',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
              const SizedBox(height: 24),
              OutlinedButton.icon(
                onPressed: () => context.push('/connect'),
                icon: const Icon(Icons.qr_code),
                label: const Text('Connect via QR code'),
              ),
            ],
          ),
        ),
      );
    }

    // Split into online and offline groups
    final onlinePeers = peers.where((p) =>
        p.connectionState == PeerConnectionState.connected ||
        p.connectionState == PeerConnectionState.connecting ||
        p.connectionState == PeerConnectionState.handshaking).toList();
    final offlinePeers = peers.where((p) =>
        p.connectionState == PeerConnectionState.disconnected ||
        p.connectionState == PeerConnectionState.failed ||
        p.connectionState == PeerConnectionState.discovering).toList();

    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      children: [
        if (onlinePeers.isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              'Online (${onlinePeers.length})',
              style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    color: Colors.green,
                    fontWeight: FontWeight.w600,
                  ),
            ),
          ),
          for (final peer in onlinePeers) _PeerCard(peer: peer),
        ],
        if (offlinePeers.isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              'Offline (${offlinePeers.length})',
              style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    color: Colors.grey,
                    fontWeight: FontWeight.w600,
                  ),
            ),
          ),
          for (final peer in offlinePeers) _PeerCard(peer: peer),
        ],
      ],
    );
  }
}

class _PeerCard extends ConsumerWidget {
  final Peer peer;

  const _PeerCard({required this.peer});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isConnected =
        peer.connectionState == PeerConnectionState.connected;
    final isConnecting =
        peer.connectionState == PeerConnectionState.connecting ||
        peer.connectionState == PeerConnectionState.handshaking;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: Stack(
          children: [
            CircleAvatar(
              backgroundColor: isConnected
                  ? Colors.green.shade100
                  : Theme.of(context).colorScheme.surfaceContainerHighest,
              child: Icon(
                Icons.person,
                color: isConnected
                    ? Colors.green
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            Positioned(
              right: 0,
              bottom: 0,
              child: Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: _getStatusColor(),
                  shape: BoxShape.circle,
                  border: Border.all(color: Colors.white, width: 2),
                ),
              ),
            ),
          ],
        ),
        title: Text(_displayName(ref)),
        subtitle: Text(
          _getStatusText(),
          style: TextStyle(
            color: isConnected ? Colors.green : null,
          ),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (isConnecting) ...[
              const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: () => _cancelConnection(ref),
                child: const Text('Cancel'),
              ),
            ] else if (isConnected)
              IconButton(
                icon: const Icon(Icons.chat),
                onPressed: () {
                  ref.read(selectedPeerProvider.notifier).state = peer;
                  context.push('/chat/${peer.id}');
                },
              )
            else
              TextButton(
                onPressed: () => _connect(context, ref),
                child: const Text('Connect'),
              ),
            PopupMenuButton<String>(
              icon: const Icon(Icons.more_vert),
              onSelected: (value) {
                switch (value) {
                  case 'rename':
                    _showRenameDialog(context, ref);
                  case 'delete':
                    _showDeleteDialog(context, ref);
                  case 'block':
                    _showBlockDialog(context, ref);
                }
              },
              itemBuilder: (context) => [
                const PopupMenuItem(
                  value: 'rename',
                  child: Row(
                    children: [
                      Icon(Icons.edit),
                      SizedBox(width: 8),
                      Text('Rename'),
                    ],
                  ),
                ),
                const PopupMenuItem(
                  value: 'delete',
                  child: Row(
                    children: [
                      Icon(Icons.delete_outline, color: Colors.red),
                      SizedBox(width: 8),
                      Text('Delete'),
                    ],
                  ),
                ),
                const PopupMenuItem(
                  value: 'block',
                  child: Row(
                    children: [
                      Icon(Icons.block, color: Colors.red),
                      SizedBox(width: 8),
                      Text('Block'),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ),
        onTap: () {
          ref.read(selectedPeerProvider.notifier).state = peer;
          context.push('/chat/${peer.id}');
        },
      ),
    );
  }

  String _displayName(WidgetRef ref) {
    final aliases = ref.watch(peerAliasesProvider);
    return aliases[peer.id] ?? peer.displayName;
  }

  Future<void> _showRenameDialog(BuildContext context, WidgetRef ref) async {
    final controller = TextEditingController(text: _displayName(ref));
    final newName = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename Peer'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Name',
            border: OutlineInputBorder(),
          ),
          onSubmitted: (value) => Navigator.pop(context, value.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );

    if (newName != null && newName.isNotEmpty && newName != _displayName(ref)) {
      final trustedPeers = ref.read(trustedPeersStorageProvider);
      await trustedPeers.updateAlias(peer.id, newName);
      // Update in-memory alias map for immediate UI refresh
      final aliases = {...ref.read(peerAliasesProvider)};
      aliases[peer.id] = newName;
      ref.read(peerAliasesProvider.notifier).state = aliases;
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Renamed to $newName')),
        );
      }
    }
  }

  Future<void> _showDeleteDialog(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Connection?'),
        content: Text(
          'Delete ${peer.displayName}? This will remove the conversation and connection.',
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
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      final trustedPeers = ref.read(trustedPeersStorageProvider);
      await trustedPeers.removePeer(peer.id);
      ref.read(chatMessagesProvider(peer.id).notifier).clearMessages();
      final connectionManager = ref.read(connectionManagerProvider);
      try {
        await connectionManager.disconnectPeer(peer.id);
      } catch (_) {
        // Best-effort disconnect
      }
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${peer.displayName} deleted')),
        );
      }
    }
  }

  Future<void> _showBlockDialog(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Block User?'),
        content: Text(
          'Block ${peer.displayName}? They won\'t be able to connect to you.',
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
            child: const Text('Block'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      final keyToBlock = peer.publicKey ?? peer.id;
      await ref.read(blockedPeersProvider.notifier).block(
            keyToBlock,
            displayName: peer.displayName,
          );
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${peer.displayName} blocked')),
        );
      }
    }
  }

  Color _getStatusColor() {
    switch (peer.connectionState) {
      case PeerConnectionState.connected:
        return Colors.green;
      case PeerConnectionState.connecting:
      case PeerConnectionState.handshaking:
        return Colors.orange;
      case PeerConnectionState.failed:
        return Colors.red;
      default:
        return Colors.grey;
    }
  }

  String _getStatusText() {
    switch (peer.connectionState) {
      case PeerConnectionState.connected:
        return 'Connected';
      case PeerConnectionState.connecting:
        return 'Connecting...';
      case PeerConnectionState.handshaking:
        return 'Securing connection...';
      case PeerConnectionState.failed:
        return 'Connection failed';
      default:
        return 'Last seen ${formatRelativeTime(peer.lastSeen)}';
    }
  }

  Future<void> _connect(BuildContext context, WidgetRef ref) async {
    final connectionManager = ref.read(connectionManagerProvider);
    try {
      await connectionManager.connectToPeer(peer.id);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Connection failed: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  Future<void> _cancelConnection(WidgetRef ref) async {
    final connectionManager = ref.read(connectionManagerProvider);
    try {
      await connectionManager.cancelConnection(peer.id);
    } catch (e) {
      // Intentionally silenced: Cancel is a best-effort operation.
      // UI state is already updated regardless of cancel success.
      // Errors are logged in ConnectionManager for debugging.
    }
  }
}
