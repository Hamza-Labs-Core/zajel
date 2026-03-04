import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../../core/logging/logger_service.dart';
import '../models/build_token.dart';
import '../models/session_token.dart';
import '../models/version_policy.dart';

/// HTTP client for communicating with the bootstrap attestation API.
///
/// Handles registration, challenge-response, and version policy requests.
class AttestationClient {
  static const _tag = 'AttestationClient';

  /// Base URL of the bootstrap server.
  final String bootstrapUrl;

  /// HTTP client for making requests.
  final http.Client _client;

  AttestationClient({
    required this.bootstrapUrl,
    http.Client? client,
  }) : _client = client ?? http.Client();

  /// Register a device with a build token.
  ///
  /// Sends the build token and device ID to `POST /attest/register`.
  /// Returns a [SessionToken] on success, or null on failure.
  Future<SessionToken?> register({
    required BuildToken buildToken,
    required String deviceId,
  }) async {
    try {
      final uri = Uri.parse('$bootstrapUrl/attest/register');
      final response = await _client
          .post(
            uri,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'build_token': buildToken.toJson(),
              'device_id': deviceId,
            }),
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode == 200 || response.statusCode == 201) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        if (json['session_token'] != null) {
          return SessionToken.fromJson(
              json['session_token'] as Map<String, dynamic>);
        }
      }

      logger.warning(
        _tag,
        'Registration failed: ${response.statusCode} ${response.body}',
      );
      return null;
    } catch (e) {
      logger.error(_tag, 'Registration request failed', e);
      return null;
    }
  }

  /// Request an attestation challenge from the bootstrap server.
  ///
  /// Sends `POST /attest/challenge` with device ID and build version.
  /// Returns the challenge data (nonce + regions), or null on failure.
  Future<AttestationChallenge?> requestChallenge({
    required String deviceId,
    required String buildVersion,
  }) async {
    try {
      final uri = Uri.parse('$bootstrapUrl/attest/challenge');
      final response = await _client
          .post(
            uri,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'device_id': deviceId,
              'build_version': buildVersion,
            }),
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        return AttestationChallenge.fromJson(json);
      }

      logger.warning(
        _tag,
        'Challenge request failed: ${response.statusCode} ${response.body}',
      );
      return null;
    } catch (e) {
      logger.error(_tag, 'Challenge request failed', e);
      return null;
    }
  }

  /// Submit challenge responses to the bootstrap server.
  ///
  /// Sends `POST /attest/verify` with the device ID, nonce, and HMAC responses.
  /// Returns a [SessionToken] on success, or null on failure.
  Future<SessionToken?> submitResponse({
    required String deviceId,
    required String nonce,
    required List<ChallengeResponse> responses,
  }) async {
    try {
      final uri = Uri.parse('$bootstrapUrl/attest/verify');
      final response = await _client
          .post(
            uri,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'device_id': deviceId,
              'nonce': nonce,
              'responses': responses.map((r) => r.toJson()).toList(),
            }),
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final valid = json['valid'] as bool? ?? false;
        if (valid && json['session_token'] != null) {
          return SessionToken.fromJson(
              json['session_token'] as Map<String, dynamic>);
        }
      }

      logger.warning(
        _tag,
        'Verification failed: ${response.statusCode} ${response.body}',
      );
      return null;
    } catch (e) {
      logger.error(_tag, 'Verification request failed', e);
      return null;
    }
  }

  /// Fetch the version policy from the bootstrap server.
  ///
  /// Calls `GET /attest/versions` and returns the parsed [VersionPolicy].
  Future<VersionPolicy?> fetchVersionPolicy() async {
    try {
      final uri = Uri.parse('$bootstrapUrl/attest/versions');
      final response = await _client.get(uri).timeout(
            const Duration(seconds: 10),
          );

      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        return VersionPolicy.fromJson(json);
      }

      logger.warning(
        _tag,
        'Version policy fetch failed: ${response.statusCode}',
      );
      return null;
    } catch (e) {
      logger.error(_tag, 'Version policy request failed', e);
      return null;
    }
  }

  /// Dispose the HTTP client.
  void dispose() {
    _client.close();
  }
}

/// Represents an attestation challenge from the bootstrap server.
class AttestationChallenge {
  /// Unique nonce for this challenge (prevents replay).
  final String nonce;

  /// Binary regions to read and hash.
  final List<ChallengeRegion> regions;

  const AttestationChallenge({
    required this.nonce,
    required this.regions,
  });

  factory AttestationChallenge.fromJson(Map<String, dynamic> json) {
    return AttestationChallenge(
      nonce: json['nonce'] as String? ?? '',
      regions: (json['regions'] as List<dynamic>?)
              ?.map((r) => ChallengeRegion.fromJson(r as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }
}

/// A binary region to read for attestation.
class ChallengeRegion {
  /// Byte offset into the binary.
  final int offset;

  /// Number of bytes to read.
  final int length;

  const ChallengeRegion({required this.offset, required this.length});

  factory ChallengeRegion.fromJson(Map<String, dynamic> json) {
    return ChallengeRegion(
      offset: json['offset'] as int? ?? 0,
      length: json['length'] as int? ?? 0,
    );
  }
}

/// An HMAC response for a single challenge region.
class ChallengeResponse {
  /// Index of the region this response corresponds to.
  final int regionIndex;

  /// HMAC-SHA256 of the binary region bytes keyed with the nonce.
  final String hmac;

  const ChallengeResponse({required this.regionIndex, required this.hmac});

  Map<String, dynamic> toJson() => {
        'region_index': regionIndex,
        'hmac': hmac,
      };
}
