import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../crypto/crypto_service.dart';
import '../models/models.dart';
import '../network/connection_manager.dart';
import '../network/discovery_service.dart';
import '../network/webrtc_service.dart';
import '../storage/file_receive_service.dart';

/// Provider for shared preferences.
final sharedPreferencesProvider = Provider<SharedPreferences>((ref) {
  throw UnimplementedError('Must be overridden with actual instance');
});

/// Provider for the user's display name.
final displayNameProvider = StateProvider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getString('displayName') ?? 'Anonymous';
});

/// Provider for crypto service.
final cryptoServiceProvider = Provider<CryptoService>((ref) {
  return CryptoService();
});

/// Provider for discovery service.
final discoveryServiceProvider = Provider<DiscoveryService>((ref) {
  final displayName = ref.watch(displayNameProvider);
  return DiscoveryService(
    displayName: displayName,
    port: 42424, // Default port for Zajel
  );
});

/// Provider for WebRTC service.
final webrtcServiceProvider = Provider<WebRTCService>((ref) {
  final cryptoService = ref.watch(cryptoServiceProvider);
  return WebRTCService(cryptoService: cryptoService);
});

/// Provider for connection manager.
final connectionManagerProvider = Provider<ConnectionManager>((ref) {
  final cryptoService = ref.watch(cryptoServiceProvider);
  final discoveryService = ref.watch(discoveryServiceProvider);
  final webrtcService = ref.watch(webrtcServiceProvider);

  return ConnectionManager(
    cryptoService: cryptoService,
    discoveryService: discoveryService,
    webrtcService: webrtcService,
  );
});

/// Provider for the list of peers.
final peersProvider = StreamProvider<List<Peer>>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.peers;
});

/// Provider for visible peers (excluding blocked).
final visiblePeersProvider = Provider<AsyncValue<List<Peer>>>((ref) {
  final peersAsync = ref.watch(peersProvider);
  final blockedPeers = ref.watch(blockedPeersProvider);

  return peersAsync.whenData((peers) {
    return peers.where((peer) => !blockedPeers.contains(peer.id)).toList();
  });
});

/// Provider for incoming messages.
final messagesStreamProvider = StreamProvider<(String, String)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.messages;
});

/// Provider for managing chat messages per peer.
final chatMessagesProvider =
    StateNotifierProvider.family<ChatMessagesNotifier, List<Message>, String>(
  (ref, peerId) => ChatMessagesNotifier(peerId),
);

class ChatMessagesNotifier extends StateNotifier<List<Message>> {
  final String peerId;

  ChatMessagesNotifier(this.peerId) : super([]);

  void addMessage(Message message) {
    state = [...state, message];
  }

  void updateMessageStatus(String localId, MessageStatus status) {
    state = state.map((m) {
      if (m.localId == localId) {
        return m.copyWith(status: status);
      }
      return m;
    }).toList();
  }

  void clearMessages() {
    state = [];
  }
}

/// Provider for the currently selected peer.
final selectedPeerProvider = StateProvider<Peer?>((ref) => null);

/// Provider for blocked peer IDs (for efficient lookup).
final blockedPeersProvider =
    StateNotifierProvider<BlockedPeersNotifier, Set<String>>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return BlockedPeersNotifier(prefs);
});

/// Provider for blocked peer details (id -> name mapping).
final blockedPeerDetailsProvider = StateProvider<Map<String, String>>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  final detailsJson = prefs.getStringList('blockedPeerDetails') ?? [];
  final Map<String, String> details = {};
  for (final entry in detailsJson) {
    final parts = entry.split('::');
    if (parts.length == 2) {
      details[parts[0]] = parts[1];
    }
  }
  return details;
});

/// Notifier for managing blocked peers with persistence.
class BlockedPeersNotifier extends StateNotifier<Set<String>> {
  final SharedPreferences _prefs;

  BlockedPeersNotifier(this._prefs) : super(_load(_prefs));

  static Set<String> _load(SharedPreferences prefs) {
    final blocked = prefs.getStringList('blockedPeers') ?? [];
    return blocked.toSet();
  }

  Future<void> block(String peerId, {String? displayName}) async {
    state = {...state, peerId};
    await _prefs.setStringList('blockedPeers', state.toList());

    // Store display name if provided
    if (displayName != null) {
      final details = _prefs.getStringList('blockedPeerDetails') ?? [];
      details.add('$peerId::$displayName');
      await _prefs.setStringList('blockedPeerDetails', details);
    }
  }

  Future<void> unblock(String peerId) async {
    state = {...state}..remove(peerId);
    await _prefs.setStringList('blockedPeers', state.toList());

    // Remove from details
    final details = _prefs.getStringList('blockedPeerDetails') ?? [];
    details.removeWhere((entry) => entry.startsWith('$peerId::'));
    await _prefs.setStringList('blockedPeerDetails', details);
  }

  bool isBlocked(String peerId) => state.contains(peerId);
}

/// Provider for external connection status.
final externalConnectionEnabledProvider = StateProvider<bool>((ref) => false);

/// Provider for the signaling server URL.
final signalingServerUrlProvider = StateProvider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getString('signalingServerUrl') ?? 'wss://zajel-signaling.example.com';
});

/// Provider for our external pairing code.
final pairingCodeProvider = StateProvider<String?>((ref) => null);

/// Provider for file receive service.
final fileReceiveServiceProvider = Provider<FileReceiveService>((ref) {
  final service = FileReceiveService();
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for active file transfers stream.
final fileTransfersStreamProvider = StreamProvider<FileTransfer>((ref) {
  final service = ref.watch(fileReceiveServiceProvider);
  return service.transferUpdates;
});

/// Provider for file transfer starts.
final fileStartsStreamProvider = StreamProvider<(String, String, String, int, int)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.fileStarts;
});

/// Provider for file transfer chunks.
final fileChunksStreamProvider = StreamProvider<(String, String, dynamic, int, int)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.fileChunks;
});

/// Provider for file transfer completions.
final fileCompletesStreamProvider = StreamProvider<(String, String)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.fileCompletes;
});
