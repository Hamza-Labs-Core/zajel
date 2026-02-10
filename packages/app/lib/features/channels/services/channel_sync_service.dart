import 'dart:async';

import '../models/chunk.dart';
import 'channel_service.dart';
import 'channel_storage_service.dart';

/// Callback type for sending WebSocket messages to the server.
typedef SendMessage = void Function(Map<String, dynamic> message);

/// Callback type for receiving the stream of incoming server messages.
typedef MessageStream = Stream<Map<String, dynamic>>;

/// Handles synchronization of chunks between the client and the relay server.
///
/// This service manages:
/// - **Chunk registration**: Announcing locally held chunks to the server
/// - **Chunk requests**: Requesting missing chunks from the server
/// - **Chunk reception**: Handling incoming chunk data from the server
/// - **Swarm seeding**: Re-announcing downloaded chunks so other subscribers
///   can pull from us
/// - **Periodic sync**: Background sync to keep the server's index fresh
///
/// The sync service acts as the bridge between local storage
/// ([ChannelStorageService]) and the relay server's chunk index. It does NOT
/// handle encryption or verification -- that remains the responsibility of
/// [ChannelService] and [ChannelCryptoService].
class ChannelSyncService {
  final ChannelStorageService _storageService;
  final SendMessage _sendMessage;

  /// Subscription to the server message stream.
  StreamSubscription<Map<String, dynamic>>? _messageSubscription;

  /// Timer for periodic chunk registration.
  Timer? _syncTimer;

  /// Peer ID used when communicating with the server.
  final String peerId;

  /// Interval between periodic sync operations.
  final Duration syncInterval;

  /// Callback invoked when chunk data is received from the server.
  /// The caller should verify, store, and optionally re-announce the chunk.
  void Function(String chunkId, Map<String, dynamic> chunkData)?
      onChunkReceived;

  /// Callback invoked when a previously unavailable chunk becomes available.
  void Function(String chunkId)? onChunkAvailable;

  /// Set of chunk IDs that we have pending requests for.
  final Set<String> _pendingRequests = {};

  /// Set of chunk IDs we have announced in the current session.
  final Set<String> _announcedChunks = {};

  /// Whether the service is currently running.
  bool _isRunning = false;

  /// Whether the service is currently running.
  bool get isRunning => _isRunning;

  /// Set of chunk IDs with pending requests (read-only view).
  Set<String> get pendingRequests => Set.unmodifiable(_pendingRequests);

  /// Set of chunk IDs announced this session (read-only view).
  Set<String> get announcedChunks => Set.unmodifiable(_announcedChunks);

  ChannelSyncService({
    required ChannelStorageService storageService,
    required SendMessage sendMessage,
    required this.peerId,
    this.syncInterval = const Duration(minutes: 5),
    this.onChunkReceived,
    this.onChunkAvailable,
  })  : _storageService = storageService,
        _sendMessage = sendMessage;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /// Start the sync service: subscribe to server messages and begin periodic sync.
  ///
  /// [messageStream] is the stream of decoded JSON messages from the server.
  /// The caller is responsible for filtering messages to only include those
  /// relevant to chunk sync (types starting with 'chunk_').
  void start(MessageStream messageStream) {
    if (_isRunning) return;
    _isRunning = true;

    _messageSubscription = messageStream.listen(
      _handleServerMessage,
      onError: (error) {
        // Silently handle stream errors -- reconnection is handled elsewhere
      },
    );

    // Start periodic sync
    _syncTimer = Timer.periodic(syncInterval, (_) => syncAllChannels());
  }

  /// Stop the sync service: cancel subscriptions and timers.
  Future<void> stop() async {
    _isRunning = false;
    _syncTimer?.cancel();
    _syncTimer = null;
    await _messageSubscription?.cancel();
    _messageSubscription = null;
    _pendingRequests.clear();
    _announcedChunks.clear();
  }

  /// Dispose all resources. Call this when the service is no longer needed.
  Future<void> dispose() async {
    await stop();
  }

  // ---------------------------------------------------------------------------
  // Chunk announcement (push metadata to server)
  // ---------------------------------------------------------------------------

  /// Announce all locally held chunks for a specific channel to the server.
  ///
  /// This registers us as a source for these chunks in the server's index.
  /// Called on initial sync and periodically to refresh our entries.
  Future<void> announceChunksForChannel(String channelId) async {
    final chunkIds = await _storageService.getChunkIds(channelId);
    if (chunkIds.isEmpty) return;

    // We need routing hash for each chunk. Fetch the chunk metadata.
    final announcements = <Map<String, dynamic>>[];
    for (final chunkId in chunkIds) {
      final chunk = await _storageService.getChunk(channelId, chunkId);
      if (chunk != null) {
        announcements.add({
          'chunkId': chunk.chunkId,
          'routingHash': chunk.routingHash,
        });
        _announcedChunks.add(chunk.chunkId);
      }
    }

    if (announcements.isNotEmpty) {
      _sendMessage({
        'type': 'chunk_announce',
        'peerId': peerId,
        'chunks': announcements,
      });
    }
  }

