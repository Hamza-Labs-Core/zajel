import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';
import 'package:zajel/features/channels/services/routing_hash_service.dart';

void main() {
  late RoutingHashService routingHashService;
  late ChannelCryptoService cryptoService;

  setUp(() {
    routingHashService = RoutingHashService();
    cryptoService = ChannelCryptoService();
  });

  group('Routing hash derivation', () {
    late String channelSecret;

    setUp(() async {
      final keys = await cryptoService.generateEncryptionKeyPair();
      channelSecret = keys.privateKey;
    });

    test('deriveRoutingHash produces a 32-char hex string', () async {
      final hash = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        now: DateTime.utc(2026, 2, 10, 12, 0),
      );

      expect(hash.length, 32);
      expect(RegExp(r'^[0-9a-f]{32}$').hasMatch(hash), isTrue);
    });

    test('same secret and time produce same hash (deterministic)', () async {
      final time = DateTime.utc(2026, 2, 10, 12, 0);

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        now: time,
      );
      final hash2 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        now: time,
      );

      expect(hash1, hash2);
    });

    test('same secret, same hour produce same hash (hourly epoch)', () async {
      final time1 = DateTime.utc(2026, 2, 10, 12, 0, 0);
      final time2 = DateTime.utc(2026, 2, 10, 12, 30, 0);
      final time3 = DateTime.utc(2026, 2, 10, 12, 59, 59);

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time1,
      );
      final hash2 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time2,
      );
      final hash3 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time3,
      );

      expect(hash1, hash2);
      expect(hash2, hash3);
    });

    test('different hours produce different hashes (hourly epoch)', () async {
      final time1 = DateTime.utc(2026, 2, 10, 12, 0);
      final time2 = DateTime.utc(2026, 2, 10, 13, 0);

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time1,
      );
      final hash2 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time2,
      );

      expect(hash1, isNot(hash2));
    });

    test('same day produce same hash (daily epoch)', () async {
      final time1 = DateTime.utc(2026, 2, 10, 0, 0, 0);
      final time2 = DateTime.utc(2026, 2, 10, 12, 0, 0);
      final time3 = DateTime.utc(2026, 2, 10, 23, 59, 59);

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.daily,
        now: time1,
      );
      final hash2 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.daily,
        now: time2,
      );
      final hash3 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.daily,
        now: time3,
      );

      expect(hash1, hash2);
      expect(hash2, hash3);
    });

    test('different days produce different hashes (daily epoch)', () async {
      final time1 = DateTime.utc(2026, 2, 10, 12, 0);
      final time2 = DateTime.utc(2026, 2, 11, 12, 0);

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.daily,
        now: time1,
      );
      final hash2 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.daily,
        now: time2,
      );

      expect(hash1, isNot(hash2));
    });

    test('different secrets produce different hashes', () async {
      final keys2 = await cryptoService.generateEncryptionKeyPair();
      final time = DateTime.utc(2026, 2, 10, 12, 0);

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        now: time,
      );
      final hash2 = await routingHashService.deriveRoutingHash(
        channelSecret: keys2.privateKey,
        now: time,
      );

      expect(hash1, isNot(hash2));
    });

    test('invalid base64 secret throws RoutingHashException', () async {
      expect(
        () => routingHashService.deriveRoutingHash(
          channelSecret: 'not-valid-base64!!!',
          now: DateTime.utc(2026, 2, 10),
        ),
        throwsA(isA<RoutingHashException>().having(
          (e) => e.message,
          'message',
          contains('Invalid base64'),
        )),
      );
    });

    test('subscriber derives same hash as owner', () async {
      // Both owner and subscriber share the same channel secret
      final time = DateTime.utc(2026, 2, 10, 14, 30);

      // Owner derives
      final ownerHash = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        now: time,
      );

      // Subscriber derives (same secret)
      final subscriberHash = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        now: time,
      );

      expect(ownerHash, subscriberHash);
    });
  });

  group('Epoch-specific routing hash', () {
    late String channelSecret;

    setUp(() async {
      final keys = await cryptoService.generateEncryptionKeyPair();
      channelSecret = keys.privateKey;
    });

    test('deriveRoutingHashForEpoch produces consistent results', () async {
      final hash1 = await routingHashService.deriveRoutingHashForEpoch(
        channelSecret: channelSecret,
        epochNumber: 42,
      );
      final hash2 = await routingHashService.deriveRoutingHashForEpoch(
        channelSecret: channelSecret,
        epochNumber: 42,
      );

      expect(hash1, hash2);
      expect(hash1.length, 32);
    });

    test('different epoch numbers produce different hashes', () async {
      final hash1 = await routingHashService.deriveRoutingHashForEpoch(
        channelSecret: channelSecret,
        epochNumber: 1,
      );
      final hash2 = await routingHashService.deriveRoutingHashForEpoch(
        channelSecret: channelSecret,
        epochNumber: 2,
      );

      expect(hash1, isNot(hash2));
    });

    test('deriveRoutingHash matches deriveRoutingHashForEpoch for same epoch',
        () async {
      final time = DateTime.utc(2026, 2, 10, 12, 0);
      final epochNumber = routingHashService.getCurrentEpochNumber(
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time,
      );

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: channelSecret,
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time,
      );
      final hash2 = await routingHashService.deriveRoutingHashForEpoch(
        channelSecret: channelSecret,
        epochNumber: epochNumber,
        epochDuration: RoutingHashEpochDuration.hourly,
      );

      expect(hash1, hash2);
    });
  });

  group('Epoch number calculation', () {
    test('getCurrentEpochNumber is deterministic for same time', () {
      final time = DateTime.utc(2026, 2, 10, 12, 0);

      final epoch1 = routingHashService.getCurrentEpochNumber(
        now: time,
      );
      final epoch2 = routingHashService.getCurrentEpochNumber(
        now: time,
      );

      expect(epoch1, epoch2);
    });

    test('hourly epoch increments every hour', () {
      final time1 = DateTime.utc(2026, 2, 10, 12, 0);
      final time2 = DateTime.utc(2026, 2, 10, 13, 0);

      final epoch1 = routingHashService.getCurrentEpochNumber(
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time1,
      );
      final epoch2 = routingHashService.getCurrentEpochNumber(
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time2,
      );

      expect(epoch2, epoch1 + 1);
    });

    test('daily epoch increments every day', () {
      final time1 = DateTime.utc(2026, 2, 10, 12, 0);
      final time2 = DateTime.utc(2026, 2, 11, 12, 0);

      final epoch1 = routingHashService.getCurrentEpochNumber(
        epochDuration: RoutingHashEpochDuration.daily,
        now: time1,
      );
      final epoch2 = routingHashService.getCurrentEpochNumber(
        epochDuration: RoutingHashEpochDuration.daily,
        now: time2,
      );

      expect(epoch2, epoch1 + 1);
    });

    test('same hour gives same hourly epoch', () {
      final time1 = DateTime.utc(2026, 2, 10, 12, 0);
      final time2 = DateTime.utc(2026, 2, 10, 12, 45);

      final epoch1 = routingHashService.getCurrentEpochNumber(
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time1,
      );
      final epoch2 = routingHashService.getCurrentEpochNumber(
        epochDuration: RoutingHashEpochDuration.hourly,
        now: time2,
      );

      expect(epoch1, epoch2);
    });
  });

  group('Epoch range calculation', () {
    test('getEpochRange returns correct range for hourly epochs', () {
      final from = DateTime.utc(2026, 2, 10, 12, 0);
      final to = DateTime.utc(2026, 2, 10, 15, 0);

      final range = routingHashService.getEpochRange(
        fromTime: from,
        toTime: to,
        epochDuration: RoutingHashEpochDuration.hourly,
      );

      expect(range.length, 4); // 12, 13, 14, 15
      expect(
          range.first,
          routingHashService.getCurrentEpochNumber(
            epochDuration: RoutingHashEpochDuration.hourly,
            now: from,
          ));
      expect(
          range.last,
          routingHashService.getCurrentEpochNumber(
            epochDuration: RoutingHashEpochDuration.hourly,
            now: to,
          ));
    });

    test('getEpochRange returns single element for same epoch', () {
      final time = DateTime.utc(2026, 2, 10, 12, 0);

      final range = routingHashService.getEpochRange(
        fromTime: time,
        toTime: time,
        epochDuration: RoutingHashEpochDuration.hourly,
      );

      expect(range.length, 1);
    });

    test('getEpochRange works for daily epochs spanning multiple days', () {
      final from = DateTime.utc(2026, 2, 10);
      final to = DateTime.utc(2026, 2, 13);

      final range = routingHashService.getEpochRange(
        fromTime: from,
        toTime: to,
        epochDuration: RoutingHashEpochDuration.daily,
      );

      expect(range.length, 4); // 10, 11, 12, 13
    });
  });

  group('Censorship detection', () {
    test('detectCensorship returns none with no history', () {
      final result = routingHashService.detectCensorship(
        routingHash: 'hash_with_no_history',
      );

      expect(result.isCensored, isFalse);
      expect(result.type, CensorshipType.none);
    });

    test('detectCensorship detects routing hash blocking', () {
      // Add a VPS node that works for other things
      routingHashService.addNode('https://vps1.example.com');
      final node = routingHashService.knownNodes.first;
      node.successCount = 10; // VPS generally works

      // Record blocked results for a specific hash
      for (var i = 0; i < 3; i++) {
        routingHashService.recordFetchResult(
          routingHash: 'blocked_hash',
          vpsUrl: 'https://vps1.example.com',
          result: FetchResult.blocked,
        );
      }

      final result = routingHashService.detectCensorship(
        routingHash: 'blocked_hash',
      );

      expect(result.isCensored, isTrue);
      expect(result.type, CensorshipType.routingHashBlocked);
      expect(result.description, contains('vps1.example.com'));
    });

    test('detectCensorship detects widespread blocking', () {
      // Two VPS nodes that generally work
      routingHashService.addNode('https://vps1.example.com');
      routingHashService.addNode('https://vps2.example.com');
      for (final node in routingHashService.knownNodes) {
        node.successCount = 10;
      }

      // Both block the same hash
      for (var i = 0; i < 3; i++) {
        routingHashService.recordFetchResult(
          routingHash: 'censored_hash',
          vpsUrl: 'https://vps1.example.com',
          result: FetchResult.blocked,
        );
        routingHashService.recordFetchResult(
          routingHash: 'censored_hash',
          vpsUrl: 'https://vps2.example.com',
          result: FetchResult.blocked,
        );
      }

      final result = routingHashService.detectCensorship(
        routingHash: 'censored_hash',
      );

      expect(result.isCensored, isTrue);
      expect(result.type, CensorshipType.widespreadBlocking);
    });

    test('detectCensorship identifies network issues vs blocking', () {
      // Record only network errors
      for (var i = 0; i < 3; i++) {
        routingHashService.recordFetchResult(
          routingHash: 'network_issue_hash',
          vpsUrl: 'https://dead-vps.example.com',
          result: FetchResult.networkError,
        );
      }

      final result = routingHashService.detectCensorship(
        routingHash: 'network_issue_hash',
      );

      expect(result.isCensored, isFalse);
      expect(result.type, CensorshipType.nodeUnreachable);
    });

    test('detectCensorship returns none for successful fetches', () {
      routingHashService.addNode('https://vps1.example.com');

      for (var i = 0; i < 5; i++) {
        routingHashService.recordFetchResult(
          routingHash: 'ok_hash',
          vpsUrl: 'https://vps1.example.com',
          result: FetchResult.success,
        );
      }

      final result = routingHashService.detectCensorship(
        routingHash: 'ok_hash',
      );

      expect(result.isCensored, isFalse);
      expect(result.type, CensorshipType.none);
    });
  });

  group('VPS node management', () {
    test('addNode adds a new node', () {
      routingHashService.addNode('https://vps1.example.com');

      expect(routingHashService.knownNodes, hasLength(1));
      expect(
          routingHashService.knownNodes.first.url, 'https://vps1.example.com');
    });

    test('addNode ignores duplicate URLs', () {
      routingHashService.addNode('https://vps1.example.com');
      routingHashService.addNode('https://vps1.example.com');

      expect(routingHashService.knownNodes, hasLength(1));
    });

    test('removeNode removes a node', () {
      routingHashService.addNode('https://vps1.example.com');
      routingHashService.addNode('https://vps2.example.com');
      routingHashService.removeNode('https://vps1.example.com');

      expect(routingHashService.knownNodes, hasLength(1));
      expect(
          routingHashService.knownNodes.first.url, 'https://vps2.example.com');
    });

    test('knownNodes returns unmodifiable list', () {
      routingHashService.addNode('https://vps1.example.com');

      expect(
        () => routingHashService.knownNodes
            .add(VpsNodeHealth(url: 'https://hack.example.com')),
        throwsA(isA<UnsupportedError>()),
      );
    });
  });

  group('VPS node health tracking', () {
    test('recordFetchResult updates success count', () {
      routingHashService.addNode('https://vps1.example.com');

      routingHashService.recordFetchResult(
        routingHash: 'hash1',
        vpsUrl: 'https://vps1.example.com',
        result: FetchResult.success,
      );

      final node = routingHashService.knownNodes.first;
      expect(node.successCount, 1);
      expect(node.failureCount, 0);
      expect(node.lastSuccess, isNotNull);
      expect(node.suspectedBlocking, isFalse);
    });

    test('recordFetchResult updates failure count for blocked', () {
      routingHashService.addNode('https://vps1.example.com');

      routingHashService.recordFetchResult(
        routingHash: 'hash1',
        vpsUrl: 'https://vps1.example.com',
        result: FetchResult.blocked,
      );

      final node = routingHashService.knownNodes.first;
      expect(node.successCount, 0);
      expect(node.failureCount, 1);
      expect(node.lastFailure, isNotNull);
      expect(node.suspectedBlocking, isTrue);
    });

    test('recordFetchResult updates failure count for network error', () {
      routingHashService.addNode('https://vps1.example.com');

      routingHashService.recordFetchResult(
        routingHash: 'hash1',
        vpsUrl: 'https://vps1.example.com',
        result: FetchResult.networkError,
      );

      final node = routingHashService.knownNodes.first;
      expect(node.failureCount, 1);
      expect(node.suspectedBlocking, isFalse); // Network error, not blocking
    });

    test('success clears suspectedBlocking flag', () {
      routingHashService.addNode('https://vps1.example.com');

      // First block
      routingHashService.recordFetchResult(
        routingHash: 'hash1',
        vpsUrl: 'https://vps1.example.com',
        result: FetchResult.blocked,
      );
      expect(routingHashService.knownNodes.first.suspectedBlocking, isTrue);

      // Then success
      routingHashService.recordFetchResult(
        routingHash: 'hash2',
        vpsUrl: 'https://vps1.example.com',
        result: FetchResult.success,
      );
      expect(routingHashService.knownNodes.first.suspectedBlocking, isFalse);
    });

    test('successRate calculation', () {
      final health = VpsNodeHealth(url: 'test');
      expect(health.successRate, 1.0); // No attempts

      health.successCount = 7;
      health.failureCount = 3;
      expect(health.successRate, 0.7);

      health.successCount = 0;
      health.failureCount = 5;
      expect(health.successRate, 0.0);
    });
  });

  group('VPS node selection and fallback', () {
    test('getBestNode returns null when no nodes', () {
      expect(routingHashService.getBestNode(), isNull);
    });

    test('getBestNode prefers non-blocking node', () {
      routingHashService.addNode('https://blocked.example.com');
      routingHashService.addNode('https://good.example.com');

      // Mark first as blocking
      routingHashService.recordFetchResult(
        routingHash: 'h1',
        vpsUrl: 'https://blocked.example.com',
        result: FetchResult.blocked,
      );
      routingHashService.recordFetchResult(
        routingHash: 'h1',
        vpsUrl: 'https://good.example.com',
        result: FetchResult.success,
      );

      final best = routingHashService.getBestNode();
      expect(best, isNotNull);
      expect(best!.url, 'https://good.example.com');
    });

    test('getBestNode prefers higher success rate', () {
      routingHashService.addNode('https://good.example.com');
      routingHashService.addNode('https://mediocre.example.com');

      // Good node: 9 successes, 1 failure
      for (var i = 0; i < 9; i++) {
        routingHashService.recordFetchResult(
          routingHash: 'h$i',
          vpsUrl: 'https://good.example.com',
          result: FetchResult.success,
        );
      }
      routingHashService.recordFetchResult(
        routingHash: 'hf',
        vpsUrl: 'https://good.example.com',
        result: FetchResult.networkError,
      );

      // Mediocre node: 5 successes, 5 failures
      for (var i = 0; i < 5; i++) {
        routingHashService.recordFetchResult(
          routingHash: 'h$i',
          vpsUrl: 'https://mediocre.example.com',
          result: FetchResult.success,
        );
        routingHashService.recordFetchResult(
          routingHash: 'hf$i',
          vpsUrl: 'https://mediocre.example.com',
          result: FetchResult.networkError,
        );
      }

      final best = routingHashService.getBestNode();
      expect(best!.url, 'https://good.example.com');
    });

    test('getBestNode returns least-bad when all blocking', () {
      routingHashService.addNode('https://vps1.example.com');
      routingHashService.addNode('https://vps2.example.com');

      // Both blocking, but vps1 has some successes
      routingHashService.knownNodes[0]
        ..successCount = 3
        ..failureCount = 2
        ..suspectedBlocking = true;
      routingHashService.knownNodes[1]
        ..successCount = 1
        ..failureCount = 5
        ..suspectedBlocking = true;

      final best = routingHashService.getBestNode();
      expect(best!.url, 'https://vps1.example.com');
    });

    test('getNodeFallbackOrder puts non-blocking first', () {
      routingHashService.addNode('https://blocked.example.com');
      routingHashService.addNode('https://good.example.com');
      routingHashService.addNode('https://also-good.example.com');

      routingHashService.knownNodes[0].suspectedBlocking = true;
      routingHashService.knownNodes[1].successCount = 5;
      routingHashService.knownNodes[2].successCount = 3;

      final order = routingHashService.getNodeFallbackOrder();
      expect(order, hasLength(3));
      // Non-blocking nodes first, sorted by success rate
      expect(order[0].url, 'https://good.example.com');
      expect(order[1].url, 'https://also-good.example.com');
      // Blocking nodes last
      expect(order[2].url, 'https://blocked.example.com');
    });

    test('getNodeFallbackOrder returns empty when no nodes', () {
      expect(routingHashService.getNodeFallbackOrder(), isEmpty);
    });
  });

  group('Reset operations', () {
    test('resetNodeHealth clears all health data', () {
      routingHashService.addNode('https://vps1.example.com');
      routingHashService.knownNodes.first
        ..successCount = 10
        ..failureCount = 5
        ..suspectedBlocking = true
        ..lastSuccess = DateTime.now()
        ..lastFailure = DateTime.now();

      routingHashService.resetNodeHealth();

      final node = routingHashService.knownNodes.first;
      expect(node.successCount, 0);
      expect(node.failureCount, 0);
      expect(node.suspectedBlocking, isFalse);
      expect(node.lastSuccess, isNull);
      expect(node.lastFailure, isNull);
    });

    test('clearFetchHistory clears all history', () {
      routingHashService.recordFetchResult(
        routingHash: 'hash1',
        vpsUrl: 'https://vps1.example.com',
        result: FetchResult.success,
      );

      routingHashService.clearFetchHistory();

      // No history means no censorship detected
      final result = routingHashService.detectCensorship(
        routingHash: 'hash1',
      );
      expect(result.type, CensorshipType.none);
      expect(result.description, contains('No fetch history'));
    });
  });

  group('Auto-created nodes from fetch results', () {
    test('recordFetchResult auto-creates node for unknown URL', () {
      expect(routingHashService.knownNodes, isEmpty);

      routingHashService.recordFetchResult(
        routingHash: 'hash1',
        vpsUrl: 'https://new-vps.example.com',
        result: FetchResult.success,
      );

      expect(routingHashService.knownNodes, hasLength(1));
      expect(routingHashService.knownNodes.first.url,
          'https://new-vps.example.com');
      expect(routingHashService.knownNodes.first.successCount, 1);
    });
  });

  group('RoutingHashException', () {
    test('toString includes message', () {
      final ex = RoutingHashException('test error');
      expect(ex.toString(), 'RoutingHashException: test error');
    });
  });

  group('Integration: routing hash with channel keys', () {
    test('two subscribers with same key derive same routing hash', () async {
      // Simulate a real channel scenario
      final encKeys = await cryptoService.generateEncryptionKeyPair();
      final sharedSecret = encKeys.privateKey;
      final time = DateTime.utc(2026, 2, 10, 14, 0);

      // Owner derives hash
      final service1 = RoutingHashService();
      final hash1 = await service1.deriveRoutingHash(
        channelSecret: sharedSecret,
        now: time,
      );

      // Subscriber derives hash (different service instance, same secret)
      final service2 = RoutingHashService();
      final hash2 = await service2.deriveRoutingHash(
        channelSecret: sharedSecret,
        now: time,
      );

      expect(hash1, hash2);
    });

    test('routing hash changes after key rotation', () async {
      final keys1 = await cryptoService.generateEncryptionKeyPair();
      final keys2 = await cryptoService.generateEncryptionKeyPair();
      final time = DateTime.utc(2026, 2, 10, 14, 0);

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: keys1.privateKey,
        now: time,
      );
      final hash2 = await routingHashService.deriveRoutingHash(
        channelSecret: keys2.privateKey,
        now: time,
      );

      // Different key = different hash, even for the same epoch
      expect(hash1, isNot(hash2));
    });
  });
}
