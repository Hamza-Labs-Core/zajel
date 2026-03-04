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

/**
 * Format hash bytes into a 60-digit safety number.
 * Takes pairs of bytes, converts to a 5-digit number (mod 100000).
 */
function formatSafetyNumber(hashBytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < 24 && i + 1 < hashBytes.length; i += 2) {
    const val = ((hashBytes[i] << 8) | hashBytes[i + 1]) % 100000;
    result += val.toString().padStart(5, '0');
  }
  return result.substring(0, 60);
}

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Nonce-based replay protection.
 *
 * Tracks seen nonces per peer to detect replayed ciphertexts.
 * Each message uses a random 12-byte nonce — replaying the exact same
 * ciphertext reuses the same nonce, which we detect via a bounded Set.
 *
 * This matches the Dart and Python clients' replay detection approach
 * and ensures cross-client interop (no sequence number in wire format).
 *
 * Memory: bounded to MAX_NONCE_HISTORY per peer (~30 bytes × 10000 = ~300KB).
 */
const MAX_NONCE_HISTORY = 10000;

export class CryptoService {
  private keyPair: KeyPair | null = null;
  private sessionKeys = new Map<string, Uint8Array>();
  // Nonce-based replay detection (matches Dart/Python wire format — no sequence numbers)
  private seenNonces = new Map<string, Set<string>>();
  private seenNoncesBytes = new Map<string, Set<string>>();
  // Store peer public keys for handshake verification (prevents MITM attacks)
  private peerPublicKeys = new Map<string, string>();
  // Track session creation time for expiration (forward secrecy)
  private sessionCreatedAt = new Map<string, number>();