  /// Announce all chunks across all channels.
  Future<void> syncAllChannels() async {
    final channels = await _storageService.getAllChannels();
    for (final channel in channels) {
      await announceChunksForChannel(channel.id);
    }
  }

  /// Announce a single chunk to the server (e.g., after downloading it).
  ///
  /// Used for swarm seeding: after a subscriber downloads a chunk, they
  /// announce it so other subscribers can pull from them too.
  void announceChunk(Chunk chunk) {
    _announcedChunks.add(chunk.chunkId);
    _sendMessage({
      'type': 'chunk_announce',
      'peerId': peerId,
      'chunks': [
        {
          'chunkId': chunk.chunkId,
          'routingHash': chunk.routingHash,
        },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Chunk requests (pull from server)
  // ---------------------------------------------------------------------------

  /// Request a specific chunk from the server.
  ///
  /// The server will check its cache first, then find an online peer source
  /// and relay the chunk data. If no source is available immediately,
  /// the server will notify us when the chunk becomes available.
  void requestChunk(String chunkId) {
    _pendingRequests.add(chunkId);
    _sendMessage({
      'type': 'chunk_request',
      'peerId': peerId,
      'chunkId': chunkId,
    });
  }

  /// Request multiple chunks at once.
  void requestChunks(List<String> chunkIds) {
    for (final chunkId in chunkIds) {
      requestChunk(chunkId);
    }
  }

  // ---------------------------------------------------------------------------
  // Chunk push (respond to server pull requests)
  // ---------------------------------------------------------------------------

  /// Push chunk data to the server in response to a chunk_pull request.
  ///
  /// The server asks us for a chunk when another subscriber needs it.
  /// We fetch it from local storage and send the full chunk data.
  Future<void> pushChunk(String channelId, String chunkId) async {
    final chunk = await _storageService.getChunk(channelId, chunkId);
    if (chunk == null) return;

    _sendMessage({
      'type': 'chunk_push',
      'peerId': peerId,
      'chunkId': chunkId,
      'data': chunk.toJson(),
    });
  }

  /// Find the channel that owns a chunk by its ID.
  ///
  /// Searches all channels for the chunk. Returns the channel ID or null.
  Future<String?> findChannelForChunk(String chunkId) async {
    final channels = await _storageService.getAllChannels();
    for (final channel in channels) {
      final chunk = await _storageService.getChunk(channel.id, chunkId);
      if (chunk != null) return channel.id;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Server message handling
  // ---------------------------------------------------------------------------

  /// Process an incoming message from the server.
  void _handleServerMessage(Map<String, dynamic> message) {
    final type = message['type'] as String?;
    if (type == null) return;

    switch (type) {
      case 'chunk_data':
        _handleChunkData(message);
        break;
      case 'chunk_pull':
        _handleChunkPull(message);
        break;
      case 'chunk_available':
        _handleChunkAvailable(message);
        break;
      case 'chunk_not_found':
        _handleChunkNotFound(message);
        break;
      case 'chunk_announce_ack':
        // Acknowledgement -- no action needed
        break;
      case 'chunk_push_ack':
        // Acknowledgement -- no action needed
        break;
    }
  }

  /// Handle incoming chunk data from the server.
  void _handleChunkData(Map<String, dynamic> message) {
    final chunkId = message['chunkId'] as String?;
    final data = message['data'] as Map<String, dynamic>?;

    if (chunkId == null || data == null) return;

    _pendingRequests.remove(chunkId);

    // Notify the caller so they can verify, decrypt, and store the chunk
    onChunkReceived?.call(chunkId, data);
  }

  /// Handle a chunk_pull request from the server.
  ///
  /// The server wants us to upload a chunk because another subscriber needs it.
  void _handleChunkPull(Map<String, dynamic> message) async {
    final chunkId = message['chunkId'] as String?;
    if (chunkId == null) return;

    final channelId = await findChannelForChunk(chunkId);
    if (channelId != null) {
      await pushChunk(channelId, chunkId);
    }
  }

  /// Handle chunk_available notification: a previously unavailable chunk
  /// is now available on the server.
  void _handleChunkAvailable(Map<String, dynamic> message) {
    final chunkId = message['chunkId'] as String?;
    if (chunkId == null) return;

    onChunkAvailable?.call(chunkId);

    // Automatically re-request the chunk
    if (_pendingRequests.contains(chunkId)) {
      requestChunk(chunkId);
    }
  }

  /// Handle chunk_not_found response: no sources available yet.
  /// The chunk remains in pending requests and we'll be notified via
  /// chunk_available when a source comes online.
  void _handleChunkNotFound(Map<String, dynamic> message) {
    // The chunk stays in _pendingRequests. The server will send
    // chunk_available when a source becomes available.
  }
}
