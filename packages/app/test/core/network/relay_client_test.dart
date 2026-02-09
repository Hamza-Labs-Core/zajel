import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/network/relay_client.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/core/network/signaling_client.dart';
import 'package:zajel/core/crypto/crypto_service.dart';

// Mock classes
class MockWebRTCService extends Mock implements WebRTCService {}

class MockSignalingClient extends Mock implements SignalingClient {}

class MockCryptoService extends Mock implements CryptoService {}

class FakeRelayInfo extends Fake implements RelayInfo {}

void main() {
  setUpAll(() {
    registerFallbackValue(FakeRelayInfo());
  });

  group('RelayClient', () {
    late RelayClient client;
    late MockWebRTCService mockWebRTC;
    late MockSignalingClient mockSignaling;

    setUp(() {
      mockWebRTC = MockWebRTCService();
      mockSignaling = MockSignalingClient();

      // Set up default stubs
      when(() => mockWebRTC.onMessage).thenReturn(null);
      when(() => mockWebRTC.onConnectionStateChange).thenReturn(null);
      when(() => mockWebRTC.onSignalingMessage).thenReturn(null);
      when(() => mockWebRTC.closeConnection(any())).thenAnswer((_) async {});
      when(() => mockSignaling.isConnected).thenReturn(true);

      client = RelayClient(
        webrtcService: mockWebRTC,
        signalingClient: mockSignaling,
        maxRelayConnections: 10,
      );
    });

    tearDown(() {
      client.dispose();
    });

    group('initialization', () {
      test('should generate unique source ID on initialization', () {
        expect(client.mySourceId, isNotEmpty);
        expect(client.mySourceId.length, greaterThanOrEqualTo(10));
      });

      test('should use provided source ID if savedSourceId is given', () {
        final savedId = 'saved_source_id_123';
        final clientWithSavedId = RelayClient(
          webrtcService: mockWebRTC,
          signalingClient: mockSignaling,
          savedSourceId: savedId,
        );

        expect(clientWithSavedId.mySourceId, equals(savedId));
        clientWithSavedId.dispose();
      });

      test('should have empty connected relays initially', () {
        expect(client.getConnectedRelayIds(), isEmpty);
      });

      test('should have zero load initially', () {
        expect(client.currentLoad, equals(0));
      });
    });

    group('connectToRelays', () {
      test('should connect to all provided relays', () async {
        final relays = [
          RelayInfo(peerId: 'relay1', publicKey: 'pk1'),
          RelayInfo(peerId: 'relay2', publicKey: 'pk2'),
          RelayInfo(peerId: 'relay3', publicKey: 'pk3'),
        ];

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        await client.connectToRelays(relays);

        verify(() => mockWebRTC.createOffer('relay1')).called(1);
        verify(() => mockWebRTC.createOffer('relay2')).called(1);
        verify(() => mockWebRTC.createOffer('relay3')).called(1);
        expect(client.getConnectedRelayIds(),
            containsAll(['relay1', 'relay2', 'relay3']));
      });

      test('should respect maxRelayConnections limit', () async {
        final relays = List.generate(
            15, (i) => RelayInfo(peerId: 'relay$i', publicKey: 'pk$i'));

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        await client.connectToRelays(relays);

        expect(client.getConnectedRelayIds().length, equals(10));
      });

      test('should skip already connected relays', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        await client.connectToRelays([relay]);

        // Try to connect again
        await client.connectToRelays([relay]);

        // Should only connect once
        verify(() => mockWebRTC.createOffer('relay1')).called(1);
      });

      test('should handle connection failures gracefully', () async {
        final relays = [
          RelayInfo(peerId: 'relay1', publicKey: 'pk1'),
          RelayInfo(peerId: 'relay2', publicKey: 'pk2'),
        ];

        when(() => mockWebRTC.createOffer('relay1'))
            .thenThrow(Exception('Connection failed'));
        when(() => mockWebRTC.createOffer('relay2'))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        await client.connectToRelays(relays);

        // Should connect to relay2 despite relay1 failure
        expect(client.getConnectedRelayIds(), contains('relay2'));
        expect(client.getConnectedRelayIds(), isNot(contains('relay1')));
      });

      test('should emit RelayStateEvent when connection succeeds', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');
        final events = <RelayStateEvent>[];

        client.onRelayStateChange.listen(events.add);

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        await client.connectToRelays([relay]);

        await Future.delayed(Duration(milliseconds: 10));

        expect(events.length, greaterThanOrEqualTo(1));
        expect(
            events.any((e) =>
                e.relayId == 'relay1' &&
                e.state == RelayConnectionState.connecting),
            isTrue);
      });
    });

    group('ensureConnectedToRelay', () {
      test('should connect if not already connected', () async {
        final relayInfo = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockSignaling.isConnected).thenReturn(true);
        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        await client.ensureConnectedToRelay('relay1', relayInfo: relayInfo);

        verify(() => mockWebRTC.createOffer('relay1')).called(1);
      });

      test('should not reconnect if already connected', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        // Connect first
        await client.connectToRelays([relay]);

        // Try to ensure connection
        await client.ensureConnectedToRelay('relay1');

        // Should only call createOffer once (from initial connect)
        verify(() => mockWebRTC.createOffer('relay1')).called(1);
      });
    });

    group('disconnectRelay', () {
      test('should close connection and remove from list', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});
        when(() => mockWebRTC.closeConnection(any())).thenAnswer((_) async {});

        await client.connectToRelays([relay]);
        expect(client.getConnectedRelayIds(), contains('relay1'));

        await client.disconnectRelay('relay1');

        verify(() => mockWebRTC.closeConnection('relay1')).called(1);
        expect(client.getConnectedRelayIds(), isNot(contains('relay1')));
      });

      test('should emit disconnected state event', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');
        final events = <RelayStateEvent>[];

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});
        when(() => mockWebRTC.closeConnection(any())).thenAnswer((_) async {});

        await client.connectToRelays([relay]);
        client.onRelayStateChange.listen(events.add);

        await client.disconnectRelay('relay1');

        await Future.delayed(Duration(milliseconds: 10));

        expect(
            events.any((e) =>
                e.relayId == 'relay1' &&
                e.state == RelayConnectionState.disconnected),
            isTrue);
      });

      test('should clear source ID mappings for disconnected relay', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});
        when(() => mockWebRTC.closeConnection(any())).thenAnswer((_) async {});

        await client.connectToRelays([relay]);
        client.registerSourceId('relay1', 'source_abc');

        await client.disconnectRelay('relay1');

        expect(client.getPeerIdBySourceId('source_abc'), isNull);
      });
    });

    group('getConnectedRelayIds', () {
      test('should return empty list when no connections', () {
        expect(client.getConnectedRelayIds(), isEmpty);
      });

      test('should return all connected relay IDs', () async {
        final relays = [
          RelayInfo(peerId: 'relay1', publicKey: 'pk1'),
          RelayInfo(peerId: 'relay2', publicKey: 'pk2'),
        ];

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        await client.connectToRelays(relays);

        final ids = client.getConnectedRelayIds();
        expect(ids, hasLength(2));
        expect(ids, containsAll(['relay1', 'relay2']));
      });
    });

    group('getCurrentRelayId', () {
      test('should return null when no connections', () {
        expect(client.getCurrentRelayId(), isNull);
      });

      test('should return a connected relay ID', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((_) async {});

        await client.connectToRelays([relay]);

        expect(client.getCurrentRelayId(), equals('relay1'));
      });
    });
  });
}
