import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../logging/logger_service.dart';
import 'cosign_verifier.dart';

/// Service for downloading and verifying release artifacts using Sigstore.
///
/// This is separate from VersionCheckService (which evaluates version policies)
/// because artifact download/verification is a distinct concern.
///
/// IMPORTANT: This service is desktop-only. On mobile platforms (Android, iOS),
/// the cosign CLI is not available and [downloadVerifiedUpdate] will throw
/// [UnsupportedError].
class ArtifactVerificationService {
  static const _tag = 'ArtifactVerificationService';

  final String expectedRepository;

  ArtifactVerificationService({this.expectedRepository = 'zajel/zajel'});

  /// Download and verify a new app version using Sigstore.
  ///
  /// This is intended for future auto-update functionality on desktop platforms.
  /// Throws [UnsupportedError] on mobile platforms (Android, iOS).
  Future<File?> downloadVerifiedUpdate({
    required String version,
    required String platform,
  }) async {
    // Guard: only supported on desktop platforms
    if (Platform.isAndroid || Platform.isIOS) {
      throw UnsupportedError(
        'Artifact verification via cosign CLI is not supported on mobile platforms. '
        'A pure Dart Sigstore implementation is needed for mobile.',
      );
    }

    final verifier = CosignVerifier(expectedRepository: expectedRepository);

    // Determine artifact name based on platform
    final artifactName = switch (platform) {
      'windows' => 'zajel-$version-windows.zip',
      'macos' => 'zajel-$version-macos.dmg',
      'linux' => 'zajel-$version-linux.tar.gz',
      _ => throw ArgumentError('Unsupported platform: $platform'),
    };

    final downloadDir = await getTemporaryDirectory();

    logger.info(_tag, 'Downloading verified update: $artifactName');

    return await verifier.downloadAndVerify(
      releaseTag: 'v$version',
      artifactName: artifactName,
      downloadDir: downloadDir,
    );
  }
}
