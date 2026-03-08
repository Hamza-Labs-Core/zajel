import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../../../core/logging/logger_service.dart';
import '../models/github_release.dart';
import '../models/update_check_result.dart';

/// Service that queries the GitHub Releases API for the latest release.
///
/// Features:
/// - ETag-based conditional requests (304 Not Modified) to avoid rate limits
/// - In-memory caching with configurable duration
/// - Rate limit tracking and enforcement
/// - Version comparison to determine if an update is available
class GitHubReleaseService {
  static const _tag = 'UpdateCheck';

  /// GitHub owner/repo for release lookups.
  static const owner = 'Hamza-Labs-Core';
  static const repo = 'zajel';

  /// Cache duration for successful responses.
  static const cacheDuration = Duration(hours: 1);

  /// Request timeout.
  static const _requestTimeout = Duration(seconds: 15);

  final http.Client _client;

  // Pre-release channel
  bool _includePrerelease = false;

  // ETag caching
  String? _lastETag;
  GitHubRelease? _cachedRelease;
  DateTime? _lastCheckedAt;

  // Rate limit tracking
  DateTime? _rateLimitResetsAt;

  GitHubReleaseService({http.Client? client})
      : _client = client ?? http.Client();

  /// Whether to include pre-release builds when checking for updates.
  ///
  /// When changed, invalidates the ETag cache since the endpoint changes.
  set includePrerelease(bool value) {
    if (_includePrerelease == value) return;
    _includePrerelease = value;
    // Invalidate cache — different endpoint means different ETag
    _lastETag = null;
    _cachedRelease = null;
    _lastCheckedAt = null;
  }

  bool get includePrerelease => _includePrerelease;

  /// The cached release, if any.
  GitHubRelease? get cachedRelease => _cachedRelease;

  /// When the last successful check was performed.
  DateTime? get lastCheckedAt => _lastCheckedAt;

  /// Whether the service is currently rate-limited.
  bool get isRateLimited {
    if (_rateLimitResetsAt == null) return false;
    return DateTime.now().isBefore(_rateLimitResetsAt!);
  }

  /// Fetch the latest non-prerelease, non-draft release.
  ///
  /// Uses conditional requests (If-None-Match with ETag) to avoid
  /// counting against rate limits when the release hasn't changed.
  ///
  /// Returns a cached result if checked within [cacheDuration].
  ///
  /// Throws [RateLimitException] if rate-limited.
  /// Throws [GitHubApiException] on API errors.
  /// Throws [TimeoutException] on request timeout.
  /// Throws [SocketException] on network errors.
  Future<GitHubRelease> fetchLatestRelease() async {
    // Return cached if within cache duration
    if (_cachedRelease != null && _lastCheckedAt != null) {
      final elapsed = DateTime.now().difference(_lastCheckedAt!);
      if (elapsed < cacheDuration) {
        logger.debug(
            _tag, 'Returning cached release (${elapsed.inMinutes}m old)');
        return _cachedRelease!;
      }
    }

    // Check rate limit
    if (isRateLimited) {
      final remaining = _rateLimitResetsAt!.difference(DateTime.now());
      logger.warning(
        _tag,
        'Rate limited. Resets in ${remaining.inMinutes} minutes.',
      );
      throw RateLimitException(
        resetsAt: _rateLimitResetsAt!,
        message: 'Rate limited - try again in ${remaining.inMinutes} minutes',
      );
    }

    if (_includePrerelease) {
      return _fetchFromReleasesList();
    }
    return _fetchFromLatest();
  }

  /// Fetch from `/releases/latest` (stable channel, excludes prereleases).
  Future<GitHubRelease> _fetchFromLatest() async {
    final url = Uri.parse(
      'https://api.github.com/repos/$owner/$repo/releases/latest',
    );
    final response = await _sendRequest(url);
    return _handleSingleReleaseResponse(response);
  }

