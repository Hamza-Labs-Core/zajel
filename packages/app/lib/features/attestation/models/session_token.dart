/// Represents a session token issued after successful attestation.
///
/// Session tokens are short-lived and grant access to VPS relay servers.
/// After expiry, the app must re-attest to obtain a new token.
class SessionToken {
  /// The opaque token string sent with VPS connections.
  final String token;

  /// When the token expires (UTC).
  final DateTime expiresAt;

  /// The device ID this token was issued for.
  final String deviceId;

  const SessionToken({
    required this.token,
    required this.expiresAt,
    required this.deviceId,
  });

  factory SessionToken.fromJson(Map<String, dynamic> json) {
    return SessionToken(
      token: json['token'] as String? ?? '',
      expiresAt: json['expires_at'] != null
          ? DateTime.fromMillisecondsSinceEpoch(json['expires_at'] as int)
          : DateTime.now(),
      deviceId: json['device_id'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
        'token': token,
        'expires_at': expiresAt.millisecondsSinceEpoch,
        'device_id': deviceId,
      };

  /// Whether the token has expired.
  bool get isExpired => DateTime.now().toUtc().isAfter(expiresAt);

  /// Whether the token is still valid (not expired and has content).
  bool get isValid => token.isNotEmpty && !isExpired;

  /// Remaining time before expiration.
  Duration get timeRemaining => expiresAt.difference(DateTime.now().toUtc());

  @override
  String toString() =>
      'SessionToken(deviceId=$deviceId, expiresAt=$expiresAt, isValid=$isValid)';
}
