import { x25519 } from '@noble/curves/ed25519';
import { CRYPTO } from './constants';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { CryptoError, ErrorCodes } from './errors';


/**
 * Formats a key fingerprint for human-readable display.
 * Groups hex bytes into 4-character chunks separated by spaces.
 */
function formatFingerprint(hex: string): string {
  return hex.match(/.{1,4}/g)?.join(' ').toUpperCase() || hex.toUpperCase();
}

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

// Replay protection constants

/**
 * Bitmap-based sliding window for replay protection.
 * Uses RFC 4303 (IPsec ESP) anti-replay algorithm.
 * Memory: O(1) - fixed ~12 bytes per peer instead of unbounded Set growth.
 */
interface ReplayWindow {
  highestSeq: number;  // Highest sequence number seen
  bitmap: bigint;      // 64-bit bitmap of seen sequences within window
}

export class CryptoService {
  private keyPair: KeyPair | null = null;
  private sessionKeys = new Map<string, Uint8Array>();
  private sendCounters = new Map<string, number>();
  // Bitmap-based replay windows (replaces Set-based seenSequences + receiveCounters)
  private replayWindows = new Map<string, ReplayWindow>();
  // Separate counters for binary data (file chunks) to avoid interference with text messages
  private sendBytesCounters = new Map<string, number>();
  private replayWindowsBytes = new Map<string, ReplayWindow>();
  // Store peer public keys for handshake verification (prevents MITM attacks)
  private peerPublicKeys = new Map<string, string>();

  /**
   * Check if a sequence number should be accepted (not a replay).
   * Uses RFC 4303 anti-replay algorithm with bitmap sliding window.
   *
   * This approach provides:
   * - O(1) time complexity for all operations
   * - O(1) memory: ~12 bytes per peer regardless of message patterns
   * - No cleanup needed - inherently bounded by bitmap size
   *
   * @param windows - The map of replay windows to use
   * @param peerId - The peer identifier
   * @param seq - The sequence number to check
   * @returns true if sequence is valid (not a replay), false if replay detected
   */
  private checkAndUpdateReplayWindow(
    windows: Map<string, ReplayWindow>,
    peerId: string,
    seq: number
  ): boolean {
    let window = windows.get(peerId);
    if (!window) {
      window = { highestSeq: 0, bitmap: 0n };
      windows.set(peerId, window);
    }

    if (seq === 0) {
      // Sequence 0 is invalid (we start from 1)
      return false;
    }

    if (seq > window.highestSeq) {
      // New highest sequence - advance the window
      const shift = seq - window.highestSeq;
      if (shift >= CRYPTO.SEQUENCE_WINDOW) {
        // Jump is larger than window - reset bitmap, only new seq is set
        window.bitmap = 1n;
      } else {
        // Shift the bitmap and set the new sequence bit
        window.bitmap = (window.bitmap << BigInt(shift)) | 1n;
        // Mask to window size to prevent unbounded growth
        window.bitmap &= (1n << BigInt(CRYPTO.SEQUENCE_WINDOW)) - 1n;
      }
      window.highestSeq = seq;
      return true;
    }

    if (seq <= window.highestSeq - CRYPTO.SEQUENCE_WINDOW) {
      // Sequence is too old (outside the window)
      return false;
    }

    // Sequence is within the window - check if already seen
    const bitPosition = window.highestSeq - seq;
    const bit = 1n << BigInt(bitPosition);

    if ((window.bitmap & bit) !== 0n) {
      // Already seen - replay detected
      return false;
    }

    // Mark as seen and accept
    window.bitmap |= bit;
    return true;
  }

  async initialize(): Promise<void> {
    // Generate ephemeral key pair - keys live only in memory
    // This is the most secure approach for ephemeral messaging:
    // - No storage means no XSS exfiltration from storage APIs
    // - Keys die when the page closes
    // - Page refresh requires re-pairing anyway (WebRTC connection dies)
    const privateKey = x25519.utils.randomPrivateKey();
    const publicKey = x25519.getPublicKey(privateKey);
    this.keyPair = { privateKey, publicKey };
  }

  getPublicKeyBase64(): string {
    if (!this.keyPair) {
      throw new CryptoError('CryptoService not initialized', ErrorCodes.CRYPTO_NOT_INITIALIZED);
    }
    return btoa(String.fromCharCode(...this.keyPair.publicKey));
  }

  getPublicKeyHex(): string {
    if (!this.keyPair) {
      throw new CryptoError('CryptoService not initialized', ErrorCodes.CRYPTO_NOT_INITIALIZED);
    }
    return bytesToHex(this.keyPair.publicKey);
  }

