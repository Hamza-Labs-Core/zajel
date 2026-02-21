import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

void main() {
  group('TrustedPeer key rotation fields', () {
    test('fromJson handles missing new fields (backward compat)', () {
      final json = {
        'id': 'peer1',
        'displayName': 'Alice',
        'publicKey': 'abc123',
        'trustedAt': '2026-01-01T00:00:00.000Z',
      };
      final peer = TrustedPeer.fromJson(json);
      expect(peer.previousPublicKey, isNull);
      expect(peer.keyRotatedAt, isNull);
      expect(peer.keyChangeAcknowledged, isTrue);
    });

    test('toJson includes new fields', () {
      final now = DateTime.now().toUtc();
      final peer = TrustedPeer(
        id: 'peer1',
        displayName: 'Alice',
        publicKey: 'newKey',
        trustedAt: now,
        previousPublicKey: 'oldKey',
        keyRotatedAt: now,
        keyChangeAcknowledged: false,
      );
      final json = peer.toJson();
      expect(json['previousPublicKey'], 'oldKey');
      expect(json['keyRotatedAt'], isNotNull);
      expect(json['keyChangeAcknowledged'], isFalse);
    });

    test('copyWith works for new fields', () {
      final peer = TrustedPeer(
        id: 'peer1',
        displayName: 'Alice',
        publicKey: 'key1',
        trustedAt: DateTime.now().toUtc(),
      );

      final updated = peer.copyWith(keyChangeAcknowledged: false);
      expect(updated.keyChangeAcknowledged, isFalse);

      final withPrevKey = peer.copyWith(previousPublicKey: 'oldKey');
      expect(withPrevKey.previousPublicKey, 'oldKey');

      final cleared = withPrevKey.copyWith(clearPreviousPublicKey: true);
      expect(cleared.previousPublicKey, isNull);
    });

    test('default keyChangeAcknowledged is true', () {
      final peer = TrustedPeer(
        id: 'peer1',
        displayName: 'Alice',
        publicKey: 'key1',
        trustedAt: DateTime.now().toUtc(),
      );
      expect(peer.keyChangeAcknowledged, isTrue);
    });

    test('roundtrip fromJson/toJson preserves key rotation fields', () {
      final now = DateTime.now().toUtc();
      final original = TrustedPeer(
        id: 'peer1',
        displayName: 'Alice',
        publicKey: 'newKey',
        trustedAt: now,
        previousPublicKey: 'oldKey',
        keyRotatedAt: now,
        keyChangeAcknowledged: false,
      );
      final json = original.toJson();
      final restored = TrustedPeer.fromJson(json);
      expect(restored.previousPublicKey, 'oldKey');
      expect(restored.keyChangeAcknowledged, isFalse);
      expect(restored.keyRotatedAt, isNotNull);
    });
  });
}
