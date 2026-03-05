import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/diagnostics/error_categorizer.dart';

void main() {
  group('ErrorCategorizer', () {
    group('network errors', () {
      test('SocketException is categorized as network', () {
        final error = const SocketException('Connection refused');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.network);
      });

      test('HttpException is categorized as network', () {
        final error = const HttpException('404 Not Found');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.network);
      });

      test('WebSocketException is categorized as network', () {
        final error = const WebSocketException('Connection closed');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.network);
      });

      test('connection refused message is categorized as network', () {
        final error = Exception('connection refused on port 8080');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.network);
      });

      test('connection timed out message is categorized as network', () {
        final error = Exception('connection timed out');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.network);
      });

      test('stack trace containing signaling_client.dart is network', () {
        final error = Exception('some error');
        final trace = StackTrace.fromString(
          '#0      SignalingClient.connect (package:zajel/core/network/signaling_client.dart:42:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final category = ErrorCategorizer.categorize(error, trace);
        expect(category, ErrorCategory.network);
      });

      test('stack trace containing webrtc_service.dart is network', () {
        final error = Exception('ice failed');
        final trace = StackTrace.fromString(
          '#0      WebRTCService.createOffer (package:zajel/core/network/webrtc_service.dart:88:7)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final category = ErrorCategorizer.categorize(error, trace);
        expect(category, ErrorCategory.network);
      });

      test('stack trace containing relay_client.dart is network', () {
        final error = Exception('relay error');
        final trace = StackTrace.fromString(
          '#0      RelayClient.send (package:zajel/core/network/relay_client.dart:55:9)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final category = ErrorCategorizer.categorize(error, trace);
        expect(category, ErrorCategory.network);
      });
    });

    group('crypto errors', () {
      test('error type containing CryptoException is categorized as crypto',
          () {
        final error = _FakeCryptoException('key derivation failed');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.crypto);
      });

      test('decrypt message is categorized as crypto', () {
        final error = Exception('failed to decrypt message payload');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.crypto);
      });

      test('encrypt message is categorized as crypto', () {
        final error = Exception('failed to encrypt data');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.crypto);
      });

      test('key exchange message is categorized as crypto', () {
        final error = Exception('key exchange failed');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.crypto);
      });

      test('stack trace containing crypto_service.dart is crypto', () {
        final error = Exception('error');
        final trace = StackTrace.fromString(
          '#0      CryptoService.deriveKey (package:zajel/core/crypto/crypto_service.dart:120:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final category = ErrorCategorizer.categorize(error, trace);
        expect(category, ErrorCategory.crypto);
      });

      test('stack trace containing crypto/ directory is crypto', () {
        final error = Exception('error');
        final trace = StackTrace.fromString(
          '#0      KeyRatchet.advance (package:zajel/core/crypto/key_ratchet.dart:55:7)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final category = ErrorCategorizer.categorize(error, trace);
        expect(category, ErrorCategory.crypto);
      });
    });

    group('storage errors', () {
      test('FileSystemException is categorized as storage', () {
        final error =
            const FileSystemException('Cannot open file', '/tmp/db.sqlite');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.storage);
      });

      test('shared_preferences message is categorized as storage', () {
        final error = Exception('shared_preferences not initialized');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.storage);
      });

      test('stack trace containing storage/ is storage', () {
        final error = Exception('error');
        final trace = StackTrace.fromString(
          '#0      MessageStorage.save (package:zajel/core/storage/message_storage.dart:42:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final category = ErrorCategorizer.categorize(error, trace);
        expect(category, ErrorCategory.storage);
      });
    });

    group('UI errors', () {
      test('FlutterError is categorized as ui', () {
        final error = FlutterError('A RenderFlex overflowed');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.ui);
      });

      test('FlutterError with RenderBox diagnostics is categorized as ui', () {
        final error = FlutterError.fromParts([
          ErrorSummary('RenderBox was not laid out'),
          ErrorDescription('This RenderBox did not receive layout.'),
        ]);
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.ui);
      });

      test('overflow message is categorized as ui', () {
        final error = Exception('A RenderFlex overflow by 42.0 pixels');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.ui);
      });

      test('renderflex message is categorized as ui', () {
        final error = Exception('RenderFlex children have non-zero flex');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.ui);
      });
    });

    group('protocol errors', () {
      test('protocol message is categorized as protocol', () {
        final error = Exception('protocol version mismatch');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.protocol);
      });

      test('handshake message is categorized as protocol', () {
        final error = Exception('handshake failed: invalid token');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.protocol);
      });

      test('pairing message is categorized as protocol', () {
        final error = Exception('pairing code expired');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.protocol);
      });

      test('stack trace containing protocol/ is protocol', () {
        final error = Exception('error');
        final trace = StackTrace.fromString(
          '#0      MessageProtocol.parse (package:zajel/core/protocol/message_protocol.dart:30:5)\n'
          '#1      main (package:zajel/main.dart:10:3)',
        );
        final category = ErrorCategorizer.categorize(error, trace);
        expect(category, ErrorCategory.protocol);
      });
    });

    group('other/fallback', () {
      test('unknown error with no matching heuristics is categorized as other',
          () {
        final error = Exception('something unexpected happened');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.other);
      });

      test('generic StateError is categorized as other', () {
        final error = StateError('bad state');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.other);
      });

      test('generic ArgumentError is categorized as other', () {
        final error = ArgumentError('invalid value');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.other);
      });
    });

    group('determinism', () {
      test('same error input always produces same category', () {
        final error = const SocketException('Connection refused');
        final results = <String>{};

        for (var i = 0; i < 10; i++) {
          results.add(ErrorCategorizer.categorize(error, null));
        }

        expect(results, hasLength(1));
        expect(results.first, ErrorCategory.network);
      });

      test('same error type with different messages produces same category',
          () {
        final error1 = const SocketException('Connection refused');
        final error2 = const SocketException('Connection timed out');

        expect(
          ErrorCategorizer.categorize(error1, null),
          ErrorCategorizer.categorize(error2, null),
        );
      });
    });

    group('priority ordering', () {
      test('network type takes priority over crypto message', () {
        // SocketException that mentions "decrypt" in the message
        // Type-based network detection should win over message-based crypto
        final error = const SocketException('failed to decrypt response');
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.network);
      });

      test('FlutterError with render diagnostics is ui not other', () {
        final error = FlutterError.fromParts([
          ErrorSummary('RenderBox was not laid out'),
        ]);
        final category = ErrorCategorizer.categorize(error, null);
        expect(category, ErrorCategory.ui);
      });
    });

    group('ErrorCategory constants', () {
      test('all categories are listed', () {
        expect(
            ErrorCategory.all,
            containsAll([
              'crash',
              'network',
              'crypto',
              'storage',
              'ui',
              'protocol',
              'other',
            ]));
      });
    });
  });
}

/// A fake error class whose runtimeType.toString() contains "CryptoException".
class _FakeCryptoException implements Exception {
  final String message;
  _FakeCryptoException(this.message);

  @override
  String toString() => 'CryptoException: $message';
}
