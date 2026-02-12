import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../config/environment.dart';
import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../models/models.dart';
import '../storage/message_storage.dart';
import '../storage/trusted_peers_storage.dart';
import 'device_link_service.dart';
import 'meeting_point_service.dart';
import 'signaling_client.dart';
import 'webrtc_service.dart';

/// Character set for pairing codes.
/// 32 characters (power of 2) chosen to avoid modulo bias with byte values (256 / 32 = 8 exactly).
/// Excludes ambiguous characters: 0, O, 1, I to improve readability.
const _pairingCodeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const _pairingCodeLength = 6;

/// Generates an unbiased random character from the given character set using rejection sampling.
///
/// This avoids modulo bias by rejecting random bytes that would cause uneven distribution.
/// For a character set of length N, we calculate the largest multiple of N that fits in 256
/// and reject any bytes >= that value.
///
/// Uses [Random.secure()] for cryptographically secure random number generation.
String _getUnbiasedRandomChar(String chars, Random secureRandom) {
  final charsetLength = chars.length;
  // Calculate the largest multiple of charsetLength that fits in 256 (byte range)
  final maxValid = (256 ~/ charsetLength) * charsetLength;

  int byte;
  do {
    byte = secureRandom.nextInt(256);
  } while (byte >= maxValid);

  return chars[byte % charsetLength];
}

/// Generates a random pairing code using unbiased random character selection.
///
/// Uses rejection sampling to ensure each character has exactly equal probability,
/// protecting against modulo bias even if the character set is changed in the future.
String _generateSecurePairingCode() {
  final secureRandom = Random.secure();
  final buffer = StringBuffer();

  for (var i = 0; i < _pairingCodeLength; i++) {
    buffer.write(_getUnbiasedRandomChar(_pairingCodeChars, secureRandom));
  }

  return buffer.toString();
}

/// Validates pairing code format.
///
/// A valid pairing code must:
/// - Be exactly [_pairingCodeLength] characters long (6 characters)
/// - Contain only characters from [_pairingCodeChars] (uppercase letters A-Z
///   excluding O and I, plus digits 2-9)
///
/// This ensures consistency with the pairing code generation algorithm.
bool _isValidPairingCode(String code) {
  if (code.length != _pairingCodeLength) return false;
  // Validate against the same character set used for generation
  final validChars = RegExp('^[$_pairingCodeChars]+\$');
  return validChars.hasMatch(code.toUpperCase());
}

/// Sealed class representing the signaling connection state.
///
/// Using a sealed class ensures exhaustive pattern matching and
/// eliminates the need for unsafe null assertions.
sealed class SignalingState {}

/// Signaling is disconnected - no client available.
class SignalingDisconnected extends SignalingState {}

/// Signaling is connected with an active client and pairing code.
class SignalingConnected extends SignalingState {
  final SignalingClient client;
  final String pairingCode;

  SignalingConnected({required this.client, required this.pairingCode});
}

/// Central manager for all peer connections.
///
/// Coordinates:
/// - External peer connections via VPS signaling server
/// - WebRTC connection establishment
/// - Cryptographic handshakes
/// - Message and file routing
/// - Linked device management (web clients proxied through mobile)
class ConnectionManager {
  final CryptoService _cryptoService;
  final WebRTCService _webrtcService;
  final DeviceLinkService _deviceLinkService;
  final TrustedPeersStorage _trustedPeersStorage;
  final MeetingPointService _meetingPointService;

  /// Current signaling state - uses sealed class for type-safe null handling.
  SignalingState _signalingState = SignalingDisconnected();

  final Map<String, Peer> _peers = {};
  final _peersController = StreamController<List<Peer>>.broadcast();
  final _messagesController =
      StreamController<(String peerId, String message)>.broadcast();

  final _fileChunksController = StreamController<
      (
        String peerId,
        String fileId,
        Uint8List chunk,
        int index,
        int total
      )>.broadcast();
  final _fileStartController = StreamController<
      (
        String peerId,
        String fileId,
        String fileName,
        int totalSize,
        int totalChunks
      )>.broadcast();
  final _fileCompleteController =
      StreamController<(String peerId, String fileId)>.broadcast();

  StreamSubscription? _signalingSubscription;

  /// Subscription to WebRTC signaling events (ICE candidates, etc.).
  /// Uses stream-based approach to avoid race conditions when multiple
  /// connections are attempted simultaneously. This replaces the previous
  /// callback-based approach (`onSignalingMessage`) that was vulnerable
  /// to being overwritten by each new connection.
  StreamSubscription? _signalingEventsSubscription;

  /// Subscription to rendezvous events (meeting point matches).
  StreamSubscription? _rendezvousSubscription;

  /// Secondary signaling clients for federated redirect servers.
  /// Key: server endpoint URL, Value: client and its subscriptions.
  final Map<String, _RedirectConnection> _redirectConnections = {};

  /// Callback to check if a public key is blocked.
  bool Function(String publicKey)? _isPublicKeyBlocked;

  /// Message storage for migrating messages when a trusted peer reconnects
  /// with a new pairing code.
  MessageStorage? _messageStorage;

