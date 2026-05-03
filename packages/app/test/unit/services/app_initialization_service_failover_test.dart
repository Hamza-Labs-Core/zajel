import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/server_discovery_service.dart';
import 'package:zajel/core/services/app_initialization_service.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

DiscoveredServer _server(String endpoint) => DiscoveredServer(
      serverId: 'ed25519:$endpoint',
      endpoint: endpoint,
      publicKey: 'pk-$endpoint',
      region: 'test',
      registeredAt: 0,
      lastSeen: 0,
    );

/// Tests that `connectSignaling` attempts every candidate server before
/// giving up, and records failed endpoints so other connection sites skip
/// them. A single random pick from the candidate pool is insufficient:
/// with N candidates of which K are dead, the probability of the first pick
/// being dead is K/N, and a 3-second backoff plus a 10-second connect
/// timeout per dead pick burns the test's 30-second window long before
/// the app happens to land on a live server.
void main() {
  group('AppInitializationService failover', () {
    late List<String> displayStates;
    late String? connectedVia;
    late List<String> failureRecords;
    late DiscoveredServer? selectedServer;

    late AppInitializationService service;

    AppInitializationService buildService({
      required Future<List<DiscoveredServer>> Function() selectCandidates,
      required Future<SignalingConnectResult> Function(String url) connect,
    }) {
      return AppInitializationService(
        initializeSecureStorage: () async {},
        initializeCrypto: () async {},
        initializeMessageStorage: () async {},
        initializeChannelStorage: () async {},
        initializeGroupStorage: () async {},
        getAllTrustedPeers: () async => <TrustedPeer>[],
        setPeerAliases: (_) {},
        initializeConnectionManager: () async {},
        initializeDeviceLinkService: () async {},
        initializeNotifications: () async {},
        requestNotificationPermission: () async {},
        connectToSignaling: connect,
        selectServerCandidates: selectCandidates,
        getWebSocketUrl: (s) => 'wss://${s.endpoint}/ws',
        recordConnectionFailure: (endpoint) => failureRecords.add(endpoint),
        reconnectTrustedPeers: () async {},
        setPairingCode: (_) {},
        setSignalingClient: (_) {},
        setSignalingConnected: (_) {},
        setSelectedServer: (s) => selectedServer = s,
        setDisplayStateConnecting: () => displayStates.add('connecting'),
        setDisplayStateConnected: () => displayStates.add('connected'),
        setDisplayStateDisconnected: () => displayStates.add('disconnected'),
        getConnectionStateStream: () => null,
      );
    }

    setUp(() {
      displayStates = [];
      connectedVia = null;
      failureRecords = [];
      selectedServer = null;
    });

    test('iterates candidates until one succeeds', () async {
      final candidates = [
        _server('dead-a.example.com'),
        _server('dead-b.example.com'),
        _server('live.example.com'),
      ];

      service = buildService(
        selectCandidates: () async => candidates,
        connect: (url) async {
          if (url.contains('dead-')) {
            throw Exception('connect refused');
          }
          connectedVia = url;
          return SignalingConnectResult(
            pairingCode: 'ABC123',
            signalingClient: 'mock-client',
          );
        },
      );

      await service.connectSignaling();

      expect(connectedVia, 'wss://live.example.com/ws');
      expect(displayStates, contains('connected'));
      expect(displayStates, isNot(contains('disconnected')));
    });

    test('records each failed endpoint in the skip list', () async {
      final candidates = [
        _server('dead-a.example.com'),
        _server('dead-b.example.com'),
        _server('live.example.com'),
      ];

      service = buildService(
        selectCandidates: () async => candidates,
        connect: (url) async {
          if (url.contains('dead-')) {
            throw Exception('connect refused');
          }
          return SignalingConnectResult(
            pairingCode: 'ABC123',
            signalingClient: 'mock-client',
          );
        },
      );

      await service.connectSignaling();

      expect(
          failureRecords,
          [
            'dead-a.example.com',
            'dead-b.example.com',
          ],
          reason: 'both dead endpoints must be skipped for next call');
    });

    test('sets the selected server to the one that actually connected',
        () async {
      final candidates = [
        _server('dead.example.com'),
        _server('live.example.com'),
      ];

      service = buildService(
        selectCandidates: () async => candidates,
        connect: (url) async {
          if (url.contains('dead')) {
            throw Exception('connect refused');
          }
          return SignalingConnectResult(
            pairingCode: 'CODE',
            signalingClient: 'mock-client',
          );
        },
      );

      await service.connectSignaling();

      expect(selectedServer?.endpoint, 'live.example.com');
    });

    test('when all candidates fail, sets disconnected and records all',
        () async {
      final candidates = [
        _server('dead-a.example.com'),
        _server('dead-b.example.com'),
      ];

      service = buildService(
        selectCandidates: () async => candidates,
        connect: (_) async => throw Exception('connect refused'),
      );

      await service.connectSignaling();

      expect(displayStates.last, 'disconnected');
      expect(failureRecords, [
        'dead-a.example.com',
        'dead-b.example.com',
      ]);
    });

    test('when no candidates are available, sets disconnected', () async {
      service = buildService(
        selectCandidates: () async => <DiscoveredServer>[],
        connect: (_) async => throw StateError('should not be called'),
      );

      await service.connectSignaling();

      expect(displayStates, contains('disconnected'));
      expect(failureRecords, isEmpty);
    });

    test('single live candidate connects without failover loop overhead',
        () async {
      final candidates = [_server('only.example.com')];

      service = buildService(
        selectCandidates: () async => candidates,
        connect: (url) async => SignalingConnectResult(
          pairingCode: 'OK',
          signalingClient: 'mock-client',
        ),
      );

      await service.connectSignaling();

      expect(displayStates, contains('connected'));
      expect(failureRecords, isEmpty);
    });

    test('a candidate that hangs does not block the entire failover loop',
        () async {
      // Simulates a dead endpoint whose DNS/TCP connect hangs for longer
      // than the test's 60s app-ready wait. Without a per-attempt timeout,
      // the failover loop gets stuck and never reaches the live server.
      final candidates = [
        _server('hangs.example.com'),
        _server('live.example.com'),
      ];

      service = buildService(
        selectCandidates: () async => candidates,
        connect: (url) async {
          if (url.contains('hangs')) {
            // Never completes — mimics a WebSocket handshake against a
            // host that accepts TCP but never responds.
            await Future<void>.delayed(const Duration(seconds: 120));
            throw StateError('unreachable');
          }
          return SignalingConnectResult(
            pairingCode: 'LIVE',
            signalingClient: 'mock-client',
          );
        },
      );

      // Bounded by the per-attempt timeout in connectSignaling (expected
      // to be well under the 30-second fail-safe used here). If the loop
      // has no timeout, this test times out.
      await service.connectSignaling().timeout(const Duration(seconds: 30));

      expect(displayStates, contains('connected'));
      expect(failureRecords, contains('hangs.example.com'));
    });
  });
}
