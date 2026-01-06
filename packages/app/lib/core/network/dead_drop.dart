import 'package:equatable/equatable.dart';

/// Represents an encrypted dead drop received from the signaling server.
///
/// A dead drop contains encrypted connection information left by a peer
/// who was looking for us but didn't find us online. The payload is
/// encrypted with our shared secret so only we can decrypt it.
class DeadDrop extends Equatable {
  /// The peer ID who left this dead drop (if known).
  final String? peerId;

  /// The encrypted payload containing connection info.
  final String encryptedPayload;

  /// The relay ID where this dead drop was found.
  final String relayId;

  /// The meeting point where this dead drop was stored.
  final String meetingPoint;

  /// When this dead drop was retrieved.
  final DateTime retrievedAt;

  DeadDrop({
    this.peerId,
    required this.encryptedPayload,
    required this.relayId,
    required this.meetingPoint,
    DateTime? retrievedAt,
  }) : retrievedAt = retrievedAt ?? DateTime.now().toUtc();

  factory DeadDrop.fromJson(Map<String, dynamic> json) {
    return DeadDrop(
      peerId: json['peerId'] as String?,
      encryptedPayload: json['encryptedPayload'] as String,
      relayId: json['relayId'] as String,
      meetingPoint: json['meetingPoint'] as String,
      retrievedAt: json['retrievedAt'] != null
          ? DateTime.parse(json['retrievedAt'] as String)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'peerId': peerId,
        'encryptedPayload': encryptedPayload,
        'relayId': relayId,
        'meetingPoint': meetingPoint,
        'retrievedAt': retrievedAt.toIso8601String(),
      };

  DeadDrop copyWith({
    String? peerId,
    String? encryptedPayload,
    String? relayId,
    String? meetingPoint,
    DateTime? retrievedAt,
  }) {
    return DeadDrop(
      peerId: peerId ?? this.peerId,
      encryptedPayload: encryptedPayload ?? this.encryptedPayload,
      relayId: relayId ?? this.relayId,
      meetingPoint: meetingPoint ?? this.meetingPoint,
      retrievedAt: retrievedAt ?? this.retrievedAt,
    );
  }

  @override
  List<Object?> get props => [
        peerId,
        encryptedPayload,
        relayId,
        meetingPoint,
        retrievedAt,
      ];

  @override
  String toString() {
    return 'DeadDrop(peerId: $peerId, relay: $relayId, '
        'meetingPoint: ${meetingPoint.substring(0, 8)}...)';
  }
}

/// Represents a live match notification from the signaling server.
///
/// A live match means another peer is currently online at the same
/// meeting point as us, so we can establish a connection immediately.
class LiveMatch extends Equatable {
  /// The peer ID who matched (if we can identify them).
  final String? peerId;

  /// The relay ID where the match occurred.
  final String relayId;

  /// The meeting point where we matched.
  final String meetingPoint;

  /// Additional connection hints from the server.
  final Map<String, dynamic>? connectionHints;

  const LiveMatch({
    this.peerId,
    required this.relayId,
    required this.meetingPoint,
    this.connectionHints,
  });

  factory LiveMatch.fromJson(Map<String, dynamic> json) {
    return LiveMatch(
      peerId: json['peerId'] as String?,
      relayId: json['relayId'] as String,
      meetingPoint: json['meetingPoint'] as String,
      connectionHints: json['connectionHints'] as Map<String, dynamic>?,
    );
  }

  Map<String, dynamic> toJson() => {
        'peerId': peerId,
        'relayId': relayId,
        'meetingPoint': meetingPoint,
        'connectionHints': connectionHints,
      };

  @override
  List<Object?> get props => [peerId, relayId, meetingPoint, connectionHints];

  @override
  String toString() {
    return 'LiveMatch(peerId: $peerId, relay: $relayId, '
        'meetingPoint: ${meetingPoint.substring(0, 8)}...)';
  }
}

/// Result of a rendezvous registration.
///
/// Contains any immediate matches (live or dead drops) found
/// when we registered our meeting points.
class RendezvousResult extends Equatable {
  /// Any peers currently online at our meeting points.
  final List<LiveMatch> liveMatches;

  /// Any dead drops left at our meeting points.
  final List<DeadDrop> deadDrops;

  /// Whether registration was successful.
  final bool success;

  /// Error message if registration failed.
  final String? error;

  const RendezvousResult({
    this.liveMatches = const [],
    this.deadDrops = const [],
    this.success = true,
    this.error,
  });

  /// Whether any matches were found.
  bool get hasMatches => liveMatches.isNotEmpty || deadDrops.isNotEmpty;

  /// Total number of matches found.
  int get totalMatches => liveMatches.length + deadDrops.length;

  factory RendezvousResult.fromJson(Map<String, dynamic> json) {
    return RendezvousResult(
      liveMatches: (json['liveMatches'] as List?)
              ?.map((e) => LiveMatch.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      deadDrops: (json['deadDrops'] as List?)
              ?.map((e) => DeadDrop.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      success: json['success'] as bool? ?? true,
      error: json['error'] as String?,
    );
  }

  factory RendezvousResult.failure(String error) {
    return RendezvousResult(
      success: false,
      error: error,
    );
  }

  Map<String, dynamic> toJson() => {
        'liveMatches': liveMatches.map((e) => e.toJson()).toList(),
        'deadDrops': deadDrops.map((e) => e.toJson()).toList(),
        'success': success,
        'error': error,
      };

  @override
  List<Object?> get props => [liveMatches, deadDrops, success, error];
}

/// Registration data sent to the signaling server.
class RendezvousRegistration extends Equatable {
  /// Daily meeting points derived from public keys.
  final List<String> dailyPoints;

  /// Hourly tokens derived from shared secret (more precise).
  final List<String> hourlyTokens;

  /// Our encrypted dead drop for others to find.
  final String? deadDrop;

  /// The relay we're connected to.
  final String relayId;

  const RendezvousRegistration({
    required this.dailyPoints,
    this.hourlyTokens = const [],
    this.deadDrop,
    required this.relayId,
  });

  Map<String, dynamic> toJson() => {
        'dailyPoints': dailyPoints,
        'hourlyTokens': hourlyTokens,
        'deadDrop': deadDrop,
        'relayId': relayId,
      };

  @override
  List<Object?> get props => [dailyPoints, hourlyTokens, deadDrop, relayId];
}
