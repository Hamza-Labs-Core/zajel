import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/config/environment.dart';
import '../../../core/logging/logger_service.dart';
import '../models/build_token.dart';
import '../models/session_token.dart';
import 'attestation_client.dart';

/// Main attestation orchestrator.
///
/// Manages build token registration, session token storage/retrieval,
/// and automatic registration on first launch.
///
/// Flow:
/// 1. On first launch (no stored session token), register with bootstrap
///    using the embedded build token.
/// 2. On subsequent launches, load the stored session token.
/// 3. If the stored token is expired, re-register to get a new one.
class AttestationService {
  static const _tag = 'AttestationService';
  static const _sessionTokenKey = 'attestation_session_token';

  final AttestationClient _client;
  final FlutterSecureStorage _secureStorage;
  final String _deviceId;

  SessionToken? _cachedToken;

  AttestationService({
    required AttestationClient client,
    required FlutterSecureStorage secureStorage,
    required String deviceId,
  })  : _client = client,
        _secureStorage = secureStorage,
        _deviceId = deviceId;

  /// Get the current valid session token, or null if not available.
  SessionToken? get currentToken =>
      _cachedToken != null && _cachedToken!.isValid ? _cachedToken : null;

  /// Whether we have a valid (non-expired) session token.
  bool get hasValidToken => currentToken != null;

  /// Initialize attestation: load stored token or register.
  ///
  /// This should be called on app startup. If no valid session token
  /// exists, it will attempt to register with the bootstrap server
  /// using the embedded build token.
  Future<SessionToken?> initialize() async {
    // Try to load a stored session token first
    _cachedToken = await _loadStoredToken();

    if (_cachedToken != null && _cachedToken!.isValid) {
      logger.info(_tag, 'Loaded valid session token from storage');
      return _cachedToken;
    }

    // No valid token — attempt registration
    logger.info(_tag, 'No valid session token, attempting registration');
    return await register();
  }

  /// Register with the bootstrap server using the embedded build token.
  ///
  /// Returns a [SessionToken] on success, or null on failure.
  Future<SessionToken?> register() async {
    final buildToken = _getBuildToken();
    if (buildToken == null) {
      logger.warning(
        _tag,
        'No build token available. '
        'Set BUILD_TOKEN via --dart-define for release builds.',
      );
      return null;
    }

    return await registerWithToken(buildToken);
  }

  /// Register with a specific build token.
  ///
  /// Useful for testing or when the build token is obtained externally.
  Future<SessionToken?> registerWithToken(BuildToken buildToken) async {
    try {
      final sessionToken = await _client.register(
        buildToken: buildToken,
        deviceId: _deviceId,
      );

      if (sessionToken != null) {
        _cachedToken = sessionToken;
        await _storeToken(sessionToken);
        logger.info(_tag, 'Registration successful, token stored');
        return sessionToken;
      }

      logger.warning(_tag, 'Registration returned no session token');
      return null;
    } catch (e) {
      logger.error(_tag, 'Registration failed', e);
      return null;
    }
  }

  /// Refresh the session token (re-register if expired).
  Future<SessionToken?> refreshToken() async {
    logger.info(_tag, 'Refreshing session token');
    return await register();
  }

  /// Clear the stored session token.
  Future<void> clearToken() async {
    _cachedToken = null;
    await _secureStorage.delete(key: _sessionTokenKey);
    logger.info(_tag, 'Session token cleared');
  }

  /// Get the build token from compile-time environment.
  BuildToken? _getBuildToken() {
    return BuildToken.fromBase64(Environment.buildToken);
  }

  /// Load a previously stored session token from secure storage.
  Future<SessionToken?> _loadStoredToken() async {
    try {
      final stored = await _secureStorage.read(key: _sessionTokenKey);
      if (stored == null || stored.isEmpty) return null;

      final json = jsonDecode(stored) as Map<String, dynamic>;
      return SessionToken.fromJson(json);
    } catch (e) {
      logger.warning(_tag, 'Failed to load stored session token: $e');
      return null;
    }
  }

  /// Store a session token in secure storage.
  Future<void> _storeToken(SessionToken token) async {
    try {
      final jsonString = jsonEncode(token.toJson());
      await _secureStorage.write(key: _sessionTokenKey, value: jsonString);
    } catch (e) {
      logger.warning(_tag, 'Failed to store session token: $e');
    }
  }
}