  ConnectionManager({
    required CryptoService cryptoService,
    required WebRTCService webrtcService,
    required DeviceLinkService deviceLinkService,
    required TrustedPeersStorage trustedPeersStorage,
    required MeetingPointService meetingPointService,
    bool Function(String publicKey)? isPublicKeyBlocked,
  })  : _cryptoService = cryptoService,
        _webrtcService = webrtcService,
        _deviceLinkService = deviceLinkService,
        _trustedPeersStorage = trustedPeersStorage,
        _meetingPointService = meetingPointService,
        _isPublicKeyBlocked = isPublicKeyBlocked {
    _setupCallbacks();
  }

  /// Update the blocked check callback (for provider updates).
  void setBlockedCheck(bool Function(String publicKey) callback) {
    _isPublicKeyBlocked = callback;
  }

  /// Set the message storage for peer migration.
  void setMessageStorage(MessageStorage storage) {
    _messageStorage = storage;
  }

  /// Stream of all known peers.
  Stream<List<Peer>> get peers => _peersController.stream;

  /// Stream of incoming messages (peerId, plaintext).
  Stream<(String, String)> get messages => _messagesController.stream;

  /// Stream of incoming file chunks.
  Stream<(String, String, Uint8List, int, int)> get fileChunks =>
      _fileChunksController.stream;

  /// Stream of file transfer starts.
  Stream<(String, String, String, int, int)> get fileStarts =>
      _fileStartController.stream;

  /// Stream of file transfer completions.
  Stream<(String, String)> get fileCompletes => _fileCompleteController.stream;

  /// Current list of peers.
  List<Peer> get currentPeers => _peers.values.toList();

  /// Our external pairing code (for sharing).
  String? get externalPairingCode => switch (_signalingState) {
        SignalingConnected(pairingCode: final code) => code,
        SignalingDisconnected() => null,
      };

  /// The current signaling client, if connected.
  SignalingClient? get signalingClient => switch (_signalingState) {
        SignalingConnected(client: final c) => c,
        SignalingDisconnected() => null,
      };

  /// Initialize the connection manager.
  Future<void> initialize() async {
    await _cryptoService.initialize();
    await _loadTrustedPeersAsOffline();
  }

  /// Load all trusted peers into the peers map as offline/disconnected.
  Future<void> _loadTrustedPeersAsOffline() async {
    final trustedPeers = await _trustedPeersStorage.getAllPeers();
    for (final trusted in trustedPeers) {
      if (trusted.isBlocked) continue;
      // Don't overwrite if already present (e.g. already connected)
      if (_peers.containsKey(trusted.id)) continue;
      _peers[trusted.id] = Peer(
        id: trusted.id,
        displayName: trusted.alias ?? trusted.displayName,
        publicKey: trusted.publicKey,
        connectionState: PeerConnectionState.disconnected,
        lastSeen: trusted.lastSeen ?? trusted.trustedAt,
        isLocal: false,
      );
    }
    _notifyPeersChanged();
  }

  /// Stream of incoming pair requests for UI to show approval dialog.
  final _pairRequestController = StreamController<
      (String code, String publicKey, String? proposedName)>.broadcast();

  /// Stream of incoming pair requests.
  Stream<(String, String, String?)> get pairRequests =>
      _pairRequestController.stream;

  /// Stream of incoming link requests from web clients.
  final _linkRequestController = StreamController<
      (String linkCode, String publicKey, String deviceName)>.broadcast();

  /// Stream of incoming link requests.
  Stream<(String, String, String)> get linkRequests =>
      _linkRequestController.stream;

  /// Connect to the signaling server to enable peer connections.
  ///
  /// Opens a WebSocket connection to [serverUrl] and registers with the signaling
  /// server using a pairing code. If [pairingCode] is provided, attempts to reuse
  /// it; otherwise, generates a new random 6-character code.
  ///
  /// Returns the pairing code (newly generated or provided) that others can use
  /// to request pairing with this client via [connectToPeer].
  ///
  /// Can be called multiple times safely - existing connections are cleaned up first.
  /// Call [disconnect] when done to release resources.
  Future<String> connect({
    required String serverUrl,
    String? pairingCode,
  }) async {
    // Cancel existing subscriptions to prevent leaks if called multiple times
    await _signalingSubscription?.cancel();
    _signalingSubscription = null;
    await _signalingEventsSubscription?.cancel();
    _signalingEventsSubscription = null;
    await _rendezvousSubscription?.cancel();
    _rendezvousSubscription = null;

    // Use local variables to avoid null assertions - Pattern 5 from research
    final code = pairingCode ?? _generatePairingCode();

    final client = SignalingClient(
      serverUrl: serverUrl,
      pairingCode: code,
      publicKey: _cryptoService.publicKeyBase64,
    );

    // Update state with sealed class - guaranteed non-null access
    _signalingState = SignalingConnected(client: client, pairingCode: code);

    _signalingSubscription = client.messages.listen(_handleSignalingMessage);

    // Subscribe to WebRTC signaling events (ICE candidates, etc.) using
    // the stream-based approach. This eliminates the race condition that
    // occurred when the callback was overwritten by each new connection.
    // The stream subscription is set up once and handles all peers.
    _signalingEventsSubscription =
        _webrtcService.signalingEvents.listen((event) {
      // Check if we're still connected before sending
      final state = _signalingState;
      if (state is! SignalingConnected || !state.client.isConnected) return;

      if (event.message['type'] == 'ice_candidate') {
        state.client.sendIceCandidate(event.peerId, event.message);
      }
    });

    // Subscribe to rendezvous events for trusted peer reconnection
    _rendezvousSubscription =
        client.rendezvousEvents.listen(_handleRendezvousEvent);

    await client.connect();

    return code;
  }

