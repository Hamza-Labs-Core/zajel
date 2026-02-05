import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';
import 'package:uuid/uuid.dart';

import '../../core/media/media_service.dart';
import '../../core/models/models.dart';
import '../../core/network/voip_service.dart';
import '../../core/providers/app_providers.dart';
import '../call/call_screen.dart';
import '../call/incoming_call_dialog.dart';

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
  final _messageFocusNode = FocusNode();
  bool _isSending = false;
  StreamSubscription<CallState>? _voipStateSubscription;

  /// Check if running on desktop platform
  bool get _isDesktop =>
      Platform.isWindows || Platform.isLinux || Platform.isMacOS;

  @override
  void initState() {
    super.initState();
    _loadBufferedMessages();
    _listenToMessages();
    _setupVoipListener();
  }

  /// Load messages that arrived while this ChatScreen was not open.
  void _loadBufferedMessages() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final connectionManager = ref.read(connectionManagerProvider);
      final buffered = connectionManager.drainBufferedMessages(widget.peerId);
      if (buffered.isNotEmpty) {
        final notifier =
            ref.read(chatMessagesProvider(widget.peerId).notifier);
        for (final (peerId, message) in buffered) {
          notifier.addMessage(
            Message(
              localId: const Uuid().v4(),
              peerId: peerId,
              content: message,
              timestamp: DateTime.now(),
              isOutgoing: false,
              status: MessageStatus.delivered,
            ),
          );
        }
        _scrollToBottom();
      }
    });
  }

  void _setupVoipListener() {
    // Listen for incoming calls after the first frame to ensure context is available
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final voipService = ref.read(voipServiceProvider);
      if (voipService != null) {
        _voipStateSubscription = voipService.onStateChange.listen((state) {
          if (state == CallState.incoming && mounted) {
            _showIncomingCallDialog();
          }
        });
      }
    });
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
    _voipStateSubscription?.cancel();
    _messageController.dispose();
    _scrollController.dispose();
    _messageFocusNode.dispose();
    super.dispose();
  }

  /// Handle key events for desktop: Enter sends, Shift+Enter creates newline
  KeyEventResult _handleKeyEvent(FocusNode node, KeyEvent event) {
    if (!_isDesktop) return KeyEventResult.ignored;

    if (event is KeyDownEvent && event.logicalKey == LogicalKeyboardKey.enter) {
      final isShiftPressed = HardwareKeyboard.instance.isShiftPressed;
      if (!isShiftPressed && !_isSending) {
        _sendMessage();
        return KeyEventResult.handled;
      }
    }
    return KeyEventResult.ignored;
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
          // Voice call button
          IconButton(
            icon: const Icon(Icons.call),
            tooltip: 'Voice call',
            onPressed: () => _startCall(withVideo: false),
          ),
          // Video call button
          IconButton(
            icon: const Icon(Icons.videocam),
            tooltip: 'Video call',
            onPressed: () => _startCall(withVideo: true),
          ),
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
      if (_isDesktop) {
        // Use platform-specific commands to open file with default app
        await _openFileOnDesktop(filePath);
      } else {
        // On mobile, use share sheet
        final file = XFile(filePath);
        await Share.shareXFiles([file]);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not open file: $e')),
        );
      }
    }
  }

  /// Opens a file using the system's default application on desktop platforms.
  Future<void> _openFileOnDesktop(String filePath) async {
    final file = File(filePath);
    if (!await file.exists()) {
      throw Exception('File not found: $filePath');
    }

    ProcessResult result;
    if (Platform.isLinux) {
      result = await Process.run('xdg-open', [filePath]);
    } else if (Platform.isMacOS) {
      result = await Process.run('open', [filePath]);
    } else if (Platform.isWindows) {
      // On Windows, use 'start' command via cmd
      result = await Process.run('cmd', ['/c', 'start', '', filePath]);
    } else {
      throw Exception('Unsupported platform');
    }

    if (result.exitCode != 0) {
      throw Exception('Failed to open file: ${result.stderr}');
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
              tooltip: 'Attach file',
              onPressed: _pickFile,
            ),
            Expanded(
              child: TextField(
                controller: _messageController,
                focusNode: _messageFocusNode..onKeyEvent = _handleKeyEvent,
                decoration: const InputDecoration(
                  hintText: 'Type a message...',
                  border: InputBorder.none,
                ),
                textCapitalization: TextCapitalization.sentences,
                maxLines: null,
                // On mobile, onSubmitted handles send; on desktop, key handler does
                onSubmitted: _isDesktop ? null : (_) => _sendMessage(),
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
                    tooltip: 'Send message',
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

  /// Start a VoIP call to the current peer.
  Future<void> _startCall({required bool withVideo}) async {
    final voipService = ref.read(voipServiceProvider);
    final mediaService = ref.read(mediaServiceProvider);

    if (voipService == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('VoIP not available. Connect to signaling server first.'),
          ),
        );
      }
      return;
    }

    try {
      await voipService.startCall(widget.peerId, withVideo);

      if (mounted) {
        _navigateToCallScreen(voipService, mediaService);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to start call: $e')),
        );
      }
    }
  }

  /// Show the incoming call dialog.
  void _showIncomingCallDialog() {
    final voipService = ref.read(voipServiceProvider);
    final mediaService = ref.read(mediaServiceProvider);
    final peer = ref.read(selectedPeerProvider);

    if (voipService == null || voipService.currentCall == null) return;

    final call = voipService.currentCall!;
    final callerName = peer?.displayName ?? 'Unknown';

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => IncomingCallDialog(
        callerName: callerName,
        callId: call.callId,
        withVideo: call.withVideo,
        onAccept: () {
          Navigator.of(context).pop();
          voipService.acceptCall(call.callId, false);
          _navigateToCallScreen(voipService, mediaService);
        },
        onAcceptWithVideo: () {
          Navigator.of(context).pop();
          voipService.acceptCall(call.callId, true);
          _navigateToCallScreen(voipService, mediaService);
        },
        onReject: () {
          Navigator.of(context).pop();
          voipService.rejectCall(call.callId);
        },
      ),
    );
  }

  /// Navigate to the call screen.
  void _navigateToCallScreen(VoIPService voipService, MediaService mediaService) {
    final peer = ref.read(selectedPeerProvider);
    final peerName = peer?.displayName ?? 'Unknown';

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CallScreen(
          voipService: voipService,
          mediaService: mediaService,
          peerName: peerName,
        ),
      ),
    );
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
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        minChildSize: 0.4,
        maxChildSize: 0.9,
        expand: false,
        builder: (context, scrollController) => SingleChildScrollView(
          controller: scrollController,
          child: Padding(
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
                const SizedBox(height: 24),
                const Divider(),
                const SizedBox(height: 16),
                _FingerprintVerificationSection(peerId: peer.id),
              ],
            ),
          ),
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

