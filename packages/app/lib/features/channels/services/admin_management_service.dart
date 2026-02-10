import '../models/channel.dart';
import 'channel_crypto_service.dart';
import 'channel_service.dart';
import 'channel_storage_service.dart';

/// Service for managing admin permissions and delegated signing keys.
///
/// Provides higher-level admin management operations that enforce permission
/// rules and handle key rotation on member removal. Works alongside
/// [ChannelService] for the underlying manifest updates.
class AdminManagementService {
  final ChannelCryptoService _cryptoService;
  final ChannelStorageService _storageService;

  AdminManagementService({
    required ChannelCryptoService cryptoService,
    required ChannelStorageService storageService,
  })  : _cryptoService = cryptoService,
        _storageService = storageService;

  // ---------------------------------------------------------------------------
  // Admin appointment & removal
  // ---------------------------------------------------------------------------

  /// Appoint a new admin by adding their Ed25519 public key to the manifest.
  ///
  /// Only the channel owner can appoint admins. Returns the updated channel
  /// with a re-signed manifest. The admin's public key must be a valid
  /// base64-encoded Ed25519 key.
  ///
  /// Throws [AdminManagementException] if:
  /// - The caller is not the channel owner
  /// - The admin public key is already in the manifest
  /// - The admin public key matches the owner key
  Future<Channel> appointAdmin({
    required Channel channel,
    required String adminPublicKey,
    required String adminLabel,
  }) async {
    _ensureOwner(channel);

    if (adminPublicKey == channel.manifest.ownerKey) {
      throw AdminManagementException('Cannot appoint the owner as an admin');
    }

    if (channel.manifest.adminKeys.any((a) => a.key == adminPublicKey)) {
      throw AdminManagementException(
          'Admin with this public key is already appointed');
    }

    final updatedAdmins = [
      ...channel.manifest.adminKeys,
      AdminKey(key: adminPublicKey, label: adminLabel),
    ];

    var updatedManifest = channel.manifest.copyWith(
      adminKeys: updatedAdmins,
      signature: '',
    );

    updatedManifest = await _cryptoService.signManifest(
      updatedManifest,
      channel.ownerSigningKeyPrivate!,
    );

    final updatedChannel = channel.copyWith(manifest: updatedManifest);
    await _storageService.saveChannel(updatedChannel);
    return updatedChannel;
  }

  /// Remove an admin from the channel and rotate the encryption key.
  ///
  /// When an admin is removed, the encryption key is rotated so the removed
  /// admin cannot decrypt future content. Returns the updated channel with
  /// new encryption keys and an incremented key epoch.
  ///
  /// Throws [AdminManagementException] if:
  /// - The caller is not the channel owner
  /// - The admin public key is not in the manifest
  Future<Channel> removeAdmin({
    required Channel channel,
    required String adminPublicKey,
  }) async {
    _ensureOwner(channel);

    if (!channel.manifest.adminKeys.any((a) => a.key == adminPublicKey)) {
      throw AdminManagementException(
          'Admin with this public key is not in the manifest');
    }

    // Remove the admin
    final updatedAdmins = channel.manifest.adminKeys
        .where((a) => a.key != adminPublicKey)
        .toList();

    // Rotate encryption key so the removed admin cannot decrypt new content
    final newKeys = await _cryptoService.generateEncryptionKeyPair();

    var updatedManifest = channel.manifest.copyWith(
      adminKeys: updatedAdmins,
      currentEncryptKey: newKeys.publicKey,
      keyEpoch: channel.manifest.keyEpoch + 1,
      signature: '',
    );

    updatedManifest = await _cryptoService.signManifest(
      updatedManifest,
      channel.ownerSigningKeyPrivate!,
    );

    final updatedChannel = channel.copyWith(
      manifest: updatedManifest,
      encryptionKeyPrivate: newKeys.privateKey,
      encryptionKeyPublic: newKeys.publicKey,
    );

    await _storageService.saveChannel(updatedChannel);
    return updatedChannel;
  }

  // ---------------------------------------------------------------------------
  // Admin authorization validation
  // ---------------------------------------------------------------------------

  /// Validate that a given public key belongs to an authorized admin
  /// in the current manifest.
  ///
  /// Returns true if the key is found in [manifest.adminKeys].
  bool isAuthorizedAdmin(ChannelManifest manifest, String publicKey) {
    return manifest.adminKeys.any((a) => a.key == publicKey);
  }

