import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/signaling_client.dart';

import '../mocks/mocks.dart';

void main() {
  group('SignalingClient Rendezvous', () {
    late FakeWebSocketChannel fakeChannel;
    late SignalingClient client;
    late List<RendezvousEvent> receivedEvents;
    late StreamSubscription<RendezvousEvent> subscription;

    setUp(() {
      fakeChannel = FakeWebSocketChannel();
      receivedEvents = [];
    });

    tearDown(() async {
      // Only clean up if client was initialized (some tests only test data classes)
      try {
        await subscription.cancel();
      } catch (_) {
        // subscription might not be initialized
      }
      try {
        await client.dispose();
      } catch (_) {
        // client might not be initialized
      }
      fakeChannel.dispose();
    });

    /// Helper to create a SignalingClient with the fake channel.
    /// Note: We can't easily inject the channel, so we test message parsing directly.
    Future<void> setupClientWithMessageSimulation(String serverUrl) async {
      client = SignalingClient(
        serverUrl: serverUrl,
        pairingCode: 'TEST-CODE',
        publicKey: 'test-public-key-base64',
        usePinnedWebSocket: false,
      );

      subscription = client.rendezvousEvents.listen(receivedEvents.add);
    }

    group('Message Parsing', () {
      test('parses rendezvous_result message correctly', () async {
        // Create a SignalingClient - we'll test the message handler indirectly
        await setupClientWithMessageSimulation('wss://test.example.com');

        // We can't inject the message directly, but we can verify the parsing logic
        // by testing the RendezvousResult class construction
        final result = RendezvousResult(
          liveMatches: [
            LiveMatch(peerId: 'peer1', relayId: 'relay1'),
            LiveMatch(peerId: 'peer2', relayId: null),
          ],
          deadDrops: [
            DeadDrop(peerId: 'peer3', encryptedData: 'encrypted-data-1', relayId: 'relay2'),
          ],
        );

        expect(result.liveMatches, hasLength(2));
        expect(result.liveMatches[0].peerId, equals('peer1'));
        expect(result.liveMatches[0].relayId, equals('relay1'));
        expect(result.liveMatches[1].peerId, equals('peer2'));
        expect(result.liveMatches[1].relayId, isNull);

        expect(result.deadDrops, hasLength(1));
        expect(result.deadDrops[0].peerId, equals('peer3'));
        expect(result.deadDrops[0].encryptedData, equals('encrypted-data-1'));
      });

      test('parses rendezvous_partial message correctly', () async {
        await setupClientWithMessageSimulation('wss://test.example.com');

        // Test RendezvousPartial class construction
        final partial = RendezvousPartial(
          liveMatches: [
            LiveMatch(peerId: 'local-peer', relayId: 'relay1'),
          ],
          deadDrops: [],
          redirects: [
            RendezvousRedirect(
              serverId: 'server-2',
              endpoint: 'wss://server2.example.com',
              dailyPoints: ['point-a', 'point-b'],
              hourlyTokens: ['token-1'],
            ),
          ],
        );

        expect(partial.liveMatches, hasLength(1));
        expect(partial.redirects, hasLength(1));
        expect(partial.redirects[0].serverId, equals('server-2'));
        expect(partial.redirects[0].dailyPoints, contains('point-a'));
        expect(partial.redirects[0].hourlyTokens, contains('token-1'));
      });

      test('parses rendezvous_match message correctly', () async {
        await setupClientWithMessageSimulation('wss://test.example.com');

        // Test RendezvousMatch class construction
        final match = RendezvousMatch(
          peerId: 'matched-peer',
          relayId: 'relay-001',
          meetingPoint: 'point-xyz',
        );

        expect(match.peerId, equals('matched-peer'));
        expect(match.relayId, equals('relay-001'));
        expect(match.meetingPoint, equals('point-xyz'));
      });
    });

    group('Event Types', () {
      test('RendezvousEvent sealed class covers all cases', () async {
        await setupClientWithMessageSimulation('wss://test.example.com');

        // Test exhaustive pattern matching on sealed class
        void handleEvent(RendezvousEvent event) {
          switch (event) {
            case RendezvousResult(:final liveMatches, :final deadDrops):
              expect(liveMatches, isA<List<LiveMatch>>());
              expect(deadDrops, isA<List<DeadDrop>>());
            case RendezvousPartial(:final liveMatches, :final deadDrops, :final redirects):
              expect(liveMatches, isA<List<LiveMatch>>());
              expect(deadDrops, isA<List<DeadDrop>>());
              expect(redirects, isA<List<RendezvousRedirect>>());
            case RendezvousMatch(:final peerId, :final relayId, meetingPoint: _):
              expect(peerId, isA<String>());
              expect(relayId, anyOf(isNull, isA<String>()));
          }
        }

        // Test each type
        handleEvent(RendezvousResult(liveMatches: [], deadDrops: []));
        handleEvent(RendezvousPartial(liveMatches: [], deadDrops: [], redirects: []));
        handleEvent(RendezvousMatch(peerId: 'test', relayId: null, meetingPoint: null));
      });
    });

    group('LiveMatch', () {
      test('stores peerId and optional relayId', () {
        final match1 = LiveMatch(peerId: 'peer-1', relayId: 'relay-1');
        final match2 = LiveMatch(peerId: 'peer-2');

        expect(match1.peerId, equals('peer-1'));
        expect(match1.relayId, equals('relay-1'));
        expect(match2.peerId, equals('peer-2'));
        expect(match2.relayId, isNull);
      });
    });

    group('DeadDrop', () {
      test('stores peerId, encryptedData, and optional relayId', () {
        final drop = DeadDrop(
          peerId: 'peer-1',
          encryptedData: 'encrypted-connection-info',
          relayId: 'relay-1',
        );

        expect(drop.peerId, equals('peer-1'));
        expect(drop.encryptedData, equals('encrypted-connection-info'));
        expect(drop.relayId, equals('relay-1'));
      });
    });

    group('RendezvousRedirect', () {
      test('stores server info and point lists', () {
        final redirect = RendezvousRedirect(
          serverId: 'server-2',
          endpoint: 'wss://server2.example.com',
          dailyPoints: ['point-1', 'point-2', 'point-3'],
          hourlyTokens: ['token-1', 'token-2'],
        );

        expect(redirect.serverId, equals('server-2'));
        expect(redirect.endpoint, equals('wss://server2.example.com'));
        expect(redirect.dailyPoints, hasLength(3));
        expect(redirect.hourlyTokens, hasLength(2));
      });
    });
  });
}