  /// Disconnect from the signaling server.
  Future<void> disconnect() async {
    // Close redirect connections first
    await _closeRedirectConnections();

    // Cancel signaling events subscription first to prevent stale callbacks
    await _rendezvousSubscription?.cancel();
    _rendezvousSubscription = null;
    await _signalingEventsSubscription?.cancel();
    _signalingEventsSubscription = null;
    await _signalingSubscription?.cancel();
    _signalingSubscription = null;

    // Safely access client through pattern matching
    // Use dispose() instead of disconnect() to properly close StreamControllers
    final state = _signalingState;
    if (state is SignalingConnected) {
      await state.client.dispose();
    }
    _signalingState = SignalingDisconnected();
  }

  /// Request to connect to a peer using their pairing code.
  /// This sends a pair request that the peer must approve.
  Future<void> connectToPeer(String pairingCode, {String? proposedName}) async {
    logger.info(
        'ConnectionManager', 'connectToPeer called with code: $pairingCode');

    // Normalize and validate pairing code format
    final normalizedCode = pairingCode.toUpperCase().trim();
    if (!_isValidPairingCode(normalizedCode)) {
      logger.error(
          'ConnectionManager', 'Invalid pairing code format: $normalizedCode');
      throw ConnectionException('Invalid pairing code format');
    }

    // Pattern 2: Guard with early return using local variable capture
    final state = _signalingState;
    logger.debug('ConnectionManager',
        'Signaling state: ${state.runtimeType}, isConnected: ${state is SignalingConnected ? state.client.isConnected : "N/A"}');
    if (state is! SignalingConnected || !state.client.isConnected) {
      logger.error('ConnectionManager',
          'Not connected to signaling server - cannot pair');
      throw ConnectionException('Not connected to signaling server');
    }

    // Create a placeholder peer (waiting for approval)
    final peer = Peer(
      id: normalizedCode,
      displayName: 'Peer $normalizedCode',
      connectionState: PeerConnectionState.connecting,
      lastSeen: DateTime.now(),
      isLocal: false,
    );
    _peers[normalizedCode] = peer;
    _notifyPeersChanged();

    // Request pairing (peer must approve before WebRTC starts)
    // Using captured state.client - guaranteed non-null by pattern match
    logger.info(
        'ConnectionManager', 'Sending pair_request for code: $normalizedCode');
    state.client.requestPairing(normalizedCode, proposedName: proposedName);
  }

  /// Respond to an incoming pair request.
  void respondToPairRequest(String peerCode, {required bool accept}) {
    // Safe access using pattern matching
    final state = _signalingState;
    if (state is SignalingConnected) {
      state.client.respondToPairing(peerCode, accept: accept);
    }

    if (!accept) {
      // Remove peer from list if rejected
      _peers.remove(peerCode);
      _notifyPeersChanged();
    }
  }

  /// Respond to an incoming link request from a web client.
  void respondToLinkRequest(String linkCode,
      {required bool accept, String? deviceId}) {
    // Safe access using pattern matching
    final state = _signalingState;
    if (state is SignalingConnected) {
      state.client
          .respondToLinkRequest(linkCode, accept: accept, deviceId: deviceId);
    }

    if (!accept) {
      _deviceLinkService.cancelLinkSession();
    }
  }

  /// Start WebRTC connection after pairing is matched.
  Future<void> _startWebRTCConnection(
      String peerCode, String peerPublicKey, bool isInitiator) async {
    // Pattern 1: Capture signaling client before async operations (HIGH risk fix)
    final state = _signalingState;
    if (state is! SignalingConnected || !state.client.isConnected) {
      _updatePeerState(peerCode, PeerConnectionState.failed);
      return;
    }
    final client = state.client;

    // Store peer's public key for handshake verification
    _cryptoService.setPeerPublicKey(peerCode, peerPublicKey);

    // No need to configure signaling callback here anymore!
    // The stream-based approach in enableExternalConnections() handles all
    // signaling events for all peers, eliminating the race condition.

    if (isInitiator) {
      // We're the initiator - create and send offer
      try {
        final offer = await _webrtcService.createOffer(peerCode);

        // Re-verify client is still connected after async operation
        // This prevents crash if disableExternalConnections() was called during await
        if (client.isConnected) {
          client.sendOffer(peerCode, offer);
        } else {
          _updatePeerState(peerCode, PeerConnectionState.failed);
        }
      } catch (e) {
        _updatePeerState(peerCode, PeerConnectionState.failed);
        rethrow;
      }
    }
    // If not initiator, wait for offer from the other peer
  }

