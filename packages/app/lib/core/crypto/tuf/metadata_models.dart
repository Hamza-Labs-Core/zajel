/// TUF Key object
class TufKey {
  final String keytype;
  final String scheme;
  final String keyval;

  const TufKey(
      {required this.keytype, required this.scheme, required this.keyval});

  factory TufKey.fromJson(Map<String, dynamic> json) => TufKey(
        keytype: json['keytype'] as String,
        scheme: json['scheme'] as String,
        keyval: json['keyval'] as String,
      );

  Map<String, dynamic> toJson() => {
        'keytype': keytype,
        'keyval': keyval,
        'scheme': scheme,
      };
}

/// TUF Role configuration
class TufRole {
  final int threshold;
  final List<String> keyids;

  const TufRole({required this.threshold, required this.keyids});

  factory TufRole.fromJson(Map<String, dynamic> json) => TufRole(
        threshold: json['threshold'] as int,
        keyids: (json['keyids'] as List).cast<String>(),
      );

  Map<String, dynamic> toJson() => {
        'keyids': keyids,
        'threshold': threshold,
      };
}

/// Root metadata (unsigned portion)
class RootMetadata {
  final String type;
  final String specVersion;
  final int version;
  final String expires;
  final Map<String, TufKey> keys;
  final Map<String, TufRole> roles;
  final bool consistentSnapshot;

  const RootMetadata({
    required this.type,
    required this.specVersion,
    required this.version,
    required this.expires,
    required this.keys,
    required this.roles,
    required this.consistentSnapshot,
  });

  factory RootMetadata.fromJson(Map<String, dynamic> json) => RootMetadata(
        type: json['_type'] as String,
        specVersion: json['spec_version'] as String,
        version: json['version'] as int,
        expires: json['expires'] as String,
        keys: (json['keys'] as Map<String, dynamic>).map(
          (k, v) => MapEntry(k, TufKey.fromJson(v as Map<String, dynamic>)),
        ),
        roles: (json['roles'] as Map<String, dynamic>).map(
          (k, v) => MapEntry(k, TufRole.fromJson(v as Map<String, dynamic>)),
        ),
        consistentSnapshot: json['consistent_snapshot'] as bool,
      );

  Map<String, dynamic> toJson() => {
        '_type': type,
        'consistent_snapshot': consistentSnapshot,
        'expires': expires,
        'keys': keys.map((k, v) => MapEntry(k, v.toJson())),
        'roles': roles.map((k, v) => MapEntry(k, v.toJson())),
        'spec_version': specVersion,
        'version': version,
      };
}

/// Target file metadata
class TargetFile {
  final int length;
  final Map<String, String> hashes;
  final Map<String, dynamic> custom;

  const TargetFile(
      {required this.length, required this.hashes, required this.custom});

  factory TargetFile.fromJson(Map<String, dynamic> json) => TargetFile(
        length: json['length'] as int,
        hashes: (json['hashes'] as Map<String, dynamic>).cast<String, String>(),
        custom: json['custom'] as Map<String, dynamic>,
      );

  Map<String, dynamic> toJson() => {
        'custom': custom,
        'hashes': hashes,
        'length': length,
      };
}

/// Targets metadata (unsigned portion)
class TargetsMetadata {
  final String type;
  final String specVersion;
  final int version;
  final String expires;
  final Map<String, TargetFile> targets;
  final dynamic delegations;

  const TargetsMetadata({
    required this.type,
    required this.specVersion,
    required this.version,
    required this.expires,
    required this.targets,
    required this.delegations,
  });

  factory TargetsMetadata.fromJson(Map<String, dynamic> json) =>
      TargetsMetadata(
        type: json['_type'] as String,
        specVersion: json['spec_version'] as String,
        version: json['version'] as int,
        expires: json['expires'] as String,
        targets: (json['targets'] as Map<String, dynamic>).map(
          (k, v) => MapEntry(k, TargetFile.fromJson(v as Map<String, dynamic>)),
        ),
        delegations: json['delegations'],
      );

  Map<String, dynamic> toJson() => {
        '_type': type,
        'delegations': delegations,
        'expires': expires,
        'spec_version': specVersion,
        'targets': targets.map((k, v) => MapEntry(k, v.toJson())),
        'version': version,
      };
}

