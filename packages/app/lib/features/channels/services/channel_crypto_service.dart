import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../models/channel.dart';
import '../models/chunk.dart';

/// Cryptographic operations for channels.
///
/// Handles Ed25519 signing/verification for manifests and chunks,
/// and ChaCha20-Poly1305 encryption/decryption for chunk payloads.
class ChannelCryptoService {
  final Ed25519 _ed25519 = Ed25519();
  final X25519 _x25519 = X25519();
  final Chacha20 _chacha20 = Chacha20.poly1305Aead();
  late final Hkdf _hkdf;

  ChannelCryptoService() {
    _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
  }

  // ---------------------------------------------------------------------------
  // Key generation
  // ---------------------------------------------------------------------------

  /// Generate an Ed25519 keypair for channel ownership/signing.
  ///
  /// Returns a record with base64-encoded public and private keys.
  Future<({String publicKey, String privateKey})>
      generateSigningKeyPair() async {
    final keyPair = await _ed25519.newKeyPair();
    final publicKey = await keyPair.extractPublicKey();
    final privateKeyBytes = await keyPair.extractPrivateKeyBytes();

    return (
      publicKey: base64Encode(publicKey.bytes),
      privateKey: base64Encode(privateKeyBytes),
    );
  }

  /// Generate an X25519 keypair for channel content encryption.
  ///
  /// Returns a record with base64-encoded public and private keys.
  Future<({String publicKey, String privateKey})>
      generateEncryptionKeyPair() async {
    final keyPair = await _x25519.newKeyPair();
    final publicKey = await keyPair.extractPublicKey();
    final privateKeyBytes = await keyPair.extractPrivateKeyBytes();

    return (
      publicKey: base64Encode(publicKey.bytes),
      privateKey: base64Encode(privateKeyBytes),
    );
  }

  /// Derive a channel ID (fingerprint) from an Ed25519 public key.
  ///
  /// Uses SHA-256 of the public key bytes, truncated to 16 bytes,
  /// hex-encoded for a compact but unique identifier.
  Future<String> deriveChannelId(String publicKeyBase64) async {
    final publicKeyBytes = base64Decode(publicKeyBase64);
    final hashAlgo = Sha256();
    final hash = await hashAlgo.hash(publicKeyBytes);
    // Use first 16 bytes (128 bits) of the hash — collision-resistant enough
    final truncated = hash.bytes.sublist(0, 16);
    return truncated
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
  }

  // ---------------------------------------------------------------------------
  // Manifest signing & verification
  // ---------------------------------------------------------------------------

  /// Sign a channel manifest with the owner's Ed25519 private key.
  ///
  /// Returns the manifest with the [signature] field populated.
  Future<ChannelManifest> signManifest(
    ChannelManifest manifest,
    String ownerPrivateKeyBase64,
  ) async {
    final signable = manifest.toSignableJson();
    final signableBytes = Uint8List.fromList(utf8.encode(signable));
    final privateKeyBytes = base64Decode(ownerPrivateKeyBase64);

    final keyPair = await _ed25519.newKeyPairFromSeed(privateKeyBytes);
    final signature = await _ed25519.sign(signableBytes, keyPair: keyPair);

    return manifest.copyWith(
      signature: base64Encode(signature.bytes),
    );
  }

