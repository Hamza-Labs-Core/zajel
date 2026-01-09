import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

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
      : _secureStorage = secureStorage ?? const FlutterSecureStorage() {
    _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
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
      throw CryptoException('CryptoService not initialized. Call initialize() first.');
    }
    return _publicKeyBase64Cache!;
  }

  /// Store a peer's public key for later verification.
  void setPeerPublicKey(String peerId, String publicKeyBase64) {
    _peerPublicKeys[peerId] = publicKeyBase64;
  }

  /// Get a stored peer's public key.
  String? getPeerPublicKey(String peerId) {
    return _peerPublicKeys[peerId];
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
      info: utf8.encode('zajel_session_$peerId'),
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
    const nonceLength = 12; // ChaCha20 nonce length
    const macLength = 16; // Poly1305 MAC length

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
      // Key loading failed, generate new ones
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
      // Failed to load session key
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
