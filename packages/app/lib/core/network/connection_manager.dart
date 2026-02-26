import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../config/environment.dart';
import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../models/models.dart';
import '../storage/trusted_peers_storage.dart';
import '../storage/message_storage.dart';
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
  final MessageStorage? _messageStorage;

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

  /// Maps a peer's pairing code to the SignalingClient that received
  /// the pairing event. Used for cross-server pairing: when a pair_incoming
  /// arrives from a redirect server, responses must go through THAT client.
  final Map<String, SignalingClient> _peerToClient = {};

  /// Callback to check if a public key is blocked.
  bool Function(String publicKey)? _isPublicKeyBlocked;

  /// Maps signaling codes to stable peer IDs for trusted peer reconnections.
  /// When a trusted peer reconnects with a new pairing code, the WebRTC layer
  /// uses the new code, but the rest of the app uses the original stable ID
  /// so that messages and conversations are preserved.
  final Map<String, String> _codeToStableId = {};
  final Map<String, String> _stableIdToCode = {};

  /// Resolve a WebRTC/signaling code to the stable peer ID used by the app.
  String _toStableId(String code) => _codeToStableId[code] ?? code;

  /// Resolve a stable peer ID to the current signaling code for WebRTC.
  String _toCode(String stableId) => _stableIdToCode[stableId] ?? stableId;

  /// Our username for handshake exchange.
  final String _username;

  ConnectionManager({
    required CryptoService cryptoService,
    required WebRTCService webrtcService,
    required DeviceLinkService deviceLinkService,
    required TrustedPeersStorage trustedPeersStorage,
    required MeetingPointService meetingPointService,
    MessageStorage? messageStorage,
    bool Function(String publicKey)? isPublicKeyBlocked,
    String username = 'Anonymous',
  })  : _cryptoService = cryptoService,
        _webrtcService = webrtcService,
        _deviceLinkService = deviceLinkService,
        _trustedPeersStorage = trustedPeersStorage,
        _meetingPointService = meetingPointService,
        _messageStorage = messageStorage,
        _isPublicKeyBlocked = isPublicKeyBlocked,
        _username = username {
    _setupCallbacks();
  }

  /// Update the blocked check callback (for provider updates).
  void setBlockedCheck(bool Function(String publicKey) callback) {
    _isPublicKeyBlocked = callback;
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

  /// Connect to additional discovered servers for cross-server rendezvous.
  ///
  /// When replicationFactor >= server count, the DHT considers all tokens
  /// local, so no rendezvous_partial redirects are generated. This method
  /// proactively connects to all other servers so that rendezvous tokens
  /// are registered everywhere, enabling cross-server peer discovery.
  Future<void> connectToAdditionalServers(List<String> serverUrls) async {
    final state = _signalingState;
    if (state is! SignalingConnected) return;

    final primaryUrl = state.client.serverUrl;

    for (final url in serverUrls) {
      // Skip the primary server (already connected)
      if (url == primaryUrl) continue;

      // Skip servers already in redirect connections
      if (_redirectConnections.containsKey(url)) continue;

      try {
        await _connectToRedirectServerForPairing(
          endpoint: url,
          pairingCode: state.pairingCode,
          publicKey: _cryptoService.publicKeyBase64,
        );
        logger.info(
            'ConnectionManager', 'Connected to additional server: $url');
      } catch (e) {
        logger.warning('ConnectionManager',
            'Failed to connect to additional server $url: $e');
      }
    }
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
        username: trusted.username,
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

  /// Stream of key rotation events (peerId, oldKey, newKey).
  final _keyChangeController = StreamController<
      (String peerId, String oldKey, String newKey)>.broadcast();

  /// Stream of key rotation events for UI warnings.
  Stream<(String, String, String)> get keyChanges =>
      _keyChangeController.stream;

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
      if (event.message['type'] == 'ice_candidate') {
        // Route ICE candidate through the correct client (redirect or main)
        final redirectClient = _peerToClient[event.peerId];
        if (redirectClient != null && redirectClient.isConnected) {
          redirectClient.sendIceCandidate(event.peerId, event.message);
        } else {
          final state = _signalingState;
          if (state is! SignalingConnected || !state.client.isConnected) return;
          state.client.sendIceCandidate(event.peerId, event.message);
        }
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

    // Clear peer ID mappings — new session will have new pairing codes
    _codeToStableId.clear();
    _stableIdToCode.clear();
    _peerToClient.clear();
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
    state.client.requestPairing(normalizedCode,
        proposedName: proposedName ?? _username);
  }

  /// Respond to an incoming pair request.
  /// Uses the client that received the pair_incoming event (may be a redirect
  /// server client for cross-server pairing).
  void respondToPairRequest(String peerCode, {required bool accept}) {
    // Check if this peer's pairing event came from a redirect client
    final redirectClient = _peerToClient[peerCode];
    if (redirectClient != null && redirectClient.isConnected) {
      redirectClient.respondToPairing(peerCode, accept: accept);
    } else {
      // Default: respond through main signaling client
      final state = _signalingState;
      if (state is SignalingConnected) {
        state.client.respondToPairing(peerCode, accept: accept);
      }
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
    // Use the redirect client for cross-server peers if available
    final redirectClient = _peerToClient[peerCode];
    final SignalingClient client;
    if (redirectClient != null && redirectClient.isConnected) {
      client = redirectClient;
    } else {
      final state = _signalingState;
      if (state is! SignalingConnected || !state.client.isConnected) {
        _updatePeerState(peerCode, PeerConnectionState.failed);
        return;
      }
      client = state.client;
    }

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
    // Translate stable ID to signaling code for WebRTC layer
    await _webrtcService.sendMessage(_toCode(peerId), plaintext);
  }

  /// Send a file to a peer.
  Future<void> sendFile(
    String peerId,
    String fileName,
    Uint8List data,
  ) async {
    final fileId = const Uuid().v4();
    // Translate stable ID to signaling code for WebRTC layer
    await _webrtcService.sendFile(_toCode(peerId), fileId, fileName, data);
  }

  /// Disconnect from a peer.
  Future<void> disconnectPeer(String peerId) async {
    await _webrtcService.closeConnection(_toCode(peerId));
    _updatePeerState(peerId, PeerConnectionState.disconnected);
  }

  /// Cancel an ongoing connection attempt.
  Future<void> cancelConnection(String peerId) async {
    await _webrtcService.closeConnection(_toCode(peerId));
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
    await _keyChangeController.close();
    await _linkRequestController.close();
  }

  // Private methods

  void _setupCallbacks() {
    // Handle handshake completion: update peer username and transition to connected
    _webrtcService.onHandshakeComplete =
        (peerId, publicKey, username, handshakeStableId) {
      // Resolve identity: prefer handshake stableId, fall back to publicKey-derived
      final provisionalId = _toStableId(peerId);
      final finalId = handshakeStableId ?? provisionalId;

      // Re-key peer entry if handshake stableId differs from provisional
      if (finalId != provisionalId && _peers.containsKey(provisionalId)) {
        final peer = _peers.remove(provisionalId)!;
        _peers[finalId] = peer.copyWith(id: finalId, username: username);
        // Update aliasing maps
        _codeToStableId[peerId] = finalId;
        _stableIdToCode.remove(provisionalId);
        _stableIdToCode[finalId] = peerId;
        // Re-key crypto session: move public key from provisional to final
        _cryptoService.removePeerPublicKey(provisionalId);
        _cryptoService.setPeerPublicKey(finalId, publicKey);
        logger.info('ConnectionManager',
            'Identity resolved: provisional=$provisionalId → final=$finalId');
      } else {
        final peer = _peers[finalId];
        if (peer != null) {
          _peers[finalId] = peer.copyWith(username: username);
        }
      }

      // Key rotation detection: known stableId with different publicKey
      _checkKeyRotation(finalId, publicKey);

      _updatePeerState(finalId, PeerConnectionState.connected);
    };

    _webrtcService.onMessage = (peerId, message) {
      // Translate signaling code to stable peer ID for reconnected peers
      final stableId = _toStableId(peerId);

      // Check if this is a message from a linked device (needs to be proxied to a peer)
      if (stableId.startsWith('link_')) {
        _handleLinkedDeviceMessage(stableId, message);
        return;
      }

      // Emit to UI — persistence is handled by the global listener in main.dart
      _messagesController.add((stableId, message));

      // Also forward to all connected linked devices
      _deviceLinkService.broadcastToLinkedDevices(
        fromPeerId: stableId,
        plaintext: message,
      );
    };

    _webrtcService.onFileChunk = (peerId, fileId, chunk, index, total) {
      final stableId = _toStableId(peerId);
      _fileChunksController.add((stableId, fileId, chunk, index, total));
    };

    _webrtcService.onFileStart =
        (peerId, fileId, fileName, totalSize, totalChunks) {
      final stableId = _toStableId(peerId);
      _fileStartController
          .add((stableId, fileId, fileName, totalSize, totalChunks));
    };

    _webrtcService.onFileComplete = (peerId, fileId) {
      final stableId = _toStableId(peerId);
      _fileCompleteController.add((stableId, fileId));
    };

    _webrtcService.onConnectionStateChange = (peerId, state) {
      // Translate signaling code to stable peer ID for reconnected peers
      final stableId = _toStableId(peerId);

      // Check if this is a linked device connection state change
      if (stableId.startsWith('link_')) {
        if (state == PeerConnectionState.connected) {
          _deviceLinkService.handleDeviceConnected(stableId);
        } else if (state == PeerConnectionState.disconnected ||
            state == PeerConnectionState.failed) {
          _deviceLinkService.handleDeviceDisconnected(stableId);
        }
        return;
      }

      _updatePeerState(stableId, state);

      // Persist peer as trusted after successful connection (handshake complete).
      // TrustedPeer.fromPeer derives the ID from the public key, so
      // saving is idempotent — reconnections just update the entry.
      if (state == PeerConnectionState.connected) {
        final peer = _peers[stableId];
        if (peer != null && peer.publicKey != null) {
          _trustedPeersStorage.savePeer(TrustedPeer.fromPeer(peer)).then((_) {
            logger.info('ConnectionManager', 'Saved trusted peer: $stableId');
          }).catchError((e) {
            logger.error('ConnectionManager',
                'Failed to save trusted peer: $stableId', e);
          });
        }
      }

      // Notify linked devices of peer connection state changes
      for (final device in _deviceLinkService.currentLinkedDevices) {
        if (device.state == LinkedDeviceState.connected) {
          // Send state update to linked device
          _deviceLinkService.proxyMessageToDevice(
            toDeviceId: device.id,
            fromPeerId: stableId,
            plaintext:
                '{"type":"peer_state","peerId":"$stableId","state":"${state.name}"}',
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
      if (parsed == null) {
        logger.warning(
            'ConnectionManager',
            'Could not parse linked device message from $deviceId '
                '(length=${message.length})');
        return;
      }

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
      logger.warning('ConnectionManager',
          'Error handling linked device message from $deviceId: $e');
    }
  }

  /// Parse a JSON message from a linked device.
  Map<String, dynamic>? _parseLinkedDeviceMessage(String message) {
    try {
      return Map<String, dynamic>.from(
        const JsonDecoder().convert(message) as Map,
      );
    } catch (e) {
      logger.debug(
          'ConnectionManager', 'Failed to parse linked device JSON: $e');
      return null;
    }
  }

  Future<void> _handleSignalingMessage(SignalingMessage message) async {
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
          // Derive a stable peer ID from the public key (like a phone number).
          // This ensures the same peer always maps to the same conversation
          // regardless of which pairing code was used for this session.
          final stableId = CryptoService.peerIdFromPublicKey(peerPublicKey);

          // Set up aliasing: signaling code ↔ stable ID
          _codeToStableId[peerCode] = stableId;
          _stableIdToCode[stableId] = peerCode;
          _peers.remove(peerCode); // Remove placeholder under pairing code

          // Check if this is a reconnection (existing trusted peer)
          final existingTrusted = await _trustedPeersStorage.getPeer(stableId);
          final isReconnection = existingTrusted != null;

          if (isReconnection) {
            logger.info('ConnectionManager',
                'Reconnection: $peerCode → $stableId (${existingTrusted.displayName})');
          } else {
            logger.info('ConnectionManager', 'New peer: $peerCode → $stableId');
          }

          // Create/update peer under the stable ID
          _peers[stableId] = Peer(
            id: stableId,
            displayName: existingTrusted?.alias ??
                existingTrusted?.displayName ??
                _peers[stableId]?.displayName ??
                'Peer $stableId',
            username: existingTrusted?.username ?? _peers[stableId]?.username,
            publicKey: peerPublicKey,
            connectionState: PeerConnectionState.connecting,
            lastSeen: DateTime.now(),
            isLocal: false,
          );
          _notifyPeersChanged();

          // Store public key under stable ID for fingerprint lookups
          _cryptoService.setPeerPublicKey(stableId, peerPublicKey);

          // Start WebRTC using the signaling code (WebRTC layer uses codes)
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

        case SignalingRegistered(redirects: final redirects):
          // Handle registration redirects for cross-server pairing
          if (redirects.isNotEmpty) {
            _handleRegistrationRedirects(redirects);
          }
          break;

        case SignalingOffer(from: final from, payload: final payload):
          // Pattern 6: Capture client reference before async operation (HIGH risk fix)
          // Use redirect client for cross-server peers
          final SignalingClient offerClient;
          final redirectOfferClient = _peerToClient[from];
          if (redirectOfferClient != null && redirectOfferClient.isConnected) {
            offerClient = redirectOfferClient;
          } else {
            final signalingState = _signalingState;
            if (signalingState is! SignalingConnected) {
              return;
            }
            offerClient = signalingState.client;
          }

          // Offer from matched peer (we're the non-initiator)
          // Use stable ID (may have been remapped in PairMatched handler)
          final stableId = _toStableId(from);
          final peerPublicKey = _cryptoService.getPeerPublicKey(from);
          if (!_peers.containsKey(stableId) ||
              _peers[stableId]?.publicKey == null) {
            _peers[stableId] = Peer(
              id: stableId,
              displayName: _peers[stableId]?.displayName ?? 'Peer $stableId',
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
          if (offerClient.isConnected) {
            offerClient.sendAnswer(from, answer);
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
          _updatePeerState(
              _toStableId(peerId), PeerConnectionState.disconnected);
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

      // Perform handshake when connected (translate to signaling code for WebRTC)
      if (state == PeerConnectionState.handshaking) {
        String? ourStableId;
        try {
          ourStableId = _cryptoService.stableId;
        } catch (_) {
          // CryptoService not yet initialized — stableId will be omitted
        }
        _webrtcService.performHandshake(_toCode(peerId),
            username: _username, stableId: ourStableId);
      }
    }
  }

  /// Detect key rotation: known stableId presenting a new publicKey.
  ///
  /// TOFU (Trust On First Use): first key associated with a stableId is trusted.
  /// Subsequent key changes are auto-accepted, logged, and produce a UI warning
  /// via the keyChanges stream and a system message in the chat.
  Future<void> _checkKeyRotation(String stableId, String newPublicKey) async {
    try {
      final existingPeer = await _trustedPeersStorage.getPeer(stableId);
      if (existingPeer != null && existingPeer.publicKey != newPublicKey) {
        logger.warning(
            'ConnectionManager',
            'Key rotation detected for $stableId '
                '(old: ${existingPeer.publicKey.substring(0, 8)}..., '
                'new: ${newPublicKey.substring(0, 8)}...)');

        final oldKey = existingPeer.publicKey;

        // Record key rotation in storage (sets keyChangeAcknowledged = false)
        await _trustedPeersStorage.recordKeyRotation(
            stableId, oldKey, newPublicKey);
        _cryptoService.setPeerPublicKey(stableId, newPublicKey);

        // Emit key change event for UI
        _keyChangeController.add((stableId, oldKey, newPublicKey));

        // Insert system message in chat history
        if (_messageStorage != null) {
          final msg = Message(
            localId: const Uuid().v4(),
            peerId: stableId,
            content: 'Safety number changed. Tap to verify.',
            type: MessageType.system,
            timestamp: DateTime.now(),
            isOutgoing: false,
            status: MessageStatus.delivered,
          );
          await _messageStorage.saveMessage(msg);
        }

        logger.info(
            'ConnectionManager', 'Key rotation persisted for $stableId');
      }
    } catch (e) {
      logger.error('ConnectionManager',
          'Failed to process key rotation for $stableId: $e');
    }
  }

  void _notifyPeersChanged() {
    _peersController.add(_peers.values.toList());
  }

  String _generatePairingCode() {
    return _generateSecurePairingCode();
  }

  /// Derive a collision-safe stable peer ID from a public key.
  ///
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

    // Also register rendezvous tokens on all redirect connections.
    // With replicationFactor >= server count, the DHT says each server
    // handles all tokens locally, so no rendezvous_partial redirects
    // are generated. We must explicitly register on redirect servers
    // so peers on different servers can discover each other.
    for (final entry in _redirectConnections.entries) {
      final conn = entry.value;
      if (conn.client.isConnected) {
        try {
          await conn.client.send(rendezvousMsg);
          logger.info('ConnectionManager',
              'Registered rendezvous tokens on redirect server ${entry.key}');
        } catch (e) {
          logger.warning('ConnectionManager',
              'Failed to register rendezvous on redirect ${entry.key}: $e');
        }
      }
    }

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

        // Re-register on redirect servers too
        for (final entry in _redirectConnections.entries) {
          final conn = entry.value;
          if (conn.client.isConnected) {
            conn.client.send(rendezvousMsg).catchError((e) {
              logger.warning('ConnectionManager',
                  'Failed to re-register rendezvous on redirect ${entry.key}: $e');
            });
          }
        }
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

  /// Follow registration redirects by connecting to other federated servers
  /// and registering the pairing code there for cross-server pairing.
  Future<void> _handleRegistrationRedirects(
      List<SignalingRedirect> redirects) async {
    final state = _signalingState;
    if (state is! SignalingConnected) return;

    for (final redirect in redirects) {
      if (redirect.endpoint.isEmpty) continue;

      logger.info('ConnectionManager',
          'Following pairing redirect to ${redirect.endpoint}');

      try {
        await _connectToRedirectServerForPairing(
          endpoint: redirect.endpoint,
          pairingCode: state.pairingCode,
          publicKey: _cryptoService.publicKeyBase64,
        );
      } catch (e) {
        logger.error('ConnectionManager',
            'Failed to follow pairing redirect to ${redirect.endpoint}', e);
      }
    }
  }

  /// Connect to a federated redirect server for pairing: register pairing code
  /// and listen for pairing messages (pair_incoming, pair_matched, etc.).
  Future<void> _connectToRedirectServerForPairing({
    required String endpoint,
    required String pairingCode,
    required String publicKey,
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

    // Listen for pairing messages from this redirect server
    final messageSub = client.messages.listen((message) {
      logger.info('ConnectionManager',
          'Redirect server message: ${message.runtimeType} from $endpoint');

      // Store the mapping so responses route through this client
      switch (message) {
        case SignalingPairIncoming(fromCode: final fromCode):
          _peerToClient[fromCode] = client;
        case SignalingPairMatched(peerCode: final peerCode):
          _peerToClient[peerCode] = client;
        default:
          break;
      }

      // Process through the same handler as the main client
      _handleSignalingMessage(message);
    });

    // Also listen for rendezvous events (in case both happen)
    final rendezvousSub = client.rendezvousEvents.listen((event) {
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

    _redirectConnections[endpoint] = _RedirectConnection(
      client: client,
      rendezvousSub: rendezvousSub,
      messageSub: messageSub,
    );

    try {
      await client.connect();
      logger.info('ConnectionManager',
          'Registered pairing code on redirect server $endpoint');
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
    _peerToClient.clear();
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

    // Also check by stable ID — after the first connection, the peer is
    // re-keyed from pairing code to stable ID, so a second rendezvous
    // match for the same pairing code wouldn't find it above.
    final stableId = _codeToStableId[matchedPeerId];
    if (stableId != null) {
      final stablePeer = _peers[stableId];
      if (stablePeer != null &&
          (stablePeer.connectionState == PeerConnectionState.connected ||
              stablePeer.connectionState == PeerConnectionState.connecting ||
              stablePeer.connectionState == PeerConnectionState.handshaking)) {
        logger.debug('ConnectionManager',
            'Skipping duplicate match for $matchedPeerId (already connected as $stableId)');
        return;
      }
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
  final StreamSubscription? messageSub;

  _RedirectConnection({
    required this.client,
    required this.rendezvousSub,
    this.messageSub,
  });

  Future<void> dispose() async {
    await messageSub?.cancel();
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
