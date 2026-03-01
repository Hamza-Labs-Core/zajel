import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:crypto/crypto.dart' as crypto;
import 'package:shared_preferences/shared_preferences.dart';

import '../constants.dart';
import '../logging/logger_service.dart';

/// Cryptographic service implementing X25519 key exchange and ChaCha20-Poly1305 encryption.
///
/// Session-based encryption:
/// 1. Long-lived X25519 identity keys (persisted in secure storage)
/// 2. ECDH shared secret derived per peer
/// 3. HKDF-SHA256 derives a session key from the shared secret
/// 4. ChaCha20-Poly1305 AEAD encrypts each message with a random nonce
///
/// Forward secrecy: Per-session ephemeral keys ensure that compromise of
/// the long-lived identity key does not expose past sessions. In-session
/// key ratcheting rotates the session key periodically.
class CryptoService {
  static const _keyPrefix = 'zajel_key_';
  static const _sessionKeyPrefix = 'zajel_session_';
  static const _stableIdKey = 'zajel_stable_id';

  final FlutterSecureStorage _secureStorage;
  final SharedPreferences? _prefs;
  final X25519 _x25519 = X25519();
  final Chacha20 _chacha20 = Chacha20.poly1305Aead();
  late final Hkdf _hkdf;

  SimpleKeyPair? _identityKeyPair;
  String? _publicKeyBase64Cache;
  String? _stableId;
  bool _keysWereRegenerated = false;
  final Map<String, SecretKey> _sessionKeys = {};
  final Map<String, ({SecretKey newKey, SecretKey oldKey, Uint8List nonce})>
      _pendingRatchets = {};
  final Map<String, String> _peerPublicKeys = {};

