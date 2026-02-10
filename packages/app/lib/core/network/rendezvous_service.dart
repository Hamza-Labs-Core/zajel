import 'dart:async';
import 'dart:convert';

import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../storage/trusted_peers_storage.dart';
import 'connection_info.dart';
import 'dead_drop.dart';
import 'meeting_point_service.dart';

/// Service for managing peer rendezvous via meeting points and dead drops.
///
/// The rendezvous service coordinates finding and reconnecting with trusted peers:
/// 1. Derives meeting points from public keys (daily) and shared secrets (hourly)
/// 2. Creates encrypted dead drops containing our connection info
/// 3. Handles live matches when another peer is online at the same meeting point
/// 4. Decrypts dead drops left by peers when we were offline
///
/// ## Privacy
/// - The signaling server only sees opaque meeting point hashes
/// - Dead drop contents are encrypted with the peer's shared secret
/// - No peer relationship is revealed to the server
class RendezvousService {
  final MeetingPointService _meetingPointService;
  final CryptoService _cryptoService;
  final TrustedPeersStorage _trustedPeersStorage;

  final _peerFoundController = StreamController<PeerFoundEvent>.broadcast();
  final _deadDropController = StreamController<DeadDropEvent>.broadcast();

  /// Emitted when a peer is found (live or via dead drop).
  Stream<PeerFoundEvent> get onPeerFound => _peerFoundController.stream;

  /// Emitted when a dead drop is received and decrypted.
  Stream<DeadDropEvent> get onDeadDropReceived => _deadDropController.stream;

  RendezvousService({
    required MeetingPointService meetingPointService,
    required CryptoService cryptoService,
    required TrustedPeersStorage trustedPeersStorage,
  })  : _meetingPointService = meetingPointService,
        _cryptoService = cryptoService,
        _trustedPeersStorage = trustedPeersStorage;

  /// Create a registration for a specific peer.
  ///
  /// This derives meeting points and creates a dead drop, ready to be
  /// sent to the signaling server.
  ///
  /// Throws [PeerNotFoundException] if the peer is not in trusted storage.
  Future<RendezvousRegistration> createRegistrationForPeer(
      String peerId) async {
    // Get keys
    final myPubkey = await _cryptoService.getPublicKeyBytes();
    final theirPubkey = await _trustedPeersStorage.getPublicKeyBytes(peerId);

    if (theirPubkey == null) {
      throw PeerNotFoundException(peerId);
    }

    // Derive meeting points
    final dailyPoints =
        _meetingPointService.deriveDailyPoints(myPubkey, theirPubkey);

    // Derive hourly tokens (if we have shared secret)
    final sharedSecret = await _cryptoService.getSessionKeyBytes(peerId);
    final hourlyTokens = sharedSecret != null
        ? _meetingPointService.deriveHourlyTokens(sharedSecret)
        : <String>[];

    // Create dead drop
    final deadDrop = await createDeadDrop(peerId);

    return RendezvousRegistration(
      dailyPoints: dailyPoints,
      hourlyTokens: hourlyTokens,
      deadDrop: deadDrop,
      relayId: '', // Will be filled by caller with actual relay ID
    );
  }

  /// Create registrations for all trusted peers.
  ///
  /// Returns a map of peer IDs to their registrations.
  /// Peers that fail are silently skipped (logged but not thrown).
  Future<Map<String, RendezvousRegistration>>
      createRegistrationsForAllPeers() async {
    final peerIds = await _trustedPeersStorage.getAllPeerIds();
    final registrations = <String, RendezvousRegistration>{};

    for (final peerId in peerIds) {
      try {
        registrations[peerId] = await createRegistrationForPeer(peerId);
      } catch (e) {
        // Log error but continue with other peers
        // In production, this should use a proper logger
        logger.error('RendezvousService',
            'Failed to create registration for $peerId', e);
      }
    }

    return registrations;
  }

  /// Create an encrypted dead drop for a specific peer.
  ///
  /// The dead drop contains our connection information encrypted with
  /// the peer's shared secret, so only they can decrypt it.
  Future<String> createDeadDrop(
    String peerId, {
    String? relayId,
    String? sourceId,
    String? ip,
    int? port,
    List<String>? fallbackRelays,
  }) async {
    final info = ConnectionInfo(
      publicKey: await _cryptoService.getPublicKeyBase64(),
      relayId: relayId ?? '',
      sourceId: sourceId ?? '',
      ip: ip ?? '0.0.0.0',
      port: port ?? 0,
      fallbackRelays: fallbackRelays ?? const [],
      timestamp: DateTime.now().toUtc(),
    );

    final plaintext = jsonEncode(info.toJson());
    return _cryptoService.encryptForPeer(peerId, plaintext);
  }

  /// Decrypt a dead drop payload from a peer.
  ///
  /// Throws [DeadDropDecryptionException] if decryption fails.
  Future<ConnectionInfo> decryptDeadDrop(
      String encrypted, String peerId) async {
    try {
      final plaintext = await _cryptoService.decryptFromPeer(peerId, encrypted);
      final json = jsonDecode(plaintext) as Map<String, dynamic>;
      return ConnectionInfo.fromJson(json);
    } catch (e) {
      throw DeadDropDecryptionException(
          'Failed to decrypt dead drop from $peerId: $e');
    }
  }

