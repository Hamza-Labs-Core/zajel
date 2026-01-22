import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../constants.dart';
import '../logging/logger_service.dart';
import 'pinned_websocket.dart';

/// Check if current platform supports pinned WebSocket.
/// Android, iOS, macOS, Linux, and Windows have native implementations.
bool get _supportsPinnedWebSocket {
  if (kIsWeb) return false;
  // All native platforms have pinned WebSocket implementations
  return Platform.isAndroid ||
      Platform.isIOS ||
      Platform.isMacOS ||
      Platform.isLinux ||
      Platform.isWindows;
}

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
///
/// ## Security Model
///
/// This client uses WSS (WebSocket Secure) but does NOT implement certificate
/// pinning. This is a deliberate design decision based on the following:
///
/// ### Why No Certificate Pinning?
///
/// 1. **Flutter Web Limitation**: Certificate pinning via `SecurityContext` is
///    not possible on the web platform where this client may run.
///
/// 2. **web_socket_channel Limitation**: The package used for WebSocket
///    connections does not expose certificate pinning configuration.
///
/// 3. **Maintenance Burden**: Certificate rotation would require app updates,
///    risking user lockouts if certificates expire before users update.
///
/// ### How Security Is Maintained Without Pinning
///
/// The lack of certificate pinning is mitigated by multiple security layers:
///
/// 1. **End-to-End Encryption (E2E)**: All message content is encrypted using
///    X25519 key exchange and ChaCha20-Poly1305. Even if the signaling server
///    is compromised, message content remains encrypted and unreadable.
///
/// 2. **Public Key Fingerprint Verification**: Users can verify each other's
///    public key fingerprints through an out-of-band channel (phone call,
///    in person) to detect MITM attacks during key exchange.
///
/// 3. **WebRTC DTLS Protection**: Once WebRTC is established, DTLS-SRTP
///    provides additional encryption and certificate fingerprint verification.
///
/// 4. **Ephemeral Keys**: New key pairs are generated per session (on mobile)
///    or per page load (on web), limiting exposure if keys are compromised.
///
/// ### Threat Model
///
/// The signaling server is treated as an **untrusted relay**. It only
/// facilitates connection establishment and never sees decrypted content.
/// The real security comes from E2E encryption with verified key fingerprints.
///
/// For high-security scenarios, users SHOULD verify key fingerprints out-of-band.
///
/// ### Future Considerations (Native Mobile Only)
///
/// For native Android/iOS builds (not Flutter Web), certificate pinning could
/// be implemented using platform-specific code:
/// - Android: Network Security Configuration or OkHttp CertificatePinner
/// - iOS: TrustKit or URLSession delegate with custom trust evaluation
///
/// See: /SECURITY.md for full security architecture documentation.
class SignalingClient {
  final String serverUrl;
  final String _pairingCode;
  final String _publicKey;
  final bool _usePinnedWebSocket;

  // Standard WebSocket (for web platform or when pinning disabled)
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;

  // Pinned WebSocket (for mobile platforms)
  PinnedWebSocket? _pinnedSocket;
  StreamSubscription? _pinnedMessageSubscription;
  StreamSubscription? _pinnedStateSubscription;
  StreamSubscription? _pinnedErrorSubscription;

  final _messageController =
      StreamController<SignalingMessage>.broadcast();
  final _connectionStateController =
      StreamController<SignalingConnectionState>.broadcast();

  // Call signaling stream controllers
  final _callOfferController = StreamController<CallOfferMessage>.broadcast();
  final _callAnswerController = StreamController<CallAnswerMessage>.broadcast();
  final _callRejectController = StreamController<CallRejectMessage>.broadcast();
  final _callHangupController = StreamController<CallHangupMessage>.broadcast();
  final _callIceController = StreamController<CallIceMessage>.broadcast();

  final _logger = LoggerService.instance;

  bool _isConnected = false;
  Timer? _heartbeatTimer;

