import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/models/peer.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

void main() {
  // A fixed 32-byte key for deterministic tests
  final knownPublicKey = base64Encode(List.filled(32, 42));
  // Tag is now derived from stableId (peer.id), not publicKey
  const testPeerId = 'ABCDEF1234567890';
  final knownTag = CryptoService.tagFromStableId(testPeerId);

  final testTrustedAt = DateTime(2024, 6, 15, 12, 0);
  final testLastSeen = DateTime(2024, 6, 16, 10, 0);

  group('TrustedPeer', () {
    group('constructor', () {
      test('creates with required fields only', () {
        final peer = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice',
          publicKey: knownPublicKey,
          trustedAt: testTrustedAt,
        );

        expect(peer.id, 'peer-1');
        expect(peer.displayName, 'Alice');
        expect(peer.username, isNull);
        expect(peer.tag, isNull);
        expect(peer.publicKey, knownPublicKey);
        expect(peer.trustedAt, testTrustedAt);
        expect(peer.lastSeen, isNull);
        expect(peer.alias, isNull);
        expect(peer.isBlocked, false);
      });

      test('creates with username and tag', () {
        final peer = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice',
          username: 'Alice',
          tag: 'A1B2',
          publicKey: knownPublicKey,
          trustedAt: testTrustedAt,
        );

        expect(peer.username, 'Alice');
        expect(peer.tag, 'A1B2');
      });
    });

    group('copyWith', () {
      test('preserves username and tag when not specified', () {
        final original = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice',
          username: 'Alice',
          tag: 'A1B2',
          publicKey: knownPublicKey,
          trustedAt: testTrustedAt,
        );

        final copy = original.copyWith(displayName: 'Alice Updated');

        expect(copy.username, 'Alice');
        expect(copy.tag, 'A1B2');
        expect(copy.displayName, 'Alice Updated');
      });

      test('modifies username and tag when specified', () {
        final original = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice',
          username: 'Alice',
          tag: 'A1B2',
          publicKey: knownPublicKey,
          trustedAt: testTrustedAt,
        );

        final copy = original.copyWith(username: 'Alicia', tag: 'C3D4');

        expect(copy.username, 'Alicia');
        expect(copy.tag, 'C3D4');
      });
    });

    group('JSON serialization', () {
      test('toJson includes username and tag', () {
        final peer = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice',
          username: 'Alice',
          tag: 'A1B2',
          publicKey: knownPublicKey,
          trustedAt: testTrustedAt,
          lastSeen: testLastSeen,
        );

        final json = peer.toJson();

        expect(json['id'], 'peer-1');
        expect(json['displayName'], 'Alice');
        expect(json['username'], 'Alice');
        expect(json['tag'], 'A1B2');
        expect(json['publicKey'], knownPublicKey);
      });

      test('toJson includes null username/tag when not set', () {
        final peer = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice',
          publicKey: knownPublicKey,
          trustedAt: testTrustedAt,
        );

        final json = peer.toJson();

        expect(json.containsKey('username'), true);
        expect(json['username'], isNull);
        expect(json.containsKey('tag'), true);
        expect(json['tag'], isNull);
      });

      test('fromJson parses username and tag', () {
        final json = {
          'id': 'peer-1',
          'displayName': 'Alice',
          'username': 'Alice',
          'tag': 'A1B2',
          'publicKey': knownPublicKey,
          'trustedAt': testTrustedAt.toIso8601String(),
        };

        final peer = TrustedPeer.fromJson(json);

        expect(peer.username, 'Alice');
        expect(peer.tag, 'A1B2');
      });

      test('fromJson handles missing username/tag (backward compat)', () {
        final json = {
          'id': 'peer-1',
          'displayName': 'Alice',
          'publicKey': knownPublicKey,
          'trustedAt': testTrustedAt.toIso8601String(),
        };

        final peer = TrustedPeer.fromJson(json);

        expect(peer.username, isNull);
        expect(peer.tag, isNull);
      });

      test('roundtrip preserves username and tag', () {
        final original = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice',
          username: 'Alice',
          tag: 'A1B2',
          publicKey: knownPublicKey,
          trustedAt: testTrustedAt,
          lastSeen: testLastSeen,
          alias: 'My Friend',
        );

        final json = original.toJson();
        final restored = TrustedPeer.fromJson(json);

        expect(restored.id, original.id);
        expect(restored.displayName, original.displayName);
        expect(restored.username, original.username);
        expect(restored.tag, original.tag);
        expect(restored.publicKey, original.publicKey);
        expect(restored.alias, original.alias);
      });
    });

    group('fromPeer factory', () {
      test('extracts username from Peer', () {
        final peer = Peer(
          id: testPeerId,
          displayName: 'Alice',
          username: 'Alice',
          publicKey: knownPublicKey,
          lastSeen: testLastSeen,
        );

        final trusted = TrustedPeer.fromPeer(peer);

        expect(trusted.username, 'Alice');
        expect(trusted.tag, knownTag);
        expect(trusted.displayName, 'Alice');
        expect(trusted.publicKey, knownPublicKey);
      });

      test('derives tag from stableId via CryptoService', () {
        final peer = Peer(
          id: testPeerId,
          displayName: 'Bob',
          publicKey: knownPublicKey,
          lastSeen: testLastSeen,
        );

        final trusted = TrustedPeer.fromPeer(peer);
        final expectedTag = CryptoService.tagFromStableId(testPeerId);

        expect(trusted.tag, expectedTag);
      });

      test('handles null username from Peer', () {
        final peer = Peer(
          id: testPeerId,
          displayName: 'OldPeer',
          publicKey: knownPublicKey,
          lastSeen: testLastSeen,
        );

        final trusted = TrustedPeer.fromPeer(peer);

        expect(trusted.username, isNull);
        // Tag is still derived even without username
        expect(trusted.tag, isNotNull);
      });

      test('throws when Peer has no public key', () {
        final peer = Peer(
          id: 'peer-1',
          displayName: 'NoPubKey',
          lastSeen: testLastSeen,
        );

        expect(
          () => TrustedPeer.fromPeer(peer),
          throwsA(isA<ArgumentError>()),
        );
      });
    });

    group('equality', () {
      test('peers with same id and publicKey are equal', () {
        final peer1 = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice',
          username: 'Alice',
          tag: 'A1B2',
          publicKey: knownPublicKey,
          trustedAt: testTrustedAt,
        );

        final peer2 = TrustedPeer(
          id: 'peer-1',
          displayName: 'Alice Updated',
          username: 'Alicia',
          tag: 'A1B2',
          publicKey: knownPublicKey,
          trustedAt: DateTime.now(),
        );

        expect(peer1, equals(peer2));
      });
    });
  });
}
