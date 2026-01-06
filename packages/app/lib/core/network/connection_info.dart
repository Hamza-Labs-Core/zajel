import 'dart:convert';

import 'package:equatable/equatable.dart';

/// Information about how to connect to a peer.
///
/// Contains all the details needed to establish a connection:
/// - Public key for authentication
/// - Relay information for relayed connections
/// - Direct connection info (IP/port) for fresh dead drops
class ConnectionInfo extends Equatable {
  /// The peer's public key (base64 encoded).
  final String publicKey;

  /// The relay server ID where the peer is registered.
  final String? relayId;

  /// The peer's source ID on the relay.
  final String? sourceId;

  /// The peer's IP address (may be stale for old dead drops).
  final String? ip;

  /// The peer's port for direct connections.
  final int? port;

  /// Alternative relay servers the peer is connected to.
  final List<String> fallbackRelays;

  /// When this connection info was created.
  final DateTime timestamp;

  const ConnectionInfo({
    required this.publicKey,
    this.relayId,
    this.sourceId,
    this.ip,
    this.port,
    this.fallbackRelays = const [],
    required this.timestamp,
  });

  /// Whether this info is likely stale (>1 hour old).
  ///
  /// Stale info means the IP/port may have changed, so relay
  /// connection should be preferred over direct connection.
  bool get isStale => age > const Duration(hours: 1);

  /// Age of this connection info.
  Duration get age => DateTime.now().toUtc().difference(timestamp);

  /// Create from JSON (as stored in dead drops).
  factory ConnectionInfo.fromJson(Map<String, dynamic> json) {
    return ConnectionInfo(
      publicKey: json['pubkey'] as String,
      relayId: json['relay'] as String?,
      sourceId: json['sourceId'] as String?,
      ip: json['ip'] as String?,
      port: json['port'] as int?,
      fallbackRelays:
          (json['fallbackRelays'] as List?)?.cast<String>() ?? const [],
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }

  /// Create from JSON string.
  factory ConnectionInfo.fromJsonString(String jsonString) {
    return ConnectionInfo.fromJson(jsonDecode(jsonString) as Map<String, dynamic>);
  }

  /// Convert to JSON for storage in dead drops.
  Map<String, dynamic> toJson() => {
        'pubkey': publicKey,
        if (relayId != null) 'relay': relayId,
        if (sourceId != null) 'sourceId': sourceId,
        if (ip != null) 'ip': ip,
        if (port != null) 'port': port,
        'fallbackRelays': fallbackRelays,
        'timestamp': timestamp.toIso8601String(),
      };

  /// Convert to JSON string.
  String toJsonString() => jsonEncode(toJson());

  ConnectionInfo copyWith({
    String? publicKey,
    String? relayId,
    String? sourceId,
    String? ip,
    int? port,
    List<String>? fallbackRelays,
    DateTime? timestamp,
  }) {
    return ConnectionInfo(
      publicKey: publicKey ?? this.publicKey,
      relayId: relayId ?? this.relayId,
      sourceId: sourceId ?? this.sourceId,
      ip: ip ?? this.ip,
      port: port ?? this.port,
      fallbackRelays: fallbackRelays ?? this.fallbackRelays,
      timestamp: timestamp ?? this.timestamp,
    );
  }

  @override
  List<Object?> get props => [
        publicKey,
        relayId,
        sourceId,
        ip,
        port,
        fallbackRelays,
        timestamp,
      ];

  @override
  String toString() {
    return 'ConnectionInfo(publicKey: ${publicKey.substring(0, 8)}..., '
        'relay: $relayId, sourceId: $sourceId, '
        'ip: ${ip ?? "none"}, port: ${port ?? "none"}, age: ${age.inMinutes}m)';
  }
}