  SignalingClient({
    required this.serverUrl,
    required String pairingCode,
    required String publicKey,
    bool? usePinnedWebSocket,
  })  : _pairingCode = pairingCode,
        _publicKey = publicKey,
        // Use pinned WebSocket only on platforms with native implementations (Android/iOS)
        // Disabled on: web (no native access), desktop (no native impl), and test env
        _usePinnedWebSocket = usePinnedWebSocket ??
            (_supportsPinnedWebSocket && !const bool.fromEnvironment('FLUTTER_TEST', defaultValue: false)) {
    _logger.debug(
      'SignalingClient',
      'Initialized: usePinnedWebSocket=$_usePinnedWebSocket, '
      'isWeb=$kIsWeb, supportsPinnedWS=$_supportsPinnedWebSocket',
    );
  }

  /// Stream of incoming signaling messages.
  Stream<SignalingMessage> get messages => _messageController.stream;

  /// Stream of connection state changes.
  Stream<SignalingConnectionState> get connectionState =>
      _connectionStateController.stream;

  /// Stream of incoming call offer messages.
  Stream<CallOfferMessage> get onCallOffer => _callOfferController.stream;

  /// Stream of incoming call answer messages.
  Stream<CallAnswerMessage> get onCallAnswer => _callAnswerController.stream;

  /// Stream of incoming call reject messages.
  Stream<CallRejectMessage> get onCallReject => _callRejectController.stream;

  /// Stream of incoming call hangup messages.
  Stream<CallHangupMessage> get onCallHangup => _callHangupController.stream;

  /// Stream of incoming call ICE candidate messages.
  Stream<CallIceMessage> get onCallIce => _callIceController.stream;

  /// Whether currently connected to the signaling server.
  bool get isConnected => _isConnected;

  /// The pairing code for this client.
  String get pairingCode => _pairingCode;

  /// Connect to the signaling server.
  ///
  /// On mobile platforms (Android/iOS), uses certificate pinning via
  /// platform-specific native WebSocket implementations. On web and desktop,
  /// uses standard WebSocket (browser/OS handles TLS validation).
  Future<void> connect() async {
    if (_isConnected) {
      _logger.debug('SignalingClient', 'Already connected, skipping');
      return;
    }

    _logger.info(
      'SignalingClient',
      'Connecting to $serverUrl (usePinnedWebSocket=$_usePinnedWebSocket)',
    );

    try {
      _connectionStateController.add(SignalingConnectionState.connecting);

      if (_usePinnedWebSocket) {
        _logger.debug('SignalingClient', 'Using pinned WebSocket connection');
        await _connectWithPinning();
      } else {
        _logger.debug('SignalingClient', 'Using standard WebSocket connection');
        await _connectStandard();
      }

      _isConnected = true;
      _connectionStateController.add(SignalingConnectionState.connected);
      _logger.info('SignalingClient', 'Connected successfully');

      // Register with our pairing code and public key
      _logger.debug('SignalingClient', 'Registering with pairing code: $_pairingCode');
      _send({
        'type': 'register',
        'pairingCode': _pairingCode,
        'publicKey': _publicKey,
      });

      // Start heartbeat
      _startHeartbeat();
    } catch (e, stackTrace) {
      _logger.error(
        'SignalingClient',
        'Connection failed to $serverUrl',
        e,
        stackTrace,
      );
      // Clean up resources on connection error
      await _cleanupConnection();
      _connectionStateController.add(SignalingConnectionState.failed);
      rethrow;
    }
  }

  /// Connect using standard WebSocket (no pinning).
  Future<void> _connectStandard() async {
    _logger.debug('SignalingClient', 'Creating standard WebSocket to $serverUrl');
    _channel = WebSocketChannel.connect(Uri.parse(serverUrl));

    _logger.debug('SignalingClient', 'Waiting for WebSocket ready...');
    await _channel!.ready;
    _logger.debug('SignalingClient', 'WebSocket ready, setting up stream listener');

    _subscription = _channel!.stream.listen(
      _handleMessage,
      onError: _handleError,
      onDone: _handleDisconnect,
    );
    _logger.debug('SignalingClient', 'Standard WebSocket connected successfully');
  }

