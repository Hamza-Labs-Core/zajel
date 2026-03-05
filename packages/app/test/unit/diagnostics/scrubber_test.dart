import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/diagnostics/scrubber.dart';

void main() {
  group('DiagnosticsScrubber', () {
    // =========================================================================
    // IPv4 addresses
    // =========================================================================
    group('IPv4 addresses', () {
      test('scrubs standard private IPv4', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Connection failed to 192.168.1.100',
          ),
          'Connection failed to [IP]',
        );
      });

      test('scrubs emulator gateway IP', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'TURN server at 10.0.2.2:3478',
          ),
          'TURN server at [IP]:3478',
        );
      });

      test('scrubs loopback address', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Listening on 127.0.0.1:8080',
          ),
          'Listening on [IP]:8080',
        );
      });

      test('scrubs multiple IPv4 addresses in one message', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Relay from 10.0.0.1 to 172.16.0.1 failed',
          ),
          'Relay from [IP] to [IP] failed',
        );
      });

      test('does not scrub version numbers that look like IPv4', () {
        // Version numbers like 1.2.3 only have 3 octets, not 4
        expect(
          DiagnosticsScrubber.scrubErrorMessage('Version 1.2.3 detected'),
          'Version 1.2.3 detected',
        );
      });
    });

    // =========================================================================
    // IPv6 addresses
    // =========================================================================
    group('IPv6 addresses', () {
      test('scrubs full IPv6 address', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Connected to 2001:0db8:85a3:0000:0000:8a2e:0370:7334',
          ),
          'Connected to [IP]',
        );
      });

      test('scrubs compressed IPv6 with double colon prefix', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Binding to ::1 for loopback',
          ),
          'Binding to [IP] for loopback',
        );
      });

      test('scrubs link-local IPv6', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Interface fe80::1 unreachable',
          ),
          'Interface [IP] unreachable',
        );
      });

      test('scrubs shortened IPv6', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'DNS returned 2001:db8::1 for host',
          ),
          'DNS returned [IP] for host',
        );
      });
    });

    // =========================================================================
    // Pairing codes
    // =========================================================================
    group('Pairing codes', () {
      test('scrubs "code: 123456" pattern', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Pairing failed with code: 123456',
          ),
          'Pairing failed with code:[REDACTED]',
        );
      });

      test('scrubs "code=789012" pattern', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Invalid pairing code=789012',
          ),
          'Invalid pairing code:[REDACTED]',
        );
      });

      test('scrubs case-insensitive "Code" keyword', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Expired Code 5432',
          ),
          'Expired code:[REDACTED]',
        );
      });

      test('scrubs 4-digit codes', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Enter code: 4321',
          ),
          'Enter code:[REDACTED]',
        );
      });

      test('scrubs 8-digit codes', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Backup code: 12345678',
          ),
          'Backup code:[REDACTED]',
        );
      });

      test('does NOT scrub standalone numbers without "code" context', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Error 123456 occurred',
          ),
          'Error 123456 occurred',
        );
      });
    });

    // =========================================================================
    // UUIDs
    // =========================================================================
    group('UUIDs', () {
      test('scrubs standard UUID', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Session 550e8400-e29b-41d4-a716-446655440000 expired',
          ),
          'Session [UUID] expired',
        );
      });

      test('scrubs UUID at start of string', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            '550e8400-e29b-41d4-a716-446655440000: not found',
          ),
          '[UUID]: not found',
        );
      });

      test('scrubs UUID at end of string', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Missing peer 550e8400-e29b-41d4-a716-446655440000',
          ),
          'Missing peer [UUID]',
        );
      });

      test('scrubs multiple UUIDs', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Peers a1b2c3d4-e5f6-7890-abcd-ef1234567890 and '
            'f0e1d2c3-b4a5-6789-0123-456789abcdef disconnected',
          ),
          'Peers [UUID] and [UUID] disconnected',
        );
      });

      test('scrubs uppercase UUID', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'ID: 550E8400-E29B-41D4-A716-446655440000',
          ),
          'ID: [UUID]',
        );
      });
    });

    // =========================================================================
    // Base64-encoded keys
    // =========================================================================
    group('Base64-encoded keys', () {
      test('scrubs 44-char base64 string (256-bit key)', () {
        // A 32-byte key in base64 = 44 chars with trailing ==
        const key = 'dGhpcyBpcyBhIDMyIGJ5dGUga2V5IGZvciBYMjU1MTk=';
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Public key: $key',
          ),
          'Public key: [KEY]',
        );
      });

      test('scrubs 88-char base64 string (512-bit key)', () {
        const key =
            'dGhpcyBpcyBhIDY0IGJ5dGUga2V5IGZvciBFZDI1NTE5IHNpZ25hdHVyZSB2ZXJpZmljYXRpb24=';
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Signature: $key',
          ),
          'Signature: [KEY]',
        );
      });

      test('does NOT scrub short base64 strings (< 44 chars)', () {
        const shortB64 = 'aGVsbG8gd29ybGQ='; // "hello world" (16 chars)
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Token: $shortB64',
          ),
          'Token: $shortB64',
        );
      });

      test('scrubs base64 without padding', () {
        // 48 chars of base64 without = padding
        const key = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv';
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Key=$key',
          ),
          'Key=[KEY]',
        );
      });
    });

    // =========================================================================
    // Hex-encoded keys
    // =========================================================================
    group('Hex-encoded keys', () {
      test('scrubs 64-char hex string (256-bit key)', () {
        const hexKey =
            'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Key material: $hexKey',
          ),
          'Key material: [KEY]',
        );
      });

      test('scrubs 128-char hex string (512-bit hash)', () {
        const hexHash =
            'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'
            'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'SHA-512: $hexHash',
          ),
          'SHA-512: [KEY]',
        );
      });

      test('does NOT scrub short hex strings (< 64 chars)', () {
        const shortHex = 'a1b2c3d4e5f6'; // 12 chars
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Partial: $shortHex',
          ),
          'Partial: $shortHex',
        );
      });
    });

    // =========================================================================
    // Peer IDs
    // =========================================================================
    group('Peer IDs', () {
      test('scrubs "peer: <hex>" pattern', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Disconnected from peer: abc123def456abc1',
          ),
          'Disconnected from peer:[REDACTED]',
        );
      });

      test('scrubs "peer_id=<hex>" pattern', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Lookup failed for peer_id=abc123def456abc1',
          ),
          'Lookup failed for peer:[REDACTED]',
        );
      });

      test('scrubs "Peer <hex>" pattern (case-insensitive)', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Peer abc123def456abc1abc123def456abc1 timed out',
          ),
          'peer:[REDACTED] timed out',
        );
      });

      test('does NOT scrub "peer" without hex suffix', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'peer connection failed',
          ),
          'peer connection failed',
        );
      });
    });

    // =========================================================================
    // Email addresses
    // =========================================================================
    group('Email addresses', () {
      test('scrubs standard email', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Notification sent to user@example.com',
          ),
          'Notification sent to [EMAIL]',
        );
      });

      test('scrubs email with dots and hyphens', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Contact: first.last-name@sub.example.co.uk',
          ),
          'Contact: [EMAIL]',
        );
      });

      test('scrubs email with plus addressing', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Registered as user+tag@gmail.com',
          ),
          'Registered as [EMAIL]',
        );
      });

      test('scrubs multiple emails', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'From alice@a.com to bob@b.com',
          ),
          'From [EMAIL] to [EMAIL]',
        );
      });
    });

    // =========================================================================
    // Absolute file system paths
    // =========================================================================
    group('Absolute file system paths', () {
      test('scrubs Android data path', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Failed to open /data/user/0/com.hamzalabs.zajel/files/db.sqlite',
          ),
          'Failed to open [PATH]',
        );
      });

      test('scrubs macOS user path', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Key file at /Users/john/Documents/keys.pem not found',
          ),
          'Key file at [PATH] not found',
        );
      });

      test('scrubs Linux home path', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Config read from /home/user/.config/zajel/settings.json',
          ),
          'Config read from [PATH]',
        );
      });

      test('scrubs /tmp path', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Temp file /tmp/zajel_export_123.zip deleted',
          ),
          'Temp file [PATH] deleted',
        );
      });

      test('scrubs /storage (Android external)', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Saved to /storage/emulated/0/Download/file.txt',
          ),
          'Saved to [PATH]',
        );
      });

      test('does NOT scrub package: paths', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'package:zajel/core/crypto/crypto_service.dart:42',
          ),
          'package:zajel/core/crypto/crypto_service.dart:42',
        );
      });
    });

    // =========================================================================
    // URLs with query parameters
    // =========================================================================
    group('URLs with query parameters', () {
      test('scrubs URL with query string', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Request to https://signal.example.com/ws?token=abc123',
          ),
          'Request to https://signal.example.com/ws[PARAMS_REDACTED]',
        );
      });

      test('scrubs URL with fragment', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Opened https://example.com/page#section=secret',
          ),
          'Opened https://example.com/page[PARAMS_REDACTED]',
        );
      });

      test('scrubs URL with multiple query params', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'GET https://api.example.com/v1/data?key=abc&secret=xyz&ts=123',
          ),
          'GET https://api.example.com/v1/data[PARAMS_REDACTED]',
        );
      });

      test('does NOT modify URL without params', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Connected to https://example.com/path',
          ),
          'Connected to https://example.com/path',
        );
      });

      test('scrubs HTTP URL with params', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Redirect to http://localhost:8080/callback?code=authcode',
          ),
          'Redirect to http://localhost:8080/callback[PARAMS_REDACTED]',
        );
      });
    });

    // =========================================================================
    // Stack trace scrubbing
    // =========================================================================
    group('scrubStackTrace', () {
      test('retains frame numbers and package paths', () {
        const trace = '#0      CryptoService.encrypt '
            '(package:zajel/core/crypto/crypto_service.dart:142:5)\n'
            '#1      MessageProtocol.send '
            '(package:zajel/core/protocol/message_protocol.dart:89:12)\n'
            '#2      main (package:zajel/main.dart:15:3)';

        final scrubbed = DiagnosticsScrubber.scrubStackTrace(trace);

        expect(scrubbed, contains('#0'));
        expect(scrubbed, contains('#1'));
        expect(scrubbed, contains('#2'));
        expect(scrubbed,
            contains('package:zajel/core/crypto/crypto_service.dart:142:5'));
        expect(scrubbed, contains('package:zajel/main.dart:15:3'));
      });

      test('removes object addresses', () {
        const trace = '#0      Widget.build (0x7f12345678) '
            '(package:zajel/ui/home.dart:42:5)';

        final scrubbed = DiagnosticsScrubber.scrubStackTrace(trace);

        expect(scrubbed, isNot(contains('0x7f12345678')));
        expect(scrubbed, contains('package:zajel/ui/home.dart:42:5'));
      });

      test('replaces Instance of patterns', () {
        const trace = "#0      Failed to serialize Instance of 'SecretKey' "
            '(package:zajel/core/crypto/crypto_service.dart:99:7)';

        final scrubbed = DiagnosticsScrubber.scrubStackTrace(trace);

        expect(scrubbed, isNot(contains("Instance of 'SecretKey'")));
        expect(scrubbed, contains('[INSTANCE]'));
      });

      test('scrubs IP addresses embedded in stack traces', () {
        const trace = '#0      WebSocket.connect '
            '(package:zajel/core/network/ws.dart:15:3)\n'
            '        Failed to connect to 192.168.1.50:8443';

        final scrubbed = DiagnosticsScrubber.scrubStackTrace(trace);

        expect(scrubbed, isNot(contains('192.168.1.50')));
        expect(scrubbed, contains('[IP]:8443'));
      });

      test('scrubs UUIDs embedded in stack traces', () {
        const trace = '#0      PeerService.lookup '
            '(package:zajel/core/services/peer.dart:55:7)\n'
            '        Peer 550e8400-e29b-41d4-a716-446655440000 not found';

        final scrubbed = DiagnosticsScrubber.scrubStackTrace(trace);

        expect(
            scrubbed, isNot(contains('550e8400-e29b-41d4-a716-446655440000')));
        expect(scrubbed, contains('[UUID]'));
      });

      test('handles anonymous closures in stack frames', () {
        const trace = '#0      main.<anonymous closure> '
            '(package:zajel/main.dart:22:9)';

        final scrubbed = DiagnosticsScrubber.scrubStackTrace(trace);

        expect(scrubbed, contains('<anonymous closure>'));
        expect(scrubbed, contains('package:zajel/main.dart:22:9'));
      });

      test('scrubs realistic Flutter error stack trace', () {
        const trace =
            '''#0      ConnectionManager._connect (package:zajel/core/network/connection_manager.dart:142:5)
#1      ConnectionManager._connect.<anonymous closure> (package:zajel/core/network/connection_manager.dart:156:12)
#2      Future._propagateToListeners (dart:async/future_impl.dart:189:20)
#3      _RawReceivePort._handleMessage (dart:isolate:184:12)
        WebSocket connection to wss://10.0.2.2:8443/ws?session=abc123token failed
        Peer 550e8400-e29b-41d4-a716-446655440000 last seen at /data/user/0/com.hamzalabs.zajel/cache/peers.db''';

        final scrubbed = DiagnosticsScrubber.scrubStackTrace(trace);

        // Frame info preserved
        expect(scrubbed, contains('#0'));
        expect(
            scrubbed,
            contains(
                'package:zajel/core/network/connection_manager.dart:142:5'));
        expect(scrubbed, contains('dart:async/future_impl.dart:189:20'));

        // PII removed
        expect(scrubbed, isNot(contains('10.0.2.2')));
        expect(scrubbed, isNot(contains('session=abc123token')));
        expect(
            scrubbed, isNot(contains('550e8400-e29b-41d4-a716-446655440000')));
        expect(scrubbed,
            isNot(contains('/data/user/0/com.hamzalabs.zajel/cache/peers.db')));
      });
    });

    // =========================================================================
    // Composition and edge cases
    // =========================================================================
    group('Composition and edge cases', () {
      test('scrubs message with multiple PII types', () {
        const message =
            'Connection from 192.168.1.1 to peer 550e8400-e29b-41d4-a716-446655440000 '
            'failed; key was dGhpcyBpcyBhIDMyIGJ5dGUga2V5IGZvciBYMjU1MTk=';

        final scrubbed = DiagnosticsScrubber.scrubErrorMessage(message);

        expect(scrubbed, isNot(contains('192.168.1.1')));
        expect(
            scrubbed, isNot(contains('550e8400-e29b-41d4-a716-446655440000')));
        expect(scrubbed,
            isNot(contains('dGhpcyBpcyBhIDMyIGJ5dGUga2V5IGZvciBYMjU1MTk=')));
        expect(scrubbed, contains('[IP]'));
        expect(scrubbed, contains('[UUID]'));
        expect(scrubbed, contains('[KEY]'));
      });

      test('returns empty string unchanged', () {
        expect(DiagnosticsScrubber.scrubErrorMessage(''), '');
        expect(DiagnosticsScrubber.scrubStackTrace(''), '');
      });

      test('returns clean string unchanged', () {
        const clean =
            'Widget build failed: Null check operator on a null value';
        expect(DiagnosticsScrubber.scrubErrorMessage(clean), clean);
      });

      test('is idempotent — scrubbing already-scrubbed output is stable', () {
        const message = 'Failed connecting to 192.168.1.1 for peer '
            '550e8400-e29b-41d4-a716-446655440000 with key '
            'dGhpcyBpcyBhIDMyIGJ5dGUga2V5IGZvciBYMjU1MTk=';

        final first = DiagnosticsScrubber.scrubErrorMessage(message);
        final second = DiagnosticsScrubber.scrubErrorMessage(first);

        expect(second, first);
      });

      test('preserves error context around scrubbed tokens', () {
        const message =
            'WebSocket handshake failed: server at 10.0.0.1 returned 403';

        final scrubbed = DiagnosticsScrubber.scrubErrorMessage(message);

        expect(scrubbed, contains('WebSocket handshake failed:'));
        expect(scrubbed, contains('returned 403'));
        expect(scrubbed, contains('[IP]'));
      });

      test('scrubs PII at string boundaries', () {
        // IP at start
        expect(
          DiagnosticsScrubber.scrubErrorMessage('192.168.1.1 refused'),
          '[IP] refused',
        );
        // UUID at end
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            'Missing 550e8400-e29b-41d4-a716-446655440000',
          ),
          'Missing [UUID]',
        );
      });

      test('handles message with only PII', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage('192.168.1.1'),
          '[IP]',
        );
        expect(
          DiagnosticsScrubber.scrubErrorMessage(
            '550e8400-e29b-41d4-a716-446655440000',
          ),
          '[UUID]',
        );
      });

      test('scrubs IP in email-like pattern with numeric TLD', () {
        // "admin@192.168.1.1" is not a valid email (TLD is numeric), so
        // the email regex won't match it. The IPv4 regex scrubs the IP portion.
        const message = 'Contact admin@192.168.1.1 for help';
        final scrubbed = DiagnosticsScrubber.scrubErrorMessage(message);
        expect(scrubbed, isNot(contains('192.168.1.1')));
        expect(scrubbed, contains('[IP]'));
      });

      test('scrubs real email before IP regex can interfere', () {
        // A real email has an alpha TLD, so email regex matches first.
        const message = 'Contact admin@example.com and server at 10.0.0.1';
        final scrubbed = DiagnosticsScrubber.scrubErrorMessage(message);
        expect(scrubbed, contains('[EMAIL]'));
        expect(scrubbed, contains('[IP]'));
        expect(scrubbed, isNot(contains('admin@example.com')));
        expect(scrubbed, isNot(contains('10.0.0.1')));
      });

      test('handles mixed PII in realistic error payload', () {
        const payload = '''WebRTC connection failed:
  Signaling URL: wss://signal.zajel.example.com/ws?token=eyJhbGciOiJIUzI1NiJ9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  Local IP: 192.168.1.42
  Remote IP: fe80::1
  Peer ID: peer_id=a1b2c3d4e5f6a7b8
  Session: 550e8400-e29b-41d4-a716-446655440000
  Code: 654321
  User: alice@example.com
  DB path: /data/user/0/com.hamzalabs.zajel/databases/main.db''';

        final scrubbed = DiagnosticsScrubber.scrubErrorMessage(payload);

        // All PII must be gone
        expect(scrubbed, isNot(contains('token=')));
        expect(scrubbed, isNot(contains('192.168.1.42')));
        expect(scrubbed, isNot(contains('fe80::1')));
        expect(scrubbed, isNot(contains('a1b2c3d4e5f6a7b8')));
        expect(
            scrubbed, isNot(contains('550e8400-e29b-41d4-a716-446655440000')));
        expect(scrubbed, isNot(contains('654321')));
        expect(scrubbed, isNot(contains('alice@example.com')));
        expect(scrubbed, isNot(contains('/data/user/0')));

        // Structure must be preserved
        expect(scrubbed, contains('WebRTC connection failed:'));
        expect(scrubbed, contains('Signaling URL:'));
        expect(scrubbed, contains('Local IP:'));
      });
    });

    // =========================================================================
    // No false positives
    // =========================================================================
    group('No false positives', () {
      test('preserves normal error messages', () {
        const messages = [
          'Null check operator used on a null value',
          'RangeError (index): Invalid value: Not in inclusive range 0..5: 7',
          'type \'Null\' is not a subtype of type \'String\'',
          'setState() called after dispose()',
          'A RenderFlex overflowed by 42 pixels on the right.',
          'Looking up a deactivated widget\'s ancestor is unsafe.',
        ];

        for (final msg in messages) {
          expect(
            DiagnosticsScrubber.scrubErrorMessage(msg),
            msg,
            reason: 'Message should not be modified: $msg',
          );
        }
      });

      test('preserves Dart SDK stack frame format', () {
        const frame =
            '#0      Object.noSuchMethod (dart:core-patch/object_patch.dart:38:5)';
        expect(
          DiagnosticsScrubber.scrubStackTrace(frame),
          frame,
        );
      });

      test('preserves Flutter framework stack frames', () {
        const frame = '#5      ComponentElement.performRebuild '
            '(package:flutter/src/widgets/framework.dart:5073:15)';
        // scrubStackTrace should not alter well-formed package: frames
        final scrubbed = DiagnosticsScrubber.scrubStackTrace(frame);
        expect(scrubbed,
            contains('package:flutter/src/widgets/framework.dart:5073:15'));
      });

      test('preserves short numeric values', () {
        expect(
          DiagnosticsScrubber.scrubErrorMessage('Error code: 42'),
          'Error code: 42',
        );
        expect(
          DiagnosticsScrubber.scrubErrorMessage('Timeout after 30000ms'),
          'Timeout after 30000ms',
        );
      });

      test('preserves error signatures (8 hex chars)', () {
        // Error signatures from US-1.4 would be short hex strings
        expect(
          DiagnosticsScrubber.scrubErrorMessage('Signature: a1b2c3d4'),
          'Signature: a1b2c3d4',
        );
      });
    });

    // =========================================================================
    // Sample payload verification (NO PII survives)
    // =========================================================================
    group('Sample payload verification', () {
      test('no PII survives in full diagnostic error sample', () {
        const sampleMessage =
            'WebSocket connection to wss://10.0.2.2:8443/ws?session=abc failed: '
            'peer 550e8400-e29b-41d4-a716-446655440000 at 192.168.1.100 '
            'with key dGhpcyBpcyBhIDMyIGJ5dGUga2V5IGZvciBYMjU1MTk= '
            'reported by user@example.com from /Users/john/projects/zajel';

        const sampleTrace =
            '''#0      SignalingClient.connect (package:zajel/core/network/signaling_client.dart:89:5)
#1      SignalingClient._handleMessage (package:zajel/core/network/signaling_client.dart:142:12)
#2      WebSocket._onData (0x7fabcdef0123) (dart:io/websocket.dart:350:7)
        peer_id=abcdef1234567890 Instance of 'ConnectionState' at /data/user/0/com.hamzalabs.zajel/cache/state.bin
        Code: 123456''';

        final scrubbedMsg =
            DiagnosticsScrubber.scrubErrorMessage(sampleMessage);
        final scrubbedTrace = DiagnosticsScrubber.scrubStackTrace(sampleTrace);

        // Define PII patterns that must NOT appear in scrubbed output
        final piiPatterns = [
          RegExp(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b'), // IPv4
          RegExp(
            r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
            caseSensitive: false,
          ), // UUID
          RegExp(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'), // Email
          RegExp(r'/Users/[^\s]+'), // macOS paths
          RegExp(r'/data/user/[^\s]+'), // Android paths
          RegExp(r'\bsession=[^\s&]+'), // Session tokens in URLs
          RegExp(r'0x[0-9a-fA-F]{8,}'), // Memory addresses
          RegExp(r"Instance of '[^']*'"), // Instance of
        ];

        for (final pattern in piiPatterns) {
          expect(
            pattern.hasMatch(scrubbedMsg),
            isFalse,
            reason:
                'PII pattern ${pattern.pattern} found in scrubbed message: $scrubbedMsg',
          );
          expect(
            pattern.hasMatch(scrubbedTrace),
            isFalse,
            reason:
                'PII pattern ${pattern.pattern} found in scrubbed trace: $scrubbedTrace',
          );
        }

        // Structural info must survive
        expect(scrubbedMsg, contains('WebSocket connection to'));
        expect(scrubbedTrace, contains('#0'));
        expect(
            scrubbedTrace,
            contains(
              'package:zajel/core/network/signaling_client.dart:89:5',
            ));
      });
    });
  });
}
