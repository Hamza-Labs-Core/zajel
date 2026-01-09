import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const NONCE_SIZE = 12;

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
const SEQUENCE_WINDOW = 64; // Size of sliding window for out-of-order delivery

export class CryptoService {
  private keyPair: KeyPair | null = null;
  private sessionKeys = new Map<string, Uint8Array>();
  private sendCounters = new Map<string, number>();
  private receiveCounters = new Map<string, number>();
  // Track seen sequences within the window using a Set per peer
  private seenSequences = new Map<string, Set<number>>();

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
    if (!this.keyPair) throw new Error('CryptoService not initialized');
    return btoa(String.fromCharCode(...this.keyPair.publicKey));
  }

  getPublicKeyHex(): string {
    if (!this.keyPair) throw new Error('CryptoService not initialized');
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
    if (!this.keyPair) throw new Error('CryptoService not initialized');
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
      throw new Error('Invalid peer public key: malformed base64');
    }

    if (peerPublicKey.length !== 32) {
      throw new Error(`Invalid peer public key: expected 32 bytes, got ${peerPublicKey.length}`);
    }

    const hash = sha256(peerPublicKey);
    // Use full 256-bit hash for collision resistance
    return formatFingerprint(bytesToHex(hash));
  }

  // TODO: Implement proper key verification to prevent MITM attacks.
  // Current implementation trusts the signaling server completely, which means:
  // 1. A compromised signaling server could substitute its own public key
  // 2. Users have no way to verify they're talking to the intended peer
  // Recommended improvements:
  // - Display key fingerprints in the UI for out-of-band verification ✓ (implemented)
  // - Implement Safety Numbers (like Signal) for visual verification
  // - Add QR code scanning for in-person key verification
  // - Consider implementing a Trust On First Use (TOFU) model with warnings on key changes
  establishSession(peerId: string, peerPublicKeyBase64: string): void {
    if (!this.keyPair) throw new Error('CryptoService not initialized');

    // Decode and validate peer's public key
    let peerPublicKey: Uint8Array;
    try {
      peerPublicKey = Uint8Array.from(atob(peerPublicKeyBase64), (c) =>
        c.charCodeAt(0)
      );
    } catch {
      throw new Error('Invalid peer public key: malformed base64');
    }

    // X25519 public keys must be exactly 32 bytes
    if (peerPublicKey.length !== 32) {
      throw new Error(`Invalid peer public key: expected 32 bytes, got ${peerPublicKey.length}`);
    }

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

  clearSession(peerId: string): void {
    this.sessionKeys.delete(peerId);
    this.sendCounters.delete(peerId);
    this.receiveCounters.delete(peerId);
    this.seenSequences.delete(peerId);
  }

  encrypt(peerId: string, plaintext: string): string {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) throw new Error(`No session for peer: ${peerId}`);

    // Increment and get sequence number for replay protection
    const seq = (this.sendCounters.get(peerId) || 0) + 1;
    this.sendCounters.set(peerId, seq);

    // Prepend 4-byte sequence number to plaintext (big-endian)
    const seqBytes = new Uint8Array(4);
    new DataView(seqBytes.buffer).setUint32(0, seq, false);

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const combined = new Uint8Array(4 + plaintextBytes.length);
    combined.set(seqBytes);
    combined.set(plaintextBytes, 4);

    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));

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
    if (!sessionKey) throw new Error(`No session for peer: ${peerId}`);

    const data = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));

    // Extract nonce and ciphertext
    const nonce = data.slice(0, NONCE_SIZE);
    const ciphertext = data.slice(NONCE_SIZE);

    const cipher = chacha20poly1305(sessionKey, nonce);
    const combined = cipher.decrypt(ciphertext);

    // Extract and verify sequence number for replay protection
    const seq = new DataView(combined.buffer, combined.byteOffset, 4).getUint32(0, false);
    const lastSeq = this.receiveCounters.get(peerId) || 0;

    // Get or create the seen sequences set for this peer
    let seen = this.seenSequences.get(peerId);
    if (!seen) {
      seen = new Set<number>();
      this.seenSequences.set(peerId, seen);
    }

    // Check for replay attacks using sliding window
    if (seq > lastSeq) {
      // New highest sequence - advance the window
      // Clear sequences that are now outside the window
      const newWindowStart = seq - SEQUENCE_WINDOW;
      for (const oldSeq of seen) {
        if (oldSeq <= newWindowStart) {
          seen.delete(oldSeq);
        }
      }
      // Update the counter and mark as seen
      this.receiveCounters.set(peerId, seq);
      seen.add(seq);
    } else if (seq <= lastSeq - SEQUENCE_WINDOW) {
      // Sequence is too old (outside the window)
      throw new Error('Replay attack detected: sequence too old');
    } else {
      // Sequence is within the window - check if already seen
      if (seen.has(seq)) {
        throw new Error('Replay attack detected: duplicate sequence number');
      }
      // Mark as seen (allow out-of-order delivery within window)
      seen.add(seq);
    }

    // Extract plaintext (skip 4-byte sequence number)
    const plaintextBytes = combined.slice(4);
    return new TextDecoder().decode(plaintextBytes);
  }

  encryptBytes(peerId: string, data: Uint8Array): Uint8Array {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) throw new Error(`No session for peer: ${peerId}`);

    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
    const cipher = chacha20poly1305(sessionKey, nonce);
    const ciphertext = cipher.encrypt(data);

    const result = new Uint8Array(nonce.length + ciphertext.length);
    result.set(nonce);
    result.set(ciphertext, nonce.length);

    return result;
  }

  decryptBytes(peerId: string, data: Uint8Array): Uint8Array {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) throw new Error(`No session for peer: ${peerId}`);

    const nonce = data.slice(0, NONCE_SIZE);
    const ciphertext = data.slice(NONCE_SIZE);

    const cipher = chacha20poly1305(sessionKey, nonce);
    return cipher.decrypt(ciphertext);
  }
}

// Singleton instance
export const cryptoService = new CryptoService();
