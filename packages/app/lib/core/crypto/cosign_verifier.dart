import 'dart:io';

import 'package:http/http.dart' as http;

import '../logging/logger_service.dart';

/// Verifies Sigstore/Cosign signatures for downloaded artifacts.
///
/// **Desktop-only**: This class shells out to the `cosign` CLI, which is
/// not available on mobile platforms (Android, iOS). On mobile, calling
/// [verifyArtifact] will throw [UnsupportedError].
///
/// For a pure Dart implementation (needed for mobile), we would need to:
/// 1. Parse the .sigstore.json bundle
/// 2. Verify the certificate chain against Fulcio root
/// 3. Verify the signature against the certificate's public key
/// 4. Check Rekor transparency log inclusion proof
///
/// For now, we shell out to cosign for simplicity.
class CosignVerifier {
  static const _tag = 'CosignVerifier';

  /// Expected GitHub repository for OIDC identity verification
  final String expectedRepository;

  /// Expected OIDC issuer (GitHub Actions)
  static const _expectedOidcIssuer =
      'https://token.actions.githubusercontent.com';

  CosignVerifier({required this.expectedRepository});

  /// Verify a downloaded artifact using its Sigstore bundle.
  ///
  /// Returns `true` if:
  /// 1. The signature is cryptographically valid
  /// 2. The certificate's OIDC identity matches [expectedRepository]
  /// 3. The certificate was issued by Fulcio
  /// 4. The signature is logged in Rekor
  Future<bool> verifyArtifact(File artifactFile, File bundleFile) async {
    if (!await artifactFile.exists()) {
      logger.error(_tag, 'Artifact file does not exist: ${artifactFile.path}');
      return false;
    }

    if (!await bundleFile.exists()) {
      logger.error(_tag, 'Bundle file does not exist: ${bundleFile.path}');
      return false;
    }

    try {
      // Guard: not supported on mobile platforms
      if (Platform.isAndroid || Platform.isIOS) {
        throw UnsupportedError(
          'cosign CLI verification is not available on mobile platforms.',
        );
      }

      // Check if cosign is installed (cross-platform)
      final findCmd = Platform.isWindows ? 'where.exe' : 'which';
      final whichResult = await Process.run(findCmd, ['cosign']);
      if (whichResult.exitCode != 0) {
        logger.error(_tag, 'cosign is not installed. Cannot verify artifact.');
        return false;
      }

      // Run cosign verify-blob
      final result = await Process.run('cosign', [
        'verify-blob',
        artifactFile.path,
        '--bundle',
        bundleFile.path,
        '--certificate-identity-regexp',
        '^https://github.com/$expectedRepository/',
        '--certificate-oidc-issuer',
        _expectedOidcIssuer,
      ]);

      if (result.exitCode == 0) {
        logger.info(_tag, 'Artifact signature verified: ${artifactFile.path}');
        return true;
      } else {
        logger.warning(
          _tag,
          'Artifact signature verification failed: ${result.stderr}',
        );
        return false;
      }
    } catch (e) {
      logger.error(_tag, 'Exception during signature verification: $e');
      return false;
    }
  }

  /// Download a release artifact and its Sigstore bundle from GitHub.
  ///
  /// Returns a tuple of (artifactFile, bundleFile) on success, or null on failure.
  Future<(File, File)?> downloadArtifact({
    required String releaseTag,
    required String artifactName,
    required Directory downloadDir,
  }) async {
    final artifactUrl =
        'https://github.com/$expectedRepository/releases/download/$releaseTag/$artifactName';
    final bundleUrl = '$artifactUrl.sigstore.json';

    try {
      // Download artifact
      final artifactResponse = await http.get(Uri.parse(artifactUrl));
      if (artifactResponse.statusCode != 200) {
        logger.error(
          _tag,
          'Failed to download artifact: ${artifactResponse.statusCode}',
        );
        return null;
      }

      // Download bundle
      final bundleResponse = await http.get(Uri.parse(bundleUrl));
      if (bundleResponse.statusCode != 200) {
        logger.error(
          _tag,
          'Failed to download bundle: ${bundleResponse.statusCode}',
        );
        return null;
      }

      // Write to files
      final artifactFile = File('${downloadDir.path}/$artifactName');
      final bundleFile = File(
        '${downloadDir.path}/$artifactName.sigstore.json',
      );

      await artifactFile.writeAsBytes(artifactResponse.bodyBytes);
      await bundleFile.writeAsString(bundleResponse.body);

      logger.info(
        _tag,
        'Downloaded artifact and bundle to ${downloadDir.path}',
      );
      return (artifactFile, bundleFile);
    } catch (e) {
      logger.error(_tag, 'Exception during artifact download: $e');
      return null;
    }
  }

  /// Download and verify a release artifact in one call.
  Future<File?> downloadAndVerify({
    required String releaseTag,
    required String artifactName,
    required Directory downloadDir,
  }) async {
    final result = await downloadArtifact(
      releaseTag: releaseTag,
      artifactName: artifactName,
      downloadDir: downloadDir,
    );

    if (result == null) return null;

    final (artifactFile, bundleFile) = result;
    final isValid = await verifyArtifact(artifactFile, bundleFile);

    if (!isValid) {
      logger.error(_tag, 'Artifact verification failed, deleting files');
      await artifactFile.delete();
      await bundleFile.delete();
      return null;
    }

    return artifactFile;
  }
}
