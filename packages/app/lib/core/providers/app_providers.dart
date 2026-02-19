import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/environment.dart';
import '../crypto/bootstrap_verifier.dart';
import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../models/models.dart';
import '../network/connection_manager.dart';
import '../network/device_link_service.dart';
import '../network/meeting_point_service.dart';
import '../network/peer_reconnection_service.dart';
import '../network/relay_client.dart';
import '../network/server_discovery_service.dart';
import '../network/signaling_client.dart'
    show SignalingClient, RendezvousResult, RendezvousPartial, RendezvousMatch;
import '../network/webrtc_service.dart';
import '../media/background_blur_processor.dart';
import '../media/media_service.dart';
import '../notifications/notification_service.dart';
import '../network/voip_service.dart';
import '../storage/file_receive_service.dart';
import '../storage/message_storage.dart';
import '../storage/trusted_peers_storage.dart';
import '../storage/trusted_peers_storage_impl.dart';

/// Provider for shared preferences.
final sharedPreferencesProvider = Provider<SharedPreferences>((ref) {
  throw UnimplementedError('Must be overridden with actual instance');
});

/// Provider for theme mode selection (Light / Dark / System).
/// Persisted to SharedPreferences under 'themeMode'.
final themeModeProvider =
    StateNotifierProvider<ThemeModeNotifier, ThemeMode>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return ThemeModeNotifier(prefs);
});

class ThemeModeNotifier extends StateNotifier<ThemeMode> {
  final SharedPreferences _prefs;
  static const _key = 'themeMode';

  ThemeModeNotifier(this._prefs) : super(_load(_prefs));

  static ThemeMode _load(SharedPreferences prefs) {
    final value = prefs.getString(_key);
    return switch (value) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    state = mode;
    await _prefs.setString(
      _key,
      switch (mode) {
        ThemeMode.light => 'light',
        ThemeMode.dark => 'dark',
        ThemeMode.system => 'system',
      },
    );
  }
}

/// Provider for whether the user has seen the onboarding tutorial.
final hasSeenOnboardingProvider = StateProvider<bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getBool('hasSeenOnboarding') ?? false;
});

/// Provider for the user's username (Discord-style, without tag).
/// Reads 'username' key first, falls back to 'displayName' for migration.
final usernameProvider = StateProvider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getString('username') ??
      prefs.getString('displayName') ??
      'Anonymous';
});

/// Provider for the user's full identity string: "Username#TAG".
/// The tag is derived deterministically from the stable ID (key-independent).
final userIdentityProvider = Provider<String>((ref) {
  final username = ref.watch(usernameProvider);
  try {
    final cryptoService = ref.watch(cryptoServiceProvider);
    final tag = CryptoService.tagFromStableId(cryptoService.stableId);
    return '$username#$tag';
  } catch (_) {
    // CryptoService not initialized yet
    return username;
  }
});

/// Provider for notification settings with SharedPreferences persistence.
final notificationSettingsProvider =
    StateNotifierProvider<NotificationSettingsNotifier, NotificationSettings>(
        (ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return NotificationSettingsNotifier(prefs);
});

/// Provider for crypto service.
///
/// SharedPreferences is injected for stableId persistence (resilient storage).
/// FlutterSecureStorage is used internally for private keys (secure storage).
final cryptoServiceProvider = Provider<CryptoService>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return CryptoService(prefs: prefs);
});

