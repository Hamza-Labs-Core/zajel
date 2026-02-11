import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../models/channel.dart';
import '../models/chunk.dart';
import 'channel_crypto_service.dart';
import 'channel_storage_service.dart';

/// High-level channel operations: create, subscribe, publish, receive.
///
/// Orchestrates [ChannelCryptoService] for cryptographic operations and
/// [ChannelStorageService] for persistence.
class ChannelService {
  /// Fixed chunk size for splitting encrypted content into relay-friendly pieces.
  ///
  /// 64KB balances efficiency (fewer chunks per message) with relay-ability
  /// (fits within WebRTC data channel message limits and VPS memory budgets).
  /// This value must match across all clients for correct reassembly.
  static const int chunkSize = 64 * 1024;

  final ChannelCryptoService _cryptoService;
  final ChannelStorageService _storageService;
  final _uuid = const Uuid();

  ChannelService({
    required ChannelCryptoService cryptoService,
    required ChannelStorageService storageService,
  })  : _cryptoService = cryptoService,
        _storageService = storageService;

  // ---------------------------------------------------------------------------
  // Channel creation
  // ---------------------------------------------------------------------------

  /// Create a new channel. Generates Ed25519 signing and X25519 encryption
  /// keypairs, creates the initial manifest, signs it, and persists everything.
  ///
  /// Returns the created [Channel].
  Future<Channel> createChannel({
    required String name,
    String description = '',
    ChannelRules rules = const ChannelRules(),
  }) async {
    // Generate signing keypair (Ed25519) — this IS the channel identity
    final signingKeys = await _cryptoService.generateSigningKeyPair();

    // Generate encryption keypair (X25519) — for content encryption
    final encryptionKeys = await _cryptoService.generateEncryptionKeyPair();

    // Derive channel ID from the owner's public key
    final channelId =
        await _cryptoService.deriveChannelId(signingKeys.publicKey);

    // Create the initial manifest
    var manifest = ChannelManifest(
      channelId: channelId,
      name: name,
      description: description,
      ownerKey: signingKeys.publicKey,
      adminKeys: const [],
      currentEncryptKey: encryptionKeys.publicKey,
      keyEpoch: 1,
      rules: rules,
    );

    // Sign the manifest with the owner's key
    manifest = await _cryptoService.signManifest(
      manifest,
      signingKeys.privateKey,
    );

    // Create the channel object
    final channel = Channel(
      id: channelId,
      role: ChannelRole.owner,
      manifest: manifest,
      ownerSigningKeyPrivate: signingKeys.privateKey,
      encryptionKeyPrivate: encryptionKeys.privateKey,
      encryptionKeyPublic: encryptionKeys.publicKey,
      createdAt: DateTime.now(),
    );

    // Persist
    await _storageService.saveChannel(channel);

    return channel;
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  /// Subscribe to a channel by storing its public key and encryption key.
  ///
  /// [ownerPublicKey] is the channel owner's Ed25519 public key (base64).
  /// [manifest] is the signed channel manifest obtained out-of-band.
  /// [encryptionPrivateKey] is the shared decryption key (base64), distributed
  /// to subscribers via the manifest or out-of-band.
  ///
  /// Returns the created subscription [Channel].
  Future<Channel> subscribe({
    required ChannelManifest manifest,
    required String encryptionPrivateKey,
  }) async {
    // Verify the manifest signature before storing
    final isValid = await _cryptoService.verifyManifest(manifest);
    if (!isValid) {
      throw ChannelServiceException(
          'Cannot subscribe: manifest signature is invalid');
    }

    final channel = Channel(
      id: manifest.channelId,
      role: ChannelRole.subscriber,
      manifest: manifest,
      encryptionKeyPrivate: encryptionPrivateKey,
      encryptionKeyPublic: manifest.currentEncryptKey,
      createdAt: DateTime.now(),
    );

    await _storageService.saveChannel(channel);
    return channel;
  }

  // ---------------------------------------------------------------------------
  // Content splitting into chunks
  // ---------------------------------------------------------------------------

  /// Split content into fixed-size chunks, encrypt, and sign each one.
  ///
  /// [payload] is the content to publish.
  /// [channel] must be an owned or admin channel with private keys.
  /// [sequence] is the channel-level sequence number for this message.
  /// [routingHash] is the current epoch's routing hash.
  ///
  /// Returns the list of signed, encrypted [Chunk]s ready for distribution.
  Future<List<Chunk>> splitIntoChunks({
    required ChunkPayload payload,
    required Channel channel,
    required int sequence,
    required String routingHash,
  }) async {
    if (channel.encryptionKeyPrivate == null) {
      throw ChannelServiceException(
          'Cannot publish: no encryption private key');
    }

    // Determine which signing key to use based on role
    final signingKey = channel.signingKeyPrivate;
    if (signingKey == null) {
      throw ChannelServiceException(
          'Cannot publish: no signing private key for role ${channel.role.name}');
    }

    // Determine the author's public key for the chunk envelope
    final String authorPubkey;
    if (channel.role == ChannelRole.owner) {
      authorPubkey = channel.manifest.ownerKey;
    } else {
      // For admins, derive the public key from the private key
      authorPubkey =
          await _cryptoService.derivePublicKeyFromPrivate(signingKey);
    }

    // Encrypt the payload
    final encryptedBytes = await _cryptoService.encryptPayload(
      payload,
      channel.encryptionKeyPrivate!,
      channel.manifest.keyEpoch,
    );

    // Split into fixed-size chunks
    final totalChunks = (encryptedBytes.length / chunkSize).ceil();
    final chunks = <Chunk>[];

    for (var i = 0; i < totalChunks; i++) {
      final start = i * chunkSize;
      final end = (start + chunkSize).clamp(0, encryptedBytes.length);
      final chunkData = encryptedBytes.sublist(start, end);

      // Sign this chunk's encrypted data
      final signature = await _cryptoService.signChunk(chunkData, signingKey);

      final chunk = Chunk(
        chunkId:
            'ch_${_uuid.v4().replaceAll('-', '').substring(0, 16)}_${i.toString().padLeft(3, '0')}',
        routingHash: routingHash,
        sequence: sequence,
        chunkIndex: i,
        totalChunks: totalChunks,
        size: chunkData.length,
        signature: signature,
        authorPubkey: authorPubkey,
        encryptedPayload: Uint8List.fromList(chunkData),
      );

      chunks.add(chunk);
    }

    return chunks;
  }

  /// Maximum reassembled message size (50 MB) to prevent memory exhaustion
  /// from malicious chunk counts or sizes.
  static const int maxMessageSize = 50 * 1024 * 1024;

  /// Maximum size for a single chunk payload (2x the expected chunk size).
  ///
  /// Any chunk larger than this is rejected as malformed. Legitimate chunks
  /// should never exceed [chunkSize] except for minor overhead.
  static const int maxChunkPayloadSize = chunkSize * 2;

  /// Reassemble chunks into the original content.
  ///
  /// All chunks must belong to the same message (same sequence number),
  /// all chunks must be present, and they are assembled in order of
  /// [chunkIndex].
  ///
  /// **Important**: Callers MUST verify each chunk's signature via
  /// [ChannelCryptoService.verifyChunkSignature] before passing them here.
  /// For a convenience wrapper that enforces signature verification, use
  /// [verifyAndReassembleChunks].
  ///
  /// Returns the combined encrypted bytes. Call [ChannelCryptoService.decryptPayload]
  /// to obtain the original [ChunkPayload].
  Uint8List reassembleChunks(List<Chunk> chunks) {
    if (chunks.isEmpty) {
      throw ChannelServiceException('Cannot reassemble: no chunks provided');
    }

    // Verify all chunks belong to the same message
    final sequence = chunks.first.sequence;
    final totalChunks = chunks.first.totalChunks;

    if (chunks.any((c) => c.sequence != sequence)) {
      throw ChannelServiceException(
          'Cannot reassemble: chunks have different sequence numbers');
    }
    if (chunks.any((c) => c.totalChunks != totalChunks)) {
      throw ChannelServiceException(
          'Cannot reassemble: chunks report different total counts');
    }
    // Deduplicate by chunk index to prevent replay/duplication attacks
    final uniqueIndices = chunks.map((c) => c.chunkIndex).toSet();
    if (uniqueIndices.length != chunks.length) {
      throw ChannelServiceException(
          'Cannot reassemble: duplicate chunk indices detected');
    }

    if (chunks.length != totalChunks) {
      throw ChannelServiceException(
          'Cannot reassemble: expected $totalChunks chunks, got ${chunks.length}');
    }

    // Per-chunk size validation: reject any chunk larger than maxChunkPayloadSize
    for (final chunk in chunks) {
      if (chunk.encryptedPayload.length > maxChunkPayloadSize) {
        throw ChannelServiceException(
            'Cannot reassemble: chunk ${chunk.chunkIndex} size '
            '${chunk.encryptedPayload.length} exceeds maximum $maxChunkPayloadSize bytes');
      }
    }

    // Sort by chunk index
    final sorted = List<Chunk>.from(chunks)
      ..sort((a, b) => a.chunkIndex.compareTo(b.chunkIndex));

    // Verify indices are 0..totalChunks-1
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].chunkIndex != i) {
        throw ChannelServiceException(
            'Cannot reassemble: missing chunk at index $i');
      }
    }

    // Combine encrypted payloads with size safety check.
    // Use checked addition to prevent integer overflow from malicious sizes.
    var totalSize = 0;
    for (final chunk in sorted) {
      final newTotal = totalSize + chunk.encryptedPayload.length;
      if (newTotal < totalSize) {
        // Integer overflow
        throw ChannelServiceException(
            'Cannot reassemble: total size overflow detected');
      }
      totalSize = newTotal;
      if (totalSize > maxMessageSize) {
        throw ChannelServiceException(
            'Cannot reassemble: total size $totalSize exceeds maximum $maxMessageSize bytes');
      }
    }

    final combined = Uint8List(totalSize);
    var offset = 0;
    for (final chunk in sorted) {
      combined.setAll(offset, chunk.encryptedPayload);
      offset += chunk.encryptedPayload.length;
    }

    return combined;
  }

  /// Verify chunk signatures and reassemble into the original encrypted bytes.
  ///
  /// This is a convenience wrapper around [reassembleChunks] that enforces
  /// signature verification before reassembly. Each chunk's signature is
  /// verified against the author's public key listed in [authorizedKeys].
  ///
  /// [chunks] - the chunks to verify and reassemble.
  /// [authorizedKeys] - set of base64-encoded Ed25519 public keys that are
  ///   authorized to publish (owner key + admin keys from the manifest).
  ///
  /// Throws [ChannelServiceException] if any chunk has an invalid signature
  /// or an unauthorized author.
  Future<Uint8List> verifyAndReassembleChunks({
    required List<Chunk> chunks,
    required Set<String> authorizedKeys,
  }) async {
    for (final chunk in chunks) {
      // Check that the author is authorized
      if (!authorizedKeys.contains(chunk.authorPubkey)) {
        throw ChannelServiceException(
            'Cannot reassemble: chunk ${chunk.chunkIndex} author is not authorized');
      }

      // Verify the signature
      final isValid = await _cryptoService.verifyChunkSignature(chunk);
      if (!isValid) {
        throw ChannelServiceException(
            'Cannot reassemble: chunk ${chunk.chunkIndex} has an invalid signature');
      }
    }

    return reassembleChunks(chunks);
  }

  // ---------------------------------------------------------------------------
  // Manifest updates
  // ---------------------------------------------------------------------------

  /// Add an admin to the channel. Only the owner can do this.
  ///
  /// Signs a new manifest with the admin's key added.
  Future<Channel> addAdmin({
    required Channel channel,
    required String adminPublicKey,
    required String adminLabel,
  }) async {
    _ensureOwner(channel);

    final updatedAdmins = [
      ...channel.manifest.adminKeys,
      AdminKey(key: adminPublicKey, label: adminLabel),
    ];

    var updatedManifest = channel.manifest.copyWith(
      adminKeys: updatedAdmins,
      signature: '', // Clear signature before re-signing
    );

    updatedManifest = await _cryptoService.signManifest(
      updatedManifest,
      channel.ownerSigningKeyPrivate!,
    );

    final updatedChannel = channel.copyWith(manifest: updatedManifest);
    await _storageService.saveChannel(updatedChannel);
    return updatedChannel;
  }

  /// Remove an admin from the channel. Only the owner can do this.
  Future<Channel> removeAdmin({
    required Channel channel,
    required String adminPublicKey,
  }) async {
    _ensureOwner(channel);

    final updatedAdmins = channel.manifest.adminKeys
        .where((a) => a.key != adminPublicKey)
        .toList();

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

  /// Rotate the channel's encryption key. Only the owner can do this.
  ///
  /// Generates a new X25519 keypair, increments the key epoch, signs a new
  /// manifest. Old subscribers who are removed will not receive the new key.
  Future<Channel> rotateEncryptionKey({
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
  // Storage delegation
  // ---------------------------------------------------------------------------

  /// Get all channels (owned + subscribed).
  Future<List<Channel>> getAllChannels() => _storageService.getAllChannels();

  /// Get a channel by ID.
  Future<Channel?> getChannel(String channelId) =>
      _storageService.getChannel(channelId);

  /// Save chunks to local storage.
  Future<void> saveChunks(String channelId, List<Chunk> chunks) async {
    for (final chunk in chunks) {
      await _storageService.saveChunk(channelId, chunk);
    }
  }

  /// Get chunks for a specific message (by sequence number).
  Future<List<Chunk>> getChunksForMessage(String channelId, int sequence) =>
      _storageService.getChunksBySequence(channelId, sequence);

  /// Delete a channel and all its data.
  Future<void> deleteChannel(String channelId) =>
      _storageService.deleteChannel(channelId);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  void _ensureOwner(Channel channel) {
    if (channel.role != ChannelRole.owner) {
      throw ChannelServiceException(
          'Only the channel owner can perform this operation');
    }
    if (channel.ownerSigningKeyPrivate == null) {
      throw ChannelServiceException('Owner signing key not available');
    }
  }
}

/// Exception thrown by channel service operations.
class ChannelServiceException implements Exception {
  final String message;
  ChannelServiceException(this.message);

  @override
  String toString() => 'ChannelServiceException: $message';
}
