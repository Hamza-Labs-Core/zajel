import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// Client for connecting to the signaling server for external peer connections.
///
/// The signaling server facilitates WebRTC connection establishment with
/// mutual approval pairing:
/// 1. Register with a pairing code and public key
/// 2. Request pairing with another peer's code
/// 3. Peer approves/rejects the request
/// 4. On approval, exchange SDP offers/answers
/// 5. Exchange ICE candidates
///
/// The server never sees actual message content - it only routes signaling data.
class SignalingClient {
  final String serverUrl;
  final String _pairingCode;
  final String _publicKey;

  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  final _messageController =
      StreamController<SignalingMessage>.broadcast();
  final _connectionStateController =
      StreamController<SignalingConnectionState>.broadcast();

  bool _isConnected = false;
  Timer? _heartbeatTimer;

  SignalingClient({
    required this.serverUrl,
    required String pairingCode,
    required String publicKey,
  })  : _pairingCode = pairingCode,
        _publicKey = publicKey;

  /// Stream of incoming signaling messages.
  Stream<SignalingMessage> get messages => _messageController.stream;

  /// Stream of connection state changes.
  Stream<SignalingConnectionState> get connectionState =>
      _connectionStateController.stream;

  /// Whether currently connected to the signaling server.
  bool get isConnected => _isConnected;

  /// The pairing code for this client.
  String get pairingCode => _pairingCode;

  /// Connect to the signaling server.
  Future<void> connect() async {
    if (_isConnected) return;

    try {
      _connectionStateController.add(SignalingConnectionState.connecting);

      _channel = WebSocketChannel.connect(Uri.parse(serverUrl));

      await _channel!.ready;

      _subscription = _channel!.stream.listen(
        _handleMessage,
        onError: _handleError,
        onDone: _handleDisconnect,
      );

      _isConnected = true;
      _connectionStateController.add(SignalingConnectionState.connected);

      // Register with our pairing code and public key
      _send({
        'type': 'register',
        'pairingCode': _pairingCode,
        'publicKey': _publicKey,
      });

      // Start heartbeat
      _startHeartbeat();
    } catch (e) {
      _connectionStateController.add(SignalingConnectionState.failed);
      rethrow;
    }
  }

  /// Disconnect from the signaling server.
  Future<void> disconnect() async {
    _stopHeartbeat();
    await _subscription?.cancel();
    await _channel?.sink.close();
    _channel = null;
    _isConnected = false;
    _connectionStateController.add(SignalingConnectionState.disconnected);
  }

  /// Send an offer to a peer via the signaling server.
  void sendOffer(String targetPairingCode, Map<String, dynamic> offer) {
    _send({
      'type': 'offer',
      'target': targetPairingCode,
      'payload': offer,
    });
  }

  /// Send an answer to a peer via the signaling server.
  void sendAnswer(String targetPairingCode, Map<String, dynamic> answer) {
    _send({
      'type': 'answer',
      'target': targetPairingCode,
      'payload': answer,
    });
  }

  /// Send an ICE candidate to a peer via the signaling server.
  void sendIceCandidate(
      String targetPairingCode, Map<String, dynamic> candidate) {
    _send({
      'type': 'ice_candidate',
      'target': targetPairingCode,
      'payload': candidate,
    });
  }

  /// Request to pair with another peer (requires their approval).
  void requestPairing(String targetPairingCode) {
    _send({
      'type': 'pair_request',
      'targetCode': targetPairingCode,
    });
  }

  /// Respond to a pairing request (accept or reject).
  void respondToPairing(String requesterPairingCode, {required bool accept}) {
    _send({
      'type': 'pair_response',
      'targetCode': requesterPairingCode,
      'accepted': accept,
    });
  }

  /// Send a generic message to the signaling server.
  ///
  /// Used by RelayClient for load reporting and other relay-specific messages.
  Future<void> send(Map<String, dynamic> message) async {
    _send(message);
  }

  /// Dispose resources.
  Future<void> dispose() async {
    await disconnect();
    await _messageController.close();
    await _connectionStateController.close();
  }

  // Private methods

  void _send(Map<String, dynamic> message) {
    if (!_isConnected || _channel == null) return;
    _channel!.sink.add(jsonEncode(message));
  }

