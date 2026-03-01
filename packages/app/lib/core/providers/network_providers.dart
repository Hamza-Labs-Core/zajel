import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/environment.dart';
import '../models/models.dart';
import '../storage/trusted_peers_storage.dart';
import '../network/connection_manager.dart';
import '../network/device_link_service.dart';
import '../network/meeting_point_service.dart';
import '../network/peer_reconnection_service.dart';
import '../network/relay_client.dart';
import '../network/server_discovery_service.dart';
import '../network/signaling_client.dart'
    show SignalingClient, RendezvousResult, RendezvousPartial, RendezvousMatch;
import '../network/voip_service.dart';
import '../network/webrtc_service.dart';
import 'chat_providers.dart';
import 'crypto_providers.dart';
import 'media_providers.dart';
import 'peer_providers.dart';
import 'preferences_providers.dart';

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
    final sub = signalingClient.rendezvousEvents.listen((event) {
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
    ref.onDispose(() => sub.cancel());
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

  final messageStorage = ref.watch(messageStorageProvider);

  return ConnectionManager(
    cryptoService: cryptoService,
    webrtcService: webrtcService,
    deviceLinkService: deviceLinkService,
    trustedPeersStorage: trustedPeersStorage,
    meetingPointService: meetingPointService,
    messageStorage: messageStorage,
    isPublicKeyBlocked: blockedNotifier.isPublicKeyBlocked,
    username: username,
  );
});

/// Stream of key rotation events emitted by ConnectionManager.
///
/// Each event is (peerId, oldPublicKey, newPublicKey). The UI can listen
/// to this to show real-time warnings when a peer's key changes.
final keyChangeStreamProvider = StreamProvider<(String, String, String)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.keyChanges;
});

/// Provider for peers with unacknowledged key changes.
///
/// Returns a map of peerId → TrustedPeer for all peers where
/// keyChangeAcknowledged is false. Used by chat screen to show
/// the key change warning banner.
final pendingKeyChangesProvider =
    FutureProvider<Map<String, TrustedPeer>>((ref) async {
  // Re-evaluate when a key change event fires
  ref.watch(keyChangeStreamProvider);
  final storage = ref.watch(trustedPeersStorageProvider);
  final peers = await storage.getPeersWithPendingKeyChanges();
  return {for (final p in peers) p.id: p};
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

/// Default bootstrap server URL (CF Workers).
/// Can be overridden at build time with `--dart-define=BOOTSTRAP_URL=<url>`.
const defaultBootstrapUrl = 'https://signal.zajel.qa.hamzalabs.dev';

/// Effective bootstrap URL (compile-time override or default).
String get _effectiveBootstrapUrl => Environment.hasCustomBootstrapUrl
    ? Environment.bootstrapUrl
    : defaultBootstrapUrl;

/// Provider for the bootstrap server URL.
final bootstrapServerUrlProvider = StateProvider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getString('bootstrapServerUrl') ?? _effectiveBootstrapUrl;
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
