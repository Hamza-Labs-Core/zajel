/**
 * Runtime type validation for signaling and data channel messages.
 *
 * This module provides type guards and validators to ensure messages
 * received from the network conform to expected shapes before processing.
 * This prevents crashes from malformed messages and provides security
 * against injection attacks.
 */

import type {
  ServerMessage,
  DataChannelMessage,
  RegisteredMessage,
  PairIncomingMessage,
  PairExpiringMessage,
  PairMatchedMessage,
  PairRejectedMessage,
  PairTimeoutMessage,
  PairErrorMessage,
  OfferReceivedMessage,
  AnswerReceivedMessage,
  IceCandidateReceivedMessage,
  PongMessage,
  ErrorMessage,
  HandshakeMessage,
  FileStartMessage,
  FileChunkMessage,
  FileCompleteMessage,
  FileErrorMessage,
  FileStartAckMessage,
  ChunkAckMessage,
  ChunkRetryRequestMessage,
  FileCompleteAckMessage,
  TransferCancelMessage,
  CallOfferReceivedMessage,
  CallAnswerReceivedMessage,
  CallRejectReceivedMessage,
  CallHangupReceivedMessage,
  CallIceReceivedMessage,
} from './protocol';
import { PAIRING_CODE_REGEX } from './constants';

// Constants for validation
const MAX_PUBLIC_KEY_LENGTH = 256;
const MIN_PUBLIC_KEY_LENGTH = 32;
const MAX_ERROR_MESSAGE_LENGTH = 1000;
const MAX_SDP_LENGTH = 100000;
const MAX_ICE_CANDIDATE_LENGTH = 10000;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_FILE_CHUNKS = 1000000;
const MAX_ARRAY_SIZE = 10000; // Max elements in retry/missing chunk arrays to prevent DoS

// Call message validation constants
const MAX_CALL_SDP_LENGTH = 100000; // Max SDP length for call offers/answers
const MAX_CALL_ICE_CANDIDATE_LENGTH = 10000; // Max ICE candidate JSON length

// UUID v4 regex pattern for call IDs
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Valid call reject reasons
const CALL_REJECT_REASONS = ['busy', 'declined', 'timeout'] as const;

/**
 * Result of a validation operation.
 */
export type ValidationResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: string;
}

/**
 * Creates a successful validation result.
 */
function success<T>(data: T): ValidationResult<T> {
  return { success: true, data };
}

/**
 * Creates a failed validation result.
 */
function failure<T>(error: string): ValidationResult<T> {
  return { success: false, error };
}

/**
 * Checks if a value is a non-null object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates that a value is a string within length limits.
 */
function isString(value: unknown, minLength = 0, maxLength = Infinity): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength;
}

/**
 * Validates that a value is a boolean.
 */
function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Validates that a value is a number within range.
 */
function isNumber(value: unknown, min = -Infinity, max = Infinity): value is number {
  return typeof value === 'number' && !isNaN(value) && value >= min && value <= max;
}

/**
 * Validates that a value is an integer within range.
 */
function isInteger(value: unknown, min = -Infinity, max = Infinity): value is number {
  return isNumber(value, min, max) && Number.isInteger(value);
}

/**
 * Validates a pairing code format.
 */
function isValidPairingCode(value: unknown): value is string {
  return isString(value) && PAIRING_CODE_REGEX.test(value);
}

/**
 * Validates a public key format (base64 encoded, within length limits).
 */
function isValidPublicKey(value: unknown): value is string {
  return isString(value, MIN_PUBLIC_KEY_LENGTH, MAX_PUBLIC_KEY_LENGTH);
}

/**
 * Validates an RTCSessionDescriptionInit payload.
 */