/// Widget for displaying fingerprint verification information.
///
/// This helps users verify they're communicating with the intended peer
/// and not a man-in-the-middle attacker. Users should compare fingerprints
/// through a trusted channel (phone call, in person).
class _FingerprintVerificationSection extends ConsumerStatefulWidget {
  final String peerId;

  const _FingerprintVerificationSection({required this.peerId});

  @override
  ConsumerState<_FingerprintVerificationSection> createState() =>
      _FingerprintVerificationSectionState();
}

class _FingerprintVerificationSectionState
    extends ConsumerState<_FingerprintVerificationSection> {
  String? _myFingerprint;
  String? _peerFingerprint;
  bool _isLoading = true;
  bool _isExpanded = false;

  @override
  void initState() {
    super.initState();
    _loadFingerprints();
  }

  Future<void> _loadFingerprints() async {
    try {
      final cryptoService = ref.read(cryptoServiceProvider);
      final myFingerprint = await cryptoService.getPublicKeyFingerprint();
      final peerFingerprint = cryptoService.getPeerFingerprintById(widget.peerId);

      if (mounted) {
        setState(() {
          _myFingerprint = myFingerprint;
          _peerFingerprint = peerFingerprint;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _copyToClipboard(String text, String label) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('$label copied to clipboard'),
          duration: const Duration(seconds: 2),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: CircularProgressIndicator(),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Header with security shield icon
        InkWell(
          onTap: () => setState(() => _isExpanded = !_isExpanded),
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                Icon(
                  Icons.shield,
                  color: Colors.green.shade700,
                  size: 24,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Verify Connection Security',
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                      Text(
                        'Tap to compare fingerprints',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: Colors.grey.shade600,
                            ),
                      ),
                    ],
                  ),
                ),
                Icon(
                  _isExpanded ? Icons.expand_less : Icons.expand_more,
                  color: Colors.grey.shade600,
                ),
              ],
            ),
          ),
        ),

        // Expandable fingerprint section
        if (_isExpanded) ...[
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.grey.shade100,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.grey.shade300),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Instructions
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.blue.shade50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.blue.shade200),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.info_outline,
                          color: Colors.blue.shade700, size: 20),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          'Compare these fingerprints with your peer through a trusted channel (phone call, video chat, or in person).',
                          style: TextStyle(
                            fontSize: 13,
                            color: Colors.blue.shade800,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),

                // My fingerprint
                if (_myFingerprint != null) ...[
                  _FingerprintCard(
                    label: 'Your Fingerprint',
                    fingerprint: _myFingerprint!,
                    onCopy: () =>
                        _copyToClipboard(_myFingerprint!, 'Your fingerprint'),
                  ),
                  const SizedBox(height: 12),
                ],

                // Peer fingerprint
                if (_peerFingerprint != null) ...[
                  _FingerprintCard(
                    label: 'Peer Fingerprint',
                    fingerprint: _peerFingerprint!,
                    onCopy: () =>
                        _copyToClipboard(_peerFingerprint!, 'Peer fingerprint'),
                  ),
                ] else ...[
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.orange.shade50,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: Colors.orange.shade200),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.warning_amber_rounded,
                            color: Colors.orange.shade700, size: 20),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            'Peer fingerprint not available. The peer may need to reconnect.',
                            style: TextStyle(
                              fontSize: 13,
                              color: Colors.orange.shade800,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                const SizedBox(height: 16),

                // Success indicator
                if (_myFingerprint != null && _peerFingerprint != null)
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.green.shade50,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: Colors.green.shade200),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.check_circle,
                            color: Colors.green.shade700, size: 20),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            'If fingerprints match, your connection is secure from interception.',
                            style: TextStyle(
                              fontSize: 13,
                              color: Colors.green.shade800,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

/// Card widget for displaying a fingerprint with copy functionality.
class _FingerprintCard extends StatelessWidget {
  final String label;
  final String fingerprint;
  final VoidCallback onCopy;

  const _FingerprintCard({
    required this.label,
    required this.fingerprint,
    required this.onCopy,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.grey.shade300),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: Colors.grey.shade700,
                ),
              ),
              InkWell(
                onTap: onCopy,
                borderRadius: BorderRadius.circular(4),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.copy, size: 14, color: Colors.grey.shade600),
                      const SizedBox(width: 4),
                      Text(
                        'Copy',
                        style: TextStyle(
                          fontSize: 12,
                          color: Colors.grey.shade600,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            fingerprint,
            style: const TextStyle(
              fontFamily: 'monospace',
              fontSize: 11,
              letterSpacing: 0.5,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }
}
