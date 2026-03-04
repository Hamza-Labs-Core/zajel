import 'dart:convert';
import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';
import 'package:crypto/crypto.dart' as crypto_hash;
import '../../logging/logger_service.dart';
import 'metadata_models.dart';

/// TUF metadata verifier implementing TUF Specification v1.0.31 section 5.
///
/// Verifies the full TUF metadata chain: Timestamp -> Snapshot -> Targets -> Root.
/// Enforces:
/// - Signature verification (Ed25519)
/// - Expiration checking
/// - Version monotonicity (rollback protection)
/// - Hash consistency (mix-and-match protection)
class TufVerifier {
  final Ed25519 _ed25519 = Ed25519();

  /// Cached root metadata (trusted after initial bootstrap or update)
  RootMetadata? _trustedRoot;
  Map<String, TufKey>? _trustedKeys;
  Map<String, TufRole>? _trustedRoles;

  /// Version tracking for rollback protection
  int? _lastTimestampVersion;
  int? _lastSnapshotVersion;
  int? _lastTargetsVersion;
  int? _lastRootVersion;

  TufVerifier();

  /// Whether the verifier has been bootstrapped with a root metadata.
  bool get isBootstrapped => _trustedRoot != null;

  /// Bootstrap the verifier with an embedded root metadata.
  /// This is the trust anchor for the entire TUF workflow.
  Future<void> bootstrapWithRoot(
      SignedMetadata<RootMetadata> rootMetadata) async {
    // Verify self-signed root metadata
    final isValid = await _verifyMetadataSignatures(
      rootMetadata.signed,
      rootMetadata.signatures,
      rootMetadata.signed.keys,
      rootMetadata.signed.roles['root']!,
    );

    if (!isValid) {
      throw TufVerificationException('Root metadata has invalid signatures');
    }

    if (_isExpired(rootMetadata.signed.expires)) {
      throw TufVerificationException('Root metadata has expired');
    }

    _trustedRoot = rootMetadata.signed;
    _trustedKeys = rootMetadata.signed.keys;
    _trustedRoles = rootMetadata.signed.roles;
    _lastRootVersion = rootMetadata.signed.version;

    logger.info('TufVerifier',
        'Bootstrapped with root v${rootMetadata.signed.version}');
  }

  /// Update to a new root metadata (N->N+1 transition).
  /// Implements TUF spec section 5.3 (root key rotation).
  Future<void> updateRoot(SignedMetadata<RootMetadata> newRootMetadata) async {
    if (_trustedRoot == null) {
      throw TufVerificationException(
          'No trusted root -- call bootstrapWithRoot first');
    }

    final newRoot = newRootMetadata.signed;

    // TUF spec 5.3.4: Check for rollback and version increment
    if (_lastRootVersion != null && newRoot.version <= _lastRootVersion!) {
      throw TufVerificationException(
        'Root version rollback detected: ${newRoot.version} <= $_lastRootVersion',
      );
    }
    if (newRoot.version != _trustedRoot!.version + 1) {
      throw TufVerificationException(
        'Root version must increment by 1: expected ${_trustedRoot!.version + 1}, got ${newRoot.version}',
      );
    }

    // TUF spec 5.3.5: Verify signatures using old root's key
    final isValidOld = await _verifyMetadataSignatures(
      newRoot,
      newRootMetadata.signatures,
      _trustedKeys!,
      _trustedRoles!['root']!,
    );

    if (!isValidOld) {
      throw TufVerificationException('New root is not signed by old root key');
    }

    // TUF spec 5.3.7: Verify signatures using new root's key
    final isValidNew = await _verifyMetadataSignatures(
      newRoot,
      newRootMetadata.signatures,
      newRoot.keys,
      newRoot.roles['root']!,
    );

    if (!isValidNew) {
      throw TufVerificationException('New root is not self-signed correctly');
    }

    // TUF spec 5.3.8: Check expiration
    if (_isExpired(newRoot.expires)) {
      throw TufVerificationException('New root metadata has expired');
    }

    // Accept the new root
    _trustedRoot = newRoot;
    _trustedKeys = newRoot.keys;
    _trustedRoles = newRoot.roles;
    _lastRootVersion = newRoot.version;

    logger.info('TufVerifier', 'Updated root to v${newRoot.version}');
  }

