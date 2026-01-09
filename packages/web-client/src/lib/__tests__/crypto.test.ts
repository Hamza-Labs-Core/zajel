/**
 * CryptoService Tests
 *
 * Tests for X25519 key exchange and ChaCha20-Poly1305 encryption.
 * Keys are ephemeral (memory-only) - no storage tests needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService } from '../crypto';

describe('CryptoService', () => {
  describe('Initialization', () => {
    it('should generate keys on init', async () => {
      const service = new CryptoService();
      await service.initialize();

      // Should be able to get public key
      const publicKey = service.getPublicKeyBase64();
      expect(publicKey).toBeTruthy();
      expect(typeof publicKey).toBe('string');
    });

    it('each instance should generate different keys (ephemeral)', async () => {
      const service1 = new CryptoService();
      await service1.initialize();
      const publicKey1 = service1.getPublicKeyBase64();

      const service2 = new CryptoService();
      await service2.initialize();
      const publicKey2 = service2.getPublicKeyBase64();

      // Different instances should have different keys
      expect(publicKey1).not.toBe(publicKey2);
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

      // Should contain spaces (formatted)
      expect(fingerprint).toContain(' ');

      // Should only contain hex chars and spaces
      expect(fingerprint).toMatch(/^[0-9A-F ]+$/);

      // Should be 32 hex chars (128 bits / 4 bits per char)
      expect(fingerprint.replace(/ /g, '').length).toBe(32);
    });

    it('getPublicKeyHex should return valid hex string', async () => {
      const service = new CryptoService();
      await service.initialize();

      const hexKey = service.getPublicKeyHex();

      // Should be 64 hex chars (32 bytes * 2)
      expect(hexKey.length).toBe(64);

      // Should only contain hex chars
      expect(hexKey).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe('Session Establishment', () => {
    it('establishSession should create session key', async () => {
      const alice = new CryptoService();
      const bob = new CryptoService();
      await alice.initialize();
      await bob.initialize();

      // Establish session using Bob's public key
      alice.establishSession('bob', bob.getPublicKeyBase64());

      expect(alice.hasSession('bob')).toBe(true);
      expect(alice.hasSession('charlie')).toBe(false);
    });

    it('should throw on invalid base64 public key', async () => {
      const alice = new CryptoService();
      await alice.initialize();

      expect(() => alice.establishSession('bob', 'not-valid-base64!!!')).toThrow(
        'Invalid peer public key: malformed base64'
      );
    });

    it('should throw on wrong key length (not 32 bytes)', async () => {
      const alice = new CryptoService();
      await alice.initialize();

      // Create a 16-byte key (too short)
      const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)));

      expect(() => alice.establishSession('bob', shortKey)).toThrow(
        'Invalid peer public key: expected 32 bytes, got 16'
      );
    });

    it('should throw on key too long', async () => {
      const alice = new CryptoService();
      await alice.initialize();

      // Create a 64-byte key (too long)
      const longKey = btoa(String.fromCharCode(...new Uint8Array(64)));

      expect(() => alice.establishSession('bob', longKey)).toThrow(
        'Invalid peer public key: expected 32 bytes, got 64'
      );
    });

    it('hasSession should return correct state', async () => {
      const alice = new CryptoService();
      const bob = new CryptoService();
      await alice.initialize();
      await bob.initialize();

      expect(alice.hasSession('bob')).toBe(false);

      alice.establishSession('bob', bob.getPublicKeyBase64());

      expect(alice.hasSession('bob')).toBe(true);
    });

    it('clearSession should remove session', async () => {
      const alice = new CryptoService();
      const bob = new CryptoService();
      await alice.initialize();
      await bob.initialize();

      alice.establishSession('bob', bob.getPublicKeyBase64());
      expect(alice.hasSession('bob')).toBe(true);

      alice.clearSession('bob');
      expect(alice.hasSession('bob')).toBe(false);
    });

    it('should throw when establishing session before initialization', () => {
      const alice = new CryptoService();

      // Create a valid 32-byte key
      const validKey = btoa(String.fromCharCode(...new Uint8Array(32)));

      expect(() => alice.establishSession('bob', validKey)).toThrow(
        'CryptoService not initialized'
      );
    });
  });

  describe('Encryption/Decryption', () => {
    let alice: CryptoService;
    let bob: CryptoService;
    const sharedRoomId = 'room123';

    beforeEach(async () => {
      alice = new CryptoService();
      bob = new CryptoService();
      await alice.initialize();
      await bob.initialize();

      // Establish sessions
      alice.establishSession(sharedRoomId, bob.getPublicKeyBase64());
      bob.establishSession(sharedRoomId, alice.getPublicKeyBase64());
    });

    it('encrypt should return base64 string', () => {
      const encrypted = alice.encrypt(sharedRoomId, 'Hello');

      expect(typeof encrypted).toBe('string');
      expect(() => atob(encrypted)).not.toThrow();
    });

    it('decrypt should recover original message', () => {
      const message = 'Hello, Bob!';
      const encrypted = alice.encrypt(sharedRoomId, message);
      const decrypted = bob.decrypt(sharedRoomId, encrypted);

      expect(decrypted).toBe(message);
    });

    it('should handle unicode messages', () => {
      const message = 'Hello! こんにちは! 🎉';
      const encrypted = alice.encrypt(sharedRoomId, message);
      const decrypted = bob.decrypt(sharedRoomId, encrypted);

      expect(decrypted).toBe(message);
    });

    it('should handle empty messages', () => {
      const message = '';
      const encrypted = alice.encrypt(sharedRoomId, message);
      const decrypted = bob.decrypt(sharedRoomId, encrypted);

      expect(decrypted).toBe(message);
    });

    it('same plaintext should produce different ciphertext (random nonce)', () => {
      const message = 'Hello';
      const encrypted1 = alice.encrypt(sharedRoomId, message);
      const encrypted2 = alice.encrypt(sharedRoomId, message);

      // Ciphertexts should be different due to random nonce
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same message
      expect(bob.decrypt(sharedRoomId, encrypted1)).toBe(message);
      expect(bob.decrypt(sharedRoomId, encrypted2)).toBe(message);
    });

    it('should throw when encrypting without session', async () => {
      const charlie = new CryptoService();
      await charlie.initialize();

      expect(() => charlie.encrypt('unknown', 'Hello')).toThrow(
        'No session for peer: unknown'
      );
    });

    it('should throw when decrypting without session', async () => {
      const charlie = new CryptoService();
      await charlie.initialize();

      const encrypted = alice.encrypt(sharedRoomId, 'Hello');

      expect(() => charlie.decrypt('unknown', encrypted)).toThrow(
        'No session for peer: unknown'
      );
    });

    it('encryptBytes should return Uint8Array', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const encrypted = alice.encryptBytes(sharedRoomId, data);

      expect(encrypted).toBeInstanceOf(Uint8Array);
      expect(encrypted.length).toBeGreaterThan(data.length); // Includes nonce + tag
    });

    it('decryptBytes should recover original bytes', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const encrypted = alice.encryptBytes(sharedRoomId, data);
      const decrypted = bob.decryptBytes(sharedRoomId, encrypted);

      expect(decrypted).toEqual(data);
    });

    it('should handle large binary data', () => {
      const data = new Uint8Array(1024 * 50); // 50KB (within 65KB limit)
      // Fill with predictable pattern instead of random
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const encrypted = alice.encryptBytes(sharedRoomId, data);
      const decrypted = bob.decryptBytes(sharedRoomId, encrypted);

      expect(decrypted).toEqual(data);
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

      // Should contain spaces (formatted)
      expect(fingerprint).toContain(' ');

      // Should only contain hex chars and spaces
      expect(fingerprint).toMatch(/^[0-9A-F ]+$/);

      // Should be 32 hex chars (128 bits / 4 bits per char)
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
      alice = new CryptoService();
      bob = new CryptoService();
      await alice.initialize();
      await bob.initialize();
      alice.establishSession(sharedRoomId, bob.getPublicKeyBase64());
      bob.establishSession(sharedRoomId, alice.getPublicKeyBase64());
    });

    it('sequence numbers should increment with each message', () => {
      const msg1 = alice.encrypt(sharedRoomId, 'Message 1');
      const msg2 = alice.encrypt(sharedRoomId, 'Message 2');
      const msg3 = alice.encrypt(sharedRoomId, 'Message 3');

      // All messages should decrypt successfully in order
      const decrypted1 = bob.decrypt(sharedRoomId, msg1);
      const decrypted2 = bob.decrypt(sharedRoomId, msg2);
      const decrypted3 = bob.decrypt(sharedRoomId, msg3);

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
      // Capture message at seq 1
      const earlyMessage = alice.encrypt(sharedRoomId, 'Early message');

      // Send and receive many more messages to advance counter beyond window (64)
      for (let i = 0; i < 70; i++) {
        const msg = alice.encrypt(sharedRoomId, `Message ${i}`);
        bob.decrypt(sharedRoomId, msg);
      }

      // Now try to replay the early message - should fail as too old
      // seq 1 is outside window: 71 - 1 = 70 >= 64
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

      // Message 2 (seq 2) - should now work with sliding window implementation
      // seq 2 is within the window (3 - 2 = 1 < 64) and hasn't been seen yet
      expect(bob.decrypt(sharedRoomId, msg2)).toBe('Message 2');

      // But replaying msg2 again should fail
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
      // Alice sends 5 messages
      for (let i = 0; i < 5; i++) {
        const msg = alice.encrypt(sharedRoomId, `Alice ${i}`);
        bob.decrypt(sharedRoomId, msg);
      }

      // Bob can still send his first message (Bob's counter is independent)
      const bobMsg = bob.encrypt(sharedRoomId, 'Bob first message');
      const decrypted = alice.decrypt(sharedRoomId, bobMsg);
      expect(decrypted).toBe('Bob first message');
    });
  });

  describe('Bidirectional Communication', () => {
    it('should allow both parties to encrypt and decrypt', async () => {
      const alice = new CryptoService();
      const bob = new CryptoService();
      await alice.initialize();
      await bob.initialize();

      const roomId = 'bidirectional-test';
      alice.establishSession(roomId, bob.getPublicKeyBase64());
      bob.establishSession(roomId, alice.getPublicKeyBase64());

      // Alice sends to Bob
      const aliceMsg = alice.encrypt(roomId, 'Hello from Alice');
      expect(bob.decrypt(roomId, aliceMsg)).toBe('Hello from Alice');

      // Bob sends to Alice
      const bobMsg = bob.encrypt(roomId, 'Hello from Bob');
      expect(alice.decrypt(roomId, bobMsg)).toBe('Hello from Bob');

      // Multiple messages back and forth
      const a2 = alice.encrypt(roomId, 'Message 2 from Alice');
      const b2 = bob.encrypt(roomId, 'Message 2 from Bob');
      expect(bob.decrypt(roomId, a2)).toBe('Message 2 from Alice');
      expect(alice.decrypt(roomId, b2)).toBe('Message 2 from Bob');
    });
  });
});