  /// Validate that a given public key is authorized to publish content
  /// (either the owner or an admin).
  bool isAuthorizedPublisher(ChannelManifest manifest, String publicKey) {
    return publicKey == manifest.ownerKey ||
        isAuthorizedAdmin(manifest, publicKey);
  }

  // ---------------------------------------------------------------------------
  // Permission rules validation
  // ---------------------------------------------------------------------------

  /// Validate that an upstream message (reply) is allowed by the channel rules.
  ///
  /// Returns null if the message is allowed, or an error message string
  /// explaining why it was rejected.
  String? validateUpstreamMessage({
    required ChannelManifest manifest,
    required int messageSize,
    bool isReply = false,
    bool isPoll = false,
  }) {
    if (isReply && !manifest.rules.repliesEnabled) {
      return 'Replies are not enabled for this channel';
    }

    if (isPoll && !manifest.rules.pollsEnabled) {
      return 'Polls are not enabled for this channel';
    }

    if (messageSize > manifest.rules.maxUpstreamSize) {
      return 'Message size ($messageSize bytes) exceeds maximum '
          'upstream size (${manifest.rules.maxUpstreamSize} bytes)';
    }

    return null;
  }

  /// Update the channel rules. Only the owner can do this.
  ///
  /// Returns the updated channel with a re-signed manifest.
  Future<Channel> updateRules({
    required Channel channel,
    required ChannelRules rules,
  }) async {
    _ensureOwner(channel);

    var updatedManifest = channel.manifest.copyWith(
      rules: rules,
      signature: '',
    );

    updatedManifest = await _cryptoService.signManifest(
      updatedManifest,
      channel.ownerSigningKeyPrivate!,
    );

    final updatedChannel = channel.copyWith(manifest: updatedManifest);
    await _storageService.saveChannel(updatedChannel);
    return updatedChannel;
  }

  // ---------------------------------------------------------------------------
  // Key rotation on subscriber removal
  // ---------------------------------------------------------------------------

  /// Rotate the channel encryption key after removing a member.
  ///
  /// Generates a new X25519 encryption key, increments the key epoch,
  /// and re-signs the manifest. The removed member will not be able to
  /// decrypt content encrypted with the new key.
  ///
  /// This is called automatically by [removeAdmin]. For subscriber removal,
  /// call this explicitly after revoking the subscriber's access.
  Future<Channel> rotateEncryptionKeyForRemoval({
    required Channel channel,
  }) async {
    _ensureOwner(channel);

    final newKeys = await _cryptoService.generateEncryptionKeyPair();

    var updatedManifest = channel.manifest.copyWith(
      currentEncryptKey: newKeys.publicKey,
      keyEpoch: channel.manifest.keyEpoch + 1,
      signature: '',
    );

    updatedManifest = await _cryptoService.signManifest(
      updatedManifest,
      channel.ownerSigningKeyPrivate!,
    );

    final updatedChannel = channel.copyWith(
      manifest: updatedManifest,
      encryptionKeyPrivate: newKeys.privateKey,
      encryptionKeyPublic: newKeys.publicKey,
    );

    await _storageService.saveChannel(updatedChannel);
    return updatedChannel;
  }

  // ---------------------------------------------------------------------------
  // Bulk admin operations
  // ---------------------------------------------------------------------------

  /// Get all admin public keys from the manifest.
  List<AdminKey> getAdmins(ChannelManifest manifest) {
    return List.unmodifiable(manifest.adminKeys);
  }

  /// Check if the manifest has any admins.
  bool hasAdmins(ChannelManifest manifest) {
    return manifest.adminKeys.isNotEmpty;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  void _ensureOwner(Channel channel) {
    if (channel.role != ChannelRole.owner) {
      throw AdminManagementException(
          'Only the channel owner can perform this operation');
    }
    if (channel.ownerSigningKeyPrivate == null) {
      throw AdminManagementException('Owner signing key not available');
    }
  }
}

/// Exception thrown by admin management operations.
class AdminManagementException implements Exception {
  final String message;
  AdminManagementException(this.message);

  @override
  String toString() => 'AdminManagementException: $message';
}
