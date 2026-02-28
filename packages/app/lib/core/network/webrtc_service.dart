import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../models/peer.dart';

import '../constants.dart';

/// Callback types for WebRTC events.
typedef OnMessageCallback = void Function(String peerId, String message);
typedef OnFileChunkCallback = void Function(
    String peerId, String fileId, Uint8List chunk, int chunkIndex, int total);
typedef OnFileStartCallback = void Function(String peerId, String fileId,
    String fileName, int totalSize, int totalChunks);
typedef OnFileCompleteCallback = void Function(String peerId, String fileId);
typedef OnConnectionStateCallback = void Function(
    String peerId, PeerConnectionState state);
typedef OnSignalingMessageCallback = void Function(
    String peerId, Map<String, dynamic> message);
typedef OnHandshakeCompleteCallback = void Function(
    String peerId, String publicKey, String? username, String? stableId);

/// Signaling event for stream-based signaling message delivery.
/// This replaces the callback-based approach to avoid race conditions
/// when multiple connections are attempted simultaneously.
class SignalingEvent {
  final String peerId;
  final Map<String, dynamic> message;

  SignalingEvent({required this.peerId, required this.message});
}

/// WebRTC service for establishing peer-to-peer connections.
///
/// Uses WebRTC Data Channels for:
/// - Text messages (encrypted)
/// - File transfer (chunked, encrypted)
///
/// Connection flow:
/// 1. Exchange signaling data (SDP offer/answer + ICE candidates)
/// 2. Establish WebRTC connection
/// 3. Perform cryptographic handshake over data channel
/// 4. Exchange encrypted messages
class WebRTCService {
  static const String _messageChannelLabel =
      WebRTCConstants.messageChannelLabel;
  static const String _fileChannelLabel = WebRTCConstants.fileChannelLabel;

  final CryptoService _cryptoService;

  // ICE servers for NAT traversal
  final List<Map<String, dynamic>> _iceServers;
  final bool _forceRelay;

  // Active connections
  final Map<String, _PeerConnection> _connections = {};

  // Queued ICE candidates that arrived before the connection was ready
  final Map<String, List<Map<String, dynamic>>> _pendingCandidates = {};

  // Stream-based signaling events to avoid race conditions
  // when multiple connections are attempted simultaneously.
  // Uses a broadcast stream so multiple listeners can subscribe.
  final _signalingController = StreamController<SignalingEvent>.broadcast();

  /// Stream of signaling events (ICE candidates, etc.) for all peers.
  /// Subscribe to this stream to receive signaling messages that need
  /// to be forwarded to the signaling server.
  Stream<SignalingEvent> get signalingEvents => _signalingController.stream;

  // Callbacks (kept for backward compatibility, but signalingEvents stream is preferred)
  OnMessageCallback? onMessage;
  OnFileChunkCallback? onFileChunk;
  OnFileStartCallback? onFileStart;
  OnFileCompleteCallback? onFileComplete;
  OnConnectionStateCallback? onConnectionStateChange;
  OnHandshakeCompleteCallback? onHandshakeComplete;
  @Deprecated('Use signalingEvents stream instead to avoid race conditions')
  OnSignalingMessageCallback? onSignalingMessage;

  WebRTCService({
    required CryptoService cryptoService,
    List<Map<String, dynamic>>? iceServers,
    bool forceRelay = false,
  })  : _cryptoService = cryptoService,
        _forceRelay = forceRelay,
        _iceServers = iceServers ??
            [
              // Google's public STUN servers
              {'urls': 'stun:stun.l.google.com:19302'},
              {'urls': 'stun:stun1.l.google.com:19302'},
            ];

