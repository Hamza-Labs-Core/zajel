import 'dart:async';
import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../crypto/crypto_service.dart';
import '../models/models.dart';
import 'signaling_client.dart';
import 'webrtc_service.dart';

/// Central manager for all peer connections.
///
/// Coordinates:
/// - External peer connections via VPS signaling server
/// - WebRTC connection establishment
/// - Cryptographic handshakes
/// - Message and file routing
class ConnectionManager {
  final CryptoService _cryptoService;
  final WebRTCService _webrtcService;

  SignalingClient? _signalingClient;
  String? _externalPairingCode;

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

  ConnectionManager({
    required CryptoService cryptoService,
    required WebRTCService webrtcService,
  })  : _cryptoService = cryptoService,
        _webrtcService = webrtcService {
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
  String? get externalPairingCode => _externalPairingCode;

  /// Initialize the connection manager.
  Future<void> initialize() async {
    await _cryptoService.initialize();
  }

  /// Stream of incoming pair requests for UI to show approval dialog.
  final _pairRequestController =
      StreamController<(String code, String publicKey)>.broadcast();

  /// Stream of incoming pair requests.
  Stream<(String, String)> get pairRequests => _pairRequestController.stream;

  /// Connect to signaling server for external connections.
  Future<String> enableExternalConnections({
    required String serverUrl,
    String? pairingCode,
  }) async {
    _externalPairingCode = pairingCode ?? _generatePairingCode();

    _signalingClient = SignalingClient(
      serverUrl: serverUrl,
      pairingCode: _externalPairingCode!,
      publicKey: _cryptoService.publicKeyBase64,
    );

    _signalingSubscription =
        _signalingClient!.messages.listen(_handleSignalingMessage);

    await _signalingClient!.connect();

    return _externalPairingCode!;
  }

  /// Disable external connections.
  Future<void> disableExternalConnections() async {
    await _signalingClient?.disconnect();
    await _signalingSubscription?.cancel();
    _signalingClient = null;
    _externalPairingCode = null;
  }

  /// Request to connect to an external peer using their pairing code.
  /// This sends a pair request that the peer must approve.
  Future<void> connectToExternalPeer(String pairingCode) async {
    if (_signalingClient == null || !_signalingClient!.isConnected) {
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
    _signalingClient!.requestPairing(pairingCode);
  }

  /// Respond to an incoming pair request.
  void respondToPairRequest(String peerCode, {required bool accept}) {
    _signalingClient?.respondToPairing(peerCode, accept: accept);

    if (!accept) {
      // Remove peer from list if rejected
      _peers.remove(peerCode);
      _notifyPeersChanged();
    }
  }

  /// Start WebRTC connection after pairing is matched.
  Future<void> _startWebRTCConnection(String peerCode, String peerPublicKey, bool isInitiator) async {
    // Store peer's public key for handshake verification
    _cryptoService.setPeerPublicKey(peerCode, peerPublicKey);

    // Set up signaling message forwarding
    _webrtcService.onSignalingMessage = (targetPeerId, message) {
      if (message['type'] == 'ice_candidate') {
        _signalingClient!.sendIceCandidate(targetPeerId, message);
      }
    };

    if (isInitiator) {
      // We're the initiator - create and send offer
      final offer = await _webrtcService.createOffer(peerCode);
      _signalingClient!.sendOffer(peerCode, offer);
    }
    // If not initiator, wait for offer from the other peer
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
    await _signalingSubscription?.cancel();
    await _webrtcService.dispose();
    await _signalingClient?.dispose();
    await _peersController.close();
    await _messagesController.close();
    await _fileChunksController.close();
    await _fileStartController.close();
    await _fileCompleteController.close();
    await _pairRequestController.close();
  }

  // Private methods

  void _setupCallbacks() {
    _webrtcService.onMessage = (peerId, message) {
      _messagesController.add((peerId, message));
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
      _updatePeerState(peerId, state);
    };
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

        // Handle offer and create answer
        final answer = await _webrtcService.handleOffer(from, payload);
        _signalingClient!.sendAnswer(from, answer);

        // Set up ICE candidate forwarding
        _webrtcService.onSignalingMessage = (targetPeerId, msg) {
          if (msg['type'] == 'ice_candidate') {
            _signalingClient!.sendIceCandidate(targetPeerId, msg);
          }
        };
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
    }
  }

  void _updatePeerState(String peerId, PeerConnectionState state) {
    if (_peers.containsKey(peerId)) {
      _peers[peerId] = _peers[peerId]!.copyWith(
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
    // Generate a 6-character alphanumeric code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    final uuid = const Uuid().v4().replaceAll('-', '');
    final buffer = StringBuffer();

    for (var i = 0; i < 6; i++) {
      final index = int.parse(uuid.substring(i * 2, i * 2 + 2), radix: 16);
      buffer.write(chars[index % chars.length]);
    }

    return buffer.toString();
  }
}

class ConnectionException implements Exception {
  final String message;
  ConnectionException(this.message);

  @override
  String toString() => 'ConnectionException: $message';
}
