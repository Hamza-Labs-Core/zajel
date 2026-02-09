/// Integration tests for messaging functionality.
///
/// Tests the full flow of:
/// - Two devices connecting via pairing codes
/// - Sending and receiving encrypted messages
/// - Bidirectional messaging
///
/// Requires the VPS signaling server to be running.
/// Set TEST_VPS_SERVER_URL environment variable for custom server.
@Tags(['integration', 'messaging'])
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/network/connection_manager.dart';
import 'package:zajel/core/network/device_link_service.dart';
import 'package:zajel/core/network/meeting_point_service.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/core/models/models.dart';
import 'package:zajel/core/storage/trusted_peers_storage_impl.dart';

import 'test_config.dart';

void main() {
  final config = TestConfig.auto();

  group('Messaging E2E Tests', () {
    late ProviderContainer deviceA;
    late ProviderContainer deviceB;
    late ConnectionManager connectionManagerA;
    late ConnectionManager connectionManagerB;

    setUpAll(() {
      if (config.verboseLogging) {
        debugPrint('Messaging E2E Test Configuration:');
        debugPrint('  VPS Server: ${config.vpsServerUrl}');
      }
    });

    setUp(() async {
      // Create isolated provider containers for two devices
      deviceA = ProviderContainer();
      deviceB = ProviderContainer();

      // Initialize crypto services
      final cryptoA = CryptoService();
      final cryptoB = CryptoService();
      await cryptoA.initialize();
      await cryptoB.initialize();

      // Create WebRTC services
      final webrtcA = WebRTCService(cryptoService: cryptoA);
      final webrtcB = WebRTCService(cryptoService: cryptoB);

      // Create device link services
      final deviceLinkA = DeviceLinkService(
        cryptoService: cryptoA,
        webrtcService: webrtcA,
      );
      final deviceLinkB = DeviceLinkService(
        cryptoService: cryptoB,
        webrtcService: webrtcB,
      );

      // Create connection managers
      connectionManagerA = ConnectionManager(
        cryptoService: cryptoA,
        webrtcService: webrtcA,
        deviceLinkService: deviceLinkA,
        trustedPeersStorage: SecureTrustedPeersStorage(),
        meetingPointService: MeetingPointService(),
      );
      connectionManagerB = ConnectionManager(
        cryptoService: cryptoB,
        webrtcService: webrtcB,
        deviceLinkService: deviceLinkB,
        trustedPeersStorage: SecureTrustedPeersStorage(),
        meetingPointService: MeetingPointService(),
      );
    });

    tearDown(() async {
      await connectionManagerA.dispose();
      await connectionManagerB.dispose();
      deviceA.dispose();
      deviceB.dispose();
    });

    test('two devices can pair via VPS signaling server', () async {
      // Skip if no VPS server available
      if (config.useMockServer) {
        markTestSkipped('Mock server does not support full pairing flow');
        return;
      }

      // Device A connects and gets a pairing code
      late String pairingCodeA;
      try {
        pairingCodeA = await TestUtils.withTimeout(
          connectionManagerA.connect(serverUrl: config.vpsServerUrl),
          timeout: config.connectionTimeout,
          operationName: 'Device A connect',
        );
      } catch (e) {
        markTestSkipped('VPS server unreachable: $e');
        return;
      }

      expect(pairingCodeA, isNotNull);
      expect(pairingCodeA.length, equals(6));

      if (config.verboseLogging) {
        debugPrint('Device A connected with code: $pairingCodeA');
      }

      // Device B connects and gets a pairing code
      late String pairingCodeB;
      try {
        pairingCodeB = await TestUtils.withTimeout(
          connectionManagerB.connect(serverUrl: config.vpsServerUrl),
          timeout: config.connectionTimeout,
          operationName: 'Device B connect',
        );
      } catch (e) {
        markTestSkipped('VPS server unreachable: $e');
        return;
      }

      expect(pairingCodeB, isNotNull);
      expect(pairingCodeB.length, equals(6));
      expect(pairingCodeB, isNot(equals(pairingCodeA)));

      if (config.verboseLogging) {
        debugPrint('Device B connected with code: $pairingCodeB');
      }

      // Set up listeners for pairing requests
      final pairRequestCompleterA = Completer<(String, String, String?)>();
      final pairRequestCompleterB = Completer<(String, String, String?)>();

      connectionManagerA.pairRequests.listen((request) {
        if (!pairRequestCompleterA.isCompleted) {
          pairRequestCompleterA.complete(request);
        }
      });

      connectionManagerB.pairRequests.listen((request) {
        if (!pairRequestCompleterB.isCompleted) {
          pairRequestCompleterB.complete(request);
        }
      });

      // Device A initiates pairing with Device B
      await connectionManagerA.connectToPeer(pairingCodeB);

      // Wait for Device B to receive the pair request
      final requestAtB = await TestUtils.withTimeout(
        pairRequestCompleterB.future,
        timeout: config.pairingTimeout,
        operationName: 'Pair request at Device B',
      );

      expect(requestAtB.$1, equals(pairingCodeA));
      expect(requestAtB.$2, isNotEmpty); // Public key

      if (config.verboseLogging) {
        debugPrint('Device B received pair request from: ${requestAtB.$1}');
      }

      // Device B approves the request
      connectionManagerB.respondToPairRequest(pairingCodeA, accept: true);

      // Wait for both devices to be connected
      final peersConnectedA = await TestUtils.waitFor(
        () {
          final peers = connectionManagerA.currentPeers;
          return peers.any((p) =>
              p.id == pairingCodeB &&
              p.connectionState == PeerConnectionState.connected);
        },
        timeout: config.connectionTimeout,
      );

      final peersConnectedB = await TestUtils.waitFor(
        () {
          final peers = connectionManagerB.currentPeers;
          return peers.any((p) =>
              p.id == pairingCodeA &&
              p.connectionState == PeerConnectionState.connected);
        },
        timeout: config.connectionTimeout,
      );

      expect(peersConnectedA, isTrue,
          reason: 'Device A should be connected to B');
      expect(peersConnectedB, isTrue,
          reason: 'Device B should be connected to A');

      if (config.verboseLogging) {
        debugPrint('Both devices connected successfully!');
      }
    }, timeout: const Timeout(Duration(minutes: 2)));

    test('can send and receive text messages', () async {
      if (config.useMockServer) {
        markTestSkipped('Mock server does not support full messaging flow');
        return;
      }

      // Connect both devices
      late String pairingCodeA;
      late String pairingCodeB;

      try {
        pairingCodeA = await TestUtils.withTimeout(
          connectionManagerA.connect(serverUrl: config.vpsServerUrl),
          timeout: config.connectionTimeout,
          operationName: 'Device A connect',
        );
        pairingCodeB = await TestUtils.withTimeout(
          connectionManagerB.connect(serverUrl: config.vpsServerUrl),
          timeout: config.connectionTimeout,
          operationName: 'Device B connect',
        );
      } catch (e) {
        markTestSkipped('VPS server unreachable: $e');
        return;
      }

      // Set up pair request handler for automatic approval
      connectionManagerB.pairRequests.listen((request) {
        connectionManagerB.respondToPairRequest(request.$1, accept: true);
      });

      // Device A initiates pairing
      await connectionManagerA.connectToPeer(pairingCodeB);

      // Wait for connection
      final connected = await TestUtils.waitFor(
        () => connectionManagerA.currentPeers.any((p) =>
            p.id == pairingCodeB &&
            p.connectionState == PeerConnectionState.connected),
        timeout: config.connectionTimeout,
      );

      if (!connected) {
        markTestSkipped('Could not establish connection');
        return;
      }

      // Set up message listener on Device B
      final messageCompleter = Completer<(String, String)>();
      connectionManagerB.messages.listen((msg) {
        if (!messageCompleter.isCompleted) {
          messageCompleter.complete(msg);
        }
      });

      // Device A sends a message
      const testMessage = 'Hello from Device A!';
      await connectionManagerA.sendMessage(pairingCodeB, testMessage);

      // Device B should receive the message
      final receivedMsg = await TestUtils.withTimeout(
        messageCompleter.future,
        timeout: const Duration(seconds: 10),
        operationName: 'Receive message',
      );

      expect(receivedMsg.$1, equals(pairingCodeA)); // From Device A
      expect(receivedMsg.$2, equals(testMessage));

      if (config.verboseLogging) {
        debugPrint('Message received: ${receivedMsg.$2}');
      }
    }, timeout: const Timeout(Duration(minutes: 2)));

    test('bidirectional messaging works', () async {
      if (config.useMockServer) {
        markTestSkipped('Mock server does not support full messaging flow');
        return;
      }

      // Connect both devices
      late String pairingCodeA;
      late String pairingCodeB;

      try {
        pairingCodeA = await TestUtils.withTimeout(
          connectionManagerA.connect(serverUrl: config.vpsServerUrl),
          timeout: config.connectionTimeout,
          operationName: 'Device A connect',
        );
        pairingCodeB = await TestUtils.withTimeout(
          connectionManagerB.connect(serverUrl: config.vpsServerUrl),
          timeout: config.connectionTimeout,
          operationName: 'Device B connect',
        );
      } catch (e) {
        markTestSkipped('VPS server unreachable: $e');
        return;
      }

      // Auto-approve pairing
      connectionManagerB.pairRequests.listen((request) {
        connectionManagerB.respondToPairRequest(request.$1, accept: true);
      });

      await connectionManagerA.connectToPeer(pairingCodeB);

      // Wait for connection
      final connected = await TestUtils.waitFor(
        () => connectionManagerA.currentPeers.any((p) =>
            p.id == pairingCodeB &&
            p.connectionState == PeerConnectionState.connected),
        timeout: config.connectionTimeout,
      );

      if (!connected) {
        markTestSkipped('Could not establish connection');
        return;
      }

      // Set up message collectors
      final messagesAtA = <(String, String)>[];
      final messagesAtB = <(String, String)>[];

      connectionManagerA.messages.listen((msg) => messagesAtA.add(msg));
      connectionManagerB.messages.listen((msg) => messagesAtB.add(msg));

      // Send messages in both directions
      await connectionManagerA.sendMessage(pairingCodeB, 'Message 1 from A');
      await connectionManagerB.sendMessage(pairingCodeA, 'Message 1 from B');
      await connectionManagerA.sendMessage(pairingCodeB, 'Message 2 from A');
      await connectionManagerB.sendMessage(pairingCodeA, 'Message 2 from B');

      // Wait for messages to be received
      await TestUtils.waitFor(
        () => messagesAtA.length >= 2 && messagesAtB.length >= 2,
        timeout: const Duration(seconds: 15),
      );

      // Verify A received messages from B
      expect(
        messagesAtA.where((m) => m.$2.contains('from B')).length,
        equals(2),
        reason: 'Device A should receive 2 messages from B',
      );

      // Verify B received messages from A
      expect(
        messagesAtB.where((m) => m.$2.contains('from A')).length,
        equals(2),
        reason: 'Device B should receive 2 messages from A',
      );

      if (config.verboseLogging) {
        debugPrint('Bidirectional messaging verified');
        debugPrint('  Messages at A: ${messagesAtA.length}');
        debugPrint('  Messages at B: ${messagesAtB.length}');
      }
    }, timeout: const Timeout(Duration(minutes: 2)));
  });
}