  /**
   * Returns a SHA-256 fingerprint of our public key for out-of-band verification.
   * Users can compare fingerprints through a trusted channel (in person, phone call, etc.)
   * to verify they're communicating with the intended party and not a MITM attacker.
   *
   * Uses the full 256-bit hash for collision resistance (birthday bound at 2^128).
   *
   * @returns A human-readable fingerprint string (uppercase hex, space-separated)
   */
  getPublicKeyFingerprint(): string {
    if (!this.keyPair) {
      throw new CryptoError('CryptoService not initialized', ErrorCodes.CRYPTO_NOT_INITIALIZED);
    }
    const hash = sha256(this.keyPair.publicKey);
    // Use full 256-bit hash for collision resistance
    return formatFingerprint(bytesToHex(hash));
  }

  /**
   * Returns a SHA-256 fingerprint of a peer's public key for out-of-band verification.
   * Compare this with what the peer reports to detect MITM attacks.
   *
   * @param peerPublicKeyBase64 - The peer's public key in base64 format
   * @returns A human-readable fingerprint string (uppercase hex, space-separated)
   * @throws Error if the public key is invalid
   */
  getPeerPublicKeyFingerprint(peerPublicKeyBase64: string): string {
    let peerPublicKey: Uint8Array;
    try {
      peerPublicKey = Uint8Array.from(atob(peerPublicKeyBase64), (c) =>
        c.charCodeAt(0)
      );
    } catch {
      throw new CryptoError('Invalid peer public key: malformed base64', ErrorCodes.CRYPTO_INVALID_KEY);
    }

    if (peerPublicKey.length !== CRYPTO.X25519_KEY_SIZE) {
      throw new CryptoError(
        `Invalid peer public key: expected 32 bytes, got ${peerPublicKey.length}`,
        ErrorCodes.CRYPTO_INVALID_KEY
      );
    }

    const hash = sha256(peerPublicKey);
    // Use full 256-bit hash for collision resistance
    return formatFingerprint(bytesToHex(hash));
  }

  // TODO: Additional key verification improvements:
  // - Implement Safety Numbers (like Signal) for visual verification
  // - Add QR code scanning for in-person key verification
  // - Consider implementing a Trust On First Use (TOFU) model with warnings on key changes
  // Note: Handshake verification is now implemented via verifyPeerKey() method
  establishSession(peerId: string, peerPublicKeyBase64: string): void {
    if (!this.keyPair) {
      throw new CryptoError('CryptoService not initialized', ErrorCodes.CRYPTO_NOT_INITIALIZED);
    }

    // Decode and validate peer's public key
    let peerPublicKey: Uint8Array;
    try {
      peerPublicKey = Uint8Array.from(atob(peerPublicKeyBase64), (c) =>
        c.charCodeAt(0)
      );
    } catch {
      throw new CryptoError('Invalid peer public key: malformed base64', ErrorCodes.CRYPTO_INVALID_KEY);
    }

    // X25519 public keys must be exactly 32 bytes
    if (peerPublicKey.length !== CRYPTO.X25519_KEY_SIZE) {
      throw new CryptoError(
        `Invalid peer public key: expected 32 bytes, got ${peerPublicKey.length}`,
        ErrorCodes.CRYPTO_INVALID_KEY
      );
    }

    // Store peer public key for later handshake verification
    // This allows us to verify the key received over WebRTC matches
    // the key received during signaling (prevents MITM attacks)
    this.peerPublicKeys.set(peerId, peerPublicKeyBase64);

    // Perform ECDH
    const sharedSecret = x25519.getSharedSecret(
      this.keyPair.privateKey,
      peerPublicKey
    );

    // Derive session key using HKDF
    const info = new TextEncoder().encode(`zajel_session_${peerId}`);
    const sessionKey = hkdf(sha256, sharedSecret, undefined, info, 32);

    this.sessionKeys.set(peerId, sessionKey);
  }

  hasSession(peerId: string): boolean {
    return this.sessionKeys.has(peerId);
  }

