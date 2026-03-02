import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/chat/services/read_receipt_service.dart';
import '../models/models.dart';
import '../storage/message_storage.dart';
import 'network_providers.dart';

/// Provider for incoming 1:1 peer messages (no protocol prefixes).
final messagesStreamProvider = StreamProvider<(String, String)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.peerMessages;
});

/// Provider for message storage (SQLite).
final messageStorageProvider = Provider<MessageStorage>((ref) {
  final storage = MessageStorage();
  ref.onDispose(() => storage.close());
  return storage;
});

/// Provider for managing chat messages per peer.
final chatMessagesProvider =
    StateNotifierProvider.family<ChatMessagesNotifier, List<Message>, String>(
  (ref, peerId) {
    final storage = ref.watch(messageStorageProvider);
    return ChatMessagesNotifier(peerId, storage);
  },
);

class ChatMessagesNotifier extends StateNotifier<List<Message>> {
  final String peerId;
  final MessageStorage _storage;
  bool _loaded = false;
  bool _hasMore = true;
  static const _pageSize = 100;

  ChatMessagesNotifier(this.peerId, this._storage) : super([]) {
    _loadMessages();
  }

  /// Whether there are more older messages to load.
  bool get hasMore => _hasMore;

  Future<void> _loadMessages() async {
    if (_loaded) return;
    final messages = await _storage.getMessages(peerId, limit: _pageSize);
    if (mounted) {
      state = messages;
      _loaded = true;
      _hasMore = messages.length >= _pageSize;
    }
  }

  /// Load older messages (pagination). Prepends to current state.
  Future<void> loadMore() async {
    if (!_hasMore || !_loaded) return;
    final older = await _storage.getMessages(
      peerId,
      limit: _pageSize,
      offset: state.length,
    );
    if (mounted && older.isNotEmpty) {
      // older is in ascending order; prepend before current messages
      state = [...older, ...state];
      _hasMore = older.length >= _pageSize;
    } else {
      _hasMore = false;
    }
  }

  /// Reload messages from DB. Called when a new message is persisted
  /// by the global listener so the UI picks it up.
  Future<void> reload() async {
    final messages = await _storage.getMessages(peerId, limit: _pageSize);
    if (mounted) {
      state = messages;
      _hasMore = messages.length >= _pageSize;
    }
  }

  void addMessage(Message message) {
    // Dedup guard: skip if a message with same localId already exists
    if (state.any((m) => m.localId == message.localId)) return;
    state = [...state, message];
    _storage.saveMessage(message);
  }

  void updateMessageStatus(String localId, MessageStatus status) {
    state = state.map((m) {
      if (m.localId == localId) {
        return m.copyWith(status: status);
      }
      return m;
    }).toList();
    _storage.updateMessageStatus(localId, status);
  }

  void clearMessages() {
    state = [];
    _storage.deleteMessages(peerId);
  }
}

/// Provider for the last message per peer (for conversation list preview).
/// Watches the chatMessagesProvider state to auto-update when messages change.
final lastMessageProvider = Provider.family<Message?, String>((ref, peerId) {
  final messages = ref.watch(chatMessagesProvider(peerId));
  if (messages.isEmpty) return null;
  return messages.last;
});

/// Provider for read receipt service.
///
/// Listens to incoming read receipts and updates message statuses.
/// When a receipt is received, invalidates the relevant chat messages provider
/// so the UI refreshes to show updated read status indicators.
final readReceiptServiceProvider = Provider<ReadReceiptService>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  final messageStorage = ref.watch(messageStorageProvider);
  final service = ReadReceiptService(
    connectionManager: connectionManager,
    messageStorage: messageStorage,
  );

  // When receipts arrive, refresh the relevant chat so UI picks up read status
  service.onStatusUpdated = (peerId) {
    ref.invalidate(chatMessagesProvider(peerId));
  };

  service.start();
  ref.onDispose(() => service.dispose());
  return service;
});
