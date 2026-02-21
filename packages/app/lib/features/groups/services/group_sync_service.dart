import '../models/group_message.dart';
import '../models/vector_clock.dart';
import 'group_storage_service.dart';

/// Synchronization service for group messages using vector clocks.
///
/// Handles:
/// - Tracking what messages each peer has via vector clocks
/// - Computing which messages a peer is missing
/// - Applying received messages from sync
/// - Handling out-of-order delivery
/// - Managing offline peers catching up
class GroupSyncService {
  final GroupStorageService _storageService;

  GroupSyncService({required GroupStorageService storageService})
      : _storageService = storageService;

  // ---------------------------------------------------------------------------
  // Vector clock operations
  // ---------------------------------------------------------------------------

  /// Get the current vector clock for a group.
  ///
  /// The vector clock reflects all messages we have stored locally.
  Future<VectorClock> getVectorClock(String groupId) async {
    return _storageService.getVectorClock(groupId);
  }

  /// Update the vector clock after receiving or sending a message.
  Future<void> updateVectorClock(
    String groupId,
    String deviceId,
    int sequenceNumber,
  ) async {
    final clock = await _storageService.getVectorClock(groupId);
    final currentSeq = clock[deviceId];

    // Only update if this is a newer sequence number
    if (sequenceNumber > currentSeq) {
      final updated = clock.set(deviceId, sequenceNumber);
      await _storageService.saveVectorClock(groupId, updated);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync computation
  // ---------------------------------------------------------------------------

  /// Compute which messages the remote peer is missing based on clock comparison.
  ///
  /// [localClock] is our vector clock.
  /// [remoteClock] is the peer's vector clock.
  ///
  /// Returns a map of {deviceId: [sequence numbers the remote is missing]}.
  Map<String, List<int>> computeMissingMessages(
    VectorClock localClock,
    VectorClock remoteClock,
  ) {
    return localClock.missingFrom(remoteClock);
  }

  /// Get the actual messages that a remote peer is missing.
  ///
  /// Compares our local clock with the remote peer's clock, then fetches
  /// the corresponding messages from storage.
  Future<List<GroupMessage>> getMessagesForSync(
    String groupId,
    VectorClock remoteClock,
  ) async {
    final localClock = await getVectorClock(groupId);
    final missing = computeMissingMessages(localClock, remoteClock);

    final messages = <GroupMessage>[];
    for (final entry in missing.entries) {
      final deviceId = entry.key;
      final sequences = entry.value;
      for (final seq in sequences) {
        final message =
            await _storageService.getMessage(groupId, deviceId, seq);
        if (message != null) {
          messages.add(message);
        }
      }
    }

    // Sort by timestamp for consistent ordering
    messages.sort((a, b) => a.timestamp.compareTo(b.timestamp));
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Message application
  // ---------------------------------------------------------------------------

  /// Apply a received message to local storage and update the vector clock.
  ///
  /// Returns true if the message was new and applied, false if it was
  /// a duplicate (already stored).
  Future<bool> applyMessage(GroupMessage message) async {
    // Check if we already have this message (idempotent)
    final existing = await _storageService.getMessage(
      message.groupId,
      message.authorDeviceId,
      message.sequenceNumber,
    );
    if (existing != null) {
      return false; // Duplicate
    }

    // Store the message
    await _storageService.saveMessage(message);

    // Update vector clock
    await updateVectorClock(
      message.groupId,
      message.authorDeviceId,
      message.sequenceNumber,
    );

    return true;
  }

  /// Apply a batch of received messages (e.g., from a sync catchup).
  ///
  /// Returns the number of new messages applied (excluding duplicates).
  Future<int> applyMessages(List<GroupMessage> messages) async {
    int applied = 0;
    for (final message in messages) {
      final wasNew = await applyMessage(message);
      if (wasNew) applied++;
    }
    return applied;
  }

  // ---------------------------------------------------------------------------
  // Sequence tracking
  // ---------------------------------------------------------------------------

  /// Get the next sequence number for our own messages in a group.
  ///
  /// This is the current value in our vector clock for our device ID + 1.
  Future<int> getNextSequenceNumber(
    String groupId,
    String selfDeviceId,
  ) async {
    final clock = await getVectorClock(groupId);
    return clock[selfDeviceId] + 1;
  }

  /// Check if we have any gaps in the messages from a specific device.
  ///
  /// Returns a list of missing sequence numbers, or empty if no gaps.
  Future<List<int>> findGaps(
    String groupId,
    String deviceId,
  ) async {
    final clock = await getVectorClock(groupId);
    final maxSeq = clock[deviceId];

    if (maxSeq == 0) return [];

    final gaps = <int>[];
    for (var seq = 1; seq <= maxSeq; seq++) {
      final message = await _storageService.getMessage(groupId, deviceId, seq);
      if (message == null) {
        gaps.add(seq);
      }
    }
    return gaps;
  }
}