function isValidSdpPayload(value: unknown): value is RTCSessionDescriptionInit {
  if (!isObject(value)) return false;

  // type is optional but if present must be valid
  if ('type' in value && value.type !== undefined) {
    if (!isString(value.type) || !['offer', 'answer', 'pranswer', 'rollback'].includes(value.type)) {
      return false;
    }
  }

  // sdp is optional but if present must be a string within limits
  if ('sdp' in value && value.sdp !== undefined) {
    if (!isString(value.sdp, 0, MAX_SDP_LENGTH)) {
      return false;
    }
    // Basic SDP structure validation for defense in depth
    // Valid SDP must start with 'v=0' and contain 'o=' and 's=' lines
    const sdp = value.sdp;
    if (sdp.length > 0) {
      if (!sdp.startsWith('v=0')) return false;
      if (!sdp.includes('\no=') && !sdp.includes('\r\no=')) return false;
      if (!sdp.includes('\ns=') && !sdp.includes('\r\ns=')) return false;
    }
  }

  return true;
}

/**
 * Validates an RTCIceCandidateInit payload.
 */
function isValidIceCandidatePayload(value: unknown): value is RTCIceCandidateInit {
  if (!isObject(value)) return false;

  // candidate is optional
  if ('candidate' in value && value.candidate !== undefined) {
    if (!isString(value.candidate, 0, MAX_ICE_CANDIDATE_LENGTH)) {
      return false;
    }
  }

  // sdpMid is optional, can be null
  if ('sdpMid' in value && value.sdpMid !== undefined && value.sdpMid !== null) {
    if (!isString(value.sdpMid, 0, 100)) {
      return false;
    }
  }

  // sdpMLineIndex is optional, can be null
  if ('sdpMLineIndex' in value && value.sdpMLineIndex !== undefined && value.sdpMLineIndex !== null) {
    if (!isInteger(value.sdpMLineIndex, 0, 255)) {
      return false;
    }
  }

  return true;
}

/**
 * Validates a UUID v4 format for call IDs.
 */
function isValidUuid(value: unknown): value is string {
  return isString(value) && UUID_REGEX.test(value);
}

/**
 * Validates an SDP string for call messages.
 * Call SDP is a raw string (not wrapped in RTCSessionDescriptionInit).
 */
function isValidCallSdp(value: unknown): value is string {
  if (!isString(value, 1, MAX_CALL_SDP_LENGTH)) {
    return false;
  }
  // Basic SDP structure validation for defense in depth
  // Valid SDP must start with 'v=0' and contain 'o=' and 's=' lines
  if (!value.startsWith('v=0')) return false;
  if (!value.includes('\no=') && !value.includes('\r\no=')) return false;
  if (!value.includes('\ns=') && !value.includes('\r\ns=')) return false;
  return true;
}

/**
 * Validates a JSON-stringified ICE candidate for call messages.
 */
