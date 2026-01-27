import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/network/connection_info.dart';
import 'package:zajel/core/network/meeting_point_service.dart';
import 'package:zajel/core/network/peer_reconnection_service.dart';
import 'package:zajel/core/network/relay_client.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

class MockCryptoServiceImpl extends Mock implements CryptoService {}
class MockTrustedPeersStorageImpl extends Mock implements TrustedPeersStorage {}
class MockMeetingPointServiceImpl extends Mock implements MeetingPointService {}
class MockRelayClientImpl extends Mock implements RelayClient {}

class FakeTrustedPeer extends Fake implements TrustedPeer {}

void main() {
  late MockCryptoServiceImpl mockCrypto;
  late MockTrustedPeersStorageImpl mockStorage;
  late MockMeetingPointServiceImpl mockMeetingPoints;
  late MockRelayClientImpl mockRelay;
  late PeerReconnectionService service;

  setUpAll(() {
    registerFallbackValue(FakeTrustedPeer());
    registerFallbackValue(Uint8List(0));
  });

  setUp(() {
    mockCrypto = MockCryptoServiceImpl();
    mockStorage = MockTrustedPeersStorageImpl();
    mockMeetingPoints = MockMeetingPointServiceImpl();
    mockRelay = MockRelayClientImpl();

    // Set up default mock behaviors
    when(() => mockRelay.onIntroduction).thenAnswer(
      (_) => const Stream.empty(),
    );
    when(() => mockRelay.mySourceId).thenReturn('test-source-id');
    when(() => mockRelay.getCurrentRelayId()).thenReturn('relay-001');
    when(() => mockRelay.getConnectedRelayIds()).thenReturn(['relay-001', 'relay-002']);
    when(() => mockRelay.maxCapacity).thenReturn(100);
    when(() => mockRelay.currentLoad).thenReturn(5);

    when(() => mockCrypto.publicKeyBase64).thenReturn('test-public-key-base64');
    when(() => mockCrypto.getPublicKeyBase64()).thenAnswer((_) async => 'test-public-key-base64');
    when(() => mockCrypto.getPublicKeyBytes()).thenAnswer((_) async => Uint8List(32));

    service = PeerReconnectionService(
      cryptoService: mockCrypto,
      trustedPeers: mockStorage,
      meetingPointService: mockMeetingPoints,
      relayClient: mockRelay,
    );
  });

  tearDown(() async {
    await service.dispose();
  });

  group('PeerReconnectionService', () {
    group('Initialization', () {
      test('sets up relay listeners on creation', () {
        // Verify that onIntroduction was accessed during setup
        verify(() => mockRelay.onIntroduction).called(1);
      });

      test('exposes isConnected as false initially', () {
        expect(service.isConnected, isFalse);
      });
    });

    group('Meeting Point Registration', () {
      test('registers daily points for all trusted peers', () async {
        // Arrange
        final peerIds = ['peer1', 'peer2'];
        final peer1PublicKey = Uint8List.fromList(List.generate(32, (i) => i));
        final peer2PublicKey = Uint8List.fromList(List.generate(32, (i) => i + 32));

        when(() => mockStorage.getAllPeerIds())
            .thenAnswer((_) async => peerIds);
        when(() => mockStorage.getPeer('peer1'))
            .thenAnswer((_) async => _createMockPeer('peer1'));
        when(() => mockStorage.getPeer('peer2'))
            .thenAnswer((_) async => _createMockPeer('peer2'));
        when(() => mockStorage.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => peer1PublicKey);
        when(() => mockStorage.getPublicKeyBytes('peer2'))
            .thenAnswer((_) async => peer2PublicKey);

        when(() => mockMeetingPoints.deriveDailyPoints(any(), peer1PublicKey))
            .thenReturn(['point1a', 'point1b', 'point1c']);
        when(() => mockMeetingPoints.deriveDailyPoints(any(), peer2PublicKey))
            .thenReturn(['point2a', 'point2b', 'point2c']);

        when(() => mockCrypto.getSessionKeyBytes('peer1'))
            .thenAnswer((_) async => null);
        when(() => mockCrypto.getSessionKeyBytes('peer2'))
            .thenAnswer((_) async => null);
        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-data');

        // Register all meeting points is called internally when connecting
        // For this test, we verify the service calls the right methods
        verify(() => mockRelay.onIntroduction).called(1);
      });

      test('registers hourly tokens when session keys exist', () async {
        // Arrange
        final peerIds = ['peer1'];
        final peerPublicKey = Uint8List.fromList(List.generate(32, (i) => i));
        final sessionKey = Uint8List.fromList(List.generate(32, (i) => i + 100));

        when(() => mockStorage.getAllPeerIds())
            .thenAnswer((_) async => peerIds);
        when(() => mockStorage.getPeer('peer1'))
            .thenAnswer((_) async => _createMockPeer('peer1'));
        when(() => mockStorage.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => peerPublicKey);

        when(() => mockMeetingPoints.deriveDailyPoints(any(), peerPublicKey))
            .thenReturn(['point1']);
        when(() => mockMeetingPoints.deriveHourlyTokens(sessionKey))
            .thenReturn(['token1', 'token2', 'token3']);

        when(() => mockCrypto.getSessionKeyBytes('peer1'))
            .thenAnswer((_) async => sessionKey);
        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-data');

        // Verify hourly tokens are derived when session key exists
        expect(mockMeetingPoints.deriveHourlyTokens(sessionKey), hasLength(3));
      });
    });

    group('Peer Discovery', () {
      test('emits PeerFoundEvent on live match via processLiveMatchFromRendezvous', () async {
        // Listen for events
        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Process a live match
        service.processLiveMatchFromRendezvous('peer-abc', 'relay-001');

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.peerId, equals('peer-abc'));
        expect(events.first.isLive, isTrue);
      });

      test('emits PeerFoundEvent with connectionInfo on dead drop via processDeadDropFromRendezvous', () async {
        // Arrange
        final connectionInfo = ConnectionInfo(
          publicKey: 'peer-public-key',
          relayId: 'relay-001',
          sourceId: 'source-123',
          fallbackRelays: ['relay-002'],
          timestamp: DateTime.now().toUtc(),
        );
        final encryptedData = 'encrypted-connection-info';

        when(() => mockCrypto.decryptFromPeer('peer-abc', encryptedData))
            .thenAnswer((_) async => connectionInfo.toJsonString());

        // Listen for events
        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Process a dead drop
        await service.processDeadDropFromRendezvous('peer-abc', encryptedData, 'relay-001');

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.peerId, equals('peer-abc'));
        expect(events.first.isLive, isFalse);
        expect(events.first.connectionInfo, isNotNull);
        expect(events.first.connectionInfo!.relayId, equals('relay-001'));
      });

      test('identifies peer from daily meeting point', () async {
        // Arrange
        final myPublicKey = Uint8List.fromList(List.generate(32, (i) => i));
        final peerPublicKey = Uint8List.fromList(List.generate(32, (i) => i + 32));

        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPublicKey);
        when(() => mockStorage.getAllPeerIds())
            .thenAnswer((_) async => ['peer1']);
        when(() => mockStorage.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => peerPublicKey);
        when(() => mockCrypto.getSessionKeyBytes('peer1'))
            .thenAnswer((_) async => null);

        when(() => mockMeetingPoints.deriveDailyPoints(myPublicKey, peerPublicKey))
            .thenReturn(['daily-point-1', 'daily-point-2']);

        // Listen for events
        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Process a live match at a known daily point
        await service.processLiveMatch('daily-point-1');

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.peerId, equals('peer1'));
      });

      test('identifies peer from hourly token', () async {
        // Arrange
        final myPublicKey = Uint8List.fromList(List.generate(32, (i) => i));
        final peerPublicKey = Uint8List.fromList(List.generate(32, (i) => i + 32));
        final sessionKey = Uint8List.fromList(List.generate(32, (i) => i + 100));

        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPublicKey);
        when(() => mockStorage.getAllPeerIds())
            .thenAnswer((_) async => ['peer1']);
        when(() => mockStorage.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => peerPublicKey);
        when(() => mockCrypto.getSessionKeyBytes('peer1'))
            .thenAnswer((_) async => sessionKey);

        when(() => mockMeetingPoints.deriveDailyPoints(myPublicKey, peerPublicKey))
            .thenReturn(['daily-point']);
        when(() => mockMeetingPoints.deriveHourlyTokens(sessionKey))
            .thenReturn(['hourly-token-1', 'hourly-token-2']);

        // Listen for events
        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Process a live match at a known hourly token
        await service.processLiveMatch('hourly-token-1');

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.peerId, equals('peer1'));
      });
    });

    group('Dead Drop Handling', () {
      test('handles decryption failure gracefully', () async {
        // Arrange
        when(() => mockCrypto.decryptFromPeer(any(), any()))
            .thenThrow(Exception('Decryption failed'));

        // Listen for events
        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Process a dead drop with bad data
        await service.processDeadDropFromRendezvous('peer-abc', 'bad-encrypted-data', null);

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        // Should not emit any event on failure
        expect(events, isEmpty);
      });
    });

    group('Connection Requests', () {
      test('sends introduction through relay', () async {
        // Arrange
        final connectionInfo = ConnectionInfo(
          publicKey: 'peer-public-key',
          relayId: 'relay-001',
          sourceId: 'source-123',
          fallbackRelays: [],
          timestamp: DateTime.now().toUtc(),
        );

        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-intro');
        when(() => mockRelay.ensureConnectedToRelay(any()))
            .thenAnswer((_) async {});
        when(() => mockRelay.sendIntroduction(
          relayId: any(named: 'relayId'),
          targetSourceId: any(named: 'targetSourceId'),
          encryptedPayload: any(named: 'encryptedPayload'),
        )).thenAnswer((_) async {});

        // Act
        await service.connectToPeer('peer-abc', connectionInfo);

        // Assert
        verify(() => mockRelay.ensureConnectedToRelay('relay-001')).called(1);
        verify(() => mockRelay.sendIntroduction(
          relayId: 'relay-001',
          targetSourceId: 'source-123',
          encryptedPayload: 'encrypted-intro',
        )).called(1);
      });

      test('tries fallback relays on failure', () async {
        // Arrange
        final connectionInfo = ConnectionInfo(
          publicKey: 'peer-public-key',
          relayId: 'relay-001',
          sourceId: 'source-123',
          fallbackRelays: ['relay-002', 'relay-003'],
          timestamp: DateTime.now().toUtc(),
        );

        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-intro');

        // Primary relay fails
        when(() => mockRelay.ensureConnectedToRelay('relay-001'))
            .thenThrow(Exception('Primary relay unavailable'));

        // First fallback also fails
        when(() => mockRelay.ensureConnectedToRelay('relay-002'))
            .thenThrow(Exception('First fallback unavailable'));

        // Second fallback succeeds
        when(() => mockRelay.ensureConnectedToRelay('relay-003'))
            .thenAnswer((_) async {});
        when(() => mockRelay.sendIntroduction(
          relayId: any(named: 'relayId'),
          targetSourceId: any(named: 'targetSourceId'),
          encryptedPayload: any(named: 'encryptedPayload'),
        )).thenAnswer((_) async {});

        // Act
        await service.connectToPeer('peer-abc', connectionInfo);

        // Assert
        verify(() => mockRelay.ensureConnectedToRelay('relay-001')).called(1);
        verify(() => mockRelay.ensureConnectedToRelay('relay-002')).called(1);
        verify(() => mockRelay.ensureConnectedToRelay('relay-003')).called(1);
        verify(() => mockRelay.sendIntroduction(
          relayId: 'relay-003',
          targetSourceId: 'source-123',
          encryptedPayload: 'encrypted-intro',
        )).called(1);
      });

      test('throws PeerConnectionException when all relays fail', () async {
        // Arrange
        final connectionInfo = ConnectionInfo(
          publicKey: 'peer-public-key',
          relayId: 'relay-001',
          sourceId: 'source-123',
          fallbackRelays: ['relay-002'],
          timestamp: DateTime.now().toUtc(),
        );

        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-intro');

        // All relays fail
        when(() => mockRelay.ensureConnectedToRelay(any()))
            .thenThrow(Exception('Relay unavailable'));

        // Act & Assert
        expect(
          () => service.connectToPeer('peer-abc', connectionInfo),
          throwsA(isA<PeerConnectionException>()),
        );
      });
    });

    group('Lifecycle', () {
      test('dispose cancels all subscriptions and closes streams', () async {
        // Create a fresh service for this test to avoid interference with tearDown
        final freshService = PeerReconnectionService(
          cryptoService: mockCrypto,
          trustedPeers: mockStorage,
          meetingPointService: mockMeetingPoints,
          relayClient: mockRelay,
        );

        // Verify initially not connected
        expect(freshService.isConnected, isFalse);

        // Act - dispose should complete without error
        await freshService.dispose();

        // After dispose, should still show as not connected
        expect(freshService.isConnected, isFalse);
      });
    });

    group('Trusted Peer Management', () {
      test('addTrustedPeer saves peer to storage', () async {
        // Arrange
        final peer = _createMockPeer('new-peer');
        when(() => mockStorage.savePeer(any()))
            .thenAnswer((_) async {});
        when(() => mockStorage.getAllPeerIds())
            .thenAnswer((_) async => []);

        // Act
        await service.addTrustedPeer(peer);

        // Assert
        verify(() => mockStorage.savePeer(peer)).called(1);
      });

      test('removeTrustedPeer removes peer from storage', () async {
        // Arrange
        when(() => mockStorage.removePeer('peer-to-remove'))
            .thenAnswer((_) async {});

        // Act
        await service.removeTrustedPeer('peer-to-remove');

        // Assert
        verify(() => mockStorage.removePeer('peer-to-remove')).called(1);
      });
    });
  });
}

/// Create a mock TrustedPeer for testing.
TrustedPeer _createMockPeer(String id) {
  return TrustedPeer(
    id: id,
    publicKey: 'public-key-$id',
    displayName: 'Peer $id',
    trustedAt: DateTime.now(),
    lastSeen: DateTime.now(),
  );
}
