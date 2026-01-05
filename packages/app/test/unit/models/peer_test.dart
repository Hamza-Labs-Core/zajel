import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/models/peer.dart';

void main() {
  group('Peer', () {
    final testDate = DateTime(2024, 1, 15, 10, 30);

    group('constructor', () {
      test('creates peer with required fields', () {
        final peer = Peer(
          id: 'test-id',
          displayName: 'Test Peer',
          lastSeen: testDate,
        );

        expect(peer.id, 'test-id');
        expect(peer.displayName, 'Test Peer');
        expect(peer.lastSeen, testDate);
        expect(peer.connectionState, PeerConnectionState.disconnected);
        expect(peer.isLocal, true);
        expect(peer.ipAddress, isNull);
        expect(peer.port, isNull);
        expect(peer.publicKey, isNull);
      });

      test('creates peer with all fields', () {
        final peer = Peer(
          id: 'test-id',
          displayName: 'Test Peer',
          ipAddress: '192.168.1.100',
          port: 8080,
          publicKey: 'base64-public-key',
          connectionState: PeerConnectionState.connected,
          lastSeen: testDate,
          isLocal: false,
        );

        expect(peer.ipAddress, '192.168.1.100');
        expect(peer.port, 8080);
        expect(peer.publicKey, 'base64-public-key');
        expect(peer.connectionState, PeerConnectionState.connected);
        expect(peer.isLocal, false);
      });
    });

    group('copyWith', () {
      test('creates copy with modified fields', () {
        final original = Peer(
          id: 'test-id',
          displayName: 'Original',
          lastSeen: testDate,
        );

        final copy = original.copyWith(
          displayName: 'Modified',
          connectionState: PeerConnectionState.connecting,
        );

        expect(copy.id, original.id);
        expect(copy.displayName, 'Modified');
        expect(copy.connectionState, PeerConnectionState.connecting);
        expect(copy.lastSeen, original.lastSeen);
      });

      test('creates identical copy when no fields specified', () {
        final original = Peer(
          id: 'test-id',
          displayName: 'Test',
          ipAddress: '192.168.1.1',
          port: 8080,
          lastSeen: testDate,
        );

        final copy = original.copyWith();

        expect(copy.id, original.id);
        expect(copy.displayName, original.displayName);
        expect(copy.ipAddress, original.ipAddress);
        expect(copy.port, original.port);
      });
    });

    group('JSON serialization', () {
      test('toJson produces valid JSON', () {
        final peer = Peer(
          id: 'test-id',
          displayName: 'Test Peer',
          ipAddress: '192.168.1.100',
          port: 8080,
          publicKey: 'test-key',
          connectionState: PeerConnectionState.connected,
          lastSeen: testDate,
          isLocal: true,
        );

        final json = peer.toJson();

        expect(json['id'], 'test-id');
        expect(json['displayName'], 'Test Peer');
        expect(json['ipAddress'], '192.168.1.100');
        expect(json['port'], 8080);
        expect(json['publicKey'], 'test-key');
        expect(json['connectionState'], 'connected');
        expect(json['lastSeen'], testDate.toIso8601String());
        expect(json['isLocal'], true);
      });

      test('fromJson creates valid peer', () {
        final json = {
          'id': 'test-id',
          'displayName': 'Test Peer',
          'ipAddress': '192.168.1.100',
          'port': 8080,
          'publicKey': 'test-key',
          'connectionState': 'connected',
          'lastSeen': testDate.toIso8601String(),
          'isLocal': true,
        };

        final peer = Peer.fromJson(json);

        expect(peer.id, 'test-id');
        expect(peer.displayName, 'Test Peer');
        expect(peer.ipAddress, '192.168.1.100');
        expect(peer.port, 8080);
        expect(peer.publicKey, 'test-key');
        expect(peer.connectionState, PeerConnectionState.connected);
        expect(peer.lastSeen, testDate);
        expect(peer.isLocal, true);
      });

      test('fromJson handles null optional fields', () {
        final json = {
          'id': 'test-id',
          'displayName': 'Test Peer',
          'ipAddress': null,
          'port': null,
          'publicKey': null,
          'connectionState': 'disconnected',
          'lastSeen': testDate.toIso8601String(),
        };

        final peer = Peer.fromJson(json);

        expect(peer.ipAddress, isNull);
        expect(peer.port, isNull);
        expect(peer.publicKey, isNull);
        expect(peer.isLocal, true); // default value
      });

      test('fromJson handles unknown connection state', () {
        final json = {
          'id': 'test-id',
          'displayName': 'Test Peer',
          'connectionState': 'unknown_state',
          'lastSeen': testDate.toIso8601String(),
        };

        final peer = Peer.fromJson(json);

        expect(peer.connectionState, PeerConnectionState.disconnected);
      });

      test('roundtrip serialization preserves data', () {
        final original = Peer(
          id: 'test-id',
          displayName: 'Test Peer',
          ipAddress: '192.168.1.100',
          port: 8080,
          publicKey: 'test-key',
          connectionState: PeerConnectionState.handshaking,
          lastSeen: testDate,
          isLocal: false,
        );

        final json = original.toJson();
        final restored = Peer.fromJson(json);

        expect(restored.id, original.id);
        expect(restored.displayName, original.displayName);
        expect(restored.ipAddress, original.ipAddress);
        expect(restored.port, original.port);
        expect(restored.publicKey, original.publicKey);
        expect(restored.connectionState, original.connectionState);
        expect(restored.lastSeen, original.lastSeen);
        expect(restored.isLocal, original.isLocal);
      });
    });

    group('equality', () {
      test('peers with same id, displayName, publicKey are equal', () {
        final peer1 = Peer(
          id: 'test-id',
          displayName: 'Test',
          publicKey: 'key',
          lastSeen: testDate,
        );

        final peer2 = Peer(
          id: 'test-id',
          displayName: 'Test',
          publicKey: 'key',
          lastSeen: DateTime.now(), // Different timestamp
          connectionState: PeerConnectionState.connected, // Different state
        );

        expect(peer1, equals(peer2));
      });

      test('peers with different id are not equal', () {
        final peer1 = Peer(
          id: 'id-1',
          displayName: 'Test',
          lastSeen: testDate,
        );

        final peer2 = Peer(
          id: 'id-2',
          displayName: 'Test',
          lastSeen: testDate,
        );

        expect(peer1, isNot(equals(peer2)));
      });
    });

    group('PeerConnectionState', () {
      test('all states can be serialized and deserialized', () {
        for (final state in PeerConnectionState.values) {
          final peer = Peer(
            id: 'test',
            displayName: 'Test',
            connectionState: state,
            lastSeen: testDate,
          );

          final json = peer.toJson();
          final restored = Peer.fromJson(json);

          expect(restored.connectionState, state);
        }
      });
    });
  });
}
