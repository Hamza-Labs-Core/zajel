import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/logging/logger_service.dart';
import '../../core/providers/app_providers.dart';

/// Settings screen for app configuration.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _usernameController = TextEditingController();
  final _serverUrlController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _usernameController.text = ref.read(usernameProvider);
    _serverUrlController.text = ref.read(bootstrapServerUrlProvider);
  }

  @override
  void dispose() {
    _usernameController.dispose();
    _serverUrlController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final identity = ref.watch(userIdentityProvider);
    final externalEnabled = ref.watch(signalingConnectedProvider);
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
              _buildProfileTile(identity),
            ],
          ),
          const SizedBox(height: 24),
          _buildAppearanceSection(context),
          const SizedBox(height: 24),
          _buildSection(
            context,
            title: 'Notifications',
            children: [
              ListTile(
                leading: const Icon(Icons.notifications),
                title: const Text('Notifications'),
                subtitle: const Text('DND, sounds, and per-peer mute'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/settings/notifications'),
              ),
            ],
          ),
          const SizedBox(height: 24),
          _buildSection(
            context,
            title: 'Audio & Video',
            children: [
              ListTile(
                leading: const Icon(Icons.videocam),
                title: const Text('Audio & Video'),
                subtitle: const Text('Microphone, speaker, camera settings'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/settings/media'),
              ),
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
              ListTile(
                leading: const Icon(Icons.block),
                title: const Text('Blocked Users'),
                subtitle: const Text('Manage blocked peers'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/settings/blocked'),
              ),
            ],
          ),
          const SizedBox(height: 24),
          _buildSection(
            context,
            title: 'External Connections',
            children: [
              ListTile(
                leading: Icon(
                  externalEnabled ? Icons.cloud_done : Icons.cloud_off,
                  color: externalEnabled ? Colors.green : Colors.grey,
                ),
                title: Text(externalEnabled ? 'Connected' : 'Connecting...'),
                subtitle: Text(
                  externalEnabled
                      ? 'Pairing Code: ${pairingCode ?? "..."}'
                      : 'Establishing connection to signaling server',
                ),
              ),
              _buildSelectedServerTile(),
              ListTile(
                leading: const Icon(Icons.dns),
                title: const Text('Bootstrap Server'),
                subtitle: Text(ref.watch(bootstrapServerUrlProvider)),
                onTap: () => _showBootstrapUrlDialog(context),
              ),
            ],
          ),
          const SizedBox(height: 24),
          _buildSection(
            context,
            title: 'Debugging',
            children: [
              ListTile(
                leading: const Icon(Icons.description),
                title: const Text('Export Logs'),
                subtitle: Text(
                  logger.logDirectoryPath ?? 'Logs not initialized',
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: const Icon(Icons.share),
                onTap: () => _exportLogs(context),
              ),
              ListTile(
                leading: const Icon(Icons.visibility),
                title: const Text('View Logs'),
                subtitle: const Text('View recent log entries'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _showLogViewer(context),
              ),
              ListTile(
                leading: const Icon(Icons.delete_outline),
                title: const Text('Clear Logs'),
                subtitle: const Text('Delete all log files'),
                onTap: () => _showClearLogsDialog(context),
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
                trailing: const Icon(Icons.open_in_new),
                onTap: () =>
                    _launchUrl('https://github.com/Hamza-Labs-Core/zajel'),
              ),
              ListTile(
                leading: const Icon(Icons.privacy_tip_outlined),
                title: const Text('Privacy Policy'),
                subtitle: const Text('Your data stays on your device'),
                trailing: const Icon(Icons.open_in_new),
                onTap: () => _launchUrl(
                  'https://github.com/Hamza-Labs-Core/zajel/blob/main/PRIVACY.md',
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          _buildSection(
            context,
            title: 'Help & Info',
            children: [
              ListTile(
                leading: const Icon(Icons.help_outline),
                title: const Text('How Zajel Works'),
                subtitle:
                    const Text('Learn about P2P messaging and encryption'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/help'),
              ),
              ListTile(
                leading: const Icon(Icons.build),
                title: const Text('Troubleshooting'),
                subtitle: const Text('Solutions for common issues'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/help/troubleshooting'),
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

  Widget _buildAppearanceSection(BuildContext context) {
    final themeMode = ref.watch(themeModeProvider);

    return _buildSection(
      context,
      title: 'Appearance',
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Theme'),
              const SizedBox(height: 8),
              SegmentedButton<ThemeMode>(
                segments: const [
                  ButtonSegment(
                    value: ThemeMode.light,
                    label: Text('Light'),
                    icon: Icon(Icons.light_mode),
                  ),
                  ButtonSegment(
                    value: ThemeMode.dark,
                    label: Text('Dark'),
                    icon: Icon(Icons.dark_mode),
                  ),
                  ButtonSegment(
                    value: ThemeMode.system,
                    label: Text('System'),
                    icon: Icon(Icons.settings_brightness),
                  ),
                ],
                selected: {themeMode},
                onSelectionChanged: (selected) {
                  ref
                      .read(themeModeProvider.notifier)
                      .setThemeMode(selected.first);
                },
              ),
            ],
          ),
        ),
      ],
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

  Widget _buildProfileTile(String identity) {
    return ListTile(
      leading: CircleAvatar(
        backgroundColor: Theme.of(context).colorScheme.primaryContainer,
        child: Text(
          identity.isNotEmpty ? identity[0].toUpperCase() : '?',
          style: TextStyle(
            color: Theme.of(context).colorScheme.onPrimaryContainer,
          ),
        ),
      ),
      title: Text(identity),
      subtitle: const Text('Tap to change username. Your #TAG is derived from your encryption key.'),
      trailing: const Icon(Icons.edit),
      onTap: () => _showUsernameDialog(context),
    );
  }

  Future<void> _showUsernameDialog(BuildContext context) async {
    _usernameController.text = ref.read(usernameProvider);

    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Username'),
        content: TextField(
          controller: _usernameController,
          autofocus: true,
          maxLength: 32,
          decoration: const InputDecoration(
            hintText: 'Enter your username',
            counterText: '',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              final text = _usernameController.text.trim();
              if (text.isNotEmpty && !text.contains('#')) {
                Navigator.pop(context, text);
              }
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );

    if (result != null && result.isNotEmpty) {
      ref.read(usernameProvider.notifier).state = result;
      final prefs = ref.read(sharedPreferencesProvider);
      await prefs.setString('username', result);
    }
  }

  Widget _buildSelectedServerTile() {
    final selectedServer = ref.watch(selectedServerProvider);
    final externalEnabled = ref.watch(signalingConnectedProvider);

    if (!externalEnabled || selectedServer == null) {
      return const SizedBox.shrink();
    }

    return ListTile(
      leading: const Icon(Icons.cloud_done),
      title: const Text('Connected Server'),
      subtitle: Text(
        '${selectedServer.region} - ${selectedServer.endpoint}',
        overflow: TextOverflow.ellipsis,
      ),
    );
  }

  Future<void> _showBootstrapUrlDialog(BuildContext context) async {
    _serverUrlController.text = ref.read(bootstrapServerUrlProvider);

    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Bootstrap Server'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'The bootstrap server helps discover available VPS servers. '
              'Only change this if you know what you\'re doing.',
              style: TextStyle(fontSize: 12),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _serverUrlController,
              autofocus: true,
              decoration: const InputDecoration(
                hintText: 'https://bootstrap.example.com',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              _serverUrlController.text = defaultBootstrapUrl;
            },
            child: const Text('Reset'),
          ),
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
      ref.read(bootstrapServerUrlProvider.notifier).state = result;
      final prefs = ref.read(sharedPreferencesProvider);
      await prefs.setString('bootstrapServerUrl', result);
    }
  }

  Future<void> _showRegenerateKeysDialog(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Regenerate Keys?'),
        content: const Text(
          'This will create a new identity. All existing peers will no longer '
          'recognize you and connections will be severed. You will need to '
          're-pair with everyone. Your contacts will no longer be able to '
          'reach you at your current identity. Continue?',
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

      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Keys regenerated')),
      );
    }
  }

  Future<void> _launchUrl(String urlString) async {
    final url = Uri.parse(urlString);
    final messenger = ScaffoldMessenger.of(context);
    if (await canLaunchUrl(url)) {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } else {
      messenger.showSnackBar(
        SnackBar(content: Text('Could not open $urlString')),
      );
    }
  }

  Future<void> _showClearDataDialog(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear All Data?'),
        content: const Text(
          'This will permanently destroy your identity, all messages, contacts, '
          'and encryption keys. Your contacts will no longer be able to reach '
          'you. You will need to re-pair with everyone. This action cannot be '
          'undone.',
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

      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('All data cleared')),
      );
    }
  }

  Future<void> _exportLogs(BuildContext context) async {
    try {
      // Show loading indicator
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Row(
            children: [
              SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              SizedBox(width: 12),
              Text('Preparing logs...'),
            ],
          ),
          duration: Duration(seconds: 1),
        ),
      );

      await logger.exportLogs();
      logger.info('Settings', 'Logs exported successfully');
    } catch (e) {
      logger.error('Settings', 'Failed to export logs', e);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed to export logs: $e'),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  Future<void> _showLogViewer(BuildContext context) async {
    final logContent = await logger.getCurrentLogContent();

    if (!context.mounted) return;

    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.7,
        minChildSize: 0.3,
        maxChildSize: 0.95,
        expand: false,
        builder: (context, scrollController) => Column(
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surface,
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(16),
                ),
              ),
              child: Row(
                children: [
                  const Icon(Icons.description),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Text(
                      'Log Viewer',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: SingleChildScrollView(
                controller: scrollController,
                padding: const EdgeInsets.all(16),
                child: SelectableText(
                  logContent.isEmpty ? 'No logs available' : logContent,
                  style: TextStyle(
                    fontFamily: Platform.isIOS || Platform.isMacOS
                        ? 'Menlo'
                        : 'monospace',
                    fontSize: 11,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showClearLogsDialog(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear Logs?'),
        content: const Text(
          'This will delete all log files. This action cannot be undone.',
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
            child: const Text('Clear'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      await logger.clearLogs();

      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Logs cleared')),
      );
    }
  }
}
