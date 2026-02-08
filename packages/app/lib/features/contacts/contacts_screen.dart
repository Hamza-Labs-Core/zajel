import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/models.dart';
import '../../core/providers/app_providers.dart';
import '../../core/storage/trusted_peers_storage.dart';
import '../../shared/widgets/relative_time.dart';

/// Provider for all trusted peers as contacts.
final contactsProvider = FutureProvider<List<TrustedPeer>>((ref) async {
  final storage = ref.watch(trustedPeersStorageProvider);
  final peers = await storage.getAllPeers();
  return peers.where((p) => !p.isBlocked).toList()
    ..sort((a, b) {
      final aName = a.alias ?? a.displayName;
      final bName = b.alias ?? b.displayName;
      return aName.toLowerCase().compareTo(bName.toLowerCase());
    });
});

/// Contacts screen showing all trusted peers.
class ContactsScreen extends ConsumerStatefulWidget {
  const ContactsScreen({super.key});

  @override
  ConsumerState<ContactsScreen> createState() => _ContactsScreenState();
}

class _ContactsScreenState extends ConsumerState<ContactsScreen> {
  String _searchQuery = '';

  @override
  Widget build(BuildContext context) {
    final contactsAsync = ref.watch(contactsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Contacts'),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: InputDecoration(
                hintText: 'Search contacts...',
                prefixIcon: const Icon(Icons.search),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                contentPadding: const EdgeInsets.symmetric(horizontal: 16),
              ),
              onChanged: (value) => setState(() => _searchQuery = value),
            ),
          ),
          Expanded(
            child: contactsAsync.when(
              data: (contacts) {
                final filtered = _searchQuery.isEmpty
                    ? contacts
                    : contacts.where((c) {
                        final name = (c.alias ?? c.displayName).toLowerCase();
                        return name.contains(_searchQuery.toLowerCase());
                      }).toList();

                if (filtered.isEmpty) {
                  return Center(
                    child: Text(
                      _searchQuery.isEmpty ? 'No contacts yet' : 'No matches',
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                            color: Theme.of(context).colorScheme.onSurfaceVariant,
                          ),
                    ),
                  );
                }

                return ListView.builder(
                  itemCount: filtered.length,
                  itemBuilder: (context, index) {
                    final contact = filtered[index];
                    return _ContactTile(contact: contact);
                  },
                );
              },
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(child: Text('Error: $e')),
            ),
          ),
        ],
      ),
    );
  }
}

class _ContactTile extends ConsumerWidget {
  final TrustedPeer contact;

  const _ContactTile({required this.contact});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final displayName = contact.alias ?? contact.displayName;
    final peersAsync = ref.watch(visiblePeersProvider);

    // Check if this contact is currently online
    bool isOnline = false;
    peersAsync.whenData((peers) {
      isOnline = peers.any((p) =>
          p.id == contact.id &&
          p.connectionState == PeerConnectionState.connected);
    });

    return ListTile(
      leading: CircleAvatar(
        backgroundColor: isOnline ? Colors.green.shade100 : Colors.grey.shade200,
        child: Text(
          displayName.isNotEmpty ? displayName[0].toUpperCase() : '?',
          style: TextStyle(
            color: isOnline ? Colors.green : Colors.grey,
          ),
        ),
      ),
      title: Text(displayName),
      subtitle: Text(
        isOnline
            ? 'Online'
            : contact.lastSeen != null
                ? 'Last seen ${formatRelativeTime(contact.lastSeen!)}'
                : 'Never connected',
        style: TextStyle(
          color: isOnline ? Colors.green : Colors.grey,
          fontSize: 12,
        ),
      ),
      trailing: isOnline
          ? Container(
              width: 10,
              height: 10,
              decoration: const BoxDecoration(
                color: Colors.green,
                shape: BoxShape.circle,
              ),
            )
          : null,
      onTap: () {
        // Set selected peer and navigate to chat
        peersAsync.whenData((peers) {
          final peer = peers.where((p) => p.id == contact.id).firstOrNull;
          if (peer != null) {
            ref.read(selectedPeerProvider.notifier).state = peer;
          }
        });
        context.push('/chat/${contact.id}');
      },
      onLongPress: () => context.push('/contacts/${contact.id}'),
    );
  }
}
