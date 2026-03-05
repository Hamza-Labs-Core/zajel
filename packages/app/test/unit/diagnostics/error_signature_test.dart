import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/diagnostics/error_signature.dart';

void main() {
  group('ErrorSignature', () {
    group('signature stability', () {
      test('two identical stack traces produce the same signature', () {
        const traceStr =
            '#0      CryptoService.deriveKey (package:zajel/core/crypto/crypto_service.dart:120:5)\n'
            '#1      PeerConnection.establish (package:zajel/core/network/peer_connection.dart:45:10)\n'
            '#2      main (package:zajel/main.dart:10:3)\n'
            '#3      _runMain (dart:isolate-patch/isolate_patch.dart:281:19)';

        final trace1 = StackTrace.fromString(traceStr);
        final trace2 = StackTrace.fromString(traceStr);

        final sig1 = ErrorSignature.compute('crypto', trace1, 'error');
        final sig2 = ErrorSignature.compute('crypto', trace2, 'error');

        expect(sig1, sig2);
      });

      test('two different stack traces produce different signatures', () {
        final trace1 = StackTrace.fromString(
          '#0      CryptoService.deriveKey (package:zajel/core/crypto/crypto_service.dart:120:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final trace2 = StackTrace.fromString(
          '#0      CryptoService.encrypt (package:zajel/core/crypto/crypto_service.dart:200:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );

        final sig1 = ErrorSignature.compute('crypto', trace1, 'error');
        final sig2 = ErrorSignature.compute('crypto', trace2, 'error');

        expect(sig1, isNot(sig2));
      });

      test(
          'same error message from different code paths produces different signatures',
          () {
        final trace1 = StackTrace.fromString(
          '#0      ServiceA.process (package:zajel/core/services/service_a.dart:42:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final trace2 = StackTrace.fromString(
          '#0      ServiceB.process (package:zajel/core/services/service_b.dart:42:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );

        final sig1 =
            ErrorSignature.compute('other', trace1, 'same error message');
        final sig2 =
            ErrorSignature.compute('other', trace2, 'same error message');

        // Different code paths = different signatures
        expect(sig1, isNot(sig2));
      });

      test(
          'signature is stable across different error message suffixes when app frames exist',
          () {
        final trace = StackTrace.fromString(
          '#0      CryptoService.deriveKey (package:zajel/core/crypto/crypto_service.dart:120:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );

        final sig1 = ErrorSignature.compute('crypto', trace, 'error A');
        final sig2 = ErrorSignature.compute('crypto', trace, 'error B');

        // When app frames exist, the message is NOT used, so signatures match
        expect(sig1, sig2);
      });

      test('different categories produce different signatures', () {
        final trace = StackTrace.fromString(
          '#0      CryptoService.deriveKey (package:zajel/core/crypto/crypto_service.dart:120:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );

        final sig1 = ErrorSignature.compute('crypto', trace, 'error');
        final sig2 = ErrorSignature.compute('network', trace, 'error');

        expect(sig1, isNot(sig2));
      });
    });

    group('frame extraction', () {
      test('only app frames (package:zajel/) are included', () {
        final trace = StackTrace.fromString(
          '#0      _RenderFlex.performLayout (package:flutter/src/rendering/flex.dart:844:15)\n'
          '#1      CryptoService.deriveKey (package:zajel/core/crypto/crypto_service.dart:120:5)\n'
          '#2      Timer._createTimer (dart:async-patch/timer_patch.dart:18:15)\n'
          '#3      main (package:zajel/main.dart:10:3)\n'
          '#4      _startIsolate (dart:isolate-patch/isolate_patch.dart:281:19)',
        );

        // Signature should only use zajel frames, not flutter/dart frames
        // There are 2 app frames in this trace
        final sig = ErrorSignature.compute('other', trace, 'error');
        expect(sig, isNotEmpty);
        expect(sig.length, 64); // SHA-256 hex string is 64 chars

        // Verify by computing what the expected signature would be with
        // only the app frames
        final traceOnlyApp = StackTrace.fromString(
          '#0      CryptoService.deriveKey (package:zajel/core/crypto/crypto_service.dart:120:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final sigOnlyApp =
            ErrorSignature.compute('other', traceOnlyApp, 'error');
        expect(sig, sigOnlyApp);
      });

      test('at most 3 app frames are used', () {
        final trace4Frames = StackTrace.fromString(
          '#0      A.a (package:zajel/core/a.dart:10:5)\n'
          '#1      B.b (package:zajel/core/b.dart:20:5)\n'
          '#2      C.c (package:zajel/core/c.dart:30:5)\n'
          '#3      D.d (package:zajel/core/d.dart:40:5)',
        );
        final trace3Frames = StackTrace.fromString(
          '#0      A.a (package:zajel/core/a.dart:10:5)\n'
          '#1      B.b (package:zajel/core/b.dart:20:5)\n'
          '#2      C.c (package:zajel/core/c.dart:30:5)',
        );

        // 4 frames should produce the same signature as 3 frames (top 3 used)
        final sig4 = ErrorSignature.compute('other', trace4Frames, 'error');
        final sig3 = ErrorSignature.compute('other', trace3Frames, 'error');
        expect(sig4, sig3);
      });

      test('fewer than 3 app frames uses all available', () {
        final trace = StackTrace.fromString(
          '#0      A.a (package:zajel/core/a.dart:10:5)\n'
          '#1      Timer._createTimer (dart:async-patch/timer_patch.dart:18:15)',
        );

        final sig = ErrorSignature.compute('other', trace, 'error');
        expect(sig, isNotEmpty);
        expect(sig.length, 64);

        // Should differ from a message-only signature (since we have 1 frame)
        final sigNoFrames = ErrorSignature.compute('other', null, 'error');
        expect(sig, isNot(sigNoFrames));
      });

      test('zero app frames falls back to message-based signature', () {
        final trace = StackTrace.fromString(
          '#0      _RenderFlex.performLayout (package:flutter/src/rendering/flex.dart:844:15)\n'
          '#1      Timer._createTimer (dart:async-patch/timer_patch.dart:18:15)',
        );

        final sigWithTrace =
            ErrorSignature.compute('other', trace, 'my error message');
        final sigNoTrace =
            ErrorSignature.compute('other', null, 'my error message');

        // Both should fall back to message-based signature
        expect(sigWithTrace, sigNoTrace);
      });

      test('null stack trace falls back to message-based signature', () {
        final sig = ErrorSignature.compute('other', null, 'my error message');
        expect(sig, isNotEmpty);
        expect(sig.length, 64);
      });
    });

    group('frame normalization', () {
      test('column numbers are stripped from frame', () {
        // Same file:line, different column -> same signature
        final trace1 = StackTrace.fromString(
          '#0      A.a (package:zajel/core/a.dart:10:5)',
        );
        final trace2 = StackTrace.fromString(
          '#0      A.a (package:zajel/core/a.dart:10:99)',
        );

        final sig1 = ErrorSignature.compute('other', trace1, 'error');
        final sig2 = ErrorSignature.compute('other', trace2, 'error');

        expect(sig1, sig2);
      });

      test('method names are stripped from frame', () {
        // Same file:line, different method name -> same signature
        final trace1 = StackTrace.fromString(
          '#0      ClassA.methodX (package:zajel/core/a.dart:10:5)',
        );
        final trace2 = StackTrace.fromString(
          '#0      ClassB.methodY (package:zajel/core/a.dart:10:5)',
        );

        final sig1 = ErrorSignature.compute('other', trace1, 'error');
        final sig2 = ErrorSignature.compute('other', trace2, 'error');

        expect(sig1, sig2);
      });

      test('lib/ prefix frames are recognized as app frames', () {
        final trace = StackTrace.fromString(
          '#0      A.a (lib/core/a.dart:10:5)',
        );

        final sig = ErrorSignature.compute('other', trace, 'error');
        // Should NOT fall back to message-based signature
        final sigMsg = ErrorSignature.compute('other', null, 'error');
        expect(sig, isNot(sigMsg));
      });
    });

    group('SHA-256 format', () {
      test('signature is a 64-character hex string', () {
        final sig = ErrorSignature.compute('other', null, 'test error');
        expect(sig.length, 64);
        expect(RegExp(r'^[0-9a-f]{64}$').hasMatch(sig), isTrue);
      });
    });
  });
}
