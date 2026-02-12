import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../models/group.dart';
import '../models/group_message.dart';
import '../models/vector_clock.dart';
import 'group_crypto_service.dart';
import 'group_storage_service.dart';
import 'group_sync_service.dart';

/// High-level group operations: create, join, leave, send, receive.
///
/// Orchestrates [GroupCryptoService] for sender key encryption,
/// [GroupStorageService] for persistence, and [GroupSyncService] for
/// vector clock-based message synchronization.
class GroupService {
  /// Maximum number of members in a group.
  ///
  /// Full mesh P2P requires N*(N-1)/2 connections. At 15 members that's
  /// 105 connections, which is practical. Beyond that, latency and bandwidth
  /// increase rapidly.
  static const int maxMembers = 15;

  final GroupCryptoService _cryptoService;
  final GroupStorageService _storageService;
  final GroupSyncService _syncService;
  final _uuid = const Uuid();

  GroupService({
    required GroupCryptoService cryptoService,
    required GroupStorageService storageService,
    required GroupSyncService syncService,
  })  : _cryptoService = cryptoService,
        _storageService = storageService,
        _syncService = syncService;

  // ---------------------------------------------------------------------------
  // Group creation
  // ---------------------------------------------------------------------------

  /// Create a new group.
  ///
  /// Generates a group ID, adds the creator as the first member, generates
  /// a sender key, and persists everything.
  ///
  /// [selfDeviceId] is our device ID.
  /// [selfDisplayName] is our display name.
  /// [selfPublicKey] is our X25519 public key (base64).
  ///
  /// Returns the created [Group] and our sender key (base64) for distribution.
  Future<({Group group, String senderKey})> createGroup({
    required String name,
    required String selfDeviceId,
    required String selfDisplayName,
    required String selfPublicKey,
  }) async {
    final groupId = _uuid.v4();
    final now = DateTime.now();

    final selfMember = GroupMember(
      deviceId: selfDeviceId,
      displayName: selfDisplayName,
      publicKey: selfPublicKey,
      joinedAt: now,
    );

    final group = Group(
      id: groupId,
      name: name,
      selfDeviceId: selfDeviceId,
      members: [selfMember],
      createdAt: now,
      createdBy: selfDeviceId,
    );

    // Generate our sender key
    final senderKey = await _cryptoService.generateSenderKey();
    _cryptoService.setSenderKey(groupId, selfDeviceId, senderKey);

    // Persist
    await _storageService.saveGroup(group);
    await _storageService.saveSenderKey(groupId, selfDeviceId, senderKey);

    // Initialize vector clock
    await _storageService.saveVectorClock(groupId, const VectorClock());

    return (group: group, senderKey: senderKey);
  }

  // ---------------------------------------------------------------------------
  // Member management
  // ---------------------------------------------------------------------------

  /// Add a member to an existing group.
  ///
  /// The new member's sender key must be distributed separately via
  /// pairwise E2E channel. This method only updates the group metadata.
  ///
  /// Returns the updated [Group].
  Future<Group> addMember({
    required String groupId,
    required GroupMember newMember,
    required String newMemberSenderKey,
  }) async {
    final group = await _storageService.getGroup(groupId);
    if (group == null) {
      throw GroupServiceException('Group not found: $groupId');
    }

    if (group.memberCount >= maxMembers) {
      throw GroupServiceException('Group is full: maximum $maxMembers members');
    }

    // Check for duplicate member
    if (group.members.any((m) => m.deviceId == newMember.deviceId)) {
      throw GroupServiceException(
          'Member ${newMember.deviceId} already in group');
    }

    // Store sender key
    _cryptoService.setSenderKey(
        groupId, newMember.deviceId, newMemberSenderKey);
    await _storageService.saveSenderKey(
        groupId, newMember.deviceId, newMemberSenderKey);

    // Update group
    final updatedGroup = group.copyWith(
      members: [...group.members, newMember],
    );
    await _storageService.updateGroup(updatedGroup);

    return updatedGroup;
  }

  /// Remove a member from the group.
  ///
  /// After removal, all remaining members must rotate their sender keys
  /// so the removed member cannot decrypt new messages. Call [rotateKeys]
  /// after this.
  ///
  /// Returns the updated [Group].
  Future<Group> removeMember({
    required String groupId,
    required String deviceId,
  }) async {
    final group = await _storageService.getGroup(groupId);
    if (group == null) {
      throw GroupServiceException('Group not found: $groupId');
    }

    if (!group.members.any((m) => m.deviceId == deviceId)) {
      throw GroupServiceException('Member $deviceId not in group');
    }

    // Remove their sender key
    _cryptoService.removeSenderKey(groupId, deviceId);
    await _storageService.deleteSenderKey(groupId, deviceId);

    // Update group
    final updatedGroup = group.copyWith(
      members: group.members.where((m) => m.deviceId != deviceId).toList(),
    );
    await _storageService.updateGroup(updatedGroup);

    return updatedGroup;
  }

  /// Rotate our sender key in a group.
  ///
  /// Called after a member leaves to ensure forward secrecy: the removed
  /// member cannot decrypt messages sent with the new key.
  ///
  /// Returns the new sender key (base64) for distribution to remaining members.
  Future<String> rotateOwnKey(String groupId, String selfDeviceId) async {
    final newKey = await _cryptoService.generateSenderKey();
    _cryptoService.setSenderKey(groupId, selfDeviceId, newKey);
    await _storageService.saveSenderKey(groupId, selfDeviceId, newKey);
    return newKey;
  }