function isValidCallIceCandidate(value: unknown): value is string {
  if (!isString(value, 1, MAX_CALL_ICE_CANDIDATE_LENGTH)) {
    return false;
  }
  // Verify it's valid JSON
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

// Individual message validators

function validateRegisteredMessage(obj: Record<string, unknown>): ValidationResult<RegisteredMessage> {
  if (!isValidPairingCode(obj.pairingCode)) {
    return failure('Invalid or missing pairingCode in registered message');
  }
  return success({ type: 'registered', pairingCode: obj.pairingCode });
}

function validatePairIncomingMessage(obj: Record<string, unknown>): ValidationResult<PairIncomingMessage> {
  if (!isValidPairingCode(obj.fromCode)) {
    return failure('Invalid or missing fromCode in pair_incoming message');
  }
  if (!isValidPublicKey(obj.fromPublicKey)) {
    return failure('Invalid or missing fromPublicKey in pair_incoming message');
  }
  // expiresIn is optional but if present must be a positive integer
  const expiresIn = isInteger(obj.expiresIn, 1, 600000) ? obj.expiresIn : undefined;
  return success({ type: 'pair_incoming', fromCode: obj.fromCode, fromPublicKey: obj.fromPublicKey, expiresIn });
}

function validatePairExpiringMessage(obj: Record<string, unknown>): ValidationResult<PairExpiringMessage> {
  if (!isValidPairingCode(obj.peerCode)) {
    return failure('Invalid or missing peerCode in pair_expiring message');
  }
  if (!isInteger(obj.remainingSeconds, 0, 600)) {
    return failure('Invalid or missing remainingSeconds in pair_expiring message');
  }
  return success({ type: 'pair_expiring', peerCode: obj.peerCode, remainingSeconds: obj.remainingSeconds });
}

function validatePairMatchedMessage(obj: Record<string, unknown>): ValidationResult<PairMatchedMessage> {
  if (!isValidPairingCode(obj.peerCode)) {
    return failure('Invalid or missing peerCode in pair_matched message');
  }
  if (!isValidPublicKey(obj.peerPublicKey)) {
    return failure('Invalid or missing peerPublicKey in pair_matched message');
  }
  if (!isBoolean(obj.isInitiator)) {
    return failure('Invalid or missing isInitiator in pair_matched message');
  }
  return success({
    type: 'pair_matched',
    peerCode: obj.peerCode,
    peerPublicKey: obj.peerPublicKey,
    isInitiator: obj.isInitiator,
  });
}

function validatePairRejectedMessage(obj: Record<string, unknown>): ValidationResult<PairRejectedMessage> {
  if (!isValidPairingCode(obj.peerCode)) {
    return failure('Invalid or missing peerCode in pair_rejected message');
  }
  return success({ type: 'pair_rejected', peerCode: obj.peerCode });
}

function validatePairTimeoutMessage(obj: Record<string, unknown>): ValidationResult<PairTimeoutMessage> {
  if (!isValidPairingCode(obj.peerCode)) {
    return failure('Invalid or missing peerCode in pair_timeout message');
  }
  return success({ type: 'pair_timeout', peerCode: obj.peerCode });
}

function validatePairErrorMessage(obj: Record<string, unknown>): ValidationResult<PairErrorMessage> {
  if (!isString(obj.error, 0, MAX_ERROR_MESSAGE_LENGTH)) {
    return failure('Invalid or missing error in pair_error message');
  }
  return success({ type: 'pair_error', error: obj.error });
}

function validateOfferReceivedMessage(obj: Record<string, unknown>): ValidationResult<OfferReceivedMessage> {
  if (!isValidPairingCode(obj.from)) {
    return failure('Invalid or missing from in offer message');
  }
  if (!isValidSdpPayload(obj.payload)) {
    return failure('Invalid or missing payload in offer message');
  }
  return success({ type: 'offer', from: obj.from, payload: obj.payload });
}

function validateAnswerReceivedMessage(obj: Record<string, unknown>): ValidationResult<AnswerReceivedMessage> {
  if (!isValidPairingCode(obj.from)) {
    return failure('Invalid or missing from in answer message');
  }
  if (!isValidSdpPayload(obj.payload)) {
    return failure('Invalid or missing payload in answer message');
  }
  return success({ type: 'answer', from: obj.from, payload: obj.payload });
}

function validateIceCandidateReceivedMessage(obj: Record<string, unknown>): ValidationResult<IceCandidateReceivedMessage> {
  if (!isValidPairingCode(obj.from)) {
    return failure('Invalid or missing from in ice_candidate message');
  }
  if (!isValidIceCandidatePayload(obj.payload)) {
    return failure('Invalid or missing payload in ice_candidate message');
  }
  return success({ type: 'ice_candidate', from: obj.from, payload: obj.payload });
}

function validatePongMessage(): ValidationResult<PongMessage> {
  return success({ type: 'pong' });
}

function validateErrorMessage(obj: Record<string, unknown>): ValidationResult<ErrorMessage> {
  if (!isString(obj.message, 0, MAX_ERROR_MESSAGE_LENGTH)) {
    return failure('Invalid or missing message in error message');
  }
  return success({ type: 'error', message: obj.message });
}

// Call signaling message validators

function validateCallOfferReceivedMessage(obj: Record<string, unknown>): ValidationResult<CallOfferReceivedMessage> {
  if (!isValidUuid(obj.callId)) {
    return failure('Invalid or missing callId in call_offer message');
  }
  if (!isString(obj.from, 1)) {
    return failure('Invalid or missing from in call_offer message');
  }
  if (!isValidCallSdp(obj.sdp)) {
    return failure('Invalid or missing sdp in call_offer message');
  }
  if (!isBoolean(obj.withVideo)) {
    return failure('Invalid or missing withVideo in call_offer message');
  }
  return success({
    type: 'call_offer',
    callId: obj.callId,
    from: obj.from,
    sdp: obj.sdp,
    withVideo: obj.withVideo,
  });
}

function validateCallAnswerReceivedMessage(obj: Record<string, unknown>): ValidationResult<CallAnswerReceivedMessage> {
  if (!isValidUuid(obj.callId)) {
    return failure('Invalid or missing callId in call_answer message');
  }
  if (!isString(obj.from, 1)) {
    return failure('Invalid or missing from in call_answer message');
  }
  if (!isValidCallSdp(obj.sdp)) {
    return failure('Invalid or missing sdp in call_answer message');
  }
  return success({
    type: 'call_answer',
    callId: obj.callId,
    from: obj.from,
    sdp: obj.sdp,
  });
}

function validateCallRejectReceivedMessage(obj: Record<string, unknown>): ValidationResult<CallRejectReceivedMessage> {
  if (!isValidUuid(obj.callId)) {
    return failure('Invalid or missing callId in call_reject message');
  }
  if (!isString(obj.from, 1)) {
    return failure('Invalid or missing from in call_reject message');
  }
  // reason is optional but if present must be a valid value
  let reason: 'busy' | 'declined' | 'timeout' | undefined;
  if (obj.reason !== undefined) {
    if (!isString(obj.reason) || !CALL_REJECT_REASONS.includes(obj.reason as typeof CALL_REJECT_REASONS[number])) {
      return failure('Invalid reason in call_reject message');
    }
    reason = obj.reason as 'busy' | 'declined' | 'timeout';
  }
  return success({
    type: 'call_reject',
    callId: obj.callId,
    from: obj.from,
    reason,
  });
}

function validateCallHangupReceivedMessage(obj: Record<string, unknown>): ValidationResult<CallHangupReceivedMessage> {
  if (!isValidUuid(obj.callId)) {
    return failure('Invalid or missing callId in call_hangup message');
  }
  if (!isString(obj.from, 1)) {
    return failure('Invalid or missing from in call_hangup message');
  }
  return success({
    type: 'call_hangup',
    callId: obj.callId,
    from: obj.from,
  });
}

function validateCallIceReceivedMessage(obj: Record<string, unknown>): ValidationResult<CallIceReceivedMessage> {
  if (!isValidUuid(obj.callId)) {
    return failure('Invalid or missing callId in call_ice message');
  }
  if (!isString(obj.from, 1)) {
    return failure('Invalid or missing from in call_ice message');
  }
  if (!isValidCallIceCandidate(obj.candidate)) {
    return failure('Invalid or missing candidate in call_ice message');
  }
  return success({
    type: 'call_ice',
    callId: obj.callId,
    from: obj.from,
    candidate: obj.candidate,
  });
}

/**
 * Validates a server message received via WebSocket.
 * Returns the validated message if successful, or null if validation fails.
 */
export function validateServerMessage(data: unknown): ValidationResult<ServerMessage> {
  if (!isObject(data)) {
    return failure('Message is not an object');
  }

  if (!isString(data.type)) {
    return failure('Message missing type field');
  }

  switch (data.type) {
    case 'registered':
      return validateRegisteredMessage(data);
    case 'pair_incoming':
      return validatePairIncomingMessage(data);
    case 'pair_expiring':
      return validatePairExpiringMessage(data);
    case 'pair_matched':
      return validatePairMatchedMessage(data);
    case 'pair_rejected':
      return validatePairRejectedMessage(data);
    case 'pair_timeout':
      return validatePairTimeoutMessage(data);
    case 'pair_error':
      return validatePairErrorMessage(data);
    case 'offer':
      return validateOfferReceivedMessage(data);
    case 'answer':
      return validateAnswerReceivedMessage(data);
    case 'ice_candidate':
      return validateIceCandidateReceivedMessage(data);
    case 'pong':
      return validatePongMessage();
    case 'error':
      return validateErrorMessage(data);
    // Call signaling messages
    case 'call_offer':
      return validateCallOfferReceivedMessage(data);
    case 'call_answer':
      return validateCallAnswerReceivedMessage(data);
    case 'call_reject':
      return validateCallRejectReceivedMessage(data);
    case 'call_hangup':
      return validateCallHangupReceivedMessage(data);
    case 'call_ice':
      return validateCallIceReceivedMessage(data);
    default:
      return failure(`Unknown message type: ${data.type}`);
  }
}

// Data channel message validators

function validateHandshakeMessage(obj: Record<string, unknown>): ValidationResult<HandshakeMessage> {
  if (!isValidPublicKey(obj.publicKey)) {
    return failure('Invalid or missing publicKey in handshake message');
  }
  return success({ type: 'handshake', publicKey: obj.publicKey });
}

function validateFileStartMessage(obj: Record<string, unknown>): ValidationResult<FileStartMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in file_start message');
  }
  if (!isString(obj.fileName, 1, MAX_FILE_NAME_LENGTH)) {
    return failure('Invalid or missing fileName in file_start message');
  }
  if (!isInteger(obj.totalSize, 0, Number.MAX_SAFE_INTEGER)) {
    return failure('Invalid or missing totalSize in file_start message');
  }
  if (!isInteger(obj.totalChunks, 1, MAX_FILE_CHUNKS)) {
    return failure('Invalid or missing totalChunks in file_start message');
  }
  // chunkHashes is optional - validate if present
  let chunkHashes: string[] | undefined;
  if (Array.isArray(obj.chunkHashes)) {
    if (obj.chunkHashes.length > MAX_ARRAY_SIZE) {
      return failure('chunkHashes array exceeds maximum size');
    }
    chunkHashes = [];
    for (const h of obj.chunkHashes) {
      if (!isString(h, 1, 100)) {
        return failure('Invalid chunkHash in file_start message');
      }
      chunkHashes.push(h);
    }
  }
  return success({
    type: 'file_start',
    fileId: obj.fileId,
    fileName: obj.fileName,
    totalSize: obj.totalSize,
    totalChunks: obj.totalChunks,
    chunkHashes,
  });
}

