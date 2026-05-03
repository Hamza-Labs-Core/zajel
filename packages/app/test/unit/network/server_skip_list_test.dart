import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/server_discovery_service.dart';
import 'package:zajel/core/network/server_skip_list.dart';

DiscoveredServer _server(String endpoint) => DiscoveredServer(
      serverId: 'ed25519:$endpoint',
      endpoint: endpoint,
      publicKey: 'pk-$endpoint',
      region: 'test',
      registeredAt: 0,
      lastSeen: 0,
    );

void main() {
  group('ServerSkipList', () {
    late DateTime now;
    late ServerSkipList skipList;

    setUp(() {
      now = DateTime(2026, 4, 21, 12, 0, 0);
      skipList = ServerSkipList(clock: () => now);
    });

    test('is initially empty — nothing is skipped', () {
      expect(skipList.isSkipped('wss://a.example.com'), isFalse);
      expect(skipList.isSkipped('wss://b.example.com'), isFalse);
    });

    test('add() marks an endpoint as skipped', () {
      skipList.add('wss://bad.example.com');
      expect(skipList.isSkipped('wss://bad.example.com'), isTrue);
      expect(skipList.isSkipped('wss://other.example.com'), isFalse);
    });

    test('skipped endpoint expires after the 5-minute TTL', () {
      skipList.add('wss://bad.example.com');
      expect(skipList.isSkipped('wss://bad.example.com'), isTrue);

      now = now.add(const Duration(minutes: 4, seconds: 59));
      expect(skipList.isSkipped('wss://bad.example.com'), isTrue);

      now = now.add(const Duration(seconds: 2));
      expect(skipList.isSkipped('wss://bad.example.com'), isFalse);
    });

    test('filter() excludes skipped servers from a list', () {
      final servers = [
        _server('wss://a.example.com'),
        _server('wss://b.example.com'),
        _server('wss://c.example.com'),
      ];
      skipList.add('wss://b.example.com');

      final filtered = skipList.filter(servers);

      expect(filtered.map((s) => s.endpoint), [
        'wss://a.example.com',
        'wss://c.example.com',
      ]);
    });

    test('repeated add() re-arms the TTL from the latest call', () {
      skipList.add('wss://bad.example.com');

      now = now.add(const Duration(minutes: 4));
      skipList.add('wss://bad.example.com'); // re-arm

      now = now.add(const Duration(minutes: 4));
      expect(
        skipList.isSkipped('wss://bad.example.com'),
        isTrue,
        reason: 'second add() should extend skip until 5 min after that call',
      );

      now = now.add(const Duration(minutes: 2));
      expect(skipList.isSkipped('wss://bad.example.com'), isFalse);
    });

    test('clear() removes all entries', () {
      skipList.add('wss://a.example.com');
      skipList.add('wss://b.example.com');
      skipList.clear();

      expect(skipList.isSkipped('wss://a.example.com'), isFalse);
      expect(skipList.isSkipped('wss://b.example.com'), isFalse);
    });

    test('custom ttl is honored', () {
      final short = ServerSkipList(
        clock: () => now,
        ttl: const Duration(seconds: 30),
      );
      short.add('wss://x.example.com');

      now = now.add(const Duration(seconds: 29));
      expect(short.isSkipped('wss://x.example.com'), isTrue);

      now = now.add(const Duration(seconds: 2));
      expect(short.isSkipped('wss://x.example.com'), isFalse);
    });
  });
}