  /// Verify the full TUF metadata chain and extract server targets.
  /// Implements TUF spec section 5.1 (update workflow).
  Future<List<Map<String, dynamic>>> verifyAndExtractTargets({
    required SignedMetadata<TimestampMetadata> timestamp,
    required SignedMetadata<SnapshotMetadata> snapshot,
    required SignedMetadata<TargetsMetadata> targets,
  }) async {
    if (_trustedRoot == null) {
      throw TufVerificationException(
          'No trusted root -- call bootstrapWithRoot first');
    }

    // === Step 1: Verify Timestamp metadata ===
    final timestampMeta = timestamp.signed;

    // TUF spec 5.1.2: Verify timestamp signatures
    final timestampValid = await _verifyMetadataSignatures(
      timestampMeta,
      timestamp.signatures,
      _trustedKeys!,
      _trustedRoles!['timestamp']!,
    );
    if (!timestampValid) {
      throw TufVerificationException(
          'Timestamp metadata has invalid signatures');
    }

    // TUF spec 5.1.3: Check timestamp expiration
    if (_isExpired(timestampMeta.expires)) {
      throw TufVerificationException('Timestamp metadata has expired');
    }

    // TUF spec 5.1.4: Check version is not older than last seen
    if (_lastTimestampVersion != null &&
        timestampMeta.version < _lastTimestampVersion!) {
      throw TufVerificationException(
        'Timestamp version rollback detected: ${timestampMeta.version} < $_lastTimestampVersion',
      );
    }
    _lastTimestampVersion = timestampMeta.version;

    // === Step 2: Verify Snapshot metadata ===
    final snapshotMeta = snapshot.signed;

    // TUF spec 5.1.6: Verify snapshot hash from timestamp
    final snapshotJson = _canonicalJson(snapshotMeta.toJson());
    final snapshotHash = _sha256(snapshotJson);
    final expectedSnapshotHash =
        timestampMeta.meta['snapshot.json']!.hashes['sha256']!;
    if (snapshotHash != expectedSnapshotHash) {
      throw TufVerificationException(
          'Snapshot hash mismatch (timestamp metadata is inconsistent)');
    }

    // TUF spec 5.1.7: Check snapshot version from timestamp
    final expectedSnapshotVersion =
        timestampMeta.meta['snapshot.json']!.version;
    if (snapshotMeta.version != expectedSnapshotVersion) {
      throw TufVerificationException(
        'Snapshot version mismatch: expected $expectedSnapshotVersion, got ${snapshotMeta.version}',
      );
    }

    // TUF spec 5.1.8: Verify snapshot signatures
    final snapshotValid = await _verifyMetadataSignatures(
      snapshotMeta,
      snapshot.signatures,
      _trustedKeys!,
      _trustedRoles!['snapshot']!,
    );
    if (!snapshotValid) {
      throw TufVerificationException(
          'Snapshot metadata has invalid signatures');
    }

    // TUF spec 5.1.9: Check snapshot expiration
    if (_isExpired(snapshotMeta.expires)) {
      throw TufVerificationException('Snapshot metadata has expired');
    }

    // TUF spec 5.1.10: Check version is not older than last seen
    if (_lastSnapshotVersion != null &&
        snapshotMeta.version < _lastSnapshotVersion!) {
      throw TufVerificationException(
        'Snapshot version rollback detected: ${snapshotMeta.version} < $_lastSnapshotVersion',
      );
    }
    _lastSnapshotVersion = snapshotMeta.version;

    // === Step 3: Verify Targets metadata ===
    final targetsMeta = targets.signed;

    // TUF spec 5.1.12: Verify targets hash from snapshot
    final targetsJson = _canonicalJson(targetsMeta.toJson());
    final targetsHash = _sha256(targetsJson);
    final expectedTargetsHash =
        snapshotMeta.meta['targets.json']!.hashes!['sha256']!;
    if (targetsHash != expectedTargetsHash) {
      throw TufVerificationException(
          'Targets hash mismatch (snapshot metadata is inconsistent)');
    }

    // TUF spec 5.1.13: Check targets version from snapshot
    final expectedTargetsVersion = snapshotMeta.meta['targets.json']!.version;
    if (targetsMeta.version != expectedTargetsVersion) {
      throw TufVerificationException(
        'Targets version mismatch: expected $expectedTargetsVersion, got ${targetsMeta.version}',
      );
    }

    // TUF spec 5.1.14: Verify targets signatures
    final targetsValid = await _verifyMetadataSignatures(
      targetsMeta,
      targets.signatures,
      _trustedKeys!,
      _trustedRoles!['targets']!,
    );
    if (!targetsValid) {
      throw TufVerificationException('Targets metadata has invalid signatures');
    }

    // TUF spec 5.1.15: Check targets expiration
    if (_isExpired(targetsMeta.expires)) {
      throw TufVerificationException('Targets metadata has expired');
    }

    // TUF spec 5.1.16: Check version is not older than last seen
    if (_lastTargetsVersion != null &&
        targetsMeta.version < _lastTargetsVersion!) {
      throw TufVerificationException(
        'Targets version rollback detected: ${targetsMeta.version} < $_lastTargetsVersion',
      );
    }
    _lastTargetsVersion = targetsMeta.version;

    // === Step 4: Extract server list from targets ===
    final servers = <Map<String, dynamic>>[];
    for (final entry in targetsMeta.targets.entries) {
      if (entry.key.startsWith('servers/')) {
        servers.add(entry.value.custom);
      }
    }

    logger.info('TufVerifier',
        'Verified TUF metadata chain: ${servers.length} servers');
    return servers;
  }

