import 'dart:convert';

import 'package:equatable/equatable.dart';

/// Role within a channel.
///
/// - [owner]: Holds the master Ed25519 private key. Can publish, appoint/remove
///   admins, rotate encryption keys, receive upstream, and update the manifest.
/// - [admin]: Holds a delegated Ed25519 signing key. Can publish content signed
///   with their key. Cannot appoint admins, rotate keys, or modify the manifest.
/// - [subscriber]: Holds the channel decryption key only. Can read broadcasts,
///   send upstream (replies/votes), and seed chunks to other subscribers.
enum ChannelRole { owner, admin, subscriber }

/// An admin entry in the channel manifest.
class AdminKey extends Equatable {
  /// The admin's Ed25519 public key, base64-encoded.
  final String key;

  /// A plaintext label for this admin (e.g., display name).
  /// Note: The manifest itself is only readable by channel members who hold
  /// the decryption key, so individual field encryption is not needed here.
  final String label;

  const AdminKey({required this.key, required this.label});

  Map<String, dynamic> toJson() => {'key': key, 'label': label};

  factory AdminKey.fromJson(Map<String, dynamic> json) => AdminKey(
        key: json['key'] as String,
        label: json['label'] as String,
      );

  @override
  List<Object?> get props => [key, label];
}

/// Rules governing channel behavior, included in the manifest.
class ChannelRules extends Equatable {
  final bool repliesEnabled;
  final bool pollsEnabled;
  final int maxUpstreamSize;

  const ChannelRules({
    this.repliesEnabled = true,
    this.pollsEnabled = true,
    this.maxUpstreamSize = 4096,
  });

  Map<String, dynamic> toJson() => {
        'replies_enabled': repliesEnabled,
        'polls_enabled': pollsEnabled,
        'max_upstream_size': maxUpstreamSize,
      };

  factory ChannelRules.fromJson(Map<String, dynamic> json) => ChannelRules(
        repliesEnabled: json['replies_enabled'] as bool? ?? true,
        pollsEnabled: json['polls_enabled'] as bool? ?? true,
        maxUpstreamSize: json['max_upstream_size'] as int? ?? 4096,
      );

  @override
  List<Object?> get props => [repliesEnabled, pollsEnabled, maxUpstreamSize];
}

/// The signed channel manifest, broadcast as a chunk to all subscribers.
///
/// Contains all public metadata needed for subscribers to verify content
/// authenticity and decrypt payloads. The entire manifest (minus the signature
/// field) is signed by the owner's Ed25519 key.
class ChannelManifest extends Equatable {
  /// Fingerprint of the owner's Ed25519 public key (channel identity).
  final String channelId;

  /// Channel name (plaintext within the signed manifest).
  /// The manifest is distributed only via encrypted chunks to subscribers who
  /// hold the decryption key, so field-level encryption is not applied here.
  /// An attacker without the channel key cannot read the manifest at all.
  final String name;

  /// Channel description (plaintext within the signed manifest).
  /// Same privacy model as [name]: readable only by key holders.
  final String description;

  /// Owner's Ed25519 public key, base64-encoded.
  final String ownerKey;

  /// List of admin Ed25519 public keys with labels.
  /// Labels are plaintext within the signed manifest. Since the manifest is
  /// distributed only via encrypted chunks to subscribers who hold the
  /// decryption key, field-level encryption is not needed here.
  final List<AdminKey> adminKeys;

  /// Current X25519 public key for content encryption, base64-encoded.
  final String currentEncryptKey;

  /// Key epoch — incremented each time the encryption key is rotated.
  final int keyEpoch;

  /// Channel behavior rules.
  final ChannelRules rules;

  /// Ed25519 signature by owner_key over all fields above.
  /// Empty string when the manifest has not yet been signed.
  final String signature;

  const ChannelManifest({
    required this.channelId,
    required this.name,
    required this.description,
    required this.ownerKey,
    this.adminKeys = const [],
    required this.currentEncryptKey,
    this.keyEpoch = 1,
    this.rules = const ChannelRules(),
    this.signature = '',
  });

  /// Serializes all fields except [signature] to a canonical JSON string
  /// suitable for signing. The fields are sorted alphabetically to ensure
  /// deterministic output across platforms.
  String toSignableJson() {
    final map = <String, dynamic>{
      'admin_keys': adminKeys.map((a) => a.toJson()).toList(),
      'channel_id': channelId,
      'current_encrypt_key': currentEncryptKey,
      'description': description,
      'key_epoch': keyEpoch,
      'name': name,
      'owner_key': ownerKey,
      'rules': rules.toJson(),
    };
    return jsonEncode(map);
  }

  Map<String, dynamic> toJson() {
    final map = <String, dynamic>{
      'admin_keys': adminKeys.map((a) => a.toJson()).toList(),
      'channel_id': channelId,
      'current_encrypt_key': currentEncryptKey,
      'description': description,
      'key_epoch': keyEpoch,
      'name': name,
      'owner_key': ownerKey,
      'rules': rules.toJson(),
      'signature': signature,
    };
    return map;
  }

