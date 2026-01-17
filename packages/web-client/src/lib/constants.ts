/**
 * Centralized constants for the Zajel web client.
 *
 * This module consolidates all magic numbers and configuration values
 * that were previously scattered across multiple files.
 *
 * Categories:
 * - CRYPTO: Cryptographic constants (X25519, ChaCha20-Poly1305, replay protection)
 * - FILE_TRANSFER: File transfer sizes and limits
 * - MESSAGE_LIMITS: Message counts and size limits
 * - TIMEOUTS: Signaling and connection timeouts
 * - PAIRING_CODE: Pairing code format and validation
 * - WEBRTC: WebRTC configuration (ICE servers, channels)
 */

// =============================================================================
// CRYPTO CONSTANTS
// =============================================================================

export const CRYPTO = {
  /** ChaCha20-Poly1305 nonce size in bytes */
  NONCE_SIZE: 12,

  /** X25519 public key size in bytes */
  X25519_KEY_SIZE: 32,

  /** Sequence number size for replay protection (4 bytes = 32-bit counter) */
  SEQUENCE_NUMBER_SIZE: 4,

  /** Sliding window size for out-of-order message tolerance in replay protection */
  SEQUENCE_WINDOW: 64,

  /** Session key expiration time (24 hours) for forward secrecy */
  SESSION_KEY_EXPIRY_MS: 24 * 60 * 60 * 1000,
} as const;

// =============================================================================
// FILE TRANSFER CONSTANTS
// =============================================================================

export const FILE_TRANSFER = {
  /** Chunk size for file transfers (16KB) */
  CHUNK_SIZE: 16 * 1024,

  /** Maximum file size for incoming files (100MB) */
  MAX_FILE_SIZE: 100 * 1024 * 1024,

  /** Maximum concurrent file transfers to track in memory */
  MAX_TRANSFERS: 100,

  /** Delay between sending file chunks to prevent overwhelming the connection (ms) */
  CHUNK_SEND_DELAY_MS: 10,

  /** Time without activity before a transfer is considered stalled (ms) */
  STALL_TIMEOUT_MS: 30000,

  /** How often to check for stalled transfers (ms) */
  STALL_CHECK_INTERVAL_MS: 5000,
} as const;

// =============================================================================
// MESSAGE LIMITS
// =============================================================================

export const MESSAGE_LIMITS = {
  /** Maximum messages to keep in memory for UI display */
  MAX_MESSAGES: 1000,

  /** Maximum WebSocket message size (1MB) - for signaling */
  MAX_WEBSOCKET_MESSAGE_SIZE: 1024 * 1024,

  /** Maximum data channel message size (1MB) - for WebRTC */
  MAX_DATA_CHANNEL_MESSAGE_SIZE: 1024 * 1024,
} as const;

// =============================================================================
// SIGNALING TIMEOUTS
// =============================================================================

export const TIMEOUTS = {
  /** Ping interval for WebSocket keepalive (ms) */
  PING_INTERVAL_MS: 25000,

  /** Base delay for reconnection attempts with exponential backoff (ms) */
  RECONNECT_DELAY_BASE_MS: 1000,

  /** Maximum delay for reconnection attempts (ms) */
  RECONNECT_DELAY_MAX_MS: 30000,
} as const;

// =============================================================================
// PAIRING CODE CONFIGURATION
// =============================================================================

export const PAIRING_CODE = {
  /** Allowed characters (excludes ambiguous: 0, 1, I, O) */
  CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',

  /** Length of pairing code */
  LENGTH: 6,

  /** Number of random bytes to generate for pairing code */
  RANDOM_BYTES: 6,
} as const;

/** Pre-computed regex for pairing code validation */
export const PAIRING_CODE_REGEX = new RegExp(
  `^[${PAIRING_CODE.CHARS}]{${PAIRING_CODE.LENGTH}}$`
);

// =============================================================================
// WEBRTC CONFIGURATION
// =============================================================================

export const WEBRTC = {
  /** STUN servers for NAT traversal */
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ] as RTCIceServer[],

  /** Maximum pending ICE candidates in queue before connection is ready */
  MAX_PENDING_ICE_CANDIDATES: 100,

  /** Data channel names */
  CHANNELS: {
    /** Channel for text messages */
    MESSAGES: 'messages',
    /** Channel for file transfers */
    FILES: 'files',
  },

  // Buffer management constants for backpressure handling
  // Based on WebRTC best practices: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount

  /** High water mark - pause sending when buffer exceeds this (1MB) */
  HIGH_WATER_MARK: 1024 * 1024,

  /** Low water mark - resume sending when buffer drops below this (256KB) */
  LOW_WATER_MARK: 256 * 1024,

  /** Timeout to prevent infinite waits for buffer drain (30 seconds) */
  BUFFER_DRAIN_TIMEOUT_MS: 30000,
} as const;

// =============================================================================
// RELIABLE FILE TRANSFER CONSTANTS (FileTransferManager)
// =============================================================================

export const RELIABLE_TRANSFER = {
  /** Maximum retries per chunk before failing the transfer */
  MAX_RETRIES_PER_CHUNK: 3,

  /** Timeout waiting for chunk acknowledgment (ms) */
  CHUNK_ACK_TIMEOUT_MS: 5000,

  /** Time without activity before transfer is considered idle (1 minute) */
  TRANSFER_IDLE_TIMEOUT_MS: 60000,

  /** Maximum buffered amount before applying backpressure (1MB) */
  MAX_BUFFERED_AMOUNT: 1024 * 1024,

  /** Interval to check backpressure (ms) */
  BACKPRESSURE_CHECK_INTERVAL_MS: 50,

  /** Sliding window size - max chunks in flight simultaneously */
  MAX_CHUNKS_IN_FLIGHT: 10,

  /** How often to check for idle/stale transfers (ms) */
  IDLE_CHECK_INTERVAL_MS: 10000,
} as const;

// =============================================================================
// VOIP CALL CONSTANTS
// =============================================================================

export const CALL = {
  /** Time allowed for the callee to answer before timeout (60 seconds) */
  RINGING_TIMEOUT_MS: 60000,

  /** Time allowed for ICE candidate gathering (10 seconds) */
  ICE_GATHERING_TIMEOUT_MS: 10000,

  /** Time allowed for reconnection after connection drops (30 seconds) */
  RECONNECT_TIMEOUT_MS: 30000,
} as const;