function validateFileChunkMessage(obj: Record<string, unknown>): ValidationResult<FileChunkMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in file_chunk message');
  }
  if (!isInteger(obj.chunkIndex, 0, MAX_FILE_CHUNKS)) {
    return failure('Invalid or missing chunkIndex in file_chunk message');
  }
  if (!isString(obj.data)) {
    return failure('Invalid or missing data in file_chunk message');
  }
  // hash is optional
  const hash = isString(obj.hash, 1, 100) ? obj.hash : undefined;
  return success({
    type: 'file_chunk',
    fileId: obj.fileId,
    chunkIndex: obj.chunkIndex,
    data: obj.data,
    hash,
  });
}

function validateFileCompleteMessage(obj: Record<string, unknown>): ValidationResult<FileCompleteMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in file_complete message');
  }
  // fileHash is optional
  const fileHash = isString(obj.fileHash, 1, 100) ? obj.fileHash : undefined;
  return success({ type: 'file_complete', fileId: obj.fileId, fileHash });
}

function validateFileErrorMessage(obj: Record<string, unknown>): ValidationResult<FileErrorMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in file_error message');
  }
  if (!isString(obj.error, 0, MAX_ERROR_MESSAGE_LENGTH)) {
    return failure('Invalid or missing error in file_error message');
  }
  return success({ type: 'file_error', fileId: obj.fileId, error: obj.error });
}