  /// Start WebRTC connection for device linking (web client → mobile).
  Future<void> _startLinkConnection(
      String linkCode, String webPublicKey, bool isInitiator) async {
    // Capture signaling client before async operations
    final state = _signalingState;
    if (state is! SignalingConnected || !state.client.isConnected) {
      _deviceLinkService.cancelLinkSession();
      return;
    }
    final client = state.client;

    // Use link code as the "peer" ID for WebRTC
    final webClientId = 'link_$linkCode';

    // Store web client's public key for handshake
    _cryptoService.setPeerPublicKey(webClientId, webPublicKey);

    if (isInitiator) {
      // We're the initiator - create and send offer
      try {
        final offer = await _webrtcService.createOffer(webClientId);

        if (client.isConnected) {
          client.sendOffer(linkCode, offer);
        } else {
          _deviceLinkService.cancelLinkSession();
        }
      } catch (e) {
        _deviceLinkService.cancelLinkSession();
        rethrow;
      }
    }
    // If not initiator, wait for offer from web client
  }

  /// Send a message to a peer.
  Future<void> sendMessage(String peerId, String plaintext) async {
    await _webrtcService.sendMessage(peerId, plaintext);
  }

  /// Send a file to a peer.
  Future<void> sendFile(
    String peerId,
    String fileName,
    Uint8List data,
  ) async {
    final fileId = const Uuid().v4();
    await _webrtcService.sendFile(peerId, fileId, fileName, data);
  }

  /// Disconnect from a peer.
  Future<void> disconnectPeer(String peerId) async {
    await _webrtcService.closeConnection(peerId);
    _updatePeerState(peerId, PeerConnectionState.disconnected);
  }

  /// Cancel an ongoing connection attempt.
  Future<void> cancelConnection(String peerId) async {
    await _webrtcService.closeConnection(peerId);
    _updatePeerState(peerId, PeerConnectionState.disconnected);
  }

  /// Dispose resources.
  Future<void> dispose() async {
    // Close redirect connections
    await _closeRedirectConnections();

    // Cancel signaling events subscription
    await _rendezvousSubscription?.cancel();
    _rendezvousSubscription = null;
    await _signalingEventsSubscription?.cancel();
    _signalingEventsSubscription = null;
    await _signalingSubscription?.cancel();
    _signalingSubscription = null;

    await _webrtcService.dispose();

    // Safe disposal using pattern matching
    final state = _signalingState;
    if (state is SignalingConnected) {
      await state.client.dispose();
    }
    _signalingState = SignalingDisconnected();

    await _peersController.close();
    await _messagesController.close();
    await _fileChunksController.close();
    await _fileStartController.close();
    await _fileCompleteController.close();
    await _pairRequestController.close();
    await _linkRequestController.close();
  }

  // Private methods

  void _setupCallbacks() {
    _webrtcService.onMessage = (peerId, message) {
      // Check if this is a message from a linked device (needs to be proxied to a peer)
      if (peerId.startsWith('link_')) {
        _handleLinkedDeviceMessage(peerId, message);
        return;
      }

      // Emit to UI — persistence is handled by the global listener in main.dart
      _messagesController.add((peerId, message));

      // Also forward to all connected linked devices
      _deviceLinkService.broadcastToLinkedDevices(
        fromPeerId: peerId,
        plaintext: message,
      );
    };

    _webrtcService.onFileChunk = (peerId, fileId, chunk, index, total) {
      _fileChunksController.add((peerId, fileId, chunk, index, total));
    };

    _webrtcService.onFileStart =
        (peerId, fileId, fileName, totalSize, totalChunks) {
      _fileStartController
          .add((peerId, fileId, fileName, totalSize, totalChunks));
    };

    _webrtcService.onFileComplete = (peerId, fileId) {
      _fileCompleteController.add((peerId, fileId));
    };

    _webrtcService.onConnectionStateChange = (peerId, state) {
      // Check if this is a linked device connection state change
      if (peerId.startsWith('link_')) {
        if (state == PeerConnectionState.connected) {
          _deviceLinkService.handleDeviceConnected(peerId);
        } else if (state == PeerConnectionState.disconnected ||
            state == PeerConnectionState.failed) {
          _deviceLinkService.handleDeviceDisconnected(peerId);
        }
        return;
      }

      _updatePeerState(peerId, state);

      // Persist peer as trusted after successful connection (handshake complete)
      if (state == PeerConnectionState.connected) {
        final peer = _peers[peerId];
        if (peer != null && peer.publicKey != null) {
          _trustedPeersStorage.savePeer(TrustedPeer.fromPeer(peer)).then((_) {
            logger.info('ConnectionManager', 'Saved trusted peer: $peerId');
          }).catchError((e) {
            logger.error(
                'ConnectionManager', 'Failed to save trusted peer: $peerId', e);
          });
        }
      }

      // Notify linked devices of peer connection state changes
      for (final device in _deviceLinkService.currentLinkedDevices) {
        if (device.state == LinkedDeviceState.connected) {
          // Send state update to linked device
          _deviceLinkService.proxyMessageToDevice(
            toDeviceId: device.id,
            fromPeerId: peerId,
            plaintext:
                '{"type":"peer_state","peerId":"$peerId","state":"${state.name}"}',
          );
        }
      }
    };
  }

