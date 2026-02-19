import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/models.dart';
import '../../core/providers/app_providers.dart';
import '../../core/utils/identity_utils.dart';
import '../../shared/widgets/relative_time.dart';
import '../chat/chat_screen.dart';

/// Breakpoint for switching between narrow (phone) and wide (desktop) layout.
const double _wideBreakpoint = 720;

/// Width of the conversation sidebar in wide mode.
const double _sidebarWidth = 320;

/// Responsive main layout: sidebar + chat on wide screens, full-screen nav on narrow.
class MainLayout extends ConsumerWidget {
  final Widget child;

  const MainLayout({super.key, required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final isWide = constraints.maxWidth >= _wideBreakpoint;

        if (isWide) {
          return _WideLayout(child: child);
        }

        // Narrow: just show the child (full-screen navigation)
        return child;
      },
    );
  }
}

class _WideLayout extends ConsumerWidget {
  final Widget child;

  const _WideLayout({required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedPeer = ref.watch(selectedPeerProvider);

    return Scaffold(
      body: Row(
        children: [
          // Sidebar
          SizedBox(
            width: _sidebarWidth,
            child: _ConversationSidebar(selectedPeerId: selectedPeer?.id),
          ),
          const VerticalDivider(width: 1, thickness: 1),
          // Chat area
          Expanded(
            child: selectedPeer != null
                ? ChatScreen(
                    key: ValueKey(selectedPeer.id),
                    peerId: selectedPeer.id,
                    embedded: true,
                  )
                : _EmptyChatPlaceholder(),
          ),
        ],
      ),
    );
  }
}

class _EmptyChatPlaceholder extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.chat_bubble_outline,
            size: 64,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 16),
          Text(
            'Select a conversation',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 8),
          Text(
            'Choose a peer from the sidebar to start chatting',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
        ],
      ),
    );
  }
}

class _ConversationSidebar extends ConsumerWidget {
  final String? selectedPeerId;

  const _ConversationSidebar({this.selectedPeerId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final peersAsync = ref.watch(visiblePeersProvider);
    final identity = ref.watch(userIdentityProvider);
    final pairingCode = ref.watch(pairingCodeProvider);
    final signalingState = ref.watch(signalingDisplayStateProvider);

    return Column(
      children: [
        // Header
        _SidebarHeader(
          displayName: identity,
          pairingCode: pairingCode,
          signalingState: signalingState,
          onSettings: () => context.push('/settings'),
          onConnect: () => context.push('/connect'),
          onContacts: () => context.push('/contacts'),
        ),
        const Divider(height: 1),
        // Peer list
        Expanded(
          child: peersAsync.when(
            data: (peers) => _buildPeerList(context, ref, peers),
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Text('Error: $e')),
          ),
        ),
        // Connect FAB
        Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: double.infinity,
            child: FloatingActionButton.extended(
              heroTag: 'sidebar_connect',
              onPressed: () => context.push('/connect'),
              icon: const Icon(Icons.add),
              label: const Text('Connect'),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildPeerList(BuildContext context, WidgetRef ref, List<Peer> peers) {
    if (peers.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.devices_other,
                size: 48,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 12),
              Text(
                'No conversations yet',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
            ],
          ),
        ),
      );
    }

    return ListView.builder(
      itemCount: peers.length,
      itemBuilder: (context, index) {
        final peer = peers[index];
        return _ConversationTile(
          peer: peer,
          isSelected: peer.id == selectedPeerId,
          onTap: () {
            ref.read(selectedPeerProvider.notifier).state = peer;
            // On wide layout, don't navigate — just update selectedPeer
            // But if someone navigates via GoRouter, handle it
          },
        );
      },
    );
  }
}

class _SidebarHeader extends StatelessWidget {
  final String displayName;
  final String? pairingCode;
  final SignalingDisplayState signalingState;
  final VoidCallback onSettings;
  final VoidCallback onConnect;
  final VoidCallback onContacts;

  const _SidebarHeader({
    required this.displayName,
    this.pairingCode,
    required this.signalingState,
    required this.onSettings,
    required this.onConnect,
    required this.onContacts,
  });

  @override
  Widget build(BuildContext context) {
    final (statusColor, statusText) = switch (signalingState) {
      SignalingDisplayState.connected => (Colors.green, 'Online'),
      SignalingDisplayState.connecting => (Colors.orange, 'Connecting...'),
      SignalingDisplayState.disconnected => (Colors.red, 'Offline'),
    };

    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
      child: Row(
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
                  overflow: TextOverflow.ellipsis,
                ),
                Row(
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
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.contacts, size: 20),
            onPressed: onContacts,
            tooltip: 'Contacts',
          ),
          IconButton(
            icon: const Icon(Icons.settings, size: 20),
            onPressed: onSettings,
            tooltip: 'Settings',
          ),
        ],
      ),
    );
  }
}

class _ConversationTile extends ConsumerWidget {
  final Peer peer;
  final bool isSelected;
  final VoidCallback onTap;

  const _ConversationTile({
    required this.peer,
    required this.isSelected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final aliases = ref.watch(peerAliasesProvider);
    final name = resolvePeerDisplayName(peer, alias: aliases[peer.id]);
    final lastMessage = ref.watch(lastMessageProvider(peer.id));
    final isOnline = peer.connectionState == PeerConnectionState.connected;

    return ListTile(
      selected: isSelected,
      selectedTileColor:
          Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.3),
      leading: Stack(
        children: [
          CircleAvatar(
            backgroundColor: isOnline
                ? Colors.green.shade100
                : Theme.of(context).colorScheme.surfaceContainerHighest,
            child: Text(
              name.isNotEmpty ? name[0].toUpperCase() : '?',
              style: TextStyle(
                color: isOnline
                    ? Colors.green.shade800
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Positioned(
            right: 0,
            bottom: 0,
            child: Container(
              width: 12,
              height: 12,
              decoration: BoxDecoration(
                color: isOnline ? Colors.green : Colors.grey,
                shape: BoxShape.circle,
                border: Border.all(
                  color: Theme.of(context).colorScheme.surface,
                  width: 2,
                ),
              ),
            ),
          ),
        ],
      ),
      title: Text(
        name,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w500),
      ),
      subtitle: lastMessage != null
          ? Text(
              lastMessage.type == MessageType.file
                  ? (lastMessage.attachmentName ?? 'File')
                  : lastMessage.content,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            )
          : Text(
              isOnline
                  ? 'Connected'
                  : 'Last seen ${formatRelativeTime(peer.lastSeen)}',
              style: TextStyle(
                fontSize: 13,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
      trailing: lastMessage != null
          ? Text(
              _formatTimeShort(lastMessage.timestamp),
              style: TextStyle(
                fontSize: 11,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            )
          : null,
      onTap: onTap,
    );
  }

  String _formatTimeShort(DateTime time) {
    final now = DateTime.now();
    if (time.year == now.year &&
        time.month == now.month &&
        time.day == now.day) {
      return '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
    }
    return '${time.day}/${time.month}';
  }
}
