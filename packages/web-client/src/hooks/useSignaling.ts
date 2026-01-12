import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { RefObject } from 'preact';
import { SignalingClient } from '../lib/signaling';
import type { ConnectionState } from '../lib/protocol';
import { sanitizeErrorMessage } from '../lib/validation';

// Signaling server URL must be configured via environment variable
const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL;

export interface IncomingPairRequest {
  code: string;
  publicKey: string;
}

export interface SignalingCallbacks {
  /** Called when pairing is matched and WebRTC should start */
  onPairMatched: (peerCode: string, peerPublicKey: string, isInitiator: boolean) => Promise<void>;
  /** Called when an offer is received from peer */
  onOffer: (from: string, payload: RTCSessionDescriptionInit) => Promise<void>;
  /** Called when an answer is received from peer */
  onAnswer: (from: string, payload: RTCSessionDescriptionInit) => Promise<void>;
  /** Called when an ICE candidate is received from peer */
  onIceCandidate: (from: string, payload: RTCIceCandidateInit) => Promise<void>;
}

export interface UseSignalingReturn {
  /** Signaling client reference */
  signalingRef: RefObject<SignalingClient | null>;
  /** Current connection state */
  connectionState: ConnectionState;
  /** Our pairing code */
  myCode: string;
  /** Pending incoming pair request */
  incomingRequest: IncomingPairRequest | null;
  /** Current error message */
  error: string | null;
  /** Connect to signaling server */
  connect: (publicKey: string) => void;
  /** Disconnect from signaling server */
  disconnect: () => void;
  /** Request pairing with a peer code */
  requestPairing: (targetCode: string) => void;
  /** Respond to incoming pairing request */
  respondToPairing: (targetCode: string, accepted: boolean) => void;
  /** Send WebRTC offer */
  sendOffer: (target: string, payload: RTCSessionDescriptionInit) => void;
  /** Send WebRTC answer */
  sendAnswer: (target: string, payload: RTCSessionDescriptionInit) => void;
  /** Send ICE candidate */
  sendIceCandidate: (target: string, payload: RTCIceCandidateInit) => void;
  /** Clear incoming request state */
  clearIncomingRequest: () => void;
  /** Clear error state */
  clearError: () => void;
  /** Set connection state manually (for app-level state management) */
  setState: (state: ConnectionState) => void;
  /** Set error manually */
  setError: (error: string | null) => void;
}

/**
 * Hook for managing signaling connection and state.
 *
 * Handles:
 * - WebSocket connection to signaling server
 * - Pairing code registration
 * - Pairing request/response flow
 * - WebRTC signaling message relay
 */
export function useSignaling(callbacks: SignalingCallbacks): UseSignalingReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [myCode, setMyCode] = useState('');
  const [incomingRequest, setIncomingRequest] = useState<IncomingPairRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signalingRef = useRef<SignalingClient | null>(null);
  const callbacksRef = useRef(callbacks);

  // Keep callbacks ref up to date
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const connect = useCallback((publicKey: string) => {
    if (!SIGNALING_URL) {
      setError(
        'VITE_SIGNALING_URL environment variable is required. ' +
        'Set it in .env file or pass via command line.'
      );
      return;
    }

    const signaling = new SignalingClient(SIGNALING_URL, {
      onStateChange: (newState) => {
        setConnectionState(newState);
        if (newState === 'registered') {
          setMyCode(signaling.pairingCode);
        }
      },
      onPairIncoming: (fromCode, fromPublicKey) => {
        setIncomingRequest({ code: fromCode, publicKey: fromPublicKey });
      },
      onPairExpiring: (_peerCode, _remainingSeconds) => {
        // Could show warning to user that pairing is about to expire
        // For now, we just ignore this - the timeout will handle it
      },
      onPairMatched: async (peerCode, peerPublicKey, isInitiator) => {
        setIncomingRequest(null);
        setConnectionState('webrtc_connecting');
        await callbacksRef.current.onPairMatched(peerCode, peerPublicKey, isInitiator);
      },
      onPairRejected: (_peerCode) => {
        // Use generic message to prevent information leakage about valid codes
        setError('Connection request declined');
        setConnectionState('registered');
      },
      onPairTimeout: (_peerCode) => {
        // Use generic message to prevent information leakage about valid codes
        setError('Connection request timed out');
        setConnectionState('registered');
      },
      onPairError: (err) => {
        // Sanitize error message from server to prevent XSS
        setError(sanitizeErrorMessage(err));
        setConnectionState('registered');
      },
      onOffer: async (from, payload) => {
        await callbacksRef.current.onOffer(from, payload);
      },
      onAnswer: async (from, payload) => {
        await callbacksRef.current.onAnswer(from, payload);
      },
      onIceCandidate: async (from, payload) => {
        await callbacksRef.current.onIceCandidate(from, payload);
      },
      onError: (err) => {
        // Sanitize error message from server to prevent XSS
        setError(sanitizeErrorMessage(err));
      },
    });

    signalingRef.current = signaling;
    signaling.connect(publicKey);
  }, []);

  const disconnect = useCallback(() => {
    signalingRef.current?.disconnect();
  }, []);

  const requestPairing = useCallback((targetCode: string) => {
    signalingRef.current?.requestPairing(targetCode);
  }, []);

  const respondToPairing = useCallback((targetCode: string, accepted: boolean) => {
    signalingRef.current?.respondToPairing(targetCode, accepted);
    if (!accepted) {
      setIncomingRequest(null);
    }
  }, []);

  const sendOffer = useCallback((target: string, payload: RTCSessionDescriptionInit) => {
    signalingRef.current?.sendOffer(target, payload);
  }, []);

  const sendAnswer = useCallback((target: string, payload: RTCSessionDescriptionInit) => {
    signalingRef.current?.sendAnswer(target, payload);
  }, []);

  const sendIceCandidate = useCallback((target: string, payload: RTCIceCandidateInit) => {
    signalingRef.current?.sendIceCandidate(target, payload);
  }, []);

  const clearIncomingRequest = useCallback(() => {
    setIncomingRequest(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      signalingRef.current?.disconnect();
    };
  }, []);

  return {
    signalingRef,
    connectionState,
    myCode,
    incomingRequest,
    error,
    connect,
    disconnect,
    requestPairing,
    respondToPairing,
    sendOffer,
    sendAnswer,
    sendIceCandidate,
    clearIncomingRequest,
    clearError,
    setState: setConnectionState,
    setError,
  };
}