  /// Connect using pinned WebSocket (certificate pinning enabled).
  Future<void> _connectWithPinning() async {
    _logger.info(
      'SignalingClient',
      'Connecting to signaling server with certificate pinning',
    );

    _pinnedSocket = PinnedWebSocket(url: serverUrl);

    // Listen for state changes
    _pinnedStateSubscription = _pinnedSocket!.stateStream.listen((state) {
      switch (state) {
        case PinnedWebSocketState.disconnected:
          _handleDisconnect();
          break;
        case PinnedWebSocketState.error:
          _handleError('Connection error');
          break;
        default:
          break;
      }
    });

    // Listen for messages
    _pinnedMessageSubscription = _pinnedSocket!.messages.listen(
      (message) => _handleMessage(message),
      onError: _handleError,
    );

    // Listen for errors (including pinning failures)
    _pinnedErrorSubscription = _pinnedSocket!.errors.listen((error) {
      if (error.startsWith('PINNING_FAILED:')) {
        _logger.error(
          'SignalingClient',
          'Certificate pinning failed for $serverUrl',
        );
        // Emit a specific error for pinning failures
        _connectionStateController.add(SignalingConnectionState.failed);
      }
    });

    await _pinnedSocket!.connect();

    _logger.info(
      'SignalingClient',
      'Connected to signaling server with certificate pinning',
    );
  }

  /// Disconnect from the signaling server.
  Future<void> disconnect() async {
    await _cleanupConnection();
    _connectionStateController.add(SignalingConnectionState.disconnected);
  }