  /// Handle a message from a linked device (proxied to a peer).
  void _handleLinkedDeviceMessage(String deviceId, String message) {
    try {
      // Message format: {"type":"send","to":"peerId","data":"..."}
      final parsed = _parseLinkedDeviceMessage(message);
      if (parsed == null) return;

      final type = parsed['type'] as String?;
      if (type == 'send') {
        final toPeerId = parsed['to'] as String?;
        final data = parsed['data'] as String?;
        if (toPeerId != null && data != null) {
          // Proxy message to the peer
          _deviceLinkService.proxyMessageToPeer(
            fromDeviceId: deviceId,
            toPeerId: toPeerId,
            encryptedTunnelData: data,
          );
        }
      }
    } catch (e) {
      // Invalid message format - ignore
    }
  }

  /// Parse a JSON message from a linked device.
  Map<String, dynamic>? _parseLinkedDeviceMessage(String message) {
    try {
      return Map<String, dynamic>.from(
        const JsonDecoder().convert(message) as Map,
      );
    } catch (e) {
      return null;
    }
  }

  /// Migrate a trusted peer's identity when they reconnect with a new pairing code.
  ///
  /// When a previously-trusted peer restarts their app, they get a new ephemeral
  /// pairing code but the same public key. This method detects that situation and:
  /// 1. Migrates message history from the old ID to the new one
  /// 2. Carries over the display name and alias
  /// 3. Removes the old duplicate entry from the peers map
  /// 4. Updates trusted peer storage with the new ID
  Future<void> _migrateTrustedPeerIfNeeded(
      String newPeerCode, String peerPublicKey) async {
    try {
      final trustedPeer =
          await _trustedPeersStorage.getPeerByPublicKey(peerPublicKey);
      if (trustedPeer == null || trustedPeer.id == newPeerCode) return;

      final oldId = trustedPeer.id;
      logger.info('ConnectionManager',
          'Migrating trusted peer: $oldId → $newPeerCode (same pubkey)');

      // Migrate message history to the new peer ID
      if (_messageStorage != null) {
        final migrated =
            await _messageStorage!.migrateMessages(oldId, newPeerCode);
        logger.debug('ConnectionManager',
            'Migrated $migrated messages from $oldId to $newPeerCode');
      }

      // Carry over display name and alias to the new peer entry
      final oldPeer = _peers[oldId];
      if (oldPeer != null) {
        _peers[newPeerCode] = Peer(
          id: newPeerCode,
          displayName: oldPeer.displayName,
          publicKey: peerPublicKey,
          connectionState: PeerConnectionState.connecting,
          lastSeen: DateTime.now(),
          isLocal: false,
        );
      }

      // Remove old entry from peers map
      _peers.remove(oldId);

      // Update trusted peers storage: remove old, save new
      await _trustedPeersStorage.removePeer(oldId);
      await _trustedPeersStorage.savePeer(TrustedPeer(
        id: newPeerCode,
        displayName: trustedPeer.alias ?? trustedPeer.displayName,
        publicKey: peerPublicKey,
        trustedAt: trustedPeer.trustedAt,
        lastSeen: DateTime.now(),
        alias: trustedPeer.alias,
      ));

      _notifyPeersChanged();
    } catch (e) {
      logger.error(
          'ConnectionManager', 'Failed to migrate trusted peer', e);
    }
  }

