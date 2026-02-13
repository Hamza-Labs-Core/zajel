import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers/app_providers.dart';
import '../models/group.dart';
import '../models/group_message.dart';
import '../services/group_connection_service.dart';
import '../services/group_crypto_service.dart';
import '../services/group_invitation_service.dart';
import '../services/group_service.dart';
import '../services/group_storage_service.dart';
import '../services/group_sync_service.dart';
import '../services/webrtc_p2p_adapter.dart';

/// Provider for the group crypto service (stateless, no initialization needed).
final groupCryptoServiceProvider = Provider<GroupCryptoService>((ref) {
  return GroupCryptoService();
});

/// Provider for the group storage service.
///
/// Requires [initialize] to be called before use (typically at app startup).
final groupStorageServiceProvider = Provider<GroupStorageService>((ref) {
  final service = GroupStorageService();
  ref.onDispose(() => service.close());
  return service;
});

/// Provider for the group sync service.
final groupSyncServiceProvider = Provider<GroupSyncService>((ref) {
  final storageService = ref.watch(groupStorageServiceProvider);
  return GroupSyncService(storageService: storageService);
});

/// Provider for the group service (orchestrates crypto + storage + sync).
final groupServiceProvider = Provider<GroupService>((ref) {
  final cryptoService = ref.watch(groupCryptoServiceProvider);
  final storageService = ref.watch(groupStorageServiceProvider);
  final syncService = ref.watch(groupSyncServiceProvider);
  return GroupService(
    cryptoService: cryptoService,
    storageService: storageService,
    syncService: syncService,
  );
});

/// Provider for the P2P connection adapter.
///
/// Bridges the abstract [P2PConnectionAdapter] interface to the real
/// [ConnectionManager] and [WebRTCService] via [WebRtcP2PAdapter].
final p2pConnectionAdapterProvider = Provider<P2PConnectionAdapter>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  final webrtcService = ref.watch(webrtcServiceProvider);
  final adapter = WebRtcP2PAdapter(
    connectionManager: connectionManager,
    webrtcService: webrtcService,
  );
  ref.onDispose(() => adapter.dispose());
  return adapter;
});

/// Provider for the group connection service (mesh WebRTC connections).
///
/// Manages P2P connections to all members of active groups.
final groupConnectionServiceProvider = Provider<GroupConnectionService>((ref) {
  final adapter = ref.watch(p2pConnectionAdapterProvider);
  final service = GroupConnectionService(adapter: adapter);
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for the group invitation service.
///
/// Handles sending and receiving group invitations over existing 1:1
/// WebRTC data channels. Starts listening automatically.
final groupInvitationServiceProvider = Provider<GroupInvitationService>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  final groupService = ref.watch(groupServiceProvider);
  final cryptoService = ref.watch(groupCryptoServiceProvider);
  final pairingCode = ref.watch(pairingCodeProvider) ?? '';

  final service = GroupInvitationService(
    connectionManager: connectionManager,
    groupService: groupService,
    cryptoService: cryptoService,
    selfDeviceId: pairingCode,
  );

  // Wire up the callback: when a group invitation is received and accepted,
  // refresh the groups list so the UI picks it up.
  service.onGroupJoined = (group) {
    ref.invalidate(groupsProvider);
  };

  // Wire up the callback: when a group message arrives over a 1:1 channel,
  // refresh that group's messages so the UI picks it up.
  service.onGroupMessageReceived = (groupId, message) {
    ref.invalidate(groupMessagesProvider(groupId));
  };

  // Start listening for incoming invitations and group messages
  service.start();

  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for all groups.
///
/// This is a [FutureProvider] that loads groups from storage.
/// Invalidate it after group creation/deletion to refresh the list.
final groupsProvider = FutureProvider<List<Group>>((ref) async {
  final service = ref.watch(groupServiceProvider);
  return service.getAllGroups();
});

/// Provider for a single group by ID.
final groupByIdProvider =
    FutureProvider.family<Group?, String>((ref, groupId) async {
  final service = ref.watch(groupServiceProvider);
  return service.getGroup(groupId);
});

/// Provider for messages in a group.
///
/// Returns the latest 50 messages by default.
final groupMessagesProvider =
    FutureProvider.family<List<GroupMessage>, String>((ref, groupId) async {
  final service = ref.watch(groupServiceProvider);
  return service.getLatestMessages(groupId);
});
