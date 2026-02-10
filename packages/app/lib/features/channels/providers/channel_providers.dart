import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/channel.dart';
import '../services/channel_crypto_service.dart';
import '../services/channel_service.dart';
import '../services/channel_storage_service.dart';

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
