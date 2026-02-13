import 'dart:async';
import 'dart:typed_data';

import '../../../core/logging/logger_service.dart';
import '../../../core/models/peer.dart';
import '../models/group.dart';

/// Connection state for a single group member.
class MemberConnection {
  final String deviceId;
  final String displayName;
  PeerConnectionState state;
  DateTime lastStateChange;

  MemberConnection({
    required this.deviceId,
    required this.displayName,
    this.state = PeerConnectionState.disconnected,
    DateTime? lastStateChange,
  }) : lastStateChange = lastStateChange ?? DateTime.now();

  MemberConnection copyWith({
    String? deviceId,
    String? displayName,
    PeerConnectionState? state,
    DateTime? lastStateChange,
  }) {
    return MemberConnection(
      deviceId: deviceId ?? this.deviceId,
      displayName: displayName ?? this.displayName,
      state: state ?? this.state,
      lastStateChange: lastStateChange ?? this.lastStateChange,
    );
  }
}

/// Event emitted when a group member's connection state changes.
class GroupConnectionEvent {
  final String groupId;
  final String deviceId;
  final PeerConnectionState oldState;
  final PeerConnectionState newState;

  GroupConnectionEvent({
    required this.groupId,
    required this.deviceId,
    required this.oldState,
    required this.newState,
  });
}

/// Event emitted when a message arrives on a group data channel.
class GroupDataEvent {
  final String groupId;
  final String fromDeviceId;
  final Uint8List data;

  GroupDataEvent({
    required this.groupId,
    required this.fromDeviceId,
    required this.data,
  });
}

/// Abstract interface for the underlying P2P connection layer.
///
/// This decouples GroupConnectionService from [ConnectionManager] and
/// [WebRTCService], making it testable without flutter_webrtc.
abstract class P2PConnectionAdapter {
  /// Initiate a connection to a peer identified by [peerId].
  Future<void> connectToPeer(String peerId);

  /// Disconnect from a peer.
  Future<void> disconnectPeer(String peerId);

  /// Get the current connection state for a peer.
  PeerConnectionState getConnectionState(String peerId);

  /// Send raw bytes to a peer over their data channel.
  Future<void> sendData(String peerId, Uint8List data);

  /// Stream of connection state changes: (peerId, newState).
  Stream<(String, PeerConnectionState)> get connectionStateChanges;

  /// Stream of incoming data from peers: (peerId, data).
  Stream<(String, Uint8List)> get incomingData;
}

/// Manages mesh WebRTC connections for a group.
///
/// When a group becomes active, this service establishes data channels
/// with ALL other group members, creating a full mesh topology. Each
/// member connects to every other member, resulting in N*(N-1)/2 total
/// connections for N members.
///
/// The service:
/// - Tracks connection state for each group member
/// - Handles member join: connects to new members
/// - Handles member leave: disconnects from departed members
/// - Provides streams for connection events and incoming data
/// - Routes outgoing data to all connected members (broadcast)
///
/// Uses [P2PConnectionAdapter] to delegate actual WebRTC operations to
/// the existing P2P infrastructure, avoiding duplication.
class GroupConnectionService {
  final P2PConnectionAdapter _adapter;

  /// Active group connections: {groupId: {deviceId: MemberConnection}}
  final Map<String, Map<String, MemberConnection>> _connections = {};

  /// Which groups are currently active (we want mesh connections for).
  final Set<String> _activeGroups = {};

  final _connectionEventController =
      StreamController<GroupConnectionEvent>.broadcast();
  final _dataEventController = StreamController<GroupDataEvent>.broadcast();

  StreamSubscription? _stateChangeSub;
  StreamSubscription? _incomingDataSub;

  /// Stream of member connection state changes.
  Stream<GroupConnectionEvent> get connectionEvents =>
      _connectionEventController.stream;

  /// Stream of incoming data from group members.
  Stream<GroupDataEvent> get dataEvents => _dataEventController.stream;