  void _handleMessage(dynamic data) {
    try {
      final json = jsonDecode(data as String) as Map<String, dynamic>;
      final type = json['type'] as String;

      switch (type) {
        case 'offer':
          _messageController.add(SignalingMessage.offer(
            from: json['from'] as String,
            payload: json['payload'] as Map<String, dynamic>,
          ));
          break;

        case 'answer':
          _messageController.add(SignalingMessage.answer(
            from: json['from'] as String,
            payload: json['payload'] as Map<String, dynamic>,
          ));
          break;

        case 'ice_candidate':
          _messageController.add(SignalingMessage.iceCandidate(
            from: json['from'] as String,
            payload: json['payload'] as Map<String, dynamic>,
          ));
          break;

        case 'peer_joined':
          _messageController.add(SignalingMessage.peerJoined(
            peerId: json['pairingCode'] as String,
          ));
          break;

        case 'peer_left':
          _messageController.add(SignalingMessage.peerLeft(
            peerId: json['pairingCode'] as String,
          ));
          break;

        case 'pair_incoming':
          _messageController.add(SignalingMessage.pairIncoming(
            fromCode: json['fromCode'] as String,
            fromPublicKey: json['fromPublicKey'] as String,
          ));
          break;

        case 'pair_matched':
          _messageController.add(SignalingMessage.pairMatched(
            peerCode: json['peerCode'] as String,
            peerPublicKey: json['peerPublicKey'] as String,
            isInitiator: json['isInitiator'] as bool,
          ));
          break;

        case 'pair_rejected':
          _messageController.add(SignalingMessage.pairRejected(
            peerCode: json['peerCode'] as String,
          ));
          break;

        case 'pair_timeout':
          _messageController.add(SignalingMessage.pairTimeout(
            peerCode: json['peerCode'] as String,
          ));
          break;

        case 'pair_error':
          _messageController.add(SignalingMessage.pairError(
            error: json['error'] as String,
          ));
          break;

        case 'error':
          _messageController.add(SignalingMessage.error(
            message: json['message'] as String,
          ));
          break;

        case 'pong':
        case 'registered':
          // Heartbeat and registration confirmation, ignore
          break;
      }
    } catch (e) {
      // Invalid message format
    }
  }

  void _handleError(Object error) {
    _connectionStateController.add(SignalingConnectionState.failed);
    _isConnected = false;
  }

  void _handleDisconnect() {
    _isConnected = false;
    _stopHeartbeat();
    _connectionStateController.add(SignalingConnectionState.disconnected);
  }

  void _startHeartbeat() {
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_isConnected) {
        _send({'type': 'ping'});
      }
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }
}

/// Represents a message received from the signaling server.
sealed class SignalingMessage {
  const SignalingMessage();

  factory SignalingMessage.offer({
    required String from,
    required Map<String, dynamic> payload,
  }) = SignalingOffer;

  factory SignalingMessage.answer({
    required String from,
    required Map<String, dynamic> payload,
  }) = SignalingAnswer;

  factory SignalingMessage.iceCandidate({
    required String from,
    required Map<String, dynamic> payload,
  }) = SignalingIceCandidate;

  factory SignalingMessage.peerJoined({required String peerId}) =
      SignalingPeerJoined;

  factory SignalingMessage.peerLeft({required String peerId}) =
      SignalingPeerLeft;

  factory SignalingMessage.pairIncoming({
    required String fromCode,
    required String fromPublicKey,
  }) = SignalingPairIncoming;

  factory SignalingMessage.pairMatched({
    required String peerCode,
    required String peerPublicKey,
    required bool isInitiator,
  }) = SignalingPairMatched;

  factory SignalingMessage.pairRejected({required String peerCode}) =
      SignalingPairRejected;

  factory SignalingMessage.pairTimeout({required String peerCode}) =
      SignalingPairTimeout;

  factory SignalingMessage.pairError({required String error}) =
      SignalingPairError;

  factory SignalingMessage.error({required String message}) = SignalingError;
}

class SignalingOffer extends SignalingMessage {
  final String from;
  final Map<String, dynamic> payload;

  const SignalingOffer({required this.from, required this.payload});
}

class SignalingAnswer extends SignalingMessage {
  final String from;
  final Map<String, dynamic> payload;

  const SignalingAnswer({required this.from, required this.payload});
}

class SignalingIceCandidate extends SignalingMessage {
  final String from;
  final Map<String, dynamic> payload;

  const SignalingIceCandidate({required this.from, required this.payload});
}

class SignalingPeerJoined extends SignalingMessage {
  final String peerId;

  const SignalingPeerJoined({required this.peerId});
}

class SignalingPeerLeft extends SignalingMessage {
  final String peerId;

  const SignalingPeerLeft({required this.peerId});
}

class SignalingError extends SignalingMessage {
  final String message;

  const SignalingError({required this.message});
}

class SignalingPairIncoming extends SignalingMessage {
  final String fromCode;
  final String fromPublicKey;

  const SignalingPairIncoming({
    required this.fromCode,
    required this.fromPublicKey,
  });
}

class SignalingPairMatched extends SignalingMessage {
  final String peerCode;
  final String peerPublicKey;
  final bool isInitiator;

  const SignalingPairMatched({
    required this.peerCode,
    required this.peerPublicKey,
    required this.isInitiator,
  });
}

class SignalingPairRejected extends SignalingMessage {
  final String peerCode;

  const SignalingPairRejected({required this.peerCode});
}

class SignalingPairTimeout extends SignalingMessage {
  final String peerCode;

  const SignalingPairTimeout({required this.peerCode});
}

class SignalingPairError extends SignalingMessage {
  final String error;

  const SignalingPairError({required this.error});
}

/// Connection state for the signaling client.
enum SignalingConnectionState {
  disconnected,
  connecting,
  connected,
  failed,
}
