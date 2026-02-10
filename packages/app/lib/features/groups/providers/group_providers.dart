import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/group.dart';
import '../models/group_message.dart';
import '../services/group_crypto_service.dart';
import '../services/group_service.dart';
import '../services/group_storage_service.dart';
import '../services/group_sync_service.dart';

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
