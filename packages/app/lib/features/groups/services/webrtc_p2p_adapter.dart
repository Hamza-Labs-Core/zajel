import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../../../core/logging/logger_service.dart';
import '../../../core/models/peer.dart';
import '../../../core/network/connection_manager.dart';
import '../../../core/network/webrtc_service.dart';
import 'group_connection_service.dart';

/// Concrete implementation of [P2PConnectionAdapter] that bridges
/// the group connection layer to [ConnectionManager] and [WebRTCService].
///
/// Group data is encoded as base64 text and sent over the existing
/// encrypted WebRTC message channel. A `grp:` prefix distinguishes
/// group data from regular chat messages so the receiver can route
/// them correctly.
///
/// Connection state changes are derived from the [ConnectionManager]'s
/// peer stream, filtered to peers whose IDs start with `group_`.
class WebRtcP2PAdapter implements P2PConnectionAdapter {
  static const String _groupDataPrefix = 'grp:';

  final ConnectionManager _connectionManager;
  final WebRTCService _webrtcService;

  final _connectionStateController =
      StreamController<(String, PeerConnectionState)>.broadcast();
  final _incomingDataController =
      StreamController<(String, Uint8List)>.broadcast();

  StreamSubscription? _peersSub;
  StreamSubscription? _messagesSub;

  /// Track last-known state per peer to emit only actual changes.
  final Map<String, PeerConnectionState> _lastKnownState = {};

  WebRtcP2PAdapter({
    required ConnectionManager connectionManager,
    required WebRTCService webrtcService,
  })  : _connectionManager = connectionManager,
        _webrtcService = webrtcService {
    _setupListeners();
  }

  void _setupListeners() {
    // Listen to peer list changes to detect connection state transitions.
    _peersSub = _connectionManager.peers.listen((peers) {
      for (final peer in peers) {
        if (!peer.id.startsWith('group_')) continue;

        final previousState = _lastKnownState[peer.id];
        if (previousState != peer.connectionState) {
          _lastKnownState[peer.id] = peer.connectionState;
          _connectionStateController.add((peer.id, peer.connectionState));
        }
      }
    });

    // Listen to incoming messages and forward group data.
    _messagesSub = _connectionManager.messages.listen((event) {
      final (peerId, message) = event;
      if (!peerId.startsWith('group_')) return;

      // Only process messages with our group data prefix.
      if (!message.startsWith(_groupDataPrefix)) return;

      try {
        final payload = message.substring(_groupDataPrefix.length);
        final data = base64Decode(payload);
        _incomingDataController.add((peerId, Uint8List.fromList(data)));
      } catch (e) {
        logger.error(
            'WebRtcP2PAdapter', 'Failed to decode group data from $peerId', e);
      }
    });
  }

  @override
  Future<void> connectToPeer(String peerId) async {
    // The ConnectionManager.connectToPeer expects a pairing code and
    // initiates the full signaling + WebRTC flow. For group connections,
    // the peerId is already namespaced (e.g., "group_<groupId>_<deviceId>").
    await _connectionManager.connectToPeer(peerId);
  }

  @override
  Future<void> disconnectPeer(String peerId) async {
    _lastKnownState.remove(peerId);
    await _connectionManager.disconnectPeer(peerId);
  }

  @override
  PeerConnectionState getConnectionState(String peerId) {
    return _webrtcService.getConnectionState(peerId);
  }

  @override
  Future<void> sendData(String peerId, Uint8List data) async {
    // Encode binary data as prefixed base64 text so the receiver can
    // distinguish group data from regular chat messages.
    final encoded = '$_groupDataPrefix${base64Encode(data)}';
    await _connectionManager.sendMessage(peerId, encoded);
  }

  @override
  Stream<(String, PeerConnectionState)> get connectionStateChanges =>
      _connectionStateController.stream;

  @override
  Stream<(String, Uint8List)> get incomingData =>
      _incomingDataController.stream;

  /// Dispose resources. Call when the adapter is no longer needed.
  Future<void> dispose() async {
    await _peersSub?.cancel();
    await _messagesSub?.cancel();
    await _connectionStateController.close();
    await _incomingDataController.close();
    _lastKnownState.clear();
  }
}
