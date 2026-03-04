/// Re-exports the unified GitHub release models.
///
/// The [ReleaseAsset] and [GitHubRelease] classes that were previously in
/// this file have been merged into `github_release.dart` as
/// [GitHubReleaseAsset] and [GitHubRelease].
///
/// This file provides backward-compatible type aliases so that existing
/// imports continue to work.
library;

import 'github_release.dart';

export 'github_release.dart' show GitHubRelease, GitHubReleaseAsset;

/// Backward-compatible type alias for [GitHubReleaseAsset].
///
/// Prefer using [GitHubReleaseAsset] directly in new code.
typedef ReleaseAsset = GitHubReleaseAsset;
