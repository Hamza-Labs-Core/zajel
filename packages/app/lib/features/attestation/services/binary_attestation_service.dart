import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../../../core/logging/logger_service.dart';
import '../platform/binary_reader.dart';
import 'attestation_client.dart';

/// Handles dynamic binary attestation challenges.
///
/// When the bootstrap server sends a challenge with random binary regions,
/// this service reads those regions from the app's own binary and computes
/// HMAC-SHA256 responses keyed with the challenge nonce.
///
/// The bootstrap server holds a reference copy of the binary and computes
/// the same HMACs. Only an unmodified binary will produce matching responses.
class BinaryAttestationService {
  static const _tag = 'BinaryAttestation';

  final BinaryReader _binaryReader;
  final Hmac _hmac = Hmac.sha256();

  BinaryAttestationService({
    required BinaryReader binaryReader,
  }) : _binaryReader = binaryReader;

  /// Whether binary attestation is supported on the current platform.
  bool get isSupported => _binaryReader.isSupported;

  /// Respond to a binary attestation challenge.
  ///
  /// For each region in the challenge:
  /// 1. Read the binary at the specified offset and length
  /// 2. Compute HMAC-SHA256(binary_region_bytes, nonce)
  /// 3. Return the hex-encoded HMAC as the response
  ///
  /// Returns a list of [ChallengeResponse] objects. If the binary cannot
  /// be read (e.g., on web), returns an empty list.
  Future<List<ChallengeResponse>> respondToChallenge({
    required String nonce,
    required List<ChallengeRegion> regions,
  }) async {
    if (!_binaryReader.isSupported) {
      logger.warning(
        _tag,
        'Binary reading not supported on this platform, '
        'returning empty responses',
      );
      return [];
    }

    final responses = <ChallengeResponse>[];

    for (var i = 0; i < regions.length; i++) {
      final region = regions[i];
      try {
        final bytes = await _binaryReader.readRegion(
          region.offset,
          region.length,
        );

        if (bytes == null) {
          logger.warning(
            _tag,
            'Failed to read region $i '
            '(offset=${region.offset}, length=${region.length})',
          );
          // Return empty HMAC for unreadable regions — the server will reject
          responses.add(ChallengeResponse(regionIndex: i, hmac: ''));
          continue;
        }

        final hmacHex = await _computeHmac(bytes, nonce);
        responses.add(ChallengeResponse(regionIndex: i, hmac: hmacHex));
      } catch (e) {
        logger.error(_tag, 'Error processing region $i', e);
        responses.add(ChallengeResponse(regionIndex: i, hmac: ''));
      }
    }

    logger.info(
      _tag,
      'Generated ${responses.length} challenge responses',
    );
    return responses;
  }

  /// Compute HMAC-SHA256(data, nonce) and return hex-encoded result.
  Future<String> _computeHmac(Uint8List data, String nonce) async {
    final nonceBytes = utf8.encode(nonce);
    final secretKey = SecretKey(nonceBytes);

    final mac = await _hmac.calculateMac(
      data,
      secretKey: secretKey,
    );

    return mac.bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
