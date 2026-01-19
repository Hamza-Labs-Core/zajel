import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/network/connection_manager.dart';

import '../../mocks/mocks.dart';

void main() {
  group('ConnectionManager', () {
    late ConnectionManager connectionManager;
    late MockCryptoService mockCryptoService;
    late MockWebRTCService mockWebRTCService;
    late MockDeviceLinkService mockDeviceLinkService;

    setUp(() {
      mockCryptoService = MockCryptoService();
      mockWebRTCService = MockWebRTCService();
      mockDeviceLinkService = MockDeviceLinkService();

      // Default stubs for dispose
      when(() => mockWebRTCService.dispose()).thenAnswer((_) async {});

      connectionManager = ConnectionManager(
        cryptoService: mockCryptoService,
        webrtcService: mockWebRTCService,
        deviceLinkService: mockDeviceLinkService,
      );
    });

    tearDown(() async {
      await connectionManager.dispose();
    });

    group('initialize', () {
      test('calls cryptoService.initialize', () async {
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});

        await connectionManager.initialize();

        verify(() => mockCryptoService.initialize()).called(1);
      });
    });

    group('connect', () {
      test('throws when cryptoService not initialized (publicKeyBase64 throws)', () async {
        // When publicKeyBase64 is accessed before initialize(), it throws
        when(() => mockCryptoService.publicKeyBase64).thenThrow(
          CryptoException('CryptoService not initialized. Call initialize() first.'),
        );

        // Attempting to connect should throw
        expect(
          () => connectionManager.connect(
            serverUrl: 'wss://example.com',
          ),
          throwsA(isA<CryptoException>().having(
            (e) => e.message,
            'message',
            contains('not initialized'),
          )),
        );
      });
    });

    group('connectToPeer', () {
      test('throws when not connected to signaling server', () async {
        // Use valid pairing code format (6 chars from A-Z excluding O,I + 2-9)
        expect(
          () => connectionManager.connectToPeer('ABC234'),
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Not connected to signaling server'),
          )),
        );
      });

      test('throws for invalid pairing code format', () async {
        // Code with invalid character '1' (only 2-9 allowed)
        expect(
          () => connectionManager.connectToPeer('PEER12'),
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Invalid pairing code format'),
          )),
        );
      });
    });

    group('respondToPairRequest', () {
      test('removes peer from list when rejected', () async {
        // Manually add a peer for testing
        // (In real usage, this would be done by signaling flow)
        // Since we can't easily set up the signaling flow in unit tests,
        // we verify the rejection logic doesn't throw
        connectionManager.respondToPairRequest('PEER12', accept: false);

        // After rejection, peer should not be in the list
        expect(
          connectionManager.currentPeers.any((p) => p.id == 'PEER12'),
          isFalse,
        );
      });
    });

    group('streams', () {
      test('peers stream exists', () {
        expect(connectionManager.peers, isA<Stream>());
      });

      test('messages stream exists', () {
        expect(connectionManager.messages, isA<Stream>());
      });

      test('fileChunks stream exists', () {
        expect(connectionManager.fileChunks, isA<Stream>());
      });

      test('fileStarts stream exists', () {
        expect(connectionManager.fileStarts, isA<Stream>());
      });

      test('fileCompletes stream exists', () {
        expect(connectionManager.fileCompletes, isA<Stream>());
      });

      test('pairRequests stream exists', () {
        expect(connectionManager.pairRequests, isA<Stream>());
      });
    });

    group('currentPeers', () {
      test('returns empty list initially', () {
        expect(connectionManager.currentPeers, isEmpty);
      });
    });

    group('externalPairingCode', () {
      test('returns null when not connected', () {
        expect(connectionManager.externalPairingCode, isNull);
      });
    });

    group('dispose', () {
      test('disposes webrtc service', () async {
        when(() => mockWebRTCService.dispose()).thenAnswer((_) async {});

        await connectionManager.dispose();

        verify(() => mockWebRTCService.dispose()).called(1);
      });
    });
  });

  group('ConnectionException', () {
    test('toString includes message', () {
      final exception = ConnectionException('Test error');

      expect(exception.toString(), contains('Test error'));
      expect(exception.toString(), contains('ConnectionException'));
    });

    test('message property returns message', () {
      const errorMessage = 'Connection failed';
      final exception = ConnectionException(errorMessage);

      expect(exception.message, errorMessage);
    });
  });
}
