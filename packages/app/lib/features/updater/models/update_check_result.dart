/// Sealed class representing the outcome of a manual update check
/// against the GitHub Releases API.
sealed class UpdateCheckResult {
  const UpdateCheckResult();
}

/// The current version is equal to or greater than the latest release.
class UpdateCheckUpToDate extends UpdateCheckResult {
  /// The current app version that was checked.
  final String currentVersion;

  /// When the check was performed.
  final DateTime checkedAt;

  const UpdateCheckUpToDate({
    required this.currentVersion,
    required this.checkedAt,
  });

  @override
  String toString() =>
      'UpdateCheckUpToDate(version=$currentVersion, checkedAt=$checkedAt)';
}

/// A newer version is available on GitHub Releases.
class UpdateCheckAvailable extends UpdateCheckResult {
  /// The current app version.
  final String currentVersion;

  /// The latest version available.
  final String latestVersion;

  /// The release title.
  final String releaseName;

  /// First ~200 characters of the release body, with markdown stripped.
  final String releaseNotes;

  /// When the release was published on GitHub.
  final DateTime publishedAt;

  /// URL to the release page on GitHub.
  final String releaseUrl;

  /// When the check was performed.
  final DateTime checkedAt;

  const UpdateCheckAvailable({
    required this.currentVersion,
    required this.latestVersion,
    required this.releaseName,
    required this.releaseNotes,
    required this.publishedAt,
    required this.releaseUrl,
    required this.checkedAt,
  });

  @override
  String toString() =>
      'UpdateCheckAvailable(current=$currentVersion, latest=$latestVersion)';
}

/// The update check failed due to a network error, rate limiting, or
/// other issue.
class UpdateCheckError extends UpdateCheckResult {
  /// Human-readable error message.
  final String message;

  /// Whether the error is due to GitHub API rate limiting.
  final bool isRateLimited;

  /// When the rate limit resets (only set when [isRateLimited] is true).
  final DateTime? rateLimitResetsAt;

  /// When the check was attempted.
  final DateTime checkedAt;

  const UpdateCheckError({
    required this.message,
    this.isRateLimited = false,
    this.rateLimitResetsAt,
    required this.checkedAt,
  });

  @override
  String toString() =>
      'UpdateCheckError(message=$message, rateLimited=$isRateLimited)';
}
