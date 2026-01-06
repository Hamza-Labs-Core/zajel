import 'package:equatable/equatable.dart';

/// Information about a relay peer.
class RelayInfo extends Equatable {
  final String peerId;
  final String publicKey;
  final double? capacity;
  final int? load;
  final DateTime? lastSeen;

  const RelayInfo({
    required this.peerId,
    required this.publicKey,
    this.capacity,
    this.load,
    this.lastSeen,
  });

  RelayInfo copyWith({
    String? peerId,
    String? publicKey,
    double? capacity,
    int? load,
    DateTime? lastSeen,
  }) {
    return RelayInfo(
      peerId: peerId ?? this.peerId,
      publicKey: publicKey ?? this.publicKey,
      capacity: capacity ?? this.capacity,
      load: load ?? this.load,
      lastSeen: lastSeen ?? this.lastSeen,
    );
  }

  Map<String, dynamic> toJson() => {
        'peerId': peerId,
        'publicKey': publicKey,
        if (capacity != null) 'capacity': capacity,
        if (load != null) 'load': load,
        if (lastSeen != null) 'lastSeen': lastSeen!.toIso8601String(),
      };

  factory RelayInfo.fromJson(Map<String, dynamic> json) => RelayInfo(
        peerId: json['peerId'] as String,
        publicKey: json['publicKey'] as String,
        capacity: json['capacity'] as double?,
        load: json['load'] as int?,
        lastSeen: json['lastSeen'] != null
            ? DateTime.parse(json['lastSeen'] as String)
            : null,
      );

  @override
  List<Object?> get props => [peerId, publicKey];
}

/// Represents an active connection to a relay.
class RelayConnection {
  final String peerId;
  final String publicKey;
  final DateTime connectedAt;
  RelayConnectionState state;
  String? sourceId;

  RelayConnection({
    required this.peerId,
    required this.publicKey,
    required this.connectedAt,
    this.state = RelayConnectionState.connecting,
    this.sourceId,
  });

  Duration get connectionDuration => DateTime.now().difference(connectedAt);
}

/// Connection state for a relay.
enum RelayConnectionState {
  connecting,
  connected,
  disconnected,
  failed,
}

/// Request to introduce two peers through a relay.
class IntroductionRequest extends Equatable {
  final String fromSourceId;
  final String targetSourceId;
  final String payload;
  final int timestamp;

  const IntroductionRequest({
    required this.fromSourceId,
    required this.targetSourceId,
    required this.payload,
    required this.timestamp,
  });

  Map<String, dynamic> toJson() => {
        'type': 'introduction_request',
        'fromSourceId': fromSourceId,
        'targetSourceId': targetSourceId,
        'payload': payload,
        'timestamp': timestamp,
      };

  factory IntroductionRequest.fromJson(Map<String, dynamic> json) =>
      IntroductionRequest(
        fromSourceId: json['fromSourceId'] as String,
        targetSourceId: json['targetSourceId'] as String,
        payload: json['payload'] as String,
        timestamp: json['timestamp'] as int,
      );

  @override
  List<Object> get props => [fromSourceId, targetSourceId, timestamp];
}

/// Response to an introduction request (forwarded to target).
class IntroductionResponse extends Equatable {
  final String fromSourceId;
  final String payload;

  const IntroductionResponse({
    required this.fromSourceId,
    required this.payload,
  });

  Map<String, dynamic> toJson() => {
        'type': 'introduction_forward',
        'fromSourceId': fromSourceId,
        'payload': payload,
      };

  factory IntroductionResponse.fromJson(Map<String, dynamic> json) =>
      IntroductionResponse(
        fromSourceId: json['fromSourceId'] as String,
        payload: json['payload'] as String,
      );

  @override
  List<Object> get props => [fromSourceId, payload];
}

/// Error response for introduction request.
class IntroductionError extends Equatable {
  final String targetSourceId;
  final String error;

  const IntroductionError({
    required this.targetSourceId,
    required this.error,
  });

  Map<String, dynamic> toJson() => {
        'type': 'introduction_error',
        'targetSourceId': targetSourceId,
        'error': error,
      };

  factory IntroductionError.fromJson(Map<String, dynamic> json) =>
      IntroductionError(
        targetSourceId: json['targetSourceId'] as String,
        error: json['error'] as String,
      );

  @override
  List<Object> get props => [targetSourceId, error];
}

/// Event emitted when an introduction is received.
class IntroductionEvent extends Equatable {
  final String fromSourceId;
  final String payload;
  final String relayId;
  final DateTime receivedAt;

  IntroductionEvent({
    required this.fromSourceId,
    required this.payload,
    required this.relayId,
    DateTime? receivedAt,
  }) : receivedAt = receivedAt ?? DateTime.now();

  @override
  List<Object> get props => [fromSourceId, payload, relayId];
}

/// Event emitted when an introduction error is received.
class IntroductionErrorEvent extends Equatable {
  final String targetSourceId;
  final String error;
  final String relayId;
  final DateTime receivedAt;

  IntroductionErrorEvent({
    required this.targetSourceId,
    required this.error,
    required this.relayId,
    DateTime? receivedAt,
  }) : receivedAt = receivedAt ?? DateTime.now();

  @override
  List<Object> get props => [targetSourceId, error, relayId];
}

/// Event emitted when relay connection state changes.
class RelayStateEvent extends Equatable {
  final String relayId;
  final RelayConnectionState state;
  final String? errorMessage;
  final DateTime timestamp;

  RelayStateEvent({
    required this.relayId,
    required this.state,
    this.errorMessage,
    DateTime? timestamp,
  }) : timestamp = timestamp ?? DateTime.now();

  @override
  List<Object?> get props => [relayId, state];
}

/// Event emitted when load changes.
class LoadChangeEvent extends Equatable {
  final int previousLoad;
  final int currentLoad;
  final DateTime timestamp;

  LoadChangeEvent({
    required this.previousLoad,
    required this.currentLoad,
    DateTime? timestamp,
  }) : timestamp = timestamp ?? DateTime.now();

  int get delta => currentLoad - previousLoad;
  bool get increased => delta > 0;
  bool get decreased => delta < 0;

  @override
  List<Object> get props => [previousLoad, currentLoad];
}

/// Relay handshake message for establishing source ID.
class RelayHandshake extends Equatable {
  final String sourceId;
  final int timestamp;
  final Map<String, dynamic>? metadata;

  const RelayHandshake({
    required this.sourceId,
    required this.timestamp,
    this.metadata,
  });

  Map<String, dynamic> toJson() => {
        'type': 'relay_handshake',
        'sourceId': sourceId,
        'timestamp': timestamp,
        if (metadata != null) 'metadata': metadata,
      };

  factory RelayHandshake.fromJson(Map<String, dynamic> json) => RelayHandshake(
        sourceId: json['sourceId'] as String,
        timestamp: json['timestamp'] as int? ?? 0,
        metadata: json['metadata'] as Map<String, dynamic>?,
      );

  @override
  List<Object?> get props => [sourceId, timestamp];
}
