import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const STORAGE_KEY = 'zajel_identity';
const NONCE_SIZE = 12;

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export class CryptoService {
  private keyPair: KeyPair | null = null;
  private sessionKeys = new Map<string, Uint8Array>();

  async initialize(): Promise<void> {
    // Try to load existing keys
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const { privateKey } = JSON.parse(stored);
        const privateKeyBytes = hexToBytes(privateKey);
        const publicKey = x25519.getPublicKey(privateKeyBytes);
        this.keyPair = { privateKey: privateKeyBytes, publicKey };
        return;
      } catch {
        // Invalid stored data, generate new
      }
    }

    // Generate new key pair
    const privateKey = x25519.utils.randomPrivateKey();
    const publicKey = x25519.getPublicKey(privateKey);
    this.keyPair = { privateKey, publicKey };

    // Store for persistence
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ privateKey: bytesToHex(privateKey) })
    );
  }

  getPublicKeyBase64(): string {
    if (!this.keyPair) throw new Error('CryptoService not initialized');
    return btoa(String.fromCharCode(...this.keyPair.publicKey));
  }

  getPublicKeyHex(): string {
    if (!this.keyPair) throw new Error('CryptoService not initialized');
    return bytesToHex(this.keyPair.publicKey);
  }

  establishSession(peerId: string, peerPublicKeyBase64: string): void {
    if (!this.keyPair) throw new Error('CryptoService not initialized');

    // Decode peer's public key
    const peerPublicKey = Uint8Array.from(atob(peerPublicKeyBase64), (c) =>
      c.charCodeAt(0)
    );

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
  }

  encrypt(peerId: string, plaintext: string): string {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) throw new Error(`No session for peer: ${peerId}`);

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));

    const cipher = chacha20poly1305(sessionKey, nonce);
    const ciphertext = cipher.encrypt(plaintextBytes);

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
    const plaintext = cipher.decrypt(ciphertext);

    return new TextDecoder().decode(plaintext);
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