  /**
   * Verifies that a received public key matches the expected key from signaling.
   * This prevents MITM attacks where an attacker substitutes their own key.
   *
   * Uses constant-time comparison to prevent timing attacks.
   *
   * @param peerId - The peer identifier
   * @param receivedKey - The public key received over WebRTC data channel
   * @returns true if the keys match, false otherwise
   */
  verifyPeerKey(peerId: string, receivedKey: string): boolean {
    const expectedKey = this.peerPublicKeys.get(peerId);
    if (!expectedKey) {
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    // Both keys should be base64 strings of the same length (32-byte keys)
    if (expectedKey.length !== receivedKey.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < expectedKey.length; i++) {
      result |= expectedKey.charCodeAt(i) ^ receivedKey.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Gets the stored peer public key for debugging purposes.
   * Note: In production, avoid logging actual key values.
   *
   * @param peerId - The peer identifier
   * @returns The stored public key or null if not found
   */
  getStoredPeerKey(peerId: string): string | null {
    return this.peerPublicKeys.get(peerId) || null;
  }

  clearSession(peerId: string): void {
    this.sessionKeys.delete(peerId);
    this.peerPublicKeys.delete(peerId);
    this.sendCounters.delete(peerId);
    this.replayWindows.delete(peerId);
    this.sendBytesCounters.delete(peerId);
    this.replayWindowsBytes.delete(peerId);
  }

  encrypt(peerId: string, plaintext: string): string {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) {
      throw new CryptoError(`No session for peer: ${peerId}`, ErrorCodes.CRYPTO_NO_SESSION);
    }

    // Increment and get sequence number for replay protection
    const currentSeq = this.sendCounters.get(peerId) || 0;
    if (currentSeq >= 0xFFFFFFFF) {
      throw new CryptoError('Counter exhausted, session rekeying required', ErrorCodes.CRYPTO_COUNTER_EXHAUSTED);
    }
    const seq = currentSeq + 1;
    this.sendCounters.set(peerId, seq);

    // Prepend 4-byte sequence number to plaintext (big-endian)
    const seqBytes = new Uint8Array(4);
    new DataView(seqBytes.buffer).setUint32(0, seq, false);

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const combined = new Uint8Array(4 + plaintextBytes.length);
    combined.set(seqBytes);
    combined.set(plaintextBytes, 4);

    const nonce = crypto.getRandomValues(new Uint8Array(CRYPTO.NONCE_SIZE));

    const cipher = chacha20poly1305(sessionKey, nonce);
    const ciphertext = cipher.encrypt(combined);

    // Combine: nonce + ciphertext
    const result = new Uint8Array(nonce.length + ciphertext.length);
    result.set(nonce);
    result.set(ciphertext, nonce.length);

    return btoa(String.fromCharCode(...result));
  }

  decrypt(peerId: string, ciphertextBase64: string): string {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) {
      throw new CryptoError(`No session for peer: ${peerId}`, ErrorCodes.CRYPTO_NO_SESSION);
    }

    const data = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));

    // Extract nonce and ciphertext
    const nonce = data.slice(0, CRYPTO.NONCE_SIZE);
    const ciphertext = data.slice(CRYPTO.NONCE_SIZE);

    const cipher = chacha20poly1305(sessionKey, nonce);
    const combined = cipher.decrypt(ciphertext);

    // Extract and verify sequence number for replay protection
    const seq = new DataView(combined.buffer, combined.byteOffset, 4).getUint32(0, false);

    // Check for replay attacks using bitmap sliding window (O(1) memory)
    if (!this.checkAndUpdateReplayWindow(this.replayWindows, peerId, seq)) {
      throw new CryptoError('Replay attack detected', ErrorCodes.CRYPTO_REPLAY_DETECTED);
    }

    // Extract plaintext (skip 4-byte sequence number)
    const plaintextBytes = combined.slice(4);
    return new TextDecoder().decode(plaintextBytes);
  }

  encryptBytes(peerId: string, data: Uint8Array): Uint8Array {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) {
      throw new CryptoError(`No session for peer: ${peerId}`, ErrorCodes.CRYPTO_NO_SESSION);
    }

    // Increment and get sequence number for replay protection
    const currentSeq = this.sendBytesCounters.get(peerId) || 0;
    if (currentSeq >= 0xFFFFFFFF) {
      throw new CryptoError('Counter exhausted, session rekeying required', ErrorCodes.CRYPTO_COUNTER_EXHAUSTED);
    }
    const seq = currentSeq + 1;
    this.sendBytesCounters.set(peerId, seq);

    // Prepend 4-byte sequence number to data (big-endian)
    const seqBytes = new Uint8Array(4);
    new DataView(seqBytes.buffer).setUint32(0, seq, false);

    const combined = new Uint8Array(4 + data.length);
    combined.set(seqBytes);
    combined.set(data, 4);

    const nonce = crypto.getRandomValues(new Uint8Array(CRYPTO.NONCE_SIZE));
    const cipher = chacha20poly1305(sessionKey, nonce);
    const ciphertext = cipher.encrypt(combined);

    const result = new Uint8Array(nonce.length + ciphertext.length);
    result.set(nonce);
    result.set(ciphertext, nonce.length);

    return result;
  }

  decryptBytes(peerId: string, data: Uint8Array): Uint8Array {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) {
      throw new CryptoError(`No session for peer: ${peerId}`, ErrorCodes.CRYPTO_NO_SESSION);
    }

    const nonce = data.slice(0, CRYPTO.NONCE_SIZE);
    const ciphertext = data.slice(CRYPTO.NONCE_SIZE);

    const cipher = chacha20poly1305(sessionKey, nonce);
    const combined = cipher.decrypt(ciphertext);

    // Extract and verify sequence number for replay protection
    const seq = new DataView(combined.buffer, combined.byteOffset, 4).getUint32(0, false);

    // Check for replay attacks using bitmap sliding window (O(1) memory)
    if (!this.checkAndUpdateReplayWindow(this.replayWindowsBytes, peerId, seq)) {
      throw new CryptoError('Replay attack detected', ErrorCodes.CRYPTO_REPLAY_DETECTED);
    }

    // Return data without the 4-byte sequence number
    return combined.slice(4);
  }
}

// Singleton instance
export const cryptoService = new CryptoService();
