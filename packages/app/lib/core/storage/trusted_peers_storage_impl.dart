import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'trusted_peers_storage.dart';

/// Secure implementation of TrustedPeersStorage using flutter_secure_storage.
///
/// Stores trusted peer data encrypted in the platform's secure storage:
/// - iOS: Keychain
/// - Android: EncryptedSharedPreferences / Keystore
/// - Windows/Linux/macOS: libsecret / Keychain
class SecureTrustedPeersStorage implements TrustedPeersStorage {
  static const _peersKey = 'trusted_peers';

  final FlutterSecureStorage _storage;
  Map<String, TrustedPeer> _cache = {};
  bool _initialized = false;

  SecureTrustedPeersStorage({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
            );

  /// Initialize and load from storage.
  Future<void> _ensureInitialized() async {
    if (_initialized) return;

    try {
      final json = await _storage.read(key: _peersKey);
      if (json != null) {
        final List<dynamic> list = jsonDecode(json);
        _cache = {
          for (final item in list)
            (item['id'] as String): TrustedPeer.fromJson(item as Map<String, dynamic>)
        };
      }
      _initialized = true;
    } catch (e) {
      _cache = {};
      _initialized = true;
      throw TrustedPeersStorageException('Failed to load trusted peers: $e');
    }
  }

  Future<void> _persist() async {
    final list = _cache.values.map((p) => p.toJson()).toList();
    await _storage.write(key: _peersKey, value: jsonEncode(list));
  }

  @override
  Future<List<String>> getAllPeerIds() async {
    await _ensureInitialized();
    return _cache.keys.toList();
  }

  @override
  Future<TrustedPeer?> getPeer(String peerId) async {
    await _ensureInitialized();
    return _cache[peerId];
  }

  @override
  Future<Uint8List?> getPublicKeyBytes(String peerId) async {
    final peer = await getPeer(peerId);
    if (peer == null) return null;
    return base64Decode(peer.publicKey);
  }

  @override
  Future<String?> getPublicKeyBase64(String peerId) async {
    final peer = await getPeer(peerId);
    return peer?.publicKey;
  }

  @override
  Future<void> savePeer(TrustedPeer peer) async {
    await _ensureInitialized();
    _cache[peer.id] = peer;
    await _persist();
  }

  @override
  Future<void> removePeer(String peerId) async {
    await _ensureInitialized();
    _cache.remove(peerId);
    await _persist();
  }

  @override
  Future<bool> isTrusted(String peerId) async {
    await _ensureInitialized();
    return _cache.containsKey(peerId);
  }

  @override
  Future<List<TrustedPeer>> getAllPeers() async {
    await _ensureInitialized();
    return _cache.values.toList();
  }

  @override
  Future<bool> isTrustedByPublicKey(String publicKey) async {
    await _ensureInitialized();
    return _cache.values.any((peer) => peer.publicKey == publicKey);
  }

  @override
  Future<void> updateLastSeen(String peerId, DateTime timestamp) async {
    await _ensureInitialized();
    final peer = _cache[peerId];
    if (peer != null) {
      _cache[peerId] = peer.copyWith(lastSeen: timestamp);
      await _persist();
    }
  }

  @override
  Future<void> updateDisplayName(String peerId, String displayName) async {
    await _ensureInitialized();
    final peer = _cache[peerId];
    if (peer != null) {
      _cache[peerId] = peer.copyWith(displayName: displayName);
      await _persist();
    }
  }

  @override
  Future<void> updateAlias(String peerId, String? alias) async {
    await _ensureInitialized();
    final peer = _cache[peerId];
    if (peer != null) {
      _cache[peerId] = alias != null
          ? peer.copyWith(alias: alias)
          : peer.copyWith(clearAlias: true);
      await _persist();
    }
  }

  @override
  Future<void> clear() async {
    _cache = {};
    await _storage.delete(key: _peersKey);
  }
}