// New reliable file transfer protocol message validators

function validateFileStartAckMessage(obj: Record<string, unknown>): ValidationResult<FileStartAckMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in file_start_ack message');
  }
  if (!isBoolean(obj.accepted)) {
    return failure('Invalid or missing accepted in file_start_ack message');
  }
  // reason is optional
  const reason = isString(obj.reason, 0, 100) ? obj.reason : undefined;
  return success({ type: 'file_start_ack', fileId: obj.fileId, accepted: obj.accepted, reason });
}

function validateChunkAckMessage(obj: Record<string, unknown>): ValidationResult<ChunkAckMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in chunk_ack message');
  }
  if (!isInteger(obj.chunkIndex, 0, MAX_FILE_CHUNKS)) {
    return failure('Invalid or missing chunkIndex in chunk_ack message');
  }
  if (!isString(obj.status) || !['received', 'failed'].includes(obj.status)) {
    return failure('Invalid or missing status in chunk_ack message');
  }
  // hash is optional
  const hash = isString(obj.hash, 1, 100) ? obj.hash : undefined;
  return success({
    type: 'chunk_ack',
    fileId: obj.fileId,
    chunkIndex: obj.chunkIndex,
    status: obj.status as 'received' | 'failed',
    hash,
  });
}

function validateChunkRetryRequestMessage(obj: Record<string, unknown>): ValidationResult<ChunkRetryRequestMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in chunk_retry message');
  }
  if (!Array.isArray(obj.chunkIndices)) {
    return failure('Invalid or missing chunkIndices in chunk_retry message');
  }
  if (obj.chunkIndices.length > MAX_ARRAY_SIZE) {
    return failure('chunkIndices array exceeds maximum size');
  }
  // Validate each chunk index
  for (const index of obj.chunkIndices) {
    if (!isInteger(index, 0, MAX_FILE_CHUNKS)) {
      return failure('Invalid chunk index in chunk_retry message');
    }
  }
  return success({
    type: 'chunk_retry',
    fileId: obj.fileId,
    chunkIndices: obj.chunkIndices as number[],
  });
}

