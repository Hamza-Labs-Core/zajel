import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';
import 'package:uuid/uuid.dart';

import '../../core/models/models.dart';
import '../../core/providers/app_providers.dart';

/// Chat screen for messaging with a peer.
class ChatScreen extends ConsumerStatefulWidget {
  final String peerId;

  const ChatScreen({super.key, required this.peerId});

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _messageController = TextEditingController();
  final _scrollController = ScrollController();
  bool _isSending = false;

  @override
  void initState() {
    super.initState();
    _listenToMessages();
  }

  void _listenToMessages() {
    ref.listenManual(messagesStreamProvider, (previous, next) {
      next.whenData((data) {
        final (peerId, message) = data;
        if (peerId == widget.peerId) {
          ref.read(chatMessagesProvider(widget.peerId).notifier).addMessage(
                Message(
                  localId: const Uuid().v4(),
                  peerId: peerId,
                  content: message,
                  timestamp: DateTime.now(),
                  isOutgoing: false,
                  status: MessageStatus.delivered,
                ),
              );
          _scrollToBottom();
        }
      });
    });
  }

  @override
  void dispose() {
    _messageController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final peer = ref.watch(selectedPeerProvider);
    final messages = ref.watch(chatMessagesProvider(widget.peerId));

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            CircleAvatar(
              radius: 18,
              backgroundColor:
                  Theme.of(context).colorScheme.primaryContainer,
              child: Text(
                peer?.displayName.isNotEmpty == true
                    ? peer!.displayName[0].toUpperCase()
                    : '?',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onPrimaryContainer,
                  fontSize: 14,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    peer?.displayName ?? 'Unknown',
                    style: const TextStyle(fontSize: 16),
                  ),
                  Text(
                    _getConnectionStatus(peer),
                    style: TextStyle(
                      fontSize: 12,
                      color: _getConnectionColor(peer),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.info_outline),
            onPressed: () => _showPeerInfo(context, peer),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: messages.isEmpty
                ? _buildEmptyState()
                : _buildMessageList(messages),
          ),
          _buildInputBar(),
        ],
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.lock_outline,
              size: 64,
              color: Theme.of(context).colorScheme.primary,
            ),
            const SizedBox(height: 16),
            Text(
              'End-to-End Encrypted',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Messages are encrypted using X25519 key exchange and ChaCha20-Poly1305. Only you and the recipient can read them.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageList(List<Message> messages) {
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      itemCount: messages.length,
      itemBuilder: (context, index) {
        final message = messages[index];
        final showDate = index == 0 ||
            !_isSameDay(messages[index - 1].timestamp, message.timestamp);

        return Column(
          children: [
            if (showDate) _buildDateDivider(message.timestamp),
            _MessageBubble(
              message: message,
              onOpenFile: message.attachmentPath != null
                  ? () => _openFile(message.attachmentPath!)
                  : null,
            ),
          ],
        );
      },
    );
  }

