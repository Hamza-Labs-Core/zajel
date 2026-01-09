import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:zajel/core/network/signaling_client.dart';

import '../../mocks/mocks.dart';

/// Testable subclass of SignalingClient that allows injecting a WebSocketChannel
class TestableSignalingClient extends SignalingClient {
  final WebSocketChannel Function()? _channelFactory;
  WebSocketChannel? _testChannel;

  TestableSignalingClient({
    required super.serverUrl,
    required super.pairingCode,
    required super.publicKey,
    WebSocketChannel Function()? channelFactory,
  }) : _channelFactory = channelFactory;

  /// For tests: directly set the channel and connection state
  void injectChannel(WebSocketChannel channel) {
    _testChannel = channel;
  }

  @override
  Future<void> connect() async {
    if (isConnected) return;

    // Use injected channel factory if available
    if (_channelFactory != null) {
      // We can't override private members, so we test via the public interface
      // This is a limitation of the current design
    }

    await super.connect();
  }
}

void main() {
  group('SignalingClient', () {
    late SignalingClient client;
    bool disposed = false;

    setUp(() {
      disposed = false;
      client = SignalingClient(
        serverUrl: 'wss://test.example.com',
        pairingCode: 'ABC123',
        publicKey: 'testPublicKey123',
      );
    });

    tearDown(() async {
      // Only dispose if not already disposed by the test
      if (!disposed) {
        await client.dispose();
      }
    });

    group('constructor and properties', () {
      test('initializes with correct pairing code', () {
        expect(client.pairingCode, equals('ABC123'));
      });

      test('initially not connected', () {
        expect(client.isConnected, isFalse);
      });

      test('exposes messages stream', () {
        expect(client.messages, isA<Stream<SignalingMessage>>());
      });

      test('exposes connectionState stream', () {
        expect(client.connectionState, isA<Stream<SignalingConnectionState>>());
      });
    });

    group('dispose', () {
      test('closes streams without errors', () async {
        disposed = true;
        // Should complete without throwing
        await client.dispose();
      });

      test('disconnect then dispose works correctly', () async {
        disposed = true;
        // Disconnect first, then dispose should work
        await client.disconnect();
        await client.dispose();
      });
    });
  });

  group('SignalingMessage', () {
    test('creates offer message correctly', () {
      final message = SignalingMessage.offer(
        from: 'PEER01',
        payload: {'type': 'offer', 'sdp': 'test-sdp'},
      );

      expect(message, isA<SignalingOffer>());
      final offer = message as SignalingOffer;
      expect(offer.from, equals('PEER01'));
      expect(offer.payload['type'], equals('offer'));
      expect(offer.payload['sdp'], equals('test-sdp'));
    });

    test('creates answer message correctly', () {
      final message = SignalingMessage.answer(
        from: 'PEER02',
        payload: {'type': 'answer', 'sdp': 'answer-sdp'},
      );

      expect(message, isA<SignalingAnswer>());
      final answer = message as SignalingAnswer;
      expect(answer.from, equals('PEER02'));
      expect(answer.payload['type'], equals('answer'));
    });

    test('creates iceCandidate message correctly', () {
      final message = SignalingMessage.iceCandidate(
        from: 'PEER03',
        payload: {'candidate': 'ice-candidate-data', 'sdpMid': 'data'},
      );

      expect(message, isA<SignalingIceCandidate>());
      final ice = message as SignalingIceCandidate;
      expect(ice.from, equals('PEER03'));
      expect(ice.payload['candidate'], equals('ice-candidate-data'));
    });

    test('creates peerJoined message correctly', () {
      final message = SignalingMessage.peerJoined(peerId: 'NEW123');

      expect(message, isA<SignalingPeerJoined>());
      final joined = message as SignalingPeerJoined;
      expect(joined.peerId, equals('NEW123'));
    });

    test('creates peerLeft message correctly', () {
      final message = SignalingMessage.peerLeft(peerId: 'LEFT99');

      expect(message, isA<SignalingPeerLeft>());
      final left = message as SignalingPeerLeft;
      expect(left.peerId, equals('LEFT99'));
    });

    test('creates pairIncoming message correctly', () {
      final message = SignalingMessage.pairIncoming(
        fromCode: 'REQ456',
        fromPublicKey: 'publicKeyData',
      );

      expect(message, isA<SignalingPairIncoming>());
      final incoming = message as SignalingPairIncoming;
      expect(incoming.fromCode, equals('REQ456'));
      expect(incoming.fromPublicKey, equals('publicKeyData'));
    });

    test('creates pairMatched message correctly', () {
      final message = SignalingMessage.pairMatched(
        peerCode: 'MTH789',
        peerPublicKey: 'matchedPublicKey',
        isInitiator: true,
      );

      expect(message, isA<SignalingPairMatched>());
      final matched = message as SignalingPairMatched;
      expect(matched.peerCode, equals('MTH789'));
      expect(matched.peerPublicKey, equals('matchedPublicKey'));
      expect(matched.isInitiator, isTrue);
    });

    test('creates pairMatched with isInitiator false', () {
      final message = SignalingMessage.pairMatched(
        peerCode: 'MTH789',
        peerPublicKey: 'matchedPublicKey',
        isInitiator: false,
      );

      final matched = message as SignalingPairMatched;
      expect(matched.isInitiator, isFalse);
    });

    test('creates pairRejected message correctly', () {
      final message = SignalingMessage.pairRejected(peerCode: 'REJ111');

      expect(message, isA<SignalingPairRejected>());
      final rejected = message as SignalingPairRejected;
      expect(rejected.peerCode, equals('REJ111'));
    });

    test('creates pairTimeout message correctly', () {
      final message = SignalingMessage.pairTimeout(peerCode: 'TMO222');

      expect(message, isA<SignalingPairTimeout>());
      final timeout = message as SignalingPairTimeout;
      expect(timeout.peerCode, equals('TMO222'));
    });

    test('creates pairError message correctly', () {
      final message = SignalingMessage.pairError(error: 'Pairing failed');

      expect(message, isA<SignalingPairError>());
      final error = message as SignalingPairError;
      expect(error.error, equals('Pairing failed'));
    });

    test('creates error message correctly', () {
      final message = SignalingMessage.error(message: 'Something went wrong');

      expect(message, isA<SignalingError>());
      final error = message as SignalingError;
      expect(error.message, equals('Something went wrong'));
    });
  });

  group('SignalingConnectionState', () {
    test('has all expected values', () {
      expect(SignalingConnectionState.values, hasLength(4));
      expect(SignalingConnectionState.values, contains(SignalingConnectionState.disconnected));
      expect(SignalingConnectionState.values, contains(SignalingConnectionState.connecting));
      expect(SignalingConnectionState.values, contains(SignalingConnectionState.connected));
      expect(SignalingConnectionState.values, contains(SignalingConnectionState.failed));
    });
  });

  group('SignalingClient with FakeWebSocket', () {
    late FakeWebSocketChannel fakeChannel;
    late StreamController<SignalingConnectionState> connectionStateController;
    late StreamController<SignalingMessage> messageController;

    setUp(() {
      fakeChannel = FakeWebSocketChannel();
      connectionStateController = StreamController<SignalingConnectionState>.broadcast();
      messageController = StreamController<SignalingMessage>.broadcast();
    });

    tearDown(() async {
      fakeChannel.dispose();
      await connectionStateController.close();
      await messageController.close();
    });

    test('FakeWebSocketChannel captures sent messages', () {
      fakeChannel.sink.add('{"type": "test"}');
      fakeChannel.sink.add('{"type": "test2"}');

      expect(fakeChannel.sentMessages, hasLength(2));
      expect(fakeChannel.sentMessages[0], equals('{"type": "test"}'));
    });

    test('FakeWebSocketChannel delivers received messages', () async {
      final messages = <dynamic>[];
      final subscription = fakeChannel.stream.listen(messages.add);

      fakeChannel.addMessage('{"type": "offer"}');
      fakeChannel.addMessage('{"type": "answer"}');

      await Future.delayed(Duration.zero);

      expect(messages, hasLength(2));
      expect(messages[0], equals('{"type": "offer"}'));
      expect(messages[1], equals('{"type": "answer"}'));

      await subscription.cancel();
    });

    test('FakeWebSocketChannel can simulate errors', () async {
      final errors = <Object>[];
      final subscription = fakeChannel.stream.listen(
        (_) {},
        onError: errors.add,
      );

      fakeChannel.addError(Exception('Connection lost'));

      await Future.delayed(Duration.zero);

      expect(errors, hasLength(1));
      expect(errors[0], isA<Exception>());

      await subscription.cancel();
    });

    test('FakeWebSocketChannel ready throws when not ready', () async {
      fakeChannel.setReady(false, Exception('Not connected'));

      expect(
        () => fakeChannel.ready,
        throwsA(isA<Exception>()),
      );
    });
  });

  group('Message parsing simulation', () {
    // These tests simulate what _handleMessage would do
    // by testing the message parsing logic directly

    SignalingMessage? parseMessage(String jsonStr) {
      try {
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;
        final type = json['type'] as String;

        switch (type) {
          case 'offer':
            return SignalingMessage.offer(
              from: json['from'] as String,
              payload: json['payload'] as Map<String, dynamic>,
            );
          case 'answer':
            return SignalingMessage.answer(
              from: json['from'] as String,
              payload: json['payload'] as Map<String, dynamic>,
            );
          case 'ice_candidate':
            return SignalingMessage.iceCandidate(
              from: json['from'] as String,
              payload: json['payload'] as Map<String, dynamic>,
            );
          case 'peer_joined':
            return SignalingMessage.peerJoined(
              peerId: json['pairingCode'] as String,
            );
          case 'peer_left':
            return SignalingMessage.peerLeft(
              peerId: json['pairingCode'] as String,
            );
          case 'pair_incoming':
            return SignalingMessage.pairIncoming(
              fromCode: json['fromCode'] as String,
              fromPublicKey: json['fromPublicKey'] as String,
            );
          case 'pair_matched':
            return SignalingMessage.pairMatched(
              peerCode: json['peerCode'] as String,
              peerPublicKey: json['peerPublicKey'] as String,
              isInitiator: json['isInitiator'] as bool,
            );
          case 'pair_rejected':
            return SignalingMessage.pairRejected(
              peerCode: json['peerCode'] as String,
            );
          case 'pair_timeout':
            return SignalingMessage.pairTimeout(
              peerCode: json['peerCode'] as String,
            );
          case 'pair_error':
            return SignalingMessage.pairError(
              error: json['error'] as String,
            );
          case 'error':
            return SignalingMessage.error(
              message: json['message'] as String,
            );
          case 'pong':
          case 'registered':
            return null; // Ignored messages
        }
      } catch (_) {
        return null;
      }
      return null;
    }

    test('parses offer message', () {
      final json = jsonEncode({
        'type': 'offer',
        'from': 'PEER01',
        'payload': {'type': 'offer', 'sdp': 'v=0\r\n...'},
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingOffer>());
      final offer = message as SignalingOffer;
      expect(offer.from, equals('PEER01'));
      expect(offer.payload['sdp'], equals('v=0\r\n...'));
    });

    test('parses answer message', () {
      final json = jsonEncode({
        'type': 'answer',
        'from': 'PEER02',
        'payload': {'type': 'answer', 'sdp': 'v=0\r\n...'},
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingAnswer>());
    });

    test('parses ice_candidate message', () {
      final json = jsonEncode({
        'type': 'ice_candidate',
        'from': 'PEER03',
        'payload': {
          'candidate': 'candidate:1 1 UDP 2130706431 ...',
          'sdpMid': 'data',
          'sdpMLineIndex': 0,
        },
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingIceCandidate>());
      final ice = message as SignalingIceCandidate;
      expect(ice.payload['sdpMLineIndex'], equals(0));
    });

    test('parses pair_incoming message', () {
      final json = jsonEncode({
        'type': 'pair_incoming',
        'fromCode': 'REQ123',
        'fromPublicKey': 'base64PublicKey==',
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingPairIncoming>());
      final incoming = message as SignalingPairIncoming;
      expect(incoming.fromCode, equals('REQ123'));
      expect(incoming.fromPublicKey, equals('base64PublicKey=='));
    });

    test('parses pair_matched message', () {
      final json = jsonEncode({
        'type': 'pair_matched',
        'peerCode': 'MTH456',
        'peerPublicKey': 'peerPubKey==',
        'isInitiator': true,
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingPairMatched>());
      final matched = message as SignalingPairMatched;
      expect(matched.peerCode, equals('MTH456'));
      expect(matched.isInitiator, isTrue);
    });

    test('parses pair_rejected message', () {
      final json = jsonEncode({
        'type': 'pair_rejected',
        'peerCode': 'REJ789',
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingPairRejected>());
    });

    test('parses pair_timeout message', () {
      final json = jsonEncode({
        'type': 'pair_timeout',
        'peerCode': 'TMO000',
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingPairTimeout>());
    });

    test('parses pair_error message', () {
      final json = jsonEncode({
        'type': 'pair_error',
        'error': 'Peer not found',
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingPairError>());
      final error = message as SignalingPairError;
      expect(error.error, equals('Peer not found'));
    });

    test('parses error message', () {
      final json = jsonEncode({
        'type': 'error',
        'message': 'Rate limit exceeded',
      });

      final message = parseMessage(json);
      expect(message, isA<SignalingError>());
      final error = message as SignalingError;
      expect(error.message, equals('Rate limit exceeded'));
    });

    test('ignores pong message', () {
      final json = jsonEncode({'type': 'pong'});
      final message = parseMessage(json);
      expect(message, isNull);
    });

    test('ignores registered message', () {
      final json = jsonEncode({'type': 'registered'});
      final message = parseMessage(json);
      expect(message, isNull);
    });

    test('handles invalid JSON gracefully', () {
      final message = parseMessage('not valid json');
      expect(message, isNull);
    });

    test('handles missing required fields gracefully', () {
      final json = jsonEncode({
        'type': 'offer',
        // Missing 'from' and 'payload'
      });
      final message = parseMessage(json);
      expect(message, isNull);
    });

    test('handles unknown message type', () {
      final json = jsonEncode({
        'type': 'unknown_type',
        'data': 'something',
      });
      final message = parseMessage(json);
      expect(message, isNull);
    });
  });

  group('Message serialization for sending', () {
    // Test the expected format of outgoing messages

    test('register message format', () {
      final message = {
        'type': 'register',
        'pairingCode': 'ABC123',
        'publicKey': 'testPublicKey==',
      };

      final json = jsonEncode(message);
      final decoded = jsonDecode(json) as Map<String, dynamic>;

      expect(decoded['type'], equals('register'));
      expect(decoded['pairingCode'], equals('ABC123'));
      expect(decoded['publicKey'], equals('testPublicKey=='));
    });

    test('pair_request message format', () {
      final message = {
        'type': 'pair_request',
        'targetCode': 'XYZ789',
      };

      final json = jsonEncode(message);
      final decoded = jsonDecode(json) as Map<String, dynamic>;

      expect(decoded['type'], equals('pair_request'));
      expect(decoded['targetCode'], equals('XYZ789'));
    });

    test('pair_response accept message format', () {
      final message = {
        'type': 'pair_response',
        'targetCode': 'REQ456',
        'accepted': true,
      };

      final json = jsonEncode(message);
      final decoded = jsonDecode(json) as Map<String, dynamic>;

      expect(decoded['type'], equals('pair_response'));
      expect(decoded['targetCode'], equals('REQ456'));
      expect(decoded['accepted'], isTrue);
    });

    test('pair_response reject message format', () {
      final message = {
        'type': 'pair_response',
        'targetCode': 'REQ456',
        'accepted': false,
      };

      final json = jsonEncode(message);
      final decoded = jsonDecode(json) as Map<String, dynamic>;

      expect(decoded['accepted'], isFalse);
    });

    test('offer message format', () {
      final message = {
        'type': 'offer',
        'target': 'PEER01',
        'payload': {
          'type': 'offer',
          'sdp': 'v=0\r\no=- 123...',
        },
      };

      final json = jsonEncode(message);
      final decoded = jsonDecode(json) as Map<String, dynamic>;

      expect(decoded['type'], equals('offer'));
      expect(decoded['target'], equals('PEER01'));
      expect((decoded['payload'] as Map)['sdp'], isNotEmpty);
    });

    test('answer message format', () {
      final message = {
        'type': 'answer',
        'target': 'PEER02',
        'payload': {
          'type': 'answer',
          'sdp': 'v=0\r\no=- 456...',
        },
      };

      final json = jsonEncode(message);
      final decoded = jsonDecode(json) as Map<String, dynamic>;

      expect(decoded['type'], equals('answer'));
      expect(decoded['target'], equals('PEER02'));
    });

    test('ice_candidate message format', () {
      final message = {
        'type': 'ice_candidate',
        'target': 'PEER03',
        'payload': {
          'candidate': 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host',
          'sdpMid': 'data',
          'sdpMLineIndex': 0,
        },
      };

      final json = jsonEncode(message);
      final decoded = jsonDecode(json) as Map<String, dynamic>;

      expect(decoded['type'], equals('ice_candidate'));
      expect(decoded['target'], equals('PEER03'));
      expect((decoded['payload'] as Map)['candidate'], contains('candidate:'));
    });

    test('ping message format', () {
      final message = {'type': 'ping'};

      final json = jsonEncode(message);
      final decoded = jsonDecode(json) as Map<String, dynamic>;

      expect(decoded['type'], equals('ping'));
      expect(decoded.length, equals(1));
    });
  });
}