function validateFileCompleteAckMessage(obj: Record<string, unknown>): ValidationResult<FileCompleteAckMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in file_complete_ack message');
  }
  if (!isString(obj.status) || !['success', 'failed'].includes(obj.status)) {
    return failure('Invalid or missing status in file_complete_ack message');
  }
  // missingChunks is optional
  let missingChunks: number[] | undefined;
  if (Array.isArray(obj.missingChunks)) {
    if (obj.missingChunks.length > MAX_ARRAY_SIZE) {
      return failure('missingChunks array exceeds maximum size');
    }
    missingChunks = [];
    for (const index of obj.missingChunks) {
      if (!isInteger(index, 0, MAX_FILE_CHUNKS)) {
        return failure('Invalid chunk index in file_complete_ack message');
      }
      missingChunks.push(index as number);
    }
  }
  // fileHash is optional
  const fileHash = isString(obj.fileHash, 1, 100) ? obj.fileHash : undefined;
  return success({
    type: 'file_complete_ack',
    fileId: obj.fileId,
    status: obj.status as 'success' | 'failed',
    missingChunks,
    fileHash,
  });
}

function validateTransferCancelMessage(obj: Record<string, unknown>): ValidationResult<TransferCancelMessage> {
  if (!isString(obj.fileId, 1, 100)) {
    return failure('Invalid or missing fileId in transfer_cancel message');
  }
  if (!isString(obj.reason) || !['user_cancelled', 'error', 'timeout'].includes(obj.reason)) {
    return failure('Invalid or missing reason in transfer_cancel message');
  }
  return success({
    type: 'transfer_cancel',
    fileId: obj.fileId,
    reason: obj.reason as 'user_cancelled' | 'error' | 'timeout',
  });
}

