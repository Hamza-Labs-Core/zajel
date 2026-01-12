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