  void _handleSignalingMessage(SignalingMessage message) async {
    logger.debug('ConnectionManager',
        'Received signaling message: ${message.runtimeType}');
    try {
      switch (message) {
        case SignalingPairIncoming(
            fromCode: final fromCode,
            fromPublicKey: final fromPublicKey,
            proposedName: final proposedName
          ):
          logger.info('ConnectionManager', 'Pair request from $fromCode');
          // Check if this public key is blocked
          if (_isPublicKeyBlocked != null &&
              _isPublicKeyBlocked!(fromPublicKey)) {
            // Auto-reject blocked users silently
            final state = _signalingState;
            if (state is SignalingConnected) {
              state.client.respondToPairing(fromCode, accept: false);
            }
            break;
          }
          // Auto-accept reconnection from trusted (previously paired) peers
          final isTrusted =
              await _trustedPeersStorage.isTrustedByPublicKey(fromPublicKey);
          if (isTrusted) {
            logger.info(
                'ConnectionManager', 'Auto-accepting trusted peer $fromCode');
            respondToPairRequest(fromCode, accept: true);
            break;
          }
          // In E2E test mode, auto-accept all pair requests
          if (Environment.isE2eTest) {
            logger.info('ConnectionManager',
                'E2E mode: auto-accepting pair request from $fromCode');
            respondToPairRequest(fromCode, accept: true);
            break;
          }
          // Someone wants to pair with us - emit event for UI to show approval dialog
          _pairRequestController.add((fromCode, fromPublicKey, proposedName));
          break;

        case SignalingPairMatched(
            peerCode: final peerCode,
            peerPublicKey: final peerPublicKey,
            isInitiator: final isInitiator
          ):
          // Pairing approved by both sides - start WebRTC connection
          // Check if this public key belongs to an existing trusted peer
          // with a different ID (peer reconnected with new pairing code)
          await _migrateTrustedPeerIfNeeded(peerCode, peerPublicKey);

          // Update or create peer with public key for blocking support
          _peers[peerCode] = Peer(
            id: peerCode,
            displayName: _peers[peerCode]?.displayName ?? 'Peer $peerCode',
            publicKey: peerPublicKey,
            connectionState: PeerConnectionState.connecting,
            lastSeen: DateTime.now(),
            isLocal: false,
          );
          _notifyPeersChanged();
          await _startWebRTCConnection(peerCode, peerPublicKey, isInitiator);
          break;

        case SignalingPairRejected(peerCode: final peerCode):
          // Peer rejected our pairing request
          _updatePeerState(peerCode, PeerConnectionState.failed);
          _peers.remove(peerCode);
          _notifyPeersChanged();
          break;

        case SignalingPairTimeout(peerCode: final peerCode):
          // Pairing request timed out
          _updatePeerState(peerCode, PeerConnectionState.failed);
          _peers.remove(peerCode);
          _notifyPeersChanged();
          break;

        case SignalingPairError(error: final error):
          // Pairing error - log and update UI
          logger.error('ConnectionManager', 'Pair error received: $error');
          // Find any peers in connecting state and mark them as failed
          for (final entry in _peers.entries.toList()) {
            if (entry.value.connectionState == PeerConnectionState.connecting) {
              logger.warning('ConnectionManager',
                  'Marking peer ${entry.key} as failed due to pair_error');
              _peers.remove(entry.key);
            }
          }
          _notifyPeersChanged();
          break;

        case SignalingOffer(from: final from, payload: final payload):
          // Pattern 6: Capture client reference before async operation (HIGH risk fix)
          final signalingState = _signalingState;
          if (signalingState is! SignalingConnected) {
            // Connection was closed, cannot process offer
            return;
          }
          final client = signalingState.client;

          // Offer from matched peer (we're the non-initiator)
          // Get public key from crypto service (stored during pairing)
          final peerPublicKey = _cryptoService.getPeerPublicKey(from);
          if (!_peers.containsKey(from) || _peers[from]?.publicKey == null) {
            _peers[from] = Peer(
              id: from,
              displayName: _peers[from]?.displayName ?? 'Peer $from',
              publicKey: peerPublicKey,
              connectionState: PeerConnectionState.connecting,
              lastSeen: DateTime.now(),
              isLocal: false,
            );
            _notifyPeersChanged();
          }

          // No need to configure signaling callback here anymore!
          // The stream-based approach handles all signaling events.

          // Handle offer and create answer
          final answer = await _webrtcService.handleOffer(from, payload);

          // Check if client is still valid and connected after async operation
          // This prevents crash if disableExternalConnections() was called during await
          if (client.isConnected) {
            client.sendAnswer(from, answer);
          }
          break;

        case SignalingAnswer(from: final from, payload: final payload):
          await _webrtcService.handleAnswer(from, payload);
          break;

        case SignalingIceCandidate(from: final from, payload: final payload):
          await _webrtcService.addIceCandidate(from, payload);
          break;

        case SignalingPeerJoined(peerId: final _):
          // Peer is online, we could auto-connect or notify user
          break;

        case SignalingPeerLeft(peerId: final peerId):
          _updatePeerState(peerId, PeerConnectionState.disconnected);
          break;

        case SignalingError(message: final _):
          // Handle error - could show notification to user
          break;

        // Device linking messages (web client → mobile app)
        case SignalingLinkRequest(
            linkCode: final linkCode,
            publicKey: final publicKey,
            deviceName: final deviceName
          ):
          // Web client wants to link with us - emit event for UI to show approval
          _linkRequestController.add((linkCode, publicKey, deviceName));
          break;

        case SignalingLinkMatched(
            linkCode: final linkCode,
            peerPublicKey: final peerPublicKey,
            isInitiator: final isInitiator
          ):
          // Link approved - establish WebRTC tunnel with web client
          await _startLinkConnection(linkCode, peerPublicKey, isInitiator);
          break;

        case SignalingLinkRejected():
          // Web client's link request was rejected
          _deviceLinkService.cancelLinkSession();
          break;

        case SignalingLinkTimeout():
          // Link request timed out
          _deviceLinkService.cancelLinkSession();
          break;
      }
    } catch (e, stackTrace) {
      // Log error to prevent silent failures in async void handler
      // This ensures exceptions from WebRTC operations are captured and visible
      logger.error('ConnectionManager', 'Failed to handle signaling message', e,
          stackTrace);
      // TODO: Consider emitting error to a dedicated error stream for UI notification
    }
  }

  void _updatePeerState(String peerId, PeerConnectionState state) {
    // Pattern 4: Map value extraction - safer than containsKey + !
    final peer = _peers[peerId];
    if (peer != null) {
      _peers[peerId] = peer.copyWith(
        connectionState: state,
        lastSeen: DateTime.now(),
      );
      _notifyPeersChanged();

      // Perform handshake when connected
      if (state == PeerConnectionState.handshaking) {
        _webrtcService.performHandshake(peerId);
      }
    }
  }