  Future<void> _openFile(String filePath) async {
    try {
      final file = XFile(filePath);
      await Share.shareXFiles([file]);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not open file: $e')),
        );
      }
    }
  }

  Widget _buildDateDivider(DateTime date) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Row(
        children: [
          Expanded(child: Divider(color: Colors.grey.shade300)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              _formatDate(date),
              style: TextStyle(
                fontSize: 12,
                color: Colors.grey.shade600,
              ),
            ),
          ),
          Expanded(child: Divider(color: Colors.grey.shade300)),
        ],
      ),
    );
  }

  Widget _buildInputBar() {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.05),
            blurRadius: 10,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: SafeArea(
        child: Row(
          children: [
            IconButton(
              icon: const Icon(Icons.attach_file),
              onPressed: _pickFile,
            ),
            Expanded(
              child: TextField(
                controller: _messageController,
                decoration: const InputDecoration(
                  hintText: 'Type a message...',
                  border: InputBorder.none,
                ),
                textCapitalization: TextCapitalization.sentences,
                maxLines: null,
                onSubmitted: (_) => _sendMessage(),
              ),
            ),
            _isSending
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(
                      width: 24,
                      height: 24,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : IconButton(
                    icon: Icon(
                      Icons.send,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                    onPressed: _sendMessage,
                  ),
          ],
        ),
      ),
    );
  }

  Future<void> _sendMessage() async {
    final text = _messageController.text.trim();
    if (text.isEmpty) return;

    setState(() => _isSending = true);

    final message = Message(
      localId: const Uuid().v4(),
      peerId: widget.peerId,
      content: text,
      timestamp: DateTime.now(),
      isOutgoing: true,
      status: MessageStatus.sending,
    );

    ref.read(chatMessagesProvider(widget.peerId).notifier).addMessage(message);
    _messageController.clear();
    _scrollToBottom();

    try {
      final connectionManager = ref.read(connectionManagerProvider);
      await connectionManager.sendMessage(widget.peerId, text);

      ref
          .read(chatMessagesProvider(widget.peerId).notifier)
          .updateMessageStatus(message.localId, MessageStatus.sent);
    } catch (e) {
      ref
          .read(chatMessagesProvider(widget.peerId).notifier)
          .updateMessageStatus(message.localId, MessageStatus.failed);
    } finally {
      setState(() => _isSending = false);
    }
  }

  Future<void> _pickFile() async {
    final result = await FilePicker.platform.pickFiles();
    if (result == null || result.files.isEmpty) return;

    final file = result.files.first;
    if (file.path == null) return;

    final bytes = await File(file.path!).readAsBytes();
    await _sendFile(file.name, bytes);
  }

  Future<void> _sendFile(String fileName, Uint8List data) async {
    setState(() => _isSending = true);

    final message = Message(
      localId: const Uuid().v4(),
      peerId: widget.peerId,
      content: 'Sending file: $fileName',
      type: MessageType.file,
      timestamp: DateTime.now(),
      isOutgoing: true,
      status: MessageStatus.sending,
      attachmentName: fileName,
      attachmentSize: data.length,
    );

    ref.read(chatMessagesProvider(widget.peerId).notifier).addMessage(message);
    _scrollToBottom();

    try {
      final connectionManager = ref.read(connectionManagerProvider);
      await connectionManager.sendFile(widget.peerId, fileName, data);

      ref
          .read(chatMessagesProvider(widget.peerId).notifier)
          .updateMessageStatus(message.localId, MessageStatus.sent);
    } catch (e) {
      ref
          .read(chatMessagesProvider(widget.peerId).notifier)
          .updateMessageStatus(message.localId, MessageStatus.failed);
    } finally {
      setState(() => _isSending = false);
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  String _getConnectionStatus(Peer? peer) {
    if (peer == null) return 'Unknown';
    switch (peer.connectionState) {
      case PeerConnectionState.connected:
        return 'Connected - E2E Encrypted';
      case PeerConnectionState.connecting:
        return 'Connecting...';
      case PeerConnectionState.handshaking:
        return 'Establishing secure channel...';
      default:
        return 'Disconnected';
    }
  }

  Color _getConnectionColor(Peer? peer) {
    if (peer?.connectionState == PeerConnectionState.connected) {
      return Colors.green;
    }
    return Colors.grey;
  }

  void _showPeerInfo(BuildContext context, Peer? peer) {
    if (peer == null) return;

    showModalBottomSheet(
      context: context,
      builder: (context) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Peer Information',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 16),
            _InfoRow(label: 'Name', value: peer.displayName),
            _InfoRow(label: 'ID', value: peer.id),
            if (peer.ipAddress != null)
              _InfoRow(label: 'IP', value: peer.ipAddress!),
            _InfoRow(
              label: 'Connection',
              value: 'End-to-end encrypted',
            ),
            _InfoRow(
              label: 'Last Seen',
              value: _formatDateTime(peer.lastSeen),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Icon(Icons.lock, size: 16, color: Colors.green.shade700),
                const SizedBox(width: 8),
                Text(
                  'End-to-end encrypted',
                  style: TextStyle(color: Colors.green.shade700),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  bool _isSameDay(DateTime a, DateTime b) {
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }

  String _formatDate(DateTime date) {
    final now = DateTime.now();
    if (_isSameDay(date, now)) return 'Today';
    if (_isSameDay(date, now.subtract(const Duration(days: 1)))) {
      return 'Yesterday';
    }
    return '${date.day}/${date.month}/${date.year}';
  }

  String _formatDateTime(DateTime date) {
    return '${date.day}/${date.month}/${date.year} ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
  }
}

class _MessageBubble extends StatelessWidget {
  final Message message;
  final VoidCallback? onOpenFile;

  const _MessageBubble({required this.message, this.onOpenFile});

  @override
  Widget build(BuildContext context) {
    final isOutgoing = message.isOutgoing;

    return Align(
      alignment: isOutgoing ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 4),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        decoration: BoxDecoration(
          color: isOutgoing
              ? Theme.of(context).colorScheme.primary
              : Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(20).copyWith(
            bottomRight: isOutgoing ? const Radius.circular(4) : null,
            bottomLeft: !isOutgoing ? const Radius.circular(4) : null,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            if (message.type == MessageType.file)
              _buildFileContent(context, isOutgoing)
            else
              Text(
                message.content,
                style: TextStyle(
                  color: isOutgoing ? Colors.white : null,
                ),
              ),
            const SizedBox(height: 4),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _formatTime(message.timestamp),
                  style: TextStyle(
                    fontSize: 11,
                    color: isOutgoing
                        ? Colors.white.withOpacity(0.7)
                        : Colors.grey,
                  ),
                ),
                if (isOutgoing) ...[
                  const SizedBox(width: 4),
                  _buildStatusIcon(),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildFileContent(BuildContext context, bool isOutgoing) {
    final hasFile = message.attachmentPath != null;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          hasFile ? Icons.insert_drive_file : Icons.hourglass_empty,
          color: isOutgoing ? Colors.white : null,
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                message.attachmentName ?? 'File',
                style: TextStyle(
                  color: isOutgoing ? Colors.white : null,
                  fontWeight: FontWeight.w500,
                ),
                overflow: TextOverflow.ellipsis,
              ),
              if (message.attachmentSize != null)
                Text(
                  _formatFileSize(message.attachmentSize!),
                  style: TextStyle(
                    fontSize: 12,
                    color: isOutgoing
                        ? Colors.white.withOpacity(0.7)
                        : Colors.grey,
                  ),
                ),
            ],
          ),
        ),
        // Show open button for received files
        if (!isOutgoing && hasFile) ...[
          const SizedBox(width: 8),
          IconButton(
            icon: const Icon(Icons.open_in_new, size: 20),
            onPressed: onOpenFile,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
            color: Theme.of(context).colorScheme.primary,
          ),
        ],
      ],
    );
  }

  Widget _buildStatusIcon() {
    switch (message.status) {
      case MessageStatus.sending:
        return const SizedBox(
          width: 12,
          height: 12,
          child: CircularProgressIndicator(
            strokeWidth: 1,
            color: Colors.white70,
          ),
        );
      case MessageStatus.sent:
        return const Icon(Icons.check, size: 14, color: Colors.white70);
      case MessageStatus.delivered:
        return const Icon(Icons.done_all, size: 14, color: Colors.white70);
      case MessageStatus.read:
        return const Icon(Icons.done_all, size: 14, color: Colors.lightBlue);
      case MessageStatus.failed:
        return const Icon(Icons.error_outline, size: 14, color: Colors.red);
      default:
        return const SizedBox.shrink();
    }
  }

  String _formatTime(DateTime time) {
    return '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
  }

  String _formatFileSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;

  const _InfoRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 80,
            child: Text(
              label,
              style: TextStyle(color: Colors.grey.shade600),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w500),
            ),
          ),
        ],
      ),
    );
  }
}