/// Provider for WebRTC service.
final webrtcServiceProvider = Provider<WebRTCService>((ref) {
  final cryptoService = ref.watch(cryptoServiceProvider);
  // Support TURN servers via environment variables in any mode.
  // In E2E test mode, forceRelay=true to avoid wasting time on direct connection attempts.
  // In normal mode with TURN, still try direct connections first (forceRelay=false).
  List<Map<String, dynamic>>? iceServers;
  const turnUrl = String.fromEnvironment('TURN_URL', defaultValue: '');
  const turnUser = String.fromEnvironment('TURN_USER', defaultValue: '');
  const turnPass = String.fromEnvironment('TURN_PASS', defaultValue: '');
  if (turnUrl.isNotEmpty) {
    iceServers = [
      {'urls': 'stun:stun.l.google.com:19302'},
      {
        'urls': turnUrl,
        'username': turnUser,
        'credential': turnPass,
      },
    ];
  }
  return WebRTCService(
    cryptoService: cryptoService,
    iceServers: iceServers,
    // Only force relay in E2E test mode (faster, avoids direct connection attempts)
    forceRelay: iceServers != null && Environment.isE2eTest,
  );
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
final peerReconnectionServiceProvider =
    Provider<PeerReconnectionService?>((ref) {
  final relayClient = ref.watch(relayClientProvider);
  final signalingClient = ref.watch(signalingClientProvider);
  if (relayClient == null) return null;

  final cryptoService = ref.watch(cryptoServiceProvider);
  final trustedPeers = ref.watch(trustedPeersStorageProvider);
  final meetingPointService = ref.watch(meetingPointServiceProvider);

  final service = PeerReconnectionService(
    cryptoService: cryptoService,
    trustedPeers: trustedPeers,
    meetingPointService: meetingPointService,
    relayClient: relayClient,
  );

  // Wire up signaling rendezvous events if signaling is connected
  if (signalingClient != null) {
    signalingClient.rendezvousEvents.listen((event) {
      switch (event) {
        case RendezvousResult(:final liveMatches, :final deadDrops):
          // Process live matches
          for (final match in liveMatches) {
            service.processLiveMatchFromRendezvous(match.peerId, match.relayId);
          }
          // Process dead drops
          for (final drop in deadDrops) {
            service.processDeadDropFromRendezvous(
                drop.peerId, drop.encryptedData, drop.relayId);
          }
        case RendezvousPartial(
            :final liveMatches,
            :final deadDrops,
            redirects: _
          ):
          // Process local results
          for (final match in liveMatches) {
            service.processLiveMatchFromRendezvous(match.peerId, match.relayId);
          }
          for (final drop in deadDrops) {
            service.processDeadDropFromRendezvous(
                drop.peerId, drop.encryptedData, drop.relayId);
          }
        // Redirects are handled by the signaling layer - no action needed here
        // Future: implement federated server connection for redirects
        case RendezvousMatch(:final peerId, :final relayId, meetingPoint: _):
          service.processLiveMatchFromRendezvous(peerId, relayId);
      }
    });
  }

  ref.onDispose(() => service.dispose());
  return service;
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
  final trustedPeersStorage = ref.watch(trustedPeersStorageProvider);
  final meetingPointService = ref.watch(meetingPointServiceProvider);
  final blockedNotifier = ref.watch(blockedPeersProvider.notifier);
  final username = ref.watch(usernameProvider);

  // Trigger migration from publicKey blocks to peerId blocks (one-time, no-op if done)
  blockedNotifier.migrateFromPublicKeys();

  return ConnectionManager(
    cryptoService: cryptoService,
    webrtcService: webrtcService,
    deviceLinkService: deviceLinkService,
    trustedPeersStorage: trustedPeersStorage,
    meetingPointService: meetingPointService,
    isPublicKeyBlocked: blockedNotifier.isPublicKeyBlocked,
    username: username,
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
/// Seeds with the current snapshot so cached peers appear immediately,
/// then stays updated via the broadcast stream.
final peersProvider = StreamProvider<List<Peer>>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);

  // Create a stream that emits the current snapshot first, then follows
  // the broadcast stream. This prevents the UI from staying in "loading"
  // state when the initial broadcast event was missed (broadcast streams
  // don't buffer past events for late subscribers).
  Stream<List<Peer>> seeded() async* {
    yield connectionManager.currentPeers;
    yield* connectionManager.peers;
  }

  return seeded();
});

/// Provider for visible peers (excluding blocked by stableId).
/// Sorted: connected first, then offline by lastSeen descending.
final visiblePeersProvider = Provider<AsyncValue<List<Peer>>>((ref) {
  final peersAsync = ref.watch(peersProvider);
  final blockedPeerIds = ref.watch(blockedPeersProvider);

  return peersAsync.whenData((peers) {
    final visible = peers.where((peer) {
      return !blockedPeerIds.contains(peer.id);
    }).toList();

    // Sort: connected/connecting first, then offline by lastSeen descending
    visible.sort((a, b) {
      final aOnline = a.connectionState == PeerConnectionState.connected ||
          a.connectionState == PeerConnectionState.connecting ||
          a.connectionState == PeerConnectionState.handshaking;
      final bOnline = b.connectionState == PeerConnectionState.connected ||
          b.connectionState == PeerConnectionState.connecting ||
          b.connectionState == PeerConnectionState.handshaking;

      if (aOnline && !bOnline) return -1;
      if (!aOnline && bOnline) return 1;
      // Within same group, sort by lastSeen descending
      return b.lastSeen.compareTo(a.lastSeen);
    });

    return visible;
  });
});

/// Provider for incoming messages.
final messagesStreamProvider = StreamProvider<(String, String)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.messages;
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

/// Provider for peer aliases (peerId -> alias).
/// Loaded from TrustedPeersStorage and updated in-memory when user renames.
final peerAliasesProvider = StateProvider<Map<String, String>>((ref) => {});

/// Provider for the currently selected peer.
final selectedPeerProvider = StateProvider<Peer?>((ref) => null);

/// Provider for blocked peer IDs (stableIds — survive key rotation).
final blockedPeersProvider =
    StateNotifierProvider<BlockedPeersNotifier, Set<String>>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  final trustedPeersStorage = ref.watch(trustedPeersStorageProvider);
  return BlockedPeersNotifier(prefs, trustedPeersStorage);
});

