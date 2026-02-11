import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers/app_providers.dart';
import '../models/channel.dart';
import '../services/admin_management_service.dart';
import '../services/background_sync_service.dart';
import '../services/channel_crypto_service.dart';
import '../services/channel_service.dart';
import '../services/channel_storage_service.dart';
import '../services/channel_sync_service.dart';
import '../services/routing_hash_service.dart';
import '../services/upstream_service.dart';
import '../services/poll_service.dart';
import '../services/live_stream_service.dart';

/// Provider for the channel crypto service (stateless, no initialization needed).
final channelCryptoServiceProvider = Provider<ChannelCryptoService>((ref) {
  return ChannelCryptoService();
});

/// Provider for the channel storage service.
///
/// Requires [initialize] to be called before use (typically at app startup).
final channelStorageServiceProvider = Provider<ChannelStorageService>((ref) {
  final service = ChannelStorageService();
  ref.onDispose(() => service.close());
  return service;
});

/// Provider for the channel service (orchestrates crypto + storage).
final channelServiceProvider = Provider<ChannelService>((ref) {
  final cryptoService = ref.watch(channelCryptoServiceProvider);
  final storageService = ref.watch(channelStorageServiceProvider);
  return ChannelService(
    cryptoService: cryptoService,
    storageService: storageService,
  );
});

/// Provider for the admin management service.
///
/// Provides admin permission management, channel rules, and encryption key rotation.
final adminManagementServiceProvider = Provider<AdminManagementService>((ref) {
  final cryptoService = ref.watch(channelCryptoServiceProvider);
  final storageService = ref.watch(channelStorageServiceProvider);
  return AdminManagementService(
    cryptoService: cryptoService,
    storageService: storageService,
  );
});

/// Provider for all channels (owned + subscribed).
///
/// This is a [FutureProvider] that loads channels from storage.
/// Invalidate it after channel creation/deletion to refresh the list.
final channelsProvider = FutureProvider<List<Channel>>((ref) async {
  final service = ref.watch(channelServiceProvider);
  return service.getAllChannels();
});

/// Provider for a single channel by ID.
final channelByIdProvider =
    FutureProvider.family<Channel?, String>((ref, channelId) async {
  final service = ref.watch(channelServiceProvider);
  return service.getChannel(channelId);
});

/// Provider for owned channels only.
final ownedChannelsProvider = FutureProvider<List<Channel>>((ref) async {
  final channels = await ref.watch(channelsProvider.future);
  return channels.where((c) => c.role == ChannelRole.owner).toList();
});

/// Provider for subscribed channels only.
final subscribedChannelsProvider = FutureProvider<List<Channel>>((ref) async {
  final channels = await ref.watch(channelsProvider.future);
  return channels.where((c) => c.role == ChannelRole.subscriber).toList();
});

/// Provider for the channel sync service.
///
/// Uses the signaling client's send function when connected, or a no-op
/// when disconnected. The peer ID comes from [pairingCodeProvider].
final channelSyncServiceProvider = Provider<ChannelSyncService>((ref) {
  final storageService = ref.watch(channelStorageServiceProvider);
  final signalingClient = ref.watch(signalingClientProvider);
  final pairingCode = ref.watch(pairingCodeProvider);

  // Build a send function: use the signaling client if connected,
  // otherwise silently drop messages (sync will retry on next interval).
  void sendMessage(Map<String, dynamic> message) {
    signalingClient?.send(message);
  }

  final service = ChannelSyncService(
    storageService: storageService,
    sendMessage: sendMessage,
    peerId: pairingCode ?? '',
  );

  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for the upstream service (handles subscriber -> owner messaging).
final upstreamServiceProvider = Provider<UpstreamService>((ref) {
  return UpstreamService();
});

/// Provider for the poll service (poll creation, voting, and tallying).
final pollServiceProvider = Provider<PollService>((ref) {
  final channelService = ref.watch(channelServiceProvider);
  final upstreamService = ref.watch(upstreamServiceProvider);
  return PollService(
    channelService: channelService,
    upstreamService: upstreamService,
  );
});

/// Provider for the live stream service.
final liveStreamServiceProvider = Provider<LiveStreamService>((ref) {
  final cryptoService = ref.watch(channelCryptoServiceProvider);
  final channelService = ref.watch(channelServiceProvider);
  return LiveStreamService(
    cryptoService: cryptoService,
    channelService: channelService,
  );
});

/// Provider for the routing hash service.
final routingHashServiceProvider = Provider<RoutingHashService>((ref) {
  return RoutingHashService();
});

/// Provider for the background sync service.
///
/// Handles periodic synchronization of channel chunks in the background.
/// On mobile, registers with platform background task schedulers.
/// On desktop/web, uses a foreground timer.
final backgroundSyncServiceProvider = Provider<BackgroundSyncService>((ref) {
  final storageService = ref.watch(channelStorageServiceProvider);
  final routingHashService = ref.watch(routingHashServiceProvider);
  final channelSyncService = ref.watch(channelSyncServiceProvider);

  final service = BackgroundSyncService(
    storageService: storageService,
    routingHashService: routingHashService,
  );

  // Wire up the channel sync service for chunk downloads
  service.setChannelSyncService(channelSyncService);

  ref.onDispose(() => service.dispose());
  return service;
});