  /// Update a member's sender key (received after key rotation).
  Future<void> updateMemberKey({
    required String groupId,
    required String deviceId,
    required String newSenderKey,
  }) async {
    _cryptoService.setSenderKey(groupId, deviceId, newSenderKey);
    await _storageService.saveSenderKey(groupId, deviceId, newSenderKey);
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /// Send a message to the group.
  ///
  /// Encrypts the message with our sender key, stores it locally, and
  /// updates our vector clock. The caller is responsible for broadcasting
  /// the encrypted bytes to all connected peers via WebRTC.
  ///
  /// Returns the [GroupMessage] and encrypted bytes for broadcast.
  Future<({GroupMessage message, Uint8List encryptedBytes})> sendMessage({
    required String groupId,
    required String selfDeviceId,
    required String content,
    GroupMessageType type = GroupMessageType.text,
    Map<String, dynamic> metadata = const {},
  }) async {
    final group = await _storageService.getGroup(groupId);
    if (group == null) {
      throw GroupServiceException('Group not found: $groupId');
    }

    // Get next sequence number
    final sequenceNumber =
        await _syncService.getNextSequenceNumber(groupId, selfDeviceId);

    final message = GroupMessage(
      groupId: groupId,
      authorDeviceId: selfDeviceId,
      sequenceNumber: sequenceNumber,
      type: type,
      content: content,
      metadata: metadata,
      timestamp: DateTime.now(),
      status: GroupMessageStatus.sent,
      isOutgoing: true,
    );

    // Encrypt with our sender key
    final plaintextBytes = message.toBytes();
    final encryptedBytes =
        await _cryptoService.encrypt(plaintextBytes, groupId, selfDeviceId);

    // Store locally and update vector clock
    await _syncService.applyMessage(message);

    return (message: message, encryptedBytes: encryptedBytes);
  }

  /// Receive and decrypt a message from a group member.
  ///
  /// Decrypts the message using the author's sender key, stores it locally,
  /// and updates the vector clock.
  ///
  /// Returns the decrypted [GroupMessage], or null if it was a duplicate.
  Future<GroupMessage?> receiveMessage({
    required String groupId,
    required String authorDeviceId,
    required Uint8List encryptedBytes,
  }) async {
    // Decrypt with the author's sender key
    final plaintextBytes =
        await _cryptoService.decrypt(encryptedBytes, groupId, authorDeviceId);

    // Deserialize
    final message = GroupMessage.fromBytes(
      plaintextBytes,
      groupId: groupId,
      status: GroupMessageStatus.delivered,
      isOutgoing: false,
    );

    // Verify the author matches
    if (message.authorDeviceId != authorDeviceId) {
      throw GroupServiceException(
          'Author mismatch: encrypted by $authorDeviceId but claims to be from ${message.authorDeviceId}');
    }

    // Apply (handles deduplication)
    final wasNew = await _syncService.applyMessage(message);
    return wasNew ? message : null;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /// Get our vector clock for sharing with a peer during sync.
  Future<VectorClock> getVectorClock(String groupId) async {
    return _syncService.getVectorClock(groupId);
  }

  /// Get messages that a remote peer is missing.
  ///
  /// Used during sync: the peer sends their vector clock, we compute
  /// what they're missing, and send those messages.
  Future<List<GroupMessage>> getMessagesForSync(
    String groupId,
    VectorClock remoteClock,
  ) async {
    return _syncService.getMessagesForSync(groupId, remoteClock);
  }

  /// Apply synced messages received from a peer.
  ///
  /// Returns the number of new messages applied.
  Future<int> applySyncedMessages(List<GroupMessage> messages) async {
    return _syncService.applyMessages(messages);
  }

  // ---------------------------------------------------------------------------
  // Storage delegation
  // ---------------------------------------------------------------------------

  /// Get all groups.
  Future<List<Group>> getAllGroups() => _storageService.getAllGroups();

  /// Get a group by ID.
  Future<Group?> getGroup(String groupId) => _storageService.getGroup(groupId);

  /// Get messages for a group.
  Future<List<GroupMessage>> getMessages(
    String groupId, {
    int? limit,
    int? offset,
  }) =>
      _storageService.getMessages(groupId, limit: limit, offset: offset);

  /// Get the latest messages for a group.
  Future<List<GroupMessage>> getLatestMessages(
    String groupId, {
    int limit = 50,
  }) =>
      _storageService.getLatestMessages(groupId, limit: limit);

  /// Leave a group (self-removal).
  ///
  /// Removes the group and all its data from local storage.
  Future<void> leaveGroup(String groupId) async {
    _cryptoService.clearGroupKeys(groupId);
    await _storageService.deleteGroup(groupId);
  }

  /// Delete a group and all its data.
  Future<void> deleteGroup(String groupId) async {
    _cryptoService.clearGroupKeys(groupId);
    await _storageService.deleteGroup(groupId);
  }

  /// Load sender keys from storage into the crypto service's memory cache.
  ///
  /// Should be called at startup after the storage service is initialized.
  Future<void> loadSenderKeys(String groupId) async {
    final keys = await _storageService.loadAllSenderKeys(groupId);
    _cryptoService.importGroupKeys(groupId, keys);
  }
}

/// Exception thrown by group service operations.
class GroupServiceException implements Exception {
  final String message;
  GroupServiceException(this.message);

  @override
  String toString() => 'GroupServiceException: $message';
}
