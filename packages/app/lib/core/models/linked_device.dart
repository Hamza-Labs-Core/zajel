import 'package:equatable/equatable.dart';

/// Represents a linked web device that proxies through this mobile app.
///
/// Web clients cannot have certificate pinning, so they link to a mobile app
/// via QR code and all their E2E encryption is handled by the mobile app.
/// The web client becomes a UI terminal - messages are proxied through
/// the encrypted tunnel to the mobile app.
class LinkedDevice extends Equatable {
  /// Unique identifier for this linked device session.
  final String id;

  /// User-friendly device name (e.g., "Chrome on Windows").
  final String deviceName;

  /// The public key used for the link tunnel encryption.
  final String publicKey;

  /// When this device was first linked.
  final DateTime linkedAt;

  /// When this device was last active.
  final DateTime lastSeen;

  /// Current connection state of this linked device.
  final LinkedDeviceState state;

  /// The session key for encrypting tunnel traffic (not persisted).
  /// This is derived from X25519 key exchange during linking.
  final String? sessionKeyBase64;

  const LinkedDevice({
    required this.id,
    required this.deviceName,
    required this.publicKey,
    required this.linkedAt,
    required this.lastSeen,
    this.state = LinkedDeviceState.disconnected,
    this.sessionKeyBase64,
  });

  LinkedDevice copyWith({
    String? id,
    String? deviceName,
    String? publicKey,
    DateTime? linkedAt,
    DateTime? lastSeen,
    LinkedDeviceState? state,
    String? sessionKeyBase64,
  }) {
    return LinkedDevice(
      id: id ?? this.id,
      deviceName: deviceName ?? this.deviceName,
      publicKey: publicKey ?? this.publicKey,
      linkedAt: linkedAt ?? this.linkedAt,
      lastSeen: lastSeen ?? this.lastSeen,
      state: state ?? this.state,
      sessionKeyBase64: sessionKeyBase64 ?? this.sessionKeyBase64,
    );
  }

  /// Serialize to JSON for persistence.
  /// Note: sessionKeyBase64 is intentionally excluded - it should not be persisted.
  Map<String, dynamic> toJson() => {
        'id': id,
        'deviceName': deviceName,
        'publicKey': publicKey,
        'linkedAt': linkedAt.toIso8601String(),
        'lastSeen': lastSeen.toIso8601String(),
        'state': state.name,
      };

  /// Deserialize from JSON.
  factory LinkedDevice.fromJson(Map<String, dynamic> json) => LinkedDevice(
        id: json['id'] as String,
        deviceName: json['deviceName'] as String,
        publicKey: json['publicKey'] as String,
        linkedAt: DateTime.parse(json['linkedAt'] as String),
        lastSeen: DateTime.parse(json['lastSeen'] as String),
        state: LinkedDeviceState.values.firstWhere(
          (e) => e.name == json['state'],
          orElse: () => LinkedDeviceState.disconnected,
        ),
      );

  @override
  List<Object?> get props => [id, publicKey];
}

/// Connection state for a linked web device.
enum LinkedDeviceState {
  /// Device is registered but not currently connected.
  disconnected,

  /// WebRTC connection is being established.
  connecting,

  /// Performing cryptographic handshake over the tunnel.
  handshaking,

  /// Fully connected and ready to proxy messages.
  connected,

  /// Connection attempt failed.
  failed,
}

/// Represents an active link session (before device is fully linked).
///
/// This is created when the mobile app generates a QR code for linking
/// and is upgraded to a LinkedDevice once the web client connects.
class LinkSession {
  /// 6-character code displayed under QR for manual entry.
  final String linkCode;

  /// Full QR payload: zajel-link://{code}:{pubkey}:{server_url}
  final String qrData;

  /// Temporary key pair for this link session.
  final String publicKey;
  final String privateKey;

  /// When this session expires (sessions are short-lived for security).
  final DateTime expiresAt;

  /// Signaling server URL to use for this link.
  final String signalingServerUrl;

  LinkSession({
    required this.linkCode,
    required this.qrData,
    required this.publicKey,
    required this.privateKey,
    required this.expiresAt,
    required this.signalingServerUrl,
  });

  /// Check if session has expired.
  bool get isExpired => DateTime.now().isAfter(expiresAt);
}