/// Snapshot metadata file entry
class SnapshotMeta {
  final int version;
  final Map<String, String>? hashes;

  const SnapshotMeta({required this.version, this.hashes});

  factory SnapshotMeta.fromJson(Map<String, dynamic> json) => SnapshotMeta(
        version: json['version'] as int,
        hashes: json['hashes'] != null
            ? (json['hashes'] as Map<String, dynamic>).cast<String, String>()
            : null,
      );

  Map<String, dynamic> toJson() => {
        if (hashes != null) 'hashes': hashes,
        'version': version,
      };
}

/// Snapshot metadata (unsigned portion)
class SnapshotMetadata {
  final String type;
  final String specVersion;
  final int version;
  final String expires;
  final Map<String, SnapshotMeta> meta;

  const SnapshotMetadata({
    required this.type,
    required this.specVersion,
    required this.version,
    required this.expires,
    required this.meta,
  });

  factory SnapshotMetadata.fromJson(Map<String, dynamic> json) =>
      SnapshotMetadata(
        type: json['_type'] as String,
        specVersion: json['spec_version'] as String,
        version: json['version'] as int,
        expires: json['expires'] as String,
        meta: (json['meta'] as Map<String, dynamic>).map(
          (k, v) =>
              MapEntry(k, SnapshotMeta.fromJson(v as Map<String, dynamic>)),
        ),
      );

  Map<String, dynamic> toJson() => {
        '_type': type,
        'expires': expires,
        'meta': meta.map((k, v) => MapEntry(k, v.toJson())),
        'spec_version': specVersion,
        'version': version,
      };
}

/// Timestamp metadata file entry
class TimestampMeta {
  final int version;
  final Map<String, String> hashes;

  const TimestampMeta({required this.version, required this.hashes});

  factory TimestampMeta.fromJson(Map<String, dynamic> json) => TimestampMeta(
        version: json['version'] as int,
        hashes: (json['hashes'] as Map<String, dynamic>).cast<String, String>(),
      );

  Map<String, dynamic> toJson() => {
        'hashes': hashes,
        'version': version,
      };
}

/// Timestamp metadata (unsigned portion)
class TimestampMetadata {
  final String type;
  final String specVersion;
  final int version;
  final String expires;
  final Map<String, TimestampMeta> meta;

  const TimestampMetadata({
    required this.type,
    required this.specVersion,
    required this.version,
    required this.expires,
    required this.meta,
  });

  factory TimestampMetadata.fromJson(Map<String, dynamic> json) =>
      TimestampMetadata(
        type: json['_type'] as String,
        specVersion: json['spec_version'] as String,
        version: json['version'] as int,
        expires: json['expires'] as String,
        meta: (json['meta'] as Map<String, dynamic>).map(
          (k, v) =>
              MapEntry(k, TimestampMeta.fromJson(v as Map<String, dynamic>)),
        ),
      );

  Map<String, dynamic> toJson() => {
        '_type': type,
        'expires': expires,
        'meta': meta.map((k, v) => MapEntry(k, v.toJson())),
        'spec_version': specVersion,
        'version': version,
      };
}

/// Signature entry
class TufSignature {
  final String keyid;
  final String sig;

  const TufSignature({required this.keyid, required this.sig});

  factory TufSignature.fromJson(Map<String, dynamic> json) => TufSignature(
        keyid: json['keyid'] as String,
        sig: json['sig'] as String,
      );

  Map<String, dynamic> toJson() => {
        'keyid': keyid,
        'sig': sig,
      };
}

/// Signed metadata envelope (generic)
class SignedMetadata<T> {
  final T signed;
  final List<TufSignature> signatures;

  const SignedMetadata({required this.signed, required this.signatures});

  factory SignedMetadata.fromJson(
    Map<String, dynamic> json,
    T Function(Map<String, dynamic>) fromJsonT,
  ) =>
      SignedMetadata(
        signed: fromJsonT(json['signed'] as Map<String, dynamic>),
        signatures: (json['signatures'] as List)
            .map((s) => TufSignature.fromJson(s as Map<String, dynamic>))
            .toList(),
      );

  Map<String, dynamic> toJson(Map<String, dynamic> Function(T) toJsonT) => {
        'signatures': signatures.map((s) => s.toJson()).toList(),
        'signed': toJsonT(signed),
      };
}
