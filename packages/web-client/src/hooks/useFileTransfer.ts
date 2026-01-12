import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { FileTransfer } from '../lib/protocol';
import { FILE_TRANSFER } from '../lib/constants';
import { sanitizeFilename, sanitizeErrorMessage } from '../lib/validation';
import { handleError, isCryptoError, ErrorCodes } from '../lib/errors';
import { logger } from '../lib/logger';

export interface FileTransferCallbacks {
  /** Get current peer code */
  getPeerCode: () => string;
  /** Decrypt data from peer */
  decrypt: (peerId: string, ciphertext: string) => string;
  /** Encrypt data for peer */
  encrypt: (peerId: string, plaintext: string) => string;
  /** Send file error to peer */
  sendFileError: (fileId: string, error: string) => void;
  /** Send file start message */
  sendFileStart: (fileId: string, fileName: string, totalSize: number, totalChunks: number) => boolean;
  /** Send file chunk with backpressure handling */
  sendFileChunk: (fileId: string, chunkIndex: number, data: string) => Promise<boolean>;
  /** Send file complete message */
  sendFileComplete: (fileId: string) => void;
  /** Send transfer cancel message */
  sendTransferCancel: (fileId: string, reason: 'timeout') => void;
}

export interface UseFileTransferReturn {
  /** Current transfers state (for UI) */
  transfers: Map<string, FileTransfer>;
  /** Transfers map ref (for synchronous access) */
  transfersMapRef: RefObject<Map<string, FileTransfer>>;
  /** Handle file start event */
  handleFileStart: (fileId: string, fileName: string, totalSize: number, totalChunks: number) => void;
  /** Handle file chunk event */
  handleFileChunk: (fileId: string, chunkIndex: number, encryptedData: string) => void;
  /** Handle file complete event */
  handleFileComplete: (fileId: string) => void;
  /** Handle file error event */
  handleFileError: (fileId: string, error: string) => void;
  /** Send a file to peer */
  sendFile: (file: File) => Promise<void>;
  /** Dismiss a completed/failed transfer from UI */
  dismissTransfer: (transferId: string) => void;
  /** Clear all transfers */
  clearTransfers: () => void;
}

/**
 * Hook for managing file transfer state and logic.
 *
 * Handles:
 * - Tracking incoming and outgoing file transfers
 * - File chunking and reassembly
 * - Transfer progress and status
 * - Stall detection and timeout handling
 * - Memory management for completed transfers
 */
