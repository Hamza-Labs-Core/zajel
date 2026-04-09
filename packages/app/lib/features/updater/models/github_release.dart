/// Model for a GitHub release from the Releases API.
///
/// Parses the JSON response from
/// `GET https://api.github.com/repos/{owner}/{repo}/releases/latest`.
///
/// Note: The `/releases/latest` endpoint already excludes prereleases and
/// drafts. The [prerelease] and [draft] fields are included for completeness
/// and in case the caller switches to the `/releases` list endpoint, where
/// manual filtering is required.
class GitHubRelease {
  /// Tag name, e.g., "v1.2.0".
  final String tagName;

  /// Semver version extracted from tag (strips leading "v").
  String get version =>
      tagName.startsWith('v') ? tagName.substring(1) : tagName;

  /// Release title.
  final String name;

  /// Release body (markdown).
  final String body;

  /// Whether this is a prerelease.
  final bool prerelease;

  /// Whether this is a draft.
  final bool draft;

  /// Publication timestamp.
  final DateTime publishedAt;

  /// HTML URL for the release page.
  final String htmlUrl;

  /// List of attached assets.
  final List<GitHubReleaseAsset> assets;

  /// Raw content of the checksums.txt asset, if present.
  /// Contains lines of "sha256hash  filename" pairs.
  final String? checksumContent;

  const GitHubRelease({
    required this.tagName,
    required this.name,
    required this.body,
    required this.prerelease,
    required this.draft,
    required this.publishedAt,
    required this.htmlUrl,
    this.assets = const [],
    this.checksumContent,
  });

  /// Creates a [GitHubRelease] from the GitHub API JSON response.
  ///
  /// Throws [FormatException] if [tagName] is missing.
  factory GitHubRelease.fromJson(Map<String, dynamic> json) {
    final tagName = json['tag_name'];
    if (tagName is! String || tagName.isEmpty) {
      throw const FormatException(
        'Missing or invalid "tag_name" field in GitHub release response',
      );
    }

    final assetsJson = json['assets'] as List<dynamic>? ?? [];
    final assets = assetsJson
        .whereType<Map<String, dynamic>>()
        .map(GitHubReleaseAsset.fromJson)
        .toList();

    final publishedAtStr = json['published_at'] as String?;
    final publishedAt = publishedAtStr != null
        ? DateTime.tryParse(publishedAtStr) ?? DateTime.now()
        : DateTime.now();

    return GitHubRelease(
      tagName: tagName,
      name: json['name'] as String? ?? tagName,
      body: json['body'] as String? ?? '',
      prerelease: json['prerelease'] as bool? ?? false,
      draft: json['draft'] as bool? ?? false,
      publishedAt: publishedAt,
      htmlUrl: json['html_url'] as String? ?? '',
      assets: assets,
    );
  }

  /// Serializes this release to a JSON map (for testing/caching).
  Map<String, dynamic> toJson() => {
        'tag_name': tagName,
        'name': name,
        'body': body,
        'prerelease': prerelease,
        'draft': draft,
        'published_at': publishedAt.toUtc().toIso8601String(),
        'html_url': htmlUrl,
        'assets': assets.map((a) => a.toJson()).toList(),
      };

  /// Returns a copy of this release with the checksums.txt content attached.
  GitHubRelease withChecksumContent(String content) {
    return GitHubRelease(
      tagName: tagName,
      name: name,
      body: body,
      prerelease: prerelease,
      draft: draft,
      publishedAt: publishedAt,
      htmlUrl: htmlUrl,
      assets: assets,
      checksumContent: content,
    );
  }

  /// Platform suffixes used to match assets to the current platform.
  static const _platformSuffixes = {
    'windows': ['-windows.zip'],
    'macos': ['-macos.dmg', '-macos.zip'],
    'linux': ['-linux.AppImage', '-linux.tar.gz'],
  };

  /// Returns the release asset appropriate for the given [platform].
  ///
  /// The [platform] should be "windows", "macos", or "linux".
  /// Returns `null` if no matching asset is found.
  GitHubReleaseAsset? getAssetForPlatform(String platform) {
    final suffixes = _platformSuffixes[platform];
    if (suffixes == null) return null;

    for (final suffix in suffixes) {
      for (final asset in assets) {
        if (asset.name.endsWith(suffix)) {
          return asset;
        }
      }
    }
    return null;
  }

  /// Returns the checksums.txt asset, if present.
  GitHubReleaseAsset? get checksumsAsset {
    for (final asset in assets) {
      if (asset.name == 'checksums.txt') {
        return asset;
      }
    }
    return null;
  }

  /// Parses the SHA-256 checksum for a specific asset from [checksumContent].
  ///
  /// The checksums.txt format is one line per file:
  /// ```
  /// abc123def456...  zajel-1.2.0-windows.zip
  /// 789abc012def...  zajel-1.2.0-linux.tar.gz
  /// ```
  ///
  /// Returns `null` if [checksumContent] is null or the asset is not found.
  String? getChecksumForAsset(String assetName) {
    if (checksumContent == null) return null;

    final lines = checksumContent!.split('\n');
    for (final line in lines) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;

      // Format: "hash  filename" (two spaces between hash and filename)
      // Also handle single space for flexibility.
      final parts = trimmed.split(RegExp(r'\s+'));
      if (parts.length >= 2 && parts.last == assetName) {
        return parts.first;
      }
    }
    return null;
  }

  @override
  String toString() => 'GitHubRelease('
      'tag=$tagName, '
      'name=$name, '
      'assets=${assets.length}, '
      'published=$publishedAt)';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GitHubRelease &&
          runtimeType == other.runtimeType &&
          tagName == other.tagName &&
          publishedAt == other.publishedAt;

  @override
  int get hashCode => Object.hash(tagName, publishedAt);
}

/// Model for a single asset attached to a GitHub release.
class GitHubReleaseAsset {
  /// File name of the asset (e.g., "zajel-1.2.0-windows.zip").
  final String name;

  /// Direct download URL for the asset.
  final String browserDownloadUrl;

  /// Size of the asset in bytes.
  final int size;

  /// MIME content type.
  final String contentType;

  const GitHubReleaseAsset({
    required this.name,
    required this.browserDownloadUrl,
    required this.size,
    required this.contentType,
  });

  factory GitHubReleaseAsset.fromJson(Map<String, dynamic> json) {
    return GitHubReleaseAsset(
      name: json['name'] as String? ?? '',
      browserDownloadUrl: json['browser_download_url'] as String? ?? '',
      size: json['size'] as int? ?? 0,
      contentType:
          json['content_type'] as String? ?? 'application/octet-stream',
    );
  }

  Map<String, dynamic> toJson() => {
        'name': name,
        'browser_download_url': browserDownloadUrl,
        'size': size,
        'content_type': contentType,
      };

  @override
  String toString() => 'GitHubReleaseAsset(name=$name, size=$size)';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GitHubReleaseAsset &&
          runtimeType == other.runtimeType &&
          name == other.name &&
          browserDownloadUrl == other.browserDownloadUrl &&
          size == other.size;

  @override
  int get hashCode => Object.hash(name, browserDownloadUrl, size);
}
