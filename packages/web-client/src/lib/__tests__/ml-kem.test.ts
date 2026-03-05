import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService } from '../crypto';
import { CRYPTO } from '../constants';

/**
 * ML-KEM-768 post-quantum hybrid key exchange tests for the web client.
 *
 * Tests:
 * - ML-KEM constant correctness
 * - CryptoService ML-KEM property behavior
 * - Protocol version negotiation
 * - Hybrid session establishment (when @noble/post-quantum is available)
 */

describe('ML-KEM Constants', () => {
  it('has correct FIPS 203 sizes', () => {
    expect(CRYPTO.MLKEM768_PUBLIC_KEY_SIZE).toBe(1184);
    expect(CRYPTO.MLKEM768_CIPHERTEXT_SIZE).toBe(1088);
    expect(CRYPTO.MLKEM768_SHARED_SECRET_SIZE).toBe(32);
  });

  it('has correct protocol versions', () => {
    expect(CRYPTO.PROTOCOL_VERSION_CLASSICAL).toBe(1);
    expect(CRYPTO.PROTOCOL_VERSION_HYBRID).toBe(2);
    expect(CRYPTO.PROTOCOL_VERSION_CURRENT).toBe(2);
  });

  it('supports both classical and hybrid KEMs', () => {
    expect(CRYPTO.SUPPORTED_KEMS).toContain('x25519');
    expect(CRYPTO.SUPPORTED_KEMS).toContain('x25519-mlkem768');
    expect(CRYPTO.SUPPORTED_KEMS).toHaveLength(2);
  });
});

describe('CryptoService ML-KEM Properties', () => {
  let crypto: CryptoService;

  beforeEach(async () => {
    crypto = new CryptoService();
    await crypto.initialize();
  });

  it('mlKemAvailable is a boolean after init', () => {
    expect(typeof crypto.mlKemAvailable).toBe('boolean');
  });

  it('getMlKemPublicKeyBase64 returns string or null', () => {
    const key = crypto.getMlKemPublicKeyBase64();
    if (crypto.mlKemAvailable) {
      expect(typeof key).toBe('string');
      // ML-KEM-768 public key is 1184 bytes, base64-encoded
      expect(key).toBeTruthy();
    } else {
      expect(key).toBeNull();
    }
  });

  it('getPeerProtocolVersion returns undefined for unknown peer', () => {
    expect(crypto.getPeerProtocolVersion('unknown')).toBeUndefined();
  });

  it('classical establishSession still works', async () => {
    // Use a real X25519 public key from another CryptoService instance
    const crypto2 = new CryptoService();
    await crypto2.initialize();
    const peerKey = crypto2.getPublicKeyBase64();
    expect(() => {
      crypto.establishSession('test-peer', peerKey);
    }).not.toThrow();
  });

  it('classical session sets protocol version', async () => {
    const crypto2 = new CryptoService();
    await crypto2.initialize();
    const peerKey = crypto2.getPublicKeyBase64();
    crypto.establishSession('test-peer', peerKey);
    expect(crypto.getPeerProtocolVersion('test-peer')).toBe(CRYPTO.PROTOCOL_VERSION_CLASSICAL);
  });
});

describe('CryptoService Hybrid Session', () => {
  let alice: CryptoService;
  let bob: CryptoService;

  beforeEach(async () => {
    alice = new CryptoService();
    bob = new CryptoService();
    await alice.initialize();
    await bob.initialize();
  });

  it('hybrid session works when ML-KEM is available', async () => {
    if (!alice.mlKemAvailable || !bob.mlKemAvailable) {
      // Skip if @noble/post-quantum is not installed
      return;
    }

    const alicePub = alice.getPublicKeyBase64();
    const bobPub = bob.getPublicKeyBase64();
    const aliceMlKemPub = alice.getMlKemPublicKeyBase64()!;
    const bobMlKemPub = bob.getMlKemPublicKeyBase64()!;

    // Alice initiates hybrid session
    const { ciphertext } = await alice.establishHybridSession(
      'bob', bobPub, bobMlKemPub, 'initiator'
    );
    expect(ciphertext).toBeTruthy();

    // Bob responds
    const result = await bob.establishHybridSession(
      'alice', alicePub, aliceMlKemPub, 'responder', ciphertext
    );
    expect(result.ciphertext).toBeUndefined();

    // Both should be able to encrypt/decrypt
    const encrypted = alice.encrypt('bob', 'Quantum-safe message!');
    const decrypted = bob.decrypt('alice', encrypted);
    expect(decrypted).toBe('Quantum-safe message!');
  });

  it('hybrid session sets protocol version to HYBRID', async () => {
    if (!alice.mlKemAvailable || !bob.mlKemAvailable) {
      return;
    }

    const bobPub = bob.getPublicKeyBase64();
    const bobMlKemPub = bob.getMlKemPublicKeyBase64()!;

    await alice.establishHybridSession('bob', bobPub, bobMlKemPub, 'initiator');
    expect(alice.getPeerProtocolVersion('bob')).toBe(CRYPTO.PROTOCOL_VERSION_HYBRID);
  });

  it('throws when ML-KEM unavailable and hybrid requested', async () => {
    // Create a fresh crypto service that we can test with
    const svc = new CryptoService();
    // Initialize WITHOUT ML-KEM (by checking if it's unavailable)
    await svc.initialize();

    if (!svc.mlKemAvailable) {
      const fakeX25519 = btoa(String.fromCharCode(...new Uint8Array(32)));
      const fakeMlKem = btoa(String.fromCharCode(...new Uint8Array(1184)));
      await expect(
        svc.establishHybridSession('peer', fakeX25519, fakeMlKem, 'initiator')
      ).rejects.toThrow('ML-KEM not available');
    }
  });
});