/**
 * Validates a data channel message.
 * Returns the validated message if successful, or null if validation fails.
 */
export function validateDataChannelMessage(data: unknown): ValidationResult<DataChannelMessage> {
  if (!isObject(data)) {
    return failure('Message is not an object');
  }

  if (!isString(data.type)) {
    return failure('Message missing type field');
  }

  switch (data.type) {
    case 'handshake':
      return validateHandshakeMessage(data);
    case 'file_start':
      return validateFileStartMessage(data);
    case 'file_chunk':
      return validateFileChunkMessage(data);
    case 'file_complete':
      return validateFileCompleteMessage(data);
    case 'file_error':
      return validateFileErrorMessage(data);
    // New reliable transfer protocol messages
    case 'file_start_ack':
      return validateFileStartAckMessage(data);
    case 'chunk_ack':
      return validateChunkAckMessage(data);
    case 'chunk_retry':
      return validateChunkRetryRequestMessage(data);
    case 'file_complete_ack':
      return validateFileCompleteAckMessage(data);
    case 'transfer_cancel':
      return validateTransferCancelMessage(data);
    default:
      return failure(`Unknown data channel message type: ${data.type}`);
  }
}

/**
 * Validates only a handshake message (for message channel).
 */
export function validateHandshake(data: unknown): ValidationResult<HandshakeMessage> {
  if (!isObject(data)) {
    return failure('Message is not an object');
  }

  if (data.type !== 'handshake') {
    return failure('Not a handshake message');
  }

  return validateHandshakeMessage(data);
}

/**
 * Safely parses JSON and returns null on failure.
 */
export function safeJsonParse(data: string): unknown | null {
  try {
    return JSON.parse(data);
  } catch {
    // Intentionally silent: returns null for invalid JSON as designed
    // Caller is responsible for handling null return value
    return null;
  }
}

// =============================================================================
// XSS Prevention and Input Sanitization
// =============================================================================

/**
 * Maximum length for display names (if added in future)
 */
export const MAX_DISPLAY_NAME_LENGTH = 50;

/**
 * Maximum length for chat messages displayed in UI
 */
export const MAX_MESSAGE_LENGTH = 10000;

/**
 * Allowed protocols for URLs - blocks javascript:, vbscript:, data:, file:
 */
const SAFE_URL_PROTOCOLS = ['http:', 'https:'];

/**
 * Sanitizes a display name by removing control characters and limiting length.
 * Use this for any user-controlled display text that's not already validated.
 *
 * Note: Preact auto-escapes JSX content, so this is defense-in-depth.
 *
 * @param name - The raw display name input
 * @returns Sanitized display name
 */
export function sanitizeDisplayName(name: string): string {
  if (!name || typeof name !== 'string') {
    return '';
  }

  // Limit length
  let sanitized = name.slice(0, MAX_DISPLAY_NAME_LENGTH);

  // Remove control characters (ASCII 0-31 and 127)
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

  // Trim whitespace
  return sanitized.trim();
}

/**
 * Validates a display name format.
 * Allows letters, numbers, emoji, spaces, and common punctuation.
 *
 * @param name - The display name to validate
 * @returns True if valid
 */