  /// Create an offer to initiate a connection with a peer.
  Future<Map<String, dynamic>> createOffer(String peerId) async {
    final connection = await _createConnection(peerId);

    // Create data channels
    await _createDataChannels(connection);

    // Create and set local description with timeout to prevent hanging
    final offer = await connection.pc.createOffer().timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('createOffer timeout'),
        );
    await connection.pc.setLocalDescription(offer).timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('setLocalDescription timeout'),
        );

    return {
      'type': 'offer',
      'sdp': offer.sdp,
    };
  }

  /// Handle an incoming offer and create an answer.
  Future<Map<String, dynamic>> handleOffer(
    String peerId,
    Map<String, dynamic> offer,
  ) async {
    final connection = await _createConnection(peerId);

    // Set remote description with timeout to prevent hanging
    await connection.pc
        .setRemoteDescription(
          RTCSessionDescription(offer['sdp'] as String, 'offer'),
        )
        .timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () =>
              throw WebRTCException('setRemoteDescription timeout'),
        );

    // Flush any ICE candidates that arrived while we were setting up
    await _flushPendingCandidates(peerId, connection);

    // Create and set local description with timeout to prevent hanging
    final answer = await connection.pc.createAnswer().timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('createAnswer timeout'),
        );
    await connection.pc.setLocalDescription(answer).timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('setLocalDescription timeout'),
        );

    return {
      'type': 'answer',
      'sdp': answer.sdp,
    };
  }

  /// Handle an incoming answer to complete connection setup.
  Future<void> handleAnswer(
    String peerId,
    Map<String, dynamic> answer,
  ) async {
    final connection = _connections[peerId];
    if (connection == null) {
      throw WebRTCException('No connection found for peer: $peerId');
    }

    // Set remote description with timeout to prevent hanging
    await connection.pc
        .setRemoteDescription(
          RTCSessionDescription(answer['sdp'] as String, 'answer'),
        )
        .timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () =>
              throw WebRTCException('setRemoteDescription timeout'),
        );
  }

  /// Add an ICE candidate from signaling.
  Future<void> addIceCandidate(
    String peerId,
    Map<String, dynamic> candidate,
  ) async {
    final connection = _connections[peerId];
    if (connection == null) {
      // Queue candidate — connection is still being set up (handleOffer in progress)
      logger.debug('WebRTCService',
          'Queuing ICE candidate for $peerId (connection not ready)');
      _pendingCandidates.putIfAbsent(peerId, () => []).add(candidate);
      return;
    }

    // Add ICE candidate with timeout to prevent hanging
    await connection.pc
        .addCandidate(
          RTCIceCandidate(
            candidate['candidate'] as String?,
            candidate['sdpMid'] as String?,
            candidate['sdpMLineIndex'] as int?,
          ),
        )
        .timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('addIceCandidate timeout'),
        );
  }

  /// Flush queued ICE candidates that arrived before the connection was ready.
  Future<void> _flushPendingCandidates(
      String peerId, _PeerConnection connection) async {
    final pending = _pendingCandidates.remove(peerId);
    if (pending == null || pending.isEmpty) return;

    logger.debug('WebRTCService',
        'Flushing ${pending.length} queued ICE candidates for $peerId');
    for (final candidate in pending) {
      await connection.pc
          .addCandidate(
            RTCIceCandidate(
              candidate['candidate'] as String?,
              candidate['sdpMid'] as String?,
              candidate['sdpMLineIndex'] as int?,
            ),
          )
          .timeout(
            WebRTCConstants.operationTimeout,
            onTimeout: () =>
                throw WebRTCException('addIceCandidate (flush) timeout'),
          );
    }
  }

  /// Send an encrypted message to a peer.
  Future<void> sendMessage(String peerId, String plaintext) async {
    final connection = _connections[peerId];
    if (connection == null || connection.messageChannel == null) {
      throw WebRTCException('No connection to peer: $peerId');
    }

    // Encrypt the message
    final ciphertext = await _cryptoService.encrypt(peerId, plaintext);

    // Send over data channel
    connection.messageChannel!.send(RTCDataChannelMessage(ciphertext));
  }

  /// Send a file to a peer in chunks.
  Future<void> sendFile(
    String peerId,
    String fileId,
    String fileName,
    Uint8List data,
  ) async {
    final connection = _connections[peerId];
    if (connection == null || connection.fileChannel == null) {
      throw WebRTCException('No connection to peer: $peerId');
    }

    const chunkSize = FileTransferConstants.chunkSize;
    final totalChunks = (data.length / chunkSize).ceil();

    // Send file metadata first
    final metadata = jsonEncode({
      'type': 'file_start',
      'fileId': fileId,
      'fileName': fileName,
      'totalSize': data.length,
      'totalChunks': totalChunks,
    });
    connection.fileChannel!.send(RTCDataChannelMessage(metadata));

    // Send chunks
    for (var i = 0; i < totalChunks; i++) {
      final start = i * chunkSize;
      final end = (start + chunkSize).clamp(0, data.length);
      final chunk = data.sublist(start, end);

      // Encrypt chunk
      final encryptedChunk =
          await _cryptoService.encrypt(peerId, base64Encode(chunk));

      final chunkMessage = jsonEncode({
        'type': 'file_chunk',
        'fileId': fileId,
        'chunkIndex': i,
        'data': encryptedChunk,
      });

      connection.fileChannel!.send(RTCDataChannelMessage(chunkMessage));

      // Small delay to prevent buffer overflow
      await Future.delayed(const Duration(milliseconds: 10));
    }

    // Send file complete
    final complete = jsonEncode({
      'type': 'file_complete',
      'fileId': fileId,
    });
    connection.fileChannel!.send(RTCDataChannelMessage(complete));
  }

  /// Perform cryptographic handshake after connection is established.
  ///
  /// Includes an ephemeral X25519 public key for forward secrecy.
  /// The ephemeral private key is stored temporarily in
  /// [_pendingEphemeralKeys] until the peer's handshake arrives,
  /// then deleted after session key derivation.
  Future<void> performHandshake(String peerId,
      {String? username, String? stableId}) async {
    final connection = _connections[peerId];
    if (connection == null || connection.messageChannel == null) {
      throw WebRTCException('No connection to peer: $peerId');
    }

    // Generate ephemeral key pair for forward secrecy
    final ephemeral = await _cryptoService.generateEphemeralKeyPair();
    _pendingEphemeralKeys[peerId] = ephemeral.privateKey;

    // Send our public key, ephemeral key, username, and stable ID
    final publicKey = await _cryptoService.getPublicKeyBase64();
    final handshakeData = <String, dynamic>{
      'type': 'handshake',
      'publicKey': publicKey,
      'ephemeralKey': ephemeral.publicKey,
      'ratchetVersion': 1,
    };
    if (username != null) {
      handshakeData['username'] = username;
    }
    if (stableId != null) {
      handshakeData['stableId'] = stableId;
    }
    final handshakeMessage = jsonEncode(handshakeData);

    connection.messageChannel!.send(RTCDataChannelMessage(handshakeMessage));
  }

  /// Temporary storage for ephemeral private keys during handshake.
  /// Deleted immediately after session key derivation.
  final Map<String, String> _pendingEphemeralKeys = {};

  /// Close connection to a peer.
  Future<void> closeConnection(String peerId) async {
    _pendingCandidates.remove(peerId);
    _pendingEphemeralKeys.remove(peerId);
    final connection = _connections.remove(peerId);
    if (connection != null) {
      await connection.messageChannel?.close();
      await connection.fileChannel?.close();
      await connection.pc.close();
    }
  }

  /// Close all connections and dispose resources.
  Future<void> dispose() async {
    for (final peerId in _connections.keys.toList()) {
      await closeConnection(peerId);
    }
    // Close the signaling stream controller
    await _signalingController.close();
  }

  /// Get connection state for a peer.
  PeerConnectionState getConnectionState(String peerId) {
    return _connections[peerId]?.state ?? PeerConnectionState.disconnected;
  }

  /// Wait for the message data channel to open for a peer.
  ///
  /// Returns immediately if already open. Throws on timeout or connection failure.
  Future<void> waitForDataChannel(String peerId,
      {Duration timeout = const Duration(seconds: 30)}) async {
    final connection = _connections[peerId];
    if (connection == null) {
      throw WebRTCException('No connection found for peer: $peerId');
    }

    // Already open
    if (connection.messageChannel?.state ==
        RTCDataChannelState.RTCDataChannelOpen) {
      return;
    }

    // Set up completer if not already waiting
    if (connection.dataChannelCompleter == null ||
        connection.dataChannelCompleter!.isCompleted) {
      connection.dataChannelCompleter = Completer<void>();
    }

    await connection.dataChannelCompleter!.future.timeout(
      timeout,
      onTimeout: () =>
          throw WebRTCException('Data channel open timeout for $peerId'),
    );
  }

  // Private methods

  Future<_PeerConnection> _createConnection(String peerId) async {
    // Close existing connection if any
    await closeConnection(peerId);

    final config = {
      'iceServers': _iceServers,
      'sdpSemantics': 'unified-plan',
      // In E2E mode with TURN, force relay to avoid wasting time on
      // unreachable host/srflx candidates between emulators.
      if (_forceRelay) 'iceTransportPolicy': 'relay',
    };

    final pc = await createPeerConnection(config);
    final connection = _PeerConnection(peerId: peerId, pc: pc);
    _connections[peerId] = connection;

    // Set up event handlers
    _setupConnectionHandlers(connection);

    return connection;
  }

  void _setupConnectionHandlers(_PeerConnection connection) {
    final peerId = connection.peerId;

    // ICE candidate handler - emit to stream for race-condition-free handling
    connection.pc.onIceCandidate = (candidate) {
      if (candidate.candidate != null) {
        final message = {
          'type': 'ice_candidate',
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        };

        // Emit to stream (preferred approach - no race conditions)
        _signalingController
            .add(SignalingEvent(peerId: peerId, message: message));

        // Also call deprecated callback for backward compatibility
        // ignore: deprecated_member_use_from_same_package
        onSignalingMessage?.call(peerId, message);
      }
    };

    // ICE connection state handler
    connection.pc.onIceConnectionState = (state) {
      logger.debug('WebRTCService', 'ICE connection state for $peerId: $state');
    };

    // ICE gathering state handler
    connection.pc.onIceGatheringState = (state) {
      logger.debug('WebRTCService', 'ICE gathering state for $peerId: $state');
    };

    // Connection state handler
    connection.pc.onConnectionState = (state) {
      logger.debug(
          'WebRTCService', 'Peer connection state for $peerId: $state');
      switch (state) {
        case RTCPeerConnectionState.RTCPeerConnectionStateConnecting:
          _updateConnectionState(connection, PeerConnectionState.connecting);
          break;
        case RTCPeerConnectionState.RTCPeerConnectionStateConnected:
          _updateConnectionState(connection, PeerConnectionState.connected);
          break;
        case RTCPeerConnectionState.RTCPeerConnectionStateDisconnected:
        case RTCPeerConnectionState.RTCPeerConnectionStateFailed:
          _updateConnectionState(connection, PeerConnectionState.failed);
          break;
        case RTCPeerConnectionState.RTCPeerConnectionStateClosed:
          _updateConnectionState(connection, PeerConnectionState.disconnected);
          break;
        default:
          break;
      }
    };

    // Data channel handler (for incoming channels)
    connection.pc.onDataChannel = (channel) {
      _setupDataChannel(connection, channel);
    };
  }

  Future<void> _createDataChannels(_PeerConnection connection) async {
    // Message channel
    final messageChannel = await connection.pc.createDataChannel(
      _messageChannelLabel,
      RTCDataChannelInit()
        ..ordered = true
        ..maxRetransmits = 3,
    );
    connection.messageChannel = messageChannel;
    _setupDataChannel(connection, messageChannel);

    // File channel
    final fileChannel = await connection.pc.createDataChannel(
      _fileChannelLabel,
      RTCDataChannelInit()
        ..ordered = true
        ..maxRetransmits = 3,
    );
    connection.fileChannel = fileChannel;
    _setupDataChannel(connection, fileChannel);
  }

  void _setupDataChannel(_PeerConnection connection, RTCDataChannel channel) {
    final peerId = connection.peerId;

    if (channel.label == _messageChannelLabel) {
      connection.messageChannel = channel;
    } else if (channel.label == _fileChannelLabel) {
      connection.fileChannel = channel;
    }

    channel.onMessage = (message) {
      _handleDataChannelMessage(peerId, channel.label ?? '', message);
    };

    channel.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        if (channel.label == _messageChannelLabel) {
          _updateConnectionState(connection, PeerConnectionState.handshaking);
          // Complete any waiters for data channel open
          if (connection.dataChannelCompleter != null &&
              !connection.dataChannelCompleter!.isCompleted) {
            connection.dataChannelCompleter!.complete();
          }
        }
      }
    };
  }

  void _handleDataChannelMessage(
    String peerId,
    String channelLabel,
    RTCDataChannelMessage message,
  ) {
    if (channelLabel == _messageChannelLabel) {
      _handleMessageChannelData(peerId, message);
    } else if (channelLabel == _fileChannelLabel) {
      _handleFileChannelData(peerId, message);
    }
  }

  void _handleMessageChannelData(
      String peerId, RTCDataChannelMessage message) async {
    final text = message.text;

    // Check if it's a handshake message
    try {
      final json = jsonDecode(text) as Map<String, dynamic>;
      if (json['type'] == 'handshake') {
        final publicKey = json['publicKey'] as String;
        final peerEphemeralKey = json['ephemeralKey'] as String?;
        final ratchetVersion = json['ratchetVersion'] as int?;
        final username = json['username'] as String?;
        final stableId = json['stableId'] as String?;
        logger.info(
            'WebRTCService',
            'Received handshake from $peerId: '
                'peerPub=${publicKey.substring(0, 8)}… '
                'ephemeral=${peerEphemeralKey != null ? "yes(v$ratchetVersion)" : "no"} '
                'username=$username stableId=$stableId');

        // Use ephemeral key exchange if both sides support it
        final ourEphemeralPrivate = _pendingEphemeralKeys.remove(peerId);
        if (peerEphemeralKey != null && ourEphemeralPrivate != null) {
          // Forward-secret session: dual ECDH (identity + ephemeral)
          await _cryptoService.establishSessionWithEphemeral(
            peerId: peerId,
            peerIdentityKeyBase64: publicKey,
            peerEphemeralKeyBase64: peerEphemeralKey,
            ourEphemeralPrivateKeyBase64: ourEphemeralPrivate,
          );
        } else {
          // Backward compatible: identity-only key exchange
          if (ourEphemeralPrivate != null) {
            logger.info('WebRTCService',
                'Peer $peerId does not support ephemeral keys, using identity-only');
          }
          await _cryptoService.establishSession(peerId, publicKey);
        }

        // Connection may have been closed during the async key exchange
        final conn = _connections[peerId];
        if (conn == null) {
          logger.warning('WebRTCService',
              'Connection for $peerId removed during handshake');
          return;
        }
        // Notify ConnectionManager via callback so it can update peer username,
        // resolve identity via stableId, and control the state transition.
        if (onHandshakeComplete != null) {
          onHandshakeComplete!(peerId, publicKey, username, stableId);
        } else {
          // Fallback: transition directly if no callback is registered
          _updateConnectionState(conn, PeerConnectionState.connected);
        }
        return;
      }
    } catch (e) {
      // Non-JSON data is expected for encrypted messages.
      // Log actual handshake errors (not just JSON parse failures on ciphertext)
      if (text.contains('"handshake"')) {
        logger.error(
            'WebRTCService', 'Handshake processing failed for $peerId: $e');
      }
    }

    // Decrypt and deliver message
    try {
      final plaintext = await _cryptoService.decrypt(peerId, text);
      onMessage?.call(peerId, plaintext);
    } catch (e) {
      // Intentionally silenced for connection resilience.
      // Decryption failures may occur during handshake transitions or
      // when receiving malformed data. Logging for debugging only.
      logger.debug(
          'WebRTCService', 'Message decryption failed for $peerId: $e');
    }
  }

  void _handleFileChannelData(
      String peerId, RTCDataChannelMessage message) async {
    try {
      final json = jsonDecode(message.text) as Map<String, dynamic>;
      final type = json['type'] as String;
      final fileId = json['fileId'] as String;

      if (type == 'file_start') {
        // Store metadata
        _connections[peerId]?.fileMetadata[fileId] = json;

        // Notify listeners
        final fileName = json['fileName'] as String;
        final totalSize = json['totalSize'] as int;
        final totalChunks = json['totalChunks'] as int;
        onFileStart?.call(peerId, fileId, fileName, totalSize, totalChunks);
      } else if (type == 'file_chunk') {
        final encryptedData = json['data'] as String;
        final chunkIndex = json['chunkIndex'] as int;

        // Decrypt chunk
        final decryptedBase64 =
            await _cryptoService.decrypt(peerId, encryptedData);
        final chunk = base64Decode(decryptedBase64);

        // Get total from stored metadata
        final metadata = _connections[peerId]?.fileMetadata[fileId];
        final totalChunks = metadata?['totalChunks'] as int? ?? 0;

        onFileChunk?.call(peerId, fileId, chunk, chunkIndex, totalChunks);
      } else if (type == 'file_complete') {
        // Notify listeners that transfer is complete
        onFileComplete?.call(peerId, fileId);

        // Clean up metadata
        _connections[peerId]?.fileMetadata.remove(fileId);
      }
    } catch (e) {
      // Handle error
      logger.error('WebRTCService', 'Error handling file data', e);
    }
  }

  void _updateConnectionState(
    _PeerConnection connection,
    PeerConnectionState state,
  ) {
    logger.info('WebRTCService',
        'Connection state for ${connection.peerId}: ${state.name}');
    connection.state = state;
    onConnectionStateChange?.call(connection.peerId, state);
  }
}

class _PeerConnection {
  final String peerId;
  final RTCPeerConnection pc;
  RTCDataChannel? messageChannel;
  RTCDataChannel? fileChannel;
  PeerConnectionState state = PeerConnectionState.disconnected;
  Map<String, Map<String, dynamic>> fileMetadata = {};
  Completer<void>? dataChannelCompleter;

  _PeerConnection({
    required this.peerId,
    required this.pc,
  });
}

class WebRTCException implements Exception {
  final String message;
  WebRTCException(this.message);

  @override
  String toString() => 'WebRTCException: $message';
}
