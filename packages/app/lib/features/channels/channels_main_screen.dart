import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'channel_detail_screen.dart';
import 'channels_list_screen.dart';
import 'models/channel.dart';
import 'providers/channel_providers.dart';

/// Breakpoint for switching between narrow (phone) and wide (desktop) layout.
const double _wideBreakpoint = 720;

/// Width of the channel sidebar in wide mode.
const double _sidebarWidth = 320;

/// Main channels screen with responsive split-view layout.
///
/// On wide screens: sidebar (channel list) + channel detail panel.
/// On narrow screens: navigates to channel detail via GoRouter.
class ChannelsMainScreen extends ConsumerWidget {
  const ChannelsMainScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final isWide = constraints.maxWidth >= _wideBreakpoint;

        if (isWide) {
          return _WideChannelLayout();
        }

        // Narrow: show the standard list screen with push navigation
        return const ChannelsListScreen();
      },
    );
  }
}

class _WideChannelLayout extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedChannelId = ref.watch(selectedChannelIdProvider);

    return Scaffold(
      body: Row(
        children: [
          // Sidebar
          SizedBox(
            width: _sidebarWidth,
            child: _ChannelSidebar(selectedChannelId: selectedChannelId),
          ),
          const VerticalDivider(width: 1, thickness: 1),
          // Detail area
          Expanded(
            child: selectedChannelId != null
                ? ChannelDetailScreen(
                    key: ValueKey(selectedChannelId),
                    channelId: selectedChannelId,
                    embedded: true,
                  )
                : _EmptyChannelPlaceholder(),
          ),
        ],
      ),
    );
  }
}

class _EmptyChannelPlaceholder extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.rss_feed,
            size: 64,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 16),
          Text(
            'Select a channel',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 8),
          Text(
            'Choose a channel from the sidebar to view messages',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
        ],
      ),
    );
  }
}

class _ChannelSidebar extends ConsumerWidget {
  final String? selectedChannelId;

  const _ChannelSidebar({this.selectedChannelId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channelsAsync = ref.watch(channelsProvider);

    return Column(
      children: [
        // Header
        Container(
          padding: const EdgeInsets.fromLTRB(4, 12, 8, 12),
          child: Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back, size: 20),
                tooltip: 'Back',
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              const Icon(Icons.rss_feed),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Channels',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.add_link, size: 20),
                tooltip: 'Subscribe to channel',
                onPressed: () =>
                    ChannelsListScreen.showSubscribeDialog(context, ref),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        // Channel list
        Expanded(
          child: channelsAsync.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Text('Error: $e')),
            data: (channels) {
              if (channels.isEmpty) {
                return _buildEmptyState(context, ref);
              }
              return ListView.builder(
                itemCount: channels.length,
                itemBuilder: (context, index) {
                  final channel = channels[index];
                  return _ChannelTile(
                    channel: channel,
                    isSelected: channel.id == selectedChannelId,
                    onTap: () {
                      ref.read(selectedChannelIdProvider.notifier).state =
                          channel.id;
                    },
                  );
                },
              );
            },
          ),
        ),
        // Create channel button
        Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: double.infinity,
            child: FloatingActionButton.extended(
              heroTag: 'channel_sidebar_create',
              onPressed: () =>
                  ChannelsListScreen.showCreateDialog(context, ref),
              icon: const Icon(Icons.add),
              label: const Text('Create Channel'),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildEmptyState(BuildContext context, WidgetRef ref) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.rss_feed,
              size: 48,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 12),
            Text(
              'No channels yet',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ChannelTile extends StatelessWidget {
  final Channel channel;
  final bool isSelected;
  final VoidCallback onTap;

  const _ChannelTile({
    required this.channel,
    required this.isSelected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final isOwner = channel.role == ChannelRole.owner;

    return ListTile(
      selected: isSelected,
      selectedTileColor:
          Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.3),
      leading: CircleAvatar(
        backgroundColor: isOwner
            ? Theme.of(context).colorScheme.primaryContainer
            : Theme.of(context).colorScheme.surfaceContainerHighest,
        child: Icon(
          isOwner ? Icons.campaign : Icons.rss_feed,
          color: isOwner
              ? Theme.of(context).colorScheme.onPrimaryContainer
              : Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
      title: Text(
        channel.manifest.name,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w500),
      ),
      subtitle: Text(
        channel.role.name.toUpperCase(),
        style: TextStyle(
          fontSize: 12,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
      onTap: onTap,
    );
  }
}
