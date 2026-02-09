import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/app_providers.dart';

/// Notification settings screen with DND, sound, preview, and per-type toggles.
class NotificationSettingsScreen extends ConsumerWidget {
  const NotificationSettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(notificationSettingsProvider);
    final notifier = ref.watch(notificationSettingsProvider.notifier);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Do Not Disturb section
          _buildSection(
            context,
            title: 'Do Not Disturb',
            children: [
              SwitchListTile(
                secondary: const Icon(Icons.do_not_disturb_on),
                title: const Text('Do Not Disturb'),
                subtitle: Text(
                  settings.isDndActive
                      ? (settings.dndUntil != null
                          ? 'Until ${_formatTime(settings.dndUntil!)}'
                          : 'On indefinitely')
                      : 'Off',
                ),
                value: settings.globalDnd,
                onChanged: (value) => notifier.setGlobalDnd(value),
              ),
              if (settings.globalDnd)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Wrap(
                    spacing: 8,
                    children: [
                      _DndChip(
                        label: '1 hour',
                        onTap: () => notifier.setGlobalDnd(
                          true,
                          until: DateTime.now().add(const Duration(hours: 1)),
                        ),
                      ),
                      _DndChip(
                        label: '4 hours',
                        onTap: () => notifier.setGlobalDnd(
                          true,
                          until: DateTime.now().add(const Duration(hours: 4)),
                        ),
                      ),
                      _DndChip(
                        label: 'Until tomorrow',
                        onTap: () {
                          final tomorrow =
                              DateTime.now().add(const Duration(days: 1));
                          final morning = DateTime(
                              tomorrow.year, tomorrow.month, tomorrow.day, 8);
                          notifier.setGlobalDnd(true, until: morning);
                        },
                      ),
                      _DndChip(
                        label: 'Indefinitely',
                        onTap: () => notifier.setGlobalDnd(true),
                      ),
                    ],
                  ),
                ),
            ],
          ),
          const SizedBox(height: 24),

          // General section
          _buildSection(
            context,
            title: 'General',
            children: [
              SwitchListTile(
                secondary: const Icon(Icons.volume_up),
                title: const Text('Sound'),
                subtitle: const Text('Play notification sounds'),
                value: settings.soundEnabled,
                onChanged: (value) => notifier.setSoundEnabled(value),
              ),
              SwitchListTile(
                secondary: const Icon(Icons.visibility),
                title: const Text('Message Preview'),
                subtitle: const Text('Show message content in notifications'),
                value: settings.previewEnabled,
                onChanged: (value) => notifier.setPreviewEnabled(value),
              ),
            ],
          ),
          const SizedBox(height: 24),

          // Notification types section
          _buildSection(
            context,
            title: 'Notification Types',
            children: [
              SwitchListTile(
                secondary: const Icon(Icons.message),
                title: const Text('Messages'),
                subtitle: const Text('New message notifications'),
                value: settings.messageNotifications,
                onChanged: (value) => notifier.setMessageNotifications(value),
              ),
              SwitchListTile(
                secondary: const Icon(Icons.call),
                title: const Text('Calls'),
                subtitle: const Text('Incoming call notifications'),
                value: settings.callNotifications,
                onChanged: (value) => notifier.setCallNotifications(value),
              ),
              SwitchListTile(
                secondary: const Icon(Icons.person),
                title: const Text('Peer Status'),
                subtitle: const Text('When peers come online or go offline'),
                value: settings.peerStatusNotifications,
                onChanged: (value) =>
                    notifier.setPeerStatusNotifications(value),
              ),
              SwitchListTile(
                secondary: const Icon(Icons.insert_drive_file),
                title: const Text('File Received'),
                subtitle: const Text('When a file transfer completes'),
                value: settings.fileReceivedNotifications,
                onChanged: (value) =>
                    notifier.setFileReceivedNotifications(value),
              ),
            ],
          ),
          const SizedBox(height: 24),

          // Muted peers section
          if (settings.mutedPeerIds.isNotEmpty)
            _buildSection(
              context,
              title: 'Muted Peers',
              children: [
                for (final peerId in settings.mutedPeerIds)
                  ListTile(
                    leading: const Icon(Icons.notifications_off),
                    title: Text(peerId),
                    trailing: TextButton(
                      onPressed: () => notifier.unmutePeer(peerId),
                      child: const Text('Unmute'),
                    ),
                  ),
              ],
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
          child: Column(children: children),
        ),
      ],
    );
  }

  String _formatTime(DateTime dateTime) {
    final hour = dateTime.hour.toString().padLeft(2, '0');
    final minute = dateTime.minute.toString().padLeft(2, '0');
    final day = dateTime.day;
    final month = dateTime.month;
    return '$day/$month $hour:$minute';
  }
}

class _DndChip extends StatelessWidget {
  final String label;
  final VoidCallback onTap;

  const _DndChip({required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      label: Text(label, style: const TextStyle(fontSize: 12)),
      onPressed: onTap,
    );
  }
}