  /// Verify Ed25519 signatures on a metadata object.
  /// Implements TUF threshold signature verification.
  Future<bool> _verifyMetadataSignatures(
    dynamic metadata,
    List<TufSignature> signatures,
    Map<String, TufKey> keys,
    TufRole role,
  ) async {
    // Canonical JSON serialization (TUF spec requires sorted keys)
    final canonicalJsonStr =
        _canonicalJson(metadata.toJson() as Map<String, dynamic>);
    final data = Uint8List.fromList(utf8.encode(canonicalJsonStr));

    int validSignatures = 0;

    for (final signature in signatures) {
      // Check if this signature is from an authorized key for this role
      if (!role.keyids.contains(signature.keyid)) {
        continue;
      }

      final key = keys[signature.keyid];
      if (key == null) {
        continue;
      }

      try {
        final publicKeyBytes = base64Decode(key.keyval);
        final publicKey =
            SimplePublicKey(publicKeyBytes, type: KeyPairType.ed25519);
        final signatureBytes = base64Decode(signature.sig);
        final sig = Signature(signatureBytes, publicKey: publicKey);

        final isValid = await _ed25519.verify(data, signature: sig);
        if (isValid) {
          validSignatures++;
          if (validSignatures >= role.threshold) {
            return true;
          }
        }
      } catch (e) {
        logger.warning(
            'TufVerifier', 'Signature verification threw exception: $e');
        continue;
      }
    }

    return false;
  }

  /// Recursive canonical JSON serialization (sorted keys at all nesting levels).
  /// Must match the server-side canonicalJSON() in metadata.js exactly.
  String _canonicalJson(dynamic obj) {
    if (obj == null) return 'null';
    if (obj is! Map && obj is! List) return jsonEncode(obj);
    if (obj is List) return '[${obj.map(_canonicalJson).join(',')}]';
    final map = obj as Map<String, dynamic>;
    final keys = map.keys.toList()..sort();
    final pairs = keys.map((k) => '"$k":${_canonicalJson(map[k])}');
    return '{${pairs.join(',')}}';
  }

  /// Compute SHA256 hash of a string.
  String _sha256(String data) {
    final bytes = utf8.encode(data);
    final digest = crypto_hash.sha256.convert(bytes);
    return digest.toString();
  }

  /// Check if an ISO 8601 timestamp is expired.
  bool _isExpired(String expiresISO) {
    final expiry = DateTime.parse(expiresISO);
    return expiry.isBefore(DateTime.now());
  }
}

class TufVerificationException implements Exception {
  final String message;
  TufVerificationException(this.message);

  @override
  String toString() => 'TufVerificationException: $message';
}