  /// Clean up WebSocket connection resources.
  Future<void> _cleanupConnection() async {
    _stopHeartbeat();
    _isConnected = false;

    // Clean up standard WebSocket
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();

    final channel = _channel;
    _channel = null;
    await channel?.sink.close();

    // Clean up pinned WebSocket
    final pinnedMessageSub = _pinnedMessageSubscription;
    _pinnedMessageSubscription = null;
    await pinnedMessageSub?.cancel();

    final pinnedStateSub = _pinnedStateSubscription;
    _pinnedStateSubscription = null;
    await pinnedStateSub?.cancel();

    final pinnedErrorSub = _pinnedErrorSubscription;
    _pinnedErrorSubscription = null;
    await pinnedErrorSub?.cancel();

    final pinnedSocket = _pinnedSocket;
    _pinnedSocket = null;
    await pinnedSocket?.close();
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

  /// Respond to a device link request (accept or reject web client linking).
  void respondToLinkRequest(String linkCode, {required bool accept, String? deviceId}) {
    _send({
      'type': 'link_response',
      'linkCode': linkCode,
      'accepted': accept,
      if (deviceId != null) 'deviceId': deviceId,
    });
  }

  // ==========================================================================
  // Call Signaling Methods
  // ==========================================================================

  /// Send a call offer to a peer.
  ///
  /// [callId] - Unique identifier for this call
  /// [targetId] - The pairing code of the peer to call
  /// [sdp] - The SDP offer string
  /// [withVideo] - Whether this is a video call
  void sendCallOffer(String callId, String targetId, String sdp, bool withVideo) {
    _send(CallOfferMessage(
      callId: callId,
      targetId: targetId,
      sdp: sdp,
      withVideo: withVideo,
    ).toJson());
  }

  /// Send a call answer to accept an incoming call.
  ///
  /// [callId] - The call ID from the offer
  /// [targetId] - The pairing code of the caller
  /// [sdp] - The SDP answer string
  void sendCallAnswer(String callId, String targetId, String sdp) {
    _send(CallAnswerMessage(
      callId: callId,
      targetId: targetId,
      sdp: sdp,
    ).toJson());
  }

  /// Send a call rejection to decline an incoming call.
  ///
  /// [callId] - The call ID from the offer
  /// [targetId] - The pairing code of the caller
  /// [reason] - Optional reason for rejection ('busy', 'declined', 'timeout')
  void sendCallReject(String callId, String targetId, {String? reason}) {
    _send(CallRejectMessage(
      callId: callId,
      targetId: targetId,
      reason: reason,
    ).toJson());
  }

  /// Send a hangup signal to end an active call.
  ///
  /// [callId] - The call ID
  /// [targetId] - The pairing code of the peer
  void sendCallHangup(String callId, String targetId) {
    _send(CallHangupMessage(
      callId: callId,
      targetId: targetId,
    ).toJson());
  }

  /// Send an ICE candidate for call establishment.
  ///
  /// [callId] - The call ID
  /// [targetId] - The pairing code of the peer
  /// [candidate] - The ICE candidate as a JSON string
  void sendCallIce(String callId, String targetId, String candidate) {
    _send(CallIceMessage(
      callId: callId,
      targetId: targetId,
      candidate: candidate,
    ).toJson());
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
    // Close call signaling stream controllers
    await _callOfferController.close();
    await _callAnswerController.close();
    await _callRejectController.close();
    await _callHangupController.close();
    await _callIceController.close();
  }

  // Private methods

  void _send(Map<String, dynamic> message) {
    if (!_isConnected) return;

    final encodedMessage = jsonEncode(message);

    // Use pinned WebSocket if available, otherwise use standard
    if (_pinnedSocket != null) {
      _pinnedSocket!.send(encodedMessage);
    } else if (_channel != null) {
      _channel!.sink.add(encodedMessage);
    }
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

        case 'link_request':
          // Web client requesting to link with this mobile app
          _messageController.add(SignalingMessage.linkRequest(
            linkCode: json['linkCode'] as String,
            publicKey: json['publicKey'] as String,
            deviceName: json['deviceName'] as String? ?? 'Unknown Device',
          ));
          break;

        case 'link_matched':
          // Link request was accepted, WebRTC connection can proceed
          _messageController.add(SignalingMessage.linkMatched(
            linkCode: json['linkCode'] as String,
            peerPublicKey: json['peerPublicKey'] as String,
            isInitiator: json['isInitiator'] as bool,
          ));
          break;

        case 'link_rejected':
          // Link request was rejected
          _messageController.add(SignalingMessage.linkRejected(
            linkCode: json['linkCode'] as String,
          ));
          break;

        case 'link_timeout':
          // Link request timed out
          _messageController.add(SignalingMessage.linkTimeout(
            linkCode: json['linkCode'] as String,
          ));
          break;

        // Call signaling messages
        case 'call_offer':
          _callOfferController.add(CallOfferMessage.fromJson(json));
          break;

        case 'call_answer':
          _callAnswerController.add(CallAnswerMessage.fromJson(json));
          break;

        case 'call_reject':
          _callRejectController.add(CallRejectMessage.fromJson(json));
          break;

        case 'call_hangup':
          _callHangupController.add(CallHangupMessage.fromJson(json));
          break;

        case 'call_ice':
          _callIceController.add(CallIceMessage.fromJson(json));
          break;

        case 'pong':
        case 'registered':
          // Heartbeat and registration confirmation, ignore
          _logger.debug('SignalingClient', 'Received $type message');
          break;

        default:
          _logger.warning('SignalingClient', 'Unknown message type: $type');
          break;
      }
    } catch (e, stackTrace) {
      // Malformed messages from server are dropped but logged for debugging.
      // This handles JSON parse errors, missing fields, type mismatches.
      // Server message validation failures are non-fatal - connection continues.
      _logger.warning(
        'SignalingClient',
        'Invalid message format: $e\nMessage: $data',
      );
      _logger.debug('SignalingClient', 'Message parse stack trace: $stackTrace');
    }
  }

  void _handleError(Object error) {
    _logger.error(
      'SignalingClient',
      'WebSocket error occurred',
      error,
    );
    // Clean up resources on WebSocket error
    _cleanupConnection();
    _connectionStateController.add(SignalingConnectionState.failed);
  }

  void _handleDisconnect() {
    _logger.info('SignalingClient', 'WebSocket disconnected');
    // Clean up resources on disconnect
    _cleanupConnection();
    _connectionStateController.add(SignalingConnectionState.disconnected);
  }

  void _startHeartbeat() {
    _heartbeatTimer = Timer.periodic(SignalingConstants.heartbeatInterval, (_) {
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

  factory SignalingMessage.linkRequest({
    required String linkCode,
    required String publicKey,
    required String deviceName,
  }) = SignalingLinkRequest;

  factory SignalingMessage.linkMatched({
    required String linkCode,
    required String peerPublicKey,
    required bool isInitiator,
  }) = SignalingLinkMatched;

  factory SignalingMessage.linkRejected({required String linkCode}) =
      SignalingLinkRejected;

  factory SignalingMessage.linkTimeout({required String linkCode}) =
      SignalingLinkTimeout;
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

/// Device link request from a web client.
class SignalingLinkRequest extends SignalingMessage {
  final String linkCode;
  final String publicKey;
  final String deviceName;

  const SignalingLinkRequest({
    required this.linkCode,
    required this.publicKey,
    required this.deviceName,
  });
}

/// Device link matched - ready for WebRTC connection.
class SignalingLinkMatched extends SignalingMessage {
  final String linkCode;
  final String peerPublicKey;
  final bool isInitiator;

  const SignalingLinkMatched({
    required this.linkCode,
    required this.peerPublicKey,
    required this.isInitiator,
  });
}

/// Device link request was rejected.
class SignalingLinkRejected extends SignalingMessage {
  final String linkCode;

  const SignalingLinkRejected({required this.linkCode});
}

/// Device link request timed out.
class SignalingLinkTimeout extends SignalingMessage {
  final String linkCode;

  const SignalingLinkTimeout({required this.linkCode});
}

/// Connection state for the signaling client.
enum SignalingConnectionState {
  disconnected,
  connecting,
  connected,
  failed,
}

// =============================================================================
// Call Signaling Messages
// =============================================================================

/// Message for initiating a call offer.
class CallOfferMessage {
  final String callId;
  final String targetId;
  final String sdp;
  final bool withVideo;

  const CallOfferMessage({
    required this.callId,
    required this.targetId,
    required this.sdp,
    required this.withVideo,
  });

  Map<String, dynamic> toJson() => {
        'type': 'call_offer',
        'callId': callId,
        'targetId': targetId,
        'sdp': sdp,
        'withVideo': withVideo,
      };

  factory CallOfferMessage.fromJson(Map<String, dynamic> json) =>
      CallOfferMessage(
        callId: json['callId'] as String,
        targetId: json['from'] as String? ?? json['targetId'] as String,
        sdp: json['sdp'] as String,
        withVideo: json['withVideo'] as bool,
      );
}

/// Message for answering a call.
class CallAnswerMessage {
  final String callId;
  final String targetId;
  final String sdp;

  const CallAnswerMessage({
    required this.callId,
    required this.targetId,
    required this.sdp,
  });

  Map<String, dynamic> toJson() => {
        'type': 'call_answer',
        'callId': callId,
        'targetId': targetId,
        'sdp': sdp,
      };

  factory CallAnswerMessage.fromJson(Map<String, dynamic> json) =>
      CallAnswerMessage(
        callId: json['callId'] as String,
        targetId: json['from'] as String? ?? json['targetId'] as String,
        sdp: json['sdp'] as String,
      );
}

/// Message for rejecting a call.
class CallRejectMessage {
  final String callId;
  final String targetId;
  final String? reason;

  const CallRejectMessage({
    required this.callId,
    required this.targetId,
    this.reason,
  });

  Map<String, dynamic> toJson() => {
        'type': 'call_reject',
        'callId': callId,
        'targetId': targetId,
        if (reason != null) 'reason': reason,
      };

  factory CallRejectMessage.fromJson(Map<String, dynamic> json) =>
      CallRejectMessage(
        callId: json['callId'] as String,
        targetId: json['from'] as String? ?? json['targetId'] as String,
        reason: json['reason'] as String?,
      );
}

/// Message for ending a call.
class CallHangupMessage {
  final String callId;
  final String targetId;

  const CallHangupMessage({
    required this.callId,
    required this.targetId,
  });

  Map<String, dynamic> toJson() => {
        'type': 'call_hangup',
        'callId': callId,
        'targetId': targetId,
      };

  factory CallHangupMessage.fromJson(Map<String, dynamic> json) =>
      CallHangupMessage(
        callId: json['callId'] as String,
        targetId: json['from'] as String? ?? json['targetId'] as String,
      );
}

/// Message for exchanging ICE candidates during call setup.
class CallIceMessage {
  final String callId;
  final String targetId;
  final String candidate;

  const CallIceMessage({
    required this.callId,
    required this.targetId,
    required this.candidate,
  });

  Map<String, dynamic> toJson() => {
        'type': 'call_ice',
        'callId': callId,
        'targetId': targetId,
        'candidate': candidate,
      };

  factory CallIceMessage.fromJson(Map<String, dynamic> json) => CallIceMessage(
        callId: json['callId'] as String,
        targetId: json['from'] as String? ?? json['targetId'] as String,
        candidate: json['candidate'] as String,
      );
}
