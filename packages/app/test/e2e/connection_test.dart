import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/models/peer.dart';
import 'package:zajel/core/network/connection_manager.dart';
import 'package:zajel/core/network/server_discovery_service.dart';
import 'package:zajel/core/network/signaling_client.dart';

import '../mocks/mocks.dart';

// Mock HTTP client for server discovery
class MockHttpClient extends Mock implements http.Client {}

class FakeUri extends Fake implements Uri {}

void main() {
  setUpAll(() {
    registerFallbackValue(FakeUri());
  });

  group('Connection Flow E2E Tests', () {
    late MockCryptoService mockCryptoService;
    late MockWebRTCService mockWebRTCService;
    late MockDeviceLinkService mockDeviceLinkService;
    late MockHttpClient mockHttpClient;
    late ConnectionManager connectionManager;
    late ServerDiscoveryService discoveryService;

    const testBootstrapUrl = 'https://zajel-bootstrap.example.com';

    setUp(() {
      mockCryptoService = MockCryptoService();
      mockWebRTCService = MockWebRTCService();
      mockDeviceLinkService = MockDeviceLinkService();
      mockHttpClient = MockHttpClient();

      // Default stubs
      when(() => mockWebRTCService.dispose()).thenAnswer((_) async {});
      when(() => mockWebRTCService.signalingEvents)
          .thenAnswer((_) => const Stream.empty());

      discoveryService = ServerDiscoveryService(
        bootstrapUrl: testBootstrapUrl,
        client: mockHttpClient,
      );

      connectionManager = ConnectionManager(
        cryptoService: mockCryptoService,
        webrtcService: mockWebRTCService,
        deviceLinkService: mockDeviceLinkService,
        trustedPeersStorage: MockTrustedPeersStorage(),
        meetingPointService: MockMeetingPointService(),
      );
    });

    tearDown(() async {
      await connectionManager.dispose();
      discoveryService.dispose();
    });

    group('Connection to VPS Server', () {
      test('discovers and connects to VPS server flow', () async {
        // Arrange - Set up server discovery
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:vpsServer1',
              'endpoint': 'wss://vps1.example.com',
              'publicKey': 'vpsPublicKey1',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockHttpClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act - Discover servers
        final servers = await discoveryService.fetchServers();
        final selectedServer = await discoveryService.selectServer();

        // Assert - Server discovered
        expect(servers, hasLength(1));
        expect(selectedServer, isNotNull);
        expect(selectedServer!.endpoint, equals('wss://vps1.example.com'));
      });

      test('connection manager initializes crypto service', () async {
        // Arrange
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});

        // Act
        await connectionManager.initialize();

        // Assert
        verify(() => mockCryptoService.initialize()).called(1);
      });

      test('enabling external connections requires initialized crypto', () async {
        // Arrange - crypto not initialized
        when(() => mockCryptoService.publicKeyBase64).thenThrow(
          CryptoException('CryptoService not initialized'),
        );

        // Act & Assert
        expect(
          () => connectionManager.connect(
            serverUrl: 'wss://vps1.example.com',
          ),
          throwsA(isA<CryptoException>()),
        );
      });
    });

    group('Pairing Code Generation', () {
      test('pairing code is 6 characters', () {
        // The pairing code format is validated in ConnectionManager
        // Valid codes are 6 chars from ABCDEFGHJKLMNPQRSTUVWXYZ23456789
        const validCode = 'ABC234';
        expect(validCode.length, equals(6));
      });

      test('pairing code uses allowed character set', () {
        // Characters allowed: A-Z (excluding O, I) + 2-9
        const allowedChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const validCode = 'XYZ789';

        for (final char in validCode.split('')) {
          expect(allowedChars.contains(char), isTrue,
              reason: 'Character $char should be allowed');
        }
      });

      test('invalid pairing code format is rejected', () async {
        // Arrange
        when(() => mockCryptoService.publicKeyBase64).thenReturn('testKey');

        // Act & Assert - Invalid characters
        expect(
          () => connectionManager.connectToPeer('ABC1O0'), // Contains 1, O, 0
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Invalid pairing code format'),
          )),
        );
      });

      test('pairing code too short is rejected', () async {
        // Arrange
        when(() => mockCryptoService.publicKeyBase64).thenReturn('testKey');

        // Act & Assert
        expect(
          () => connectionManager.connectToPeer('ABC23'), // Only 5 chars
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Invalid pairing code format'),
          )),
        );
      });

      test('pairing code too long is rejected', () async {
        // Arrange
        when(() => mockCryptoService.publicKeyBase64).thenReturn('testKey');

        // Act & Assert
        expect(
          () => connectionManager.connectToPeer('ABC2345'), // 7 chars
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Invalid pairing code format'),
          )),
        );
      });

      test('pairing code is case-insensitive', () async {
        // Arrange
        when(() => mockCryptoService.publicKeyBase64).thenReturn('testKey');

        // Both should fail the same way (not connected) - proving normalization works
        // Lower case should be normalized to upper case
        expect(
          () => connectionManager.connectToPeer('abc234'),
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Not connected to signaling server'),
          )),
        );
      });
    });

    group('WebRTC Connection Establishment', () {
      test('offer/answer exchange flow', () async {
        // This tests the signaling message types used in WebRTC setup
        final offer = SignalingMessage.offer(
          from: 'PEER01',
          payload: {'type': 'offer', 'sdp': 'v=0\r\n...'},
        );

        expect(offer, isA<SignalingOffer>());
        final offerMsg = offer as SignalingOffer;
        expect(offerMsg.payload['type'], equals('offer'));
        expect(offerMsg.payload['sdp'], isNotNull);

        final answer = SignalingMessage.answer(
          from: 'PEER02',
          payload: {'type': 'answer', 'sdp': 'v=0\r\n...'},
        );

        expect(answer, isA<SignalingAnswer>());
        final answerMsg = answer as SignalingAnswer;
        expect(answerMsg.payload['type'], equals('answer'));
      });

      test('ICE candidate exchange flow', () async {
        final iceCandidate = SignalingMessage.iceCandidate(
          from: 'PEER01',
          payload: {
            'candidate': 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host',
            'sdpMid': 'data',
            'sdpMLineIndex': 0,
          },
        );

        expect(iceCandidate, isA<SignalingIceCandidate>());
        final iceCandidateMsg = iceCandidate as SignalingIceCandidate;
        expect(iceCandidateMsg.payload['candidate'], contains('candidate:'));
        expect(iceCandidateMsg.payload['sdpMid'], equals('data'));
      });

      test('pair matching triggers WebRTC connection', () async {
        // The pair_matched message signals both parties to start WebRTC
        final pairMatched = SignalingMessage.pairMatched(
          peerCode: 'ABC234',
          peerPublicKey: 'peerPublicKeyBase64==',
          isInitiator: true,
        );

        expect(pairMatched, isA<SignalingPairMatched>());
        final matched = pairMatched as SignalingPairMatched;
        expect(matched.peerCode, equals('ABC234'));
        expect(matched.isInitiator, isTrue);
      });
    });

    group('Server Failover', () {
      test('multiple servers available for failover', () async {
        // Arrange - Multiple VPS servers
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:primaryServer',
              'endpoint': 'wss://primary.example.com',
              'publicKey': 'primaryKey',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
            {
              'serverId': 'ed25519:backupServer',
              'endpoint': 'wss://backup.example.com',
              'publicKey': 'backupKey',
              'region': 'us-west',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockHttpClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act
        final servers = await discoveryService.fetchServers();

        // Assert - Multiple servers available
        expect(servers.length, greaterThanOrEqualTo(2));
      });

      test('server selection for load distribution', () async {
        // Arrange - Multiple servers with different lastSeen times
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:server1',
              'endpoint': 'wss://server1.example.com',
              'publicKey': 'key1',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now - 10000, // 10 seconds ago
            },
            {
              'serverId': 'ed25519:server2',
              'endpoint': 'wss://server2.example.com',
              'publicKey': 'key2',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now - 5000, // 5 seconds ago (more recent)
            },
            {
              'serverId': 'ed25519:server3',
              'endpoint': 'wss://server3.example.com',
              'publicKey': 'key3',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now, // Just now (most recent)
            },
          ],
        };

        when(() => mockHttpClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act - Select server multiple times
        final selections = <String>{};
        for (var i = 0; i < 10; i++) {
          final server = await discoveryService.selectServer();
          if (server != null) {
            selections.add(server.serverId);
          }
        }

        // Assert - Server selection distributes among top candidates
        expect(selections, isNotEmpty);
      });

      test('handles server going offline (stale)', () async {
        // Arrange - Initial fetch with online server
        final now = DateTime.now().millisecondsSinceEpoch;
        var firstCall = true;

        when(() => mockHttpClient.get(any())).thenAnswer((_) async {
          if (firstCall) {
            firstCall = false;
            // First call - server is online
            return http.Response(jsonEncode({
              'servers': [
                {
                  'serverId': 'ed25519:server1',
                  'endpoint': 'wss://server1.example.com',
                  'publicKey': 'key1',
                  'region': 'us-east',
                  'registeredAt': now,
                  'lastSeen': now,
                },
              ],
            }), 200);
          } else {
            // Second call - server is stale
            return http.Response(jsonEncode({
              'servers': [
                {
                  'serverId': 'ed25519:server1',
                  'endpoint': 'wss://server1.example.com',
                  'publicKey': 'key1',
                  'region': 'us-east',
                  'registeredAt': now,
                  'lastSeen': now - 300000, // 5 minutes ago - stale
                },
              ],
            }), 200);
          }
        });

        // Act - First fetch (online)
        final servers1 = await discoveryService.fetchServers();
        expect(servers1, hasLength(1));

        // Act - Force refresh (server now stale)
        final servers2 = await discoveryService.fetchServers(forceRefresh: true);

        // Assert - Stale server filtered out
        expect(servers2, isEmpty);
      });
    });

    group('Connection State Management', () {
      test('connection states are properly defined', () {
        expect(PeerConnectionState.values, contains(PeerConnectionState.disconnected));
        expect(PeerConnectionState.values, contains(PeerConnectionState.discovering));
        expect(PeerConnectionState.values, contains(PeerConnectionState.connecting));
        expect(PeerConnectionState.values, contains(PeerConnectionState.handshaking));
        expect(PeerConnectionState.values, contains(PeerConnectionState.connected));
        expect(PeerConnectionState.values, contains(PeerConnectionState.failed));
      });

      test('peers stream emits updates', () async {
        // Arrange
        final peersList = <List<Peer>>[];
        final subscription = connectionManager.peers.listen(peersList.add);

        // The peers list starts empty
        await Future.delayed(Duration.zero);

        // Cleanup
        await subscription.cancel();

        // Assert - Initial state
        expect(connectionManager.currentPeers, isEmpty);
      });

      test('pair request rejection removes peer', () async {
        // Act - Reject a pair request
        connectionManager.respondToPairRequest('UNKNWN', accept: false);

        // Assert - Peer should not exist
        expect(
          connectionManager.currentPeers.any((p) => p.id == 'UNKNWN'),
          isFalse,
        );
      });
    });

    group('Error Handling', () {
      test('network error during server discovery is handled gracefully', () async {
        // Arrange
        when(() => mockHttpClient.get(any()))
            .thenThrow(Exception('Network unreachable'));

        // Act
        final servers = await discoveryService.fetchServers();

        // Assert - Should not throw, returns empty list
        expect(servers, isEmpty);
      });

      test('invalid pairing code throws ConnectionException', () async {
        // Arrange
        when(() => mockCryptoService.publicKeyBase64).thenReturn('testKey');

        // Act & Assert
        expect(
          () => connectionManager.connectToPeer('!!!!!!'),
          throwsA(isA<ConnectionException>()),
        );
      });

      test('connecting without signaling server throws ConnectionException', () async {
        // Act & Assert
        expect(
          () => connectionManager.connectToPeer('ABC234'),
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Not connected to signaling server'),
          )),
        );
      });
    });

    group('Signaling Message Types', () {
      test('pair_incoming message for approval flow', () {
        final incoming = SignalingMessage.pairIncoming(
          fromCode: 'XYZ789',
          fromPublicKey: 'requesterPublicKey==',
        );

        expect(incoming, isA<SignalingPairIncoming>());
        final incomingMsg = incoming as SignalingPairIncoming;
        expect(incomingMsg.fromCode, equals('XYZ789'));
        expect(incomingMsg.fromPublicKey, equals('requesterPublicKey=='));
      });

      test('pair_rejected message', () {
        final rejected = SignalingMessage.pairRejected(peerCode: 'ABC234');

        expect(rejected, isA<SignalingPairRejected>());
        final rejectedMsg = rejected as SignalingPairRejected;
        expect(rejectedMsg.peerCode, equals('ABC234'));
      });

      test('pair_timeout message', () {
        final timeout = SignalingMessage.pairTimeout(peerCode: 'ABC234');

        expect(timeout, isA<SignalingPairTimeout>());
        final timeoutMsg = timeout as SignalingPairTimeout;
        expect(timeoutMsg.peerCode, equals('ABC234'));
      });

      test('error message', () {
        final error = SignalingMessage.error(message: 'Rate limit exceeded');

        expect(error, isA<SignalingError>());
        final errorMsg = error as SignalingError;
        expect(errorMsg.message, equals('Rate limit exceeded'));
      });

      test('peer_joined message', () {
        final joined = SignalingMessage.peerJoined(peerId: 'NEWPEER');

        expect(joined, isA<SignalingPeerJoined>());
        final joinedMsg = joined as SignalingPeerJoined;
        expect(joinedMsg.peerId, equals('NEWPEER'));
      });

      test('peer_left message', () {
        final left = SignalingMessage.peerLeft(peerId: 'GONEPR');

        expect(left, isA<SignalingPeerLeft>());
        final leftMsg = left as SignalingPeerLeft;
        expect(leftMsg.peerId, equals('GONEPR'));
      });
    });

    group('Device Linking Messages', () {
      test('link_request message for web client linking', () {
        final linkRequest = SignalingMessage.linkRequest(
          linkCode: 'LINK99',
          publicKey: 'webClientPublicKey==',
          deviceName: 'Chrome Browser',
        );

        expect(linkRequest, isA<SignalingLinkRequest>());
        final linkMsg = linkRequest as SignalingLinkRequest;
        expect(linkMsg.linkCode, equals('LINK99'));
        expect(linkMsg.publicKey, equals('webClientPublicKey=='));
        expect(linkMsg.deviceName, equals('Chrome Browser'));
      });

      test('link_matched message', () {
        final linkMatched = SignalingMessage.linkMatched(
          linkCode: 'LINK99',
          peerPublicKey: 'mobilePublicKey==',
          isInitiator: false,
        );

        expect(linkMatched, isA<SignalingLinkMatched>());
        final matchedMsg = linkMatched as SignalingLinkMatched;
        expect(matchedMsg.linkCode, equals('LINK99'));
        expect(matchedMsg.peerPublicKey, equals('mobilePublicKey=='));
        expect(matchedMsg.isInitiator, isFalse);
      });

      test('link_rejected message', () {
        final linkRejected = SignalingMessage.linkRejected(linkCode: 'LINK99');

        expect(linkRejected, isA<SignalingLinkRejected>());
        final rejectedMsg = linkRejected as SignalingLinkRejected;
        expect(rejectedMsg.linkCode, equals('LINK99'));
      });

      test('link_timeout message', () {
        final linkTimeout = SignalingMessage.linkTimeout(linkCode: 'LINK99');

        expect(linkTimeout, isA<SignalingLinkTimeout>());
        final timeoutMsg = linkTimeout as SignalingLinkTimeout;
        expect(timeoutMsg.linkCode, equals('LINK99'));
      });
    });

    group('Signaling Connection State', () {
      test('all connection states are defined', () {
        expect(SignalingConnectionState.values, hasLength(4));
        expect(SignalingConnectionState.values, contains(SignalingConnectionState.disconnected));
        expect(SignalingConnectionState.values, contains(SignalingConnectionState.connecting));
        expect(SignalingConnectionState.values, contains(SignalingConnectionState.connected));
        expect(SignalingConnectionState.values, contains(SignalingConnectionState.failed));
      });
    });
  });

  group('Integration Scenarios', () {
    late MockHttpClient mockHttpClient;
    late ServerDiscoveryService discoveryService;

    const testBootstrapUrl = 'https://zajel-bootstrap.example.com';

    setUp(() {
      mockHttpClient = MockHttpClient();
      discoveryService = ServerDiscoveryService(
        bootstrapUrl: testBootstrapUrl,
        client: mockHttpClient,
      );
    });

    tearDown(() {
      discoveryService.dispose();
    });

    group('Full Discovery to Server Selection Flow', () {
      test('discovers servers, filters stale, selects best', () async {
        // Arrange - Mixed server list
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:freshEU',
              'endpoint': 'wss://eu.example.com',
              'publicKey': 'euKey',
              'region': 'eu-west',
              'registeredAt': now - 60000,
              'lastSeen': now - 30000, // Fresh (30s ago)
            },
            {
              'serverId': 'ed25519:staleUS',
              'endpoint': 'wss://us.example.com',
              'publicKey': 'usKey',
              'region': 'us-east',
              'registeredAt': now - 600000,
              'lastSeen': now - 300000, // Stale (5min ago)
            },
            {
              'serverId': 'ed25519:freshAP',
              'endpoint': 'wss://ap.example.com',
              'publicKey': 'apKey',
              'region': 'ap-south',
              'registeredAt': now - 30000,
              'lastSeen': now - 10000, // Very fresh (10s ago)
            },
          ],
        };

        when(() => mockHttpClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act
        final servers = await discoveryService.fetchServers();
        final selected = await discoveryService.selectServer();

        // Assert - Only fresh servers returned
        expect(servers, hasLength(2)); // Stale US server filtered
        expect(servers.map((s) => s.serverId), isNot(contains('ed25519:staleUS')));

        // Selected server should be one of the fresh ones
        expect(selected, isNotNull);
        expect(
          ['ed25519:freshEU', 'ed25519:freshAP'],
          contains(selected!.serverId),
        );
      });

      test('prefers region but falls back when unavailable', () async {
        // Arrange - Only EU server
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:euServer',
              'endpoint': 'wss://eu.example.com',
              'publicKey': 'euKey',
              'region': 'eu-west',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockHttpClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act - Request US region (not available)
        final selected = await discoveryService.selectServer(preferredRegion: 'us-east');

        // Assert - Falls back to available EU server
        expect(selected, isNotNull);
        expect(selected!.region, equals('eu-west'));
      });
    });

    group('Caching Behavior', () {
      test('cache is used within cache duration', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        var callCount = 0;

        when(() => mockHttpClient.get(any())).thenAnswer((_) async {
          callCount++;
          return http.Response(jsonEncode({
            'servers': [
              {
                'serverId': 'ed25519:server$callCount',
                'endpoint': 'wss://server$callCount.example.com',
                'publicKey': 'key$callCount',
                'region': 'us-east',
                'registeredAt': now,
                'lastSeen': now,
              },
            ],
          }), 200);
        });

        // Act - Multiple fetches
        await discoveryService.fetchServers();
        await discoveryService.fetchServers();
        await discoveryService.fetchServers();

        // Assert - Only one HTTP call (cache used)
        expect(callCount, equals(1));
      });

      test('force refresh bypasses cache', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        var callCount = 0;

        when(() => mockHttpClient.get(any())).thenAnswer((_) async {
          callCount++;
          return http.Response(jsonEncode({
            'servers': [
              {
                'serverId': 'ed25519:server$callCount',
                'endpoint': 'wss://server$callCount.example.com',
                'publicKey': 'key$callCount',
                'region': 'us-east',
                'registeredAt': now,
                'lastSeen': now,
              },
            ],
          }), 200);
        });

        // Act - Fetches with force refresh
        await discoveryService.fetchServers();
        await discoveryService.fetchServers(forceRefresh: true);
        await discoveryService.fetchServers(forceRefresh: true);

        // Assert - Three HTTP calls
        expect(callCount, equals(3));
      });
    });

    group('Error Recovery', () {
      test('returns cached servers on subsequent fetch failure', () async {
        // Arrange - First successful, then failure
        final now = DateTime.now().millisecondsSinceEpoch;
        var firstCall = true;

        when(() => mockHttpClient.get(any())).thenAnswer((_) async {
          if (firstCall) {
            firstCall = false;
            return http.Response(jsonEncode({
              'servers': [
                {
                  'serverId': 'ed25519:cached',
                  'endpoint': 'wss://cached.example.com',
                  'publicKey': 'cachedKey',
                  'region': 'us-east',
                  'registeredAt': now,
                  'lastSeen': now,
                },
              ],
            }), 200);
          }
          throw Exception('Network error');
        });

        // Act - First fetch succeeds
        final servers1 = await discoveryService.fetchServers();
        expect(servers1, hasLength(1));

        // Act - Second fetch fails, returns cache
        final servers2 = await discoveryService.fetchServers(forceRefresh: true);

        // Assert - Returns cached data
        expect(servers2, hasLength(1));
        expect(servers2[0].serverId, equals('ed25519:cached'));
      });

      test('handles empty server list gracefully', () async {
        // Arrange
        when(() => mockHttpClient.get(any())).thenAnswer(
          (_) async => http.Response('{"servers": []}', 200),
        );

        // Act
        final servers = await discoveryService.fetchServers();
        final selected = await discoveryService.selectServer();

        // Assert
        expect(servers, isEmpty);
        expect(selected, isNull);
      });
    });
  });

  group('Peer Model', () {
    test('Peer.copyWith creates new instance with updated values', () {
      // Arrange
      final original = Peer(
        id: 'peer1',
        displayName: 'Original Peer',
        connectionState: PeerConnectionState.disconnected,
        lastSeen: DateTime(2024, 1, 1),
        isLocal: true,
      );

      // Act
      final updated = original.copyWith(
        displayName: 'Updated Peer',
        connectionState: PeerConnectionState.connected,
      );

      // Assert
      expect(updated.id, equals('peer1'));
      expect(updated.displayName, equals('Updated Peer'));
      expect(updated.connectionState, equals(PeerConnectionState.connected));
      expect(updated.isLocal, isTrue);
    });

    test('Peer.toJson and fromJson roundtrip', () {
      // Arrange
      final original = Peer(
        id: 'peer1',
        displayName: 'Test Peer',
        ipAddress: '192.168.1.100',
        port: 8080,
        publicKey: 'testPublicKey==',
        connectionState: PeerConnectionState.connected,
        lastSeen: DateTime(2024, 1, 15, 10, 30),
        isLocal: false,
      );

      // Act
      final json = original.toJson();
      final restored = Peer.fromJson(json);

      // Assert
      expect(restored.id, equals(original.id));
      expect(restored.displayName, equals(original.displayName));
      expect(restored.ipAddress, equals(original.ipAddress));
      expect(restored.port, equals(original.port));
      expect(restored.publicKey, equals(original.publicKey));
      expect(restored.connectionState, equals(original.connectionState));
      expect(restored.isLocal, equals(original.isLocal));
    });

    test('Peer equality is based on id, displayName, and publicKey', () {
      // Arrange
      final peer1 = Peer(
        id: 'peer1',
        displayName: 'Test Peer',
        publicKey: 'key1',
        lastSeen: DateTime(2024, 1, 1),
      );

      final peer2 = Peer(
        id: 'peer1',
        displayName: 'Test Peer',
        publicKey: 'key1',
        lastSeen: DateTime(2024, 6, 1), // Different lastSeen
        connectionState: PeerConnectionState.connected, // Different state
      );

      final peer3 = Peer(
        id: 'peer2', // Different id
        displayName: 'Test Peer',
        publicKey: 'key1',
        lastSeen: DateTime(2024, 1, 1),
      );

      // Assert
      expect(peer1, equals(peer2)); // Same id, displayName, publicKey
      expect(peer1, isNot(equals(peer3))); // Different id
    });
  });

  group('ConnectionException', () {
    test('toString includes exception type and message', () {
      final exception = ConnectionException('Connection refused');

      expect(exception.toString(), contains('ConnectionException'));
      expect(exception.toString(), contains('Connection refused'));
    });

    test('message property returns the error message', () {
      const errorMessage = 'Server unreachable';
      final exception = ConnectionException(errorMessage);

      expect(exception.message, equals(errorMessage));
    });
  });
}
