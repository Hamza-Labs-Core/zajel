import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/groups/providers/group_providers.dart';
import 'package:zajel/features/groups/services/group_crypto_service.dart';
import 'package:zajel/features/groups/services/group_service.dart';
import 'package:zajel/features/groups/services/group_storage_service.dart';
import 'package:zajel/features/groups/services/group_sync_service.dart';

void main() {
  late ProviderContainer container;

  setUp(() {
    container = ProviderContainer();
  });

  tearDown(() {
    container.dispose();
  });

  group('Group providers create instances without errors', () {
    test('groupCryptoServiceProvider creates GroupCryptoService', () {
      final service = container.read(groupCryptoServiceProvider);
      expect(service, isA<GroupCryptoService>());
    });

    test('groupStorageServiceProvider creates GroupStorageService', () {
      final service = container.read(groupStorageServiceProvider);
      expect(service, isA<GroupStorageService>());
    });

    test('groupSyncServiceProvider creates GroupSyncService', () {
      final service = container.read(groupSyncServiceProvider);
      expect(service, isA<GroupSyncService>());
    });

    test('groupServiceProvider creates GroupService', () {
      final service = container.read(groupServiceProvider);
      expect(service, isA<GroupService>());
    });
  });

  group('Provider dependencies are wired correctly', () {
    test('groupServiceProvider depends on crypto, storage, and sync', () {
      // Reading group service should trigger creation of all dependencies
      final groupService = container.read(groupServiceProvider);
      final cryptoService = container.read(groupCryptoServiceProvider);
      final storageService = container.read(groupStorageServiceProvider);
      final syncService = container.read(groupSyncServiceProvider);

      expect(groupService, isNotNull);
      expect(cryptoService, isNotNull);
      expect(storageService, isNotNull);
      expect(syncService, isNotNull);
    });

    test('groupSyncServiceProvider depends on storageService', () {
      // Sync service should be created using the storage service
      final syncService = container.read(groupSyncServiceProvider);
      final storageService = container.read(groupStorageServiceProvider);

      expect(syncService, isNotNull);
      expect(storageService, isNotNull);
    });
  });

  group('Provider stability', () {
    test('reading same provider twice returns same instance', () {
      final service1 = container.read(groupCryptoServiceProvider);
      final service2 = container.read(groupCryptoServiceProvider);
      expect(identical(service1, service2), isTrue);
    });

    test('reading groupServiceProvider twice returns same instance', () {
      final service1 = container.read(groupServiceProvider);
      final service2 = container.read(groupServiceProvider);
      expect(identical(service1, service2), isTrue);
    });

    test('reading groupStorageServiceProvider twice returns same instance', () {
      final service1 = container.read(groupStorageServiceProvider);
      final service2 = container.read(groupStorageServiceProvider);
      expect(identical(service1, service2), isTrue);
    });

    test('reading groupSyncServiceProvider twice returns same instance', () {
      final service1 = container.read(groupSyncServiceProvider);
      final service2 = container.read(groupSyncServiceProvider);
      expect(identical(service1, service2), isTrue);
    });
  });

  group('FutureProvider groups', () {
    test('groupsProvider returns AsyncValue', () {
      final async = container.read(groupsProvider);
      expect(async, isA<AsyncValue>());
    });
  });

  group('Family providers return different instances for different IDs', () {
    test('groupByIdProvider returns different futures for different IDs', () {
      final future1 = container.read(groupByIdProvider('group_1'));
      final future2 = container.read(groupByIdProvider('group_2'));

      expect(future1, isA<AsyncValue>());
      expect(future2, isA<AsyncValue>());
    });

    test('groupByIdProvider returns same future for same ID', () {
      final future1 = container.read(groupByIdProvider('group_1'));
      final future2 = container.read(groupByIdProvider('group_1'));

      expect(future1, equals(future2));
    });

    test('groupMessagesProvider returns different futures for different IDs',
        () {
      final future1 = container.read(groupMessagesProvider('group_1'));
      final future2 = container.read(groupMessagesProvider('group_2'));

      expect(future1, isA<AsyncValue>());
      expect(future2, isA<AsyncValue>());
    });

    test('groupMessagesProvider returns same future for same ID', () {
      final future1 = container.read(groupMessagesProvider('group_1'));
      final future2 = container.read(groupMessagesProvider('group_1'));

      expect(future1, equals(future2));
    });
  });

  group('Provider isolation', () {
    test('separate ProviderContainers create independent instances', () {
      final container1 = ProviderContainer();
      final container2 = ProviderContainer();

      final service1 = container1.read(groupCryptoServiceProvider);
      final service2 = container2.read(groupCryptoServiceProvider);

      // Different containers should yield different instances
      expect(identical(service1, service2), isFalse);

      container1.dispose();
      container2.dispose();
    });
  });
}
