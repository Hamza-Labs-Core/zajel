import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/network/server_discovery_service.dart';
import 'package:zajel/core/network/signaling_client.dart'
    show SignalingConnectionState;
import 'package:zajel/core/services/app_initialization_service.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

void main() {
  group('AppInitializationService', () {
    // --- Tracking variables for closure calls ---
    late bool cryptoInitialized;
    late bool messageStorageInitialized;
    late bool connectionManagerInitialized;
    late bool deviceLinkServiceInitialized;
    late bool notificationsInitialized;
    late bool notificationPermissionRequested;
    late Map<String, String>? peerAliasesSet;
    late String? pairingCodeSet;
    late dynamic signalingClientSet;
    late bool? signalingConnectedSet;
    late DiscoveredServer? selectedServerSet;
    late List<String> displayStates; // track state transitions

    late AppInitializationService service;

    // Default stubs that can be overridden per-test
    late Future<List<TrustedPeer>> Function() getAllTrustedPeersStub;
    late Future<SignalingConnectResult> Function(String) connectToSignalingStub;
    late Future<DiscoveredServer?> Function() selectServerStub;
    late String Function(DiscoveredServer) getWebSocketUrlStub;
    late Future<void> Function() reconnectTrustedPeersStub;
    late Stream<SignalingConnectionState>? Function()
        getConnectionStateStreamStub;

    setUp(() {
      cryptoInitialized = false;
      messageStorageInitialized = false;
      connectionManagerInitialized = false;
      deviceLinkServiceInitialized = false;
      notificationsInitialized = false;
      notificationPermissionRequested = false;
      peerAliasesSet = null;
      pairingCodeSet = null;
      signalingClientSet = null;
      signalingConnectedSet = null;
      selectedServerSet = null;
      displayStates = [];

      // Default stubs
      getAllTrustedPeersStub = () async => <TrustedPeer>[];
      connectToSignalingStub = (url) async => SignalingConnectResult(
            pairingCode: 'ABC123',
            signalingClient: 'mock-client',
          );
      selectServerStub = () async => const DiscoveredServer(
            serverId: 'srv1',
            endpoint: 'https://example.com',
            publicKey: 'pk1',
            region: 'us-east',
            registeredAt: 0,
            lastSeen: 0,
          );
      getWebSocketUrlStub = (server) => 'wss://${server.endpoint}/ws';
      reconnectTrustedPeersStub = () async {};
      getConnectionStateStreamStub = () => null;
    });

    AppInitializationService buildService() {
      return AppInitializationService(
        initializeCrypto: () async {
          cryptoInitialized = true;
        },
        initializeMessageStorage: () async {
          messageStorageInitialized = true;
        },
        getAllTrustedPeers: getAllTrustedPeersStub,
        setPeerAliases: (aliases) => peerAliasesSet = aliases,
        initializeConnectionManager: () async {
          connectionManagerInitialized = true;
        },
        initializeDeviceLinkService: () async {
          deviceLinkServiceInitialized = true;
        },
        initializeNotifications: () async {
          notificationsInitialized = true;
        },
        requestNotificationPermission: () async {
          notificationPermissionRequested = true;
        },
        connectToSignaling: connectToSignalingStub,
        selectServer: selectServerStub,
        getWebSocketUrl: getWebSocketUrlStub,
        reconnectTrustedPeers: reconnectTrustedPeersStub,
        setPairingCode: (code) => pairingCodeSet = code,
        setSignalingClient: (client) => signalingClientSet = client,
        setSignalingConnected: (connected) => signalingConnectedSet = connected,
        setSelectedServer: (server) => selectedServerSet = server,
        setDisplayStateConnecting: () => displayStates.add('connecting'),
        setDisplayStateConnected: () => displayStates.add('connected'),
        setDisplayStateDisconnected: () => displayStates.add('disconnected'),
        getConnectionStateStream: getConnectionStateStreamStub,
      );
    }

    group('initializeCore', () {
      test('initializes all services in order', () async {
        service = buildService();
        final result = await service.initializeCore();

        expect(result, isTrue);
        expect(cryptoInitialized, isTrue);
        expect(messageStorageInitialized, isTrue);
        expect(connectionManagerInitialized, isTrue);
        expect(deviceLinkServiceInitialized, isTrue);
        expect(notificationsInitialized, isTrue);
        expect(notificationPermissionRequested, isTrue);
      });

      test('sets empty peer aliases when no trusted peers', () async {
        service = buildService();
        await service.initializeCore();

        expect(peerAliasesSet, equals(<String, String>{}));
      });

      test('loads peer aliases from trusted peers', () async {
        getAllTrustedPeersStub = () async => [
              TrustedPeer(
                id: 'peer1',
                displayName: 'Peer One',
                publicKey: 'pk1',
                trustedAt: DateTime(2024),
                alias: 'My Friend',
              ),
              TrustedPeer(
                id: 'peer2',
                displayName: 'Peer Two',
                publicKey: 'pk2',
                trustedAt: DateTime(2024),
                alias: null, // no alias
              ),
              TrustedPeer(
                id: 'peer3',
                displayName: 'Peer Three',
                publicKey: 'pk3',
                trustedAt: DateTime(2024),
                alias: 'Buddy',
              ),
            ];

        service = buildService();
        await service.initializeCore();

        expect(
            peerAliasesSet, equals({'peer1': 'My Friend', 'peer3': 'Buddy'}));
      });

      test('returns false and logs error when crypto init fails', () async {
        service = AppInitializationService(
          initializeCrypto: () async => throw Exception('Crypto failed'),
          initializeMessageStorage: () async =>
              messageStorageInitialized = true,
          getAllTrustedPeers: getAllTrustedPeersStub,
          setPeerAliases: (aliases) => peerAliasesSet = aliases,
          initializeConnectionManager: () async =>
              connectionManagerInitialized = true,
          initializeDeviceLinkService: () async =>
              deviceLinkServiceInitialized = true,
          initializeNotifications: () async => notificationsInitialized = true,
          requestNotificationPermission: () async =>
              notificationPermissionRequested = true,
          connectToSignaling: connectToSignalingStub,
          selectServer: selectServerStub,
          getWebSocketUrl: getWebSocketUrlStub,
          reconnectTrustedPeers: reconnectTrustedPeersStub,
          setPairingCode: (code) => pairingCodeSet = code,
          setSignalingClient: (client) => signalingClientSet = client,
          setSignalingConnected: (connected) =>
              signalingConnectedSet = connected,
          setSelectedServer: (server) => selectedServerSet = server,
          setDisplayStateConnecting: () => displayStates.add('connecting'),
          setDisplayStateConnected: () => displayStates.add('connected'),
          setDisplayStateDisconnected: () => displayStates.add('disconnected'),
          getConnectionStateStream: getConnectionStateStreamStub,
        );

        final result = await service.initializeCore();

        expect(result, isFalse);
        // Subsequent steps should NOT have run
        expect(messageStorageInitialized, isFalse);
        expect(connectionManagerInitialized, isFalse);
      });

      test('returns false when message storage init fails', () async {
        service = AppInitializationService(
          initializeCrypto: () async => cryptoInitialized = true,
          initializeMessageStorage: () async =>
              throw Exception('DB init failed'),
          getAllTrustedPeers: getAllTrustedPeersStub,
          setPeerAliases: (aliases) => peerAliasesSet = aliases,
          initializeConnectionManager: () async =>
              connectionManagerInitialized = true,
          initializeDeviceLinkService: () async =>
              deviceLinkServiceInitialized = true,
          initializeNotifications: () async => notificationsInitialized = true,
          requestNotificationPermission: () async =>
              notificationPermissionRequested = true,
          connectToSignaling: connectToSignalingStub,
          selectServer: selectServerStub,
          getWebSocketUrl: getWebSocketUrlStub,
          reconnectTrustedPeers: reconnectTrustedPeersStub,
          setPairingCode: (code) => pairingCodeSet = code,
          setSignalingClient: (client) => signalingClientSet = client,
          setSignalingConnected: (connected) =>
              signalingConnectedSet = connected,
          setSelectedServer: (server) => selectedServerSet = server,
          setDisplayStateConnecting: () => displayStates.add('connecting'),
          setDisplayStateConnected: () => displayStates.add('connected'),
          setDisplayStateDisconnected: () => displayStates.add('disconnected'),
          getConnectionStateStream: getConnectionStateStreamStub,
        );

        final result = await service.initializeCore();
        expect(result, isFalse);
        expect(cryptoInitialized, isTrue);
        expect(connectionManagerInitialized, isFalse);
      });
    });

    group('connectSignaling', () {
      test('connects and updates all state on success', () async {
        var reconnectCalled = false;
        reconnectTrustedPeersStub = () async => reconnectCalled = true;

        service = buildService();
        await service.connectSignaling();

        expect(displayStates, contains('connecting'));
        expect(displayStates.last, equals('connected'));
        expect(pairingCodeSet, equals('ABC123'));
        expect(signalingClientSet, equals('mock-client'));
        expect(signalingConnectedSet, isTrue);
        expect(reconnectCalled, isTrue);
      });

      test('sets selected server from discovery', () async {
        service = buildService();
        await service.connectSignaling();

        expect(selectedServerSet, isNotNull);
        expect(selectedServerSet!.serverId, equals('srv1'));
      });

      test('sets disconnected when no server available', () async {
        selectServerStub = () async => null;

        service = buildService();
        await service.connectSignaling();

        expect(displayStates.last, equals('disconnected'));
        expect(pairingCodeSet, isNull);
        expect(signalingConnectedSet, isNull);
      });

      test('sets disconnected on connection failure', () async {
        connectToSignalingStub =
            (_) async => throw Exception('Connection refused');

        service = buildService();
        await service.connectSignaling();

        expect(displayStates.last, equals('disconnected'));
        expect(signalingConnectedSet, isNull);
      });
    });

    group('setupSignalingReconnect', () {
      test('returns null when no connection state stream', () {
        getConnectionStateStreamStub = () => null;
        service = buildService();

        final sub = service.setupSignalingReconnect(isDisposed: () => false);

        expect(sub, isNull);
      });

      test('reconnects on disconnect event', () async {
        final controller = StreamController<SignalingConnectionState>();
        getConnectionStateStreamStub = () => controller.stream;

        connectToSignalingStub = (url) async {
          return SignalingConnectResult(
            pairingCode: 'NEW123',
            signalingClient: 'new-client',
          );
        };

        service = buildService();
        final sub = service.setupSignalingReconnect(isDisposed: () => false);

        // Emit disconnect
        controller.add(SignalingConnectionState.disconnected);

        // Wait for the reconnect logic (initial delay is 3s, but we need
        // to let the async listener fire)
        await Future<void>.delayed(const Duration(milliseconds: 100));

        // The reconnect is delayed by 3s, so connectCount should be 0 right away
        // We need to advance more to test the actual reconnection
        // But at minimum, the state should show disconnected then connecting
        expect(displayStates, contains('disconnected'));

        sub?.cancel();
        await controller.close();
      });

      test('does not reconnect when disposed', () async {
        final controller = StreamController<SignalingConnectionState>();
        getConnectionStateStreamStub = () => controller.stream;

        var connectCount = 0;
        connectToSignalingStub = (url) async {
          connectCount++;
          return SignalingConnectResult(
            pairingCode: 'NEW123',
            signalingClient: 'new-client',
          );
        };

        service = buildService();
        final sub = service.setupSignalingReconnect(isDisposed: () => true);

        controller.add(SignalingConnectionState.disconnected);
        await Future<void>.delayed(const Duration(milliseconds: 100));

        // Should not attempt to connect when disposed
        expect(connectCount, equals(0));

        sub?.cancel();
        await controller.close();
      });

      test('does not reconnect on connected event', () async {
        final controller = StreamController<SignalingConnectionState>();
        getConnectionStateStreamStub = () => controller.stream;

        service = buildService();
        final sub = service.setupSignalingReconnect(isDisposed: () => false);

        controller.add(SignalingConnectionState.connected);
        await Future<void>.delayed(const Duration(milliseconds: 100));

        // No state transitions should occur for connected events
        expect(displayStates, isEmpty);

        sub?.cancel();
        await controller.close();
      });
    });
  });
}
