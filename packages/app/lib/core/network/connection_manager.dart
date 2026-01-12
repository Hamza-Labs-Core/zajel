import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../crypto/crypto_service.dart';
import '../models/models.dart';
import 'device_link_service.dart';
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

  /// Current signaling state - uses sealed class for type-safe null handling.
  SignalingState _signalingState = SignalingDisconnected();

  final Map<String, Peer> _peers = {};
  final _peersController = StreamController<List<Peer>>.broadcast();
  final _messagesController =
      StreamController<(String peerId, String message)>.broadcast();
  final _fileChunksController =
      StreamController<(String peerId, String fileId, Uint8List chunk, int index, int total)>.broadcast();
  final _fileStartController =
      StreamController<(String peerId, String fileId, String fileName, int totalSize, int totalChunks)>.broadcast();
  final _fileCompleteController =
      StreamController<(String peerId, String fileId)>.broadcast();

  StreamSubscription? _signalingSubscription;

  /// Subscription to WebRTC signaling events (ICE candidates, etc.).
  /// Uses stream-based approach to avoid race conditions when multiple
  /// connections are attempted simultaneously. This replaces the previous
  /// callback-based approach (`onSignalingMessage`) that was vulnerable
  /// to being overwritten by each new connection.
  StreamSubscription? _signalingEventsSubscription;


  ConnectionManager({
    required CryptoService cryptoService,
    required WebRTCService webrtcService,
    required DeviceLinkService deviceLinkService,
  })  : _cryptoService = cryptoService,
        _webrtcService = webrtcService,
        _deviceLinkService = deviceLinkService {
    _setupCallbacks();
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
  Stream<(String, String)> get fileCompletes =>
      _fileCompleteController.stream;

  /// Current list of peers.
  List<Peer> get currentPeers => _peers.values.toList();

  /// Our external pairing code (for sharing).
  String? get externalPairingCode => switch (_signalingState) {
    SignalingConnected(pairingCode: final code) => code,
    SignalingDisconnected() => null,
  };

  /// Initialize the connection manager.
  Future<void> initialize() async {
    await _cryptoService.initialize();
  }

  /// Stream of incoming pair requests for UI to show approval dialog.
  final _pairRequestController =
      StreamController<(String code, String publicKey)>.broadcast();

  /// Stream of incoming pair requests.
  Stream<(String, String)> get pairRequests => _pairRequestController.stream;

  /// Stream of incoming link requests from web clients.
  final _linkRequestController =
      StreamController<(String linkCode, String publicKey, String deviceName)>.broadcast();

  /// Stream of incoming link requests.
  Stream<(String, String, String)> get linkRequests => _linkRequestController.stream;

  /// Connect to signaling server for external connections.
  Future<String> enableExternalConnections({
    required String serverUrl,
    String? pairingCode,
  }) async {
    // Cancel existing subscriptions to prevent leaks if called multiple times
    await _signalingSubscription?.cancel();
    _signalingSubscription = null;
    await _signalingEventsSubscription?.cancel();
    _signalingEventsSubscription = null;

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
    _signalingEventsSubscription = _webrtcService.signalingEvents.listen((event) {
      // Check if we're still connected before sending
      final state = _signalingState;
      if (state is! SignalingConnected || !state.client.isConnected) return;

      if (event.message['type'] == 'ice_candidate') {
        state.client.sendIceCandidate(event.peerId, event.message);
      }
    });

    await client.connect();

    return code;
  }

  /// Disable external connections.
  Future<void> disableExternalConnections() async {
    // Cancel signaling events subscription first to prevent stale callbacks
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

  /// Request to connect to an external peer using their pairing code.
  /// This sends a pair request that the peer must approve.
  Future<void> connectToExternalPeer(String pairingCode) async {
    // Pattern 2: Guard with early return using local variable capture
    final state = _signalingState;
    if (state is! SignalingConnected || !state.client.isConnected) {
      throw ConnectionException('Not connected to signaling server');
    }

    // Create a placeholder peer (waiting for approval)
    final peer = Peer(
      id: pairingCode,
      displayName: 'Peer $pairingCode',
      connectionState: PeerConnectionState.connecting,
      lastSeen: DateTime.now(),
      isLocal: false,
    );
    _peers[pairingCode] = peer;
    _notifyPeersChanged();

    // Request pairing (peer must approve before WebRTC starts)
    // Using captured state.client - guaranteed non-null by pattern match
    state.client.requestPairing(pairingCode);
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
  void respondToLinkRequest(String linkCode, {required bool accept, String? deviceId}) {
    // Safe access using pattern matching
    final state = _signalingState;
    if (state is SignalingConnected) {
      state.client.respondToLinkRequest(linkCode, accept: accept, deviceId: deviceId);
    }

    if (!accept) {
      _deviceLinkService.cancelLinkSession();
    }
  }

  /// Start WebRTC connection after pairing is matched.
  Future<void> _startWebRTCConnection(String peerCode, String peerPublicKey, bool isInitiator) async {
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
  Future<void> _startLinkConnection(String linkCode, String webPublicKey, bool isInitiator) async {
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
    // Cancel signaling events subscription
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

      // Normal peer message - emit to UI
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

    _webrtcService.onFileStart = (peerId, fileId, fileName, totalSize, totalChunks) {
      _fileStartController.add((peerId, fileId, fileName, totalSize, totalChunks));
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

      // Notify linked devices of peer connection state changes
      for (final device in _deviceLinkService.currentLinkedDevices) {
        if (device.state == LinkedDeviceState.connected) {
          // Send state update to linked device
          _deviceLinkService.proxyMessageToDevice(
            toDeviceId: device.id,
            fromPeerId: peerId,
            plaintext: '{"type":"peer_state","peerId":"$peerId","state":"${state.name}"}',
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

  void _handleSignalingMessage(SignalingMessage message) async {
    switch (message) {
      case SignalingPairIncoming(fromCode: final fromCode, fromPublicKey: final fromPublicKey):
        // Someone wants to pair with us - emit event for UI to show approval dialog
        _pairRequestController.add((fromCode, fromPublicKey));
        break;

      case SignalingPairMatched(peerCode: final peerCode, peerPublicKey: final peerPublicKey, isInitiator: final isInitiator):
        // Pairing approved by both sides - start WebRTC connection
        if (!_peers.containsKey(peerCode)) {
          _peers[peerCode] = Peer(
            id: peerCode,
            displayName: 'Peer $peerCode',
            connectionState: PeerConnectionState.connecting,
            lastSeen: DateTime.now(),
            isLocal: false,
          );
          _notifyPeersChanged();
        }
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

      case SignalingPairError(error: final _):
        // Pairing error
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
        if (!_peers.containsKey(from)) {
          _peers[from] = Peer(
            id: from,
            displayName: 'Peer $from',
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
      case SignalingLinkRequest(linkCode: final linkCode, publicKey: final publicKey, deviceName: final deviceName):
        // Web client wants to link with us - emit event for UI to show approval
        _linkRequestController.add((linkCode, publicKey, deviceName));
        break;

      case SignalingLinkMatched(linkCode: final linkCode, peerPublicKey: final peerPublicKey, isInitiator: final isInitiator):
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
}

class ConnectionException implements Exception {
  final String message;
  ConnectionException(this.message);

  @override
  String toString() => 'ConnectionException: $message';
}