  void _notifyPeersChanged() {
    _peersController.add(_peers.values.toList());
  }

  String _generatePairingCode() {
    return _generateSecurePairingCode();
  }

  // ==========================================================================
  // Trusted Peer Reconnection via Meeting Points
  // ==========================================================================

  /// Register meeting points for all trusted peers on the signaling server.
  ///
  /// After connecting to signaling, this derives daily meeting points from
  /// our public key + each trusted peer's public key, then registers them.
  /// If the other peer is also online and registered the same points, the
  /// server will return a live match with their pairing code, enabling
  /// automatic reconnection via the standard pairing flow.
  Future<void> reconnectTrustedPeers() async {
    final state = _signalingState;
    if (state is! SignalingConnected || !state.client.isConnected) return;

    final myPublicKey = await _cryptoService.getPublicKeyBytes();
    final allDailyPoints = <String>{};
    final allHourlyTokens = <String>{};

    logger.debug(
        'ConnectionManager', 'My public key: ${base64Encode(myPublicKey)}');

    final peers = await _trustedPeersStorage.getAllPeers();
    for (final peer in peers) {
      if (peer.isBlocked) continue;
      final theirPublicKey =
          await _trustedPeersStorage.getPublicKeyBytes(peer.id);
      if (theirPublicKey == null) continue;

      logger.debug(
          'ConnectionManager',
          'Trusted peer ${peer.id}: storedPubKey=${peer.publicKey}, '
              'decodedBytes=${base64Encode(theirPublicKey)}');

      // Daily points from public keys (for dead drops / async discovery)
      final dailyPoints = _meetingPointService.deriveDailyPoints(
        myPublicKey,
        theirPublicKey,
      );
      logger.debug('ConnectionManager',
          'Daily points for peer ${peer.id}: $dailyPoints');
      allDailyPoints.addAll(dailyPoints);

      // Hourly tokens from session keys (for live matching with push notification)
      final sessionKeyBytes = await _cryptoService.getSessionKeyBytes(peer.id);
      if (sessionKeyBytes != null) {
        final hourlyTokens =
            _meetingPointService.deriveHourlyTokens(sessionKeyBytes);
        allHourlyTokens.addAll(hourlyTokens);
      }
    }

    if (allDailyPoints.isEmpty && allHourlyTokens.isEmpty) {
      logger.debug('ConnectionManager', 'No trusted peers to reconnect with');
      return;
    }

    // Also register daily points as hourly tokens for live matching.
    // The server only sends push notifications for hourly token matches,
    // so we need daily points in both arrays to enable real-time discovery.
    final combinedHourlyTokens = <String>{
      ...allHourlyTokens,
      ...allDailyPoints
    };

    logger.info(
        'ConnectionManager',
        'Registering ${allDailyPoints.length} daily points + '
            '${combinedHourlyTokens.length} hourly tokens '
            '(${allHourlyTokens.length} from sessions) for ${peers.length} trusted peers');

    final rendezvousMsg = {
      'type': 'register_rendezvous',
      'peerId': state.pairingCode,
      'daily_points': allDailyPoints.toList(),
      'hourly_tokens': combinedHourlyTokens.toList(),
      'dead_drops': <String, String>{},
    };

    await state.client.send(rendezvousMsg);

    // Re-register after a delay to handle the race condition where both
    // peers restart simultaneously and neither finds the other's tokens
    // on the first registration (server deletes tokens on disconnect).
    Future.delayed(const Duration(seconds: 5), () {
      final currentState = _signalingState;
      if (currentState is SignalingConnected &&
          currentState.client.isConnected) {
        logger.debug(
            'ConnectionManager', 'Re-registering rendezvous after delay');
        currentState.client.send(rendezvousMsg);
      }
    });
  }

  /// Handle a rendezvous event (meeting point match from the server).
  void _handleRendezvousEvent(RendezvousEvent event) {
    logger.info(
        'ConnectionManager', 'Rendezvous event received: ${event.runtimeType}');
    switch (event) {
      case RendezvousResult(:final liveMatches, deadDrops: _):
        logger.info('ConnectionManager',
            'Rendezvous result: ${liveMatches.length} live matches');
        for (final match in liveMatches) {
          _handleLiveMatch(match.peerId);
        }
      case RendezvousPartial(
          :final liveMatches,
          deadDrops: _,
          :final redirects
        ):
        logger.info(
            'ConnectionManager',
            'Rendezvous partial: ${liveMatches.length} live matches, '
                '${redirects.length} redirects');
        for (final match in liveMatches) {
          _handleLiveMatch(match.peerId);
        }
        // Follow redirects: register tokens on the responsible servers
        if (redirects.isNotEmpty) {
          _handleRendezvousRedirects(redirects);
        }
      case RendezvousMatch(:final peerId, relayId: _, meetingPoint: _):
        logger.info('ConnectionManager', 'Rendezvous match: peerId=$peerId');
        _handleLiveMatch(peerId);
    }
  }