  GroupConnectionService({required P2PConnectionAdapter adapter})
      : _adapter = adapter {
    _setupListeners();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  void _setupListeners() {
    _stateChangeSub = _adapter.connectionStateChanges.listen((event) {
      final (peerId, newState) = event;
      _handleConnectionStateChange(peerId, newState);
    });

    _incomingDataSub = _adapter.incomingData.listen((event) {
      final (peerId, data) = event;
      _handleIncomingData(peerId, data);
    });
  }

  /// Dispose all resources and close all group connections.
  Future<void> dispose() async {
    await _stateChangeSub?.cancel();
    await _incomingDataSub?.cancel();

    for (final groupId in _activeGroups.toList()) {
      await deactivateGroup(groupId);
    }

    await _connectionEventController.close();
    await _dataEventController.close();
  }

  // ---------------------------------------------------------------------------
  // Group activation / deactivation
  // ---------------------------------------------------------------------------

  /// Activate mesh connections for a group.
  ///
  /// Initiates P2P connections to all other members. Call this when
  /// the user opens a group chat or the group needs real-time sync.
  Future<void> activateGroup(Group group) async {
    final groupId = group.id;
    _activeGroups.add(groupId);

    // Initialize connection tracking for all other members
    _connections.putIfAbsent(groupId, () => {});
    final groupConns = _connections[groupId]!;

    for (final member in group.otherMembers) {
      if (!groupConns.containsKey(member.deviceId)) {
        groupConns[member.deviceId] = MemberConnection(
          deviceId: member.deviceId,
          displayName: member.displayName,
        );
      }
    }

    // Initiate connections to all other members
    for (final member in group.otherMembers) {
      final peerId = _groupPeerId(groupId, member.deviceId);
      try {
        _updateMemberState(
            groupId, member.deviceId, PeerConnectionState.connecting);
        await _adapter.connectToPeer(peerId);
      } catch (e) {
        logger.error('GroupConnectionService',
            'Failed to connect to ${member.deviceId} in group $groupId', e);
        _updateMemberState(
            groupId, member.deviceId, PeerConnectionState.failed);
      }
    }
  }

  /// Deactivate mesh connections for a group.
  ///
  /// Disconnects from all group members. Call this when the user
  /// navigates away from the group or the group is deleted.
  Future<void> deactivateGroup(String groupId) async {
    _activeGroups.remove(groupId);

    final groupConns = _connections[groupId];
    if (groupConns == null) return;

    for (final entry in groupConns.entries) {
      final peerId = _groupPeerId(groupId, entry.key);
      try {
        await _adapter.disconnectPeer(peerId);
      } catch (e) {
        logger.error('GroupConnectionService',
            'Failed to disconnect from ${entry.key} in group $groupId', e);
      }
      _updateMemberState(groupId, entry.key, PeerConnectionState.disconnected);
    }

    _connections.remove(groupId);
  }

  /// Check if a group is currently active.
  bool isGroupActive(String groupId) => _activeGroups.contains(groupId);

  // ---------------------------------------------------------------------------
  // Member management
  // ---------------------------------------------------------------------------

  /// Handle a new member joining the group.
  ///
  /// If the group is active, immediately connect to the new member.
  Future<void> handleMemberJoined(
    String groupId,
    GroupMember newMember,
  ) async {
    if (!_activeGroups.contains(groupId)) return;

    _connections.putIfAbsent(groupId, () => {});
    final groupConns = _connections[groupId]!;

    groupConns[newMember.deviceId] = MemberConnection(
      deviceId: newMember.deviceId,
      displayName: newMember.displayName,
    );

    final peerId = _groupPeerId(groupId, newMember.deviceId);
    try {
      _updateMemberState(
          groupId, newMember.deviceId, PeerConnectionState.connecting);
      await _adapter.connectToPeer(peerId);
    } catch (e) {
      logger.error('GroupConnectionService',
          'Failed to connect to new member ${newMember.deviceId}', e);
      _updateMemberState(
          groupId, newMember.deviceId, PeerConnectionState.failed);
    }
  }

  /// Handle a member leaving the group.
  ///
  /// Disconnects from the member and cleans up tracking state.
  Future<void> handleMemberLeft(String groupId, String deviceId) async {
    final groupConns = _connections[groupId];
    if (groupConns == null) return;

    final peerId = _groupPeerId(groupId, deviceId);
    try {
      await _adapter.disconnectPeer(peerId);
    } catch (e) {
      logger.error('GroupConnectionService',
          'Failed to disconnect from departing member $deviceId', e);
    }

    _updateMemberState(groupId, deviceId, PeerConnectionState.disconnected);
    groupConns.remove(deviceId);
  }

  // ---------------------------------------------------------------------------
  // Data operations
  // ---------------------------------------------------------------------------

  /// Broadcast data to all connected members of a group.
  ///
  /// Returns the number of members the data was sent to.
  Future<int> broadcastToGroup(String groupId, Uint8List data) async {
    final groupConns = _connections[groupId];
    if (groupConns == null) return 0;

    int sentCount = 0;
    for (final entry in groupConns.entries) {
      if (entry.value.state == PeerConnectionState.connected) {
        final peerId = _groupPeerId(groupId, entry.key);
        try {
          await _adapter.sendData(peerId, data);
          sentCount++;
        } catch (e) {
          logger.error('GroupConnectionService',
              'Failed to send data to ${entry.key} in group $groupId', e);
        }
      }
    }
    return sentCount;
  }

  /// Send data to a specific member of a group.
  Future<void> sendToMember(
    String groupId,
    String deviceId,
    Uint8List data,
  ) async {
    final peerId = _groupPeerId(groupId, deviceId);
    await _adapter.sendData(peerId, data);
  }

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  /// Get connection states for all members in a group.
  Map<String, MemberConnection> getGroupConnections(String groupId) {
    return Map.unmodifiable(_connections[groupId] ?? {});
  }

  /// Get connection state for a specific member in a group.
  MemberConnection? getMemberConnection(String groupId, String deviceId) {
    return _connections[groupId]?[deviceId];
  }

  /// Get all connected member device IDs for a group.
  List<String> getConnectedMembers(String groupId) {
    final groupConns = _connections[groupId];
    if (groupConns == null) return [];

    return groupConns.entries
        .where((e) => e.value.state == PeerConnectionState.connected)
        .map((e) => e.key)
        .toList();
  }

  /// Get the number of connected members for a group.
  int getConnectedMemberCount(String groupId) {
    return getConnectedMembers(groupId).length;
  }

  /// Check if all members of a group are connected.
  bool isFullyConnected(String groupId) {
    final groupConns = _connections[groupId];
    if (groupConns == null || groupConns.isEmpty) return false;

    return groupConns.values
        .every((c) => c.state == PeerConnectionState.connected);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /// Create a unique peer ID for a group member connection.
  ///
  /// Namespaces the peer ID with the group ID to avoid collisions
  /// when the same device is in multiple groups, and to distinguish
  /// group connections from 1:1 connections.
  String _groupPeerId(String groupId, String deviceId) {
    return 'group_${groupId}_$deviceId';
  }

  /// Extract the group ID and device ID from a namespaced peer ID.
  ///
  /// Returns null if the peer ID is not a group connection.
  ({String groupId, String deviceId})? _parseGroupPeerId(String peerId) {
    if (!peerId.startsWith('group_')) return null;

    // Format: group_{groupId}_{deviceId}
    // We look up the groupId against our active groups to parse reliably,
    // since group IDs may vary in length.
    final withoutPrefix = peerId.substring(6); // Remove 'group_'

    // Try each active group to find a match
    for (final groupId in _activeGroups) {
      final expectedPrefix = '${groupId}_';
      if (withoutPrefix.startsWith(expectedPrefix)) {
        final deviceId = withoutPrefix.substring(expectedPrefix.length);
        if (deviceId.isNotEmpty) {
          return (groupId: groupId, deviceId: deviceId);
        }
      }
    }

    // Also check _connections for groups that were just deactivated
    // but may still have pending events
    for (final groupId in _connections.keys) {
      final expectedPrefix = '${groupId}_';
      if (withoutPrefix.startsWith(expectedPrefix)) {
        final deviceId = withoutPrefix.substring(expectedPrefix.length);
        if (deviceId.isNotEmpty) {
          return (groupId: groupId, deviceId: deviceId);
        }
      }
    }

    return null;
  }

  void _handleConnectionStateChange(
      String peerId, PeerConnectionState newState) {
    final parsed = _parseGroupPeerId(peerId);
    if (parsed == null) return; // Not a group connection

    final groupId = parsed.groupId;
    final deviceId = parsed.deviceId;

    if (!_activeGroups.contains(groupId)) return;

    _updateMemberState(groupId, deviceId, newState);
  }

  void _handleIncomingData(String peerId, Uint8List data) {
    final parsed = _parseGroupPeerId(peerId);
    if (parsed == null) return; // Not a group connection

    final groupId = parsed.groupId;
    final deviceId = parsed.deviceId;

    if (!_activeGroups.contains(groupId)) return;

    _dataEventController.add(GroupDataEvent(
      groupId: groupId,
      fromDeviceId: deviceId,
      data: data,
    ));
  }

  void _updateMemberState(
    String groupId,
    String deviceId,
    PeerConnectionState newState,
  ) {
    final groupConns = _connections[groupId];
    if (groupConns == null) return;

    final member = groupConns[deviceId];
    if (member == null) return;

    final oldState = member.state;
    if (oldState == newState) return;

    member.state = newState;
    member.lastStateChange = DateTime.now();

    _connectionEventController.add(GroupConnectionEvent(
      groupId: groupId,
      deviceId: deviceId,
      oldState: oldState,
      newState: newState,
    ));
  }
}
