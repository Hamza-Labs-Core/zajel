/**
 * Centralized constants for the Zajel VPS signaling server.
 *
 * This module consolidates all magic numbers and configuration values
 * that were previously scattered across multiple files.
 */

// =============================================================================
// WEBSOCKET CONSTANTS
// =============================================================================

export const WEBSOCKET = {
  /** Maximum message size (64KB) - matches WebSocket server config */
  MAX_MESSAGE_SIZE: 64 * 1024,
} as const;

// =============================================================================
// CRYPTO CONSTANTS
// =============================================================================

export const CRYPTO = {
  /** X25519 public key size in bytes */
  X25519_KEY_SIZE: 32,
} as const;

// =============================================================================
// RATE LIMITING
// =============================================================================

export const RATE_LIMIT = {
  /** Rate limit window in milliseconds (1 minute) */
  WINDOW_MS: 60000,

  /** Maximum messages per window */
  MAX_MESSAGES: 100,

  /** Maximum pair requests per window (stricter limit for expensive operations) */
  MAX_PAIR_REQUESTS: 10,
} as const;

// =============================================================================
// PAIRING CODE FORMAT
// =============================================================================

export const PAIRING_CODE = {
  /**
   * Regex for validating pairing code format.
   * Pairing codes are 6 characters using an unambiguous alphabet:
   * - Uppercase letters excluding I, O (to avoid confusion with 1, 0)
   * - Digits excluding 0, 1 (to avoid confusion with O, I)
   * This gives 32 possible characters (24 letters + 8 digits).
   */
  REGEX: /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/,
} as const;

// =============================================================================
// CALL SIGNALING VALIDATION
// =============================================================================

export const CALL_SIGNALING = {
  /**
   * Regex for validating UUID v4 format (used for callId).
   * Standard UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
   * where y is 8, 9, a, or b.
   */
  UUID_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,

  /**
   * Maximum length for SDP strings (defense against oversized payloads).
   * Typical SDP is 2-5KB, but can grow with many media lines.
   * 64KB should be more than enough for any legitimate SDP.
   */
  MAX_SDP_LENGTH: 65536,

  /**
   * Maximum length for ICE candidate strings.
   * Typical ICE candidate is ~100-200 bytes.
   * 1KB should be more than enough.
   */
  MAX_ICE_CANDIDATE_LENGTH: 1024,
} as const;

// =============================================================================
// PAIRING CONSTANTS
// =============================================================================

export const PAIRING = {
  /** Default timeout for pair request approval (2 minutes in ms) */
  DEFAULT_REQUEST_TIMEOUT: 120000,

  /** Default warning time before timeout (30 seconds in ms) */
  DEFAULT_REQUEST_WARNING_TIME: 30000,

  /** Maximum pending requests per target (DoS protection) */
  MAX_PENDING_REQUESTS_PER_TARGET: 10,
} as const;

// =============================================================================
// ENTROPY MONITORING THRESHOLDS (Issue #41)
// =============================================================================

export const ENTROPY = {
  /** Low risk threshold - below this is safe */
  COLLISION_LOW_THRESHOLD: 10000,

  /** Medium risk threshold */
  COLLISION_MEDIUM_THRESHOLD: 20000,

  /** High risk threshold - consider extending code length */
  COLLISION_HIGH_THRESHOLD: 30000,
} as const;

// =============================================================================
// ATTESTATION CONSTANTS
// =============================================================================

export const ATTESTATION = {
  /** Default session token TTL: 1 hour (in ms) */
  DEFAULT_SESSION_TOKEN_TTL: 60 * 60 * 1000,

  /** Default grace period for unattested connections: 30 seconds (in ms) */
  DEFAULT_GRACE_PERIOD: 30 * 1000,

  /** Error code sent to clients when attestation is required but missing */
  ERROR_CODE_NOT_ATTESTED: 'NOT_ATTESTED',

  /** WebSocket close code for attestation failure (4001 = application error) */
  WS_CLOSE_CODE_ATTESTATION_FAILED: 4001,

  /** WebSocket close code for grace period expired */
  WS_CLOSE_CODE_GRACE_EXPIRED: 4002,
} as const;
