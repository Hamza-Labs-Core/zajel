import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/models.dart';
import '../storage/trusted_peers_storage.dart';
import 'crypto_providers.dart';
import 'network_providers.dart';
import 'preferences_providers.dart';

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

  final peers = peersAsync.valueOrNull;
  if (peers == null) return peersAsync;

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

  return AsyncData(visible);
});

/// Provider for the currently selected peer.
final selectedPeerProvider = StateProvider<Peer?>((ref) => null);

/// Provider for peer aliases (peerId -> alias).
/// Loaded from TrustedPeersStorage and updated in-memory when user renames.
final peerAliasesProvider = StateProvider<Map<String, String>>((ref) => {});

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
