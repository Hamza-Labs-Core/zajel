import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers/group_providers.dart';

/// Screen showing details and messages for a single group.
class GroupDetailScreen extends ConsumerWidget {
  final String groupId;

  const GroupDetailScreen({super.key, required this.groupId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final groupAsync = ref.watch(groupByIdProvider(groupId));
    final messagesAsync = ref.watch(groupMessagesProvider(groupId));

    return Scaffold(
      appBar: AppBar(
        title: groupAsync.when(
          loading: () => const Text('Group'),
          error: (_, __) => const Text('Group'),
          data: (group) => Text(group?.name ?? 'Unknown Group'),
        ),
        actions: [
          groupAsync.when(
            loading: () => const SizedBox.shrink(),
            error: (_, __) => const SizedBox.shrink(),
            data: (group) {
              if (group == null) return const SizedBox.shrink();
              return IconButton(
                icon: const Icon(Icons.people),
                tooltip: '${group.memberCount} members',
                onPressed: () => _showMembersSheet(context, group),
              );
            },
          ),
        ],
      ),
      body: groupAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(
          child: Text('Error loading group: $error'),
        ),
        data: (group) {
          if (group == null) {
            return const Center(
              child: Text('Group not found'),
            );
          }

          return messagesAsync.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (error, stack) => Center(
              child: Text('Error loading messages: $error'),
            ),
            data: (messages) {
              if (messages.isEmpty) {
                return const Center(
                  child: Text(
                    'No messages yet',
                    style: TextStyle(color: Colors.grey),
                  ),
                );
              }

              return ListView.builder(
                itemCount: messages.length,
                padding: const EdgeInsets.all(8),
                itemBuilder: (context, index) {
                  final msg = messages[index];
                  final isOutgoing = msg.isOutgoing;
                  return Align(
                    alignment: isOutgoing
                        ? Alignment.centerRight
                        : Alignment.centerLeft,
                    child: Container(
                      margin: const EdgeInsets.symmetric(vertical: 4),
                      padding: const EdgeInsets.all(12),
                      constraints: BoxConstraints(
                        maxWidth: MediaQuery.of(context).size.width * 0.75,
                      ),
                      decoration: BoxDecoration(
                        color: isOutgoing
                            ? Theme.of(context).colorScheme.primaryContainer
                            : Theme.of(context)
                                .colorScheme
                                .surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (!isOutgoing)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 4),
                              child: Text(
                                msg.authorDeviceId,
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.bold,
                                  color: Theme.of(context).colorScheme.primary,
                                ),
                              ),
                            ),
                          Text(msg.content),
                        ],
                      ),
                    ),
                  );
                },
              );
            },
          );
        },
      ),
    );
  }

  void _showMembersSheet(BuildContext context, dynamic group) {
    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                'Members (${group.memberCount})',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            ...group.members.map<Widget>(
              (member) => ListTile(
                leading: Icon(
                  member.deviceId == group.selfDeviceId
                      ? Icons.person
                      : Icons.person_outline,
                ),
                title: Text(member.displayName),
                subtitle: Text(
                  member.deviceId == group.selfDeviceId
                      ? 'You'
                      : member.deviceId,
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
