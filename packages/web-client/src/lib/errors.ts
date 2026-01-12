/**
 * Centralized Error Handling for Zajel Web Client
 *
 * This module provides:
 * 1. Custom error classes for different error categories
 * 2. A centralized error handler with logging
 * 3. Error code registry for consistent error identification
 * 4. User-friendly message mapping
 */

// Error Codes Registry
export const ErrorCodes = {
  // Crypto errors (CRYPTO_xxx)
  CRYPTO_NOT_INITIALIZED: 'CRYPTO_001',
  CRYPTO_INVALID_KEY: 'CRYPTO_002',
  CRYPTO_DECRYPTION_FAILED: 'CRYPTO_003',
  CRYPTO_ENCRYPTION_FAILED: 'CRYPTO_004',
  CRYPTO_REPLAY_DETECTED: 'CRYPTO_005',
  CRYPTO_NO_SESSION: 'CRYPTO_006',
  CRYPTO_COUNTER_EXHAUSTED: 'CRYPTO_007',
  CRYPTO_SESSION_EXPIRED: 'CRYPTO_008',

  // Signaling errors (SIG_xxx)
  SIGNALING_CONNECTION_FAILED: 'SIG_001',
  SIGNALING_MESSAGE_PARSE_ERROR: 'SIG_002',
  SIGNALING_SEND_FAILED: 'SIG_003',
  SIGNALING_INVALID_CODE: 'SIG_004',
  SIGNALING_MESSAGE_TOO_LARGE: 'SIG_005',

  // WebRTC errors (RTC_xxx)
  WEBRTC_CONNECTION_FAILED: 'RTC_001',
  WEBRTC_CHANNEL_ERROR: 'RTC_002',
  WEBRTC_SEND_FAILED: 'RTC_003',
  WEBRTC_MESSAGE_TOO_LARGE: 'RTC_004',
  WEBRTC_ICE_FAILED: 'RTC_005',

  // File transfer errors (FILE_xxx)
  FILE_TOO_LARGE: 'FILE_001',
  FILE_CHUNK_FAILED: 'FILE_002',
  FILE_INCOMPLETE: 'FILE_003',

  // General errors (GEN_xxx)
  INITIALIZATION_FAILED: 'GEN_001',
  UNKNOWN_ERROR: 'GEN_999',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// User-friendly error messages
export const UserMessages: Record<string, string> = {
  [ErrorCodes.CRYPTO_NOT_INITIALIZED]:
    'Security initialization failed. Please refresh the page.',
  [ErrorCodes.CRYPTO_INVALID_KEY]:
    'Invalid security key received. Connection may be compromised.',
  [ErrorCodes.CRYPTO_DECRYPTION_FAILED]:
    'Could not decrypt message. The connection may be compromised.',
  [ErrorCodes.CRYPTO_ENCRYPTION_FAILED]:
    'Could not encrypt message. Please try again.',
  [ErrorCodes.CRYPTO_REPLAY_DETECTED]:
    'Security alert: Possible replay attack detected.',
  [ErrorCodes.CRYPTO_NO_SESSION]:
    'No secure session established. Please reconnect.',
  [ErrorCodes.CRYPTO_COUNTER_EXHAUSTED]:
    'Session counter exhausted. Please reconnect to establish a new session.',
  [ErrorCodes.CRYPTO_SESSION_EXPIRED]:
    'Session expired for security. Please reconnect.',
  [ErrorCodes.SIGNALING_CONNECTION_FAILED]:
    'Cannot connect to server. Please check your internet connection.',
  [ErrorCodes.SIGNALING_MESSAGE_PARSE_ERROR]:
    'Received invalid message from server.',
  [ErrorCodes.SIGNALING_SEND_FAILED]:
    'Failed to send message to server. Please check your connection.',
  [ErrorCodes.SIGNALING_INVALID_CODE]: 'Invalid pairing code format.',
  [ErrorCodes.SIGNALING_MESSAGE_TOO_LARGE]:
    'Message too large. Connection closed for security.',
  [ErrorCodes.WEBRTC_CONNECTION_FAILED]:
    'Peer connection failed. Please try reconnecting.',
  [ErrorCodes.WEBRTC_CHANNEL_ERROR]:
    'Communication channel error. Please try reconnecting.',
  [ErrorCodes.WEBRTC_SEND_FAILED]: 'Message could not be sent. Please try again.',
  [ErrorCodes.WEBRTC_MESSAGE_TOO_LARGE]:
    'Message too large to send.',
  [ErrorCodes.WEBRTC_ICE_FAILED]:
    'Network connectivity issue. Please check your connection.',
  [ErrorCodes.FILE_TOO_LARGE]: 'File is too large to transfer (max 100MB).',
  [ErrorCodes.FILE_CHUNK_FAILED]: 'File transfer interrupted. Please try again.',
  [ErrorCodes.FILE_INCOMPLETE]: 'File transfer incomplete. Some data was lost.',
  [ErrorCodes.INITIALIZATION_FAILED]:
    'Application failed to initialize. Please refresh the page.',
  [ErrorCodes.UNKNOWN_ERROR]: 'An unexpected error occurred.',
};

/**
 * Base error class for all Zajel errors.
 * Provides structured error information including error code and recoverability.
 */
export class ZajelError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean = true,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ZajelError';
    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Get a user-friendly message for this error.
   */
  get userMessage(): string {
    return UserMessages[this.code] || this.message;
  }
}