  /// Fetch from `/releases?per_page=10` and return the first non-draft release.
  Future<GitHubRelease> _fetchFromReleasesList() async {
    final url = Uri.parse(
      'https://api.github.com/repos/$owner/$repo/releases?per_page=10',
    );
    final response = await _sendRequest(url);

    // Track rate limit headers on all responses
    _trackRateLimit(response);

    switch (response.statusCode) {
      case 200:
        final list = jsonDecode(response.body) as List<dynamic>;
        for (final item in list) {
          final json = item as Map<String, dynamic>;
          final release = GitHubRelease.fromJson(json);
          if (!release.draft) {
            _cachedRelease = release;
            _lastCheckedAt = DateTime.now();
            _lastETag = response.headers['etag'];
            logger.info(_tag,
                'Fetched release (prerelease channel): ${release.tagName}');
            return release;
          }
        }
        throw const GitHubApiException(
          statusCode: 200,
          message: 'No suitable release found in releases list',
        );

      case 304:
        logger.info(_tag, 'Releases list unchanged (304 Not Modified)');
        _lastCheckedAt = DateTime.now();
        if (_cachedRelease != null) {
          return _cachedRelease!;
        }
        throw const GitHubApiException(
          statusCode: 304,
          message: 'Received 304 but no cached release available',
        );

      default:
        return _handleErrorResponse(response);
    }
  }

  /// Send a GET request with standard headers and ETag.
  Future<http.Response> _sendRequest(Uri url) async {
    final headers = <String, String>{
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Zajel-Desktop-Updater/1.0',
    };

    if (_lastETag != null) {
      headers['If-None-Match'] = _lastETag!;
    }

    logger.info(_tag, 'Fetching release from $url');

    return _client.get(url, headers: headers).timeout(_requestTimeout);
  }

  /// Handle a single-object release response (from `/releases/latest`).
  GitHubRelease _handleSingleReleaseResponse(http.Response response) {
    _trackRateLimit(response);

    switch (response.statusCode) {
      case 200:
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final release = GitHubRelease.fromJson(json);

        _cachedRelease = release;
        _lastCheckedAt = DateTime.now();
        _lastETag = response.headers['etag'];

        logger.info(_tag, 'Fetched release: ${release.tagName}');
        return release;

      case 304:
        logger.info(_tag, 'Release unchanged (304 Not Modified)');
        _lastCheckedAt = DateTime.now();
        if (_cachedRelease != null) {
          return _cachedRelease!;
        }
        throw const GitHubApiException(
          statusCode: 304,
          message: 'Received 304 but no cached release available',
        );

      default:
        return _handleErrorResponse(response);
    }
  }

  /// Handle 403, 404, and other error responses.
  Never _handleErrorResponse(http.Response response) {
    switch (response.statusCode) {
      case 403:
        final remaining = response.headers['x-ratelimit-remaining'];
        if (remaining == '0') {
          final resetStr = response.headers['x-ratelimit-reset'];
          if (resetStr != null) {
            final resetEpoch = int.tryParse(resetStr);
            if (resetEpoch != null) {
              _rateLimitResetsAt = DateTime.fromMillisecondsSinceEpoch(
                resetEpoch * 1000,
              );
            }
          }
          throw RateLimitException(
            resetsAt: _rateLimitResetsAt,
            message: 'GitHub API rate limit exceeded',
          );
        }
        throw GitHubApiException(
          statusCode: 403,
          message: 'Access forbidden: ${response.body}',
        );

      case 404:
        throw const GitHubApiException(
          statusCode: 404,
          message: 'Repository not accessible',
        );

      default:
        throw GitHubApiException(
          statusCode: response.statusCode,
          message: 'Unexpected response: ${response.statusCode}',
        );
    }
  }

  /// Check if an update is available by comparing [currentVersion]
  /// against the latest GitHub release.
  ///
  /// Returns one of [UpdateCheckUpToDate], [UpdateCheckAvailable],
  /// or [UpdateCheckError].
  Future<UpdateCheckResult> checkForUpdate(String currentVersion) async {
    final now = DateTime.now();
    final effectiveVersion = currentVersion.isEmpty ? '0.0.0' : currentVersion;

    try {
      final release = await fetchLatestRelease();
      final latestVersion = release.version;

      final comparison = compareVersions(effectiveVersion, latestVersion);

      if (comparison >= 0) {
        logger.info(
          _tag,
          'Up to date: $effectiveVersion >= $latestVersion',
        );
        return UpdateCheckUpToDate(
          currentVersion: currentVersion.isEmpty ? 'dev' : currentVersion,
          checkedAt: now,
        );
      }

      logger.info(
        _tag,
        'Update available: $effectiveVersion < $latestVersion',
      );
      return UpdateCheckAvailable(
        currentVersion: currentVersion.isEmpty ? 'dev' : currentVersion,
        latestVersion: latestVersion,
        releaseName: release.name,
        releaseNotes: _stripMarkdown(release.body),
        publishedAt: release.publishedAt,
        releaseUrl: release.htmlUrl,
        checkedAt: now,
      );
    } on RateLimitException catch (e) {
      logger.warning(_tag, 'Rate limited: ${e.message}');
      return UpdateCheckError(
        message: e.message,
        isRateLimited: true,
        rateLimitResetsAt: e.resetsAt,
        checkedAt: now,
      );
    } on TimeoutException {
      logger.warning(_tag, 'Request timed out');
      return UpdateCheckError(
        message: 'Request timed out',
        checkedAt: now,
      );
    } on SocketException {
      logger.warning(_tag, 'No internet connection');
      return UpdateCheckError(
        message: 'No internet connection',
        checkedAt: now,
      );
    } on FormatException catch (e) {
      logger.error(_tag, 'Invalid response from server', e);
      return UpdateCheckError(
        message: 'Invalid response from server',
        checkedAt: now,
      );
    } on GitHubApiException catch (e) {
      logger.error(_tag, 'GitHub API error: ${e.message}', e);
      return UpdateCheckError(
        message: e.message,
        checkedAt: now,
      );
    } catch (e) {
      logger.error(_tag, 'Unexpected error during update check', e);
      return UpdateCheckError(
        message: 'Could not check for updates',
        checkedAt: now,
      );
    }
  }

