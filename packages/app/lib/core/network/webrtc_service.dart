import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../models/peer.dart';

/// Callback types for WebRTC events.
typedef OnMessageCallback = void Function(String peerId, String message);
typedef OnFileChunkCallback = void Function(
    String peerId, String fileId, Uint8List chunk, int chunkIndex, int total);
typedef OnFileStartCallback = void Function(
    String peerId, String fileId, String fileName, int totalSize, int totalChunks);
typedef OnFileCompleteCallback = void Function(String peerId, String fileId);
typedef OnConnectionStateCallback = void Function(
    String peerId, PeerConnectionState state);
typedef OnSignalingMessageCallback = void Function(
    String peerId, Map<String, dynamic> message);

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
  static const String _messageChannelLabel = 'messages';
  static const String _fileChannelLabel = 'files';

  final CryptoService _cryptoService;

  // ICE servers for NAT traversal
  final List<Map<String, dynamic>> _iceServers;

  // Active connections
  final Map<String, _PeerConnection> _connections = {};

  // Callbacks
  OnMessageCallback? onMessage;
  OnFileChunkCallback? onFileChunk;
  OnFileStartCallback? onFileStart;
  OnFileCompleteCallback? onFileComplete;
  OnConnectionStateCallback? onConnectionStateChange;
  OnSignalingMessageCallback? onSignalingMessage;

  WebRTCService({
    required CryptoService cryptoService,
    List<Map<String, dynamic>>? iceServers,
  })  : _cryptoService = cryptoService,
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

    // Create and set local description
    final offer = await connection.pc.createOffer();
    await connection.pc.setLocalDescription(offer);

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

    // Set remote description
    await connection.pc.setRemoteDescription(
      RTCSessionDescription(offer['sdp'] as String, 'offer'),
    );

    // Create and set local description
    final answer = await connection.pc.createAnswer();
    await connection.pc.setLocalDescription(answer);

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

    await connection.pc.setRemoteDescription(
      RTCSessionDescription(answer['sdp'] as String, 'answer'),
    );
  }

  /// Add an ICE candidate from signaling.
  Future<void> addIceCandidate(
    String peerId,
    Map<String, dynamic> candidate,
  ) async {
    final connection = _connections[peerId];
    if (connection == null) {
      // Queue candidate for later if connection doesn't exist yet
      return;
    }

    await connection.pc.addCandidate(
      RTCIceCandidate(
        candidate['candidate'] as String?,
        candidate['sdpMid'] as String?,
        candidate['sdpMLineIndex'] as int?,
      ),
    );
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

    const chunkSize = 16384; // 16KB chunks
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
  Future<void> performHandshake(String peerId) async {
    final connection = _connections[peerId];
    if (connection == null || connection.messageChannel == null) {
      throw WebRTCException('No connection to peer: $peerId');
    }

    // Send our public key
    final publicKey = await _cryptoService.getPublicKeyBase64();
    final handshakeMessage = jsonEncode({
      'type': 'handshake',
      'publicKey': publicKey,
    });

    connection.messageChannel!.send(RTCDataChannelMessage(handshakeMessage));
  }

  /// Close connection to a peer.
  Future<void> closeConnection(String peerId) async {
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
  }

  /// Get connection state for a peer.
  PeerConnectionState getConnectionState(String peerId) {
    return _connections[peerId]?.state ?? PeerConnectionState.disconnected;
  }

  // Private methods

  Future<_PeerConnection> _createConnection(String peerId) async {
    // Close existing connection if any
    await closeConnection(peerId);

    final config = {
      'iceServers': _iceServers,
      'sdpSemantics': 'unified-plan',
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

    // ICE candidate handler
    connection.pc.onIceCandidate = (candidate) {
      if (candidate.candidate != null) {
        onSignalingMessage?.call(peerId, {
          'type': 'ice_candidate',
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        });
      }
    };

    // Connection state handler
    connection.pc.onConnectionState = (state) {
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
        await _cryptoService.establishSession(peerId, publicKey);
        _updateConnectionState(
          _connections[peerId]!,
          PeerConnectionState.connected,
        );
        return;
      }
    } catch (_) {
      // Not a JSON message, try to decrypt as regular message
    }

    // Decrypt and deliver message
    try {
      final plaintext = await _cryptoService.decrypt(peerId, text);
      onMessage?.call(peerId, plaintext);
    } catch (e) {
      // Decryption failed - might be unencrypted handshake or error
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
