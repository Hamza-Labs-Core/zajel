/**
 * FileTransferManager - Reliable file transfer with chunk acknowledgments and retries
 *
 * Implements:
 * - Chunk-level acknowledgment protocol (SACK-style)
 * - Per-chunk SHA-256 integrity verification
 * - Automatic retry with exponential backoff
 * - Backpressure handling for WebRTC data channels
 * - Transfer timeout detection
 * - Progress tracking with speed estimation
 */

import type {
  FileTransfer,
  TransferState,
  ChunkAckMessage,
  ChunkRetryRequestMessage,
  FileStartAckMessage,
  FileCompleteAckMessage,
} from './protocol';
import { logger } from './logger';
import { handleError, ErrorCodes } from './errors';
import { FILE_TRANSFER, RELIABLE_TRANSFER } from './constants';

/**
 * Compute SHA-256 hash of data
 */
export async function computeHash(data: Uint8Array): Promise<string> {
  // Create a new ArrayBuffer from the Uint8Array to satisfy TypeScript's strict BufferSource type
  // This handles the case where Uint8Array.buffer might be a SharedArrayBuffer
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
}

/**
 * Compute SHA-256 hash of a file using streaming
 */
export async function computeFileHash(chunks: Uint8Array[]): Promise<string> {
  // Combine all chunks and hash
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return computeHash(combined);
}

/**
 * Chunk tracking for sender side
 */
interface SentChunkInfo {
  data: string; // Encrypted base64 data
  hash: string; // SHA-256 of plaintext chunk
  sentAt: number;
  retries: number;
  acked: boolean;
}

/**
 * Received chunk info for receiver side
 */
interface ReceivedChunkInfo {
  data: Uint8Array;
  hash: string;
  receivedAt: number;
}

/**
 * Transfer context for tracking active transfers
 */
interface TransferContext {
  id: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  chunkSize: number;
  direction: 'sending' | 'receiving';
  state: TransferState;
  error?: string;

  // Sender-side tracking
  sentChunks?: Map<number, SentChunkInfo>;
  pendingAcks?: Set<number>;
  retryTimeouts?: Map<number, ReturnType<typeof setTimeout>>;

  // Receiver-side tracking
  receivedChunks?: Map<number, ReceivedChunkInfo>;
  expectedHashes?: string[]; // Hashes from file_start for verification

  // Common
  startTime: number;
  lastActivityTime: number;
  bytesTransferred: number;
  retryCount: number;
  fileHash?: string;
}

/**
 * Events emitted by FileTransferManager
 */
export interface FileTransferEvents {
  onTransferUpdate: (transfer: FileTransfer) => void;
  onTransferComplete: (transfer: FileTransfer, blob: Blob) => void;
  onTransferFailed: (transfer: FileTransfer, error: string) => void;

  // Protocol message sending
  sendFileStart: (
    fileId: string,
    fileName: string,
    totalSize: number,
    totalChunks: number,
    chunkHashes?: string[]
  ) => boolean;
  sendFileChunk: (
    fileId: string,
    chunkIndex: number,
    data: string,
    hash: string
  ) => boolean;
  sendFileComplete: (fileId: string, fileHash: string) => void;
  sendFileError: (fileId: string, error: string) => void;
  sendFileStartAck: (fileId: string, accepted: boolean, reason?: string) => void;
  sendChunkAck: (
    fileId: string,
    chunkIndex: number,
    status: 'received' | 'failed',
    hash?: string
  ) => void;
  sendChunkRetryRequest: (fileId: string, chunkIndices: number[]) => void;
  sendFileCompleteAck: (
    fileId: string,
    status: 'success' | 'failed',
    missingChunks?: number[],
    fileHash?: string
  ) => void;
  sendTransferCancel: (
    fileId: string,
    reason: 'user_cancelled' | 'error' | 'timeout'
  ) => void;

  // Backpressure query
  getBufferedAmount: () => number;

  // Encryption
  encrypt: (data: string) => string;
  decrypt: (data: string) => string;
}

/**
 * FileTransferManager handles reliable file transfers
 */
export class FileTransferManager {
  private transfers: Map<string, TransferContext> = new Map();
  private events: FileTransferEvents;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;
  private isCancelled: Set<string> = new Set();

  constructor(events: FileTransferEvents) {
    this.events = events;
    this.startIdleCheck();
  }

