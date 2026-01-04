import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../crypto/crypto_service.dart';
import '../models/models.dart';
import '../network/connection_manager.dart';
import '../network/discovery_service.dart';
import '../network/webrtc_service.dart';

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

/// Provider for external connection status.
final externalConnectionEnabledProvider = StateProvider<bool>((ref) => false);

/// Provider for the signaling server URL.
final signalingServerUrlProvider = StateProvider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getString('signalingServerUrl') ?? 'wss://zajel-signaling.example.com';
});

/// Provider for our external pairing code.
final pairingCodeProvider = StateProvider<String?>((ref) => null);