/// Provider for blocked peer details (peerId -> name mapping).
///
/// Watches [blockedPeersProvider] to re-read from SharedPreferences whenever
/// the block set changes (block/unblock). This prevents stale UI state.
final blockedPeerDetailsProvider = Provider<Map<String, String>>((ref) {
  // Watch the blocked set — when it changes (block/unblock), we re-read details
  ref.watch(blockedPeersProvider);
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
///
/// Blocks by peer ID (stableId) so blocks survive key rotation.
/// Also maintains a secondary set of blocked public keys for
/// rejecting pair requests before stableId is known.
class BlockedPeersNotifier extends StateNotifier<Set<String>> {
  final SharedPreferences _prefs;
  final TrustedPeersStorage _trustedPeersStorage;

  /// Secondary set: blocked public keys for pair request rejection.
  Set<String> _blockedPublicKeys = {};

  BlockedPeersNotifier(this._prefs, this._trustedPeersStorage)
      : super(_load(_prefs)) {
    _blockedPublicKeys =
        (_prefs.getStringList('blockedPublicKeys') ?? []).toSet();
  }

  static Set<String> _load(SharedPreferences prefs) {
    // Primary: stableId-based blocked set
    final blockedIds = prefs.getStringList('blockedPeerIds');
    if (blockedIds != null) return blockedIds.toSet();

    // Migration: fall back to legacy publicKey-based set
    final legacyBlocked = prefs.getStringList('blockedPublicKeys') ?? [];
    return legacyBlocked.toSet();
  }

  /// Run one-time migration from publicKey-based blocks to peerId-based.
  ///
  /// Looks up TrustedPeer records to map publicKeys to stableIds.
  /// Should be called once after app initialization.
  Future<void> migrateFromPublicKeys() async {
    // Skip if already migrated
    if (_prefs.containsKey('blockedPeerIds')) return;

    final legacyBlocked = _prefs.getStringList('blockedPublicKeys') ?? [];
    if (legacyBlocked.isEmpty) {
      await _prefs.setStringList('blockedPeerIds', []);
      return;
    }

    final peers = await _trustedPeersStorage.getAllPeers();
    final migratedIds = <String>{};
    final migratedDetails = <String>[];
    final existingDetails = _prefs.getStringList('blockedPeerDetails') ?? [];

    for (final publicKey in legacyBlocked) {
      // Find the peer with this publicKey to get their stableId
      final peer = peers.where((p) => p.publicKey == publicKey).firstOrNull;
      if (peer != null) {
        migratedIds.add(peer.id);
        // Migrate display name mapping
        for (final detail in existingDetails) {
          if (detail.startsWith('$publicKey::')) {
            final name = detail.substring(publicKey.length + 2);
            migratedDetails.add('${peer.id}::$name');
          }
        }
      } else {
        // No matching peer found — keep publicKey as-is (it may be a stableId already)
        migratedIds.add(publicKey);
      }
    }

    state = migratedIds;
    await _prefs.setStringList('blockedPeerIds', migratedIds.toList());
    if (migratedDetails.isNotEmpty) {
      await _prefs.setStringList('blockedPeerDetails', migratedDetails);
    }
  }

  /// Block a peer by their ID (stableId).
  Future<void> block(String peerId,
      {String? publicKey, String? displayName}) async {
    state = {...state, peerId};
    await _prefs.setStringList('blockedPeerIds', state.toList());

    // Also track the publicKey for pair request rejection
    if (publicKey != null) {
      _blockedPublicKeys.add(publicKey);
      await _prefs.setStringList(
          'blockedPublicKeys', _blockedPublicKeys.toList());
    }

    // Store display name if provided
    if (displayName != null) {
      final details = _prefs.getStringList('blockedPeerDetails') ?? [];
      details.removeWhere((entry) => entry.startsWith('$peerId::'));
      details.add('$peerId::$displayName');
      await _prefs.setStringList('blockedPeerDetails', details);
    }

    // Store blockedAt timestamp
    final timestamps = _prefs.getStringList('blockedTimestamps') ?? [];
    timestamps.removeWhere((e) => e.startsWith('$peerId::'));
    timestamps.add('$peerId::${DateTime.now().toIso8601String()}');
    await _prefs.setStringList('blockedTimestamps', timestamps);

    // Sync to TrustedPeersStorage
    await _syncBlockToTrustedPeers(peerId, blocked: true);
  }

  /// Unblock a peer by their ID (stableId).
  Future<void> unblock(String peerId) async {
    state = {...state}..remove(peerId);
    await _prefs.setStringList('blockedPeerIds', state.toList());

    // Also remove from publicKey blocklist
    final peer = await _trustedPeersStorage.getPeer(peerId);
    if (peer != null) {
      _blockedPublicKeys.remove(peer.publicKey);
      await _prefs.setStringList(
          'blockedPublicKeys', _blockedPublicKeys.toList());
    }

    // Remove from details
    final details = _prefs.getStringList('blockedPeerDetails') ?? [];
    details.removeWhere((entry) => entry.startsWith('$peerId::'));
    await _prefs.setStringList('blockedPeerDetails', details);

    // Sync to TrustedPeersStorage
    await _syncBlockToTrustedPeers(peerId, blocked: false);
  }

  /// Check if a peer ID (stableId) is blocked.
  bool isBlocked(String peerId) => state.contains(peerId);

  /// Check if a public key is blocked (for pair request rejection).
  bool isPublicKeyBlocked(String publicKey) =>
      _blockedPublicKeys.contains(publicKey);

  /// Get when a peer was blocked.
  DateTime? getBlockedAt(String peerId) {
    final timestamps = _prefs.getStringList('blockedTimestamps') ?? [];
    for (final entry in timestamps) {
      final parts = entry.split('::');
      if (parts.length == 2 && parts[0] == peerId) {
        return DateTime.tryParse(parts[1]);
      }
    }
    return null;
  }

  /// Unblock and permanently remove a peer from trusted storage.
  Future<void> removePermanently(String peerId) async {
    await unblock(peerId);
    await _trustedPeersStorage.removePeer(peerId);
    // Remove blockedAt timestamp
    final timestamps = _prefs.getStringList('blockedTimestamps') ?? [];
    timestamps.removeWhere((e) => e.startsWith('$peerId::'));
    await _prefs.setStringList('blockedTimestamps', timestamps);
  }

  /// Sync block status to TrustedPeersStorage.
  Future<void> _syncBlockToTrustedPeers(String peerId,
      {required bool blocked}) async {
    final peer = await _trustedPeersStorage.getPeer(peerId);
    if (peer != null) {
      await _trustedPeersStorage.savePeer(peer.copyWith(isBlocked: blocked));
    }
  }
}

/// Provider for signaling connection status.
final signalingConnectedProvider = StateProvider<bool>((ref) => false);

/// Provider for signaling connection state (for UI display).
enum SignalingDisplayState {
  disconnected,
  connecting,
  connected,
}

final signalingDisplayStateProvider =
    StateProvider<SignalingDisplayState>((ref) {
  return SignalingDisplayState.disconnected;
});

/// Default bootstrap server URL (CF Workers).
/// Can be overridden at build time with `--dart-define=BOOTSTRAP_URL=<url>`.
const defaultBootstrapUrl = 'https://signal.zajel.hamzalabs.dev';

/// Effective bootstrap URL (compile-time override or default).
String get _effectiveBootstrapUrl => Environment.hasCustomBootstrapUrl
    ? Environment.bootstrapUrl
    : defaultBootstrapUrl;

/// Provider for the bootstrap server URL.
final bootstrapServerUrlProvider = StateProvider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getString('bootstrapServerUrl') ?? _effectiveBootstrapUrl;
});

