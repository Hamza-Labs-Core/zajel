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
/// Group messaging reuses existing 1:1 P2P connections rather than
/// establishing new ones. The group layer uses namespaced peer IDs
/// (e.g., "group_{groupId}_{deviceId}") for internal tracking, but
/// this adapter maps those back to the underlying plain device IDs
/// (6-char pairing codes) for actual WebRTC operations.
///
/// Group data is encoded as base64 text and sent over the existing
/// encrypted WebRTC message channel. A `grp:` prefix distinguishes
/// group data from regular chat messages so the receiver can route
/// them correctly.
class WebRtcP2PAdapter implements P2PConnectionAdapter {
  static const String _groupDataPrefix = 'grp:';
  static const String _groupPeerPrefix = 'group_';

  final ConnectionManager _connectionManager;
  final WebRTCService _webrtcService;

  final _connectionStateController =
      StreamController<(String, PeerConnectionState)>.broadcast();
  final _incomingDataController =
      StreamController<(String, Uint8List)>.broadcast();

  StreamSubscription? _peersSub;
  StreamSubscription? _messagesSub;

  /// Track last-known state per group peer ID to emit only actual changes.
  final Map<String, PeerConnectionState> _lastKnownState = {};

  /// Map of device ID → set of group-namespaced peer IDs that use it.
  /// This allows us to translate connection state changes and incoming
  /// messages from the plain device ID back to the group-namespaced IDs.
  final Map<String, Set<String>> _deviceToGroupPeerIds = {};

  WebRtcP2PAdapter({
    required ConnectionManager connectionManager,
    required WebRTCService webrtcService,
  })  : _connectionManager = connectionManager,
        _webrtcService = webrtcService {
    _setupListeners();
  }

  /// Extract the plain device ID from a group-namespaced peer ID.
  ///
  /// Format: "group_{groupId}_{deviceId}"
  /// Returns null if the peer ID is not group-namespaced.
  String? _extractDeviceId(String groupPeerId) {
    if (!groupPeerId.startsWith(_groupPeerPrefix)) return null;
    // The device ID is the last segment after the final underscore.
    // Group IDs may contain underscores (e.g. UUIDs with hyphens converted),
    // but device IDs are 6-char pairing codes, so we take the last '_' segment.
    final lastUnderscore = groupPeerId.lastIndexOf('_');
    if (lastUnderscore <= _groupPeerPrefix.length) return null;
    return groupPeerId.substring(lastUnderscore + 1);
  }

  void _setupListeners() {
    // Listen to peer list changes to detect connection state transitions
    // for device IDs that are mapped to group peers.
    _peersSub = _connectionManager.peers.listen((peers) {
      for (final peer in peers) {
        final groupPeerIds = _deviceToGroupPeerIds[peer.id];
        if (groupPeerIds == null || groupPeerIds.isEmpty) continue;

        // Emit state change for each group-namespaced peer ID
        // that maps to this device ID.
        for (final groupPeerId in groupPeerIds) {
          final previousState = _lastKnownState[groupPeerId];
          if (previousState != peer.connectionState) {
            _lastKnownState[groupPeerId] = peer.connectionState;
            _connectionStateController.add((groupPeerId, peer.connectionState));
          }
        }
      }
    });

    // Listen to incoming messages and forward group data.
    // Messages arrive with the plain device ID as the peer ID.
    _messagesSub = _connectionManager.messages.listen((event) {
      final (peerId, message) = event;

      // Only process messages with our group data prefix.
      if (!message.startsWith(_groupDataPrefix)) return;

      // Find all group peer IDs that map to this device ID.
      final groupPeerIds = _deviceToGroupPeerIds[peerId];
      if (groupPeerIds == null || groupPeerIds.isEmpty) return;

      try {
        final payload = message.substring(_groupDataPrefix.length);
        final data = base64Decode(payload);
        // Forward to all group contexts that include this device.
        for (final groupPeerId in groupPeerIds) {
          _incomingDataController.add((groupPeerId, Uint8List.fromList(data)));
        }
      } catch (e) {
        logger.error(
            'WebRtcP2PAdapter', 'Failed to decode group data from $peerId', e);
      }
    });
  }

  @override
  Future<void> connectToPeer(String peerId) async {
    // Group connections reuse existing 1:1 connections. We don't initiate
    // new signaling/pairing — we just register the mapping so that state
    // changes and messages from the underlying device ID are forwarded
    // to the group layer.
    final deviceId = _extractDeviceId(peerId);
    if (deviceId == null) {
      logger.error('WebRtcP2PAdapter',
          'Cannot connect: invalid group peer ID format: $peerId');
      return;
    }

    // Register the mapping from device ID to group peer ID.
    _deviceToGroupPeerIds.putIfAbsent(deviceId, () => {}).add(peerId);

    // Check if the underlying 1:1 connection is already established.
    // If so, immediately emit a connected state for the group peer.
    final existingPeers = _connectionManager.currentPeers;
    final existingPeer = existingPeers.where((p) => p.id == deviceId).toList();

    if (existingPeer.isNotEmpty) {
      final state = existingPeer.first.connectionState;
      _lastKnownState[peerId] = state;
      _connectionStateController.add((peerId, state));
    } else {
      // The member's device is not currently connected as a 1:1 peer.
      // We can't establish a new connection with a group-namespaced ID.
      // Mark as disconnected — messages will fall through to the direct
      // send fallback in group_detail_screen.dart.
      _lastKnownState[peerId] = PeerConnectionState.disconnected;
      _connectionStateController
          .add((peerId, PeerConnectionState.disconnected));
    }
  }

  @override
  Future<void> disconnectPeer(String peerId) async {
    // Remove the group peer mapping. Don't disconnect the underlying
    // 1:1 connection — it may be used by other groups or direct chat.
    final deviceId = _extractDeviceId(peerId);
    if (deviceId != null) {
      _deviceToGroupPeerIds[deviceId]?.remove(peerId);
      if (_deviceToGroupPeerIds[deviceId]?.isEmpty ?? false) {
        _deviceToGroupPeerIds.remove(deviceId);
      }
    }
    _lastKnownState.remove(peerId);
  }

  @override
  PeerConnectionState getConnectionState(String peerId) {
    final deviceId = _extractDeviceId(peerId);
    if (deviceId == null) return PeerConnectionState.disconnected;
    // Check the underlying 1:1 connection state.
    return _webrtcService.getConnectionState(deviceId);
  }

  @override
  Future<void> sendData(String peerId, Uint8List data) async {
    final deviceId = _extractDeviceId(peerId);
    if (deviceId == null) {
      throw Exception(
          'Cannot send data: invalid group peer ID format: $peerId');
    }
    // Encode binary data as prefixed base64 text so the receiver can
    // distinguish group data from regular chat messages.
    final encoded = '$_groupDataPrefix${base64Encode(data)}';
    await _connectionManager.sendMessage(deviceId, encoded);
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
    _deviceToGroupPeerIds.clear();
  }
}
