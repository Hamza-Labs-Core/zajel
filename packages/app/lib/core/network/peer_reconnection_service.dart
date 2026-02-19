import 'dart:async';
import 'dart:convert';

import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../storage/trusted_peers_storage.dart';
import 'connection_info.dart';
import 'meeting_point_service.dart';
import 'relay_client.dart';
import 'subscription_manager.dart';

/// Orchestrates peer reconnection using the relay and rendezvous system.
///
/// This service brings together:
/// - MeetingPointService: Derives meeting points from public keys/shared secrets
/// - RelayClient: Manages relay connections for introductions
/// - TrustedPeersStorage: Persists peer information
///
/// Flow:
/// 1. On startup, register at meeting points for all trusted peers
/// 2. When a peer is found (live or dead drop), attempt WebRTC connection
/// 3. If peer not found at meeting points, try through known relays
/// 4. After successful connection, save peer as trusted
class PeerReconnectionService with SubscriptionManager {
  final CryptoService _cryptoService;
  final TrustedPeersStorage _trustedPeers;
  final MeetingPointService _meetingPointService;
  final RelayClient _relayClient;

  Timer? _registrationTimer;

  // Event streams
  final _peerFoundController = StreamController<PeerFoundEvent>.broadcast();
  final _connectionRequestController =
      StreamController<ConnectionRequestEvent>.broadcast();
  final _statusController = StreamController<ReconnectionStatus>.broadcast();

  /// Emits when a peer is found via meeting point or dead drop.
  Stream<PeerFoundEvent> get onPeerFound => _peerFoundController.stream;

  /// Emits when we receive a connection request (introduction) from a peer.
  Stream<ConnectionRequestEvent> get onConnectionRequest =>
      _connectionRequestController.stream;

  /// Emits status updates about the reconnection service.
  Stream<ReconnectionStatus> get onStatus => _statusController.stream;

  PeerReconnectionService({
    required CryptoService cryptoService,
    required TrustedPeersStorage trustedPeers,
    required MeetingPointService meetingPointService,
    required RelayClient relayClient,
  })  : _cryptoService = cryptoService,
        _trustedPeers = trustedPeers,
        _meetingPointService = meetingPointService,
        _relayClient = relayClient {
    _setupRelayListeners();
  }

  void _setupRelayListeners() {
    // Listen for introductions from other peers through relays
    // Use track() to ensure the subscription is cancelled on dispose
    track(_relayClient.onIntroduction.listen((event) {
      _connectionRequestController.add(ConnectionRequestEvent(
        peerId: event.fromSourceId,
        relayId: event.relayId,
        encryptedPayload: event.payload,
        timestamp: DateTime.now(),
      ));
    }));
  }

  // Meeting point registration is handled by ConnectionManager.reconnectTrustedPeers()
  // which has direct access to the shared SignalingClient instance.

