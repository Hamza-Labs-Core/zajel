import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../crypto/crypto_service.dart';
import '../models/models.dart';
import 'discovery_service.dart';
import 'local_signaling_server.dart';
import 'signaling_client.dart';
import 'webrtc_service.dart';

/// Central manager for all peer connections.
///
/// Coordinates:
/// - Local peer discovery via mDNS
/// - External peer connections via signaling server
/// - WebRTC connection establishment
/// - Cryptographic handshakes
/// - Message and file routing
class ConnectionManager {
  final CryptoService _cryptoService;
  final DiscoveryService _discoveryService;
  final WebRTCService _webrtcService;

  LocalSignalingServer? _localSignalingServer;
  StreamSubscription? _localSignalingSubscription;

  SignalingClient? _signalingClient;
  String? _externalPairingCode;

  final Map<String, Peer> _peers = {};
  final _peersController = StreamController<List<Peer>>.broadcast();
  final _messagesController =
      StreamController<(String peerId, String message)>.broadcast();
  final _fileChunksController =
      StreamController<(String peerId, String fileId, Uint8List chunk, int index, int total)>.broadcast();

  StreamSubscription? _discoverySubscription;
  StreamSubscription? _signalingSubscription;

  ConnectionManager({
    required CryptoService cryptoService,
    required DiscoveryService discoveryService,
    required WebRTCService webrtcService,
  })  : _cryptoService = cryptoService,
        _discoveryService = discoveryService,
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

  /// Current list of peers.
  List<Peer> get currentPeers => _peers.values.toList();

  /// Our external pairing code (for sharing).
  String? get externalPairingCode => _externalPairingCode;

  /// Initialize the connection manager.
  Future<void> initialize() async {
    await _cryptoService.initialize();

    // Start local signaling server
    _localSignalingServer = LocalSignalingServer();
    final signalingPort = await _localSignalingServer!.start();
    print('[ConnectionManager] Local signaling server started on port $signalingPort');

    // Update discovery service with actual signaling port
    await _discoveryService.updatePort(signalingPort);

    // Listen to local signaling messages
    _localSignalingSubscription = _localSignalingServer!.messages.listen(_handleLocalSignalingMessage);

    // Listen to discovered peers
    _discoverySubscription = _discoveryService.peers.listen(_handleDiscoveredPeers);

    // Start local discovery
    await _discoveryService.start();
  }

  /// Get the local signaling port.
  int? get localSignalingPort => _localSignalingServer?.actualPort;

