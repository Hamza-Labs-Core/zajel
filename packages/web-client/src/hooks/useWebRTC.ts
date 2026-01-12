import { useRef, useCallback, useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';
import { WebRTCService } from '../lib/webrtc';
import type { SignalingClient } from '../lib/signaling';
import type {
  ChunkAckMessage,
  ChunkRetryRequestMessage,
  FileStartAckMessage,
  FileCompleteAckMessage,
  TransferCancelMessage,
} from '../lib/protocol';

export interface WebRTCCallbacks {
  /** Called when WebRTC connection state changes */
  onStateChange: (state: RTCPeerConnectionState) => void;
  /** Called when handshake message is received from peer */
  onHandshake: (publicKey: string) => void;
  /** Called when encrypted message is received */
  onMessage: (encryptedData: string) => void;
  /** Called when file transfer starts */
  onFileStart: (fileId: string, fileName: string, totalSize: number, totalChunks: number, chunkHashes?: string[]) => void;
  /** Called when file chunk is received */
  onFileChunk: (fileId: string, chunkIndex: number, data: string, hash?: string) => void;
  /** Called when file transfer completes */
  onFileComplete: (fileId: string, fileHash?: string) => void;
  /** Called when file transfer errors */
  onFileError: (fileId: string, error: string) => void;
  /** Called when file start ack is received (optional) */
  onFileStartAck?: (msg: FileStartAckMessage) => void;
  /** Called when chunk ack is received (optional) */
  onChunkAck?: (msg: ChunkAckMessage) => void;
  /** Called when chunk retry request is received (optional) */
  onChunkRetryRequest?: (msg: ChunkRetryRequestMessage) => void;
  /** Called when file complete ack is received (optional) */
  onFileCompleteAck?: (msg: FileCompleteAckMessage) => void;
  /** Called when transfer cancel is received (optional) */
  onTransferCancel?: (msg: TransferCancelMessage) => void;
}

export interface UseWebRTCReturn {
  /** WebRTC service reference */
  webrtcRef: RefObject<WebRTCService | null>;
  /** Initialize WebRTC with signaling client */
  initialize: (signaling: SignalingClient) => void;
  /** Connect to peer */
  connect: (peerCode: string, isInitiator: boolean) => Promise<void>;
  /** Handle incoming offer */
  handleOffer: (offer: RTCSessionDescriptionInit) => Promise<void>;
  /** Handle incoming answer */
  handleAnswer: (answer: RTCSessionDescriptionInit) => Promise<void>;
  /** Handle incoming ICE candidate */
  handleIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
  /** Send handshake message */
  sendHandshake: (publicKey: string) => void;
  /** Send encrypted message */
  sendMessage: (encryptedData: string) => void;
  /** Send file start message */
  sendFileStart: (fileId: string, fileName: string, totalSize: number, totalChunks: number, chunkHashes?: string[]) => boolean;
  /** Send file chunk with backpressure handling */
  sendFileChunk: (fileId: string, chunkIndex: number, data: string, hash?: string) => Promise<boolean>;
  /** Send file complete message */
  sendFileComplete: (fileId: string, fileHash?: string) => void;
  /** Send file error message */
  sendFileError: (fileId: string, error: string) => void;
  /** Send transfer cancel message */
  sendTransferCancel: (fileId: string, reason: 'user_cancelled' | 'error' | 'timeout') => boolean;
  /** Close WebRTC connection */
  close: () => void;
  /** Check if connected */
  isConnected: () => boolean;
}

/**
 * Hook for managing WebRTC connection.
 *
 * Handles:
 * - WebRTC peer connection management
 * - Data channel setup for messages and files
 * - ICE candidate handling
 * - Message and file transfer methods
 */
export function useWebRTC(callbacks: WebRTCCallbacks): UseWebRTCReturn {
  const webrtcRef = useRef<WebRTCService | null>(null);
  const callbacksRef = useRef(callbacks);

  // Keep callbacks ref up to date
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const initialize = useCallback((signaling: SignalingClient) => {
    const webrtc = new WebRTCService(signaling, {
      onStateChange: (state) => callbacksRef.current.onStateChange(state),
      onHandshake: (publicKey) => callbacksRef.current.onHandshake(publicKey),
      onMessage: (data) => callbacksRef.current.onMessage(data),
      onFileStart: (fileId, fileName, totalSize, totalChunks, chunkHashes) => {
        callbacksRef.current.onFileStart(fileId, fileName, totalSize, totalChunks, chunkHashes);
      },
      onFileChunk: (fileId, chunkIndex, data, hash) => {
        callbacksRef.current.onFileChunk(fileId, chunkIndex, data, hash);
      },
      onFileComplete: (fileId, fileHash) => {
        callbacksRef.current.onFileComplete(fileId, fileHash);
      },
      onFileError: (fileId, error) => {
        callbacksRef.current.onFileError(fileId, error);
      },
      onFileStartAck: (msg) => callbacksRef.current.onFileStartAck?.(msg),
      onChunkAck: (msg) => callbacksRef.current.onChunkAck?.(msg),
      onChunkRetryRequest: (msg) => callbacksRef.current.onChunkRetryRequest?.(msg),
      onFileCompleteAck: (msg) => callbacksRef.current.onFileCompleteAck?.(msg),
      onTransferCancel: (msg) => callbacksRef.current.onTransferCancel?.(msg),
    });

    webrtcRef.current = webrtc;
  }, []);

  const connect = useCallback(async (peerCode: string, isInitiator: boolean) => {
    await webrtcRef.current?.connect(peerCode, isInitiator);
  }, []);

  const handleOffer = useCallback(async (offer: RTCSessionDescriptionInit) => {
    await webrtcRef.current?.handleOffer(offer);
  }, []);

  const handleAnswer = useCallback(async (answer: RTCSessionDescriptionInit) => {
    await webrtcRef.current?.handleAnswer(answer);
  }, []);

  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    await webrtcRef.current?.handleIceCandidate(candidate);
  }, []);

  const sendHandshake = useCallback((publicKey: string) => {
    webrtcRef.current?.sendHandshake(publicKey);
  }, []);

  const sendMessage = useCallback((encryptedData: string) => {
    webrtcRef.current?.sendMessage(encryptedData);
  }, []);

  const sendFileStart = useCallback((
    fileId: string,
    fileName: string,
    totalSize: number,
    totalChunks: number,
    chunkHashes?: string[]
  ) => {
    return webrtcRef.current?.sendFileStart(fileId, fileName, totalSize, totalChunks, chunkHashes) ?? false;
  }, []);

  const sendFileChunk = useCallback(async (
    fileId: string,
    chunkIndex: number,
    data: string,
    hash?: string
  ) => {
    return await webrtcRef.current?.sendFileChunk(fileId, chunkIndex, data, hash) ?? false;
  }, []);

  const sendFileComplete = useCallback((fileId: string, fileHash?: string) => {
    webrtcRef.current?.sendFileComplete(fileId, fileHash);
  }, []);

  const sendFileError = useCallback((fileId: string, error: string) => {
    webrtcRef.current?.sendFileError(fileId, error);
  }, []);

  const sendTransferCancel = useCallback((
    fileId: string,
    reason: 'user_cancelled' | 'error' | 'timeout'
  ) => {
    return webrtcRef.current?.sendTransferCancel(fileId, reason) ?? false;
  }, []);

  const close = useCallback(() => {
    webrtcRef.current?.close();
  }, []);

  const isConnected = useCallback(() => {
    return webrtcRef.current?.isConnected ?? false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      webrtcRef.current?.close();
    };
  }, []);

  return {
    webrtcRef,
    initialize,
    connect,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    sendHandshake,
    sendMessage,
    sendFileStart,
    sendFileChunk,
    sendFileComplete,
    sendFileError,
    sendTransferCancel,
    close,
    isConnected,
  };
}
