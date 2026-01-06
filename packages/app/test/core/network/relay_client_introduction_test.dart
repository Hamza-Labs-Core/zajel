import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/network/relay_client.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/core/network/signaling_client.dart';

// Mock classes
class MockWebRTCService extends Mock implements WebRTCService {}

class MockSignalingClient extends Mock implements SignalingClient {}

void main() {
  group('RelayClient Introduction Protocol', () {
    late RelayClient client;
    late MockWebRTCService mockWebRTC;
    late MockSignalingClient mockSignaling;
    late List<(String, String)> sentMessages;

    setUp(() {
      mockWebRTC = MockWebRTCService();
      mockSignaling = MockSignalingClient();
      sentMessages = [];

      when(() => mockWebRTC.onMessage).thenReturn(null);
      when(() => mockWebRTC.onConnectionStateChange).thenReturn(null);
      when(() => mockWebRTC.onSignalingMessage).thenReturn(null);
      when(() => mockWebRTC.closeConnection(any())).thenAnswer((_) async {});
      when(() => mockSignaling.isConnected).thenReturn(true);

      // Track sent messages
      when(() => mockWebRTC.sendMessage(any(), any())).thenAnswer((invocation) {
        final peerId = invocation.positionalArguments[0] as String;
        final message = invocation.positionalArguments[1] as String;
        sentMessages.add((peerId, message));
        return Future.value();
      });

      client = RelayClient(
        webrtcService: mockWebRTC,
        signalingClient: mockSignaling,
        maxRelayConnections: 10,
      );
    });

    tearDown(() {
      client.dispose();
    });

    group('sendIntroduction', () {
      test('should send introduction request to relay', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});

        await client.connectToRelays([relay]);
        sentMessages.clear();

        await client.sendIntroduction(
          relayId: 'relay1',
          targetSourceId: 'target_source_123',
          encryptedPayload: 'encrypted_connection_info',
        );

        expect(sentMessages.length, equals(1));
        expect(sentMessages[0].$1, equals('relay1'));

        final msg = jsonDecode(sentMessages[0].$2) as Map<String, dynamic>;
        expect(msg['type'], equals('introduction_request'));
        expect(msg['targetSourceId'], equals('target_source_123'));
        expect(msg['payload'], equals('encrypted_connection_info'));
        expect(msg['fromSourceId'], equals(client.mySourceId));
      });

      test('should throw if not connected to relay', () async {
        expect(
          () => client.sendIntroduction(
            relayId: 'unknown_relay',
            targetSourceId: 'target',
            encryptedPayload: 'payload',
          ),
          throwsA(isA<RelayNotConnectedException>()),
        );
      });

      test('should include timestamp in introduction request', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});

        await client.connectToRelays([relay]);
        sentMessages.clear();

        final beforeTime = DateTime.now().millisecondsSinceEpoch;
        await client.sendIntroduction(
          relayId: 'relay1',
          targetSourceId: 'target_source_123',
          encryptedPayload: 'payload',
        );
        final afterTime = DateTime.now().millisecondsSinceEpoch;

        final msg = jsonDecode(sentMessages[0].$2) as Map<String, dynamic>;
        final timestamp = msg['timestamp'] as int;
        expect(timestamp, greaterThanOrEqualTo(beforeTime));
        expect(timestamp, lessThanOrEqualTo(afterTime));
      });
    });

    group('handleIntroductionRequest (as relay)', () {
      test('should forward to connected target', () async {
        // Set up two connections (we're acting as relay)
        final alice = RelayInfo(peerId: 'alice', publicKey: 'pk_alice');
        final bob = RelayInfo(peerId: 'bob', publicKey: 'pk_bob');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});

        await client.connectToRelays([alice, bob]);

        // Register alice's source ID
        client.registerSourceId('alice', 'alice_source_123');

        sentMessages.clear();

        // Bob sends introduction for alice
        final request = IntroductionRequest(
          fromSourceId: 'bob_source_456',
          targetSourceId: 'alice_source_123',
          payload: 'encrypted_for_alice',
          timestamp: DateTime.now().millisecondsSinceEpoch,
        );

        await client.handleIntroductionRequest('bob', request);

        // Should forward to alice
        expect(sentMessages.any((m) => m.$1 == 'alice'), isTrue);
        final forwardMsg = sentMessages.firstWhere((m) => m.$1 == 'alice');
        final msg = jsonDecode(forwardMsg.$2) as Map<String, dynamic>;
        expect(msg['type'], equals('introduction_forward'));
        expect(msg['fromSourceId'], equals('bob_source_456'));
        expect(msg['payload'], equals('encrypted_for_alice'));
      });

      test('should respond with error if target not found', () async {
        final bob = RelayInfo(peerId: 'bob', publicKey: 'pk_bob');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});

        await client.connectToRelays([bob]);
        sentMessages.clear();

        final request = IntroductionRequest(
          fromSourceId: 'bob_source_456',
          targetSourceId: 'unknown_source',
          payload: 'encrypted',
          timestamp: DateTime.now().millisecondsSinceEpoch,
        );

        await client.handleIntroductionRequest('bob', request);

        // Should send error back to bob
        expect(sentMessages.any((m) => m.$1 == 'bob'), isTrue);
        final errorMsg = sentMessages.firstWhere((m) => m.$1 == 'bob');
        final msg = jsonDecode(errorMsg.$2) as Map<String, dynamic>;
        expect(msg['type'], equals('introduction_error'));
        expect(msg['error'], equals('target_not_found'));
      });

      test('should respond with error if target is disconnected', () async {
        final bob = RelayInfo(peerId: 'bob', publicKey: 'pk_bob');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});
        when(() => mockWebRTC.closeConnection(any()))
            .thenAnswer((_) async {});

        await client.connectToRelays([bob]);

        // Register alice then disconnect her
        client.registerSourceId('alice', 'alice_source_123');
        // We don't have alice connected as peer, just registered source ID
        // This simulates the case where we know about alice but she's not connected

        sentMessages.clear();

        final request = IntroductionRequest(
          fromSourceId: 'bob_source_456',
          targetSourceId: 'alice_source_123',
          payload: 'encrypted',
          timestamp: DateTime.now().millisecondsSinceEpoch,
        );

        await client.handleIntroductionRequest('bob', request);

        // Should send error since alice is not connected as a relay peer
        expect(sentMessages.any((m) => m.$1 == 'bob'), isTrue);
        final errorMsg = sentMessages.firstWhere((m) => m.$1 == 'bob');
        final msg = jsonDecode(errorMsg.$2) as Map<String, dynamic>;
        expect(msg['type'], equals('introduction_error'));
      });
    });

    group('handleIntroductionResponse', () {
      test('should emit event when receiving introduction', () async {
        final events = <IntroductionEvent>[];
        client.onIntroduction.listen(events.add);

        final response = IntroductionResponse(
          fromSourceId: 'alice_source_123',
          payload: 'encrypted_alice_info',
        );

        await client.handleIntroductionResponse('relay1', response);

        await Future.delayed(Duration(milliseconds: 10));

        expect(events, hasLength(1));
        expect(events[0].fromSourceId, equals('alice_source_123'));
        expect(events[0].payload, equals('encrypted_alice_info'));
        expect(events[0].relayId, equals('relay1'));
      });

      test('should handle multiple introduction events', () async {
        final events = <IntroductionEvent>[];
        client.onIntroduction.listen(events.add);

        await client.handleIntroductionResponse(
          'relay1',
          IntroductionResponse(
              fromSourceId: 'alice_123', payload: 'payload_alice'),
        );

        await client.handleIntroductionResponse(
          'relay2',
          IntroductionResponse(fromSourceId: 'bob_456', payload: 'payload_bob'),
        );

        await Future.delayed(Duration(milliseconds: 10));

        expect(events, hasLength(2));
        expect(events[0].fromSourceId, equals('alice_123'));
        expect(events[1].fromSourceId, equals('bob_456'));
      });
    });

    group('handleIntroductionError', () {
      test('should emit error event when receiving introduction error',
          () async {
        final errors = <IntroductionErrorEvent>[];
        client.onIntroductionError.listen(errors.add);

        await client.handleIntroductionError(
          'relay1',
          IntroductionError(
            targetSourceId: 'target_123',
            error: 'target_not_found',
          ),
        );

        await Future.delayed(Duration(milliseconds: 10));

        expect(errors, hasLength(1));
        expect(errors[0].targetSourceId, equals('target_123'));
        expect(errors[0].error, equals('target_not_found'));
        expect(errors[0].relayId, equals('relay1'));
      });
    });

    group('message routing', () {
      test('should process relay messages received via WebRTC', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');
        final events = <IntroductionEvent>[];

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});

        client.onIntroduction.listen(events.add);
        await client.connectToRelays([relay]);

        // Simulate receiving an introduction_forward message
        final forwardMessage = jsonEncode({
          'type': 'introduction_forward',
          'fromSourceId': 'alice_source_123',
          'payload': 'encrypted_data',
        });

        client.handleRelayMessage('relay1', forwardMessage);

        await Future.delayed(Duration(milliseconds: 10));

        expect(events, hasLength(1));
        expect(events[0].fromSourceId, equals('alice_source_123'));
      });

      test('should handle relay_handshake message', () async {
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');

        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});

        await client.connectToRelays([relay]);

        // Simulate receiving a handshake from relay1
        final handshakeMessage = jsonEncode({
          'type': 'relay_handshake',
          'sourceId': 'relay1_source_xyz',
        });

        client.handleRelayMessage('relay1', handshakeMessage);

        expect(client.getSourceId('relay1'), equals('relay1_source_xyz'));
        expect(
            client.getPeerIdBySourceId('relay1_source_xyz'), equals('relay1'));
      });
    });
  });
}
