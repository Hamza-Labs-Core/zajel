import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/logging/log_dedup_buffer.dart';
import 'package:zajel/core/logging/logger_service.dart';

LogEntry _entry({
  required String tag,
  required String message,
  LogLevel level = LogLevel.info,
  required DateTime timestamp,
}) {
  return LogEntry(
    timestamp: timestamp,
    level: level,
    tag: tag,
    message: message,
  );
}

void main() {
  group('LogDedupBuffer', () {
    late LogDedupBuffer buffer;
    late DateTime baseTime;

    setUp(() {
      buffer = LogDedupBuffer(
        maxSlots: 200,
        dedupWindow: const Duration(seconds: 30),
        significanceGap: const Duration(minutes: 5),
      );
      baseTime = DateTime(2026, 3, 10, 12, 0, 0);
    });

    group('basic deduplication', () {
      test('first occurrence creates a new slot', () {
        final deduped = buffer.add(_entry(
          tag: 'Network',
          message: 'Connection failed',
          timestamp: baseTime,
        ));

        expect(deduped, isFalse);
        expect(buffer.slotCount, 1);
      });

      test('same message within dedup window increments count', () {
        buffer.add(_entry(
          tag: 'Network',
          message: 'Connection failed',
          timestamp: baseTime,
        ));

        final deduped = buffer.add(_entry(
          tag: 'Network',
          message: 'Connection failed',
          timestamp: baseTime.add(const Duration(seconds: 10)),
        ));

        expect(deduped, isTrue);
        expect(buffer.slotCount, 1);

        final entries = buffer.drain();
        expect(entries.length, 1);
        expect(entries[0].count, 2);
        expect(entries[0].category, 'Network');
        expect(entries[0].message, 'Connection failed');
      });

      test('same message repeated 15 times produces count=15', () {
        for (var i = 0; i < 15; i++) {
          buffer.add(_entry(
            tag: 'Network',
            message: 'Retry',
            timestamp: baseTime.add(Duration(seconds: i * 2)),
          ));
        }

        final entries = buffer.drain();
        expect(entries.length, 1);
        expect(entries[0].count, 15);
      });

      test('different messages create separate slots', () {
        buffer.add(_entry(
          tag: 'Network',
          message: 'Connection failed',
          timestamp: baseTime,
        ));
        buffer.add(_entry(
          tag: 'Storage',
          message: 'Write error',
          timestamp: baseTime,
        ));

        expect(buffer.slotCount, 2);

        final entries = buffer.drain();
        expect(entries.length, 2);
        expect(entries[0].count, 1);
        expect(entries[1].count, 1);
      });

      test('same message but different tags are separate slots', () {
        buffer.add(_entry(
          tag: 'Network',
          message: 'Timeout',
          timestamp: baseTime,
        ));
        buffer.add(_entry(
          tag: 'Crypto',
          message: 'Timeout',
          timestamp: baseTime,
        ));

        expect(buffer.slotCount, 2);
      });

      test('same message but different severity are separate slots', () {
        buffer.add(_entry(
          tag: 'Net',
          message: 'Fail',
          level: LogLevel.info,
          timestamp: baseTime,
        ));
        buffer.add(_entry(
          tag: 'Net',
          message: 'Fail',
          level: LogLevel.error,
          timestamp: baseTime,
        ));

        expect(buffer.slotCount, 2);
      });
    });

    group('dedup window expiry', () {
      test('message after dedup window creates new entry', () {
        buffer.add(_entry(
          tag: 'Net',
          message: 'Fail',
          timestamp: baseTime,
        ));

        // 31 seconds later — outside 30s window
        buffer.add(_entry(
          tag: 'Net',
          message: 'Fail',
          timestamp: baseTime.add(const Duration(seconds: 31)),
        ));

        // Should have flushed the first entry and created a new slot
        final entries = buffer.drain();
        expect(entries.length, 2);
        expect(entries[0].count, 1);
        expect(entries[1].count, 1);
      });

      test('expired slots are flushed on next add', () {
        buffer.add(_entry(
          tag: 'Net',
          message: 'Fail',
          timestamp: baseTime,
        ));

        // Add a different message 31s later — should trigger flush of first
        buffer.add(_entry(
          tag: 'Other',
          message: 'Something',
          timestamp: baseTime.add(const Duration(seconds: 31)),
        ));

        expect(buffer.flushedCount, 1);
      });
    });

    group('significance gap', () {
      test('message after >5min gap resets dedup counter', () {
        // First burst
        for (var i = 0; i < 10; i++) {
          buffer.add(_entry(
            tag: 'Net',
            message: 'Reconnect',
            timestamp: baseTime.add(Duration(seconds: i * 2)),
          ));
        }

        // 6 minutes gap
        buffer.add(_entry(
          tag: 'Net',
          message: 'Reconnect',
          timestamp: baseTime.add(const Duration(minutes: 6)),
        ));

        final entries = buffer.drain();
        expect(entries.length, 2);
        expect(entries[0].count, 10); // first burst
        expect(entries[1].count, 1); // after gap — new significant entry
      });

      test(
          'message just under 5min gap still creates new entry (outside dedup window)',
          () {
        buffer.add(_entry(
          tag: 'Net',
          message: 'Fail',
          timestamp: baseTime,
        ));

        // 4 minutes later — outside dedup window but inside significance gap
        buffer.add(_entry(
          tag: 'Net',
          message: 'Fail',
          timestamp: baseTime.add(const Duration(minutes: 4)),
        ));

        final entries = buffer.drain();
        // Both entries should appear separately since 4min > 30s dedup window
        expect(entries.length, 2);
      });
    });

    group('capacity eviction', () {
      test('oldest slot is evicted when at capacity', () {
        final smallBuffer = LogDedupBuffer(
          maxSlots: 3,
          dedupWindow: const Duration(seconds: 30),
          significanceGap: const Duration(minutes: 5),
        );

        for (var i = 0; i < 4; i++) {
          smallBuffer.add(_entry(
            tag: 'Tag',
            message: 'Message $i',
            timestamp: baseTime.add(Duration(seconds: i)),
          ));
        }

        // Should have evicted slot 0 to make room for slot 3
        expect(smallBuffer.slotCount, 3);
        expect(smallBuffer.flushedCount, 1);

        final entries = smallBuffer.drain();
        // Flushed entry (evicted) + 3 active slots
        expect(entries.length, 4);
        expect(entries[0].message, 'Message 0'); // evicted first
      });
    });

    group('drain', () {
      test('drain returns all entries and clears buffers', () {
        buffer.add(_entry(
          tag: 'A',
          message: 'One',
          timestamp: baseTime,
        ));
        buffer.add(_entry(
          tag: 'B',
          message: 'Two',
          timestamp: baseTime,
        ));

        final entries = buffer.drain();
        expect(entries.length, 2);
        expect(buffer.slotCount, 0);
        expect(buffer.flushedCount, 0);

        // Second drain should be empty
        expect(buffer.drain(), isEmpty);
      });

      test('drainFlushed only returns flushed entries', () {
        buffer.add(_entry(
          tag: 'A',
          message: 'One',
          timestamp: baseTime,
        ));

        // Nothing flushed yet (still in active slot)
        expect(buffer.drainFlushed(), isEmpty);
        expect(buffer.slotCount, 1);
      });
    });

    group('severity mapping', () {
      test('LogLevel.debug maps to "debug"', () {
        buffer.add(_entry(
          tag: 'T',
          message: 'M',
          level: LogLevel.debug,
          timestamp: baseTime,
        ));
        final entries = buffer.drain();
        expect(entries[0].severity, 'debug');
      });

      test('LogLevel.info maps to "info"', () {
        buffer.add(_entry(
          tag: 'T',
          message: 'M',
          level: LogLevel.info,
          timestamp: baseTime,
        ));
        final entries = buffer.drain();
        expect(entries[0].severity, 'info');
      });

      test('LogLevel.warning maps to "warn"', () {
        buffer.add(_entry(
          tag: 'T',
          message: 'M',
          level: LogLevel.warning,
          timestamp: baseTime,
        ));
        final entries = buffer.drain();
        expect(entries[0].severity, 'warn');
      });

      test('LogLevel.error maps to "error"', () {
        buffer.add(_entry(
          tag: 'T',
          message: 'M',
          level: LogLevel.error,
          timestamp: baseTime,
        ));
        final entries = buffer.drain();
        expect(entries[0].severity, 'error');
      });
    });

    group('toJson', () {
      test('DedupedLogEntry serializes correctly', () {
        buffer.add(_entry(
          tag: 'Network',
          message: 'WebSocket reconnect failed',
          level: LogLevel.error,
          timestamp: baseTime,
        ));

        // Add duplicate to get count > 1
        buffer.add(_entry(
          tag: 'Network',
          message: 'WebSocket reconnect failed',
          level: LogLevel.error,
          timestamp: baseTime.add(const Duration(seconds: 5)),
        ));

        final entries = buffer.drain();
        final json = entries[0].toJson();

        expect(json['timestamp'], baseTime.millisecondsSinceEpoch);
        expect(json['severity'], 'error');
        expect(json['category'], 'Network');
        expect(json['message'], 'WebSocket reconnect failed');
        expect(json['count'], 2);
      });
    });
  });
}
