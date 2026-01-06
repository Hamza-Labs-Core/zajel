import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/network/connection_info.dart';
import 'package:zajel/core/network/dead_drop.dart';
import 'package:zajel/core/network/meeting_point_service.dart';
import 'package:zajel/core/network/rendezvous_service.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

// Mock classes
class MockMeetingPointService extends Mock implements MeetingPointService {}

class MockCryptoService extends Mock implements CryptoService {}

class MockTrustedPeersStorage extends Mock implements TrustedPeersStorage {}

void main() {
  setUpAll(() {
    // Register fallback values for types used with `any()`
    registerFallbackValue(Uint8List(0));
  });

  group('RendezvousService', () {
    late RendezvousService service;
    late MockMeetingPointService mockMeetingPoint;
    late MockCryptoService mockCrypto;
    late MockTrustedPeersStorage mockTrustedPeers;

    final myPubkey = Uint8List.fromList(List.generate(32, (i) => i));
    final theirPubkey = Uint8List.fromList(List.generate(32, (i) => i + 100));
    final sharedSecret = Uint8List.fromList(List.generate(32, (i) => i * 2));

    setUp(() {
      mockMeetingPoint = MockMeetingPointService();
      mockCrypto = MockCryptoService();
      mockTrustedPeers = MockTrustedPeersStorage();

      service = RendezvousService(
        meetingPointService: mockMeetingPoint,
        cryptoService: mockCrypto,
        trustedPeersStorage: mockTrustedPeers,
      );
    });

    tearDown(() {
      service.dispose();
    });

    /// Helper to set up basic mocks for a peer
    void setupMocksForPeer(String peerId) {
      when(() => mockCrypto.getPublicKeyBytes())
          .thenAnswer((_) async => myPubkey);
      when(() => mockTrustedPeers.getPublicKeyBytes(peerId))
          .thenAnswer((_) async => theirPubkey);
      when(() => mockCrypto.getSessionKeyBytes(peerId))
          .thenAnswer((_) async => sharedSecret);
      when(() => mockMeetingPoint.deriveDailyPoints(any(), any()))
          .thenReturn(['day_1', 'day_2', 'day_3']);
      when(() => mockMeetingPoint.deriveHourlyTokens(any()))
          .thenReturn(['hr_1', 'hr_2', 'hr_3']);
      when(() => mockCrypto.getPublicKeyBase64())
          .thenAnswer((_) async => 'my_pubkey_base64');
      when(() => mockCrypto.encryptForPeer(any(), any()))
          .thenAnswer((_) async => 'encrypted_dead_drop');
    }

    group('registerForPeer', () {
      test('should derive meeting points and create dead drop', () async {
        // Arrange
        setupMocksForPeer('peer1');

        // Act
        final registration = await service.createRegistrationForPeer('peer1');

        // Assert
        expect(registration.dailyPoints, hasLength(3));
        expect(registration.dailyPoints, contains('day_1'));
        expect(registration.hourlyTokens, hasLength(3));
        expect(registration.hourlyTokens, contains('hr_1'));
        expect(registration.deadDrop, isNotNull);
        expect(registration.deadDrop, equals('encrypted_dead_drop'));

        verify(() => mockMeetingPoint.deriveDailyPoints(any(), any())).called(1);
        verify(() => mockMeetingPoint.deriveHourlyTokens(any())).called(1);
        verify(() => mockCrypto.encryptForPeer('peer1', any())).called(1);
      });

      test('should handle peer not found error', () async {
        // Arrange
        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPubkey);
        when(() => mockTrustedPeers.getPublicKeyBytes('unknown'))
            .thenAnswer((_) async => null);

        // Act & Assert
        expect(
          () => service.createRegistrationForPeer('unknown'),
          throwsA(isA<PeerNotFoundException>()),
        );
      });

      test('should work without shared secret (daily points only)', () async {
        // Arrange
        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPubkey);
        when(() => mockTrustedPeers.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => theirPubkey);
        when(() => mockCrypto.getSessionKeyBytes('peer1'))
            .thenAnswer((_) async => null);
        when(() => mockMeetingPoint.deriveDailyPoints(any(), any()))
            .thenReturn(['day_1', 'day_2', 'day_3']);
        when(() => mockCrypto.getPublicKeyBase64())
            .thenAnswer((_) async => 'my_pubkey');
        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted');

        // Act
        final registration = await service.createRegistrationForPeer('peer1');

        // Assert
        expect(registration.dailyPoints, hasLength(3));
        expect(registration.hourlyTokens, isEmpty);
        verify(() => mockMeetingPoint.deriveDailyPoints(any(), any())).called(1);
        verifyNever(() => mockMeetingPoint.deriveHourlyTokens(any()));
      });

      test('should include correct connection info in dead drop', () async {
        // Arrange
        setupMocksForPeer('peer1');

        String? capturedPlaintext;
        when(() => mockCrypto.encryptForPeer('peer1', any()))
            .thenAnswer((invocation) async {
          capturedPlaintext = invocation.positionalArguments[1] as String;
          return 'encrypted_payload';
        });

        // Act
        await service.createRegistrationForPeer('peer1');

        // Assert
        expect(capturedPlaintext, isNotNull);
        final parsed = jsonDecode(capturedPlaintext!) as Map<String, dynamic>;
        expect(parsed['pubkey'], 'my_pubkey_base64');
        expect(parsed['timestamp'], isNotNull);
        // Other fields might be default values since we don't have a real connection
      });
    });

    group('registerForAllPeers', () {
      test('should register for all trusted peers', () async {
        // Arrange
        when(() => mockTrustedPeers.getAllPeerIds())
            .thenAnswer((_) async => ['peer1', 'peer2', 'peer3']);

        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPubkey);

        for (final peerId in ['peer1', 'peer2', 'peer3']) {
          when(() => mockTrustedPeers.getPublicKeyBytes(peerId))
              .thenAnswer((_) async => theirPubkey);
          when(() => mockCrypto.getSessionKeyBytes(peerId))
              .thenAnswer((_) async => sharedSecret);
        }

        when(() => mockMeetingPoint.deriveDailyPoints(any(), any()))
            .thenReturn(['day_1', 'day_2', 'day_3']);
        when(() => mockMeetingPoint.deriveHourlyTokens(any()))
            .thenReturn(['hr_1', 'hr_2', 'hr_3']);
        when(() => mockCrypto.getPublicKeyBase64())
            .thenAnswer((_) async => 'my_pubkey');
        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted');

        // Act
        final registrations = await service.createRegistrationsForAllPeers();

        // Assert
        expect(registrations.keys, containsAll(['peer1', 'peer2', 'peer3']));
        expect(registrations.length, 3);
      });

      test('should continue with other peers if one fails', () async {
        // Arrange
        when(() => mockTrustedPeers.getAllPeerIds())
            .thenAnswer((_) async => ['peer1', 'peer2']);

        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPubkey);

        // peer1 works
        when(() => mockTrustedPeers.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => theirPubkey);
        when(() => mockCrypto.getSessionKeyBytes('peer1'))
            .thenAnswer((_) async => sharedSecret);

        // peer2 fails - not found
        when(() => mockTrustedPeers.getPublicKeyBytes('peer2'))
            .thenAnswer((_) async => null);

        when(() => mockMeetingPoint.deriveDailyPoints(any(), any()))
            .thenReturn(['day_1']);
        when(() => mockMeetingPoint.deriveHourlyTokens(any()))
            .thenReturn(['hr_1']);
        when(() => mockCrypto.getPublicKeyBase64())
            .thenAnswer((_) async => 'my_pubkey');
        when(() => mockCrypto.encryptForPeer(any(), any()))
            .thenAnswer((_) async => 'encrypted');

        // Act
        final registrations = await service.createRegistrationsForAllPeers();

        // Assert
        expect(registrations.containsKey('peer1'), true);
        expect(registrations.containsKey('peer2'), false);
      });

      test('should return empty map when no trusted peers', () async {
        // Arrange
        when(() => mockTrustedPeers.getAllPeerIds())
            .thenAnswer((_) async => []);

        // Act
        final registrations = await service.createRegistrationsForAllPeers();

        // Assert
        expect(registrations, isEmpty);
      });
    });

    group('Dead Drop Handling', () {
      group('createDeadDrop', () {
        test('should create encrypted dead drop with connection info',
            () async {
          // Arrange
          when(() => mockCrypto.getPublicKeyBase64())
              .thenAnswer((_) async => 'my_pubkey_base64');

          String? capturedPlaintext;
          when(() => mockCrypto.encryptForPeer('peer1', any()))
              .thenAnswer((invocation) async {
            capturedPlaintext = invocation.positionalArguments[1] as String;
            return 'encrypted_payload';
          });

          // Act
          final encrypted = await service.createDeadDrop('peer1');

          // Assert
          expect(encrypted, 'encrypted_payload');
          expect(capturedPlaintext, isNotNull);

          final parsed = jsonDecode(capturedPlaintext!) as Map<String, dynamic>;
          expect(parsed['pubkey'], 'my_pubkey_base64');
          expect(parsed['timestamp'], isNotNull);
        });

        test('should include custom connection info when provided', () async {
          // Arrange
          when(() => mockCrypto.getPublicKeyBase64())
              .thenAnswer((_) async => 'my_pubkey_base64');

          String? capturedPlaintext;
          when(() => mockCrypto.encryptForPeer('peer1', any()))
              .thenAnswer((invocation) async {
            capturedPlaintext = invocation.positionalArguments[1] as String;
            return 'encrypted';
          });

          // Act
          await service.createDeadDrop(
            'peer1',
            relayId: 'relay_123',
            sourceId: 'source_456',
            ip: '1.2.3.4',
            port: 12345,
            fallbackRelays: ['r1', 'r2'],
          );

          // Assert
          final parsed = jsonDecode(capturedPlaintext!) as Map<String, dynamic>;
          expect(parsed['relay'], 'relay_123');
          expect(parsed['sourceId'], 'source_456');
          expect(parsed['ip'], '1.2.3.4');
          expect(parsed['port'], 12345);
          expect(parsed['fallbackRelays'], ['r1', 'r2']);
        });
      });

      group('decryptDeadDrop', () {
        test('should decrypt and parse connection info', () async {
          // Arrange
          final timestamp = DateTime.now().toUtc().toIso8601String();
          final deadDropPayload = jsonEncode({
            'pubkey': 'their_pubkey',
            'relay': 'relay_abc',
            'sourceId': 'source_xyz',
            'ip': '5.6.7.8',
            'port': 54321,
            'fallbackRelays': ['r1', 'r2'],
            'timestamp': timestamp,
          });

          when(() => mockCrypto.decryptFromPeer('peer1', 'encrypted_drop'))
              .thenAnswer((_) async => deadDropPayload);

          // Act
          final info =
              await service.decryptDeadDrop('encrypted_drop', 'peer1');

          // Assert
          expect(info.publicKey, 'their_pubkey');
          expect(info.relayId, 'relay_abc');
          expect(info.sourceId, 'source_xyz');
          expect(info.ip, '5.6.7.8');
          expect(info.port, 54321);
          expect(info.fallbackRelays, ['r1', 'r2']);
        });

        test('should handle decryption failure', () async {
          // Arrange
          when(() => mockCrypto.decryptFromPeer('peer1', 'bad_payload'))
              .thenThrow(CryptoException('Decryption failed'));

          // Act & Assert
          expect(
            () => service.decryptDeadDrop('bad_payload', 'peer1'),
            throwsA(isA<DeadDropDecryptionException>()),
          );
        });

        test('should detect stale dead drop', () async {
          // Arrange
          final oldTimestamp = DateTime.now()
              .toUtc()
              .subtract(const Duration(hours: 25))
              .toIso8601String();
          final deadDropPayload = jsonEncode({
            'pubkey': 'key',
            'relay': 'relay',
            'sourceId': 'source',
            'ip': '1.2.3.4',
            'port': 12345,
            'timestamp': oldTimestamp,
          });

          when(() => mockCrypto.decryptFromPeer('peer1', 'encrypted'))
              .thenAnswer((_) async => deadDropPayload);

          // Act
          final info = await service.decryptDeadDrop('encrypted', 'peer1');

          // Assert
          expect(info.isStale, true);
          expect(info.age.inHours, greaterThan(24));
        });

        test('should detect fresh dead drop', () async {
          // Arrange
          final freshTimestamp = DateTime.now()
              .toUtc()
              .subtract(const Duration(minutes: 30))
              .toIso8601String();
          final deadDropPayload = jsonEncode({
            'pubkey': 'key',
            'relay': 'relay',
            'sourceId': 'source',
            'ip': '1.2.3.4',
            'port': 12345,
            'timestamp': freshTimestamp,
          });

          when(() => mockCrypto.decryptFromPeer('peer1', 'encrypted'))
              .thenAnswer((_) async => deadDropPayload);

          // Act
          final info = await service.decryptDeadDrop('encrypted', 'peer1');

          // Assert
          expect(info.isStale, false);
          expect(info.age.inMinutes, lessThan(60));
        });
      });
    });

    group('Match Handling', () {
      group('handleLiveMatch', () {
        test('should emit peer found event', () async {
          // Arrange
          final match = LiveMatch(
            peerId: 'peer1',
            relayId: 'relay_abc',
            meetingPoint: 'meeting_point_123',
          );
          final events = <PeerFoundEvent>[];
          service.onPeerFound.listen(events.add);

          // Act
          await service.handleLiveMatch(match);
          await Future.delayed(Duration.zero); // Let stream emit

          // Assert
          expect(events, hasLength(1));
          expect(events[0].peerId, 'peer1');
          expect(events[0].connectionType, ConnectionType.live);
          expect(events[0].relayId, 'relay_abc');
        });

        test('should emit multiple events for multiple matches', () async {
          // Arrange
          final events = <PeerFoundEvent>[];
          service.onPeerFound.listen(events.add);

          // Act
          await service.handleLiveMatch(LiveMatch(
            peerId: 'peer1',
            relayId: 'r1',
            meetingPoint: 'mp1',
          ));
          await service.handleLiveMatch(LiveMatch(
            peerId: 'peer2',
            relayId: 'r2',
            meetingPoint: 'mp2',
          ));
          await Future.delayed(Duration.zero);

          // Assert
          expect(events, hasLength(2));
          expect(events[0].peerId, 'peer1');
          expect(events[1].peerId, 'peer2');
        });
      });

      group('handleDeadDrop', () {
        test('should decrypt and emit dead drop event', () async {
          // Arrange
          final timestamp = DateTime.now().toUtc().toIso8601String();
          final deadDropPayload = jsonEncode({
            'pubkey': 'key',
            'relay': 'relay',
            'sourceId': 'source',
            'ip': '1.2.3.4',
            'port': 12345,
            'timestamp': timestamp,
          });

          when(() => mockCrypto.decryptFromPeer('peer1', 'encrypted_data'))
              .thenAnswer((_) async => deadDropPayload);

          final drop = DeadDrop(
            peerId: 'peer1',
            encryptedPayload: 'encrypted_data',
            relayId: 'relay_xyz',
            meetingPoint: 'mp_123',
          );

          final events = <DeadDropEvent>[];
          service.onDeadDropReceived.listen(events.add);

          // Act
          await service.handleDeadDrop(drop);
          await Future.delayed(Duration.zero);

          // Assert
          expect(events, hasLength(1));
          expect(events[0].peerId, 'peer1');
          expect(events[0].connectionInfo.ip, '1.2.3.4');
        });

        test('should also emit peer found event for dead drop', () async {
          // Arrange
          final timestamp = DateTime.now().toUtc().toIso8601String();
          final deadDropPayload = jsonEncode({
            'pubkey': 'key',
            'relay': 'relay',
            'sourceId': 'source',
            'ip': '1.2.3.4',
            'port': 12345,
            'timestamp': timestamp,
          });

          when(() => mockCrypto.decryptFromPeer('peer1', 'enc'))
              .thenAnswer((_) async => deadDropPayload);

          final drop = DeadDrop(
            peerId: 'peer1',
            encryptedPayload: 'enc',
            relayId: 'r1',
            meetingPoint: 'mp1',
          );

          final peerEvents = <PeerFoundEvent>[];
          service.onPeerFound.listen(peerEvents.add);

          // Act
          await service.handleDeadDrop(drop);
          await Future.delayed(Duration.zero);

          // Assert
          expect(peerEvents, hasLength(1));
          expect(peerEvents[0].peerId, 'peer1');
          expect(peerEvents[0].connectionType, ConnectionType.deadDrop);
        });
      });

      group('processRendezvousResult', () {
        test('should prioritize live matches over dead drops', () async {
          // Arrange
          final result = RendezvousResult(
            liveMatches: [
              LiveMatch(
                peerId: 'peer1',
                relayId: 'r1',
                meetingPoint: 'mp1',
              )
            ],
            deadDrops: [
              DeadDrop(
                peerId: 'peer1',
                encryptedPayload: 'enc',
                relayId: 'r2',
                meetingPoint: 'mp2',
              )
            ],
          );

          final peerEvents = <PeerFoundEvent>[];
          service.onPeerFound.listen(peerEvents.add);

          // Act
          await service.processRendezvousResult('peer1', result);
          await Future.delayed(Duration.zero);

          // Assert
          expect(peerEvents, hasLength(1));
          expect(peerEvents[0].connectionType, ConnectionType.live);
          verifyNever(() => mockCrypto.decryptFromPeer(any(), any()));
        });

        test('should process dead drop if no live match', () async {
          // Arrange
          final timestamp = DateTime.now().toUtc().toIso8601String();
          when(() => mockCrypto.decryptFromPeer('peer1', 'enc'))
              .thenAnswer((_) async => jsonEncode({
                    'pubkey': 'key',
                    'relay': 'relay',
                    'sourceId': 'source',
                    'ip': '1.2.3.4',
                    'port': 12345,
                    'timestamp': timestamp,
                  }));

          final result = RendezvousResult(
            liveMatches: [],
            deadDrops: [
              DeadDrop(
                peerId: 'peer1',
                encryptedPayload: 'enc',
                relayId: 'r2',
                meetingPoint: 'mp2',
              )
            ],
          );

          final deadDropEvents = <DeadDropEvent>[];
          service.onDeadDropReceived.listen(deadDropEvents.add);

          // Act
          await service.processRendezvousResult('peer1', result);
          await Future.delayed(Duration.zero);

          // Assert
          verify(() => mockCrypto.decryptFromPeer('peer1', 'enc')).called(1);
          expect(deadDropEvents, hasLength(1));
        });

        test('should handle empty result gracefully', () async {
          // Arrange
          final result = RendezvousResult();

          final events = <PeerFoundEvent>[];
          service.onPeerFound.listen(events.add);

          // Act
          await service.processRendezvousResult('peer1', result);
          await Future.delayed(Duration.zero);

          // Assert
          expect(events, isEmpty);
        });

        test('should handle failed result gracefully', () async {
          // Arrange
          final result = RendezvousResult.failure('Server error');

          // Act & Assert - should not throw
          await service.processRendezvousResult('peer1', result);
        });
      });
    });

    group('Event Streams', () {
      test('onPeerFound should be a broadcast stream', () {
        // Assert
        expect(service.onPeerFound.isBroadcast, true);
      });

      test('onDeadDropReceived should be a broadcast stream', () {
        // Assert
        expect(service.onDeadDropReceived.isBroadcast, true);
      });

      test('multiple listeners should receive events', () async {
        // Arrange
        final events1 = <PeerFoundEvent>[];
        final events2 = <PeerFoundEvent>[];
        service.onPeerFound.listen(events1.add);
        service.onPeerFound.listen(events2.add);

        // Act
        await service.handleLiveMatch(LiveMatch(
          peerId: 'peer1',
          relayId: 'r1',
          meetingPoint: 'mp1',
        ));
        await Future.delayed(Duration.zero);

        // Assert
        expect(events1, hasLength(1));
        expect(events2, hasLength(1));
      });

      test('dispose should close all streams', () async {
        // Arrange
        var peerFoundClosed = false;
        var deadDropClosed = false;

        service.onPeerFound.listen(
          (_) {},
          onDone: () => peerFoundClosed = true,
        );
        service.onDeadDropReceived.listen(
          (_) {},
          onDone: () => deadDropClosed = true,
        );

        // Act
        service.dispose();
        await Future.delayed(Duration.zero);

        // Assert
        expect(peerFoundClosed, true);
        expect(deadDropClosed, true);
      });
    });

    group('Identification', () {
      test('should try to identify peer from meeting point', () async {
        // Arrange
        when(() => mockTrustedPeers.getAllPeerIds())
            .thenAnswer((_) async => ['peer1', 'peer2']);
        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPubkey);
        when(() => mockTrustedPeers.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => theirPubkey);
        when(() => mockTrustedPeers.getPublicKeyBytes('peer2'))
            .thenAnswer((_) async => Uint8List(32));

        // Return different daily points for different peer keys
        when(() => mockMeetingPoint.deriveDailyPoints(any(), any()))
            .thenAnswer((invocation) {
          final theirKey = invocation.positionalArguments[1] as Uint8List;
          // Match for peer1's key returns the matching point
          if (theirKey == theirPubkey) {
            return ['matching_point', 'other_1', 'other_2'];
          }
          return ['no_match_1', 'no_match_2', 'no_match_3'];
        });
        when(() => mockCrypto.getSessionKeyBytes(any()))
            .thenAnswer((_) async => null);

        // Act
        final peerId = await service.identifyPeerFromMeetingPoint('matching_point');

        // Assert
        expect(peerId, 'peer1');
      });

      test('should return null if no peer matches meeting point', () async {
        // Arrange
        when(() => mockTrustedPeers.getAllPeerIds())
            .thenAnswer((_) async => ['peer1']);
        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPubkey);
        when(() => mockTrustedPeers.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => theirPubkey);
        when(() => mockMeetingPoint.deriveDailyPoints(any(), any()))
            .thenReturn(['no_match_1', 'no_match_2', 'no_match_3']);
        when(() => mockCrypto.getSessionKeyBytes(any()))
            .thenAnswer((_) async => null);

        // Act
        final peerId = await service.identifyPeerFromMeetingPoint('unknown_point');

        // Assert
        expect(peerId, isNull);
      });

      test('should check hourly tokens if shared secret exists', () async {
        // Arrange
        when(() => mockTrustedPeers.getAllPeerIds())
            .thenAnswer((_) async => ['peer1']);
        when(() => mockCrypto.getPublicKeyBytes())
            .thenAnswer((_) async => myPubkey);
        when(() => mockTrustedPeers.getPublicKeyBytes('peer1'))
            .thenAnswer((_) async => theirPubkey);
        when(() => mockMeetingPoint.deriveDailyPoints(any(), any()))
            .thenReturn(['no_match_1', 'no_match_2', 'no_match_3']);
        when(() => mockCrypto.getSessionKeyBytes('peer1'))
            .thenAnswer((_) async => sharedSecret);
        when(() => mockMeetingPoint.deriveHourlyTokens(any()))
            .thenReturn(['hourly_match', 'hr_2', 'hr_3']);

        // Act
        final peerId = await service.identifyPeerFromMeetingPoint('hourly_match');

        // Assert
        expect(peerId, 'peer1');
      });
    });
  });

  group('ConnectionInfo', () {
    test('should serialize and deserialize correctly', () {
      // Arrange
      final timestamp = DateTime.now().toUtc();
      final info = ConnectionInfo(
        publicKey: 'test_key',
        relayId: 'relay_1',
        sourceId: 'source_1',
        ip: '192.168.1.1',
        port: 8080,
        fallbackRelays: ['r1', 'r2'],
        timestamp: timestamp,
      );

      // Act
      final json = info.toJson();
      final restored = ConnectionInfo.fromJson(json);

      // Assert
      expect(restored.publicKey, info.publicKey);
      expect(restored.relayId, info.relayId);
      expect(restored.sourceId, info.sourceId);
      expect(restored.ip, info.ip);
      expect(restored.port, info.port);
      expect(restored.fallbackRelays, info.fallbackRelays);
      expect(
        restored.timestamp.millisecondsSinceEpoch,
        info.timestamp.millisecondsSinceEpoch,
      );
    });

    test('isStale should return true for old timestamps', () {
      // Arrange
      final oldTimestamp =
          DateTime.now().toUtc().subtract(const Duration(hours: 2));
      final info = ConnectionInfo(
        publicKey: 'key',
        relayId: 'relay',
        sourceId: 'source',
        ip: '1.2.3.4',
        port: 1234,
        timestamp: oldTimestamp,
      );

      // Assert
      expect(info.isStale, true);
    });

    test('isStale should return false for recent timestamps', () {
      // Arrange
      final recentTimestamp =
          DateTime.now().toUtc().subtract(const Duration(minutes: 30));
      final info = ConnectionInfo(
        publicKey: 'key',
        relayId: 'relay',
        sourceId: 'source',
        ip: '1.2.3.4',
        port: 1234,
        timestamp: recentTimestamp,
      );

      // Assert
      expect(info.isStale, false);
    });

    test('copyWith should create correct copy', () {
      // Arrange
      final original = ConnectionInfo(
        publicKey: 'key1',
        relayId: 'relay1',
        sourceId: 'source1',
        ip: '1.1.1.1',
        port: 1111,
        timestamp: DateTime.now().toUtc(),
      );

      // Act
      final modified = original.copyWith(ip: '2.2.2.2', port: 2222);

      // Assert
      expect(modified.ip, '2.2.2.2');
      expect(modified.port, 2222);
      expect(modified.publicKey, original.publicKey);
      expect(modified.relayId, original.relayId);
    });
  });

  group('DeadDrop', () {
    test('should serialize and deserialize correctly', () {
      // Arrange
      final drop = DeadDrop(
        peerId: 'peer_1',
        encryptedPayload: 'encrypted_data',
        relayId: 'relay_1',
        meetingPoint: 'meeting_point_1',
      );

      // Act
      final json = drop.toJson();
      final restored = DeadDrop.fromJson(json);

      // Assert
      expect(restored.peerId, drop.peerId);
      expect(restored.encryptedPayload, drop.encryptedPayload);
      expect(restored.relayId, drop.relayId);
      expect(restored.meetingPoint, drop.meetingPoint);
    });

    test('should handle null peerId', () {
      // Arrange
      final drop = DeadDrop(
        encryptedPayload: 'enc',
        relayId: 'relay',
        meetingPoint: 'mp',
      );

      // Assert
      expect(drop.peerId, isNull);

      // Serialize and deserialize
      final restored = DeadDrop.fromJson(drop.toJson());
      expect(restored.peerId, isNull);
    });
  });

  group('LiveMatch', () {
    test('should serialize and deserialize correctly', () {
      // Arrange
      final match = LiveMatch(
        peerId: 'peer_1',
        relayId: 'relay_1',
        meetingPoint: 'meeting_point_1',
        connectionHints: {'hint': 'value'},
      );

      // Act
      final json = match.toJson();
      final restored = LiveMatch.fromJson(json);

      // Assert
      expect(restored.peerId, match.peerId);
      expect(restored.relayId, match.relayId);
      expect(restored.meetingPoint, match.meetingPoint);
      expect(restored.connectionHints, match.connectionHints);
    });
  });

  group('RendezvousResult', () {
    test('should report hasMatches correctly', () {
      // Arrange
      final emptyResult = RendezvousResult();
      final withLive = RendezvousResult(
        liveMatches: [
          LiveMatch(relayId: 'r', meetingPoint: 'mp'),
        ],
      );
      final withDrop = RendezvousResult(
        deadDrops: [
          DeadDrop(encryptedPayload: 'e', relayId: 'r', meetingPoint: 'mp'),
        ],
      );

      // Assert
      expect(emptyResult.hasMatches, false);
      expect(withLive.hasMatches, true);
      expect(withDrop.hasMatches, true);
    });

    test('should count total matches correctly', () {
      // Arrange
      final result = RendezvousResult(
        liveMatches: [
          LiveMatch(relayId: 'r1', meetingPoint: 'mp1'),
          LiveMatch(relayId: 'r2', meetingPoint: 'mp2'),
        ],
        deadDrops: [
          DeadDrop(encryptedPayload: 'e', relayId: 'r', meetingPoint: 'mp'),
        ],
      );

      // Assert
      expect(result.totalMatches, 3);
    });

    test('failure factory should create failed result', () {
      // Arrange
      final result = RendezvousResult.failure('Test error');

      // Assert
      expect(result.success, false);
      expect(result.error, 'Test error');
      expect(result.liveMatches, isEmpty);
      expect(result.deadDrops, isEmpty);
    });
  });

  group('RendezvousRegistration', () {
    test('should serialize correctly', () {
      // Arrange
      final registration = RendezvousRegistration(
        dailyPoints: ['d1', 'd2'],
        hourlyTokens: ['h1', 'h2'],
        deadDrop: 'encrypted_dead_drop',
        relayId: 'relay_1',
      );

      // Act
      final json = registration.toJson();

      // Assert
      expect(json['dailyPoints'], ['d1', 'd2']);
      expect(json['hourlyTokens'], ['h1', 'h2']);
      expect(json['deadDrop'], 'encrypted_dead_drop');
      expect(json['relayId'], 'relay_1');
    });
  });
}