  factory ChannelManifest.fromJson(Map<String, dynamic> json) {
    return ChannelManifest(
      channelId: json['channel_id'] as String,
      name: json['name'] as String,
      description: json['description'] as String,
      ownerKey: json['owner_key'] as String,
      adminKeys: (json['admin_keys'] as List<dynamic>?)
              ?.map((e) => AdminKey.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      currentEncryptKey: json['current_encrypt_key'] as String,
      keyEpoch: json['key_epoch'] as int? ?? 1,
      rules: json['rules'] != null
          ? ChannelRules.fromJson(json['rules'] as Map<String, dynamic>)
          : const ChannelRules(),
      signature: json['signature'] as String? ?? '',
    );
  }

  ChannelManifest copyWith({
    String? channelId,
    String? name,
    String? description,
    String? ownerKey,
    List<AdminKey>? adminKeys,
    String? currentEncryptKey,
    int? keyEpoch,
    ChannelRules? rules,
    String? signature,
  }) {
    return ChannelManifest(
      channelId: channelId ?? this.channelId,
      name: name ?? this.name,
      description: description ?? this.description,
      ownerKey: ownerKey ?? this.ownerKey,
      adminKeys: adminKeys ?? this.adminKeys,
      currentEncryptKey: currentEncryptKey ?? this.currentEncryptKey,
      keyEpoch: keyEpoch ?? this.keyEpoch,
      rules: rules ?? this.rules,
      signature: signature ?? this.signature,
    );
  }

  @override
  List<Object?> get props => [
        channelId,
        name,
        description,
        ownerKey,
        adminKeys,
        currentEncryptKey,
        keyEpoch,
        rules,
        signature,
      ];
}

/// A channel — either owned by us or subscribed to.
///
/// For an owned channel, [ownerSigningKeyPrivate] and [encryptionKeyPrivate]
/// are populated. For a subscribed channel, only the public keys from the
/// manifest are stored.
class Channel extends Equatable {
  /// The channel's unique identifier (Ed25519 public key fingerprint).
  final String id;

  /// Our role in this channel.
  final ChannelRole role;

  /// The channel manifest (latest signed version).
  final ChannelManifest manifest;

  /// Owner's Ed25519 signing private key, base64-encoded.
  /// Only populated when [role] == [ChannelRole.owner].
  final String? ownerSigningKeyPrivate;

  /// Admin's Ed25519 signing private key, base64-encoded.
  /// Only populated when [role] == [ChannelRole.admin].
  final String? adminSigningKeyPrivate;

  /// X25519 encryption private key, base64-encoded.
  /// Only populated when [role] == [ChannelRole.owner].
  final String? encryptionKeyPrivate;

  /// X25519 encryption public key used for decrypting content.
  /// For subscribers, this is the shared decryption key received from
  /// the manifest. For owners, this is the key pair's public side.
  final String encryptionKeyPublic;

  /// When this channel was created or first subscribed to.
  final DateTime createdAt;

  const Channel({
    required this.id,
    required this.role,
    required this.manifest,
    this.ownerSigningKeyPrivate,
    this.adminSigningKeyPrivate,
    this.encryptionKeyPrivate,
    required this.encryptionKeyPublic,
    required this.createdAt,
  });

  Channel copyWith({
    String? id,
    ChannelRole? role,
    ChannelManifest? manifest,
    String? ownerSigningKeyPrivate,
    String? adminSigningKeyPrivate,
    String? encryptionKeyPrivate,
    String? encryptionKeyPublic,
    DateTime? createdAt,
  }) {
    return Channel(
      id: id ?? this.id,
      role: role ?? this.role,
      manifest: manifest ?? this.manifest,
      ownerSigningKeyPrivate:
          ownerSigningKeyPrivate ?? this.ownerSigningKeyPrivate,
      adminSigningKeyPrivate:
          adminSigningKeyPrivate ?? this.adminSigningKeyPrivate,
      encryptionKeyPrivate: encryptionKeyPrivate ?? this.encryptionKeyPrivate,
      encryptionKeyPublic: encryptionKeyPublic ?? this.encryptionKeyPublic,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  /// Serialize for storage. Private keys are stored separately in secure storage.
  Map<String, dynamic> toJson() => {
        'id': id,
        'role': role.name,
        'manifest': jsonEncode(manifest.toJson()),
        'encryption_key_public': encryptionKeyPublic,
        'created_at': createdAt.toIso8601String(),
      };

  factory Channel.fromJson(
    Map<String, dynamic> json, {
    String? ownerSigningKeyPrivate,
    String? adminSigningKeyPrivate,
    String? encryptionKeyPrivate,
  }) {
    return Channel(
      id: json['id'] as String,
      role: ChannelRole.values.firstWhere(
        (e) => e.name == json['role'],
        orElse: () => ChannelRole.subscriber,
      ),
      manifest: ChannelManifest.fromJson(
        jsonDecode(json['manifest'] as String) as Map<String, dynamic>,
      ),
      ownerSigningKeyPrivate: ownerSigningKeyPrivate,
      adminSigningKeyPrivate: adminSigningKeyPrivate,
      encryptionKeyPrivate: encryptionKeyPrivate,
      encryptionKeyPublic: json['encryption_key_public'] as String,
      createdAt: DateTime.parse(json['created_at'] as String),
    );
  }

  @override
  List<Object?> get props => [id, role, manifest, createdAt];

  /// The signing private key to use for publishing content.
  ///
  /// Returns the owner's key for owners, the admin's key for admins,
  /// or null for subscribers.
  String? get signingKeyPrivate {
    switch (role) {
      case ChannelRole.owner:
        return ownerSigningKeyPrivate;
      case ChannelRole.admin:
        return adminSigningKeyPrivate;
      case ChannelRole.subscriber:
        return null;
    }
  }
}
