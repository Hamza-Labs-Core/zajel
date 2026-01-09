import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/models.dart';
import '../../core/providers/app_providers.dart';

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
              loading: () => const Center(child: CircularProgressIndicator()),
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
                  color: Colors.green.shade100,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: const BoxDecoration(
                        color: Colors.green,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 4),
                    const Text(
                      'Discovering',
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.green,
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
            'Nearby Devices',
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

    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      itemCount: peers.length,
      itemBuilder: (context, index) {
        final peer = peers[index];
        return _PeerCard(peer: peer);
      },
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
                peer.isLocal ? Icons.computer : Icons.public,
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
        title: Text(peer.displayName),
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
                if (value == 'block') {
                  _showBlockDialog(context, ref);
                }
              },
              itemBuilder: (context) => [
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
        onTap: isConnected
            ? () {
                ref.read(selectedPeerProvider.notifier).state = peer;
                context.push('/chat/${peer.id}');
              }
            : null,
      ),
    );
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
      await ref.read(blockedPeersProvider.notifier).block(
            peer.id,
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
        return peer.isLocal ? 'On local network' : 'External peer';
    }
  }

  Future<void> _connect(BuildContext context, WidgetRef ref) async {
    final connectionManager = ref.read(connectionManagerProvider);
    try {
      if (peer.isLocal) {
        await connectionManager.connectToLocalPeer(peer.id);
      } else {
        await connectionManager.connectToExternalPeer(peer.id);
      }
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
      // Handle error
    }
  }
}