export function isValidDisplayName(name: string): boolean {
  if (!name || name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH) {
    return false;
  }
  // Allow letters (any script), numbers, emoji, spaces, and common punctuation
  const DISPLAY_NAME_REGEX = /^[\p{L}\p{N}\p{Emoji}\s._\-']+$/u;
  return DISPLAY_NAME_REGEX.test(name);
}

/**
 * Sanitizes a filename for safe display and download.
 * Removes path separators, control characters, and limits length.
 *
 * @param fileName - The raw filename from peer
 * @returns Sanitized filename
 */
export function sanitizeFilename(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    return 'unknown_file';
  }

  let sanitized = fileName;

  // Remove path separators to prevent directory traversal display issues
  sanitized = sanitized.replace(/[/\\]/g, '_');

  // Remove control characters (ASCII 0-31 and 127)
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

  // Remove null bytes (double-check since they're critical)
  sanitized = sanitized.replace(/\0/g, '');

  // Limit length
  sanitized = sanitized.slice(0, MAX_FILE_NAME_LENGTH);

  // Trim whitespace
  sanitized = sanitized.trim();

  // If empty after sanitization, use default name
  if (!sanitized) {
    return 'unknown_file';
  }

  return sanitized;
}

/**
 * Validates that a filename doesn't contain dangerous patterns.
 *
 * @param fileName - The filename to validate
 * @returns True if the filename is safe
 */
export function isValidFilename(fileName: string): boolean {
  if (!fileName || typeof fileName !== 'string') {
    return false;
  }

  // Check length
  if (fileName.length === 0 || fileName.length > MAX_FILE_NAME_LENGTH) {
    return false;
  }

  // Check for path traversal attempts
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return false;
  }

  // Check for control characters
  if (/[\x00-\x1F\x7F]/.test(fileName)) {
    return false;
  }

  return true;
}

/**
 * Validates a chat message content.
 *
 * @param content - The message content to validate
 * @returns True if valid
 */
export function isValidMessage(content: string): boolean {
  if (typeof content !== 'string') {
    return false;
  }
  return content.length > 0 && content.length <= MAX_MESSAGE_LENGTH;
}

/**
 * Sanitizes a chat message for display.
 * Removes control characters but preserves newlines and tabs for formatting.
 *
 * Note: Preact auto-escapes JSX content, so this is defense-in-depth.
 *
 * @param content - The raw message content
 * @returns Sanitized message content
 */
export function sanitizeMessage(content: string): string {
  if (!content || typeof content !== 'string') {
    return '';
  }

  // Remove control characters except newline (\n), carriage return (\r), and tab (\t)
  let sanitized = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Limit length
  sanitized = sanitized.slice(0, MAX_MESSAGE_LENGTH);

  return sanitized;
}

/**
 * Sanitizes an error message for display.
 * Server/peer error messages should be limited and cleaned before display.
 *
 * @param error - The raw error message
 * @returns Sanitized error message
 */
export function sanitizeErrorMessage(error: string): string {
  if (!error || typeof error !== 'string') {
    return 'An unknown error occurred';
  }

  // Remove control characters
  let sanitized = error.replace(/[\x00-\x1F\x7F]/g, '');

  // Limit length to prevent UI overflow
  sanitized = sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH);

  // Trim whitespace
  sanitized = sanitized.trim();

  if (!sanitized) {
    return 'An unknown error occurred';
  }

  return sanitized;
}

/**
 * Validates a URL to ensure it uses a safe protocol.
 * Prevents javascript:, vbscript:, data:, and file: protocols.
 *
 * Use this before rendering any user-provided URL as a clickable link.
 *
 * @param url - The URL to validate
 * @returns True if the URL uses http: or https:
 */
export function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(url);
    return SAFE_URL_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validates and returns a URL if safe, null otherwise.
 * Use this before rendering any user-provided URL as a link.
 *
 * @param url - The URL to validate
 * @returns The URL if safe, null otherwise
 */
export function sanitizeUrl(url: string): string | null {
  if (!isValidUrl(url)) {
    return null;
  }
  return url;
}

/**
 * Checks if a value is a non-empty string.
 *
 * @param value - The value to check
 * @returns True if value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Checks if a value is a safe positive integer.
 *
 * @param value - The value to check
 * @returns True if value is a safe positive integer
 */
export function isSafePositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(value)
  );
}
