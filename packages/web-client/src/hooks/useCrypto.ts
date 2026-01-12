import { useState, useEffect, useCallback } from 'preact/hooks';
import { cryptoService } from '../lib/crypto';
import { handleError, ErrorCodes } from '../lib/errors';

export interface UseCryptoReturn {
  /** Whether crypto is initialized */
  isInitialized: boolean;
  /** Initialization error if any */
  initError: string | null;
  /** Our public key fingerprint */
  myFingerprint: string;
  /** Get the base64 encoded public key */
  getPublicKeyBase64: () => string;
  /** Calculate fingerprint for a peer's public key */
  getPeerFingerprint: (peerPublicKeyBase64: string) => string;
  /** Establish a crypto session with a peer */
  establishSession: (peerId: string, peerPublicKeyBase64: string) => void;
  /** Verify a peer's key matches what we received from signaling */
  verifyPeerKey: (peerId: string, receivedKey: string) => boolean;
  /** Clear a peer's session */
  clearSession: (peerId: string) => void;
  /** Encrypt a message for a peer */
  encrypt: (peerId: string, plaintext: string) => string;
  /** Decrypt a message from a peer */
  decrypt: (peerId: string, ciphertext: string) => string;
}

/**
 * Hook for managing cryptographic operations and key management.
 *
 * Handles:
 * - Crypto service initialization
 * - Public key fingerprint generation
 * - Session establishment and verification
 * - Message encryption/decryption
 */
export function useCrypto(): UseCryptoReturn {
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [myFingerprint, setMyFingerprint] = useState('');

  // Initialize crypto service on mount
  useEffect(() => {
    const init = async () => {
      try {
        await cryptoService.initialize();
        setMyFingerprint(cryptoService.getPublicKeyFingerprint());
        setIsInitialized(true);
      } catch (e) {
        const err = handleError(e, 'crypto.initialize', ErrorCodes.INITIALIZATION_FAILED);
        setInitError(err.userMessage);
      }
    };

    init();
  }, []);

  const getPublicKeyBase64 = useCallback(() => {
    return cryptoService.getPublicKeyBase64();
  }, []);

  const getPeerFingerprint = useCallback((peerPublicKeyBase64: string) => {
    return cryptoService.getPeerPublicKeyFingerprint(peerPublicKeyBase64);
  }, []);

  const establishSession = useCallback((peerId: string, peerPublicKeyBase64: string) => {
    cryptoService.establishSession(peerId, peerPublicKeyBase64);
  }, []);

  const verifyPeerKey = useCallback((peerId: string, receivedKey: string) => {
    return cryptoService.verifyPeerKey(peerId, receivedKey);
  }, []);

  const clearSession = useCallback((peerId: string) => {
    cryptoService.clearSession(peerId);
  }, []);

  const encrypt = useCallback((peerId: string, plaintext: string) => {
    return cryptoService.encrypt(peerId, plaintext);
  }, []);

  const decrypt = useCallback((peerId: string, ciphertext: string) => {
    return cryptoService.decrypt(peerId, ciphertext);
  }, []);

  return {
    isInitialized,
    initError,
    myFingerprint,
    getPublicKeyBase64,
    getPeerFingerprint,
    establishSession,
    verifyPeerKey,
    clearSession,
    encrypt,
    decrypt,
  };
}
