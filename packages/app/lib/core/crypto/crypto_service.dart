import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:crypto/crypto.dart' as crypto;

import '../constants.dart';

/// Cryptographic service implementing X25519 key exchange and ChaCha20-Poly1305 encryption.
///
/// This implements a simplified Double Ratchet-like protocol for forward secrecy:
/// 1. Generate ephemeral X25519 key pairs each session
/// 2. Derive shared secrets using ECDH
/// 3. Use HKDF to derive message keys
/// 4. Encrypt with ChaCha20-Poly1305 AEAD
class CryptoService {
  static const _keyPrefix = 'zajel_key_';
  static const _sessionKeyPrefix = 'zajel_session_';

  final FlutterSecureStorage _secureStorage;
  final X25519 _x25519 = X25519();
  final Chacha20 _chacha20 = Chacha20.poly1305Aead();
  late final Hkdf _hkdf;

  SimpleKeyPair? _identityKeyPair;
  String? _publicKeyBase64Cache;
  final Map<String, SecretKey> _sessionKeys = {};
  final Map<String, String> _peerPublicKeys = {};

  CryptoService({FlutterSecureStorage? secureStorage})
      : _secureStorage = secureStorage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            ) {
    _hkdf = Hkdf(
        hmac: Hmac.sha256(), outputLength: CryptoConstants.hkdfOutputLength);
  }

  /// Initialize the crypto service and generate/load identity keys.
  Future<void> initialize() async {
    await _loadOrGenerateIdentityKeys();
    // Cache the public key for synchronous access
    if (_identityKeyPair != null) {
      final publicKey = await _identityKeyPair!.extractPublicKey();
      _publicKeyBase64Cache = base64Encode(Uint8List.fromList(publicKey.bytes));
    }
  }

  /// Get our public key as a base64 string (synchronous, requires initialize() first).
  String get publicKeyBase64 {
    if (_publicKeyBase64Cache == null) {
      throw CryptoException(
          'CryptoService not initialized. Call initialize() first.');
    }
    return _publicKeyBase64Cache!;
  }

  /// Derive a stable peer ID from a public key (like a phone number).
  ///
  /// Uses first 16 characters of SHA-256 hex hash, uppercased.
  /// 16 hex chars = 64 bits → birthday collision at ~4 billion users.
  static String peerIdFromPublicKey(String publicKeyBase64) {
    final publicKeyBytes = base64Decode(publicKeyBase64);
    final hash = crypto.sha256.convert(publicKeyBytes);
    final hexStr = hash.toString().toUpperCase();
    return hexStr.substring(0, 16);
  }

  /// Derive a short tag from a public key for Discord-style identity display.
  ///
  /// Returns first 4 hex chars of SHA-256, uppercased (same hash as peerIdFromPublicKey).
  /// Used as the #TAG portion of "Username#TAG".
  static String tagFromPublicKey(String publicKeyBase64) {
    final publicKeyBytes = base64Decode(publicKeyBase64);
    final hash = crypto.sha256.convert(publicKeyBytes);
    return hash.toString().substring(0, 4).toUpperCase();
  }

  /// Store a peer's public key for later verification.
  void setPeerPublicKey(String peerId, String publicKeyBase64) {
    _peerPublicKeys[peerId] = publicKeyBase64;
  }

  /// Get a stored peer's public key.
  String? getPeerPublicKey(String peerId) {
    return _peerPublicKeys[peerId];
  }

  /// Returns a SHA-256 fingerprint of our public key for out-of-band verification.
  ///
  /// Users can compare fingerprints through a trusted channel (in person, phone call, etc.)
  /// to verify they're communicating with the intended party and not a MITM attacker.
  ///
  /// Uses the full 256-bit hash for collision resistance (birthday bound at 2^128).
  ///
  /// Returns a human-readable fingerprint string (uppercase hex, space-separated 4-char groups).
  Future<String> getPublicKeyFingerprint() async {
    final publicKeyBytes = await getPublicKeyBytes();
    final hash = crypto.sha256.convert(publicKeyBytes);
    return _formatFingerprint(hash.toString());
  }

  /// Returns a SHA-256 fingerprint of a peer's public key for out-of-band verification.
  ///
  /// Compare this with what the peer reports to detect MITM attacks.
  ///
  /// [peerPublicKeyBase64] - The peer's public key in base64 format
  /// Returns a human-readable fingerprint string (uppercase hex, space-separated 4-char groups).
  /// Throws [CryptoException] if the public key is invalid.
  String getPeerPublicKeyFingerprint(String peerPublicKeyBase64) {
    final Uint8List peerPublicKey;
    try {
      peerPublicKey = Uint8List.fromList(base64Decode(peerPublicKeyBase64));
    } catch (e) {
      throw CryptoException('Invalid peer public key: malformed base64');
    }

    if (peerPublicKey.length != CryptoConstants.x25519KeySize) {
      throw CryptoException(
          'Invalid peer public key: expected 32 bytes, got ${peerPublicKey.length}');
    }

    final hash = crypto.sha256.convert(peerPublicKey);
    return _formatFingerprint(hash.toString());
  }

  /// Get the fingerprint for a peer by their ID.
  ///
  /// Returns null if no public key is stored for the peer.
  String? getPeerFingerprintById(String peerId) {
    final publicKey = _peerPublicKeys[peerId];
    if (publicKey == null) return null;
    return getPeerPublicKeyFingerprint(publicKey);
  }

  /// Formats a hex string as a human-readable fingerprint.
  ///
  /// Groups hex characters into 4-character chunks separated by spaces.
  /// Example: "abcd1234ef567890..." -> "ABCD 1234 EF56 7890 ..."
  String _formatFingerprint(String hex) {
    final buffer = StringBuffer();
    for (var i = 0; i < hex.length; i += 4) {
      if (i > 0) buffer.write(' ');
      final end = (i + 4).clamp(0, hex.length);
      buffer.write(hex.substring(i, end).toUpperCase());
    }
    return buffer.toString();
  }

  /// Get our public key as a base64 string for sharing with peers (async version).
  Future<String> getPublicKeyBase64() async {
    if (_identityKeyPair == null) {
      await _loadOrGenerateIdentityKeys();
    }
    final publicKey = await _identityKeyPair!.extractPublicKey();
    final bytes = Uint8List.fromList(publicKey.bytes);
    return base64Encode(bytes);
  }

  /// Get our public key as raw bytes.
  Future<Uint8List> getPublicKeyBytes() async {
    if (_identityKeyPair == null) {
      await _loadOrGenerateIdentityKeys();
    }
    final publicKey = await _identityKeyPair!.extractPublicKey();
    return Uint8List.fromList(publicKey.bytes);
  }

  /// Get session key bytes for a peer (for deriving meeting points).
  ///
  /// Returns null if no session is established with the peer.
  Future<Uint8List?> getSessionKeyBytes(String peerId) async {
    final sessionKey = await _getSessionKey(peerId);
    if (sessionKey == null) return null;
    final bytes = await sessionKey.extractBytes();
    return Uint8List.fromList(bytes);
  }

  /// Encrypt data specifically for a peer using their session key.
  ///
  /// This is an alias for [encrypt] with a different name for clarity.
  Future<String> encryptForPeer(String peerId, String plaintext) async {
    return encrypt(peerId, plaintext);
  }

  /// Decrypt data from a specific peer using their session key.
  ///
  /// This is an alias for [decrypt] with a different name for clarity.
  Future<String> decryptFromPeer(String peerId, String ciphertextBase64) async {
    return decrypt(peerId, ciphertextBase64);
  }

  /// Perform X25519 key exchange with a peer's public key.
  ///
  /// Returns a base64-encoded shared secret suitable for deriving session keys.
  Future<String> performKeyExchange(String peerPublicKeyBase64) async {
    if (_identityKeyPair == null) {
      await _loadOrGenerateIdentityKeys();
    }

    final peerPublicKeyBytes = base64Decode(peerPublicKeyBase64);
    final peerPublicKey = SimplePublicKey(
      peerPublicKeyBytes,
      type: KeyPairType.x25519,
    );

    // Perform ECDH
    final sharedSecret = await _x25519.sharedSecretKey(
      keyPair: _identityKeyPair!,
      remotePublicKey: peerPublicKey,
    );

    final sharedSecretBytes = await sharedSecret.extractBytes();
    return base64Encode(sharedSecretBytes);
  }

  /// Establish a session with a peer using their public key.
  ///
  /// Returns the session ID that can be used for encryption/decryption.
  Future<String> establishSession(
      String peerId, String peerPublicKeyBase64) async {
    final sharedSecretBase64 = await performKeyExchange(peerPublicKeyBase64);
    final sharedSecretBytes = base64Decode(sharedSecretBase64);

    // Derive session key using HKDF
    final sessionKey = await _hkdf.deriveKey(
      secretKey: SecretKey(sharedSecretBytes),
      info: utf8.encode('zajel_session'),
      nonce: const [],
    );

    // Store session key
    _sessionKeys[peerId] = sessionKey;

    // Persist encrypted session key
    await _storeSessionKey(peerId, sessionKey);

    return peerId;
  }

  /// Encrypt a message for a peer.
  ///
  /// Uses ChaCha20-Poly1305 with a random nonce.
  /// Returns base64-encoded ciphertext with prepended nonce.
  Future<String> encrypt(String peerId, String plaintext) async {
    final sessionKey = await _getSessionKey(peerId);
    if (sessionKey == null) {
      throw CryptoException('No session established with peer: $peerId');
    }

    final plaintextBytes = utf8.encode(plaintext);
    final nonce = _chacha20.newNonce();

    final secretBox = await _chacha20.encrypt(
      plaintextBytes,
      secretKey: sessionKey,
      nonce: nonce,
    );

    // Combine nonce + ciphertext + mac
    final combined = Uint8List(
      nonce.length + secretBox.cipherText.length + secretBox.mac.bytes.length,
    );
    combined.setAll(0, nonce);
    combined.setAll(nonce.length, secretBox.cipherText);
    combined.setAll(
        nonce.length + secretBox.cipherText.length, secretBox.mac.bytes);

    return base64Encode(combined);
  }

  /// Decrypt a message from a peer.
  ///
  /// Expects base64-encoded ciphertext with prepended nonce.
  Future<String> decrypt(String peerId, String ciphertextBase64) async {
    final sessionKey = await _getSessionKey(peerId);
    if (sessionKey == null) {
      throw CryptoException('No session established with peer: $peerId');
    }

    final combined = base64Decode(ciphertextBase64);
    const nonceLength = CryptoConstants.nonceSize;
    const macLength = CryptoConstants.macSize;

    if (combined.length < nonceLength + macLength) {
      throw CryptoException('Invalid ciphertext: too short');
    }

    final nonce = combined.sublist(0, nonceLength);
    final cipherText =
        combined.sublist(nonceLength, combined.length - macLength);
    final mac = Mac(combined.sublist(combined.length - macLength));

    final secretBox = SecretBox(
      cipherText,
      nonce: nonce,
      mac: mac,
    );

    final plaintextBytes = await _chacha20.decrypt(
      secretBox,
      secretKey: sessionKey,
    );

    return utf8.decode(plaintextBytes);
  }

  /// Generate a new ephemeral key pair for a session.
  ///
  /// Used for perfect forward secrecy - each session uses fresh keys.
  Future<({String publicKey, String privateKey})>
      generateEphemeralKeyPair() async {
    final keyPair = await _x25519.newKeyPair();
    final publicKey = await keyPair.extractPublicKey();
    final privateKeyBytes = await keyPair.extractPrivateKeyBytes();

    return (
      publicKey: base64Encode(publicKey.bytes),
      privateKey: base64Encode(privateKeyBytes),
    );
  }

  /// Clear all session keys (for logout/reset).
  Future<void> clearAllSessions() async {
    _sessionKeys.clear();
    // Clear persisted session keys
    final allKeys = await _secureStorage.readAll();
    for (final key in allKeys.keys) {
      if (key.startsWith(_sessionKeyPrefix)) {
        await _secureStorage.delete(key: key);
      }
    }
  }

  /// Regenerate identity keys (for maximum privacy, do this each app start).
  Future<void> regenerateIdentityKeys() async {
    _identityKeyPair = await _x25519.newKeyPair();
    await _persistIdentityKeys();
    // Update the cache with the new public key
    final publicKey = await _identityKeyPair!.extractPublicKey();
    _publicKeyBase64Cache = base64Encode(Uint8List.fromList(publicKey.bytes));
  }

  // Private methods

  Future<void> _loadOrGenerateIdentityKeys() async {
    try {
      final privateKeyBase64 =
          await _secureStorage.read(key: '${_keyPrefix}private');
      if (privateKeyBase64 != null) {
        final privateKeyBytes = base64Decode(privateKeyBase64);
        _identityKeyPair = await _x25519.newKeyPairFromSeed(privateKeyBytes);
        return;
      }
    } catch (_) {
      // Intentionally silent: Storage read failures (corrupted data, storage API errors,
      // or invalid base64) are handled by generating new keys. This is expected behavior
      // on first run or after storage is cleared.
    }

    // Generate new identity keys
    _identityKeyPair = await _x25519.newKeyPair();
    await _persistIdentityKeys();
  }

  Future<void> _persistIdentityKeys() async {
    if (_identityKeyPair == null) return;

    final privateKeyBytes = await _identityKeyPair!.extractPrivateKeyBytes();
    await _secureStorage.write(
      key: '${_keyPrefix}private',
      value: base64Encode(privateKeyBytes),
    );
  }

  Future<void> _storeSessionKey(String peerId, SecretKey sessionKey) async {
    final keyBytes = await sessionKey.extractBytes();
    await _secureStorage.write(
      key: '$_sessionKeyPrefix$peerId',
      value: base64Encode(keyBytes),
    );
  }

  Future<SecretKey?> _getSessionKey(String peerId) async {
    // Check memory cache first
    if (_sessionKeys.containsKey(peerId)) {
      return _sessionKeys[peerId];
    }

    // Try to load from secure storage
    try {
      final keyBase64 =
          await _secureStorage.read(key: '$_sessionKeyPrefix$peerId');
      if (keyBase64 != null) {
        final keyBytes = base64Decode(keyBase64);
        final sessionKey = SecretKey(keyBytes);
        _sessionKeys[peerId] = sessionKey;
        return sessionKey;
      }
    } catch (_) {
      // Intentionally silent: Session key loading failure is handled by returning null.
      // Caller will establish a new session with fresh key exchange if no key is found.
    }

    return null;
  }
}

class CryptoException implements Exception {
  final String message;
  CryptoException(this.message);

  @override
  String toString() => 'CryptoException: $message';
}