  // ML-KEM-768 post-quantum key exchange fields
  // Note: Web client ML-KEM support requires @noble/post-quantum package.
  // When the package is not installed, mlKemAvailable will be false and
  // the client falls back to classical X25519-only.
  private mlKemKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array } | null = null;
  private peerMlKemPublicKeys = new Map<string, Uint8Array>();
  private peerProtocolVersions = new Map<string, number>();
  private _mlKemAvailable = false;

  /**
   * Check if a nonce has been seen before (replay detection).
   *
   * @param nonceMap - The map of seen-nonce sets to use
   * @param peerId - The peer identifier
   * @param nonce - The 12-byte nonce from the ciphertext
   * @returns true if nonce is new (not a replay), false if replay detected
   */
  private checkAndRecordNonce(
    nonceMap: Map<string, Set<string>>,
    peerId: string,
    nonce: Uint8Array
  ): boolean {
    let seen = nonceMap.get(peerId);
    if (!seen) {
      seen = new Set<string>();
      nonceMap.set(peerId, seen);
    }

    const nonceHex = bytesToHex(nonce);
    if (seen.has(nonceHex)) {
      return false; // Replay detected
    }

    seen.add(nonceHex);

    // Evict oldest half when set grows too large
    if (seen.size > MAX_NONCE_HISTORY) {
      const entries = Array.from(seen);
      const keep = entries.slice(entries.length >> 1);
      nonceMap.set(peerId, new Set(keep));
    }

    return true;
  }

  /**
   * Check if a session has expired.
   * Sessions expire after SESSION_KEY_EXPIRY_MS (24 hours by default) for forward secrecy.
   *
   * @param peerId - The peer identifier
   * @returns true if the session has expired or doesn't exist, false otherwise
   */
  private isSessionExpired(peerId: string): boolean {
    const createdAt = this.sessionCreatedAt.get(peerId);
    if (!createdAt) return true;
    return Date.now() - createdAt > CRYPTO.SESSION_KEY_EXPIRY_MS;
  }

  /** Encode Uint8Array to base64 (safe for large arrays like ML-KEM keys). */
  private static uint8ToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Decode base64 to Uint8Array. */
  private static base64ToUint8(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /** Whether ML-KEM hybrid key exchange is available. */
  get mlKemAvailable(): boolean {
    return this._mlKemAvailable;
  }

  /** Get our ML-KEM public key as base64, or null if unavailable. */
  getMlKemPublicKeyBase64(): string | null {
    if (!this.mlKemKeyPair) return null;
    return CryptoService.uint8ToBase64(this.mlKemKeyPair.publicKey);
  }

  /** Get the protocol version for a specific peer's session. */
  getPeerProtocolVersion(peerId: string): number | undefined {
    return this.peerProtocolVersions.get(peerId);
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

    // ML-KEM initialization: requires @noble/post-quantum package
    // If not available, fall back to classical X25519-only
    try {
      const { ml_kem768 } = await import('@noble/post-quantum/ml-kem.js');
      const seed = crypto.getRandomValues(new Uint8Array(64));
      const [mlKemPub, mlKemSec] = ml_kem768.keygen(seed);
      this.mlKemKeyPair = { publicKey: mlKemPub, secretKey: mlKemSec };
      this._mlKemAvailable = true;
    } catch {
      // @noble/post-quantum not installed or keygen failed
      this._mlKemAvailable = false;
    }
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

  /**
   * Compute a shared safety number from two public keys.
   *
   * Both peers compute the same number by sorting keys lexicographically
   * before hashing. Returns a 60-digit string.
   */
  static computeSafetyNumber(publicKeyABase64: string, publicKeyBBase64: string): string {
    const bytesA = Uint8Array.from(atob(publicKeyABase64), (c) => c.charCodeAt(0));
    const bytesB = Uint8Array.from(atob(publicKeyBBase64), (c) => c.charCodeAt(0));

    // Sort lexicographically
    let cmp = 0;
    for (let i = 0; i < Math.min(bytesA.length, bytesB.length) && cmp === 0; i++) {
      cmp = bytesA[i] - bytesB[i];
    }
    if (cmp === 0) cmp = bytesA.length - bytesB.length;

    const combined = new Uint8Array(bytesA.length + bytesB.length);
    if (cmp <= 0) {
      combined.set(bytesA, 0);
      combined.set(bytesB, bytesA.length);
    } else {
      combined.set(bytesB, 0);
      combined.set(bytesA, bytesB.length);
    }

    const hash = sha256(combined);
    return formatSafetyNumber(hash);
  }

  /**
   * Format a safety number for display as groups of 5 digits.
   */
  static formatSafetyNumberForDisplay(safetyNumber: string): string {
    const groups: string[] = [];
    for (let i = 0; i < safetyNumber.length; i += 5) {
      groups.push(safetyNumber.substring(i, i + 5));
    }
    const lines: string[] = [];
    for (let i = 0; i < groups.length; i += 4) {
      lines.push(groups.slice(i, i + 4).join(' '));
    }
    return lines.join('\n');
  }

  /**
   * Establish a session with a peer using X25519 key exchange.
   *
   * This is the classical (non-hybrid) session establishment.
   * For hybrid X25519 + ML-KEM-768 sessions, use establishHybridSession().
   */
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
    const info = new TextEncoder().encode('zajel_session');
    const sessionKey = hkdf(sha256, sharedSecret, undefined, info, 32);

    this.sessionKeys.set(peerId, sessionKey);
    this.peerProtocolVersions.set(peerId, CRYPTO.PROTOCOL_VERSION_CLASSICAL);
    // Record session creation time for expiration tracking
    this.sessionCreatedAt.set(peerId, Date.now());
  }

  /**
   * Establish a hybrid X25519 + ML-KEM-768 session with a peer.
   *
   * Combines classical X25519 ECDH with post-quantum ML-KEM-768 KEM:
   * session_key = HKDF-SHA256(x25519_secret || mlkem_secret, "zajel_hybrid_session")
   *
   * @param peerId - The peer identifier
   * @param peerX25519PublicKeyBase64 - Peer's X25519 public key (base64)
   * @param peerMlKemPublicKeyBase64 - Peer's ML-KEM-768 public key (base64)
   * @param role - "initiator" (encapsulate) or "responder" (decapsulate)
   * @param mlKemCiphertextBase64 - ML-KEM ciphertext (base64, required for responder)
   * @returns Object with optional ciphertext (non-null for initiator)
   */
  async establishHybridSession(
    peerId: string,
    peerX25519PublicKeyBase64: string,
    peerMlKemPublicKeyBase64: string,
    role: 'initiator' | 'responder',
    mlKemCiphertextBase64?: string,
  ): Promise<{ ciphertext?: string }> {
    if (!this.keyPair) {
      throw new CryptoError('CryptoService not initialized', ErrorCodes.CRYPTO_NOT_INITIALIZED);
    }
    if (!this._mlKemAvailable || !this.mlKemKeyPair) {
      throw new CryptoError('ML-KEM not available for hybrid key exchange', ErrorCodes.CRYPTO_NOT_INITIALIZED);
    }

    // 1. X25519 ECDH
    const peerX25519Key = CryptoService.base64ToUint8(peerX25519PublicKeyBase64);
    if (peerX25519Key.length !== CRYPTO.X25519_KEY_SIZE) {
      throw new CryptoError(
        `Invalid X25519 key size: ${peerX25519Key.length}`,
        ErrorCodes.CRYPTO_INVALID_KEY
      );
    }
    this.peerPublicKeys.set(peerId, peerX25519PublicKeyBase64);
    const x25519SharedSecret = x25519.getSharedSecret(
      this.keyPair.privateKey,
      peerX25519Key
    );

    // 2. ML-KEM encapsulation or decapsulation
    const { ml_kem768 } = await import('@noble/post-quantum/ml-kem.js');
    const peerMlKemKey = CryptoService.base64ToUint8(peerMlKemPublicKeyBase64);
    let mlKemSharedSecret: Uint8Array;
    let mlKemCiphertext: Uint8Array | undefined;

    if (role === 'initiator') {
      const [ct, ss] = ml_kem768.encapsulate(peerMlKemKey);
      mlKemCiphertext = ct;
      mlKemSharedSecret = ss;
    } else {
      if (!mlKemCiphertextBase64) {
        throw new CryptoError('mlKemCiphertextBase64 required for responder role', ErrorCodes.CRYPTO_INVALID_KEY);
      }
      const ct = CryptoService.base64ToUint8(mlKemCiphertextBase64);
      mlKemSharedSecret = ml_kem768.decapsulate(ct, this.mlKemKeyPair.secretKey);
    }

    // 3. Combine secrets: X25519 || ML-KEM
    const combinedSecret = new Uint8Array(x25519SharedSecret.length + mlKemSharedSecret.length);
    combinedSecret.set(x25519SharedSecret, 0);
    combinedSecret.set(mlKemSharedSecret, x25519SharedSecret.length);

    // 4. Derive session key via HKDF with hybrid info string
    const info = new TextEncoder().encode('zajel_hybrid_session');
    const sessionKey = hkdf(sha256, combinedSecret, undefined, info, 32);

    this.sessionKeys.set(peerId, sessionKey);
    this.peerProtocolVersions.set(peerId, CRYPTO.PROTOCOL_VERSION_HYBRID);
    this.sessionCreatedAt.set(peerId, Date.now());

    if (mlKemCiphertext) {
      return { ciphertext: CryptoService.uint8ToBase64(mlKemCiphertext) };
    }
    return {};
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
    this.seenNonces.delete(peerId);
    this.seenNoncesBytes.delete(peerId);
    this.sessionCreatedAt.delete(peerId);
  }

  encrypt(peerId: string, plaintext: string): string {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) {
      throw new CryptoError(`No session for peer: ${peerId}`, ErrorCodes.CRYPTO_NO_SESSION);
    }

    // Check session expiration for forward secrecy
    if (this.isSessionExpired(peerId)) {
      throw new CryptoError('Session expired, please reconnect', ErrorCodes.CRYPTO_SESSION_EXPIRED);
    }

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const nonce = crypto.getRandomValues(new Uint8Array(CRYPTO.NONCE_SIZE));

    const cipher = chacha20poly1305(sessionKey, nonce);
    const ciphertext = cipher.encrypt(plaintextBytes);

    // Wire format: nonce(12) + ciphertext (includes 16-byte MAC)
    // Matches Dart and Python clients for cross-client interop
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

    // Check session expiration for forward secrecy
    if (this.isSessionExpired(peerId)) {
      throw new CryptoError('Session expired, please reconnect', ErrorCodes.CRYPTO_SESSION_EXPIRED);
    }

    const data = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));

    // Extract nonce and ciphertext
    const nonce = data.slice(0, CRYPTO.NONCE_SIZE);
    const ciphertext = data.slice(CRYPTO.NONCE_SIZE);

    // Nonce-based replay detection: reject if we've seen this nonce before
    if (!this.checkAndRecordNonce(this.seenNonces, peerId, nonce)) {
      throw new CryptoError('Replay attack detected', ErrorCodes.CRYPTO_REPLAY_DETECTED);
    }

    const cipher = chacha20poly1305(sessionKey, nonce);
    const plaintextBytes = cipher.decrypt(ciphertext);

    return new TextDecoder().decode(plaintextBytes);
  }

  encryptBytes(peerId: string, data: Uint8Array): Uint8Array {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) {
      throw new CryptoError(`No session for peer: ${peerId}`, ErrorCodes.CRYPTO_NO_SESSION);
    }

    // Check session expiration for forward secrecy
    if (this.isSessionExpired(peerId)) {
      throw new CryptoError('Session expired, please reconnect', ErrorCodes.CRYPTO_SESSION_EXPIRED);
    }

    const nonce = crypto.getRandomValues(new Uint8Array(CRYPTO.NONCE_SIZE));
    const cipher = chacha20poly1305(sessionKey, nonce);
    const ciphertext = cipher.encrypt(data);

    // Wire format: nonce(12) + ciphertext (includes 16-byte MAC)
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

    // Check session expiration for forward secrecy
    if (this.isSessionExpired(peerId)) {
      throw new CryptoError('Session expired, please reconnect', ErrorCodes.CRYPTO_SESSION_EXPIRED);
    }

    const nonce = data.slice(0, CRYPTO.NONCE_SIZE);
    const ciphertext = data.slice(CRYPTO.NONCE_SIZE);

    // Nonce-based replay detection for binary channel
    if (!this.checkAndRecordNonce(this.seenNoncesBytes, peerId, nonce)) {
      throw new CryptoError('Replay attack detected', ErrorCodes.CRYPTO_REPLAY_DETECTED);
    }

    const cipher = chacha20poly1305(sessionKey, nonce);
    return cipher.decrypt(ciphertext);
  }
}

// Singleton instance
export const cryptoService = new CryptoService();
