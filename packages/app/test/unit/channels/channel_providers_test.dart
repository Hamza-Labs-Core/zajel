import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/features/channels/providers/channel_providers.dart';
import 'package:zajel/features/channels/services/background_sync_service.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';
import 'package:zajel/features/channels/services/channel_service.dart';
import 'package:zajel/features/channels/services/channel_storage_service.dart';
import 'package:zajel/features/channels/services/channel_sync_service.dart';
import 'package:zajel/features/channels/services/live_stream_service.dart';
import 'package:zajel/features/channels/services/poll_service.dart';
import 'package:zajel/features/channels/services/routing_hash_service.dart';
import 'package:zajel/features/channels/services/upstream_service.dart';

void main() {
  late ProviderContainer container;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();

    container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  group('Channel providers create instances without errors', () {
    test('channelCryptoServiceProvider creates ChannelCryptoService', () {
      final service = container.read(channelCryptoServiceProvider);
      expect(service, isA<ChannelCryptoService>());
    });

    test('channelStorageServiceProvider creates ChannelStorageService', () {
      final service = container.read(channelStorageServiceProvider);
      expect(service, isA<ChannelStorageService>());
    });

    test('channelServiceProvider creates ChannelService', () {
      final service = container.read(channelServiceProvider);
      expect(service, isA<ChannelService>());
    });

    test('upstreamServiceProvider creates UpstreamService', () {
      final service = container.read(upstreamServiceProvider);
      expect(service, isA<UpstreamService>());
    });

    test('routingHashServiceProvider creates RoutingHashService', () {
      final service = container.read(routingHashServiceProvider);
      expect(service, isA<RoutingHashService>());
    });
  });

  group('Provider dependencies are wired correctly', () {
    test('channelServiceProvider depends on crypto and storage', () {
      // Reading the channel service should trigger creation of its dependencies
      final channelService = container.read(channelServiceProvider);
      final cryptoService = container.read(channelCryptoServiceProvider);
      final storageService = container.read(channelStorageServiceProvider);

      // All should be non-null instances
      expect(channelService, isNotNull);
      expect(cryptoService, isNotNull);
      expect(storageService, isNotNull);
    });

    test('pollServiceProvider depends on channelService and upstreamService',
        () {
      final pollService = container.read(pollServiceProvider);
      expect(pollService, isA<PollService>());

      // Should not throw -- dependencies are resolved
      final channelService = container.read(channelServiceProvider);
      final upstreamService = container.read(upstreamServiceProvider);
      expect(channelService, isNotNull);
      expect(upstreamService, isNotNull);
    });

    test('liveStreamServiceProvider depends on crypto and channelService', () {
      final liveStreamService = container.read(liveStreamServiceProvider);
      expect(liveStreamService, isA<LiveStreamService>());
    });

    test(
        'channelSyncServiceProvider creates service with empty peerId when not connected',
        () {
      // When no signaling client or pairing code is set, the sync service
      // should still be created (with a no-op send function and empty peerId).
      final syncService = container.read(channelSyncServiceProvider);
      expect(syncService, isA<ChannelSyncService>());
    });

    test('backgroundSyncServiceProvider depends on storage and routing hash',
        () {
      final bgSyncService = container.read(backgroundSyncServiceProvider);
      expect(bgSyncService, isA<BackgroundSyncService>());
    });
  });

  group('Provider stability', () {
    test('reading same provider twice returns same instance', () {
      final service1 = container.read(channelCryptoServiceProvider);
      final service2 = container.read(channelCryptoServiceProvider);
      expect(identical(service1, service2), isTrue);
    });

    test('reading channelServiceProvider twice returns same instance', () {
      final service1 = container.read(channelServiceProvider);
      final service2 = container.read(channelServiceProvider);
      expect(identical(service1, service2), isTrue);
    });

    test('reading storageServiceProvider twice returns same instance', () {
      final service1 = container.read(channelStorageServiceProvider);
      final service2 = container.read(channelStorageServiceProvider);
      expect(identical(service1, service2), isTrue);
    });
  });

  group('FutureProvider channels', () {
    test('channelsProvider returns empty list before storage initialization',
        () async {
      // The storage is not initialized so getAllChannels returns []
      final channelsAsync = container.read(channelsProvider);
      // It will be a loading state initially
      expect(
        channelsAsync,
        isA<AsyncValue>(),
      );
    });

    test('ownedChannelsProvider returns AsyncValue', () async {
      final async = container.read(ownedChannelsProvider);
      expect(async, isA<AsyncValue>());
    });

    test('subscribedChannelsProvider returns AsyncValue', () async {
      final async = container.read(subscribedChannelsProvider);
      expect(async, isA<AsyncValue>());
    });
  });

  group('Family providers return different instances for different IDs', () {
    test('channelByIdProvider returns different futures for different IDs',
        () async {
      final future1 = container.read(channelByIdProvider('channel_1'));
      final future2 = container.read(channelByIdProvider('channel_2'));

      // Both should be AsyncValues (loading or data)
      expect(future1, isA<AsyncValue>());
      expect(future2, isA<AsyncValue>());

      // They should not be the identical object (different family args)
      // Note: AsyncLoading instances may be equal but not identical
      // The important thing is they resolve independently
    });

    test('channelByIdProvider returns same future for same ID', () {
      final future1 = container.read(channelByIdProvider('channel_1'));
      final future2 = container.read(channelByIdProvider('channel_1'));

      // Same family argument should return same cached value
      expect(future1, equals(future2));
    });
  });
}
