import 'dart:collection';

import 'logger_service.dart';

/// A deduplicated log entry ready for upload.
class DedupedLogEntry {
  final int timestamp;
  final String severity;
  final String category;
  final String message;
  final int count;

  const DedupedLogEntry({
    required this.timestamp,
    required this.severity,
    required this.category,
    required this.message,
    required this.count,
  });

  Map<String, dynamic> toJson() => {
        'timestamp': timestamp,
        'severity': severity,
        'category': category,
        'message': message,
        'count': count,
      };
}

/// Tracks a single deduplicated message in the buffer.
class _DedupSlot {
  final String severity;
  final String category;
  final String message;
  int count;
  int firstSeen; // milliseconds since epoch
  int lastSeen; // milliseconds since epoch

  _DedupSlot({
    required this.severity,
    required this.category,
    required this.message,
    required int timestamp,
  })  : count = 1,
        firstSeen = timestamp,
        lastSeen = timestamp;
}

/// Deduplication buffer for log entries.
///
/// Tracks the last [maxSlots] unique log messages. If the same message
/// repeats within [dedupWindow], the counter is incremented instead of
/// creating a new entry. When the window expires or the message hasn't
/// appeared in more than [significanceGap], the entry is flushed with
/// its accumulated count.
class LogDedupBuffer {
  /// Maximum number of unique message slots to track.
  final int maxSlots;

  /// Window within which duplicate messages are collapsed.
  final Duration dedupWindow;

  /// If a message hasn't appeared for longer than this, it is considered
  /// significant again and the dedup counter resets.
  final Duration significanceGap;

  /// Keyed by "severity:category:message" for O(1) lookup.
  final LinkedHashMap<String, _DedupSlot> _slots = LinkedHashMap();

  /// Entries that have been flushed and are ready for upload.
  final List<DedupedLogEntry> _flushed = [];

  LogDedupBuffer({
    this.maxSlots = 200,
    this.dedupWindow = const Duration(seconds: 30),
    this.significanceGap = const Duration(minutes: 5),
  });

  /// The number of currently tracked unique slots.
  int get slotCount => _slots.length;

  /// The number of flushed entries waiting to be drained.
  int get flushedCount => _flushed.length;

  /// Add a log entry to the buffer.
  ///
  /// Returns true if the entry was deduplicated (merged into existing slot),
  /// false if a new slot was created.
  bool add(LogEntry entry) {
    final now = entry.timestamp.millisecondsSinceEpoch;
    final severity = _logLevelToSeverity(entry.level);
    final key = '$severity:${entry.tag}:${entry.message}';

    // First, flush any expired slots
    _flushExpired(now);

    final existing = _slots[key];
    if (existing != null) {
      final timeSinceLast = now - existing.lastSeen;

      if (timeSinceLast <= dedupWindow.inMilliseconds) {
        // Within dedup window — merge
        existing.count++;
        existing.lastSeen = now;
        return true;
      }

      if (timeSinceLast > significanceGap.inMilliseconds) {
        // Significance gap exceeded — flush old entry, create new slot
        _flushSlot(key, existing);
        _slots[key] = _DedupSlot(
          severity: severity,
          category: entry.tag,
          message: entry.message,
          timestamp: now,
        );
        return false;
      }

      // Between dedup window and significance gap — flush and create new
      _flushSlot(key, existing);
      _slots[key] = _DedupSlot(
        severity: severity,
        category: entry.tag,
        message: entry.message,
        timestamp: now,
      );
      return false;
    }

    // New message — evict oldest if at capacity
    if (_slots.length >= maxSlots) {
      final oldestKey = _slots.keys.first;
      _flushSlot(oldestKey, _slots[oldestKey]!);
    }

    _slots[key] = _DedupSlot(
      severity: severity,
      category: entry.tag,
      message: entry.message,
      timestamp: now,
    );
    return false;
  }

  /// Flush all slots whose last seen time is older than [dedupWindow].
  void _flushExpired(int nowMs) {
    final keysToFlush = <String>[];
    for (final entry in _slots.entries) {
      if (nowMs - entry.value.lastSeen > dedupWindow.inMilliseconds) {
        keysToFlush.add(entry.key);
      }
    }
    for (final key in keysToFlush) {
      _flushSlot(key, _slots[key]!);
    }
  }

  /// Move a slot to the flushed list and remove it from active tracking.
  void _flushSlot(String key, _DedupSlot slot) {
    _flushed.add(DedupedLogEntry(
      timestamp: slot.firstSeen,
      severity: slot.severity,
      category: slot.category,
      message: slot.message,
      count: slot.count,
    ));
    _slots.remove(key);
  }

  /// Flush all active slots and return all pending entries.
  ///
  /// After this call, both active slots and the flushed buffer are empty.
  List<DedupedLogEntry> drain() {
    // Flush all active slots
    final keys = _slots.keys.toList();
    for (final key in keys) {
      _flushSlot(key, _slots[key]!);
    }

    final result = List<DedupedLogEntry>.from(_flushed);
    _flushed.clear();
    return result;
  }

  /// Drain only the flushed entries without forcing active slots to flush.
  List<DedupedLogEntry> drainFlushed() {
    final result = List<DedupedLogEntry>.from(_flushed);
    _flushed.clear();
    return result;
  }

  /// Convert [LogLevel] to the severity string used in the upload payload.
  static String _logLevelToSeverity(LogLevel level) {
    switch (level) {
      case LogLevel.debug:
        return 'debug';
      case LogLevel.info:
        return 'info';
      case LogLevel.warning:
        return 'warn';
      case LogLevel.error:
        return 'error';
    }
  }
}
