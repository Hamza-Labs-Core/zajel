import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/attestation/platform/binary_reader.dart';
import 'package:zajel/features/attestation/services/attestation_client.dart';
import 'package:zajel/features/attestation/services/binary_attestation_service.dart';

/// Fake binary reader that returns predictable data for testing.
class FakeBinaryReader implements BinaryReader {
  final Map<int, Uint8List> _data;
  final bool _supported;

  FakeBinaryReader({
    Map<int, Uint8List>? data,
    bool supported = true,
  })  : _data = data ?? {},
        _supported = supported;

  @override
  Future<Uint8List?> readRegion(int offset, int length) async {
    return _data[offset];
  }

  @override
  bool get isSupported => _supported;
}

void main() {
  group('BinaryAttestationService', () {
    group('respondToChallenge', () {
      test('computes HMAC for each region', () async {
        final reader = FakeBinaryReader(data: {
          100: Uint8List.fromList([1, 2, 3, 4]),
          200: Uint8List.fromList([5, 6, 7, 8]),
        });

        final service = BinaryAttestationService(binaryReader: reader);

        final responses = await service.respondToChallenge(
          nonce: 'test-nonce',
          regions: [
            const ChallengeRegion(offset: 100, length: 4),
            const ChallengeRegion(offset: 200, length: 4),
          ],
        );

        expect(responses, hasLength(2));
        expect(responses[0].regionIndex, 0);
        expect(responses[0].hmac, isNotEmpty);
        expect(responses[1].regionIndex, 1);
        expect(responses[1].hmac, isNotEmpty);

        // Different regions should produce different HMACs
        expect(responses[0].hmac, isNot(responses[1].hmac));
      });

      test('produces consistent HMACs for same data and nonce', () async {
        final reader = FakeBinaryReader(data: {
          100: Uint8List.fromList([1, 2, 3, 4]),
        });

        final service = BinaryAttestationService(binaryReader: reader);

        final responses1 = await service.respondToChallenge(
          nonce: 'same-nonce',
          regions: [const ChallengeRegion(offset: 100, length: 4)],
        );

        final responses2 = await service.respondToChallenge(
          nonce: 'same-nonce',
          regions: [const ChallengeRegion(offset: 100, length: 4)],
        );

        expect(responses1[0].hmac, responses2[0].hmac);
      });

      test('different nonces produce different HMACs', () async {
        final reader = FakeBinaryReader(data: {
          100: Uint8List.fromList([1, 2, 3, 4]),
        });

        final service = BinaryAttestationService(binaryReader: reader);

        final responses1 = await service.respondToChallenge(
          nonce: 'nonce-1',
          regions: [const ChallengeRegion(offset: 100, length: 4)],
        );

        final responses2 = await service.respondToChallenge(
          nonce: 'nonce-2',
          regions: [const ChallengeRegion(offset: 100, length: 4)],
        );

        expect(responses1[0].hmac, isNot(responses2[0].hmac));
      });

      test('returns empty hmac for unreadable regions', () async {
        final reader = FakeBinaryReader(data: {
          // Only offset 100 has data
          100: Uint8List.fromList([1, 2, 3]),
        });

        final service = BinaryAttestationService(binaryReader: reader);

        final responses = await service.respondToChallenge(
          nonce: 'test',
          regions: [
            const ChallengeRegion(offset: 100, length: 3),
            const ChallengeRegion(offset: 999, length: 10), // Not in data
          ],
        );

        expect(responses, hasLength(2));
        expect(responses[0].hmac, isNotEmpty);
        expect(responses[1].hmac, ''); // Unreadable region
      });

      test('returns empty list when platform not supported', () async {
        final reader = FakeBinaryReader(supported: false);
        final service = BinaryAttestationService(binaryReader: reader);

        final responses = await service.respondToChallenge(
          nonce: 'test',
          regions: [const ChallengeRegion(offset: 0, length: 100)],
        );

        expect(responses, isEmpty);
      });

      test('handles empty regions list', () async {
        final reader = FakeBinaryReader();
        final service = BinaryAttestationService(binaryReader: reader);

        final responses = await service.respondToChallenge(
          nonce: 'test',
          regions: [],
        );

        expect(responses, isEmpty);
      });

      test('HMAC output is hex-encoded', () async {
        final reader = FakeBinaryReader(data: {
          0: Uint8List.fromList([1, 2, 3]),
        });

        final service = BinaryAttestationService(binaryReader: reader);

        final responses = await service.respondToChallenge(
          nonce: 'test',
          regions: [const ChallengeRegion(offset: 0, length: 3)],
        );

        // HMAC-SHA256 produces 32 bytes = 64 hex chars
        expect(responses[0].hmac, hasLength(64));
        // All chars should be valid hex
        expect(
          RegExp(r'^[0-9a-f]+$').hasMatch(responses[0].hmac),
          isTrue,
        );
      });
    });

    group('isSupported', () {
      test('reflects binary reader support', () {
        final supported = BinaryAttestationService(
          binaryReader: FakeBinaryReader(supported: true),
        );
        expect(supported.isSupported, isTrue);

        final unsupported = BinaryAttestationService(
          binaryReader: FakeBinaryReader(supported: false),
        );
        expect(unsupported.isSupported, isFalse);
      });
    });
  });

  group('StubBinaryReader', () {
    test('returns null for readRegion', () async {
      final reader = StubBinaryReader();
      final result = await reader.readRegion(0, 100);
      expect(result, isNull);
    });

    test('reports not supported', () {
      final reader = StubBinaryReader();
      expect(reader.isSupported, isFalse);
    });
  });
}
