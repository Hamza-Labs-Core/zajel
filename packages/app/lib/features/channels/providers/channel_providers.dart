import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/signaling_client.dart'
    show SignalingConnectionState;
import '../../../core/providers/app_providers.dart';
import '../models/channel.dart';
import '../models/chunk.dart';
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

  // Wire up chunk received callback: parse, store, and re-announce for seeding.
  service.onChunkReceived = (chunkId, data) async {
    try {
      final channelId = data.remove('_channelId') as String?;
      if (channelId == null) return;

      final chunk = Chunk.fromJson(data);
      await storageService.saveChunk(channelId, chunk);

      // Re-announce so we become a seeder for this chunk
      service.announceChunk(chunk, channelId: channelId);

      // Invalidate the messages provider so UI refreshes
      ref.invalidate(channelMessagesProvider(channelId));
    } catch (_) {
      // Skip malformed chunks — don't crash the sync loop
    }
  };

  // Wire up chunk message stream from the signaling client so the
  // sync service can react to incoming chunk_data, chunk_pull, etc.
  StreamSubscription? connectionSub;
  if (signalingClient != null) {
    service.start(signalingClient.chunkMessages);

    // Register channels when the WebSocket is fully connected, and
    // re-register on every reconnect. This avoids the race condition
    // where send() silently drops messages before the connection is ready.
    if (signalingClient.isConnected) {
      _registerChannelsWithVps(storageService, sendMessage);
    }
    connectionSub = signalingClient.connectionState.listen((state) {
      if (state == SignalingConnectionState.connected) {
        _registerChannelsWithVps(storageService, sendMessage);
      }
    });
  }

  ref.onDispose(() {
    connectionSub?.cancel();
    service.dispose();
  });
  return service;
});

/// Send channel-owner-register / channel-subscribe for all local channels.
Future<void> _registerChannelsWithVps(
  ChannelStorageService storageService,
  void Function(Map<String, dynamic>) sendMessage,
) async {
  try {
    final channels = await storageService.getAllChannels();
    for (final channel in channels) {
      if (channel.role == ChannelRole.owner) {
        sendMessage({
          'type': 'channel-owner-register',
          'channelId': channel.id,
        });
      } else {
        sendMessage({
          'type': 'channel-subscribe',
          'channelId': channel.id,
        });
      }
    }
  } catch (_) {
    // Non-fatal: registration will be retried on next reconnect
  }
}

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

/// Provider for the currently selected channel ID (for split-view layout).
final selectedChannelIdProvider = StateProvider<String?>((ref) => null);

/// A single displayable message decoded from channel chunks.
class ChannelMessage {
  final int sequence;
  final ContentType type;
  final String text;
  final DateTime timestamp;
  final String? author;

  const ChannelMessage({
    required this.sequence,
    required this.type,
    required this.text,
    required this.timestamp,
    this.author,
  });
}

/// Provider for channel messages (decrypted chunks) for a specific channel.
///
/// Fetches all chunks from storage, groups by sequence, reassembles and
/// decrypts each group into a displayable [ChannelMessage].
/// Invalidate this provider after publishing to refresh the list.
final channelMessagesProvider =
    FutureProvider.family<List<ChannelMessage>, String>((ref, channelId) async {
  final storageService = ref.watch(channelStorageServiceProvider);
  final channelService = ref.watch(channelServiceProvider);
  final cryptoService = ref.watch(channelCryptoServiceProvider);

  // Get the channel to access the encryption key
  final channel = await channelService.getChannel(channelId);
  if (channel == null) return [];

  final encryptionKey = channel.encryptionKeyPrivate;
  if (encryptionKey == null) return [];

  // Fetch all chunks for this channel
  final allChunks = await storageService.getAllChunksForChannel(channelId);
  if (allChunks.isEmpty) return [];

  // Group by sequence number
  final grouped = <int, List<Chunk>>{};
  for (final chunk in allChunks) {
    grouped.putIfAbsent(chunk.sequence, () => []).add(chunk);
  }

  // Decrypt each sequence group
  final messages = <ChannelMessage>[];
  for (final entry in grouped.entries.toList()
    ..sort((a, b) => a.key.compareTo(b.key))) {
    try {
      final chunks = entry.value;
      // Skip incomplete sequences
      if (chunks.length != chunks.first.totalChunks) continue;

      final encryptedBytes = channelService.reassembleChunks(chunks);
      final payload = await cryptoService.decryptPayload(
        encryptedBytes,
        encryptionKey,
        channel.manifest.keyEpoch,
      );

      messages.add(ChannelMessage(
        sequence: entry.key,
        type: payload.type,
        text: payload.type == ContentType.text
            ? utf8.decode(payload.payload)
            : '[${payload.type.name}]',
        timestamp: payload.timestamp,
        author: payload.author,
      ));
    } catch (_) {
      // Skip corrupted or unreadable messages
    }
  }

  return messages;
});
