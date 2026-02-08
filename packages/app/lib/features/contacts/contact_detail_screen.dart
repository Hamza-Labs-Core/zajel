import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers/app_providers.dart';
import '../../core/storage/trusted_peers_storage.dart';
import '../../shared/widgets/relative_time.dart';

/// Detail screen for a single contact, allowing edit alias, notes, block/remove.
class ContactDetailScreen extends ConsumerStatefulWidget {
  final String peerId;

  const ContactDetailScreen({super.key, required this.peerId});

  @override
  ConsumerState<ContactDetailScreen> createState() => _ContactDetailScreenState();
}

class _ContactDetailScreenState extends ConsumerState<ContactDetailScreen> {
  final _aliasController = TextEditingController();
  TrustedPeer? _peer;
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadPeer();
  }

  Future<void> _loadPeer() async {
    final storage = ref.read(trustedPeersStorageProvider);
    final peer = await storage.getPeer(widget.peerId);
    if (mounted) {
      setState(() {
        _peer = peer;
        _aliasController.text = peer?.alias ?? '';
        _isLoading = false;
      });
    }
  }

  @override
  void dispose() {
    _aliasController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return Scaffold(
        appBar: AppBar(title: const Text('Contact')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    if (_peer == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Contact')),
        body: const Center(child: Text('Contact not found')),
      );
    }

    final peer = _peer!;
    final displayName = peer.alias ?? peer.displayName;

    return Scaffold(
      appBar: AppBar(
        title: Text(displayName),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Avatar and name
          Center(
            child: Column(
              children: [
                CircleAvatar(
                  radius: 48,
                  backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                  child: Text(
                    displayName.isNotEmpty ? displayName[0].toUpperCase() : '?',
                    style: TextStyle(
                      fontSize: 36,
                      color: Theme.of(context).colorScheme.onPrimaryContainer,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  displayName,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                if (peer.alias != null)
                  Text(
                    peer.displayName,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Colors.grey,
                        ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // Alias field
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Alias',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          color: Theme.of(context).colorScheme.primary,
                        ),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _aliasController,
                    decoration: const InputDecoration(
                      hintText: 'Set a custom name...',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      if (peer.alias != null)
                        TextButton(
                          onPressed: _clearAlias,
                          child: const Text('Clear'),
                        ),
                      const SizedBox(width: 8),
                      ElevatedButton(
                        onPressed: _saveAlias,
                        child: const Text('Save'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Connection info
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.fingerprint),
                  title: const Text('Peer ID'),
                  subtitle: Text(
                    peer.id,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                  ),
                ),
                ListTile(
                  leading: const Icon(Icons.access_time),
                  title: const Text('Trusted Since'),
                  subtitle: Text(formatRelativeTime(peer.trustedAt)),
                ),
                if (peer.lastSeen != null)
                  ListTile(
                    leading: const Icon(Icons.schedule),
                    title: const Text('Last Seen'),
                    subtitle: Text(formatRelativeTime(peer.lastSeen!)),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // Actions
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.block, color: Colors.orange),
                  title: const Text('Block Contact'),
                  subtitle: const Text('Prevent this peer from connecting'),
                  onTap: () => _blockContact(context),
                ),
                ListTile(
                  leading: const Icon(Icons.delete_forever, color: Colors.red),
                  title: const Text('Remove Permanently'),
                  subtitle: const Text('Delete from trusted peers'),
                  onTap: () => _removePermanently(context),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _saveAlias() async {
    final alias = _aliasController.text.trim();
    final storage = ref.read(trustedPeersStorageProvider);
    await storage.updateAlias(widget.peerId, alias.isEmpty ? null : alias);
    await _loadPeer();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Alias saved')),
      );
    }
  }

  Future<void> _clearAlias() async {
    final storage = ref.read(trustedPeersStorageProvider);
    await storage.updateAlias(widget.peerId, null);
    _aliasController.clear();
    await _loadPeer();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Alias cleared')),
      );
    }
  }

  Future<void> _blockContact(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Block Contact?'),
        content: Text(
          'Block ${_peer?.alias ?? _peer?.displayName}? They won\'t be able to connect.',
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

    if (confirmed == true && _peer != null) {
      await ref.read(blockedPeersProvider.notifier).block(
            _peer!.publicKey,
            displayName: _peer!.alias ?? _peer!.displayName,
          );
      if (mounted) {
        context.go('/contacts');
      }
    }
  }

  Future<void> _removePermanently(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove Permanently?'),
        content: const Text(
          'This will permanently delete this contact. You will need to re-pair to communicate again. This cannot be undone.',
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
      final storage = ref.read(trustedPeersStorageProvider);
      await storage.removePeer(widget.peerId);
      if (mounted) {
        context.go('/contacts');
      }
    }
  }
}