  /// Connect to signaling server for external connections.
  Future<String> enableExternalConnections({
    required String serverUrl,
    String? pairingCode,
  }) async {
    _externalPairingCode = pairingCode ?? _generatePairingCode();

    _signalingClient = SignalingClient(
      serverUrl: serverUrl,
      pairingCode: _externalPairingCode!,
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

  /// Connect to a local peer (discovered via mDNS).
  Future<void> connectToLocalPeer(String peerId) async {
    final peer = _peers[peerId];
    if (peer == null) {
      throw ConnectionException('Unknown peer: $peerId');
    }

    if (peer.ipAddress == null || peer.port == null) {
      throw ConnectionException('Peer $peerId has no address information');
    }

    _updatePeerState(peerId, PeerConnectionState.connecting);

    try {
      // Set up signaling callback to send messages to peer
      _webrtcService.onSignalingMessage = (targetPeerId, message) {
        _sendLocalSignal(targetPeerId, message);
      };

      // Create and send WebRTC offer
      final offer = await _webrtcService.createOffer(peerId);

      // Send offer to peer via local HTTP signaling
      final sent = await sendLocalSignal(
        targetHost: peer.ipAddress!,
        targetPort: peer.port!,
        fromPeerId: _discoveryService.instanceId,
        type: 'offer',
        payload: offer,
      );

      if (!sent) {
        throw ConnectionException('Failed to send offer to peer');
      }

      print('[ConnectionManager] Sent offer to ${peer.ipAddress}:${peer.port}');
    } catch (e) {
      _updatePeerState(peerId, PeerConnectionState.failed);
      rethrow;
    }
  }

  /// Send a signaling message to a local peer.
  Future<void> _sendLocalSignal(String peerId, Map<String, dynamic> message) async {
    final peer = _peers[peerId];
    if (peer == null || peer.ipAddress == null || peer.port == null) {
      print('[ConnectionManager] Cannot send signal to $peerId: no address');
      return;
    }

    await sendLocalSignal(
      targetHost: peer.ipAddress!,
      targetPort: peer.port!,
      fromPeerId: _discoveryService.instanceId,
      type: message['type'] as String,
      payload: message,
    );
  }

  /// Connect to an external peer using their pairing code.
  Future<void> connectToExternalPeer(String pairingCode) async {
    if (_signalingClient == null || !_signalingClient!.isConnected) {
      throw ConnectionException('Not connected to signaling server');
    }

    // Create a placeholder peer
    final peer = Peer(
      id: pairingCode,
      displayName: 'External Peer',
      connectionState: PeerConnectionState.connecting,
      lastSeen: DateTime.now(),
      isLocal: false,
    );
    _peers[pairingCode] = peer;
    _notifyPeersChanged();

    // Create and send WebRTC offer
    final offer = await _webrtcService.createOffer(pairingCode);
    _signalingClient!.sendOffer(pairingCode, offer);

    // Set up signaling message forwarding
    _webrtcService.onSignalingMessage = (targetPeerId, message) {
      if (message['type'] == 'ice_candidate') {
        _signalingClient!.sendIceCandidate(targetPeerId, message);
      }
    };
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
    await _discoverySubscription?.cancel();
    await _signalingSubscription?.cancel();
    await _localSignalingSubscription?.cancel();
    await _localSignalingServer?.dispose();
    await _discoveryService.dispose();
    await _webrtcService.dispose();
    await _signalingClient?.dispose();
    await _peersController.close();
    await _messagesController.close();
    await _fileChunksController.close();
  }

  // Private methods

  void _setupCallbacks() {
    _webrtcService.onMessage = (peerId, message) {
      _messagesController.add((peerId, message));
    };

    _webrtcService.onFileChunk = (peerId, fileId, chunk, index, total) {
      _fileChunksController.add((peerId, fileId, chunk, index, total));
    };

    _webrtcService.onConnectionStateChange = (peerId, state) {
      _updatePeerState(peerId, state);
    };
  }

  /// Handle incoming local signaling messages.
  void _handleLocalSignalingMessage(LocalSignalingMessage message) async {
    final fromPeerId = message.fromPeerId;
    print('[ConnectionManager] Received ${message.type} from $fromPeerId');

    // Find or create peer entry
    if (!_peers.containsKey(fromPeerId)) {
      // Look for this peer in discovered peers by matching the ID
      final existingPeer = _peers.values.firstWhere(
        (p) => p.id == fromPeerId,
        orElse: () => Peer(
          id: fromPeerId,
          displayName: 'Local Peer',
          connectionState: PeerConnectionState.connecting,
          lastSeen: DateTime.now(),
          isLocal: true,
        ),
      );
      _peers[fromPeerId] = existingPeer;
    }

    switch (message.type) {
      case 'offer':
        _updatePeerState(fromPeerId, PeerConnectionState.connecting);

        // Set up signaling callback for response
        _webrtcService.onSignalingMessage = (targetPeerId, msg) {
          _sendLocalSignal(targetPeerId, msg);
        };

        // Handle offer and create answer
        final answer = await _webrtcService.handleOffer(fromPeerId, message.payload);

        // Send answer back
        final peer = _peers[fromPeerId];
        if (peer?.ipAddress != null && peer?.port != null) {
          await sendLocalSignal(
            targetHost: peer!.ipAddress!,
            targetPort: peer.port!,
            fromPeerId: _discoveryService.instanceId,
            type: 'answer',
            payload: answer,
          );
          print('[ConnectionManager] Sent answer to ${peer.ipAddress}:${peer.port}');
        }
        break;

      case 'answer':
        await _webrtcService.handleAnswer(fromPeerId, message.payload);
        break;

      case 'ice_candidate':
        await _webrtcService.addIceCandidate(fromPeerId, message.payload);
        break;
    }
  }

  void _handleDiscoveredPeers(List<Peer> discoveredPeers) {
    // Update peers map with discovered peers
    for (final peer in discoveredPeers) {
      if (!_peers.containsKey(peer.id)) {
        _peers[peer.id] = peer;
      } else {
        // Update existing peer info but preserve connection state
        _peers[peer.id] = peer.copyWith(
          connectionState: _peers[peer.id]!.connectionState,
        );
      }
    }

    // Remove peers that are no longer discovered (and not connected)
    final discoveredIds = discoveredPeers.map((p) => p.id).toSet();
    _peers.removeWhere((id, peer) =>
        !discoveredIds.contains(id) &&
        peer.isLocal &&
        peer.connectionState == PeerConnectionState.disconnected);

    _notifyPeersChanged();
  }

  void _handleSignalingMessage(SignalingMessage message) async {
    switch (message) {
      case SignalingOffer(from: final from, payload: final payload):
        // Add peer if not known
        if (!_peers.containsKey(from)) {
          _peers[from] = Peer(
            id: from,
            displayName: 'External Peer',
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

/// Provider for the connection manager.
final connectionManagerProvider = Provider<ConnectionManager>((ref) {
  throw UnimplementedError('Must be overridden in ProviderScope');
});
