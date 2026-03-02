import 'package:equatable/equatable.dart';

/// A vector clock for tracking causal ordering of messages in a group.
///
/// Maps each peer's device ID to the latest sequence number received from
/// that peer. Used for:
/// - Detecting missing messages during sync
/// - Establishing causal ordering (happens-before)
/// - Identifying which messages a peer is missing
class VectorClock extends Equatable {
  /// Map of {device_id: sequence_number}.
  ///
  /// Each entry represents the highest sequence number seen from that device.
  final Map<String, int> _clock;

  const VectorClock([Map<String, int>? clock]) : _clock = clock ?? const {};

  /// Create a vector clock from a map.
  factory VectorClock.fromMap(Map<String, int> map) {
    return VectorClock(Map<String, int>.from(map));
  }

  /// Get the sequence number for a specific device.
  ///
  /// Returns 0 if no messages have been received from the device.
  int operator [](String deviceId) => _clock[deviceId] ?? 0;

  /// Get all device IDs tracked by this clock.
  Set<String> get deviceIds => _clock.keys.toSet();

  /// Get the underlying map (immutable view).
  Map<String, int> toMap() => Map<String, int>.unmodifiable(_clock);

  /// Returns true if this clock has no entries.
  bool get isEmpty => _clock.isEmpty;

  /// Returns the number of entries in the clock.
  int get length => _clock.length;

  /// Increment the sequence number for a device.
  ///
  /// Returns a new [VectorClock] with the updated value.
  VectorClock increment(String deviceId) {
    final updated = Map<String, int>.from(_clock);
    updated[deviceId] = (updated[deviceId] ?? 0) + 1;
    return VectorClock(updated);
  }

  /// Set the sequence number for a device to a specific value.
  ///
  /// Returns a new [VectorClock] with the updated value.
  VectorClock set(String deviceId, int sequenceNumber) {
    final updated = Map<String, int>.from(_clock);
    updated[deviceId] = sequenceNumber;
    return VectorClock(updated);
  }

  /// Merge this clock with another, taking the maximum sequence number
  /// for each device.
  ///
  /// This is the standard vector clock merge operation used when
  /// receiving a message or syncing with a peer.
  VectorClock merge(VectorClock other) {
    final merged = Map<String, int>.from(_clock);
    for (final entry in other._clock.entries) {
      final current = merged[entry.key] ?? 0;
      if (entry.value > current) {
        merged[entry.key] = entry.value;
      }
    }
    return VectorClock(merged);
  }

  /// Returns true if this clock is causally before or equal to [other].
  ///
  /// A <= B iff for all device_id d: A[d] <= B[d]
  bool isBeforeOrEqual(VectorClock other) {
    for (final entry in _clock.entries) {
      if (entry.value > (other._clock[entry.key] ?? 0)) {
        return false;
      }
    }
    return true;
  }

  /// Returns true if this clock is strictly before [other].
  ///
  /// A < B iff A <= B and A != B
  bool isBefore(VectorClock other) {
    return isBeforeOrEqual(other) && this != other;
  }

  /// Returns true if this clock and [other] are concurrent
  /// (neither is causally before the other).
  bool isConcurrentWith(VectorClock other) {
    return !isBeforeOrEqual(other) && !other.isBeforeOrEqual(this);
  }

  /// Compute the set of messages that [other] is missing compared to this clock.
  ///
  /// Returns a map of {device_id: [list of missing sequence numbers]}.
  /// For each device where this clock is ahead of [other], the missing
  /// sequence numbers are listed.
  Map<String, List<int>> missingFrom(VectorClock other) {
    final missing = <String, List<int>>{};
    for (final entry in _clock.entries) {
      final otherSeq = other[entry.key];
      if (entry.value > otherSeq) {
        // The other peer is missing sequences (otherSeq+1) through entry.value
        missing[entry.key] = List.generate(
          entry.value - otherSeq,
          (i) => otherSeq + i + 1,
        );
      }
    }
    return missing;
  }

  /// Serialize to JSON-compatible map.
  Map<String, dynamic> toJson() =>
      _clock.map((key, value) => MapEntry(key, value));

  /// Deserialize from JSON map.
  factory VectorClock.fromJson(Map<String, dynamic> json) {
    return VectorClock(
      json.map((key, value) => MapEntry(key, (value as num).toInt())),
    );
  }

  @override
  List<Object?> get props => [_clock];

  @override
  String toString() => 'VectorClock($_clock)';
}
