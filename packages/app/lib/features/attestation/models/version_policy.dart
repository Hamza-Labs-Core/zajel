/// Represents the version management policy fetched from the bootstrap server.
///
/// Controls which app versions are allowed to connect to the infrastructure.
class VersionPolicy {
  /// Minimum version required to connect. Versions below this are blocked.
  final String minimumVersion;

  /// Recommended version. Versions below this get a non-blocking update prompt.
  final String recommendedVersion;

  /// Specific versions that are blocked (e.g., known vulnerable builds).
  final List<String> blockedVersions;

  /// Sunset dates for specific versions (version -> ISO date string).
  final Map<String, String> sunsetDates;

  const VersionPolicy({
    this.minimumVersion = '0.0.0',
    this.recommendedVersion = '0.0.0',
    this.blockedVersions = const [],
    this.sunsetDates = const {},
  });

  factory VersionPolicy.fromJson(Map<String, dynamic> json) {
    return VersionPolicy(
      minimumVersion: json['minimum_version'] as String? ?? '0.0.0',
      recommendedVersion: json['recommended_version'] as String? ?? '0.0.0',
      blockedVersions: (json['blocked_versions'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toList() ??
          [],
      sunsetDates: (json['sunset_date'] as Map<String, dynamic>?)
              ?.map((k, v) => MapEntry(k, v as String)) ??
          {},
    );
  }

  Map<String, dynamic> toJson() => {
        'minimum_version': minimumVersion,
        'recommended_version': recommendedVersion,
        'blocked_versions': blockedVersions,
        'sunset_date': sunsetDates,
      };

  @override
  String toString() => 'VersionPolicy(min=$minimumVersion, '
      'recommended=$recommendedVersion, '
      'blocked=$blockedVersions)';
}

/// The result of comparing the current app version against the version policy.
enum VersionStatus {
  /// Version is current or above recommended.
  upToDate,

  /// Version is below recommended but above minimum.
  updateAvailable,

  /// Version is below minimum — must update.
  updateRequired,

  /// Version is explicitly blocked — must update.
  blocked,
}
