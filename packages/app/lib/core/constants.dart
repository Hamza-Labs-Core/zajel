/// Centralized constants for the Zajel Flutter app.
///
/// This module consolidates all magic numbers and configuration values
/// that were previously scattered across multiple files.
library;

// =============================================================================
// CRYPTO CONSTANTS
// =============================================================================

/// Cryptographic constants for encryption and key management.
class CryptoConstants {
  CryptoConstants._();

  /// ChaCha20-Poly1305 nonce size in bytes
  static const int nonceSize = 12;

  /// Poly1305 MAC size in bytes
  static const int macSize = 16;

  /// X25519 public key size in bytes
  static const int x25519KeySize = 32;

  /// HKDF output length in bytes
  static const int hkdfOutputLength = 32;
}

// =============================================================================
// FILE TRANSFER CONSTANTS
// =============================================================================

/// File transfer constants for WebRTC data channels.
class FileTransferConstants {
  FileTransferConstants._();

  /// Chunk size for file transfers (16KB)
  static const int chunkSize = 16 * 1024;

  /// Delay between sending chunks to prevent overwhelming (ms)
  static const int chunkSendDelayMs = 10;
}

// =============================================================================
// WEBSOCKET/SIGNALING CONSTANTS
// =============================================================================

/// WebSocket and signaling constants.
class SignalingConstants {
  SignalingConstants._();

  /// Heartbeat interval (30 seconds)
  static const Duration heartbeatInterval = Duration(seconds: 30);
}

// =============================================================================
// WEBRTC CONSTANTS
// =============================================================================

/// WebRTC configuration constants.
class WebRTCConstants {
  WebRTCConstants._();

  /// Default STUN servers for NAT traversal
  static const List<Map<String, dynamic>> defaultIceServers = [
    {'urls': 'stun:stun.l.google.com:19302'},
    {'urls': 'stun:stun1.l.google.com:19302'},
  ];

  /// Data channel label for messages
  static const String messageChannelLabel = 'messages';

  /// Data channel label for files
  static const String fileChannelLabel = 'files';

  /// Maximum retransmit attempts for data channels
  static const int maxRetransmits = 3;

  /// Timeout for WebRTC operations (createOffer, setLocalDescription, etc.)
  /// This prevents hanging when network is unstable or TURN/STUN servers are unreachable.
  static const Duration operationTimeout = Duration(seconds: 30);
}

// =============================================================================
// VOIP/CALL CONSTANTS
// =============================================================================

/// VoIP and call-related constants.
class CallConstants {
  CallConstants._();

  /// Timeout for ringing phase before auto-hangup (60 seconds)
  static const Duration ringingTimeout = Duration(seconds: 60);

  /// Reconnection attempt timeout after ICE disconnect
  static const Duration reconnectionTimeout = Duration(seconds: 10);

  /// Maximum time to wait for ICE gathering to complete
  static const Duration iceGatheringTimeout = Duration(seconds: 30);

  /// Delay before cleanup after call end to allow final packets
  static const Duration cleanupDelay = Duration(milliseconds: 500);

  /// Maximum pending ICE candidates to queue before remote description is set.
  /// Prevents memory exhaustion from ICE candidate floods.
  static const int maxPendingIceCandidates = 100;
}