  /**
   * Start periodic check for idle/stale transfers
   */
  private startIdleCheck(): void {
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, ctx] of this.transfers) {
        if (ctx.state === 'failed' || ctx.state === 'complete' || ctx.state === 'cancelled') {
          continue;
        }

        if (now - ctx.lastActivityTime > RELIABLE_TRANSFER.TRANSFER_IDLE_TIMEOUT_MS) {
          this.failTransfer(id, 'Transfer timeout - no activity for 60 seconds');
          this.events.sendTransferCancel(id, 'timeout');
        }
      }
    }, RELIABLE_TRANSFER.IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    // Clear all retry timeouts
    for (const ctx of this.transfers.values()) {
      if (ctx.retryTimeouts) {
        for (const timeout of ctx.retryTimeouts.values()) {
          clearTimeout(timeout);
        }
      }
    }

    this.transfers.clear();
    this.isCancelled.clear();
  }

  /**
   * Get current transfer state as FileTransfer object
   */
  private getTransferState(ctx: TransferContext): FileTransfer {
    const now = Date.now();
    const elapsedSeconds = Math.max(1, (now - ctx.startTime) / 1000);
    const speed = ctx.bytesTransferred / elapsedSeconds;
    const remaining = ctx.totalSize - ctx.bytesTransferred;
    const estimatedTime = speed > 0 ? remaining / speed : undefined;

    const ackedChunks =
      ctx.direction === 'sending'
        ? Array.from(ctx.sentChunks?.values() || []).filter((c) => c.acked).length
        : ctx.receivedChunks?.size || 0;

    const failedChunks: number[] = [];
    if (ctx.direction === 'sending' && ctx.sentChunks) {
      for (const [index, info] of ctx.sentChunks) {
        if (!info.acked && info.retries >= RELIABLE_TRANSFER.MAX_RETRIES_PER_CHUNK) {
          failedChunks.push(index);
        }
      }
    }

    // Map state to legacy status
    let status: 'receiving' | 'sending' | 'complete' | 'failed' =
      ctx.direction === 'sending' ? 'sending' : 'receiving';
    if (ctx.state === 'complete') status = 'complete';
    if (ctx.state === 'failed' || ctx.state === 'cancelled') status = 'failed';

    return {
      id: ctx.id,
      fileName: ctx.fileName,
      totalSize: ctx.totalSize,
      totalChunks: ctx.totalChunks,
      receivedChunks: ctx.direction === 'receiving'
        ? (ctx.receivedChunks?.size || 0)
        : Array.from(ctx.sentChunks?.values() || []).filter(c => c.acked).length,
      ackedChunks,
      failedChunks,
      retryCount: ctx.retryCount,
      state: ctx.state,
      status,
      error: ctx.error,
      fileHash: ctx.fileHash,
      lastActivityTime: ctx.lastActivityTime,
      transferSpeed: speed,
      estimatedTimeRemaining: estimatedTime,
      direction: ctx.direction,
    };
  }

  /**
   * Emit transfer update event
   */
  private emitUpdate(ctx: TransferContext): void {
    this.events.onTransferUpdate(this.getTransferState(ctx));
  }

  /**
   * Fail a transfer with an error
   */
  private failTransfer(id: string, error: string): void {
    const ctx = this.transfers.get(id);
    if (!ctx) return;

    ctx.state = 'failed';
    ctx.error = error;

    // Clear retry timeouts
    if (ctx.retryTimeouts) {
      for (const timeout of ctx.retryTimeouts.values()) {
        clearTimeout(timeout);
      }
      ctx.retryTimeouts.clear();
    }

    this.emitUpdate(ctx);
    this.events.onTransferFailed(this.getTransferState(ctx), error);
  }

  /**
   * Wait for backpressure to clear
   */
  private async waitForBackpressure(): Promise<void> {
    while (this.events.getBufferedAmount() > RELIABLE_TRANSFER.MAX_BUFFERED_AMOUNT) {
      await new Promise((r) => setTimeout(r, RELIABLE_TRANSFER.BACKPRESSURE_CHECK_INTERVAL_MS));
    }
  }

  // ==================== SENDER SIDE ====================

  /**
   * Start sending a file
   */
  async sendFile(file: File): Promise<string> {
    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / FILE_TRANSFER.CHUNK_SIZE);

    // Create transfer context
    const ctx: TransferContext = {
      id: fileId,
      fileName: file.name,
      totalSize: file.size,
      totalChunks,
      chunkSize: FILE_TRANSFER.CHUNK_SIZE,
      direction: 'sending',
      state: 'awaiting_start_ack',
      sentChunks: new Map(),
      pendingAcks: new Set(),
      retryTimeouts: new Map(),
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      bytesTransferred: 0,
      retryCount: 0,
    };

    this.transfers.set(fileId, ctx);
    this.emitUpdate(ctx);

    // Read file and compute chunk hashes
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkHashes: string[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * FILE_TRANSFER.CHUNK_SIZE;
      const end = Math.min(start + FILE_TRANSFER.CHUNK_SIZE, file.size);
      const chunk = bytes.slice(start, end);
      const hash = await computeHash(chunk);
      chunkHashes.push(hash);

      // Pre-encrypt and store chunk data
      const base64 = btoa(String.fromCharCode(...chunk));
      const encrypted = this.events.encrypt(base64);

      ctx.sentChunks!.set(i, {
        data: encrypted,
        hash,
        sentAt: 0,
        retries: 0,
        acked: false,
      });
    }

    // Compute file hash
    ctx.fileHash = await computeHash(bytes);

    // Send file_start message
    const sent = this.events.sendFileStart(
      fileId,
      file.name,
      file.size,
      totalChunks,
      chunkHashes
    );

    if (!sent) {
      this.failTransfer(fileId, 'Failed to send file start message');
      return fileId;
    }

    // Wait for start ack (handled by handleFileStartAck)
    // Chunks will be sent once start is acknowledged

    return fileId;
  }

  /**
   * Handle file_start_ack from receiver
   */
  handleFileStartAck(msg: FileStartAckMessage): void {
    const ctx = this.transfers.get(msg.fileId);
    if (!ctx || ctx.direction !== 'sending') return;

    ctx.lastActivityTime = Date.now();

    if (!msg.accepted) {
      this.failTransfer(msg.fileId, `Transfer rejected: ${msg.reason || 'Unknown reason'}`);
      return;
    }

    ctx.state = 'transferring';
    this.emitUpdate(ctx);

    // Start sending chunks with sliding window
    this.sendChunksWithWindow(msg.fileId);
  }

  /**
   * Send chunks using sliding window for flow control
   */
  private async sendChunksWithWindow(fileId: string): Promise<void> {
    const ctx = this.transfers.get(fileId);
    if (!ctx || ctx.state !== 'transferring' || this.isCancelled.has(fileId)) return;

    const sentChunks = ctx.sentChunks!;
    const pendingAcks = ctx.pendingAcks!;

    // Find chunks to send (not yet sent or need retry)
    for (let i = 0; i < ctx.totalChunks; i++) {
      // Check if we should stop
      if (ctx.state !== 'transferring' || this.isCancelled.has(fileId)) return;

      // Wait if too many chunks in flight
      while (pendingAcks.size >= RELIABLE_TRANSFER.MAX_CHUNKS_IN_FLIGHT) {
        await new Promise((r) => setTimeout(r, 100));
        if (ctx.state !== 'transferring' || this.isCancelled.has(fileId)) return;
      }

      const chunkInfo = sentChunks.get(i)!;

      // Skip already acknowledged chunks
      if (chunkInfo.acked) continue;

      // Skip if already waiting for ack (unless it timed out)
      if (pendingAcks.has(i) && Date.now() - chunkInfo.sentAt < RELIABLE_TRANSFER.CHUNK_ACK_TIMEOUT_MS) {
        continue;
      }

      // Check retry limit
      if (chunkInfo.retries >= RELIABLE_TRANSFER.MAX_RETRIES_PER_CHUNK) {
        this.failTransfer(fileId, `Chunk ${i} failed after ${RELIABLE_TRANSFER.MAX_RETRIES_PER_CHUNK} retries`);
        return;
      }

      // Wait for backpressure
      await this.waitForBackpressure();

      // Send the chunk
      const sent = this.events.sendFileChunk(
        fileId,
        i,
        chunkInfo.data,
        chunkInfo.hash
      );

      if (!sent) {
        this.failTransfer(fileId, `Failed to send chunk ${i}`);
        return;
      }

      // Update tracking
      chunkInfo.sentAt = Date.now();
      if (chunkInfo.retries > 0) {
        ctx.retryCount++;
      }
      chunkInfo.retries++;
      pendingAcks.add(i);
      ctx.lastActivityTime = Date.now();

      this.emitUpdate(ctx);

      // Set timeout for ack
      this.setChunkTimeout(fileId, i);

      // Small delay between chunks
      await new Promise((r) => setTimeout(r, 10));
    }

    // Check if all chunks are acknowledged
    this.checkSendComplete(fileId);
  }

  /**
   * Set timeout for chunk acknowledgment
   */
  private setChunkTimeout(fileId: string, chunkIndex: number): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx) return;

    // Clear existing timeout
    const existing = ctx.retryTimeouts?.get(chunkIndex);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      this.handleChunkTimeout(fileId, chunkIndex);
    }, RELIABLE_TRANSFER.CHUNK_ACK_TIMEOUT_MS);

    ctx.retryTimeouts!.set(chunkIndex, timeout);
  }

  /**
   * Handle chunk timeout - trigger retry
   */
  private handleChunkTimeout(fileId: string, chunkIndex: number): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx || ctx.state !== 'transferring') return;

    const chunkInfo = ctx.sentChunks?.get(chunkIndex);
    if (!chunkInfo || chunkInfo.acked) return;

    logger.warn('FileTransfer', `Chunk ${chunkIndex} timeout for file ${fileId}, will retry`);

    // Remove from pending so it can be resent
    ctx.pendingAcks?.delete(chunkIndex);

    // Trigger resend
    this.sendChunksWithWindow(fileId);
  }

  /**
   * Handle chunk_ack from receiver
   */
  handleChunkAck(msg: ChunkAckMessage): void {
    const ctx = this.transfers.get(msg.fileId);
    if (!ctx || ctx.direction !== 'sending') return;

    const chunkInfo = ctx.sentChunks?.get(msg.chunkIndex);
    if (!chunkInfo) return;

    ctx.lastActivityTime = Date.now();

    // Clear timeout
    const timeout = ctx.retryTimeouts?.get(msg.chunkIndex);
    if (timeout) {
      clearTimeout(timeout);
      ctx.retryTimeouts!.delete(msg.chunkIndex);
    }

    ctx.pendingAcks?.delete(msg.chunkIndex);

    if (msg.status === 'received') {
      // Verify hash if provided
      if (msg.hash && msg.hash !== chunkInfo.hash) {
        logger.warn('FileTransfer', `Hash mismatch for chunk ${msg.chunkIndex}, will retry`);
        chunkInfo.acked = false;
        this.sendChunksWithWindow(msg.fileId);
        return;
      }

      chunkInfo.acked = true;
      ctx.bytesTransferred = this.calculateBytesTransferred(ctx);
      this.emitUpdate(ctx);
      this.checkSendComplete(msg.fileId);
    } else {
      // Chunk failed, will be retried by sendChunksWithWindow
      logger.warn('FileTransfer', `Chunk ${msg.chunkIndex} failed on receiver, will retry`);
      this.sendChunksWithWindow(msg.fileId);
    }
  }

  /**
   * Calculate bytes transferred based on acked chunks
   */
  private calculateBytesTransferred(ctx: TransferContext): number {
    if (!ctx.sentChunks) return 0;

    let bytes = 0;
    for (const [index, info] of ctx.sentChunks) {
      if (info.acked) {
        bytes += index === ctx.totalChunks - 1
          ? ctx.totalSize - index * ctx.chunkSize
          : ctx.chunkSize;
      }
    }
    return bytes;
  }

  /**
   * Check if all chunks are sent and acknowledged
   */
  private checkSendComplete(fileId: string): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx || ctx.state !== 'transferring') return;

    const allAcked = Array.from(ctx.sentChunks!.values()).every((c) => c.acked);
    if (allAcked) {
      ctx.state = 'awaiting_complete_ack';
      this.events.sendFileComplete(fileId, ctx.fileHash || '');
      this.emitUpdate(ctx);
    }
  }

  /**
   * Handle file_complete_ack from receiver
   */
  handleFileCompleteAck(msg: FileCompleteAckMessage): void {
    const ctx = this.transfers.get(msg.fileId);
    if (!ctx || ctx.direction !== 'sending') return;

    ctx.lastActivityTime = Date.now();

    if (msg.status === 'success') {
      ctx.state = 'complete';
      this.emitUpdate(ctx);
      this.events.onTransferComplete(this.getTransferState(ctx), new Blob());
    } else {
      // Handle missing chunks - retry them
      if (msg.missingChunks && msg.missingChunks.length > 0) {
        logger.warn('FileTransfer', `Receiver reports missing chunks: ${msg.missingChunks.join(', ')}`);

        // Mark these chunks as not acked so they get resent
        for (const index of msg.missingChunks) {
          const chunkInfo = ctx.sentChunks?.get(index);
          if (chunkInfo) {
            chunkInfo.acked = false;
            chunkInfo.retries = 0; // Reset retry count for this final attempt
          }
        }

        ctx.state = 'transferring';
        this.sendChunksWithWindow(msg.fileId);
      } else {
        this.failTransfer(msg.fileId, 'Receiver failed to verify file');
      }
    }
  }

  /**
   * Handle chunk retry request from receiver
   */
  handleChunkRetryRequest(msg: ChunkRetryRequestMessage): void {
    const ctx = this.transfers.get(msg.fileId);
    if (!ctx || ctx.direction !== 'sending') return;

    logger.info('FileTransfer', `Receiver requested retry of chunks: ${msg.chunkIndices.join(', ')}`);

    ctx.lastActivityTime = Date.now();

    // Mark requested chunks for resend
    for (const index of msg.chunkIndices) {
      const chunkInfo = ctx.sentChunks?.get(index);
      if (chunkInfo && !chunkInfo.acked) {
        ctx.pendingAcks?.delete(index);
      }
    }

    // Trigger resend
    if (ctx.state === 'transferring') {
      this.sendChunksWithWindow(msg.fileId);
    }
  }

  // ==================== RECEIVER SIDE ====================

  /**
   * Handle file_start from sender - create receiving transfer
   */
  handleFileStart(
    fileId: string,
    fileName: string,
    totalSize: number,
    totalChunks: number,
    chunkHashes?: string[],
    maxFileSize: number = 100 * 1024 * 1024
  ): boolean {
    // Validate
    if (totalSize > maxFileSize) {
      this.events.sendFileStartAck(fileId, false, 'too_large');
      return false;
    }

    if (totalSize <= 0 || totalChunks <= 0) {
      this.events.sendFileStartAck(fileId, false, 'invalid_parameters');
      return false;
    }

    // Create receiving context
    const ctx: TransferContext = {
      id: fileId,
      fileName,
      totalSize,
      totalChunks,
      chunkSize: FILE_TRANSFER.CHUNK_SIZE,
      direction: 'receiving',
      state: 'receiving',
      receivedChunks: new Map(),
      expectedHashes: chunkHashes,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      bytesTransferred: 0,
      retryCount: 0,
    };

    this.transfers.set(fileId, ctx);
    this.events.sendFileStartAck(fileId, true);
    this.emitUpdate(ctx);

    return true;
  }

  /**
   * Handle incoming file chunk
   */
  handleFileChunk(
    fileId: string,
    chunkIndex: number,
    encryptedData: string,
    hash?: string
  ): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx || ctx.direction !== 'receiving' || ctx.state === 'failed') {
      this.events.sendChunkAck(fileId, chunkIndex, 'failed');
      return;
    }

    ctx.lastActivityTime = Date.now();

    try {
      // Decrypt the chunk
      const decrypted = this.events.decrypt(encryptedData);
      const bytes = Uint8Array.from(atob(decrypted), (c) => c.charCodeAt(0));

      // Verify hash if provided
      computeHash(bytes).then((computedHash) => {
        // Check against provided hash
        if (hash && hash !== computedHash) {
          logger.warn('FileTransfer', `Hash mismatch for chunk ${chunkIndex}`);
          this.events.sendChunkAck(fileId, chunkIndex, 'failed');
          return;
        }

        // Check against expected hash from file_start
        if (ctx.expectedHashes && ctx.expectedHashes[chunkIndex]) {
          if (ctx.expectedHashes[chunkIndex] !== computedHash) {
            logger.warn('FileTransfer', `Chunk ${chunkIndex} hash doesn't match expected`);
            this.events.sendChunkAck(fileId, chunkIndex, 'failed');
            return;
          }
        }

        // Store chunk
        ctx.receivedChunks!.set(chunkIndex, {
          data: bytes,
          hash: computedHash,
          receivedAt: Date.now(),
        });

        ctx.bytesTransferred += bytes.length;
        this.events.sendChunkAck(fileId, chunkIndex, 'received', computedHash);
        this.emitUpdate(ctx);
      });
    } catch (e) {
      // Use centralized error handling for chunk processing failures
      handleError(e, 'fileTransfer.processChunk', ErrorCodes.FILE_CHUNK_FAILED);
      this.events.sendChunkAck(fileId, chunkIndex, 'failed');
    }
  }

  /**
   * Handle file_complete from sender
   */
  handleFileComplete(fileId: string, fileHash?: string): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx || ctx.direction !== 'receiving') return;

    ctx.lastActivityTime = Date.now();

    // Check for missing chunks
    const missingChunks: number[] = [];
    for (let i = 0; i < ctx.totalChunks; i++) {
      if (!ctx.receivedChunks!.has(i)) {
        missingChunks.push(i);
      }
    }

    if (missingChunks.length > 0) {
      this.events.sendFileCompleteAck(fileId, 'failed', missingChunks);
      // Request retry of missing chunks
      this.events.sendChunkRetryRequest(fileId, missingChunks);
      return;
    }

    // Assemble file and verify hash
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < ctx.totalChunks; i++) {
      const chunk = ctx.receivedChunks!.get(i);
      if (chunk) {
        chunks.push(chunk.data);
      }
    }

    computeFileHash(chunks).then((computedHash) => {
      ctx.fileHash = computedHash;

      // Verify file hash if provided
      if (fileHash && fileHash !== computedHash) {
        this.events.sendFileCompleteAck(fileId, 'failed');
        this.failTransfer(fileId, 'File hash verification failed');
        return;
      }

      // Success - create blob and complete
      const blob = new Blob(chunks as BlobPart[]);
      ctx.state = 'complete';

      this.events.sendFileCompleteAck(fileId, 'success', undefined, computedHash);
      this.emitUpdate(ctx);

      // Add data array for compatibility
      const transfer = this.getTransferState(ctx);
      transfer.data = chunks;

      this.events.onTransferComplete(transfer, blob);
    });
  }

  /**
   * Handle file_error from peer
   */
  handleFileError(fileId: string, error: string): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx) return;

    this.failTransfer(fileId, `Peer error: ${error}`);
  }

  /**
   * Handle transfer_cancel from peer
   */
  handleTransferCancel(fileId: string, _reason: string): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx) return;

    ctx.state = 'cancelled';
    ctx.error = 'Transfer cancelled by peer';
    this.emitUpdate(ctx);
  }

  // ==================== USER ACTIONS ====================

  /**
   * Cancel a transfer
   */
  cancelTransfer(fileId: string): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx) return;

    this.isCancelled.add(fileId);

    // Clear timeouts
    if (ctx.retryTimeouts) {
      for (const timeout of ctx.retryTimeouts.values()) {
        clearTimeout(timeout);
      }
    }

    ctx.state = 'cancelled';
    ctx.error = 'Cancelled by user';

    this.events.sendTransferCancel(fileId, 'user_cancelled');
    this.emitUpdate(ctx);
  }

  /**
   * Retry a failed transfer (receiver only - requests missing chunks)
   */
  retryTransfer(fileId: string): void {
    const ctx = this.transfers.get(fileId);
    if (!ctx || ctx.state !== 'failed' || ctx.direction !== 'receiving') return;

    // Find missing chunks
    const missingChunks: number[] = [];
    for (let i = 0; i < ctx.totalChunks; i++) {
      if (!ctx.receivedChunks!.has(i)) {
        missingChunks.push(i);
      }
    }

    if (missingChunks.length > 0) {
      ctx.state = 'receiving';
      ctx.error = undefined;
      ctx.lastActivityTime = Date.now();
      ctx.retryCount++;

      this.events.sendChunkRetryRequest(fileId, missingChunks);
      this.emitUpdate(ctx);
    }
  }

  /**
   * Get transfer by ID
   */
  getTransfer(fileId: string): FileTransfer | undefined {
    const ctx = this.transfers.get(fileId);
    if (!ctx) return undefined;
    return this.getTransferState(ctx);
  }

  /**
   * Get all transfers
   */
  getAllTransfers(): FileTransfer[] {
    return Array.from(this.transfers.values()).map((ctx) =>
      this.getTransferState(ctx)
    );
  }

  /**
   * Clear completed/failed transfers
   */
  clearCompleted(): void {
    for (const [id, ctx] of this.transfers) {
      if (ctx.state === 'complete' || ctx.state === 'failed' || ctx.state === 'cancelled') {
        this.transfers.delete(id);
        this.isCancelled.delete(id);
      }
    }
  }

  /**
   * Remove specific transfer
   */
  removeTransfer(fileId: string): void {
    const ctx = this.transfers.get(fileId);
    if (ctx?.retryTimeouts) {
      for (const timeout of ctx.retryTimeouts.values()) {
        clearTimeout(timeout);
      }
    }
    this.transfers.delete(fileId);
    this.isCancelled.delete(fileId);
  }
}