  /// Compare two semver version strings.
  ///
  /// Returns:
  /// - negative if a < b
  /// - zero if a == b
  /// - positive if a > b
  ///
  /// Strips leading "v" prefix, pre-release suffixes, and build metadata.
  static int compareVersions(String a, String b) {
    final aParts = parseVersion(a);
    final bParts = parseVersion(b);

    for (var i = 0; i < 3; i++) {
      final diff = aParts[i] - bParts[i];
      if (diff != 0) return diff;
    }
    return 0;
  }

  /// Parse a version string into [major, minor, patch].
  ///
  /// Strips leading "v", pre-release suffixes (e.g., "-beta"), and
  /// build metadata (e.g., "+42").
  static List<int> parseVersion(String version) {
    // Strip leading "v"
    var v = version;
    if (v.startsWith('v')) {
      v = v.substring(1);
    }
    // Strip pre-release and build metadata
    final cleanVersion = v.split('-').first.split('+').first;
    final parts = cleanVersion.split('.');
    return [
      parts.isNotEmpty ? (int.tryParse(parts[0]) ?? 0) : 0,
      parts.length > 1 ? (int.tryParse(parts[1]) ?? 0) : 0,
      parts.length > 2 ? (int.tryParse(parts[2]) ?? 0) : 0,
    ];
  }

  /// Strip basic markdown formatting from release notes and truncate
  /// to approximately 200 characters.
  static String _stripMarkdown(String markdown) {
    if (markdown.isEmpty) return '';

    var text = markdown
        // Remove headers
        .replaceAll(RegExp(r'^#{1,6}\s+', multiLine: true), '')
        // Remove bold/italic — use replaceAllMapped so capture groups work
        .replaceAllMapped(
            RegExp(r'\*{1,3}([^*]+)\*{1,3}'), (m) => m.group(1) ?? '')
        // Remove links, keep text — use replaceAllMapped for capture group
        .replaceAllMapped(
            RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m.group(1) ?? '')
        // Remove bullet points
        .replaceAll(RegExp(r'^[-*]\s+', multiLine: true), '')
        // Remove images
        .replaceAll(RegExp(r'!\[[^\]]*\]\([^)]+\)'), '')
        // Collapse whitespace
        .replaceAll(RegExp(r'\n{2,}'), '\n')
        .trim();

    if (text.length > 200) {
      text = '${text.substring(0, 197)}...';
    }

    return text;
  }

  void _trackRateLimit(http.Response response) {
    final remaining = response.headers['x-ratelimit-remaining'];
    final limit = response.headers['x-ratelimit-limit'];
    if (remaining != null && limit != null) {
      logger.debug(_tag, 'Rate limit: $remaining/$limit remaining');
    }
  }

  /// Dispose the HTTP client.
  void dispose() {
    _client.close();
  }
}

/// Exception thrown when the GitHub API rate limit is exceeded.
class RateLimitException implements Exception {
  final DateTime? resetsAt;
  final String message;

  const RateLimitException({this.resetsAt, required this.message});

  @override
  String toString() => 'RateLimitException: $message';
}

/// Exception thrown for GitHub API errors.
class GitHubApiException implements Exception {
  final int statusCode;
  final String message;

  const GitHubApiException({required this.statusCode, required this.message});

  @override
  String toString() => 'GitHubApiException($statusCode): $message';
}
