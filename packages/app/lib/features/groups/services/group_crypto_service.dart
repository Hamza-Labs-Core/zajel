import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Sender key-based encryption for group messaging.
///
/// Each member generates a symmetric "sender key" and distributes it to all
/// other members via existing pairwise E2E channels (X25519). When sending a
/// message, the author encrypts once with their sender key and broadcasts
/// the ciphertext. All members who hold the sender key can decrypt.
///
/// This achieves O(1) encrypt and O(1) decrypt per message, compared to
/// O(N) for pairwise encryption.
///
/// Key rotation happens when a member leaves: all remaining members generate
/// new sender keys and redistribute them.
class GroupCryptoService {
  final Chacha20 _chacha20 = Chacha20.poly1305Aead();
  late final Hkdf _hkdf;

  /// In-memory cache of sender keys: {groupId: {deviceId: senderKey}}
  final Map<String, Map<String, SecretKey>> _senderKeys = {};

  GroupCryptoService() {
    _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
  }

  // ---------------------------------------------------------------------------
  // Sender key generation
  // ---------------------------------------------------------------------------

  /// Generate a new random sender key for encrypting our messages.
  ///
  /// Returns the raw key bytes (32 bytes) as a base64-encoded string
  /// for distribution to other members.
  Future<String> generateSenderKey() async {
    final key = await _chacha20.newSecretKey();
    final bytes = await key.extractBytes();
    return base64Encode(bytes);
  }

  // ---------------------------------------------------------------------------
  // Sender key management
  // ---------------------------------------------------------------------------

  /// Store a sender key for a member in a group.
  ///
  /// [senderKeyBase64] is the raw sender key distributed by the member.
  void setSenderKey(
    String groupId,
    String deviceId,
    String senderKeyBase64,
  ) {
    final Uint8List keyBytes;
    try {
      keyBytes = base64Decode(senderKeyBase64);
    } on FormatException {
      throw GroupCryptoException(
          'Invalid base64 encoding for sender key from $deviceId');
    }
    if (keyBytes.length != 32) {
      throw GroupCryptoException(
          'Invalid sender key length: expected 32 bytes, got ${keyBytes.length}');
    }

    _senderKeys.putIfAbsent(groupId, () => {});
    _senderKeys[groupId]![deviceId] = SecretKey(keyBytes);
  }

  /// Get a sender key for a member.
  ///
  /// Returns null if no key is stored for this member in this group.
  SecretKey? getSenderKey(String groupId, String deviceId) {
    return _senderKeys[groupId]?[deviceId];
  }

  /// Check if we have a sender key for a specific member.
  bool hasSenderKey(String groupId, String deviceId) {
    return _senderKeys[groupId]?.containsKey(deviceId) ?? false;
  }

  /// Get all device IDs for which we have sender keys in a group.
  Set<String> getSenderKeyDeviceIds(String groupId) {
    return _senderKeys[groupId]?.keys.toSet() ?? {};
  }

  /// Remove a member's sender key (e.g., when they leave the group).
  void removeSenderKey(String groupId, String deviceId) {
    _senderKeys[groupId]?.remove(deviceId);
  }

  /// Remove all sender keys for a group (e.g., during full key rotation).
  void clearGroupKeys(String groupId) {
    _senderKeys.remove(groupId);
  }

  /// Remove all cached keys (for cleanup/logout).
  void clearAllKeys() {
    _senderKeys.clear();
  }

  // ---------------------------------------------------------------------------
  // Encryption & Decryption
  // ---------------------------------------------------------------------------

  /// Encrypt a message using our sender key for the group.
  ///
  /// [plaintext] is the message bytes to encrypt.
  /// [groupId] and [selfDeviceId] identify which sender key to use.
  ///
  /// Returns the encrypted bytes (nonce + ciphertext + MAC).
  Future<Uint8List> encrypt(
    Uint8List plaintext,
    String groupId,
    String selfDeviceId,
  ) async {
    final senderKey = getSenderKey(groupId, selfDeviceId);
    if (senderKey == null) {
      throw GroupCryptoException(
          'No sender key found for $selfDeviceId in group $groupId');
    }

    final nonce = _chacha20.newNonce();

    final secretBox = await _chacha20.encrypt(
      plaintext,
      secretKey: senderKey,
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

  /// Decrypt a message using the author's sender key.
  ///
  /// [encryptedBytes] is the combined nonce + ciphertext + MAC.
  /// [groupId] and [authorDeviceId] identify which sender key to use.
  ///
  /// Returns the decrypted plaintext bytes.
  Future<Uint8List> decrypt(
    Uint8List encryptedBytes,
    String groupId,
    String authorDeviceId,
  ) async {
    const nonceLength = 12;
    const macLength = 16;

    if (encryptedBytes.length < nonceLength + macLength) {
      throw GroupCryptoException('Encrypted message too short');
    }

    final senderKey = getSenderKey(groupId, authorDeviceId);
    if (senderKey == null) {
      throw GroupCryptoException(
          'No sender key found for $authorDeviceId in group $groupId');
    }

    final nonce = encryptedBytes.sublist(0, nonceLength);
    final cipherText =
        encryptedBytes.sublist(nonceLength, encryptedBytes.length - macLength);
    final mac = Mac(encryptedBytes.sublist(encryptedBytes.length - macLength));

    final secretBox = SecretBox(cipherText, nonce: nonce, mac: mac);

    try {
      final plaintextBytes =
          await _chacha20.decrypt(secretBox, secretKey: senderKey);
      return Uint8List.fromList(plaintextBytes);
    } on SecretBoxAuthenticationError {
      throw GroupCryptoException(
          'MAC verification failed: message tampered or wrong sender key');
    } catch (e) {
      throw GroupCryptoException('Failed to decrypt message: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // Key export/import for persistence
  // ---------------------------------------------------------------------------

  /// Export all sender keys for a group as a serializable map.
  ///
  /// Returns {deviceId: base64EncodedKey}.
  Future<Map<String, String>> exportGroupKeys(String groupId) async {
    final groupKeys = _senderKeys[groupId];
    if (groupKeys == null) return {};

    final exported = <String, String>{};
    for (final entry in groupKeys.entries) {
      final bytes = await entry.value.extractBytes();
      exported[entry.key] = base64Encode(bytes);
    }
    return exported;
  }

  /// Import sender keys for a group from a serialized map.
  ///
  /// [keys] is {deviceId: base64EncodedKey}.
  void importGroupKeys(String groupId, Map<String, String> keys) {
    for (final entry in keys.entries) {
      setSenderKey(groupId, entry.key, entry.value);
    }
  }
}

/// Exception thrown by group cryptographic operations.
class GroupCryptoException implements Exception {
  final String message;
  GroupCryptoException(this.message);

  @override
  String toString() => 'GroupCryptoException: $message';
}