  /// Verify a manifest's signature against the owner's public key.
  ///
  /// Returns true if the signature is valid.
  Future<bool> verifyManifest(ChannelManifest manifest) async {
    if (manifest.signature.isEmpty) return false;

    try {
      final signable = manifest.toSignableJson();
      final signableBytes = Uint8List.fromList(utf8.encode(signable));
      final signatureBytes = base64Decode(manifest.signature);
      final publicKeyBytes = base64Decode(manifest.ownerKey);

      final publicKey =
          SimplePublicKey(publicKeyBytes, type: KeyPairType.ed25519);
      final signature = Signature(signatureBytes, publicKey: publicKey);

      return await _ed25519.verify(signableBytes, signature: signature);
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Chunk payload encryption & decryption
  // ---------------------------------------------------------------------------

  /// Derive a symmetric key from the channel's X25519 private key for
  /// encrypting/decrypting chunk payloads.
  ///
  /// Uses HKDF with the private key as input keying material and a
  /// channel-specific info string that includes the key epoch.
  Future<SecretKey> _deriveContentKey(
    String encryptionPrivateKeyBase64,
    int keyEpoch,
  ) async {
    final privateKeyBytes = base64Decode(encryptionPrivateKeyBase64);
    return _hkdf.deriveKey(
      secretKey: SecretKey(privateKeyBytes),
      info: utf8.encode('zajel_channel_content_epoch_$keyEpoch'),
      nonce: const [],
    );
  }

  /// Encrypt a chunk payload using the channel's encryption key.
  ///
  /// Returns the encrypted bytes (nonce + ciphertext + MAC).
  Future<Uint8List> encryptPayload(
    ChunkPayload payload,
    String encryptionPrivateKeyBase64,
    int keyEpoch,
  ) async {
    final contentKey =
        await _deriveContentKey(encryptionPrivateKeyBase64, keyEpoch);
    final plaintextBytes = payload.toBytes();
    final nonce = _chacha20.newNonce();

    final secretBox = await _chacha20.encrypt(
      plaintextBytes,
      secretKey: contentKey,
      nonce: nonce,
    );

    // Combine: nonce (12) + ciphertext + mac (16)
    final combined = Uint8List(
      nonce.length + secretBox.cipherText.length + secretBox.mac.bytes.length,
    );
    combined.setAll(0, nonce);
    combined.setAll(nonce.length, secretBox.cipherText);
    combined.setAll(
        nonce.length + secretBox.cipherText.length, secretBox.mac.bytes);

    return combined;
  }

  /// Decrypt a chunk payload using the channel's encryption key.
  ///
  /// Expects the combined format: nonce (12) + ciphertext + mac (16).
  Future<ChunkPayload> decryptPayload(
    Uint8List encryptedBytes,
    String encryptionPrivateKeyBase64,
    int keyEpoch,
  ) async {
    const nonceLength = 12;
    const macLength = 16;

    if (encryptedBytes.length < nonceLength + macLength) {
      throw ChannelCryptoException('Encrypted payload too short');
    }

    final contentKey =
        await _deriveContentKey(encryptionPrivateKeyBase64, keyEpoch);

    final nonce = encryptedBytes.sublist(0, nonceLength);
    final cipherText =
        encryptedBytes.sublist(nonceLength, encryptedBytes.length - macLength);
    final mac =
        Mac(encryptedBytes.sublist(encryptedBytes.length - macLength));

    final secretBox = SecretBox(cipherText, nonce: nonce, mac: mac);

    try {
      final plaintextBytes =
          await _chacha20.decrypt(secretBox, secretKey: contentKey);
      return ChunkPayload.fromBytes(Uint8List.fromList(plaintextBytes));
    } catch (e) {
      throw ChannelCryptoException('Failed to decrypt payload: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // Chunk signing & verification
  // ---------------------------------------------------------------------------

  /// Sign a chunk's encrypted payload with the author's Ed25519 private key.
  ///
  /// Returns the base64-encoded signature.
  Future<String> signChunk(
    Uint8List encryptedPayload,
    String authorPrivateKeyBase64,
  ) async {
    final privateKeyBytes = base64Decode(authorPrivateKeyBase64);
    final keyPair = await _ed25519.newKeyPairFromSeed(privateKeyBytes);
    final signature = await _ed25519.sign(encryptedPayload, keyPair: keyPair);
    return base64Encode(signature.bytes);
  }

  /// Verify a chunk's signature against the author's public key.
  Future<bool> verifyChunkSignature(Chunk chunk) async {
    try {
      final signatureBytes = base64Decode(chunk.signature);
      final publicKeyBytes = base64Decode(chunk.authorPubkey);

      final publicKey =
          SimplePublicKey(publicKeyBytes, type: KeyPairType.ed25519);
      final signature = Signature(signatureBytes, publicKey: publicKey);

      return await _ed25519.verify(
        chunk.encryptedPayload,
        signature: signature,
      );
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Subscriber verification (5-step check from plan Section 7)
  // ---------------------------------------------------------------------------

  /// Perform the 5-step subscriber verification on a received chunk.
  ///
  /// Steps:
  /// 1. Check signature on chunk against author_pubkey (authentic?)
  /// 2. Check author_pubkey is in channel manifest (authorized?)
  /// 3. Check manifest is signed by owner_key (manifest legit?)
  /// 4. Check owner_key matches locally stored key from subscribe time (trusted?)
  /// 5. Decrypt payload with channel encryption key (readable?)
  ///
  /// Returns the decrypted [ChunkPayload] on success.
  /// Throws [ChannelCryptoException] with a descriptive message on any failure.
  Future<ChunkPayload> verifyAndDecryptChunk({
    required Chunk chunk,
    required ChannelManifest manifest,
    required String trustedOwnerKey,
    required String encryptionPrivateKeyBase64,
  }) async {
    // Step 1: Check signature on chunk against author_pubkey
    final signatureValid = await verifyChunkSignature(chunk);
    if (!signatureValid) {
      throw ChannelCryptoException(
          'Step 1 failed: chunk signature is invalid');
    }

    // Step 2: Check author_pubkey is in channel manifest (owner or admin)
    final isOwner = chunk.authorPubkey == manifest.ownerKey;
    final isAdmin =
        manifest.adminKeys.any((admin) => admin.key == chunk.authorPubkey);
    if (!isOwner && !isAdmin) {
      throw ChannelCryptoException(
          'Step 2 failed: author is not authorized in manifest');
    }

    // Step 3: Check manifest is signed by owner_key
    final manifestValid = await verifyManifest(manifest);
    if (!manifestValid) {
      throw ChannelCryptoException(
          'Step 3 failed: manifest signature is invalid');
    }

    // Step 4: Check owner_key matches locally stored key from subscribe time
    if (manifest.ownerKey != trustedOwnerKey) {
      throw ChannelCryptoException(
          'Step 4 failed: owner key does not match trusted key');
    }

    // Step 5: Decrypt payload with channel encryption key
    try {
      return await decryptPayload(
        chunk.encryptedPayload,
        encryptionPrivateKeyBase64,
        manifest.keyEpoch,
      );
    } catch (e) {
      throw ChannelCryptoException('Step 5 failed: cannot decrypt payload: $e');
    }
  }
}

/// Exception thrown by channel cryptographic operations.
class ChannelCryptoException implements Exception {
  final String message;
  ChannelCryptoException(this.message);

  @override
  String toString() => 'ChannelCryptoException: $message';
}
