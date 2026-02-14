import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/logging/logger_service.dart';
import '../../core/models/peer.dart';
import '../../core/providers/app_providers.dart';
import 'models/group.dart';
import 'providers/group_providers.dart';

/// Screen showing details and messages for a single group.
class GroupDetailScreen extends ConsumerStatefulWidget {
  final String groupId;

  const GroupDetailScreen({super.key, required this.groupId});

  @override
  ConsumerState<GroupDetailScreen> createState() => _GroupDetailScreenState();
}

class _GroupDetailScreenState extends ConsumerState<GroupDetailScreen> {
  final _messageController = TextEditingController();
  bool _sending = false;
  bool _groupActivated = false;

  @override
  void initState() {
    super.initState();
    _activateGroupConnection();
  }

  Future<void> _activateGroupConnection() async {
    try {
      final groupService = ref.read(groupServiceProvider);
      final group = await groupService.getGroup(widget.groupId);
      if (group != null && mounted) {
        final connectionService = ref.read(groupConnectionServiceProvider);
        await connectionService.activateGroup(group);
        _groupActivated = true;
      }
    } catch (e) {
      logger.error('GroupDetailScreen',
          'Failed to activate mesh for group ${widget.groupId}', e);
    }
  }

  @override
  void dispose() {
    if (_groupActivated) {
      try {
        final connectionService = ref.read(groupConnectionServiceProvider);
        connectionService.deactivateGroup(widget.groupId);
      } catch (e) {
        logger.error('GroupDetailScreen',
            'Failed to deactivate mesh for group ${widget.groupId}', e);
      }
    }
    _messageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final groupAsync = ref.watch(groupByIdProvider(widget.groupId));
    final messagesAsync = ref.watch(groupMessagesProvider(widget.groupId));

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
              return Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    icon: const Icon(Icons.person_add),
                    tooltip: 'Add member',
                    onPressed: () => _showAddMemberDialog(context, group),
                  ),
                  IconButton(
                    icon: const Icon(Icons.people),
                    tooltip: '${group.memberCount} members',
                    onPressed: () => _showMembersSheet(context, group),
                  ),
                ],
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

          return Column(
            children: [
              Expanded(
                child: messagesAsync.when(
                  loading: () =>
                      const Center(child: CircularProgressIndicator()),
                  error: (error, stack) => Center(
                    child: Text('Error loading messages: $error'),
                  ),
                  data: (messages) {
                    if (messages.isEmpty) {
                      return const Center(
                        child: Text(
                          'No messages yet.\nSend the first message!',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.grey),
                        ),
                      );
                    }

                    return ListView.builder(
                      reverse: true,
                      itemCount: messages.length,
                      padding: const EdgeInsets.all(8),
                      itemBuilder: (context, index) {
                        final msg = messages[messages.length - 1 - index];
                        final isOutgoing = msg.isOutgoing;
                        return Align(
                          alignment: isOutgoing
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: GestureDetector(
                            onLongPressStart: (details) {
                              _showMessageCopyMenu(
                                context,
                                details.globalPosition,
                                msg.content,
                              );
                            },
                            onSecondaryTapDown: (details) {
                              _showMessageCopyMenu(
                                context,
                                details.globalPosition,
                                msg.content,
                              );
                            },
                            child: Container(
                              margin: const EdgeInsets.symmetric(vertical: 4),
                              padding: const EdgeInsets.all(12),
                              constraints: BoxConstraints(
                                maxWidth:
                                    MediaQuery.of(context).size.width * 0.75,
                              ),
                              decoration: BoxDecoration(
                                color: isOutgoing
                                    ? Theme.of(context)
                                        .colorScheme
                                        .primaryContainer
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
                                        _resolveAuthorName(
                                            group, msg.authorDeviceId),
                                        style: TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.bold,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .primary,
                                        ),
                                      ),
                                    ),
                                  Text(msg.content),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    );
                  },
                ),
              ),
              _buildComposeBar(context),
            ],
          );
        },
      ),
    );
  }

  Widget _buildComposeBar(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border(
          top: BorderSide(
            color: Theme.of(context).dividerColor,
          ),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _messageController,
                decoration: const InputDecoration(
                  hintText: 'Type a message...',
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.symmetric(horizontal: 8),
                ),
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _sendMessage(),
              ),
            ),
            IconButton(
              icon: _sending
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send),
              onPressed: _sending ? null : _sendMessage,
              tooltip: 'Send',
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _sendMessage() async {
    final text = _messageController.text.trim();
    if (text.isEmpty) return;

    setState(() => _sending = true);
    _messageController.clear();

    try {
      final groupService = ref.read(groupServiceProvider);
      final connectionService = ref.read(groupConnectionServiceProvider);
      final pairingCode = ref.read(pairingCodeProvider) ?? 'unknown';

      final result = await groupService.sendMessage(
        groupId: widget.groupId,
        selfDeviceId: pairingCode,
        content: text,
      );

      // Broadcast encrypted bytes to connected group members via mesh
      final meshCount = await connectionService.broadcastToGroup(
        widget.groupId,
        result.encryptedBytes,
      );

      // Fallback: also send via 1-on-1 direct connections for group
      // members who are directly connected peers (e.g. HeadlessBob).
      // This handles the case where mesh group_ connections aren't
      // established but the member is reachable as a regular peer.
      if (meshCount == 0) {
        final group = await groupService.getGroup(widget.groupId);
        if (group != null) {
          final connectionManager = ref.read(connectionManagerProvider);
          final directPeers = connectionManager.currentPeers
              .where((p) => p.connectionState == PeerConnectionState.connected)
              .map((p) => p.id)
              .toSet();

          final payload = 'grp:${base64Encode(result.encryptedBytes)}';
          for (final member in group.otherMembers) {
            if (directPeers.contains(member.deviceId)) {
              try {
                await connectionManager.sendMessage(member.deviceId, payload);
              } catch (e) {
                logger.error('GroupDetailScreen',
                    'Failed to send group message to ${member.deviceId}', e);
              }
            }
          }
        }
      }

      // Refresh messages
      ref.invalidate(groupMessagesProvider(widget.groupId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to send: $e')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _sending = false);
      }
    }
  }

  void _showMessageCopyMenu(
      BuildContext context, Offset globalPosition, String content) {
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final position = RelativeRect.fromRect(
      globalPosition & const Size(1, 1),
      Offset.zero & overlay.size,
    );

    showMenu<String>(
      context: context,
      position: position,
      items: [
        const PopupMenuItem<String>(
          value: 'copy',
          child: Row(
            children: [
              Icon(Icons.copy, size: 18),
              SizedBox(width: 8),
              Text('Copy'),
            ],
          ),
        ),
      ],
    ).then((value) {
      if (value == 'copy') {
        Clipboard.setData(ClipboardData(text: content));
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Message copied to clipboard'),
            duration: Duration(seconds: 2),
          ),
        );
      }
    });
  }

  String _resolveAuthorName(Group group, String deviceId) {
    final member = group.members.where((m) => m.deviceId == deviceId);
    if (member.isNotEmpty) return member.first.displayName;
    return deviceId.length > 8 ? '${deviceId.substring(0, 8)}...' : deviceId;
  }

  Future<void> _showAddMemberDialog(BuildContext context, Group group) async {
    final peersAsync = ref.read(visiblePeersProvider);

    peersAsync.whenData((peers) async {
      // Filter out peers already in the group and peers without public keys
      final groupDeviceIds = group.members.map((m) => m.deviceId).toSet();
      final availablePeers = peers
          .where((p) => p.publicKey != null && !groupDeviceIds.contains(p.id))
          .toList();

      if (availablePeers.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No available peers to add')),
        );
        return;
      }

      final selectedPeer = await showDialog(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Add Member'),
          content: SizedBox(
            width: double.maxFinite,
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: availablePeers.length,
              itemBuilder: (context, index) {
                final peer = availablePeers[index];
                return ListTile(
                  leading: const Icon(Icons.person),
                  title: Text(peer.displayName),
                  subtitle: Text(
                    peer.publicKey!.length > 16
                        ? '${peer.publicKey!.substring(0, 16)}...'
                        : peer.publicKey!,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                    ),
                  ),
                  onTap: () => Navigator.pop(context, peer),
                );
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
          ],
        ),
      );

      if (selectedPeer != null) {
        try {
          final groupService = ref.read(groupServiceProvider);
          final cryptoService = ref.read(groupCryptoServiceProvider);
          final invitationService = ref.read(groupInvitationServiceProvider);
          final senderKey = await cryptoService.generateSenderKey();

          final updatedGroup = await groupService.addMember(
            groupId: widget.groupId,
            newMember: GroupMember(
              deviceId: selectedPeer.id,
              displayName: selectedPeer.displayName,
              publicKey: selectedPeer.publicKey!,
              joinedAt: DateTime.now(),
            ),
            newMemberSenderKey: senderKey,
          );

          // Send the invitation over the 1:1 P2P channel
          await invitationService.sendInvitation(
            targetPeerId: selectedPeer.id,
            group: updatedGroup,
            inviteeSenderKey: senderKey,
          );

          ref.invalidate(groupByIdProvider(widget.groupId));

          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text('Invitation sent to ${selectedPeer.displayName}'),
              ),
            );
          }
        } catch (e) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Failed to add member: $e')),
            );
          }
        }
      }
    });
  }

  void _showMembersSheet(BuildContext context, Group group) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.4,
        minChildSize: 0.25,
        maxChildSize: 0.75,
        expand: false,
        builder: (context, scrollController) => SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  'Members (${group.memberCount})',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView.builder(
                  controller: scrollController,
                  itemCount: group.members.length,
                  itemBuilder: (context, index) {
                    final member = group.members[index];
                    final isSelf = member.deviceId == group.selfDeviceId;
                    return ListTile(
                      leading: CircleAvatar(
                        backgroundColor: isSelf
                            ? Theme.of(context).colorScheme.primaryContainer
                            : Theme.of(context)
                                .colorScheme
                                .surfaceContainerHighest,
                        child: Icon(
                          isSelf ? Icons.person : Icons.person_outline,
                          color: isSelf
                              ? Theme.of(context).colorScheme.primary
                              : null,
                        ),
                      ),
                      title: Text(
                        member.displayName,
                        style: isSelf
                            ? const TextStyle(fontWeight: FontWeight.bold)
                            : null,
                      ),
                      subtitle: Text(isSelf ? 'You' : 'Member'),
                      trailing: isSelf
                          ? null
                          : Icon(
                              Icons.circle,
                              size: 10,
                              color: Colors.green.shade400,
                            ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
