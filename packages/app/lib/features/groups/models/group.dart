import 'dart:convert';

import 'package:equatable/equatable.dart';

/// A member of a group.
class GroupMember extends Equatable {
  /// The member's device ID (used for P2P connections).
  final String deviceId;

  /// Display name for this member.
  final String displayName;

  /// The member's X25519 public key (base64), used for pairwise key exchange.
  final String publicKey;

  /// When this member joined the group.
  final DateTime joinedAt;

  const GroupMember({
    required this.deviceId,
    required this.displayName,
    required this.publicKey,
    required this.joinedAt,
  });

  Map<String, dynamic> toJson() => {
        'device_id': deviceId,
        'display_name': displayName,
        'public_key': publicKey,
        'joined_at': joinedAt.toIso8601String(),
      };

  factory GroupMember.fromJson(Map<String, dynamic> json) => GroupMember(
        deviceId: json['device_id'] as String,
        displayName: json['display_name'] as String,
        publicKey: json['public_key'] as String,
        joinedAt: DateTime.parse(json['joined_at'] as String),
      );

  GroupMember copyWith({
    String? deviceId,
    String? displayName,
    String? publicKey,
    DateTime? joinedAt,
  }) {
    return GroupMember(
      deviceId: deviceId ?? this.deviceId,
      displayName: displayName ?? this.displayName,
      publicKey: publicKey ?? this.publicKey,
      joinedAt: joinedAt ?? this.joinedAt,
    );
  }

  @override
  List<Object?> get props => [deviceId, publicKey];
}

/// A group — small, tight-knit, full mesh P2P.
///
/// Everyone in the group knows each other. Communication is direct
/// via WebRTC data channels (no relay). Encryption uses sender keys:
/// each member generates a symmetric key and distributes it to all
/// other members via existing pairwise E2E channels.
///
/// Practical size limit: ~10-15 members (N*(N-1)/2 connections).
class Group extends Equatable {
  /// Unique identifier for this group.
  final String id;

  /// Group display name.
  final String name;

  /// Our device ID within this group.
  final String selfDeviceId;

  /// List of group members (including ourselves).
  final List<GroupMember> members;

  /// When this group was created.
  final DateTime createdAt;

  /// The device ID of the group creator.
  ///
  /// The creator has no special privileges after creation — all members
  /// are equal. This is stored only for provenance.
  final String createdBy;

  const Group({
    required this.id,
    required this.name,
    required this.selfDeviceId,
    required this.members,
    required this.createdAt,
    required this.createdBy,
  });

  /// Get our own member entry.
  GroupMember? get selfMember {
    try {
      return members.firstWhere((m) => m.deviceId == selfDeviceId);
    } catch (_) {
      return null;
    }
  }

  /// Get all other members (everyone except us).
  List<GroupMember> get otherMembers =>
      members.where((m) => m.deviceId != selfDeviceId).toList();

  /// Number of members in the group.
  int get memberCount => members.length;

  Group copyWith({
    String? id,
    String? name,
    String? selfDeviceId,
    List<GroupMember>? members,
    DateTime? createdAt,
    String? createdBy,
  }) {
    return Group(
      id: id ?? this.id,
      name: name ?? this.name,
      selfDeviceId: selfDeviceId ?? this.selfDeviceId,
      members: members ?? this.members,
      createdAt: createdAt ?? this.createdAt,
      createdBy: createdBy ?? this.createdBy,
    );
  }

  /// Serialize for local storage.
  ///
  /// Sender keys are NOT stored here — they are managed separately
  /// in secure storage by [GroupCryptoService].
  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'self_device_id': selfDeviceId,
        'members': jsonEncode(members.map((m) => m.toJson()).toList()),
        'created_at': createdAt.toIso8601String(),
        'created_by': createdBy,
      };

  factory Group.fromJson(Map<String, dynamic> json) {
    final membersJson = json['members'] is String
        ? (jsonDecode(json['members'] as String) as List<dynamic>)
        : (json['members'] as List<dynamic>);

    return Group(
      id: json['id'] as String,
      name: json['name'] as String,
      selfDeviceId: json['self_device_id'] as String,
      members: membersJson
          .map((m) => GroupMember.fromJson(m as Map<String, dynamic>))
          .toList(),
      createdAt: DateTime.parse(json['created_at'] as String),
      createdBy: json['created_by'] as String,
    );
  }

  @override
  List<Object?> get props => [id, name, members, createdAt, createdBy];
}