  /// Handle a live match notification.
  ///
  /// Emits a [PeerFoundEvent] with connection type [ConnectionType.live].
  Future<void> handleLiveMatch(LiveMatch match) async {
    _peerFoundController.add(PeerFoundEvent(
      peerId: match.peerId,
      connectionType: ConnectionType.live,
      relayId: match.relayId,
      meetingPoint: match.meetingPoint,
    ));
  }

  /// Handle a dead drop.
  ///
  /// Decrypts the dead drop and emits both [DeadDropEvent] and [PeerFoundEvent].
  Future<void> handleDeadDrop(DeadDrop drop) async {
    final peerId = drop.peerId;
    if (peerId == null) {
      throw DeadDropDecryptionException(
          'Cannot handle dead drop without peer ID');
    }

    final connectionInfo = await decryptDeadDrop(drop.encryptedPayload, peerId);

    _deadDropController.add(DeadDropEvent(
      peerId: peerId,
      connectionInfo: connectionInfo,
      deadDrop: drop,
    ));

    _peerFoundController.add(PeerFoundEvent(
      peerId: peerId,
      connectionType: ConnectionType.deadDrop,
      relayId: connectionInfo.relayId,
      meetingPoint: drop.meetingPoint,
      connectionInfo: connectionInfo,
    ));
  }

  /// Process a rendezvous result from the signaling server.
  ///
  /// Prioritizes live matches over dead drops.
  Future<void> processRendezvousResult(
      String peerId, RendezvousResult result) async {
    if (!result.success) {
      // Log the error but don't throw
      logger.error('RendezvousService',
          'Rendezvous failed for $peerId: ${result.error}');
      return;
    }

    // Prioritize live matches
    if (result.liveMatches.isNotEmpty) {
      final match = result.liveMatches.first;
      await handleLiveMatch(match);
      return;
    }

    // Fall back to dead drops
    if (result.deadDrops.isNotEmpty) {
      final drop = result.deadDrops.first;
      // Ensure the peer ID is set
      final dropWithPeerId =
          drop.peerId != null ? drop : drop.copyWith(peerId: peerId);
      await handleDeadDrop(dropWithPeerId);
    }
  }

  /// Try to identify which peer a meeting point belongs to.
  ///
  /// Iterates through all trusted peers and checks if the meeting point
  /// matches any of them. Returns null if no match is found.
  Future<String?> identifyPeerFromMeetingPoint(String meetingPoint) async {
    final myPubkey = await _cryptoService.getPublicKeyBytes();
    final peerIds = await _trustedPeersStorage.getAllPeerIds();

    for (final peerId in peerIds) {
      final theirPubkey = await _trustedPeersStorage.getPublicKeyBytes(peerId);
      if (theirPubkey == null) continue;

      // Check if the meeting point matches this peer's daily points
      final dailyPoints =
          _meetingPointService.deriveDailyPoints(myPubkey, theirPubkey);
      if (dailyPoints.contains(meetingPoint)) {
        return peerId;
      }

      // Check hourly tokens if we have a shared secret
      final sharedSecret = await _cryptoService.getSessionKeyBytes(peerId);
      if (sharedSecret != null) {
        final hourlyTokens =
            _meetingPointService.deriveHourlyTokens(sharedSecret);
        if (hourlyTokens.contains(meetingPoint)) {
          return peerId;
        }
      }
    }

    return null;
  }

  /// Dispose resources and close streams.
  Future<void> dispose() async {
    await _peerFoundController.close();
    await _deadDropController.close();
  }
}

/// Event emitted when a peer is found.
class PeerFoundEvent {
  /// The peer ID (if known).
  final String? peerId;

  /// How the peer was found.
  final ConnectionType connectionType;

  /// The relay where the peer was found.
  final String? relayId;

  /// The meeting point where the match occurred.
  final String? meetingPoint;

  /// Connection info from dead drop (if available).
  final ConnectionInfo? connectionInfo;

  const PeerFoundEvent({
    this.peerId,
    required this.connectionType,
    this.relayId,
    this.meetingPoint,
    this.connectionInfo,
  });

  @override
  String toString() {
    return 'PeerFoundEvent(peerId: $peerId, type: $connectionType, relay: $relayId)';
  }
}

/// Event emitted when a dead drop is received and decrypted.
class DeadDropEvent {
  /// The peer ID who left the dead drop.
  final String peerId;

  /// The decrypted connection info.
  final ConnectionInfo connectionInfo;

  /// The original dead drop.
  final DeadDrop deadDrop;

  const DeadDropEvent({
    required this.peerId,
    required this.connectionInfo,
    required this.deadDrop,
  });

  @override
  String toString() {
    return 'DeadDropEvent(peerId: $peerId, info: $connectionInfo)';
  }
}

/// How a peer was found.
enum ConnectionType {
  /// Peer is currently online at the same meeting point.
  live,

  /// Peer left a dead drop (was online earlier).
  deadDrop,
}

/// Exception thrown when a peer is not found in trusted storage.
class PeerNotFoundException implements Exception {
  final String peerId;

  PeerNotFoundException(this.peerId);

  @override
  String toString() => 'PeerNotFoundException: Peer not found: $peerId';
}

/// Exception thrown when dead drop decryption fails.
class DeadDropDecryptionException implements Exception {
  final String message;

  DeadDropDecryptionException(this.message);

  @override
  String toString() => 'DeadDropDecryptionException: $message';
}
