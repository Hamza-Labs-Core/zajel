import '../../../core/config/environment.dart';
import '../../../core/logging/logger_service.dart';
import '../models/version_policy.dart';
import 'attestation_client.dart';

/// Checks the current app version against the bootstrap version policy.
///
/// On app start, fetches the version policy from `GET /attest/versions`
/// and determines whether the current build needs to be updated.
class VersionCheckService {
  static const _tag = 'VersionCheck';

  final AttestationClient _client;

  /// Cached version policy from the last fetch.
  VersionPolicy? _cachedPolicy;

  VersionCheckService({
    required AttestationClient client,
  }) : _client = client;

  /// Get the cached version policy.
  VersionPolicy? get cachedPolicy => _cachedPolicy;

  /// Fetch the version policy and check the current app version.
  ///
  /// Returns the [VersionStatus] indicating whether the app is up to date,
  /// needs an optional update, or requires a mandatory update.
  ///
  /// Returns [VersionStatus.upToDate] if the policy cannot be fetched
  /// (fail-open to avoid blocking users on network issues).
  Future<VersionStatus> checkVersion() async {
    final policy = await _client.fetchVersionPolicy();
    if (policy == null) {
      logger.warning(
        _tag,
        'Failed to fetch version policy, assuming up to date',
      );
      return VersionStatus.upToDate;
    }

    _cachedPolicy = policy;
    final currentVersion = Environment.version.isNotEmpty
        ? Environment.version
        : Environment.fullVersion;

    return evaluateVersion(currentVersion, policy);
  }

  /// Evaluate a version string against a version policy.
  ///
  /// This is a pure function suitable for testing.
  static VersionStatus evaluateVersion(
      String currentVersion, VersionPolicy policy) {
    // Check if this exact version is blocked
    if (policy.blockedVersions.contains(currentVersion)) {
      logger.info(
        _tag,
        'Version $currentVersion is explicitly blocked',
      );
      return VersionStatus.blocked;
    }

    // Check minimum version
    if (_compareVersions(currentVersion, policy.minimumVersion) < 0) {
      logger.info(
        _tag,
        'Version $currentVersion below minimum ${policy.minimumVersion}',
      );
      return VersionStatus.updateRequired;
    }

    // Check recommended version
    if (_compareVersions(currentVersion, policy.recommendedVersion) < 0) {
      logger.info(
        _tag,
        'Version $currentVersion below recommended ${policy.recommendedVersion}',
      );
      return VersionStatus.updateAvailable;
    }

    logger.info(_tag, 'Version $currentVersion is up to date');
    return VersionStatus.upToDate;
  }

  /// Compare two semver version strings.
  ///
  /// Returns:
  /// - negative if a < b
  /// - zero if a == b
  /// - positive if a > b
  ///
  /// Handles versions with or without patch numbers (e.g., "1.2" == "1.2.0").
  static int _compareVersions(String a, String b) {
    final aParts = _parseVersion(a);
    final bParts = _parseVersion(b);

    for (var i = 0; i < 3; i++) {
      final diff = aParts[i] - bParts[i];
      if (diff != 0) return diff;
    }
    return 0;
  }

  /// Parse a version string into [major, minor, patch].
  ///
  /// Pre-release suffixes (e.g., `-beta`, `-rc1`) and build metadata (e.g., `+build123`)
  /// are intentionally stripped for numeric version comparison. This allows "1.2.0-beta"
  /// to be compared as if it were "1.2.0", consistent with semver ordering.
  ///
  /// **Note:** To block a specific pre-release build (e.g., prevent users from using
  /// "1.2.0-beta" while allowing "1.2.0"), add the full version string including the
  /// suffix to the [VersionPolicy.blockedVersions] list. The blockedVersions check
  /// happens first and compares the exact string before numeric comparison.
  static List<int> _parseVersion(String version) {
    // Strip any pre-release or build metadata (e.g., "1.2.0-beta" -> "1.2.0")
    final cleanVersion = version.split('-').first.split('+').first;
    final parts = cleanVersion.split('.');
    return [
      parts.isNotEmpty ? (int.tryParse(parts[0]) ?? 0) : 0,
      parts.length > 1 ? (int.tryParse(parts[1]) ?? 0) : 0,
      parts.length > 2 ? (int.tryParse(parts[2]) ?? 0) : 0,
    ];
  }
}
