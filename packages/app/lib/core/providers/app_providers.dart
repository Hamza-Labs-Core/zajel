import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../models/models.dart';
import '../network/connection_manager.dart';
import '../network/device_link_service.dart';
import '../network/meeting_point_service.dart';
import '../network/peer_reconnection_service.dart';
import '../network/relay_client.dart';
import '../network/server_discovery_service.dart';
import '../network/signaling_client.dart';
import '../network/webrtc_service.dart';
import '../media/media_service.dart';
import '../network/voip_service.dart';
import '../storage/file_receive_service.dart';
import '../storage/trusted_peers_storage.dart';
import '../storage/trusted_peers_storage_impl.dart';

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

/// Provider for WebRTC service.
final webrtcServiceProvider = Provider<WebRTCService>((ref) {
  final cryptoService = ref.watch(cryptoServiceProvider);
  return WebRTCService(cryptoService: cryptoService);
});

/// Provider for trusted peers storage.
final trustedPeersStorageProvider = Provider<TrustedPeersStorage>((ref) {
  return SecureTrustedPeersStorage();
});

/// Provider for meeting point service.
final meetingPointServiceProvider = Provider<MeetingPointService>((ref) {
  return MeetingPointService();
});

/// Provider for the signaling client (created lazily when external connections are enabled).
final signalingClientProvider = StateProvider<SignalingClient?>((ref) => null);

/// Provider for relay client (created lazily when signaling is connected).
final relayClientProvider = Provider<RelayClient?>((ref) {
  final signalingClient = ref.watch(signalingClientProvider);
  if (signalingClient == null) return null;

  final webrtcService = ref.watch(webrtcServiceProvider);
  return RelayClient(
    webrtcService: webrtcService,
    signalingClient: signalingClient,
  );
});

/// Provider for peer reconnection service (created lazily when relay is available).
final peerReconnectionServiceProvider = Provider<PeerReconnectionService?>((ref) {
  final relayClient = ref.watch(relayClientProvider);
  if (relayClient == null) return null;

  final cryptoService = ref.watch(cryptoServiceProvider);
  final trustedPeers = ref.watch(trustedPeersStorageProvider);
  final meetingPointService = ref.watch(meetingPointServiceProvider);

  return PeerReconnectionService(
    cryptoService: cryptoService,
    trustedPeers: trustedPeers,
    meetingPointService: meetingPointService,
    relayClient: relayClient,
  );
});

/// Provider for device link service (for linking web clients).
/// Must be defined before connectionManagerProvider since ConnectionManager depends on it.
final deviceLinkServiceProvider = Provider<DeviceLinkService>((ref) {
  final cryptoService = ref.watch(cryptoServiceProvider);
  final webrtcService = ref.watch(webrtcServiceProvider);

  final service = DeviceLinkService(
    cryptoService: cryptoService,
    webrtcService: webrtcService,
  );
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for connection manager.
final connectionManagerProvider = Provider<ConnectionManager>((ref) {
  final cryptoService = ref.watch(cryptoServiceProvider);
  final webrtcService = ref.watch(webrtcServiceProvider);
  final deviceLinkService = ref.watch(deviceLinkServiceProvider);

  return ConnectionManager(
    cryptoService: cryptoService,
    webrtcService: webrtcService,
    deviceLinkService: deviceLinkService,
  );
});

/// Provider for the list of linked devices.
final linkedDevicesProvider = StreamProvider<List<LinkedDevice>>((ref) {
  final deviceLinkService = ref.watch(deviceLinkServiceProvider);
  return deviceLinkService.linkedDevices;
});

/// Provider for current link session state.
final linkSessionStateProvider = StateProvider<DeviceLinkState>((ref) {
  return DeviceLinkIdle();
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

/// Provider for signaling connection status.
final signalingConnectedProvider = StateProvider<bool>((ref) => false);

/// Provider for signaling connection state (for UI display).
enum SignalingDisplayState {
  disconnected,
  connecting,
  connected,
}

final signalingDisplayStateProvider = StateProvider<SignalingDisplayState>((ref) {
  return SignalingDisplayState.disconnected;
});

/// Default bootstrap server URL (CF Workers).
const defaultBootstrapUrl = 'https://zajel-signaling.mahmoud-s-darwish.workers.dev';

/// Provider for the bootstrap server URL.
final bootstrapServerUrlProvider = StateProvider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getString('bootstrapServerUrl') ?? defaultBootstrapUrl;
});

/// Provider for server discovery service.
final serverDiscoveryServiceProvider = Provider<ServerDiscoveryService>((ref) {
  final bootstrapUrl = ref.watch(bootstrapServerUrlProvider);
  final service = ServerDiscoveryService(bootstrapUrl: bootstrapUrl);
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for discovered servers.
final discoveredServersProvider = FutureProvider<List<DiscoveredServer>>((ref) async {
  final service = ref.watch(serverDiscoveryServiceProvider);
  return service.fetchServers();
});

/// Provider for the currently selected VPS server.
final selectedServerProvider = StateProvider<DiscoveredServer?>((ref) => null);

/// Provider for the signaling server URL (from selected VPS server).
final signalingServerUrlProvider = Provider<String?>((ref) {
  final selectedServer = ref.watch(selectedServerProvider);
  if (selectedServer == null) return null;

  final service = ref.watch(serverDiscoveryServiceProvider);
  return service.getWebSocketUrl(selectedServer);
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

/// Provider for the logger service.
final loggerServiceProvider = Provider<LoggerService>((ref) {
  // Uses the singleton instance
  return LoggerService.instance;
});

/// Provider for media service.
final mediaServiceProvider = Provider<MediaService>((ref) {
  final service = MediaService();
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for VoIP service (created lazily when signaling is connected).
final voipServiceProvider = Provider<VoIPService?>((ref) {
  final signalingClient = ref.watch(signalingClientProvider);
  if (signalingClient == null) return null;

  final mediaService = ref.watch(mediaServiceProvider);
  final voipService = VoIPService(mediaService, signalingClient);
  ref.onDispose(() => voipService.dispose());
  return voipService;
});
