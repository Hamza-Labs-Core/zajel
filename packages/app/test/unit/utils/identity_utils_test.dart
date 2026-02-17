import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/models/peer.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';
import 'package:zajel/core/utils/identity_utils.dart';

void main() {
  // A fixed 32-byte key for deterministic tag derivation
  final knownPublicKey = base64Encode(List.filled(32, 42));
  final knownTag = CryptoService.tagFromPublicKey(knownPublicKey);
  final testDate = DateTime(2024, 6, 15);

  group('resolvePeerDisplayName', () {
    test('returns alias when provided and non-empty', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Bob',
        username: 'Bob',
        publicKey: knownPublicKey,
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer, alias: 'My Friend');
      expect(name, 'My Friend');
    });

    test('ignores empty alias', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Bob',
        username: 'Bob',
        publicKey: knownPublicKey,
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer, alias: '');
      expect(name, 'Bob#$knownTag');
    });

    test('returns username#tag when username and publicKey present', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Bob',
        username: 'Bob',
        publicKey: knownPublicKey,
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer);
      expect(name, 'Bob#$knownTag');
    });

    test('skips username#tag when username is null', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Bob',
        publicKey: knownPublicKey,
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer);
      expect(name, 'Bob');
    });

    test('skips username#tag when username is empty', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Bob',
        username: '',
        publicKey: knownPublicKey,
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer);
      expect(name, 'Bob');
    });

    test('skips username#tag when publicKey is null', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Bob',
        username: 'Bob',
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer);
      // Falls through to displayName since tag can't be derived without publicKey
      expect(name, 'Bob');
    });

    test('returns displayName when no username/publicKey', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Bob',
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer);
      expect(name, 'Bob');
    });

    test('returns "Peer {id prefix}" when displayName is empty', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: '',
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer);
      expect(name, 'Peer abcdef12');
    });

    test('alias takes priority over everything', () {
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Bob',
        username: 'Bob',
        publicKey: knownPublicKey,
        lastSeen: testDate,
      );

      final name = resolvePeerDisplayName(peer, alias: 'BFF');
      expect(name, 'BFF');
    });
  });

  group('resolveTrustedPeerDisplayName', () {
    test('returns alias when provided and non-empty', () {
      final peer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: 'Alice',
        username: 'Alice',
        tag: 'A1B2',
        publicKey: knownPublicKey,
        trustedAt: testDate,
        alias: 'Work Friend',
      );

      final name = resolveTrustedPeerDisplayName(peer);
      expect(name, 'Work Friend');
    });

    test('returns username#tag when no alias', () {
      final peer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: 'Alice',
        username: 'Alice',
        tag: 'A1B2',
        publicKey: knownPublicKey,
        trustedAt: testDate,
      );

      final name = resolveTrustedPeerDisplayName(peer);
      expect(name, 'Alice#A1B2');
    });

    test('skips username#tag when username is null', () {
      final peer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: 'Alice',
        tag: 'A1B2',
        publicKey: knownPublicKey,
        trustedAt: testDate,
      );

      final name = resolveTrustedPeerDisplayName(peer);
      expect(name, 'Alice');
    });

    test('skips username#tag when username is empty', () {
      final peer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: 'Alice',
        username: '',
        tag: 'A1B2',
        publicKey: knownPublicKey,
        trustedAt: testDate,
      );

      final name = resolveTrustedPeerDisplayName(peer);
      expect(name, 'Alice');
    });

    test('skips username#tag when tag is null', () {
      final peer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: 'Alice',
        username: 'Alice',
        publicKey: knownPublicKey,
        trustedAt: testDate,
      );

      final name = resolveTrustedPeerDisplayName(peer);
      // Falls through to displayName since tag is null
      expect(name, 'Alice');
    });

    test('returns displayName when no username/tag', () {
      final peer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: 'Old Peer',
        publicKey: knownPublicKey,
        trustedAt: testDate,
      );

      final name = resolveTrustedPeerDisplayName(peer);
      expect(name, 'Old Peer');
    });

    test('returns "Peer {id prefix}" when displayName is empty', () {
      final peer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: '',
        publicKey: knownPublicKey,
        trustedAt: testDate,
      );

      final name = resolveTrustedPeerDisplayName(peer);
      expect(name, 'Peer abcdef12');
    });

    test('ignores empty alias', () {
      final peer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: 'Alice',
        username: 'Alice',
        tag: 'A1B2',
        publicKey: knownPublicKey,
        trustedAt: testDate,
        alias: '',
      );

      final name = resolveTrustedPeerDisplayName(peer);
      expect(name, 'Alice#A1B2');
    });
  });

  group('resolvePeerDisplayName vs resolveTrustedPeerDisplayName consistency',
      () {
    test('same priority order produces same results', () {
      // Create matching Peer and TrustedPeer with username+tag
      final peer = Peer(
        id: 'abcdef1234567890',
        displayName: 'Alice',
        username: 'Alice',
        publicKey: knownPublicKey,
        lastSeen: testDate,
      );

      final trustedPeer = TrustedPeer(
        id: 'abcdef1234567890',
        displayName: 'Alice',
        username: 'Alice',
        tag: knownTag,
        publicKey: knownPublicKey,
        trustedAt: testDate,
      );

      final peerName = resolvePeerDisplayName(peer);
      final trustedName = resolveTrustedPeerDisplayName(trustedPeer);

      expect(peerName, trustedName);
    });
  });
}