  /// Follow rendezvous redirects by connecting to other federated servers
  /// and registering the tokens that belong to them.
  Future<void> _handleRendezvousRedirects(
      List<RendezvousRedirect> redirects) async {
    final state = _signalingState;
    if (state is! SignalingConnected) return;

    for (final redirect in redirects) {
      if (redirect.endpoint.isEmpty) continue;
      if (redirect.dailyPoints.isEmpty && redirect.hourlyTokens.isEmpty) {
        continue;
      }

      logger.info(
          'ConnectionManager',
          'Following redirect to ${redirect.endpoint}: '
              '${redirect.dailyPoints.length} daily, '
              '${redirect.hourlyTokens.length} hourly tokens');

      try {
        await _connectToRedirectServer(
          endpoint: redirect.endpoint,
          pairingCode: state.pairingCode,
          publicKey: _cryptoService.publicKeyBase64,
          dailyPoints: redirect.dailyPoints,
          hourlyTokens: redirect.hourlyTokens,
        );
      } catch (e) {
        logger.error('ConnectionManager',
            'Failed to follow redirect to ${redirect.endpoint}', e);
      }
    }
  }

  /// Connect to a federated redirect server, register, and send tokens.
  Future<void> _connectToRedirectServer({
    required String endpoint,
    required String pairingCode,
    required String publicKey,
    required List<String> dailyPoints,
    required List<String> hourlyTokens,
  }) async {
    // Close existing connection to this endpoint if any
    final existing = _redirectConnections[endpoint];
    if (existing != null) {
      await existing.dispose();
      _redirectConnections.remove(endpoint);
    }

    // Create a new signaling client for this server
    final client = SignalingClient(
      serverUrl: endpoint,
      pairingCode: pairingCode,
      publicKey: publicKey,
    );

    // Listen for rendezvous events from this redirect server
    final sub = client.rendezvousEvents.listen((event) {
      logger.info(
          'ConnectionManager',
          'Redirect server rendezvous event: ${event.runtimeType} '
              'from $endpoint');
      // Process matches from the redirect server the same way
      switch (event) {
        case RendezvousResult(:final liveMatches, deadDrops: _):
          for (final match in liveMatches) {
            _handleLiveMatch(match.peerId);
          }
        case RendezvousPartial(:final liveMatches, deadDrops: _, redirects: _):
          for (final match in liveMatches) {
            _handleLiveMatch(match.peerId);
          }
        case RendezvousMatch(:final peerId, relayId: _, meetingPoint: _):
          _handleLiveMatch(peerId);
      }
    });

    _redirectConnections[endpoint] =
        _RedirectConnection(client: client, rendezvousSub: sub);

    try {
      await client.connect();

      // Register the redirected tokens on this server
      final rendezvousMsg = {
        'type': 'register_rendezvous',
        'peerId': pairingCode,
        'daily_points': dailyPoints,
        'hourly_tokens': hourlyTokens,
        'dead_drops': <String, String>{},
      };

      await client.send(rendezvousMsg);
      logger.info(
          'ConnectionManager',
          'Registered ${dailyPoints.length + hourlyTokens.length} tokens '
              'on redirect server $endpoint');
    } catch (e) {
      // Clean up on failure
      await _redirectConnections[endpoint]?.dispose();
      _redirectConnections.remove(endpoint);
      rethrow;
    }
  }

  /// Close all redirect connections.
  Future<void> _closeRedirectConnections() async {
    for (final conn in _redirectConnections.values) {
      await conn.dispose();
    }
    _redirectConnections.clear();
  }

  /// Handle a live match: initiate pairing with the matched peer.
  ///
  /// Uses deterministic initiator selection (lexicographic comparison of
  /// pairing codes) to prevent both sides from simultaneously initiating,
  /// which would create duplicate WebRTC connections.
  void _handleLiveMatch(String matchedPeerId) {
    if (matchedPeerId.isEmpty) return;

    // Skip if already connected or connecting to this peer (by pairing code)
    final existingPeer = _peers[matchedPeerId];
    if (existingPeer != null &&
        (existingPeer.connectionState == PeerConnectionState.connected ||
            existingPeer.connectionState == PeerConnectionState.connecting ||
            existingPeer.connectionState == PeerConnectionState.handshaking)) {
      return;
    }

    final state = _signalingState;
    if (state is! SignalingConnected) return;

    // Deterministic initiator: only the peer with the smaller code initiates
    if (state.pairingCode.compareTo(matchedPeerId) > 0) {
      logger.debug('ConnectionManager',
          'Live match with $matchedPeerId - waiting for them to initiate');
      return;
    }

    logger.info('ConnectionManager',
        'Live match with $matchedPeerId - initiating reconnection');
    connectToPeer(matchedPeerId);
  }
}

/// Holds a secondary signaling connection to a federated redirect server.
class _RedirectConnection {
  final SignalingClient client;
  final StreamSubscription rendezvousSub;

  _RedirectConnection({required this.client, required this.rendezvousSub});

  Future<void> dispose() async {
    await rendezvousSub.cancel();
    await client.dispose();
  }
}

class ConnectionException implements Exception {
  final String message;
  ConnectionException(this.message);

  @override
  String toString() => 'ConnectionException: $message';
}
