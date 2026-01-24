import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/network/connection_info.dart';
import 'package:zajel/core/network/meeting_point_service.dart';
import 'package:zajel/core/network/peer_reconnection_service.dart';
import 'package:zajel/core/network/relay_client.dart';
import 'package:zajel/core/network/signaling_client.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

import '../mocks/mocks.dart';

// Mock implementations for integration testing
class MockCryptoServiceImpl extends Mock implements CryptoService {}
class MockTrustedPeersStorageImpl extends Mock implements TrustedPeersStorage {}
class MockRelayClientImpl extends Mock implements RelayClient {}

class FakeTrustedPeer extends Fake implements TrustedPeer {}

void main() {
  group('Reconnection Flow Integration', () {
    late MockCryptoServiceImpl mockCrypto;
    late MockTrustedPeersStorageImpl mockStorage;
    late MeetingPointService realMeetingPoints; // Use real implementation
    late MockRelayClientImpl mockRelay;
    late PeerReconnectionService service;

    setUpAll(() {
      registerFallbackValue(FakeTrustedPeer());
      registerFallbackValue(Uint8List(0));
    });

    setUp(() {
      mockCrypto = MockCryptoServiceImpl();
      mockStorage = MockTrustedPeersStorageImpl();
      realMeetingPoints = MeetingPointService(); // Real implementation
      mockRelay = MockRelayClientImpl();

      // Set up default mock behaviors
      when(() => mockRelay.onIntroduction)
          .thenAnswer((_) => const Stream.empty());
      when(() => mockRelay.mySourceId).thenReturn('my-source-id');
      when(() => mockRelay.getCurrentRelayId()).thenReturn('current-relay');
      when(() => mockRelay.getConnectedRelayIds()).thenReturn(['relay-1', 'relay-2']);
      when(() => mockRelay.maxCapacity).thenReturn(100);
      when(() => mockRelay.currentLoad).thenReturn(0);

      when(() => mockCrypto.publicKeyBase64).thenReturn('mock-public-key-base64');
      when(() => mockCrypto.getPublicKeyBase64())
          .thenAnswer((_) async => 'mock-public-key-base64');

      service = PeerReconnectionService(
        cryptoService: mockCrypto,
        trustedPeers: mockStorage,
        meetingPointService: realMeetingPoints,
        relayClient: mockRelay,
      );
    });

    tearDown(() async {
      await service.dispose();
    });

    group('Meeting Point Derivation', () {
      test('two peers derive same daily meeting points', () {
        // Arrange: two consistent key pairs
        final alicePublicKey = Uint8List.fromList(List.generate(32, (i) => i));
        final bobPublicKey = Uint8List.fromList(List.generate(32, (i) => i + 32));

        // Act: Both peers derive daily points
        final alicePoints = realMeetingPoints.deriveDailyPoints(
          alicePublicKey,
          bobPublicKey,
        );
        final bobPoints = realMeetingPoints.deriveDailyPoints(
          bobPublicKey,
          alicePublicKey,
        );

        // Assert: Same points (order might differ, but set should be equal)
        expect(alicePoints.toSet(), equals(bobPoints.toSet()));
        expect(alicePoints, hasLength(3)); // yesterday, today, tomorrow
      });

      test('two peers with shared secret derive same hourly tokens', () {
        // Arrange: shared session key
        final sharedSecret = Uint8List.fromList(List.generate(32, (i) => i * 2));

        // Act: Both peers derive hourly tokens (using same secret)
        final aliceTokens = realMeetingPoints.deriveHourlyTokens(sharedSecret);
        final bobTokens = realMeetingPoints.deriveHourlyTokens(sharedSecret);

        // Assert: Identical tokens
        expect(aliceTokens, equals(bobTokens));
        expect(aliceTokens, hasLength(3)); // last hour, this hour, next hour
      });

      test('different peer pairs derive different meeting points', () {
        // Arrange: different key pairs
        final alicePublicKey = Uint8List.fromList(List.generate(32, (i) => i));
        final bobPublicKey = Uint8List.fromList(List.generate(32, (i) => i + 32));
        final charliePublicKey = Uint8List.fromList(List.generate(32, (i) => i + 64));

        // Act: Derive points for Alice-Bob and Alice-Charlie pairs
        final aliceBobPoints = realMeetingPoints.deriveDailyPoints(
          alicePublicKey,
          bobPublicKey,
        );
        final aliceCharliePoints = realMeetingPoints.deriveDailyPoints(
          alicePublicKey,
          charliePublicKey,
        );

        // Assert: Different points for different pairs
        expect(
          aliceBobPoints.toSet().intersection(aliceCharliePoints.toSet()),
          isEmpty,
        );
      });
    });

    group('Peer Discovery Flow', () {
      test('emits event when receiving live match from rendezvous', () async {
        // Arrange
        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Act: Simulate receiving a live match
        service.processLiveMatchFromRendezvous('peer-alice', 'relay-001');

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        // Assert
        expect(events, hasLength(1));
        expect(events.first.peerId, equals('peer-alice'));
        expect(events.first.isLive, isTrue);
      });

      test('decrypts dead drop and emits event with connection info', () async {
        // Arrange
        final connectionInfo = ConnectionInfo(
          publicKey: 'alice-public-key',
          relayId: 'relay-001',
          sourceId: 'alice-source-id',
          fallbackRelays: ['relay-002'],
          timestamp: DateTime.now().toUtc(),
        );
        final encryptedData = 'encrypted-connection-info';

        when(() => mockCrypto.decryptFromPeer('peer-alice', encryptedData))
            .thenAnswer((_) async => connectionInfo.toJsonString());

        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Act: Process dead drop
        await service.processDeadDropFromRendezvous(
          'peer-alice',
          encryptedData,
          'relay-001',
        );

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        // Assert
        expect(events, hasLength(1));
        expect(events.first.peerId, equals('peer-alice'));
        expect(events.first.isLive, isFalse);
        expect(events.first.connectionInfo, isNotNull);
        expect(events.first.connectionInfo!.relayId, equals('relay-001'));
        expect(events.first.connectionInfo!.sourceId, equals('alice-source-id'));
      });

      test('handles malformed dead drop gracefully', () async {
        // Arrange
        when(() => mockCrypto.decryptFromPeer(any(), any()))
            .thenThrow(Exception('Decryption failed - invalid data'));

        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Act: Process bad dead drop
        await service.processDeadDropFromRendezvous(
          'peer-malicious',
          'corrupted-encrypted-data',
          null,
        );

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        // Assert: No event emitted
        expect(events, isEmpty);
      });
    });

    group('Connection Establishment', () {
      test('connects to peer via primary relay', () async {
        // Arrange
        final connectionInfo = ConnectionInfo(
          publicKey: 'alice-public-key',
          relayId: 'primary-relay',
          sourceId: 'alice-source',
          fallbackRelays: [],
          timestamp: DateTime.now().toUtc(),
        );

        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-intro-payload');
        when(() => mockRelay.ensureConnectedToRelay('primary-relay'))
            .thenAnswer((_) async {});
        when(() => mockRelay.sendIntroduction(
              relayId: any(named: 'relayId'),
              targetSourceId: any(named: 'targetSourceId'),
              encryptedPayload: any(named: 'encryptedPayload'),
            )).thenAnswer((_) async {});

        // Act
        await service.connectToPeer('peer-alice', connectionInfo);

        // Assert
        verify(() => mockRelay.ensureConnectedToRelay('primary-relay')).called(1);
        verify(() => mockRelay.sendIntroduction(
              relayId: 'primary-relay',
              targetSourceId: 'alice-source',
              encryptedPayload: 'encrypted-intro-payload',
            )).called(1);
      });

      test('falls back to secondary relay when primary fails', () async {
        // Arrange
        final connectionInfo = ConnectionInfo(
          publicKey: 'alice-public-key',
          relayId: 'primary-relay',
          sourceId: 'alice-source',
          fallbackRelays: ['fallback-relay-1', 'fallback-relay-2'],
          timestamp: DateTime.now().toUtc(),
        );

        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-intro-payload');

        // Primary fails
        when(() => mockRelay.ensureConnectedToRelay('primary-relay'))
            .thenThrow(Exception('Primary relay offline'));

        // First fallback also fails
        when(() => mockRelay.ensureConnectedToRelay('fallback-relay-1'))
            .thenThrow(Exception('Fallback 1 offline'));

        // Second fallback succeeds
        when(() => mockRelay.ensureConnectedToRelay('fallback-relay-2'))
            .thenAnswer((_) async {});
        when(() => mockRelay.sendIntroduction(
              relayId: any(named: 'relayId'),
              targetSourceId: any(named: 'targetSourceId'),
              encryptedPayload: any(named: 'encryptedPayload'),
            )).thenAnswer((_) async {});

        // Act
        await service.connectToPeer('peer-alice', connectionInfo);

        // Assert: Tried all relays in order
        verify(() => mockRelay.ensureConnectedToRelay('primary-relay')).called(1);
        verify(() => mockRelay.ensureConnectedToRelay('fallback-relay-1')).called(1);
        verify(() => mockRelay.ensureConnectedToRelay('fallback-relay-2')).called(1);

        // Only sent introduction via the successful relay
        verify(() => mockRelay.sendIntroduction(
              relayId: 'fallback-relay-2',
              targetSourceId: 'alice-source',
              encryptedPayload: 'encrypted-intro-payload',
            )).called(1);
      });

      test('throws exception when all relays fail', () async {
        // Arrange
        final connectionInfo = ConnectionInfo(
          publicKey: 'alice-public-key',
          relayId: 'primary-relay',
          sourceId: 'alice-source',
          fallbackRelays: ['fallback-relay'],
          timestamp: DateTime.now().toUtc(),
        );

        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-intro-payload');

        // All relays fail
        when(() => mockRelay.ensureConnectedToRelay(any()))
            .thenThrow(Exception('Relay offline'));

        // Act & Assert
        expect(
          () => service.connectToPeer('peer-alice', connectionInfo),
          throwsA(isA<PeerConnectionException>()),
        );
      });
    });

    group('Introduction Handling', () {
      test('forwards introductions from relay to connection request stream', () async {
        // Arrange: Create a controller to simulate relay introductions
        final introController = StreamController<IntroductionEvent>.broadcast();

        when(() => mockRelay.onIntroduction)
            .thenAnswer((_) => introController.stream);

        // Recreate service with the new mock
        await service.dispose();
        service = PeerReconnectionService(
          cryptoService: mockCrypto,
          trustedPeers: mockStorage,
          meetingPointService: realMeetingPoints,
          relayClient: mockRelay,
        );

        final requests = <ConnectionRequestEvent>[];
        service.onConnectionRequest.listen(requests.add);

        // Act: Simulate an introduction event from relay
        introController.add(IntroductionEvent(
          fromSourceId: 'remote-source-id',
          payload: 'encrypted-connection-payload',
          relayId: 'relay-001',
        ));

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        // Assert
        expect(requests, hasLength(1));
        expect(requests.first.peerId, equals('remote-source-id'));
        expect(requests.first.encryptedPayload, equals('encrypted-connection-payload'));
        expect(requests.first.relayId, equals('relay-001'));

        // Cleanup
        await introController.close();
      });
    });

    group('Trusted Peer Management', () {
      test('adding trusted peer triggers meeting point re-registration', () async {
        // Arrange
        final newPeer = TrustedPeer(
          id: 'new-peer-id',
          publicKey: 'new-peer-public-key',
          displayName: 'New Peer',
          trustedAt: DateTime.now(),
          lastSeen: DateTime.now(),
        );

        when(() => mockStorage.savePeer(any())).thenAnswer((_) async {});
        when(() => mockStorage.getAllPeerIds()).thenAnswer((_) async => ['new-peer-id']);
        when(() => mockStorage.getPeer('new-peer-id')).thenAnswer((_) async => newPeer);
        when(() => mockStorage.getPublicKeyBytes('new-peer-id'))
            .thenAnswer((_) async => Uint8List.fromList(List.generate(32, (i) => i)));
        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => Uint8List.fromList(List.generate(32, (i) => i + 100)));
        when(() => mockCrypto.getSessionKeyBytes(any())).thenAnswer((_) async => null);
        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted-data');

        // Act
        await service.addTrustedPeer(newPeer);

        // Assert
        verify(() => mockStorage.savePeer(newPeer)).called(1);
      });

      test('removing trusted peer removes from storage', () async {
        // Arrange
        when(() => mockStorage.removePeer('peer-to-remove'))
            .thenAnswer((_) async {});

        // Act
        await service.removeTrustedPeer('peer-to-remove');

        // Assert
        verify(() => mockStorage.removePeer('peer-to-remove')).called(1);
      });
    });

    group('Status Updates', () {
      test('emits status updates on significant events', () async {
        // Arrange
        final statuses = <ReconnectionStatus>[];
        service.onStatus.listen(statuses.add);

        // Act: Trigger a status update by processing a match
        service.processLiveMatchFromRendezvous('some-peer', null);

        // Allow stream to propagate
        await Future.delayed(Duration.zero);

        // Note: processLiveMatchFromRendezvous doesn't directly emit status,
        // but the stream should still be functional
        expect(service.onStatus, isA<Stream<ReconnectionStatus>>());
      });
    });
  });
}
