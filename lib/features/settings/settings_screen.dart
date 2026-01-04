import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/providers/app_providers.dart';

/// Settings screen for app configuration.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _displayNameController = TextEditingController();
  final _serverUrlController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _displayNameController.text = ref.read(displayNameProvider);
    _serverUrlController.text = ref.read(signalingServerUrlProvider);
  }

  @override
  void dispose() {
    _displayNameController.dispose();
    _serverUrlController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final displayName = ref.watch(displayNameProvider);
    final externalEnabled = ref.watch(externalConnectionEnabledProvider);
    final pairingCode = ref.watch(pairingCodeProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _buildSection(
            context,
            title: 'Profile',
            children: [
              _buildProfileTile(displayName),
            ],
          ),
          const SizedBox(height: 24),
          _buildSection(
            context,
            title: 'Privacy & Security',
            children: [
              ListTile(
                leading: const Icon(Icons.lock),
                title: const Text('End-to-End Encryption'),
                subtitle: const Text('Always enabled'),
                trailing: Icon(
                  Icons.check_circle,
                  color: Colors.green.shade700,
                ),
              ),
              ListTile(
                leading: const Icon(Icons.refresh),
                title: const Text('Regenerate Keys'),
                subtitle: const Text(
                  'Create new encryption keys (disconnects all peers)',
                ),
                onTap: () => _showRegenerateKeysDialog(context),
              ),
              SwitchListTile(
                secondary: const Icon(Icons.delete_sweep),
                title: const Text('Auto-delete Messages'),
                subtitle: const Text('Delete messages after 24 hours'),
                value: false, // TODO: Implement
                onChanged: (value) {
                  // TODO: Implement auto-delete
                },
              ),
            ],
          ),
          const SizedBox(height: 24),
          _buildSection(
            context,
            title: 'External Connections',
            children: [
              SwitchListTile(
                secondary: const Icon(Icons.public),
                title: const Text('Enable External Connections'),
                subtitle: Text(
                  externalEnabled
                      ? 'Code: ${pairingCode ?? "Generating..."}'
                      : 'Connect to peers outside local network',
                ),
                value: externalEnabled,
                onChanged: (value) => _toggleExternalConnections(value),
              ),
              ListTile(
                leading: const Icon(Icons.dns),
                title: const Text('Signaling Server'),
                subtitle: Text(ref.watch(signalingServerUrlProvider)),
                onTap: () => _showServerUrlDialog(context),
              ),
            ],
          ),
          const SizedBox(height: 24),
          _buildSection(
            context,
            title: 'About',
            children: [
              const ListTile(
                leading: Icon(Icons.info_outline),
                title: Text('Version'),
                subtitle: Text('1.0.0'),
              ),
              ListTile(
                leading: const Icon(Icons.code),
                title: const Text('Source Code'),
                subtitle: const Text('Open source and auditable'),
                onTap: () {
                  // TODO: Open GitHub link
                },
              ),
              ListTile(
                leading: const Icon(Icons.privacy_tip_outlined),
                title: const Text('Privacy Policy'),
                subtitle: const Text('Your data stays on your device'),
                onTap: () {
                  // TODO: Show privacy policy
                },
              ),
            ],
          ),
          const SizedBox(height: 32),
          Center(
            child: TextButton.icon(
              icon: const Icon(Icons.delete_forever, color: Colors.red),
              label: const Text(
                'Clear All Data',
                style: TextStyle(color: Colors.red),
              ),
              onPressed: () => _showClearDataDialog(context),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSection(
    BuildContext context, {
    required String title,
    required List<Widget> children,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Text(
            title,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: Theme.of(context).colorScheme.primary,
                  fontWeight: FontWeight.w600,
                ),
          ),
        ),
        Card(
          child: Column(
            children: children,
          ),
        ),
      ],
    );
  }

  Widget _buildProfileTile(String displayName) {
    return ListTile(
      leading: CircleAvatar(
        backgroundColor: Theme.of(context).colorScheme.primaryContainer,
        child: Text(
          displayName.isNotEmpty ? displayName[0].toUpperCase() : '?',
          style: TextStyle(
            color: Theme.of(context).colorScheme.onPrimaryContainer,
          ),
        ),
      ),
      title: Text(displayName),
      subtitle: const Text('Tap to change display name'),
      trailing: const Icon(Icons.edit),
      onTap: () => _showDisplayNameDialog(context),
    );
  }

  Future<void> _showDisplayNameDialog(BuildContext context) async {
    _displayNameController.text = ref.read(displayNameProvider);

    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Display Name'),
        content: TextField(
          controller: _displayNameController,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: 'Enter your display name',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              Navigator.pop(context, _displayNameController.text);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );

    if (result != null && result.isNotEmpty) {
      ref.read(displayNameProvider.notifier).state = result;
      final prefs = ref.read(sharedPreferencesProvider);
      await prefs.setString('displayName', result);
    }
  }

  Future<void> _showServerUrlDialog(BuildContext context) async {
    _serverUrlController.text = ref.read(signalingServerUrlProvider);

    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Signaling Server'),
        content: TextField(
          controller: _serverUrlController,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: 'wss://your-server.com',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              Navigator.pop(context, _serverUrlController.text);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );

    if (result != null && result.isNotEmpty) {
      ref.read(signalingServerUrlProvider.notifier).state = result;
      final prefs = ref.read(sharedPreferencesProvider);
      await prefs.setString('signalingServerUrl', result);
    }
  }

  Future<void> _toggleExternalConnections(bool enabled) async {
    final connectionManager = ref.read(connectionManagerProvider);

    if (enabled) {
      try {
        final serverUrl = ref.read(signalingServerUrlProvider);
        final code = await connectionManager.enableExternalConnections(
          serverUrl: serverUrl,
        );
        ref.read(pairingCodeProvider.notifier).state = code;
        ref.read(externalConnectionEnabledProvider.notifier).state = true;
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to enable: $e')),
          );
        }
      }
    } else {
      await connectionManager.disableExternalConnections();
      ref.read(externalConnectionEnabledProvider.notifier).state = false;
      ref.read(pairingCodeProvider.notifier).state = null;
    }
  }

  Future<void> _showRegenerateKeysDialog(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Regenerate Keys?'),
        content: const Text(
          'This will create new encryption keys and disconnect all peers. '
          'You will need to reconnect to everyone. Continue?',
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
            child: const Text('Regenerate'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      final cryptoService = ref.read(cryptoServiceProvider);
      await cryptoService.regenerateIdentityKeys();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Keys regenerated')),
        );
      }
    }
  }

  Future<void> _showClearDataDialog(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear All Data?'),
        content: const Text(
          'This will delete all messages, contacts, and keys. '
          'This action cannot be undone. Continue?',
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
            child: const Text('Clear All'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      final cryptoService = ref.read(cryptoServiceProvider);
      await cryptoService.clearAllSessions();
      await cryptoService.regenerateIdentityKeys();

      final prefs = await SharedPreferences.getInstance();
      await prefs.clear();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('All data cleared')),
        );
      }
    }
  }
}
