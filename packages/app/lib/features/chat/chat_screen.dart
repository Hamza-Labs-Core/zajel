import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';
import 'package:uuid/uuid.dart';

import '../../app_router.dart';
import '../../core/logging/logger_service.dart';
import '../../core/media/media_service.dart';
import '../../core/models/models.dart';
import '../../core/network/voip_service.dart';
import '../../core/providers/app_providers.dart';
import '../../core/utils/identity_utils.dart';
import '../call/call_screen.dart';
import '../call/incoming_call_dialog.dart';
import 'widgets/filtered_emoji_picker.dart';

/// Chat screen for messaging with a peer.
class ChatScreen extends ConsumerStatefulWidget {
  final String peerId;

  /// When true, renders without its own Scaffold/AppBar (for split-view embedding).
  final bool embedded;

  const ChatScreen({super.key, required this.peerId, this.embedded = false});

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen>
    with WidgetsBindingObserver {
  final _messageController = TextEditingController();
  final _scrollController = ScrollController();
  final _messageFocusNode = FocusNode();
  bool _isSending = false;
  bool _isLoadingMore = false;
  bool _isIncomingCallDialogOpen = false;
  bool _showEmojiPicker = false;
  StreamSubscription<CallState>? _voipStateSubscription;

  /// Check if running on desktop platform
  bool get _isDesktop =>
      Platform.isWindows || Platform.isLinux || Platform.isMacOS;

  /// Get the correct context for showing dialogs.
  /// When embedded in a ShellRoute (split-view), the local context belongs to
  /// the shell navigator. On GTK/Linux this can cause transparent/stuck dialogs
  /// because the barrier hit-test area doesn't cover the dialog content.
  /// Using the root navigator context ensures proper overlay stacking.
  BuildContext get _dialogContext =>
      widget.embedded ? (rootNavigatorKey.currentContext ?? context) : context;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scrollController.addListener(_onScroll);
    _listenToMessages();
    _setupVoipListener();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _messageFocusNode.requestFocus();
    }
  }

  void _setupVoipListener() {
    // Listen for incoming calls after the first frame to ensure context is available
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final voipService = ref.read(voipServiceProvider);
      if (voipService != null) {
        _voipStateSubscription = voipService.onStateChange.listen((state) {
          if (state == CallState.incoming && mounted) {
            _showIncomingCallDialog();
          } else if (_isIncomingCallDialogOpen &&
              (state == CallState.ended ||
                  state == CallState.connecting ||
                  state == CallState.idle) &&
              mounted) {
            _dismissIncomingCallDialog();
          }
        });
      }
    });
  }

  /// Load older messages when user scrolls near the top.
  void _onScroll() {
    if (_isLoadingMore) return;
    if (!_scrollController.hasClients) return;
    if (_scrollController.position.pixels <
        _scrollController.position.minScrollExtent + 100) {
      final notifier = ref.read(chatMessagesProvider(widget.peerId).notifier);
      if (!notifier.hasMore) return;
      _isLoadingMore = true;
      notifier.loadMore().then((_) {
        _isLoadingMore = false;
      });
    }
  }

  void _listenToMessages() {
    // Messages are persisted by the global listener in main.dart.
    // Here we just reload from DB when a new message arrives for this peer.
    ref.listenManual(messagesStreamProvider, (previous, next) {
      next.whenData((data) {
        final (peerId, _) = data;
        if (peerId == widget.peerId) {
          ref.read(chatMessagesProvider(widget.peerId).notifier).reload();
          _scrollToBottom();
        }
      });
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _voipStateSubscription?.cancel();
    _scrollController.removeListener(_onScroll);
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

  /// Fallback for platforms where IME inserts the newline before onKeyEvent fires.
  /// Detects trailing newline (without Shift) and triggers send instead.
  void _handleTextChanged(String text) {
    if (!_isDesktop || _isSending) return;

    if (text.endsWith('\n') && !HardwareKeyboard.instance.isShiftPressed) {
      // Remove the newline that was inserted by the IME
      _messageController.text = text.substring(0, text.length - 1);
      _messageController.selection = TextSelection.collapsed(
        offset: _messageController.text.length,
      );
      _sendMessage();
    }
  }

  @override
  Widget build(BuildContext context) {
    final peer = ref.watch(selectedPeerProvider);
    final messages = ref.watch(chatMessagesProvider(widget.peerId));
    final aliases = ref.watch(peerAliasesProvider);
    final peerName = peer != null
        ? resolvePeerDisplayName(peer, alias: aliases[peer.id])
        : 'Unknown';

    final body = Column(
      children: [
        if (peer?.connectionState != PeerConnectionState.connected)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            color: Colors.orange.shade50,
            child: Row(
              children: [
                Icon(Icons.cloud_off, size: 18, color: Colors.orange.shade700),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Peer is offline. Messages will be sent when they reconnect.',
                    style:
                        TextStyle(fontSize: 13, color: Colors.orange.shade800),
                  ),
                ),
              ],
            ),
          ),
        Expanded(
          child: messages.isEmpty
              ? _buildEmptyState()
              : _buildMessageList(messages),
        ),
        _buildInputBar(),
        if (_showEmojiPicker)
          FilteredEmojiPicker(
            textEditingController: _messageController,
            onEmojiSelected: (category, emoji) {
              // Emoji is auto-inserted by the textEditingController binding
            },
            onBackspacePressed: () {
              _messageController
                ..text = _messageController.text.characters.skipLast(1).string
                ..selection = TextSelection.fromPosition(
                  TextPosition(offset: _messageController.text.length),
                );
            },
          ),
      ],
    );

    if (widget.embedded) {
      // In embedded mode (split-view), render with a header bar but no Scaffold
      return Column(
        children: [
          _buildEmbeddedHeader(context, peer, peerName),
          Expanded(child: body),
        ],
      );
    }

    return Scaffold(
      appBar: _buildAppBar(context, peer, peerName),
      body: body,
    );
  }

  PreferredSizeWidget _buildAppBar(
      BuildContext context, Peer? peer, String peerName) {
    return AppBar(
      title: Row(
        children: [
          CircleAvatar(
            radius: 18,
            backgroundColor: Theme.of(context).colorScheme.primaryContainer,
            child: Text(
              peerName.isNotEmpty ? peerName[0].toUpperCase() : '?',
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
                Text(peerName, style: const TextStyle(fontSize: 16)),
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
      actions: _buildChatActions(peer),
    );
  }

  Widget _buildEmbeddedHeader(
      BuildContext context, Peer? peer, String peerName) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border(
          bottom: BorderSide(
            color: Theme.of(context).dividerColor,
          ),
        ),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 18,
            backgroundColor: Theme.of(context).colorScheme.primaryContainer,
            child: Text(
              peerName.isNotEmpty ? peerName[0].toUpperCase() : '?',
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
                  peerName,
                  style: Theme.of(context)
                      .textTheme
                      .titleMedium
                      ?.copyWith(fontWeight: FontWeight.w600),
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
          ..._buildChatActions(peer),
        ],
      ),
    );
  }

  List<Widget> _buildChatActions(Peer? peer) {
    return [
      IconButton(
        icon: const Icon(Icons.call),
        tooltip: 'Voice call',
        onPressed: () => _startCall(withVideo: false),
      ),
      IconButton(
        icon: const Icon(Icons.videocam),
        tooltip: 'Video call',
        onPressed: () => _startCall(withVideo: true),
      ),
      PopupMenuButton<String>(
        icon: const Icon(Icons.more_vert),
        onSelected: (value) {
          switch (value) {
            case 'rename':
              _showRenameDialog(peer);
            case 'delete':
              _showDeleteDialog(peer);
            case 'info':
              _showPeerInfo(context, peer);
          }
        },
        itemBuilder: (context) => [
          const PopupMenuItem(
            value: 'rename',
            child: Row(
              children: [
                Icon(Icons.edit),
                SizedBox(width: 8),
                Text('Rename'),
              ],
            ),
          ),
          const PopupMenuItem(
            value: 'delete',
            child: Row(
              children: [
                Icon(Icons.delete_outline, color: Colors.red),
                SizedBox(width: 8),
                Text('Delete conversation'),
              ],
            ),
          ),
          const PopupMenuItem(
            value: 'info',
            child: Row(
              children: [
                Icon(Icons.info_outline),
                SizedBox(width: 8),
                Text('Info'),
              ],
            ),
          ),
        ],
      ),
    ];
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
      // Use explorer.exe directly — avoids cmd.exe shell parser which is
      // vulnerable to injection via crafted filenames (& calc.exe, | net user)
      result = await Process.run('explorer.exe', [filePath]);
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
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 10,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: SafeArea(
        child: Row(
          children: [
            IconButton(
              icon: Icon(
                _showEmojiPicker
                    ? Icons.keyboard
                    : Icons.emoji_emotions_outlined,
              ),
              tooltip: _showEmojiPicker ? 'Keyboard' : 'Emoji',
              onPressed: () {
                if (_showEmojiPicker) {
                  setState(() => _showEmojiPicker = false);
                  _messageFocusNode.requestFocus();
                } else {
                  _messageFocusNode.unfocus();
                  setState(() => _showEmojiPicker = true);
                }
              },
            ),
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
                onTap: () {
                  if (_showEmojiPicker) {
                    setState(() => _showEmojiPicker = false);
                  }
                },
                // Fallback for desktop platforms where the IME processes Enter
                // before FocusNode.onKeyEvent fires (e.g. Linux GTK).
                // Detects the inserted newline and triggers send instead.
                onChanged: _isDesktop ? _handleTextChanged : null,
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

    // Check if the actual peer (not selectedPeerProvider) is connected
    bool isConnected = false;
    ref.read(peersProvider).whenData((peers) {
      final peer = peers.where((p) => p.id == widget.peerId).firstOrNull;
      isConnected = peer?.connectionState == PeerConnectionState.connected;
    });
    if (!isConnected) {
      // Queue as pending — will be sent on reconnect
      ref
          .read(chatMessagesProvider(widget.peerId).notifier)
          .updateMessageStatus(message.localId, MessageStatus.pending);
      setState(() => _isSending = false);
      return;
    }

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
            content:
                Text('VoIP not available. Connect to signaling server first.'),
          ),
        );
      }
      return;
    }

    try {
      await voipService.startCall(widget.peerId, withVideo);

      if (mounted) {
        _navigateToCallScreen(voipService, mediaService, withVideo: withVideo);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to start call: $e')),
        );
      }
    }
  }

  void _dismissIncomingCallDialog() {
    if (!_isIncomingCallDialogOpen) return;
    if (mounted) {
      Navigator.of(context).pop();
    }
    _isIncomingCallDialogOpen = false;
  }

  /// Show the incoming call dialog.
  void _showIncomingCallDialog() {
    final voipService = ref.read(voipServiceProvider);
    final mediaService = ref.read(mediaServiceProvider);
    final peer = ref.read(selectedPeerProvider);

    if (voipService == null || voipService.currentCall == null) return;

    final call = voipService.currentCall!;
    final aliases = ref.read(peerAliasesProvider);
    final callerName = peer != null
        ? resolvePeerDisplayName(peer, alias: aliases[peer.id])
        : 'Unknown';

    _isIncomingCallDialogOpen = true;

    showDialog(
      context: _dialogContext,
      barrierDismissible: false,
      barrierColor: Colors.black54,
      builder: (_) => IncomingCallDialog(
        callerName: callerName,
        callId: call.callId,
        withVideo: call.withVideo,
        onAccept: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.acceptCall(call.callId, false);
          _navigateToCallScreen(voipService, mediaService, withVideo: false);
        },
        onAcceptWithVideo: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.acceptCall(call.callId, true);
          _navigateToCallScreen(voipService, mediaService, withVideo: true);
        },
        onReject: () {
          _isIncomingCallDialogOpen = false;
          Navigator.of(context).pop();
          voipService.rejectCall(call.callId);
        },
      ),
    );
  }

  /// Navigate to the call screen.
  void _navigateToCallScreen(VoIPService voipService, MediaService mediaService,
      {bool withVideo = false}) {
    final peer = ref.read(selectedPeerProvider);
    final aliases = ref.read(peerAliasesProvider);
    final peerName = peer != null
        ? resolvePeerDisplayName(peer, alias: aliases[peer.id])
        : 'Unknown';

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CallScreen(
          voipService: voipService,
          mediaService: mediaService,
          peerName: peerName,
          initialVideoOn: withVideo,
        ),
      ),
    );
  }

  Future<void> _showRenameDialog(Peer? peer) async {
    if (peer == null) return;
    final aliases = ref.read(peerAliasesProvider);
    final currentName = resolvePeerDisplayName(peer, alias: aliases[peer.id]);
    final controller = TextEditingController(text: currentName);
    final newName = await showDialog<String>(
      context: _dialogContext,
      barrierColor: Colors.black54,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename Peer'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Name',
            border: OutlineInputBorder(),
          ),
          onSubmitted: (value) => Navigator.pop(ctx, value.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );

    if (newName != null && newName.isNotEmpty && newName != currentName) {
      final trustedPeers = ref.read(trustedPeersStorageProvider);
      await trustedPeers.updateAlias(peer.id, newName);
      final updatedAliases = {...ref.read(peerAliasesProvider)};
      updatedAliases[peer.id] = newName;
      ref.read(peerAliasesProvider.notifier).state = updatedAliases;
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Renamed to $newName')),
        );
      }
    }
  }

  Future<void> _showDeleteDialog(Peer? peer) async {
    if (peer == null) return;
    final confirmed = await showDialog<bool>(
      context: _dialogContext,
      barrierColor: Colors.black54,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Conversation?'),
        content: Text(
          'Delete conversation with ${resolvePeerDisplayName(peer, alias: ref.read(peerAliasesProvider)[peer.id])}? This will remove all messages and the connection.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      final trustedPeers = ref.read(trustedPeersStorageProvider);
      await trustedPeers.removePeer(peer.id);
      ref.read(chatMessagesProvider(peer.id).notifier).clearMessages();
      final connectionManager = ref.read(connectionManagerProvider);
      try {
        await connectionManager.disconnectPeer(peer.id);
      } catch (e) {
        logger.debug(
            'ChatScreen', 'Best-effort disconnect failed for ${peer.id}: $e');
      }
      if (mounted) {
        Navigator.of(context).pop(); // Go back to home
      }
    }
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
      context: _dialogContext,
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
                _InfoRow(
                    label: 'Name',
                    value: resolvePeerDisplayName(peer,
                        alias: ref.read(peerAliasesProvider)[peer.id])),
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
                        ? Colors.white.withValues(alpha: 0.7)
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
                        ? Colors.white.withValues(alpha: 0.7)
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
      final peerFingerprint =
          cryptoService.getPeerFingerprintById(widget.peerId);

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
                        style:
                            Theme.of(context).textTheme.titleMedium?.copyWith(
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
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
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
