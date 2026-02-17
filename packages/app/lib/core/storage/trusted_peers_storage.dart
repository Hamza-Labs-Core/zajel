import 'dart:typed_data';

import '../crypto/crypto_service.dart';
import '../models/peer.dart';

/// Storage interface for managing trusted peers.
///
/// Trusted peers are peers we've previously connected with and verified.
/// Their public keys are stored so we can:
/// 1. Derive meeting points for reconnection
/// 2. Verify their identity when reconnecting
/// 3. Encrypt dead drops specifically for them
///
/// This is an abstract interface that can be implemented with different
/// storage backends (secure storage, encrypted SQLite, etc.).
abstract class TrustedPeersStorage {
  /// Get all trusted peer IDs.
  Future<List<String>> getAllPeerIds();

  /// Get a trusted peer by ID.
  Future<TrustedPeer?> getPeer(String peerId);

  /// Get a peer's public key bytes.
  ///
  /// Returns null if the peer is not found or has no public key.
  Future<Uint8List?> getPublicKeyBytes(String peerId);

  /// Get a peer's public key as base64.
  ///
  /// Returns null if the peer is not found or has no public key.
  Future<String?> getPublicKeyBase64(String peerId);

  /// Add or update a trusted peer.
  Future<void> savePeer(TrustedPeer peer);

  /// Remove a trusted peer.
  Future<void> removePeer(String peerId);

  /// Check if a peer is trusted.
  Future<bool> isTrusted(String peerId);

  /// Get all trusted peers.
  Future<List<TrustedPeer>> getAllPeers();

  /// Update a peer's last seen timestamp.
  Future<void> updateLastSeen(String peerId, DateTime timestamp);

  /// Update a peer's display name.
  Future<void> updateDisplayName(String peerId, String displayName);

  /// Update a peer's alias.
  Future<void> updateAlias(String peerId, String? alias);

  /// Check if a peer is trusted by their public key.
  Future<bool> isTrustedByPublicKey(String publicKey);

  /// Find a trusted peer by their public key.
  /// Returns null if no peer with this public key exists.
  Future<TrustedPeer?> getPeerByPublicKey(String publicKey);

  /// Clear all trusted peers.
  Future<void> clear();
}

/// Represents a trusted peer stored locally.
///
/// This contains the essential information needed to reconnect
/// with a peer we've previously verified.
class TrustedPeer {
  /// Unique identifier for this peer.
  final String id;

  /// Human-readable name for the peer.
  final String displayName;

  /// The peer's chosen username (Discord-style, without tag).
  final String? username;

  /// Short tag derived from the peer's public key (first 4 hex chars of SHA-256).
  final String? tag;

  /// The peer's public key (base64 encoded).
  final String publicKey;

  /// When we first trusted this peer.
  final DateTime trustedAt;

  /// When we last connected with this peer.
  final DateTime? lastSeen;

  /// Optional notes about this peer.
  final String? notes;

  /// User-assigned alias for this peer.
  final String? alias;

  /// Whether this peer is currently blocked.
  final bool isBlocked;

  /// When this peer was blocked (null if not blocked).
  final DateTime? blockedAt;

  const TrustedPeer({
    required this.id,
    required this.displayName,
    this.username,
    this.tag,
    required this.publicKey,
    required this.trustedAt,
    this.lastSeen,
    this.notes,
    this.alias,
    this.isBlocked = false,
    this.blockedAt,
  });

  TrustedPeer copyWith({
    String? id,
    String? displayName,
    String? username,
    String? tag,
    String? publicKey,
    DateTime? trustedAt,
    DateTime? lastSeen,
    String? notes,
    String? alias,
    bool clearAlias = false,
    bool? isBlocked,
    DateTime? blockedAt,
    bool clearBlockedAt = false,
  }) {
    return TrustedPeer(
      id: id ?? this.id,
      displayName: displayName ?? this.displayName,
      username: username ?? this.username,
      tag: tag ?? this.tag,
      publicKey: publicKey ?? this.publicKey,
      trustedAt: trustedAt ?? this.trustedAt,
      lastSeen: lastSeen ?? this.lastSeen,
      notes: notes ?? this.notes,
      alias: clearAlias ? null : (alias ?? this.alias),
      isBlocked: isBlocked ?? this.isBlocked,
      blockedAt: clearBlockedAt ? null : (blockedAt ?? this.blockedAt),
    );
  }

  /// Convert from storage format.
  factory TrustedPeer.fromJson(Map<String, dynamic> json) {
    return TrustedPeer(
      id: json['id'] as String,
      displayName: json['displayName'] as String,
      username: json['username'] as String?,
      tag: json['tag'] as String?,
      publicKey: json['publicKey'] as String,
      trustedAt: DateTime.parse(json['trustedAt'] as String),
      lastSeen: json['lastSeen'] != null
          ? DateTime.parse(json['lastSeen'] as String)
          : null,
      notes: json['notes'] as String?,
      alias: json['alias'] as String?,
      isBlocked: json['isBlocked'] as bool? ?? false,
      blockedAt: json['blockedAt'] != null
          ? DateTime.parse(json['blockedAt'] as String)
          : null,
    );
  }

  /// Convert to storage format.
  Map<String, dynamic> toJson() => {
        'id': id,
        'displayName': displayName,
        'username': username,
        'tag': tag,
        'publicKey': publicKey,
        'trustedAt': trustedAt.toIso8601String(),
        'lastSeen': lastSeen?.toIso8601String(),
        'notes': notes,
        'alias': alias,
        'isBlocked': isBlocked,
        'blockedAt': blockedAt?.toIso8601String(),
      };

  /// Create from a connected Peer.
  ///
  /// The peer's ID must already be set to the collision-safe stable ID
  /// (derived from the public key by ConnectionManager._resolveStablePeerId).
  factory TrustedPeer.fromPeer(Peer peer) {
    if (peer.publicKey == null) {
      throw ArgumentError('Peer must have a public key to be trusted');
    }
    return TrustedPeer(
      id: peer.id,
      displayName: peer.displayName,
      username: peer.username,
      tag: CryptoService.tagFromPublicKey(peer.publicKey!),
      publicKey: peer.publicKey!,
      trustedAt: DateTime.now().toUtc(),
      lastSeen: peer.lastSeen,
    );
  }

  @override
  String toString() {
    return 'TrustedPeer(id: $id, displayName: $displayName, '
        'trusted: ${trustedAt.toIso8601String()})';
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is TrustedPeer &&
        other.id == id &&
        other.publicKey == publicKey;
  }

  @override
  int get hashCode => id.hashCode ^ publicKey.hashCode;
}

/// Exception thrown when trusted peer storage operations fail.
class TrustedPeersStorageException implements Exception {
  final String message;

  TrustedPeersStorageException(this.message);

  @override
  String toString() => 'TrustedPeersStorageException: $message';
}
