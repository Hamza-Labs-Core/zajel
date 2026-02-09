import 'dart:convert';

/// Notification settings for the app.
class NotificationSettings {
  final bool globalDnd;
  final bool soundEnabled;
  final bool previewEnabled;
  final bool messageNotifications;
  final bool callNotifications;
  final bool peerStatusNotifications;
  final bool fileReceivedNotifications;
  final Set<String> mutedPeerIds;
  final DateTime? dndUntil;

  const NotificationSettings({
    this.globalDnd = false,
    this.soundEnabled = true,
    this.previewEnabled = true,
    this.messageNotifications = true,
    this.callNotifications = true,
    this.peerStatusNotifications = true,
    this.fileReceivedNotifications = true,
    this.mutedPeerIds = const {},
    this.dndUntil,
  });

  NotificationSettings copyWith({
    bool? globalDnd,
    bool? soundEnabled,
    bool? previewEnabled,
    bool? messageNotifications,
    bool? callNotifications,
    bool? peerStatusNotifications,
    bool? fileReceivedNotifications,
    Set<String>? mutedPeerIds,
    DateTime? dndUntil,
    bool clearDndUntil = false,
  }) {
    return NotificationSettings(
      globalDnd: globalDnd ?? this.globalDnd,
      soundEnabled: soundEnabled ?? this.soundEnabled,
      previewEnabled: previewEnabled ?? this.previewEnabled,
      messageNotifications: messageNotifications ?? this.messageNotifications,
      callNotifications: callNotifications ?? this.callNotifications,
      peerStatusNotifications: peerStatusNotifications ?? this.peerStatusNotifications,
      fileReceivedNotifications: fileReceivedNotifications ?? this.fileReceivedNotifications,
      mutedPeerIds: mutedPeerIds ?? this.mutedPeerIds,
      dndUntil: clearDndUntil ? null : (dndUntil ?? this.dndUntil),
    );
  }

  /// Whether DND is currently active (either permanent or timed).
  bool get isDndActive {
    if (!globalDnd) return false;
    if (dndUntil == null) return true;
    return DateTime.now().isBefore(dndUntil!);
  }

  /// Whether notifications should show for a given peer.
  bool shouldNotify(String peerId) {
    if (isDndActive) return false;
    if (mutedPeerIds.contains(peerId)) return false;
    return true;
  }

  Map<String, dynamic> toJson() => {
        'globalDnd': globalDnd,
        'soundEnabled': soundEnabled,
        'previewEnabled': previewEnabled,
        'messageNotifications': messageNotifications,
        'callNotifications': callNotifications,
        'peerStatusNotifications': peerStatusNotifications,
        'fileReceivedNotifications': fileReceivedNotifications,
        'mutedPeerIds': mutedPeerIds.toList(),
        'dndUntil': dndUntil?.toIso8601String(),
      };

  factory NotificationSettings.fromJson(Map<String, dynamic> json) {
    return NotificationSettings(
      globalDnd: json['globalDnd'] as bool? ?? false,
      soundEnabled: json['soundEnabled'] as bool? ?? true,
      previewEnabled: json['previewEnabled'] as bool? ?? true,
      messageNotifications: json['messageNotifications'] as bool? ?? true,
      callNotifications: json['callNotifications'] as bool? ?? true,
      peerStatusNotifications: json['peerStatusNotifications'] as bool? ?? true,
      fileReceivedNotifications: json['fileReceivedNotifications'] as bool? ?? true,
      mutedPeerIds: (json['mutedPeerIds'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toSet() ??
          {},
      dndUntil: json['dndUntil'] != null
          ? DateTime.parse(json['dndUntil'] as String)
          : null,
    );
  }

  String serialize() => jsonEncode(toJson());

  factory NotificationSettings.deserialize(String data) {
    return NotificationSettings.fromJson(
      jsonDecode(data) as Map<String, dynamic>,
    );
  }
}