/**
 * Cryptographic operation errors.
 * These are typically non-recoverable and may indicate security issues.
 */
export class CryptoError extends ZajelError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.CRYPTO_DECRYPTION_FAILED,
    context?: Record<string, unknown>
  ) {
    super(message, code, false, context);
    this.name = 'CryptoError';
  }
}

/**
 * Connection-related errors (signaling and WebRTC).
 * These are often recoverable through reconnection.
 */
export class ConnectionError extends ZajelError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.SIGNALING_CONNECTION_FAILED,
    recoverable = true,
    context?: Record<string, unknown>
  ) {
    super(message, code, recoverable, context);
    this.name = 'ConnectionError';
  }
}

/**
 * File transfer errors.
 */
export class FileTransferError extends ZajelError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.FILE_CHUNK_FAILED,
    context?: Record<string, unknown>
  ) {
    super(message, code, true, context);
    this.name = 'FileTransferError';
  }
}

/**
 * Error handler type for subscribers.
 */
export type ErrorHandler = (error: ZajelError) => void;

/**
 * Centralized error handling utility.
 * Logs errors consistently and notifies subscribers.
 */
class ErrorService {
  private handlers: Set<ErrorHandler> = new Set();

  /**
   * Subscribe to error notifications.
   * @returns Unsubscribe function
   */
  subscribe(handler: ErrorHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Report an error. Logs to console and notifies subscribers.
   */
  report(error: ZajelError): void {
    // Log with appropriate level based on recoverability
    const logFn = error.recoverable ? console.warn : console.error;
    logFn(`[${error.code}] ${error.name}: ${error.message}`, error.context || '');

    // Notify all subscribers
    this.handlers.forEach((handler) => {
      try {
        handler(error);
      } catch (e) {
        console.error('Error handler threw:', e);
      }
    });
  }

  /**
   * Create and report a ZajelError from an unknown error.
   */
  reportUnknown(
    error: unknown,
    context: string,
    code: ErrorCode = ErrorCodes.UNKNOWN_ERROR
  ): ZajelError {
    const zajelError = this.wrapError(error, context, code);
    this.report(zajelError);
    return zajelError;
  }

  /**
   * Wrap an unknown error into a ZajelError.
   */
  wrapError(
    error: unknown,
    context: string,
    code: ErrorCode = ErrorCodes.UNKNOWN_ERROR
  ): ZajelError {
    if (error instanceof ZajelError) {
      return error;
    }

    const message =
      error instanceof Error ? error.message : String(error);

    return new ZajelError(`[${context}] ${message}`, code, true, {
      originalError: error instanceof Error ? error.name : typeof error,
    });
  }
}

// Singleton instance
export const errorService = new ErrorService();

/**
 * Utility function to handle errors in a consistent manner.
 * Logs the error with context and returns a ZajelError.
 *
 * @param error - The error to handle
 * @param context - Description of where the error occurred
 * @param code - Optional error code (defaults to UNKNOWN_ERROR)
 * @returns A ZajelError wrapping the original error
 */
export function handleError(
  error: unknown,
  context: string,
  code: ErrorCode = ErrorCodes.UNKNOWN_ERROR
): ZajelError {
  return errorService.reportUnknown(error, context, code);
}

/**
 * Type guard to check if an error is a ZajelError.
 */
export function isZajelError(error: unknown): error is ZajelError {
  return error instanceof ZajelError;
}

/**
 * Type guard to check if an error is a CryptoError.
 */
export function isCryptoError(error: unknown): error is CryptoError {
  return error instanceof CryptoError;
}

/**
 * Type guard to check if an error is a ConnectionError.
 */
export function isConnectionError(error: unknown): error is ConnectionError {
  return error instanceof ConnectionError;
}