  CryptoService({FlutterSecureStorage? secureStorage, SharedPreferences? prefs})
      : _secureStorage = secureStorage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            ),
        _prefs = prefs {
    _hkdf = Hkdf(
        hmac: Hmac.sha256(), outputLength: CryptoConstants.hkdfOutputLength);
  }

  /// Initialize the crypto service and generate/load identity keys.
  ///
  /// Safe to call multiple times — subsequent calls are no-ops.
  /// (ConnectionManager.initialize() also calls this, so guard prevents
  /// double-init with its associated secure storage timeouts.)
  Future<void> initialize() async {
    if (_identityKeyPair != null) return;
    await _loadOrGenerateIdentityKeys();
    // Cache the public key for synchronous access
    if (_identityKeyPair != null) {
      final publicKey = await _identityKeyPair!.extractPublicKey();
      _publicKeyBase64Cache = base64Encode(Uint8List.fromList(publicKey.bytes));
    }
    await _loadOrGenerateStableId();
  }

  /// Get our public key as a base64 string (synchronous, requires initialize() first).
  String get publicKeyBase64 {
    if (_publicKeyBase64Cache == null) {
      throw CryptoException(
          'CryptoService not initialized. Call initialize() first.');
    }
    return _publicKeyBase64Cache!;
  }

  /// Get our stable ID (synchronous, requires initialize() first).
  ///
  /// The stable ID is a persistent 16 hex-char identity anchor that survives
  /// key rotation. Unlike the public-key-derived peer ID, this is randomly
  /// generated once and stored in SharedPreferences (resilient storage).
  String get stableId {
    if (_stableId == null) {
      throw CryptoException(
          'CryptoService not initialized. Call initialize() first.');
    }
    return _stableId!;
  }

  /// Whether identity keys were regenerated due to storage corruption.
  ///
  /// When true, the previous identity (public key) is lost and all
  /// existing peer trust relationships are broken. The UI should
  /// warn the user that their identity changed.
  bool get keysWereRegenerated => _keysWereRegenerated;

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
  @Deprecated('Use tagFromStableId instead — tags should be key-independent')
  static String tagFromPublicKey(String publicKeyBase64) {
    final publicKeyBytes = base64Decode(publicKeyBase64);
    final hash = crypto.sha256.convert(publicKeyBytes);
    return hash.toString().substring(0, 4).toUpperCase();
  }

  /// Derive a short tag from a stable ID for Discord-style identity display.
  ///
  /// Returns first 4 characters of the stableId, uppercased.
  /// Used as the #TAG portion of "Username#TAG".
  /// Unlike the deprecated tagFromPublicKey, this survives key rotation.
  static String tagFromStableId(String stableId) {
    if (stableId.length < 4) {
      throw ArgumentError(
          'stableId must be at least 4 characters, got ${stableId.length}');
    }
    return stableId.substring(0, 4).toUpperCase();
  }

  /// Store a peer's public key for later verification.
  void setPeerPublicKey(String peerId, String publicKeyBase64) {
    _peerPublicKeys[peerId] = publicKeyBase64;
  }

  /// Remove a peer's stored public key (cleanup after re-keying).
  void removePeerPublicKey(String peerId) {
    _peerPublicKeys.remove(peerId);
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

  /// Compute a shared safety number from two public keys.
  ///
  /// Both peers compute the same number by sorting keys lexicographically
  /// before hashing. The result is 60 digits displayed as 12 groups of 5.
  /// Users compare this number out-of-band (phone, in person) to verify
  /// no MITM attack has occurred.
  ///
  /// Returns a 60-digit string (all digits).
  static String computeSafetyNumber(
      String publicKeyABase64, String publicKeyBBase64) {
    final bytesA = base64Decode(publicKeyABase64);
    final bytesB = base64Decode(publicKeyBBase64);

    // Sort lexicographically so both sides get the same result
    int cmp = 0;
    for (var i = 0; i < bytesA.length && i < bytesB.length && cmp == 0; i++) {
      cmp = bytesA[i].compareTo(bytesB[i]);
    }
    if (cmp == 0) cmp = bytesA.length.compareTo(bytesB.length);

    final List<int> sorted;
    if (cmp <= 0) {
      sorted = [...bytesA, ...bytesB];
    } else {
      sorted = [...bytesB, ...bytesA];
    }

    final hash = crypto.sha256.convert(sorted);
    return _formatSafetyNumber(hash.bytes);
  }

  /// Format hash bytes into a 60-digit safety number.
  ///
  /// Takes pairs of bytes, converts to a 5-digit number (mod 100000),
  /// producing 12 groups of 5 digits = 60 digits total.
  static String _formatSafetyNumber(List<int> hashBytes) {
    final buffer = StringBuffer();
    for (var i = 0; i < 24 && i + 1 < hashBytes.length; i += 2) {
      final val = (hashBytes[i] << 8 | hashBytes[i + 1]) % 100000;
      buffer.write(val.toString().padLeft(5, '0'));
    }
    return buffer.toString().substring(0, 60);
  }

  /// Format a 60-digit safety number for display as 12 groups of 5.
  ///
  /// Example: "12345678901234..." → "12345 67890 12345 67890\n..."
  static String formatSafetyNumberForDisplay(String safetyNumber) {
    final buffer = StringBuffer();
    for (var i = 0; i < safetyNumber.length; i += 5) {
      if (i > 0) {
        buffer.write(i % 20 == 0 ? '\n' : ' ');
      }
      final end = (i + 5).clamp(0, safetyNumber.length);
      buffer.write(safetyNumber.substring(i, end));
    }
    return buffer.toString();
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

    // Diagnostic: log key fingerprints for cross-platform debugging
    final sessionKeyBytes = await sessionKey.extractBytes();
    final sessionKeyHash = crypto.sha256.convert(sessionKeyBytes).toString();
    final sharedSecretHash =
        crypto.sha256.convert(sharedSecretBytes).toString();
    logger.info(
        'CryptoService',
        'establishSession($peerId): '
            'ourPub=${publicKeyBase64.substring(0, 8)}… '
            'peerPub=${peerPublicKeyBase64.substring(0, 8)}… '
            'sharedHash=${sharedSecretHash.substring(0, 16)} '
            'sessionHash=${sessionKeyHash.substring(0, 16)}');

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
      // Log all known session keys for debugging
      logger.warning('CryptoService',
          'No session for peer=$peerId. Known sessions: ${_sessionKeys.keys.toList()}');
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
  /// After a key ratchet, falls back to the previous key during the
  /// grace period if the current key fails to decrypt.
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

    try {
      final plaintextBytes = await _chacha20.decrypt(
        secretBox,
        secretKey: sessionKey,
      );
      return utf8.decode(plaintextBytes);
    } on SecretBoxAuthenticationError catch (_) {
      // Try pending ratchet key (we're the initiator, peer already ratcheted and is using new key)
      final pending = _pendingRatchets[peerId];
      if (pending != null) {
        try {
          final plaintextBytes = await _chacha20.decrypt(
            secretBox,
            secretKey: pending.newKey,
          );
          // Peer proved they have the new key — commit the ratchet
          commitRatchet(peerId);
          return utf8.decode(plaintextBytes);
        } on SecretBoxAuthenticationError catch (_) {
          // Not encrypted with new key either, continue to grace period check
        }
      }
      // Try previous key during grace period after a ratchet
      final prev = _previousSessionKeys[peerId];
      if (prev != null &&
          DateTime.now().difference(prev.expiry) < _graceTimeout) {
        final plaintextBytes = await _chacha20.decrypt(
          secretBox,
          secretKey: prev.key,
        );
        return utf8.decode(plaintextBytes);
      }
      rethrow;
    }
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

  /// Establish a session using both identity and ephemeral key exchange.
  ///
  /// Performs two X25519 ECDH computations:
  /// 1. Identity key × Peer identity key (authenticates both parties)
  /// 2. Ephemeral key × Peer ephemeral key (provides forward secrecy)
  ///
  /// Session key = HKDF(identitySecret || ephemeralSecret, "zajel_session_v2")
  ///
  /// The ephemeral private key is deleted immediately after use.
  /// If the identity key is later compromised, past session keys
  /// cannot be recovered because the ephemeral secret is gone.
  Future<String> establishSessionWithEphemeral({
    required String peerId,
    required String peerIdentityKeyBase64,
    required String peerEphemeralKeyBase64,
    required String ourEphemeralPrivateKeyBase64,
  }) async {
    // 1. Identity ECDH (same as current establishSession)
    final identitySecretBase64 =
        await performKeyExchange(peerIdentityKeyBase64);
    final identitySecretBytes = base64Decode(identitySecretBase64);

    // 2. Ephemeral ECDH
    final ephemeralPrivateBytes = base64Decode(ourEphemeralPrivateKeyBase64);
    final ephemeralKeyPair = SimpleKeyPairData(
      ephemeralPrivateBytes,
      publicKey: SimplePublicKey([], type: KeyPairType.x25519),
      type: KeyPairType.x25519,
    );
    final peerEphemeralKey = SimplePublicKey(
      base64Decode(peerEphemeralKeyBase64),
      type: KeyPairType.x25519,
    );
    final ephemeralSecret = await _x25519.sharedSecretKey(
      keyPair: ephemeralKeyPair,
      remotePublicKey: peerEphemeralKey,
    );
    final ephemeralSecretBytes = await ephemeralSecret.extractBytes();

    // 3. Concatenate secrets: identity || ephemeral
    final combinedSecret = Uint8List(
      identitySecretBytes.length + ephemeralSecretBytes.length,
    );
    combinedSecret.setAll(0, identitySecretBytes);
    combinedSecret.setAll(identitySecretBytes.length, ephemeralSecretBytes);

    // 4. Derive session key via HKDF with v2 info string
    final sessionKey = await _hkdf.deriveKey(
      secretKey: SecretKey(combinedSecret),
      info: utf8.encode('zajel_session_v2'),
      nonce: const [],
    );

    // Diagnostic logging
    final sessionKeyBytes = await sessionKey.extractBytes();
    final sessionKeyHash = crypto.sha256.convert(sessionKeyBytes).toString();
    logger.info(
        'CryptoService',
        'establishSessionWithEphemeral($peerId): '
            'peerPub=${peerIdentityKeyBase64.substring(0, 8)}… '
            'peerEph=${peerEphemeralKeyBase64.substring(0, 8)}… '
            'sessionHash=${sessionKeyHash.substring(0, 16)}');

    // Store session key
    _sessionKeys[peerId] = sessionKey;
    await _storeSessionKey(peerId, sessionKey);

    return peerId;
  }

  /// Ratchet the session key forward using a random nonce.
  ///
  /// new_key = HKDF(current_key || nonce, "zajel_ratchet")
  ///
  /// The old key is kept in [_previousSessionKeys] for a brief grace
  /// period to decrypt in-flight messages sent before the peer
  /// processed the ratchet.
  Future<void> ratchetSessionKey(String peerId, Uint8List nonce) async {
    final currentKey = await _getSessionKey(peerId);
    if (currentKey == null) {
      throw CryptoException('No session to ratchet for peer: $peerId');
    }

    final currentKeyBytes = await currentKey.extractBytes();

    // Combine current key material with nonce
    final input = Uint8List(currentKeyBytes.length + nonce.length);
    input.setAll(0, currentKeyBytes);
    input.setAll(currentKeyBytes.length, nonce);

    // Derive new key
    final newKey = await _hkdf.deriveKey(
      secretKey: SecretKey(input),
      info: utf8.encode('zajel_ratchet'),
      nonce: const [],
    );

    // Clean up expired previous keys while we're here
    _previousSessionKeys.removeWhere(
        (_, prev) => DateTime.now().difference(prev.expiry) >= _graceTimeout);

    // Keep old key briefly for grace period
    _previousSessionKeys[peerId] = (key: currentKey, expiry: DateTime.now());

    // Install new key
    _sessionKeys[peerId] = newKey;
    await _storeSessionKey(peerId, newKey);

    final newKeyBytes = await newKey.extractBytes();
    final hash = crypto.sha256.convert(newKeyBytes).toString();
    logger.info('CryptoService',
        'ratchetSessionKey($peerId): newHash=${hash.substring(0, 16)}');
  }

  /// Prepare a ratchet without committing it.
  ///
  /// Derives the new key but does NOT replace [_sessionKeys]. The caller
  /// must later call [commitRatchet] once the peer has acknowledged or
  /// proved they hold the new key (by successfully decrypting with it).
  /// This avoids the race where the initiator switches keys before the
  /// peer has received the ratchet control message.
  Future<void> prepareRatchet(String peerId, Uint8List nonce) async {
    final currentKey = _sessionKeys[peerId];
    if (currentKey == null) {
      throw CryptoException('No session key for peer $peerId');
    }
    final currentKeyBytes = await currentKey.extractBytes();
    final input = Uint8List(currentKeyBytes.length + nonce.length);
    input.setAll(0, currentKeyBytes);
    input.setAll(currentKeyBytes.length, nonce);
    final newKey = await _hkdf.deriveKey(
      secretKey: SecretKey(input),
      info: utf8.encode('zajel_ratchet'),
      nonce: const [],
    );
    _pendingRatchets[peerId] =
        (newKey: newKey, oldKey: currentKey, nonce: nonce);
  }

  /// Commit a previously prepared ratchet.
  ///
  /// Moves the old key into [_previousSessionKeys] for the grace period
  /// and installs the new key as the active session key.
  void commitRatchet(String peerId) {
    final pending = _pendingRatchets.remove(peerId);
    if (pending == null) return;
    // Clean up expired previous keys
    _previousSessionKeys.removeWhere(
        (_, prev) => DateTime.now().difference(prev.expiry) >= _graceTimeout);
    _previousSessionKeys[peerId] =
        (key: pending.oldKey, expiry: DateTime.now());
    _sessionKeys[peerId] = pending.newKey;
    _storeSessionKey(peerId, pending.newKey);
    logger.info('CryptoService',
        'Ratchet committed for peer ${peerId.substring(0, 8)}...');
  }

  /// Whether a prepared-but-not-committed ratchet exists for [peerId].
  bool hasPendingRatchet(String peerId) => _pendingRatchets.containsKey(peerId);

  /// Grace period for old session keys after a ratchet.
  ///
  /// Messages encrypted with the old key may still be in-flight when
  /// the ratchet completes. This map holds old keys for [_graceTimeout]
  /// so those messages can still be decrypted.
  final Map<String, ({SecretKey key, DateTime expiry})> _previousSessionKeys =
      {};
  static const _graceTimeout = Duration(seconds: 30);

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

  /// Regenerate identity keys. Called from Settings when user explicitly requests it.
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
      // Timeout protects against libsecret/gnome-keyring hanging on headless
      // Linux (D-Bus call blocks if keyring daemon is not reachable).
      final privateKeyBase64 = await _secureStorage
          .read(key: '${_keyPrefix}private')
          .timeout(const Duration(seconds: 10));
      if (privateKeyBase64 != null) {
        final privateKeyBytes = base64Decode(privateKeyBase64);
        _identityKeyPair = await _x25519.newKeyPairFromSeed(privateKeyBytes);
        return;
      }
    } catch (e) {
      // Storage corruption, API error, or timeout — generating new keys will
      // break existing peer trust relationships, so log a visible warning.
      logger.warning(
          'CryptoService',
          'Failed to load identity keys from storage, generating new keys. '
              'Existing peer trust relationships will be broken. Error: $e');
      _keysWereRegenerated = true;
    }

    // Generate new identity keys (in-memory only if storage is broken)
    _identityKeyPair = await _x25519.newKeyPair();
    try {
      await _persistIdentityKeys();
    } catch (e) {
      // Secure storage is completely unavailable (e.g. headless CI with no
      // gnome-keyring). Keys stay in memory only for this session.
      logger.warning('CryptoService',
          'Failed to persist identity keys to secure storage: $e');
    }
  }

  /// Load stableId from SharedPreferences or generate a new one.
  ///
  /// Migration strategy:
  /// - If SharedPreferences has a stored stableId, use it.
  /// - If not (existing install), derive from current publicKey for backward compat.
  /// - If still not available (fresh install, no prefs), generate 16 random hex chars.
  Future<void> _loadOrGenerateStableId() async {
    // Try to load from SharedPreferences
    final stored = _prefs?.getString(_stableIdKey);
    if (stored != null && stored.length == 16) {
      _stableId = stored;
      return;
    }

    // Migration: derive from existing publicKey (matches old peerIdFromPublicKey)
    if (_publicKeyBase64Cache != null) {
      _stableId = peerIdFromPublicKey(_publicKeyBase64Cache!);
    } else {
      // Fresh install with no SharedPreferences: generate random 16 hex chars
      _stableId = _generateRandomHex(16);
    }

    // Persist for future runs
    if (_prefs != null) {
      await _prefs.setString(_stableIdKey, _stableId!);
    } else {
      // No SharedPreferences injected — stableId is ephemeral this session.
      // In production, prefs MUST be injected via cryptoServiceProvider.
      assert(() {
        // ignore: avoid_print
        print(
            'WARNING: CryptoService._prefs is null — stableId will not persist across restarts');
        return true;
      }());
    }
  }

  /// Generate a cryptographically random hex string of the given length.
  static String _generateRandomHex(int length) {
    final random = Random.secure();
    final bytes =
        List<int>.generate((length / 2).ceil(), (_) => random.nextInt(256));
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return hex.substring(0, length).toUpperCase();
  }

  Future<void> _persistIdentityKeys() async {
    if (_identityKeyPair == null) return;

    final privateKeyBytes = await _identityKeyPair!.extractPrivateKeyBytes();
    await _secureStorage
        .write(
          key: '${_keyPrefix}private',
          value: base64Encode(privateKeyBytes),
        )
        .timeout(const Duration(seconds: 10));
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
    } catch (e) {
      logger.warning('CryptoService',
          'Session key load failed for $peerId - will re-establish on next connection. Error: $e');
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
