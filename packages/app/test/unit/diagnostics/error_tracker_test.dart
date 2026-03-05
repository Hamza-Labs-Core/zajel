import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/diagnostics/error_tracker.dart';

void main() {
  group('ErrorTracker', () {
    late ErrorTracker tracker;

    setUp(() {
      tracker = ErrorTracker(isEnabled: () => true);
    });

    tearDown(() {
      // Ensure hooks are restored after each test
      if (tracker.isRunning) {
        tracker.stop();
      }
    });

    group('lifecycle', () {
      test('start() registers FlutterError.onError handler', () {
        final originalHandler = FlutterError.onError;

        tracker.start();

        // The handler should have changed
        expect(FlutterError.onError, isNot(same(originalHandler)));
        expect(tracker.isRunning, isTrue);
      });

      test('stop() restores the previous FlutterError.onError handler', () {
        final originalHandler = FlutterError.onError;

        tracker.start();
        expect(FlutterError.onError, isNot(same(originalHandler)));

        tracker.stop();
        expect(FlutterError.onError, same(originalHandler));
        expect(tracker.isRunning, isFalse);
      });

      test('start() is idempotent when already running', () {
        tracker.start();
        final handlerAfterFirstStart = FlutterError.onError;

        tracker.start(); // second call
        expect(FlutterError.onError, same(handlerAfterFirstStart));
      });

      test('stop() is idempotent when not running', () {
        // Should not throw
        tracker.stop();
        tracker.stop();
        expect(tracker.isRunning, isFalse);
      });
    });

    group('error capture', () {
      test('captured error appears in drain() output', () {
        tracker.start();

        final error = Exception('test error');
        final trace = StackTrace.fromString(
          '#0      main (package:zajel/main.dart:10:3)',
        );

        tracker.recordError(error, trace);

        final errors = tracker.drain();
        expect(errors, hasLength(1));
        expect(errors.first.message, contains('test error'));
        expect(errors.first.count, 1);
      });

      test('captured error has correct category', () {
        tracker.start();

        final error = const FormatException('failed to decrypt payload');
        tracker.recordError(error, null);

        final errors = tracker.drain();
        expect(errors, hasLength(1));
        expect(errors.first.category, 'crypto');
      });

      test('captured error has a valid SHA-256 signature', () {
        tracker.start();

        tracker.recordError(Exception('test'), null);

        final errors = tracker.drain();
        expect(errors.first.signature.length, 64);
        expect(
          RegExp(r'^[0-9a-f]{64}$').hasMatch(errors.first.signature),
          isTrue,
        );
      });

      test('captured error stores stack trace string', () {
        tracker.start();

        const traceStr = '#0      main (package:zajel/main.dart:10:3)';
        final trace = StackTrace.fromString(traceStr);

        tracker.recordError(Exception('test'), trace);

        final errors = tracker.drain();
        expect(errors.first.stackTrace, contains('main.dart'));
      });

      test('FlutterError.onError captures errors', () {
        tracker.start();

        // Simulate a FlutterError being reported
        final details = FlutterErrorDetails(
          exception: FlutterError('A RenderFlex overflowed'),
          stack: StackTrace.fromString(
            '#0      Widget.build (package:zajel/features/home/home_screen.dart:25:5)',
          ),
        );
        FlutterError.onError?.call(details);

        final errors = tracker.drain();
        expect(errors, hasLength(1));
        expect(errors.first.category, 'ui');
      });

      test('FlutterError.onError chains to previous handler', () {
        var previousHandlerCalled = false;
        final originalHandler = FlutterError.onError;
        FlutterError.onError = (details) {
          previousHandlerCalled = true;
        };

        tracker.start();

        final details = FlutterErrorDetails(
          exception: FlutterError('test error'),
        );
        FlutterError.onError?.call(details);

        expect(previousHandlerCalled, isTrue);

        tracker.stop();
        // Restore the handler we set, not the tracker's saved one
        FlutterError.onError = originalHandler;
      });
    });

    group('deduplication', () {
      test('two identical errors result in a single entry with count == 2', () {
        tracker.start();

        final trace = StackTrace.fromString(
          '#0      main (package:zajel/main.dart:10:3)',
        );

        tracker.recordError(Exception('same error'), trace);
        tracker.recordError(Exception('same error'), trace);

        final errors = tracker.drain();
        expect(errors, hasLength(1));
        expect(errors.first.count, 2);
      });

      test('lastOccurrence is updated on duplicate', () {
        tracker.start();

        final trace = StackTrace.fromString(
          '#0      main (package:zajel/main.dart:10:3)',
        );

        tracker.recordError(Exception('same error'), trace);
        final firstErrors = tracker.drain();
        final firstTimestamp = firstErrors.first.lastOccurrence;

        // Re-record same error (buffer was cleared, so count starts at 1 again)
        tracker.recordError(Exception('same error'), trace);
        tracker.recordError(Exception('same error'), trace);
        final secondErrors = tracker.drain();

        expect(secondErrors.first.count, 2);
        expect(
          secondErrors.first.lastOccurrence,
          greaterThanOrEqualTo(firstTimestamp),
        );
      });

      test('different errors produce separate entries', () {
        tracker.start();

        tracker.recordError(
          Exception('error A'),
          StackTrace.fromString(
            '#0      A.a (package:zajel/core/a.dart:10:5)',
          ),
        );
        tracker.recordError(
          Exception('error B'),
          StackTrace.fromString(
            '#0      B.b (package:zajel/core/b.dart:20:5)',
          ),
        );

        final errors = tracker.drain();
        expect(errors, hasLength(2));
      });
    });

    group('drain()', () {
      test('drain() clears the buffer', () {
        tracker.start();

        tracker.recordError(Exception('test error'), null);
        expect(tracker.bufferSize, 1);

        final errors = tracker.drain();
        expect(errors, hasLength(1));
        expect(tracker.bufferSize, 0);

        // Second drain should be empty
        final secondDrain = tracker.drain();
        expect(secondDrain, isEmpty);
      });

      test('drain() returns empty list when no errors captured', () {
        tracker.start();
        final errors = tracker.drain();
        expect(errors, isEmpty);
      });
    });

    group('disabled state', () {
      test('errors are not captured when diagnostics is disabled', () {
        var enabled = true;
        final disabledTracker = ErrorTracker(isEnabled: () => enabled);
        disabledTracker.start();

        // Capture while enabled
        disabledTracker.recordError(Exception('enabled error'), null);
        expect(disabledTracker.bufferSize, 1);

        // Disable and try to capture
        enabled = false;
        disabledTracker.recordError(Exception('disabled error'), null);
        expect(disabledTracker.bufferSize, 1); // still 1, not 2

        disabledTracker.stop();
      });

      test('errors captured after stop() are not tracked', () {
        tracker.start();
        tracker.recordError(Exception('tracked'), null);
        expect(tracker.bufferSize, 1);

        tracker.stop();
        tracker.recordError(Exception('not tracked'), null);
        // recordError checks _running, so this should not be captured
        expect(tracker.bufferSize, 1);
      });

      test('FlutterError hook does not capture when disabled', () {
        var enabled = true;
        final disabledTracker = ErrorTracker(isEnabled: () => enabled);
        disabledTracker.start();

        enabled = false;

        final details = FlutterErrorDetails(
          exception: FlutterError('should not be captured'),
        );
        FlutterError.onError?.call(details);

        expect(disabledTracker.bufferSize, 0);

        disabledTracker.stop();
      });
    });

    group('buffer size limit', () {
      test('buffer does not grow beyond maxBufferSize', () {
        tracker.start();

        // Fill the buffer with unique errors
        for (var i = 0; i < ErrorTracker.maxBufferSize + 10; i++) {
          tracker.recordError(
            Exception('error $i'),
            StackTrace.fromString(
              '#0      Cls.method (package:zajel/core/file_$i.dart:${i + 1}:5)',
            ),
          );
        }

        expect(tracker.bufferSize, ErrorTracker.maxBufferSize);
      });

      test('oldest entry is evicted when buffer is full', () {
        tracker.start();

        // Fill the buffer exactly
        for (var i = 0; i < ErrorTracker.maxBufferSize; i++) {
          tracker.recordError(
            Exception('error $i'),
            StackTrace.fromString(
              '#0      Cls.method (package:zajel/core/file_$i.dart:${i + 1}:5)',
            ),
          );
        }

        // Drain and check the first entry's message
        final errorsBefore = tracker.drain();
        final firstMessage = errorsBefore.first.message;

        // Refill and add one more to trigger eviction
        for (var i = 0; i < ErrorTracker.maxBufferSize; i++) {
          tracker.recordError(
            Exception('error $i'),
            StackTrace.fromString(
              '#0      Cls.method (package:zajel/core/file_$i.dart:${i + 1}:5)',
            ),
          );
        }

        // Add one more to trigger eviction of the oldest
        tracker.recordError(
          Exception('newest error'),
          StackTrace.fromString(
            '#0      Cls.method (package:zajel/core/file_newest.dart:999:5)',
          ),
        );

        final errorsAfter = tracker.drain();
        expect(errorsAfter, hasLength(ErrorTracker.maxBufferSize));

        // The oldest error (error 0) should have been evicted
        final messages = errorsAfter.map((e) => e.message).toList();
        expect(messages, contains('Exception: newest error'));
        // The first error should have been evicted
        expect(messages, isNot(contains(firstMessage)));
      });
    });

    group('toJson serialization', () {
      test('DiagnosticError serializes correctly', () {
        tracker.start();

        tracker.recordError(
          Exception('test error'),
          StackTrace.fromString(
            '#0      main (package:zajel/main.dart:10:3)',
          ),
        );

        final errors = tracker.drain();
        final json = errors.first.toJson();

        expect(json['category'], isA<String>());
        expect(json['message'], contains('test error'));
        expect(json['stackTrace'], isA<String>());
        expect(json['signature'], isA<String>());
        expect(json['count'], 1);
        expect(json['firstOccurrence'], isA<int>());
        expect(json['lastOccurrence'], isA<int>());
      });
    });
  });
}
