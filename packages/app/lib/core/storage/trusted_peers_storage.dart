import 'dart:typed_data';

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

  /// The peer's public key (base64 encoded).
  final String publicKey;

  /// When we first trusted this peer.
  final DateTime trustedAt;

  /// When we last connected with this peer.
  final DateTime? lastSeen;

  /// Optional notes about this peer.
  final String? notes;

  /// Whether this peer is currently blocked.
  final bool isBlocked;

  const TrustedPeer({
    required this.id,
    required this.displayName,
    required this.publicKey,
    required this.trustedAt,
    this.lastSeen,
    this.notes,
    this.isBlocked = false,
  });

  TrustedPeer copyWith({
    String? id,
    String? displayName,
    String? publicKey,
    DateTime? trustedAt,
    DateTime? lastSeen,
    String? notes,
    bool? isBlocked,
  }) {
    return TrustedPeer(
      id: id ?? this.id,
      displayName: displayName ?? this.displayName,
      publicKey: publicKey ?? this.publicKey,
      trustedAt: trustedAt ?? this.trustedAt,
      lastSeen: lastSeen ?? this.lastSeen,
      notes: notes ?? this.notes,
      isBlocked: isBlocked ?? this.isBlocked,
    );
  }

  /// Convert from storage format.
  factory TrustedPeer.fromJson(Map<String, dynamic> json) {
    return TrustedPeer(
      id: json['id'] as String,
      displayName: json['displayName'] as String,
      publicKey: json['publicKey'] as String,
      trustedAt: DateTime.parse(json['trustedAt'] as String),
      lastSeen: json['lastSeen'] != null
          ? DateTime.parse(json['lastSeen'] as String)
          : null,
      notes: json['notes'] as String?,
      isBlocked: json['isBlocked'] as bool? ?? false,
    );
  }

  /// Convert to storage format.
  Map<String, dynamic> toJson() => {
        'id': id,
        'displayName': displayName,
        'publicKey': publicKey,
        'trustedAt': trustedAt.toIso8601String(),
        'lastSeen': lastSeen?.toIso8601String(),
        'notes': notes,
        'isBlocked': isBlocked,
      };

  /// Create from a connected Peer.
  factory TrustedPeer.fromPeer(Peer peer) {
    if (peer.publicKey == null) {
      throw ArgumentError('Peer must have a public key to be trusted');
    }
    return TrustedPeer(
      id: peer.id,
      displayName: peer.displayName,
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
