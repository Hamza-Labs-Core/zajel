/**
 * Validation Tests
 *
 * Tests for runtime message validation functions used for signaling and data channel messages.
 * These validators ensure type safety and security against malformed/malicious messages.
 */

import { describe, it, expect } from 'vitest';
import {
  validateServerMessage,
  validateDataChannelMessage,
  validateHandshake,
  safeJsonParse,
} from '../validation';

// Valid test data that passes validation
const VALID_PAIRING_CODE = 'ABC234';
const VALID_PUBLIC_KEY = 'test-public-key-123456789012345678901234567890'; // 32-256 chars
// Valid SDP must start with 'v=0' and contain 'o=' and 's=' lines per RFC 4566
const VALID_SDP = 'v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

describe('validateServerMessage', () => {
  describe('Basic validation', () => {
    it('should reject non-object values', () => {
      expect(validateServerMessage(null).success).toBe(false);
      expect(validateServerMessage(undefined).success).toBe(false);
      expect(validateServerMessage('string').success).toBe(false);
      expect(validateServerMessage(123).success).toBe(false);
      expect(validateServerMessage([]).success).toBe(false);
    });

    it('should reject objects without type field', () => {
      const result = validateServerMessage({ data: 'test' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('type');
      }
    });

    it('should reject unknown message types', () => {
      const result = validateServerMessage({ type: 'unknown_type' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown message type');
      }
    });
  });

  describe('registered message', () => {
    it('should validate valid registered message', () => {
      const result = validateServerMessage({
        type: 'registered',
        pairingCode: VALID_PAIRING_CODE,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('registered');
        expect(result.data.pairingCode).toBe(VALID_PAIRING_CODE);
      }
    });

    it('should reject registered message with invalid pairing code', () => {
      expect(validateServerMessage({
        type: 'registered',
        pairingCode: 'invalid',
      }).success).toBe(false);

      expect(validateServerMessage({
        type: 'registered',
        pairingCode: 'ABC01O', // Contains invalid chars
      }).success).toBe(false);

      expect(validateServerMessage({
        type: 'registered',
        pairingCode: 'abc234', // Lowercase
      }).success).toBe(false);
    });

    it('should reject registered message without pairing code', () => {
      const result = validateServerMessage({ type: 'registered' });
      expect(result.success).toBe(false);
    });
  });

  describe('pair_incoming message', () => {
    it('should validate valid pair_incoming message', () => {
      const result = validateServerMessage({
        type: 'pair_incoming',
        fromCode: VALID_PAIRING_CODE,
        fromPublicKey: VALID_PUBLIC_KEY,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('pair_incoming');
      }
    });

    it('should validate pair_incoming with optional expiresIn', () => {
      const result = validateServerMessage({
        type: 'pair_incoming',
        fromCode: VALID_PAIRING_CODE,
        fromPublicKey: VALID_PUBLIC_KEY,
        expiresIn: 60000,
      });
      expect(result.success).toBe(true);
    });

    it('should reject pair_incoming with invalid public key length', () => {
      const result = validateServerMessage({
        type: 'pair_incoming',
        fromCode: VALID_PAIRING_CODE,
        fromPublicKey: 'short', // Less than 32 chars
      });
      expect(result.success).toBe(false);
    });

    it('should reject pair_incoming with missing fromCode', () => {
      const result = validateServerMessage({
        type: 'pair_incoming',
        fromPublicKey: VALID_PUBLIC_KEY,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('pair_expiring message', () => {
    it('should validate valid pair_expiring message', () => {
      const result = validateServerMessage({
        type: 'pair_expiring',
        peerCode: VALID_PAIRING_CODE,
        remainingSeconds: 30,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('pair_expiring');
        expect(result.data.remainingSeconds).toBe(30);
      }
    });

    it('should reject pair_expiring with negative remainingSeconds', () => {
      const result = validateServerMessage({
        type: 'pair_expiring',
        peerCode: VALID_PAIRING_CODE,
        remainingSeconds: -1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject pair_expiring with missing remainingSeconds', () => {
      const result = validateServerMessage({
        type: 'pair_expiring',
        peerCode: VALID_PAIRING_CODE,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('pair_matched message', () => {
    it('should validate valid pair_matched message', () => {
      const result = validateServerMessage({
        type: 'pair_matched',
        peerCode: VALID_PAIRING_CODE,
        peerPublicKey: VALID_PUBLIC_KEY,
        isInitiator: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('pair_matched');
        expect(result.data.isInitiator).toBe(true);
      }
    });

    it('should reject pair_matched with non-boolean isInitiator', () => {
      const result = validateServerMessage({
        type: 'pair_matched',
        peerCode: VALID_PAIRING_CODE,
        peerPublicKey: VALID_PUBLIC_KEY,
        isInitiator: 'true', // String instead of boolean
      });
      expect(result.success).toBe(false);
    });

    it('should reject pair_matched without isInitiator', () => {
      const result = validateServerMessage({
        type: 'pair_matched',
        peerCode: VALID_PAIRING_CODE,
        peerPublicKey: VALID_PUBLIC_KEY,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('pair_rejected message', () => {
    it('should validate valid pair_rejected message', () => {
      const result = validateServerMessage({
        type: 'pair_rejected',
        peerCode: VALID_PAIRING_CODE,
      });
      expect(result.success).toBe(true);
    });

    it('should reject pair_rejected without peerCode', () => {
      const result = validateServerMessage({ type: 'pair_rejected' });
      expect(result.success).toBe(false);
    });
  });

  describe('pair_timeout message', () => {
    it('should validate valid pair_timeout message', () => {
      const result = validateServerMessage({
        type: 'pair_timeout',
        peerCode: VALID_PAIRING_CODE,
      });
      expect(result.success).toBe(true);
    });

    it('should reject pair_timeout without peerCode', () => {
      const result = validateServerMessage({ type: 'pair_timeout' });
      expect(result.success).toBe(false);
    });
  });

  describe('pair_error message', () => {
    it('should validate valid pair_error message', () => {
      const result = validateServerMessage({
        type: 'pair_error',
        error: 'Target not found',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.error).toBe('Target not found');
      }
    });

    it('should reject pair_error without error', () => {
      const result = validateServerMessage({ type: 'pair_error' });
      expect(result.success).toBe(false);
    });

    it('should reject pair_error with error exceeding max length', () => {
      const result = validateServerMessage({
        type: 'pair_error',
        error: 'x'.repeat(1001), // Exceeds 1000 char limit
      });
      expect(result.success).toBe(false);
    });
  });

  describe('offer message', () => {
    it('should validate valid offer message', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'offer', sdp: VALID_SDP },
      });
      expect(result.success).toBe(true);
    });

    it('should validate offer with minimal payload', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: {},
      });
      expect(result.success).toBe(true);
    });

    it('should validate offer with empty sdp string', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'offer', sdp: '' },
      });
      expect(result.success).toBe(true);
    });

    it('should reject offer with invalid SDP type', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'invalid-type', sdp: VALID_SDP },
      });
      expect(result.success).toBe(false);
    });

    it('should reject offer with SDP exceeding max length', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'offer', sdp: 'v=0\r\no=x\r\ns=x\r\n' + 'x'.repeat(100001) },
      });
      expect(result.success).toBe(false);
    });

    it('should reject offer with SDP not starting with v=0', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'offer', sdp: 'invalid-sdp' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject offer with SDP missing o= line', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'offer', sdp: 'v=0\r\ns=-\r\n' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject offer with SDP missing s= line', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'offer', sdp: 'v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\n' },
      });
      expect(result.success).toBe(false);
    });

    it('should accept SDP with Unix-style line endings', () => {
      const result = validateServerMessage({
        type: 'offer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'offer', sdp: 'v=0\no=- 123 456 IN IP4 127.0.0.1\ns=-\n' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('answer message', () => {
    it('should validate valid answer message', () => {
      const result = validateServerMessage({
        type: 'answer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'answer', sdp: VALID_SDP },
      });
      expect(result.success).toBe(true);
    });

    it('should reject answer with non-object payload', () => {
      const result = validateServerMessage({
        type: 'answer',
        from: VALID_PAIRING_CODE,
        payload: 'string-payload',
      });
      expect(result.success).toBe(false);
    });

    it('should reject answer with malformed SDP', () => {
      const result = validateServerMessage({
        type: 'answer',
        from: VALID_PAIRING_CODE,
        payload: { type: 'answer', sdp: 'malformed-sdp-content' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ice_candidate message', () => {
    it('should validate valid ice_candidate message', () => {
      const result = validateServerMessage({
        type: 'ice_candidate',
        from: VALID_PAIRING_CODE,
        payload: { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 },
      });
      expect(result.success).toBe(true);
    });

    it('should validate ice_candidate with null sdpMid', () => {
      const result = validateServerMessage({
        type: 'ice_candidate',
        from: VALID_PAIRING_CODE,
        payload: { candidate: 'candidate:123', sdpMid: null },
      });
      expect(result.success).toBe(true);
    });

    it('should reject ice_candidate with invalid sdpMLineIndex', () => {
      const result = validateServerMessage({
        type: 'ice_candidate',
        from: VALID_PAIRING_CODE,
        payload: { candidate: 'test', sdpMLineIndex: -1 },
      });
      expect(result.success).toBe(false);
    });

    it('should reject ice_candidate with candidate exceeding max length', () => {
      const result = validateServerMessage({
        type: 'ice_candidate',
        from: VALID_PAIRING_CODE,
        payload: { candidate: 'x'.repeat(10001) },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('pong message', () => {
    it('should validate valid pong message', () => {
      const result = validateServerMessage({ type: 'pong' });
      expect(result.success).toBe(true);
    });
  });

  describe('error message', () => {
    it('should validate valid error message', () => {
      const result = validateServerMessage({
        type: 'error',
        message: 'Something went wrong',
      });
      expect(result.success).toBe(true);
    });

    it('should reject error without message', () => {
      const result = validateServerMessage({ type: 'error' });
      expect(result.success).toBe(false);
    });
  });
});

describe('validateDataChannelMessage', () => {
  describe('Basic validation', () => {
    it('should reject non-object values', () => {
      expect(validateDataChannelMessage(null).success).toBe(false);
      expect(validateDataChannelMessage('string').success).toBe(false);
      expect(validateDataChannelMessage(123).success).toBe(false);
    });

    it('should reject objects without type field', () => {
      const result = validateDataChannelMessage({ data: 'test' });
      expect(result.success).toBe(false);
    });

    it('should reject unknown message types', () => {
      const result = validateDataChannelMessage({ type: 'unknown_type' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown');
      }
    });
  });

  describe('handshake message', () => {
    it('should validate valid handshake message', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: VALID_PUBLIC_KEY,
      });
      expect(result.success).toBe(true);
    });

    it('should validate handshake with valid 16-hex-char stableId', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: VALID_PUBLIC_KEY,
        stableId: 'abcdef1234567890',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stableId).toBe('abcdef1234567890');
      }
    });

    it('should validate handshake with uppercase hex stableId', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: VALID_PUBLIC_KEY,
        stableId: 'ABCDEF1234567890',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stableId).toBe('ABCDEF1234567890');
      }
    });

    it('should ignore stableId that is too short', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: VALID_PUBLIC_KEY,
        stableId: 'abc123',
      });
      // Handshake still succeeds, stableId is just omitted
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stableId).toBeUndefined();
      }
    });

    it('should ignore stableId that is too long', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: VALID_PUBLIC_KEY,
        stableId: 'abcdef12345678901', // 17 chars
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stableId).toBeUndefined();
      }
    });

    it('should ignore stableId with non-hex characters', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: VALID_PUBLIC_KEY,
        stableId: 'ghijkl1234567890', // g-l are not hex
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stableId).toBeUndefined();
      }
    });

    it('should ignore non-string stableId', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: VALID_PUBLIC_KEY,
        stableId: 12345,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stableId).toBeUndefined();
      }
    });

    it('should validate handshake without stableId (backward compat)', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: VALID_PUBLIC_KEY,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stableId).toBeUndefined();
      }
    });

    it('should reject handshake with short public key', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: 'short', // Less than 32 chars
      });
      expect(result.success).toBe(false);
    });

    it('should reject handshake with too long public key', () => {
      const result = validateDataChannelMessage({
        type: 'handshake',
        publicKey: 'x'.repeat(257), // Exceeds 256 chars
      });
      expect(result.success).toBe(false);
    });
  });

  describe('file_start message', () => {
    it('should validate valid file_start message', () => {
      const result = validateDataChannelMessage({
        type: 'file_start',
        fileId: 'file-123',
        fileName: 'test.txt',
        totalSize: 1024,
        totalChunks: 10,
      });
      expect(result.success).toBe(true);
    });

    it('should validate file_start with optional chunkHashes', () => {
      const result = validateDataChannelMessage({
        type: 'file_start',
        fileId: 'file-123',
        fileName: 'test.txt',
        totalSize: 1024,
        totalChunks: 2,
        chunkHashes: ['hash1', 'hash2'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chunkHashes).toEqual(['hash1', 'hash2']);
      }
    });

    it('should reject file_start with empty fileId', () => {
      const result = validateDataChannelMessage({
        type: 'file_start',
        fileId: '',
        fileName: 'test.txt',
        totalSize: 1024,
        totalChunks: 10,
      });
      expect(result.success).toBe(false);
    });

    it('should reject file_start with negative totalSize', () => {
      const result = validateDataChannelMessage({
        type: 'file_start',
        fileId: 'file-123',
        fileName: 'test.txt',
        totalSize: -1,
        totalChunks: 10,
      });
      expect(result.success).toBe(false);
    });

    it('should reject file_start with zero totalChunks', () => {
      const result = validateDataChannelMessage({
        type: 'file_start',
        fileId: 'file-123',
        fileName: 'test.txt',
        totalSize: 1024,
        totalChunks: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should reject file_start with too many totalChunks', () => {
      const result = validateDataChannelMessage({
        type: 'file_start',
        fileId: 'file-123',
        fileName: 'test.txt',
        totalSize: 1024,
        totalChunks: 1000001, // Exceeds 1000000 limit
      });
      expect(result.success).toBe(false);
    });

    it('should reject file_start with too long fileName', () => {
      const result = validateDataChannelMessage({
        type: 'file_start',
        fileId: 'file-123',
        fileName: 'x'.repeat(256), // Exceeds 255 chars
        totalSize: 1024,
        totalChunks: 10,
      });
      expect(result.success).toBe(false);
    });

    it('should reject file_start with invalid chunkHash', () => {
      const result = validateDataChannelMessage({
        type: 'file_start',
        fileId: 'file-123',
        fileName: 'test.txt',
        totalSize: 1024,
        totalChunks: 2,
        chunkHashes: ['valid', ''], // Empty hash is invalid
      });
      expect(result.success).toBe(false);
    });
  });

  describe('file_chunk message', () => {
    it('should validate valid file_chunk message', () => {
      const result = validateDataChannelMessage({
        type: 'file_chunk',
        fileId: 'file-123',
        chunkIndex: 5,
        data: 'base64-encoded-data',
      });
      expect(result.success).toBe(true);
    });

    it('should validate file_chunk with optional hash', () => {
      const result = validateDataChannelMessage({
        type: 'file_chunk',
        fileId: 'file-123',
        chunkIndex: 5,
        data: 'base64-encoded-data',
        hash: 'chunk-hash',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hash).toBe('chunk-hash');
      }
    });

    it('should reject file_chunk with negative chunkIndex', () => {
      const result = validateDataChannelMessage({
        type: 'file_chunk',
        fileId: 'file-123',
        chunkIndex: -1,
        data: 'data',
      });
      expect(result.success).toBe(false);
    });

    it('should reject file_chunk without data', () => {
      const result = validateDataChannelMessage({
        type: 'file_chunk',
        fileId: 'file-123',
        chunkIndex: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('file_complete message', () => {
    it('should validate valid file_complete message', () => {
      const result = validateDataChannelMessage({
        type: 'file_complete',
        fileId: 'file-123',
      });
      expect(result.success).toBe(true);
    });

    it('should validate file_complete with optional fileHash', () => {
      const result = validateDataChannelMessage({
        type: 'file_complete',
        fileId: 'file-123',
        fileHash: 'final-hash',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fileHash).toBe('final-hash');
      }
    });

    it('should reject file_complete without fileId', () => {
      const result = validateDataChannelMessage({ type: 'file_complete' });
      expect(result.success).toBe(false);
    });
  });

  describe('file_error message', () => {
    it('should validate valid file_error message', () => {
      const result = validateDataChannelMessage({
        type: 'file_error',
        fileId: 'file-123',
        error: 'Transfer failed',
      });
      expect(result.success).toBe(true);
    });

    it('should reject file_error without error', () => {
      const result = validateDataChannelMessage({
        type: 'file_error',
        fileId: 'file-123',
      });
      expect(result.success).toBe(false);
    });

    it('should reject file_error with too long error message', () => {
      const result = validateDataChannelMessage({
        type: 'file_error',
        fileId: 'file-123',
        error: 'x'.repeat(1001),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('file_start_ack message', () => {
    it('should validate valid file_start_ack message', () => {
      const result = validateDataChannelMessage({
        type: 'file_start_ack',
        fileId: 'file-123',
        accepted: true,
      });
      expect(result.success).toBe(true);
    });

    it('should validate file_start_ack with rejection reason', () => {
      const result = validateDataChannelMessage({
        type: 'file_start_ack',
        fileId: 'file-123',
        accepted: false,
        reason: 'File too large',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reason).toBe('File too large');
      }
    });

    it('should reject file_start_ack with non-boolean accepted', () => {
      const result = validateDataChannelMessage({
        type: 'file_start_ack',
        fileId: 'file-123',
        accepted: 'true', // String instead of boolean
      });
      expect(result.success).toBe(false);
    });
  });

  describe('chunk_ack message', () => {
    it('should validate valid chunk_ack with received status', () => {
      const result = validateDataChannelMessage({
        type: 'chunk_ack',
        fileId: 'file-123',
        chunkIndex: 5,
        status: 'received',
      });
      expect(result.success).toBe(true);
    });

    it('should validate chunk_ack with failed status', () => {
      const result = validateDataChannelMessage({
        type: 'chunk_ack',
        fileId: 'file-123',
        chunkIndex: 5,
        status: 'failed',
      });
      expect(result.success).toBe(true);
    });

    it('should validate chunk_ack with optional hash', () => {
      const result = validateDataChannelMessage({
        type: 'chunk_ack',
        fileId: 'file-123',
        chunkIndex: 5,
        status: 'received',
        hash: 'chunk-hash',
      });
      expect(result.success).toBe(true);
    });

    it('should reject chunk_ack with invalid status', () => {
      const result = validateDataChannelMessage({
        type: 'chunk_ack',
        fileId: 'file-123',
        chunkIndex: 5,
        status: 'pending', // Invalid status
      });
      expect(result.success).toBe(false);
    });
  });

  describe('chunk_retry message', () => {
    it('should validate valid chunk_retry message', () => {
      const result = validateDataChannelMessage({
        type: 'chunk_retry',
        fileId: 'file-123',
        chunkIndices: [0, 5, 10],
      });
      expect(result.success).toBe(true);
    });

    it('should reject chunk_retry with non-array chunkIndices', () => {
      const result = validateDataChannelMessage({
        type: 'chunk_retry',
        fileId: 'file-123',
        chunkIndices: '0,5,10', // String instead of array
      });
      expect(result.success).toBe(false);
    });

    it('should reject chunk_retry with invalid chunk index', () => {
      const result = validateDataChannelMessage({
        type: 'chunk_retry',
        fileId: 'file-123',
        chunkIndices: [0, -1, 5], // Negative index
      });
      expect(result.success).toBe(false);
    });

    it('should reject chunk_retry with non-integer chunk index', () => {
      const result = validateDataChannelMessage({
        type: 'chunk_retry',
        fileId: 'file-123',
        chunkIndices: [0, 5.5, 10], // Float index
      });
      expect(result.success).toBe(false);
    });
  });

  describe('file_complete_ack message', () => {
    it('should validate valid file_complete_ack with success status', () => {
      const result = validateDataChannelMessage({
        type: 'file_complete_ack',
        fileId: 'file-123',
        status: 'success',
      });
      expect(result.success).toBe(true);
    });

    it('should validate file_complete_ack with failed status and missing chunks', () => {
      const result = validateDataChannelMessage({
        type: 'file_complete_ack',
        fileId: 'file-123',
        status: 'failed',
        missingChunks: [2, 5, 8],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.missingChunks).toEqual([2, 5, 8]);
      }
    });

    it('should validate file_complete_ack with optional fileHash', () => {
      const result = validateDataChannelMessage({
        type: 'file_complete_ack',
        fileId: 'file-123',
        status: 'success',
        fileHash: 'final-hash',
      });
      expect(result.success).toBe(true);
    });

    it('should reject file_complete_ack with invalid status', () => {
      const result = validateDataChannelMessage({
        type: 'file_complete_ack',
        fileId: 'file-123',
        status: 'pending', // Invalid status
      });
      expect(result.success).toBe(false);
    });

    it('should reject file_complete_ack with invalid missing chunk index', () => {
      const result = validateDataChannelMessage({
        type: 'file_complete_ack',
        fileId: 'file-123',
        status: 'failed',
        missingChunks: [2, -1, 8], // Negative index
      });
      expect(result.success).toBe(false);
    });
  });

  describe('transfer_cancel message', () => {
    it('should validate valid transfer_cancel with user_cancelled reason', () => {
      const result = validateDataChannelMessage({
        type: 'transfer_cancel',
        fileId: 'file-123',
        reason: 'user_cancelled',
      });
      expect(result.success).toBe(true);
    });

    it('should validate transfer_cancel with error reason', () => {
      const result = validateDataChannelMessage({
        type: 'transfer_cancel',
        fileId: 'file-123',
        reason: 'error',
      });
      expect(result.success).toBe(true);
    });

    it('should validate transfer_cancel with timeout reason', () => {
      const result = validateDataChannelMessage({
        type: 'transfer_cancel',
        fileId: 'file-123',
        reason: 'timeout',
      });
      expect(result.success).toBe(true);
    });

    it('should reject transfer_cancel with invalid reason', () => {
      const result = validateDataChannelMessage({
        type: 'transfer_cancel',
        fileId: 'file-123',
        reason: 'invalid_reason',
      });
      expect(result.success).toBe(false);
    });

    it('should reject transfer_cancel without reason', () => {
      const result = validateDataChannelMessage({
        type: 'transfer_cancel',
        fileId: 'file-123',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('validateHandshake', () => {
  it('should validate valid handshake', () => {
    const result = validateHandshake({
      type: 'handshake',
      publicKey: VALID_PUBLIC_KEY,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('handshake');
      expect(result.data.publicKey).toBe(VALID_PUBLIC_KEY);
    }
  });

  it('should reject non-handshake messages', () => {
    const result = validateHandshake({
      type: 'file_start',
      fileId: 'file-123',
      fileName: 'test.txt',
      totalSize: 1024,
      totalChunks: 10,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Not a handshake');
    }
  });

  it('should reject non-object values', () => {
    expect(validateHandshake(null).success).toBe(false);
    expect(validateHandshake('string').success).toBe(false);
    expect(validateHandshake(123).success).toBe(false);
  });

  it('should reject handshake with invalid public key', () => {
    const result = validateHandshake({
      type: 'handshake',
      publicKey: 'short', // Less than 32 chars
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid stableId in handshake', () => {
    const result = validateHandshake({
      type: 'handshake',
      publicKey: VALID_PUBLIC_KEY,
      stableId: 'a1b2c3d4e5f67890',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stableId).toBe('a1b2c3d4e5f67890');
    }
  });

  it('should silently drop invalid stableId in handshake', () => {
    const result = validateHandshake({
      type: 'handshake',
      publicKey: VALID_PUBLIC_KEY,
      stableId: 'not-hex!!',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stableId).toBeUndefined();
    }
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: 'value' });
    expect(safeJsonParse('123')).toBe(123);
    expect(safeJsonParse('"string"')).toBe('string');
    expect(safeJsonParse('null')).toBe(null);
    expect(safeJsonParse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('should return null for invalid JSON', () => {
    expect(safeJsonParse('not valid json')).toBe(null);
    expect(safeJsonParse('{invalid}')).toBe(null);
    expect(safeJsonParse("{'single': 'quotes'}")).toBe(null);
    expect(safeJsonParse('')).toBe(null);
    expect(safeJsonParse(undefined as unknown as string)).toBe(null);
  });

  it('should handle edge cases', () => {
    expect(safeJsonParse('{}')).toEqual({});
    expect(safeJsonParse('[]')).toEqual([]);
    expect(safeJsonParse('false')).toBe(false);
    expect(safeJsonParse('true')).toBe(true);
    expect(safeJsonParse('0')).toBe(0);
  });
});

// Call signaling message validators
describe('Call signaling message validators', () => {
  // Valid test data
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
  const VALID_CALL_SDP = 'v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
  const VALID_ICE_CANDIDATE = JSON.stringify({ candidate: 'candidate:123', sdpMid: '0' });

  describe('call_offer message', () => {
    it('should validate valid call_offer message', () => {
      const result = validateServerMessage({
        type: 'call_offer',
        callId: VALID_UUID,
        from: 'peer123',
        sdp: VALID_CALL_SDP,
        withVideo: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('call_offer');
      }
    });

    it('should validate call_offer with withVideo false', () => {
      const result = validateServerMessage({
        type: 'call_offer',
        callId: VALID_UUID,
        from: 'peer123',
        sdp: VALID_CALL_SDP,
        withVideo: false,
      });
      expect(result.success).toBe(true);
    });

    it('should reject call_offer with invalid UUID', () => {
      const result = validateServerMessage({
        type: 'call_offer',
        callId: 'not-a-uuid',
        from: 'peer123',
        sdp: VALID_CALL_SDP,
        withVideo: true,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('callId');
      }
    });

    it('should reject call_offer with empty from', () => {
      const result = validateServerMessage({
        type: 'call_offer',
        callId: VALID_UUID,
        from: '',
        sdp: VALID_CALL_SDP,
        withVideo: true,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('from');
      }
    });

    it('should reject call_offer with invalid SDP', () => {
      const result = validateServerMessage({
        type: 'call_offer',
        callId: VALID_UUID,
        from: 'peer123',
        sdp: 'invalid-sdp',
        withVideo: true,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('sdp');
      }
    });

    it('should reject call_offer with missing withVideo', () => {
      const result = validateServerMessage({
        type: 'call_offer',
        callId: VALID_UUID,
        from: 'peer123',
        sdp: VALID_CALL_SDP,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('withVideo');
      }
    });

    it('should reject call_offer with non-boolean withVideo', () => {
      const result = validateServerMessage({
        type: 'call_offer',
        callId: VALID_UUID,
        from: 'peer123',
        sdp: VALID_CALL_SDP,
        withVideo: 'true',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('call_answer message', () => {
    it('should validate valid call_answer message', () => {
      const result = validateServerMessage({
        type: 'call_answer',
        callId: VALID_UUID,
        from: 'peer123',
        sdp: VALID_CALL_SDP,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('call_answer');
      }
    });

    it('should reject call_answer with invalid UUID', () => {
      const result = validateServerMessage({
        type: 'call_answer',
        callId: 'invalid',
        from: 'peer123',
        sdp: VALID_CALL_SDP,
      });
      expect(result.success).toBe(false);
    });

    it('should reject call_answer with empty SDP', () => {
      const result = validateServerMessage({
        type: 'call_answer',
        callId: VALID_UUID,
        from: 'peer123',
        sdp: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject call_answer with malformed SDP', () => {
      const result = validateServerMessage({
        type: 'call_answer',
        callId: VALID_UUID,
        from: 'peer123',
        sdp: 'v=1\r\nmalformed',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('call_reject message', () => {
    it('should validate valid call_reject message without reason', () => {
      const result = validateServerMessage({
        type: 'call_reject',
        callId: VALID_UUID,
        from: 'peer123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('call_reject');
      }
    });

    it('should validate call_reject with busy reason', () => {
      const result = validateServerMessage({
        type: 'call_reject',
        callId: VALID_UUID,
        from: 'peer123',
        reason: 'busy',
      });
      expect(result.success).toBe(true);
    });

    it('should validate call_reject with declined reason', () => {
      const result = validateServerMessage({
        type: 'call_reject',
        callId: VALID_UUID,
        from: 'peer123',
        reason: 'declined',
      });
      expect(result.success).toBe(true);
    });

    it('should validate call_reject with timeout reason', () => {
      const result = validateServerMessage({
        type: 'call_reject',
        callId: VALID_UUID,
        from: 'peer123',
        reason: 'timeout',
      });
      expect(result.success).toBe(true);
    });

    it('should reject call_reject with invalid reason', () => {
      const result = validateServerMessage({
        type: 'call_reject',
        callId: VALID_UUID,
        from: 'peer123',
        reason: 'invalid_reason',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('reason');
      }
    });

    it('should reject call_reject with invalid UUID', () => {
      const result = validateServerMessage({
        type: 'call_reject',
        callId: 'bad-uuid',
        from: 'peer123',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('call_hangup message', () => {
    it('should validate valid call_hangup message', () => {
      const result = validateServerMessage({
        type: 'call_hangup',
        callId: VALID_UUID,
        from: 'peer123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('call_hangup');
      }
    });

    it('should reject call_hangup with invalid UUID', () => {
      const result = validateServerMessage({
        type: 'call_hangup',
        callId: 'not-uuid',
        from: 'peer123',
      });
      expect(result.success).toBe(false);
    });

    it('should reject call_hangup with empty from', () => {
      const result = validateServerMessage({
        type: 'call_hangup',
        callId: VALID_UUID,
        from: '',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('call_ice message', () => {
    it('should validate valid call_ice message', () => {
      const result = validateServerMessage({
        type: 'call_ice',
        callId: VALID_UUID,
        from: 'peer123',
        candidate: VALID_ICE_CANDIDATE,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('call_ice');
      }
    });

    it('should reject call_ice with invalid UUID', () => {
      const result = validateServerMessage({
        type: 'call_ice',
        callId: 'bad',
        from: 'peer123',
        candidate: VALID_ICE_CANDIDATE,
      });
      expect(result.success).toBe(false);
    });

    it('should reject call_ice with invalid JSON candidate', () => {
      const result = validateServerMessage({
        type: 'call_ice',
        callId: VALID_UUID,
        from: 'peer123',
        candidate: 'not-valid-json',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('candidate');
      }
    });

    it('should reject call_ice with empty candidate', () => {
      const result = validateServerMessage({
        type: 'call_ice',
        callId: VALID_UUID,
        from: 'peer123',
        candidate: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject call_ice without candidate', () => {
      const result = validateServerMessage({
        type: 'call_ice',
        callId: VALID_UUID,
        from: 'peer123',
      });
      expect(result.success).toBe(false);
    });
  });
});