/// Provider for bootstrap response verifier.
///
/// Verifies Ed25519 signatures on GET /servers responses from the bootstrap server.
/// Disabled in E2E test mode (test servers don't have signing keys).
final bootstrapVerifierProvider = Provider<BootstrapVerifier?>((ref) {
  if (Environment.isE2eTest) return null;
  return BootstrapVerifier();
});

/// Provider for server discovery service.
final serverDiscoveryServiceProvider = Provider<ServerDiscoveryService>((ref) {
  final bootstrapUrl = ref.watch(bootstrapServerUrlProvider);
  final verifier = ref.watch(bootstrapVerifierProvider);
  final service = ServerDiscoveryService(
    bootstrapUrl: bootstrapUrl,
    bootstrapVerifier: verifier,
  );
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for discovered servers.
final discoveredServersProvider =
    FutureProvider<List<DiscoveredServer>>((ref) async {
  final service = ref.watch(serverDiscoveryServiceProvider);
  return service.fetchServers();
});

/// Provider for the currently selected VPS server.
final selectedServerProvider = StateProvider<DiscoveredServer?>((ref) => null);

/// Provider for the signaling server URL (from selected VPS server).
/// Can be overridden at build time with `--dart-define=SIGNALING_URL=<url>`.
final signalingServerUrlProvider = Provider<String?>((ref) {
  // If a direct signaling URL is provided via --dart-define, use it
  if (Environment.hasDirectSignalingUrl) {
    return Environment.signalingUrl;
  }

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
final fileStartsStreamProvider =
    StreamProvider<(String, String, String, int, int)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.fileStarts;
});

/// Provider for file transfer chunks.
final fileChunksStreamProvider =
    StreamProvider<(String, String, dynamic, int, int)>((ref) {
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

/// Provider for notification service.
final notificationServiceProvider = Provider<NotificationService>((ref) {
  return NotificationService();
});

/// Provider for background blur processor.
final backgroundBlurProvider = Provider<BackgroundBlurProcessor>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  final processor = BackgroundBlurProcessor();
  processor.initPreferences(prefs);
  ref.onDispose(() => processor.dispose());
  return processor;
});

/// Provider for media service.
final mediaServiceProvider = Provider<MediaService>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  final service = MediaService();
  service.initPreferences(prefs);
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for VoIP service (created lazily when signaling is connected).
final voipServiceProvider = Provider<VoIPService?>((ref) {
  final signalingClient = ref.watch(signalingClientProvider);
  if (signalingClient == null) return null;

  final mediaService = ref.watch(mediaServiceProvider);

  // Support TURN servers via environment variables for VoIP calls.
  List<Map<String, dynamic>>? iceServers;
  const turnUrl = String.fromEnvironment('TURN_URL', defaultValue: '');
  const turnUser = String.fromEnvironment('TURN_USER', defaultValue: '');
  const turnPass = String.fromEnvironment('TURN_PASS', defaultValue: '');
  if (turnUrl.isNotEmpty) {
    iceServers = [
      {'urls': 'stun:stun.l.google.com:19302'},
      {
        'urls': turnUrl,
        'username': turnUser,
        'credential': turnPass,
      },
    ];
  }

  final voipService = VoIPService(mediaService, signalingClient,
      iceServers: iceServers,
      forceRelay: iceServers != null && Environment.isE2eTest);
  ref.onDispose(() => voipService.dispose());
  return voipService;
});

/// Notifier for managing notification settings with persistence.
class NotificationSettingsNotifier extends StateNotifier<NotificationSettings> {
  final SharedPreferences _prefs;
  static const _key = 'notificationSettings';

  NotificationSettingsNotifier(this._prefs) : super(_load(_prefs));

  static NotificationSettings _load(SharedPreferences prefs) {
    final data = prefs.getString(_key);
    if (data == null) return const NotificationSettings();
    return NotificationSettings.deserialize(data);
  }

  Future<void> _save() async {
    await _prefs.setString(_key, state.serialize());
  }

  Future<void> setGlobalDnd(bool enabled, {DateTime? until}) async {
    state = state.copyWith(
        globalDnd: enabled,
        dndUntil: until,
        clearDndUntil: until == null && !enabled);
    await _save();
  }

  Future<void> setSoundEnabled(bool enabled) async {
    state = state.copyWith(soundEnabled: enabled);
    await _save();
  }

  Future<void> setPreviewEnabled(bool enabled) async {
    state = state.copyWith(previewEnabled: enabled);
    await _save();
  }

  Future<void> setMessageNotifications(bool enabled) async {
    state = state.copyWith(messageNotifications: enabled);
    await _save();
  }

  Future<void> setCallNotifications(bool enabled) async {
    state = state.copyWith(callNotifications: enabled);
    await _save();
  }

  Future<void> setPeerStatusNotifications(bool enabled) async {
    state = state.copyWith(peerStatusNotifications: enabled);
    await _save();
  }

  Future<void> setFileReceivedNotifications(bool enabled) async {
    state = state.copyWith(fileReceivedNotifications: enabled);
    await _save();
  }

  Future<void> mutePeer(String peerId) async {
    state = state.copyWith(mutedPeerIds: {...state.mutedPeerIds, peerId});
    await _save();
  }

  Future<void> unmutePeer(String peerId) async {
    state =
        state.copyWith(mutedPeerIds: {...state.mutedPeerIds}..remove(peerId));
    await _save();
  }

  bool isPeerMuted(String peerId) => state.mutedPeerIds.contains(peerId);
}

// ── Auto-Delete Messages ──────────────────────────────────

/// Settings for automatic message deletion.
class AutoDeleteSettings {
  final bool enabled;
  final Duration duration;

  const AutoDeleteSettings({
    this.enabled = false,
    this.duration = const Duration(hours: 24),
  });

  AutoDeleteSettings copyWith({bool? enabled, Duration? duration}) {
    return AutoDeleteSettings(
      enabled: enabled ?? this.enabled,
      duration: duration ?? this.duration,
    );
  }

  /// Available auto-delete duration options (minutes -> label).
  static const durations = <int, String>{
    60: '1 hour',
    360: '6 hours',
    1440: '24 hours',
    10080: '7 days',
    43200: '30 days',
  };
}

final autoDeleteSettingsProvider =
    StateNotifierProvider<AutoDeleteSettingsNotifier, AutoDeleteSettings>(
        (ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return AutoDeleteSettingsNotifier(prefs);
});

class AutoDeleteSettingsNotifier extends StateNotifier<AutoDeleteSettings> {
  final SharedPreferences _prefs;
  static const _enabledKey = 'autoDeleteEnabled';
  static const _durationKey = 'autoDeleteDurationMinutes';

  AutoDeleteSettingsNotifier(this._prefs) : super(_load(_prefs));

  static AutoDeleteSettings _load(SharedPreferences prefs) {
    final enabled = prefs.getBool(_enabledKey) ?? false;
    final minutes = prefs.getInt(_durationKey) ?? 1440; // 24 hours
    return AutoDeleteSettings(
      enabled: enabled,
      duration: Duration(minutes: minutes),
    );
  }

  Future<void> setEnabled(bool enabled) async {
    state = state.copyWith(enabled: enabled);
    await _prefs.setBool(_enabledKey, enabled);
  }

  Future<void> setDuration(Duration duration) async {
    state = state.copyWith(duration: duration);
    await _prefs.setInt(_durationKey, duration.inMinutes);
  }
}

// ── Privacy Screen ──────────────────────────────────

/// Whether the app-switcher privacy screen is enabled.
/// When enabled, the app content is obscured when the app goes to background,
/// preventing sensitive content from appearing in the app switcher / recent apps.
final privacyScreenProvider =
    StateNotifierProvider<PrivacyScreenNotifier, bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return PrivacyScreenNotifier(prefs);
});

class PrivacyScreenNotifier extends StateNotifier<bool> {
  final SharedPreferences _prefs;
  static const _key = 'privacyScreenEnabled';

  PrivacyScreenNotifier(this._prefs)
      : super(_prefs.getBool(_key) ?? true); // enabled by default

  Future<void> setEnabled(bool enabled) async {
    state = enabled;
    await _prefs.setBool(_key, enabled);
  }
}
