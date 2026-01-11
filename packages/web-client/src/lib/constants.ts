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
} as const;