export function useFileTransfer(callbacks: FileTransferCallbacks): UseFileTransferReturn {
  const [transfers, setTransfers] = useState<Map<string, FileTransfer>>(new Map());
  // Ref for immediate transfer state storage to avoid race conditions with async state updates
  const transfersMapRef = useRef<Map<string, FileTransfer>>(new Map());
  const callbacksRef = useRef(callbacks);

  // Keep callbacks ref up to date
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  // Sync transfers state with ref
  const syncTransfers = useCallback(() => {
    setTransfers(new Map(transfersMapRef.current));
  }, []);

  // Remove oldest completed transfers if limit exceeded
  const pruneCompletedTransfers = useCallback(() => {
    if (transfersMapRef.current.size > FILE_TRANSFER.MAX_TRANSFERS) {
      const entries = Array.from(transfersMapRef.current.entries());
      const completedIds = entries
        .filter(([, t]) => t.status === 'complete')
        .map(([id]) => id);
      for (const id of completedIds) {
        if (transfersMapRef.current.size <= FILE_TRANSFER.MAX_TRANSFERS) break;
        transfersMapRef.current.delete(id);
      }
    }
  }, []);

  const handleFileStart = useCallback((
    fileId: string,
    fileName: string,
    totalSize: number,
    totalChunks: number
  ) => {
    // Reject files larger than the limit to prevent memory exhaustion
    if (totalSize > FILE_TRANSFER.MAX_FILE_SIZE) {
      logger.warn('FileTransfer', `Rejected file transfer: ${fileName} (${totalSize} bytes exceeds ${FILE_TRANSFER.MAX_FILE_SIZE} limit)`);
      callbacksRef.current.sendFileError(fileId, 'File too large');
      return;
    }

    // Sanitize filename to remove path separators and control characters
    const sanitizedFileName = sanitizeFilename(fileName);

    // Create new transfer and store in ref immediately (synchronous)
    const newTransfer: FileTransfer = {
      id: fileId,
      fileName: sanitizedFileName,
      totalSize,
      totalChunks,
      receivedChunks: 0,
      status: 'receiving' as const,
      data: [],
      lastActivityTime: Date.now(),
    };
    transfersMapRef.current.set(fileId, newTransfer);

    pruneCompletedTransfers();
    syncTransfers();
  }, [syncTransfers, pruneCompletedTransfers]);

  const handleFileChunk = useCallback((
    fileId: string,
    chunkIndex: number,
    encryptedData: string
  ) => {
    const peerCode = callbacksRef.current.getPeerCode();
    if (!peerCode) return;

    // Read from ref immediately (synchronous) to avoid race conditions
    const transfer = transfersMapRef.current.get(fileId);
    if (!transfer) {
      logger.warn('FileTransfer', `Received chunk for unknown transfer: ${fileId}`);
      return;
    }

    // Skip if already failed
    if (transfer.status === 'failed') return;

    const data = transfer.data || [];

    // Decrypt chunk
    try {
      const decrypted = callbacksRef.current.decrypt(peerCode, encryptedData);
      const bytes = Uint8Array.from(atob(decrypted), (c) => c.charCodeAt(0));
      data[chunkIndex] = bytes;

      // Update ref immediately (synchronous)
      const updatedTransfer: FileTransfer = {
        ...transfer,
        receivedChunks: transfer.receivedChunks + 1,
        data,
        lastActivityTime: Date.now(),
      };
      transfersMapRef.current.set(fileId, updatedTransfer);
      syncTransfers();
    } catch (e) {
      // Use centralized error handling
      const err = handleError(e, 'file.chunk.decrypt', ErrorCodes.CRYPTO_DECRYPTION_FAILED);
      const userMessage = isCryptoError(e)
        ? err.userMessage
        : `Failed to decrypt chunk ${chunkIndex + 1}`;

      // Mark transfer as failed in ref immediately
      const failedTransfer: FileTransfer = {
        ...transfer,
        status: 'failed',
        error: userMessage,
      };
      transfersMapRef.current.set(fileId, failedTransfer);

      // Notify peer
      callbacksRef.current.sendFileError(fileId, userMessage);
      syncTransfers();
    }
  }, [syncTransfers]);

  const handleFileComplete = useCallback((fileId: string) => {
    const transfer = transfersMapRef.current.get(fileId);
    if (!transfer) return;
    // Skip if already failed
    if (transfer.status === 'failed') return;

    // Check if any chunks are missing
    if (transfer.data) {
      const missingChunks: number[] = [];
      for (let i = 0; i < transfer.totalChunks; i++) {
        if (!transfer.data[i]) {
          missingChunks.push(i + 1);
        }
      }
      if (missingChunks.length > 0) {
        const missingStr = missingChunks.length > 3
          ? `${missingChunks.slice(0, 3).join(', ')}... (${missingChunks.length} total)`
          : missingChunks.join(', ');
        transfersMapRef.current.set(fileId, {
          ...transfer,
          status: 'failed',
          error: `Missing chunks: ${missingStr}`,
        });
        syncTransfers();
        return;
      }

      // All chunks present, combine and download
      const blob = new Blob(transfer.data as BlobPart[]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = transfer.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      // No data received at all
      transfersMapRef.current.set(fileId, {
        ...transfer,
        status: 'failed',
        error: 'No data received',
      });
      syncTransfers();
      return;
    }

    transfersMapRef.current.set(fileId, { ...transfer, status: 'complete' });
    syncTransfers();
  }, [syncTransfers]);

  const handleFileError = useCallback((fileId: string, error: string) => {
    // Sanitize error message from peer to prevent XSS
    const sanitizedError = sanitizeErrorMessage(error);
    const transfer = transfersMapRef.current.get(fileId);
    if (transfer) {
      transfersMapRef.current.set(fileId, {
        ...transfer,
        status: 'failed',
        error: `Peer error: ${sanitizedError}`,
      });
      syncTransfers();
    }
  }, [syncTransfers]);

  const sendFile = useCallback(async (file: File) => {
    const peerCode = callbacksRef.current.getPeerCode();
    if (!peerCode) return;

    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / FILE_TRANSFER.CHUNK_SIZE);

    // Add to transfers using Map ref for consistency
    const newTransfer: FileTransfer = {
      id: fileId,
      fileName: file.name,
      totalSize: file.size,
      totalChunks,
      receivedChunks: 0,
      status: 'sending' as const,
      lastActivityTime: Date.now(),
    };
    transfersMapRef.current.set(fileId, newTransfer);

    pruneCompletedTransfers();
    syncTransfers();

    // Send file start
    callbacksRef.current.sendFileStart(fileId, file.name, file.size, totalChunks);

    // Read and send chunks with backpressure handling
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * FILE_TRANSFER.CHUNK_SIZE;
      const end = Math.min(start + FILE_TRANSFER.CHUNK_SIZE, file.size);
      const chunk = bytes.slice(start, end);

      // Encrypt chunk
      const base64 = btoa(String.fromCharCode(...chunk));
      const encrypted = callbacksRef.current.encrypt(peerCode, base64);

      // Send with backpressure handling - awaits buffer drain if needed
      const sent = await callbacksRef.current.sendFileChunk(fileId, i, encrypted);

      if (!sent) {
        // Channel closed or error occurred
        const failedTransfer = transfersMapRef.current.get(fileId);
        if (failedTransfer) {
          transfersMapRef.current.set(fileId, {
            ...failedTransfer,
            status: 'failed' as const,
            error: 'Connection lost during transfer',
          });
          syncTransfers();
        }
        return;
      }

      // Update progress and lastActivityTime
      const currentTransfer = transfersMapRef.current.get(fileId);
      if (currentTransfer) {
        transfersMapRef.current.set(fileId, {
          ...currentTransfer,
          receivedChunks: i + 1,
          lastActivityTime: Date.now(),
        });
        syncTransfers();
      }
    }

    // Send complete
    callbacksRef.current.sendFileComplete(fileId);
    const completedTransfer = transfersMapRef.current.get(fileId);
    if (completedTransfer) {
      transfersMapRef.current.set(fileId, {
        ...completedTransfer,
        status: 'complete' as const,
      });
      syncTransfers();
    }
  }, [syncTransfers, pruneCompletedTransfers]);

  const dismissTransfer = useCallback((transferId: string) => {
    transfersMapRef.current.delete(transferId);
    syncTransfers();
  }, [syncTransfers]);

  const clearTransfers = useCallback(() => {
    transfersMapRef.current.clear();
    syncTransfers();
  }, [syncTransfers]);

  // Handle transfer timeout - cancel the transfer and notify peer
  const handleTransferTimeout = useCallback((fileId: string) => {
    const transfer = transfersMapRef.current.get(fileId);
    if (!transfer) return;

    // Mark as failed due to timeout
    transfersMapRef.current.set(fileId, {
      ...transfer,
      status: 'failed',
      error: 'Transfer stalled - no activity for 30 seconds',
    });
    syncTransfers();

    // Notify peer about the timeout/cancellation
    callbacksRef.current.sendTransferCancel(fileId, 'timeout');
  }, [syncTransfers]);

  // Stall detection interval - check for transfers with no activity for >30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      transfersMapRef.current.forEach((transfer, fileId) => {
        // Only check active transfers (receiving or sending)
        if (transfer.status === 'receiving' || transfer.status === 'sending') {
          const lastActivity = transfer.lastActivityTime || 0;
          if (lastActivity > 0 && now - lastActivity > FILE_TRANSFER.STALL_TIMEOUT_MS) {
            handleTransferTimeout(fileId);
          }
        }
      });
    }, FILE_TRANSFER.STALL_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [handleTransferTimeout]);

  return {
    transfers,
    transfersMapRef,
    handleFileStart,
    handleFileChunk,
    handleFileComplete,
    handleFileError,
    sendFile,
    dismissTransfer,
    clearTransfers,
  };
}
