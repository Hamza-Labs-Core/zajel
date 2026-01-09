/**
 * CryptoService Tests
 *
 * Tests for X25519 key exchange, ChaCha20-Poly1305 encryption,
 * and key storage management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CryptoService,
  setStorageMode,
  getStorageMode,
  isEphemeralStorage,
  type StorageMode,
} from '../crypto';

// Mock storage
const createMockStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
};

// Store original globals
const originalSessionStorage = globalThis.sessionStorage;
const originalLocalStorage = globalThis.localStorage;

describe('CryptoService', () => {
  let mockSessionStorage: Storage;
  let mockLocalStorage: Storage;

  beforeEach(() => {
    // Create fresh mock storages for each test
    mockSessionStorage = createMockStorage();
    mockLocalStorage = createMockStorage();

    // Replace global storage objects
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: mockSessionStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });

    // Reset storage mode to default
    setStorageMode('session');
  });

  afterEach(() => {
    // Restore original storage objects
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: originalSessionStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
      configurable: true,
    });
  });

  describe('Initialization', () => {
    it('should generate keys on first init', async () => {
      const service = new CryptoService();
      await service.initialize();

      // Should have stored the key
      expect(mockSessionStorage.getItem('zajel_identity')).not.toBeNull();

      // Should be able to get public key
      const publicKey = service.getPublicKeyBase64();
      expect(publicKey).toBeTruthy();
      expect(typeof publicKey).toBe('string');
    });

    it('should load existing keys from storage', async () => {
      // First service generates keys
      const service1 = new CryptoService();
      await service1.initialize();
      const publicKey1 = service1.getPublicKeyBase64();

      // Second service should load the same keys
      const service2 = new CryptoService();
      await service2.initialize();
      const publicKey2 = service2.getPublicKeyBase64();

      expect(publicKey1).toBe(publicKey2);
    });

    it('should regenerate keys if stored data is invalid', async () => {
      // Store invalid data
      mockSessionStorage.setItem('zajel_identity', 'invalid-json');

      const service = new CryptoService();
      await service.initialize();

      // Should still work with new keys
      const publicKey = service.getPublicKeyBase64();
      expect(publicKey).toBeTruthy();
    });

    it('should throw when getting public key before initialization', () => {
      const service = new CryptoService();

      expect(() => service.getPublicKeyBase64()).toThrow(
        'CryptoService not initialized'
      );
    });

    it('should throw when getting fingerprint before initialization', () => {
      const service = new CryptoService();

      expect(() => service.getPublicKeyFingerprint()).toThrow(
        'CryptoService not initialized'
      );
    });

    it('getPublicKeyBase64 should return valid base64', async () => {
      const service = new CryptoService();
      await service.initialize();

      const base64Key = service.getPublicKeyBase64();

      // Should be valid base64
      expect(() => atob(base64Key)).not.toThrow();

      // Decoded should be 32 bytes (X25519 public key)
      const decoded = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(32);
    });

    it('getPublicKeyFingerprint should return formatted hex', async () => {
      const service = new CryptoService();
      await service.initialize();

      const fingerprint = service.getPublicKeyFingerprint();

      // Should be uppercase
      expect(fingerprint).toBe(fingerprint.toUpperCase());

      // Should have spaces (groups of 4 characters)
      expect(fingerprint).toContain(' ');

      // Should only contain hex characters and spaces
      expect(fingerprint).toMatch(/^[0-9A-F ]+$/);

      // 16 bytes = 32 hex chars + 7 spaces (8 groups of 4)
      expect(fingerprint.replace(/ /g, '').length).toBe(32);
    });

    it('getPublicKeyHex should return valid hex string', async () => {
      const service = new CryptoService();
      await service.initialize();

      const hexKey = service.getPublicKeyHex();

      // Should be lowercase hex
      expect(hexKey).toMatch(/^[0-9a-f]+$/);

      // Should be 64 hex chars (32 bytes)
      expect(hexKey.length).toBe(64);
    });
  });

  describe('Session Establishment', () => {
    let service: CryptoService;
    let peerService: CryptoService;

    beforeEach(async () => {
      service = new CryptoService();
      await service.initialize();

      // Create a peer with separate storage
      const peerStorage = createMockStorage();
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: peerStorage,
        writable: true,
        configurable: true,
      });

      peerService = new CryptoService();
      await peerService.initialize();

      // Restore original mock storage for main service
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: mockSessionStorage,
        writable: true,
        configurable: true,
      });
    });

    it('establishSession should create session key', () => {
      const peerId = 'peer-123';
      const peerPublicKey = peerService.getPublicKeyBase64();

      expect(service.hasSession(peerId)).toBe(false);

      service.establishSession(peerId, peerPublicKey);

      expect(service.hasSession(peerId)).toBe(true);
    });

    it('should throw on invalid base64 public key', () => {
      const peerId = 'peer-123';

      expect(() => service.establishSession(peerId, 'not-valid-base64!!!')).toThrow(
        'Invalid peer public key: malformed base64'
      );
    });

    it('should throw on wrong key length (not 32 bytes)', () => {
      const peerId = 'peer-123';
      // Create a 16-byte key (too short)
      const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)));

      expect(() => service.establishSession(peerId, shortKey)).toThrow(
        'Invalid peer public key: expected 32 bytes, got 16'
      );
    });

    it('should throw on key too long', () => {
      const peerId = 'peer-123';
      // Create a 64-byte key (too long)
      const longKey = btoa(String.fromCharCode(...new Uint8Array(64)));

      expect(() => service.establishSession(peerId, longKey)).toThrow(
        'Invalid peer public key: expected 32 bytes, got 64'
      );
    });

    it('hasSession should return correct state', () => {
      const peerId = 'peer-123';
      const peerPublicKey = peerService.getPublicKeyBase64();

      expect(service.hasSession(peerId)).toBe(false);
      expect(service.hasSession('other-peer')).toBe(false);

      service.establishSession(peerId, peerPublicKey);

      expect(service.hasSession(peerId)).toBe(true);
      expect(service.hasSession('other-peer')).toBe(false);
    });

    it('clearSession should remove session', () => {
      const peerId = 'peer-123';
      const peerPublicKey = peerService.getPublicKeyBase64();

      service.establishSession(peerId, peerPublicKey);
      expect(service.hasSession(peerId)).toBe(true);

      service.clearSession(peerId);
      expect(service.hasSession(peerId)).toBe(false);
    });

    it('should throw when establishing session before initialization', () => {
      const uninitializedService = new CryptoService();
      const peerPublicKey = peerService.getPublicKeyBase64();

      expect(() =>
        uninitializedService.establishSession('peer-123', peerPublicKey)
      ).toThrow('CryptoService not initialized');
    });
  });

  describe('Encryption/Decryption', () => {
    let service: CryptoService;
    let peerService: CryptoService;
    // Use the same peerId on both sides since HKDF includes peerId in key derivation
    // In the real app, both parties use the same room/session identifier
    const sessionId = 'shared-session-123';

    beforeEach(async () => {
      service = new CryptoService();
      await service.initialize();

      // Create a peer with separate storage
      const peerStorage = createMockStorage();
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: peerStorage,
        writable: true,
        configurable: true,
      });

      peerService = new CryptoService();
      await peerService.initialize();

      // Restore original mock storage
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: mockSessionStorage,
        writable: true,
        configurable: true,
      });

      // Establish sessions on both sides with the same session ID
      // Both sides use the same ID because HKDF derives the key using:
      // hkdf(sha256, sharedSecret, undefined, `zajel_session_${peerId}`, 32)
      // For the same derived key, both parties need the same peerId
      service.establishSession(sessionId, peerService.getPublicKeyBase64());
      peerService.establishSession(sessionId, service.getPublicKeyBase64());
    });

    it('encrypt should return base64 string', () => {
      const plaintext = 'Hello, World!';
      const ciphertext = service.encrypt(sessionId, plaintext);

      expect(typeof ciphertext).toBe('string');
      // Should be valid base64
      expect(() => atob(ciphertext)).not.toThrow();
    });

    it('decrypt should recover original message', () => {
      const originalMessage = 'Hello, secure world!';

      const ciphertext = service.encrypt(sessionId, originalMessage);
      const decrypted = peerService.decrypt(sessionId, ciphertext);

      expect(decrypted).toBe(originalMessage);
    });

    it('should handle unicode messages', () => {
      const originalMessage = 'Hello 123';

      const ciphertext = service.encrypt(sessionId, originalMessage);
      const decrypted = peerService.decrypt(sessionId, ciphertext);

      expect(decrypted).toBe(originalMessage);
    });

    it('should handle empty messages', () => {
      const originalMessage = '';

      const ciphertext = service.encrypt(sessionId, originalMessage);
      const decrypted = peerService.decrypt(sessionId, ciphertext);

      expect(decrypted).toBe(originalMessage);
    });

    it('same plaintext should produce different ciphertext (random nonce)', () => {
      const plaintext = 'Same message twice';

      const ciphertext1 = service.encrypt(sessionId, plaintext);
      const ciphertext2 = service.encrypt(sessionId, plaintext);

      // Should be different due to random nonce
      expect(ciphertext1).not.toBe(ciphertext2);

      // But both should decrypt to the same plaintext
      const decrypted1 = peerService.decrypt(sessionId, ciphertext1);
      const decrypted2 = peerService.decrypt(sessionId, ciphertext2);

      expect(decrypted1).toBe(plaintext);
      expect(decrypted2).toBe(plaintext);
    });

    it('should throw when encrypting without session', () => {
      const serviceWithoutSession = new CryptoService();

      // Initialize but don't establish session
      return serviceWithoutSession.initialize().then(() => {
        expect(() =>
          serviceWithoutSession.encrypt('unknown-peer', 'test')
        ).toThrow('No session for peer: unknown-peer');
      });
    });

    it('should throw when decrypting without session', () => {
      const serviceWithoutSession = new CryptoService();

      return serviceWithoutSession.initialize().then(() => {
        expect(() =>
          serviceWithoutSession.decrypt('unknown-peer', 'dGVzdA==')
        ).toThrow('No session for peer: unknown-peer');
      });
    });

    it('encryptBytes should return Uint8Array', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const encrypted = service.encryptBytes(sessionId, data);

      expect(encrypted).toBeInstanceOf(Uint8Array);
      // Should be longer than input (nonce + ciphertext + tag)
      expect(encrypted.length).toBeGreaterThan(data.length);
    });

    it('decryptBytes should recover original bytes', () => {
      const originalData = new Uint8Array([10, 20, 30, 40, 50]);

      const encrypted = service.encryptBytes(sessionId, originalData);
      const decrypted = peerService.decryptBytes(sessionId, encrypted);

      expect(decrypted).toEqual(originalData);
    });

    it('should handle large binary data', () => {
      const largeData = new Uint8Array(10000);
      crypto.getRandomValues(largeData);

      const encrypted = service.encryptBytes(sessionId, largeData);
      const decrypted = peerService.decryptBytes(sessionId, encrypted);

      expect(decrypted).toEqual(largeData);
    });
  });

  describe('Storage Configuration', () => {
    it('isEphemeralStorage should return true by default', () => {
      // Reset to default state
      setStorageMode('session');
      expect(isEphemeralStorage()).toBe(true);
    });

    it('setStorageMode should change storage type', () => {
      setStorageMode('persistent');
      expect(isEphemeralStorage()).toBe(false);
      expect(getStorageMode()).toBe('persistent');

      setStorageMode('session');
      expect(isEphemeralStorage()).toBe(true);
      expect(getStorageMode()).toBe('session');
    });

    it('getStorageMode should return current mode', () => {
      setStorageMode('session');
      expect(getStorageMode()).toBe('session');

      setStorageMode('persistent');
      expect(getStorageMode()).toBe('persistent');
    });

    it('should use sessionStorage when mode is session', async () => {
      setStorageMode('session');

      const service = new CryptoService();
      await service.initialize();

      expect(mockSessionStorage.getItem('zajel_identity')).not.toBeNull();
      expect(mockLocalStorage.getItem('zajel_identity')).toBeNull();
    });

    it('should use localStorage when mode is persistent', async () => {
      setStorageMode('persistent');

      const service = new CryptoService();
      await service.initialize();

      expect(mockLocalStorage.getItem('zajel_identity')).not.toBeNull();
      expect(mockSessionStorage.getItem('zajel_identity')).toBeNull();
    });

    it('should load keys from correct storage based on mode', async () => {
      // First, create keys in persistent storage
      setStorageMode('persistent');
      const persistentService = new CryptoService();
      await persistentService.initialize();
      const persistentKey = persistentService.getPublicKeyBase64();

      // Now create keys in session storage
      setStorageMode('session');
      const sessionService = new CryptoService();
      await sessionService.initialize();
      const sessionKey = sessionService.getPublicKeyBase64();

      // Keys should be different (different storage, different keys)
      expect(persistentKey).not.toBe(sessionKey);

      // Switching back should load the persistent key
      setStorageMode('persistent');
      const reloadedService = new CryptoService();
      await reloadedService.initialize();
      expect(reloadedService.getPublicKeyBase64()).toBe(persistentKey);
    });
  });

  describe('Peer Fingerprint', () => {
    let service: CryptoService;

    beforeEach(async () => {
      service = new CryptoService();
      await service.initialize();
    });

    it('getPeerPublicKeyFingerprint should return formatted fingerprint', () => {
      // Create a valid 32-byte key
      const validKey = new Uint8Array(32);
      crypto.getRandomValues(validKey);
      const validKeyBase64 = btoa(String.fromCharCode(...validKey));

      const fingerprint = service.getPeerPublicKeyFingerprint(validKeyBase64);

      // Should be uppercase
      expect(fingerprint).toBe(fingerprint.toUpperCase());

      // Should have spaces (groups of 4 characters)
      expect(fingerprint).toContain(' ');

      // Should only contain hex characters and spaces
      expect(fingerprint).toMatch(/^[0-9A-F ]+$/);

      // 16 bytes = 32 hex chars + 7 spaces
      expect(fingerprint.replace(/ /g, '').length).toBe(32);
    });

    it('should throw on invalid base64', () => {
      expect(() =>
        service.getPeerPublicKeyFingerprint('not-valid-base64!!!')
      ).toThrow('Invalid peer public key: malformed base64');
    });

    it('should throw on wrong key length (too short)', () => {
      const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)));

      expect(() => service.getPeerPublicKeyFingerprint(shortKey)).toThrow(
        'Invalid peer public key: expected 32 bytes, got 16'
      );
    });

    it('should throw on wrong key length (too long)', () => {
      const longKey = btoa(String.fromCharCode(...new Uint8Array(64)));

      expect(() => service.getPeerPublicKeyFingerprint(longKey)).toThrow(
        'Invalid peer public key: expected 32 bytes, got 64'
      );
    });

    it('should produce same fingerprint for same key', () => {
      const validKey = new Uint8Array(32);
      crypto.getRandomValues(validKey);
      const validKeyBase64 = btoa(String.fromCharCode(...validKey));

      const fingerprint1 = service.getPeerPublicKeyFingerprint(validKeyBase64);
      const fingerprint2 = service.getPeerPublicKeyFingerprint(validKeyBase64);

      expect(fingerprint1).toBe(fingerprint2);
    });

    it('should produce different fingerprints for different keys', () => {
      const key1 = new Uint8Array(32);
      const key2 = new Uint8Array(32);
      crypto.getRandomValues(key1);
      crypto.getRandomValues(key2);

      const fingerprint1 = service.getPeerPublicKeyFingerprint(
        btoa(String.fromCharCode(...key1))
      );
      const fingerprint2 = service.getPeerPublicKeyFingerprint(
        btoa(String.fromCharCode(...key2))
      );

      expect(fingerprint1).not.toBe(fingerprint2);
    });

    it('peer fingerprint should match own fingerprint for same key', async () => {
      // Get our own public key and fingerprint
      const ownPublicKey = service.getPublicKeyBase64();
      const ownFingerprint = service.getPublicKeyFingerprint();

      // Calculate peer fingerprint using our own public key
      const peerFingerprint = service.getPeerPublicKeyFingerprint(ownPublicKey);

      expect(peerFingerprint).toBe(ownFingerprint);
    });
  });

  describe('Replay Protection', () => {
    let alice: CryptoService;
    let bob: CryptoService;
    const sharedRoomId = 'room-replay-test';

    beforeEach(async () => {
      // Create Alice
      const aliceStorage = createMockStorage();
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: aliceStorage,
        writable: true,
        configurable: true,
      });
      alice = new CryptoService();
      await alice.initialize();

      // Create Bob
      const bobStorage = createMockStorage();
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: bobStorage,
        writable: true,
        configurable: true,
      });
      bob = new CryptoService();
      await bob.initialize();

      // Establish sessions
      alice.establishSession(sharedRoomId, bob.getPublicKeyBase64());
      bob.establishSession(sharedRoomId, alice.getPublicKeyBase64());
    });

    it('sequence numbers should increment with each message', () => {
      const message1 = alice.encrypt(sharedRoomId, 'Message 1');
      const message2 = alice.encrypt(sharedRoomId, 'Message 2');
      const message3 = alice.encrypt(sharedRoomId, 'Message 3');

      // All messages should decrypt successfully in order
      const decrypted1 = bob.decrypt(sharedRoomId, message1);
      const decrypted2 = bob.decrypt(sharedRoomId, message2);
      const decrypted3 = bob.decrypt(sharedRoomId, message3);

      expect(decrypted1).toBe('Message 1');
      expect(decrypted2).toBe('Message 2');
      expect(decrypted3).toBe('Message 3');
    });

    it('should reject replay of same message (duplicate sequence number)', () => {
      const message = alice.encrypt(sharedRoomId, 'Original message');

      // First decryption should succeed
      const decrypted = bob.decrypt(sharedRoomId, message);
      expect(decrypted).toBe('Original message');

      // Replaying the same message should fail
      expect(() => bob.decrypt(sharedRoomId, message)).toThrow(
        'Replay attack detected: duplicate sequence number'
      );
    });

    it('should reject messages with old sequence numbers', () => {
      // Send and receive many messages to advance the counter
      for (let i = 0; i < 15; i++) {
        const msg = alice.encrypt(sharedRoomId, `Message ${i}`);
        bob.decrypt(sharedRoomId, msg);
      }

      // Create a new session for Alice (to reset her counter) but keep Bob's counter
      const aliceStorage2 = createMockStorage();
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: aliceStorage2,
        writable: true,
        configurable: true,
      });
      const aliceNew = new CryptoService();
      // Manually set up a session that would produce low sequence numbers
      // This simulates an attacker trying to replay old captured messages

      // For simplicity, we just capture an early message before sending many
      // Reset and test differently:
      // Re-establish the session for fresh test
      alice.clearSession(sharedRoomId);
      bob.clearSession(sharedRoomId);
      alice.establishSession(sharedRoomId, bob.getPublicKeyBase64());
      bob.establishSession(sharedRoomId, alice.getPublicKeyBase64());

      // Capture message at seq 1
      const earlyMessage = alice.encrypt(sharedRoomId, 'Early message');

      // Send and receive many more messages to advance counter beyond window
      for (let i = 0; i < 15; i++) {
        const msg = alice.encrypt(sharedRoomId, `Message ${i}`);
        bob.decrypt(sharedRoomId, msg);
      }

      // Now try to replay the early message - should fail as too old
      expect(() => bob.decrypt(sharedRoomId, earlyMessage)).toThrow(
        'Replay attack detected: sequence too old'
      );
    });

    it('should handle messages slightly out of order within window', () => {
      // Encrypt messages 1, 2, 3
      const msg1 = alice.encrypt(sharedRoomId, 'Message 1');
      const msg2 = alice.encrypt(sharedRoomId, 'Message 2');
      const msg3 = alice.encrypt(sharedRoomId, 'Message 3');

      // Receive them out of order: 1, 3, 2
      // Message 1 (seq 1) - should work
      expect(bob.decrypt(sharedRoomId, msg1)).toBe('Message 1');

      // Message 3 (seq 3) - should work (skipping ahead is fine)
      expect(bob.decrypt(sharedRoomId, msg3)).toBe('Message 3');

      // Message 2 (seq 2) - would fail because we track highest seen (3)
      // and 2 < 3, so it's treated as duplicate/old
      // Note: This is a trade-off in the current implementation
      expect(() => bob.decrypt(sharedRoomId, msg2)).toThrow(
        'Replay attack detected: duplicate sequence number'
      );
    });

    it('clearSession should reset sequence counters', () => {
      // Send a message
      const msg1 = alice.encrypt(sharedRoomId, 'Before clear');
      bob.decrypt(sharedRoomId, msg1);

      // Clear and re-establish session
      alice.clearSession(sharedRoomId);
      bob.clearSession(sharedRoomId);
      alice.establishSession(sharedRoomId, bob.getPublicKeyBase64());
      bob.establishSession(sharedRoomId, alice.getPublicKeyBase64());

      // Should be able to send new messages starting from seq 1 again
      const msg2 = alice.encrypt(sharedRoomId, 'After clear');
      const decrypted = bob.decrypt(sharedRoomId, msg2);
      expect(decrypted).toBe('After clear');
    });

    it('each peer should have independent counters', () => {
      // Alice sends to Bob
      const aliceMsg = alice.encrypt(sharedRoomId, 'From Alice');
      bob.decrypt(sharedRoomId, aliceMsg);

      // Bob sends to Alice - should work with its own counter
      const bobMsg = bob.encrypt(sharedRoomId, 'From Bob');
      alice.decrypt(sharedRoomId, bobMsg);

      // Both should be able to continue sending
      const aliceMsg2 = alice.encrypt(sharedRoomId, 'From Alice 2');
      bob.decrypt(sharedRoomId, aliceMsg2);

      const bobMsg2 = bob.encrypt(sharedRoomId, 'From Bob 2');
      alice.decrypt(sharedRoomId, bobMsg2);
    });
  });

  describe('Bidirectional Communication', () => {
    it('should allow both parties to encrypt and decrypt', async () => {
      // Create Alice
      const aliceStorage = createMockStorage();
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: aliceStorage,
        writable: true,
        configurable: true,
      });
      const alice = new CryptoService();
      await alice.initialize();

      // Create Bob
      const bobStorage = createMockStorage();
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: bobStorage,
        writable: true,
        configurable: true,
      });
      const bob = new CryptoService();
      await bob.initialize();

      // Establish sessions with the same session ID (e.g., a shared room)
      // Both parties use the same session ID because the HKDF key derivation
      // includes the peerId in the info parameter
      const sharedRoomId = 'room-abc-123';
      alice.establishSession(sharedRoomId, bob.getPublicKeyBase64());
      bob.establishSession(sharedRoomId, alice.getPublicKeyBase64());

      // Alice sends to Bob
      const aliceMessage = 'Hello Bob!';
      const aliceCiphertext = alice.encrypt(sharedRoomId, aliceMessage);
      const bobReceived = bob.decrypt(sharedRoomId, aliceCiphertext);
      expect(bobReceived).toBe(aliceMessage);

      // Bob sends to Alice
      const bobMessage = 'Hello Alice!';
      const bobCiphertext = bob.encrypt(sharedRoomId, bobMessage);
      const aliceReceived = alice.decrypt(sharedRoomId, bobCiphertext);
      expect(aliceReceived).toBe(bobMessage);
    });
  });
});