  Future<String?> _identifyPeerFromMeetingPoint(String meetingPoint) async {
    final myStableId = _cryptoService.stableId;
    final myPublicKey = await _cryptoService.getPublicKeyBytes();

    final peerIds = await _trustedPeers.getAllPeerIds();

    for (final peerId in peerIds) {
      // Primary: check stableId-based daily points
      final dailyPoints = _meetingPointService.deriveDailyPointsFromIds(
        myStableId,
        peerId,
      );
      if (dailyPoints.contains(meetingPoint)) {
        return peerId;
      }

      // Legacy: check pubkey-based daily points
      final theirPublicKey = await _trustedPeers.getPublicKeyBytes(peerId);
      if (theirPublicKey != null) {
        final legacyPoints = _meetingPointService.deriveDailyPoints(
          myPublicKey,
          theirPublicKey,
        );
        if (legacyPoints.contains(meetingPoint)) {
          return peerId;
        }
      }

      // Check hourly tokens (these use shared secret, not identity)
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

  Future<String?> _createDeadDrop(String peerId, ConnectionInfo info) async {
    try {
      final plaintext = info.toJsonString();
      final encrypted = await _cryptoService.encryptForPeer(peerId, plaintext);
      return encrypted;
    } catch (e) {
      logger.error(
          'PeerReconnection', 'Failed to create dead drop for $peerId', e);
      return null;
    }
  }

  Future<ConnectionInfo?> _decryptDeadDrop(
      String peerId, String encryptedData) async {
    try {
      final plaintext =
          await _cryptoService.decryptFromPeer(peerId, encryptedData);
      return ConnectionInfo.fromJsonString(plaintext);
    } catch (e) {
      logger.error(
          'PeerReconnection', 'Failed to decrypt dead drop from $peerId', e);
      return null;
    }
  }

  /// Attempt to connect to a peer using their connection info.
  Future<void> connectToPeer(
    String peerId,
    ConnectionInfo connectionInfo,
  ) async {
    // Encrypt our introduction payload
    final myPublicKey = await _cryptoService.getPublicKeyBase64();
    final introPayload = jsonEncode({
      'public_key': myPublicKey,
      'source_id': _relayClient.mySourceId,
    });

    final encryptedPayload =
        await _cryptoService.encryptForPeer(peerId, introPayload);

    // If they have a relay, connect through it
    if (connectionInfo.relayId != null) {
      try {
        // First ensure we're connected to their relay
        await _relayClient.ensureConnectedToRelay(connectionInfo.relayId!);

        // Send introduction through the relay
        await _relayClient.sendIntroduction(
          relayId: connectionInfo.relayId!,
          targetSourceId: connectionInfo.sourceId ?? peerId,
          encryptedPayload: encryptedPayload,
        );
        return;
      } catch (e) {
        logger.warning('PeerReconnection', 'Primary relay failed: $e');
      }
    }

    // Try fallback relays if primary fails
    for (final fallbackRelay in connectionInfo.fallbackRelays) {
      try {
        await _relayClient.ensureConnectedToRelay(fallbackRelay);
        await _relayClient.sendIntroduction(
          relayId: fallbackRelay,
          targetSourceId: connectionInfo.sourceId ?? peerId,
          encryptedPayload: encryptedPayload,
        );
        return; // Success, don't try more fallbacks
      } catch (e) {
        logger.warning(
            'PeerReconnection', 'Fallback relay $fallbackRelay failed: $e');
        continue;
      }
    }

    throw PeerConnectionException('Failed to connect through any relay');
  }

  /// Process a received dead drop and emit peer found event.
  Future<void> processDeadDrop(
      String meetingPoint, String encryptedData) async {
    final peerId = await _identifyPeerFromMeetingPoint(meetingPoint);
    if (peerId == null) return;

    try {
      final connectionInfo = await _decryptDeadDrop(peerId, encryptedData);
      if (connectionInfo != null) {
        _peerFoundController.add(PeerFoundEvent(
          peerId: peerId,
          meetingPoint: meetingPoint,
          isLive: false,
          connectionInfo: connectionInfo,
        ));
      }
    } catch (e) {
      logger.error('PeerReconnection', 'Failed to process dead drop', e);
    }
  }

  /// Process a live match and emit peer found event.
  Future<void> processLiveMatch(String meetingPoint) async {
    final peerId = await _identifyPeerFromMeetingPoint(meetingPoint);
    if (peerId != null) {
      _peerFoundController.add(PeerFoundEvent(
        peerId: peerId,
        meetingPoint: meetingPoint,
        isLive: true,
      ));
    }
  }

  /// Process a live match from rendezvous response (peerId already known).
  ///
  /// This is called when the server provides the peerId directly in the
  /// rendezvous result, rather than just the meeting point hash.
  void processLiveMatchFromRendezvous(String peerId, String? relayId) {
    logger.info(
      'PeerReconnection',
      'Live match from rendezvous: $peerId (relay: $relayId)',
    );

    _peerFoundController.add(PeerFoundEvent(
      peerId: peerId,
      meetingPoint: '', // Unknown - server matched by peerId
      isLive: true,
      connectionInfo: relayId != null
          ? ConnectionInfo(
              publicKey: '', // Will be fetched from trusted peers
              relayId: relayId,
              sourceId: null,
              fallbackRelays: [],
              timestamp: DateTime.now().toUtc(),
            )
          : null,
    ));
  }

  /// Process a dead drop from rendezvous response (peerId already known).
  ///
  /// This is called when the server provides the peerId along with the
  /// encrypted dead drop data in the rendezvous result.
  Future<void> processDeadDropFromRendezvous(
    String peerId,
    String encryptedData,
    String? relayId,
  ) async {
    logger.info(
      'PeerReconnection',
      'Dead drop from rendezvous: $peerId (relay: $relayId)',
    );

    try {
      final connectionInfo = await _decryptDeadDrop(peerId, encryptedData);
      if (connectionInfo != null) {
        _peerFoundController.add(PeerFoundEvent(
          peerId: peerId,
          meetingPoint: '', // Unknown - server matched by peerId
          isLive: false,
          connectionInfo: connectionInfo,
        ));
      }
    } catch (e) {
      logger.error(
        'PeerReconnection',
        'Failed to decrypt dead drop from $peerId',
        e,
      );
    }
  }

  /// Add a new trusted peer after successful connection.
  Future<void> addTrustedPeer(TrustedPeer peer) async {
    await _trustedPeers.savePeer(peer);
    // Meeting point re-registration is triggered via ConnectionManager
  }

  /// Remove a trusted peer.
  Future<void> removeTrustedPeer(String peerId) async {
    await _trustedPeers.removePeer(peerId);
  }

  /// Dispose resources.
  Future<void> dispose() async {
    _registrationTimer?.cancel();
    _registrationTimer = null;
    await cancelAllSubscriptions();
    await _peerFoundController.close();
    await _connectionRequestController.close();
    await _statusController.close();
  }
}

/// Event emitted when a peer is found.
class PeerFoundEvent {
  final String peerId;
  final String meetingPoint;
  final bool isLive;
  final ConnectionInfo? connectionInfo;

  PeerFoundEvent({
    required this.peerId,
    required this.meetingPoint,
    required this.isLive,
    this.connectionInfo,
  });

  @override
  String toString() {
    final mpPreview = meetingPoint.length > 10
        ? '${meetingPoint.substring(0, 10)}...'
        : meetingPoint;
    return 'PeerFoundEvent(peerId: $peerId, '
        'meetingPoint: $mpPreview, '
        'isLive: $isLive)';
  }
}

/// Event emitted when we receive a connection request.
class ConnectionRequestEvent {
  final String peerId;
  final String relayId;
  final String encryptedPayload;
  final DateTime timestamp;

  ConnectionRequestEvent({
    required this.peerId,
    required this.relayId,
    required this.encryptedPayload,
    required this.timestamp,
  });
}

/// Status update for the reconnection service.
class ReconnectionStatus {
  final bool isConnected;
  final String message;
  final bool error;

  ReconnectionStatus({
    required this.isConnected,
    required this.message,
    this.error = false,
  });

  @override
  String toString() => 'ReconnectionStatus(connected: $isConnected, $message)';
}

/// Exception thrown when peer connection fails.
class PeerConnectionException implements Exception {
  final String message;

  PeerConnectionException(this.message);

  @override
  String toString() => 'PeerConnectionException: $message';
}
