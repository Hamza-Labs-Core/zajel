import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/server_discovery_service.dart';
import 'package:zajel/features/attestation/services/server_attestation_service.dart';

void main() {
  group('ServerAttestationService', () {
    late ServerAttestationService service;

    setUp(() {
      service = ServerAttestationService();
    });

    group('updateServerRegistry', () {
      test('stores servers with identity keys', () {
        service.updateServerRegistry([
          DiscoveredServer(
            serverId: 'server-1',
            endpoint: 'wss://s1.example.com',
            publicKey: 'pk1',
            region: 'us-east',
            registeredAt: 1000,
            lastSeen: DateTime.now().millisecondsSinceEpoch,
            identityKey: 'id-key-1',
          ),
          DiscoveredServer(
            serverId: 'server-2',
            endpoint: 'wss://s2.example.com',
            publicKey: 'pk2',
            region: 'eu-west',
            registeredAt: 1000,
            lastSeen: DateTime.now().millisecondsSinceEpoch,
            identityKey: 'id-key-2',
          ),
        ]);

        expect(service.isServerKnown('server-1'), isTrue);
        expect(service.isServerKnown('server-2'), isTrue);
        expect(service.getServerIdentityKey('server-1'), 'id-key-1');
        expect(service.getServerIdentityKey('server-2'), 'id-key-2');
      });

      test('skips servers without identity keys', () {
        service.updateServerRegistry([
          DiscoveredServer(
            serverId: 'server-1',
            endpoint: 'wss://s1.example.com',
            publicKey: 'pk1',
            region: 'us-east',
            registeredAt: 1000,
            lastSeen: DateTime.now().millisecondsSinceEpoch,
            identityKey: 'id-key-1',
          ),
          DiscoveredServer(
            serverId: 'server-no-key',
            endpoint: 'wss://s2.example.com',
            publicKey: 'pk2',
            region: 'eu-west',
            registeredAt: 1000,
            lastSeen: DateTime.now().millisecondsSinceEpoch,
            // no identityKey
          ),
        ]);

        expect(service.isServerKnown('server-1'), isTrue);
        expect(service.isServerKnown('server-no-key'), isFalse);
      });

      test('clears previous registry on update', () {
        service.updateServerRegistry([
          DiscoveredServer(
            serverId: 'old-server',
            endpoint: 'wss://old.example.com',
            publicKey: 'pk',
            region: 'us',
            registeredAt: 1000,
            lastSeen: DateTime.now().millisecondsSinceEpoch,
            identityKey: 'old-key',
          ),
        ]);

        expect(service.isServerKnown('old-server'), isTrue);

        service.updateServerRegistry([
          DiscoveredServer(
            serverId: 'new-server',
            endpoint: 'wss://new.example.com',
            publicKey: 'pk',
            region: 'eu',
            registeredAt: 1000,
            lastSeen: DateTime.now().millisecondsSinceEpoch,
            identityKey: 'new-key',
          ),
        ]);

        expect(service.isServerKnown('old-server'), isFalse);
        expect(service.isServerKnown('new-server'), isTrue);
      });
    });

    group('verifyServer', () {
      setUp(() {
        service.updateServerRegistry([
          DiscoveredServer(
            serverId: 'verified-server',
            endpoint: 'wss://verified.example.com',
            publicKey: 'pk',
            region: 'us',
            registeredAt: 1000,
            lastSeen: DateTime.now().millisecondsSinceEpoch,
            identityKey: 'correct-identity-key',
          ),
        ]);
      });

      test('returns true for matching identity key', () {
        final result = service.verifyServer(
          serverId: 'verified-server',
          identityKey: 'correct-identity-key',
        );
        expect(result, isTrue);
      });

      test('returns false for mismatched identity key', () {
        final result = service.verifyServer(
          serverId: 'verified-server',
          identityKey: 'wrong-identity-key',
        );
        expect(result, isFalse);
      });

      test('returns false for unknown server', () {
        final result = service.verifyServer(
          serverId: 'unknown-server',
          identityKey: 'any-key',
        );
        expect(result, isFalse);
      });
    });

    group('isServerKnown', () {
      test('returns false for empty registry', () {
        expect(service.isServerKnown('any'), isFalse);
      });
    });

    group('getServerIdentityKey', () {
      test('returns null for unknown server', () {
        expect(service.getServerIdentityKey('unknown'), isNull);
      });

      test('returns key for known server', () {
        service.updateServerRegistry([
          DiscoveredServer(
            serverId: 'srv',
            endpoint: 'wss://srv.example.com',
            publicKey: 'pk',
            region: 'us',
            registeredAt: 1000,
            lastSeen: DateTime.now().millisecondsSinceEpoch,
            identityKey: 'my-key',
          ),
        ]);

        expect(service.getServerIdentityKey('srv'), 'my-key');
      });
    });
  });
}
