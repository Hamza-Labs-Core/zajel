import 'package:equatable/equatable.dart';

/// Represents a peer device on the network.
///
/// Each peer has a unique identifier, display name, and connection details.
/// For maximum privacy, the ID is ephemeral and regenerated each session.
class Peer extends Equatable {
  final String id;
  final String displayName;
  final String? ipAddress;
  final int? port;
  final String? publicKey;
  final PeerConnectionState connectionState;
  final DateTime lastSeen;
  final bool isLocal; // Discovered via mDNS on local network

  const Peer({
    required this.id,
    required this.displayName,
    this.ipAddress,
    this.port,
    this.publicKey,
    this.connectionState = PeerConnectionState.disconnected,
    required this.lastSeen,
    this.isLocal = true,
  });

  Peer copyWith({
    String? id,
    String? displayName,
    String? ipAddress,
    int? port,
    String? publicKey,
    PeerConnectionState? connectionState,
    DateTime? lastSeen,
    bool? isLocal,
  }) {
    return Peer(
      id: id ?? this.id,
      displayName: displayName ?? this.displayName,
      ipAddress: ipAddress ?? this.ipAddress,
      port: port ?? this.port,
      publicKey: publicKey ?? this.publicKey,
      connectionState: connectionState ?? this.connectionState,
      lastSeen: lastSeen ?? this.lastSeen,
      isLocal: isLocal ?? this.isLocal,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'displayName': displayName,
        'ipAddress': ipAddress,
        'port': port,
        'publicKey': publicKey,
        'connectionState': connectionState.name,
        'lastSeen': lastSeen.toIso8601String(),
        'isLocal': isLocal,
      };

  factory Peer.fromJson(Map<String, dynamic> json) => Peer(
        id: json['id'] as String,
        displayName: json['displayName'] as String,
        ipAddress: json['ipAddress'] as String?,
        port: json['port'] as int?,
        publicKey: json['publicKey'] as String?,
        connectionState: PeerConnectionState.values.firstWhere(
          (e) => e.name == json['connectionState'],
          orElse: () => PeerConnectionState.disconnected,
        ),
        lastSeen: DateTime.parse(json['lastSeen'] as String),
        isLocal: json['isLocal'] as bool? ?? true,
      );

  @override
  List<Object?> get props => [id, displayName, publicKey];
}

enum PeerConnectionState {
  disconnected,
  discovering,
  connecting,
  handshaking,
  connected,
  failed,
}
