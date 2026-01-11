// Message types for VPS signaling

// Client → Server messages
export interface RegisterMessage {
  type: 'register';
  pairingCode: string;
  publicKey: string;
}

export interface PairRequestMessage {
  type: 'pair_request';
  targetCode: string;
}

export interface PairResponseMessage {
  type: 'pair_response';
  targetCode: string;
  accepted: boolean;
}

export interface OfferMessage {
  type: 'offer';
  target: string;
  payload: RTCSessionDescriptionInit;
}

export interface AnswerMessage {
  type: 'answer';
  target: string;
  payload: RTCSessionDescriptionInit;
}

export interface IceCandidateMessage {
  type: 'ice_candidate';
  target: string;
  payload: RTCIceCandidateInit;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | RegisterMessage
  | PairRequestMessage
  | PairResponseMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | PingMessage;

// Server → Client messages
export interface RegisteredMessage {
  type: 'registered';
  pairingCode: string;
}

export interface PairIncomingMessage {
  type: 'pair_incoming';
  fromCode: string;
  fromPublicKey: string;
  expiresIn?: number; // Timeout in milliseconds for client-side countdown
}

export interface PairExpiringMessage {
  type: 'pair_expiring';
  peerCode: string;
  remainingSeconds: number; // Seconds remaining before timeout
}

export interface PairMatchedMessage {
  type: 'pair_matched';
  peerCode: string;
  peerPublicKey: string;
  isInitiator: boolean;
}

export interface PairRejectedMessage {
  type: 'pair_rejected';
  peerCode: string;
}

export interface PairTimeoutMessage {
  type: 'pair_timeout';
  peerCode: string;
}

export interface PairErrorMessage {
  type: 'pair_error';
  error: string;
}

export interface OfferReceivedMessage {
  type: 'offer';
  from: string;
  payload: RTCSessionDescriptionInit;
}

export interface AnswerReceivedMessage {
  type: 'answer';
  from: string;
  payload: RTCSessionDescriptionInit;
}

export interface IceCandidateReceivedMessage {
  type: 'ice_candidate';
  from: string;
  payload: RTCIceCandidateInit;
}

export interface PongMessage {
  type: 'pong';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | RegisteredMessage
  | PairIncomingMessage
  | PairExpiringMessage
  | PairMatchedMessage
  | PairRejectedMessage
  | PairTimeoutMessage
  | PairErrorMessage
  | OfferReceivedMessage
  | AnswerReceivedMessage
  | IceCandidateReceivedMessage
  | PongMessage
  | ErrorMessage;

// Data channel messages (after WebRTC connected)
export interface HandshakeMessage {
  type: 'handshake';
  publicKey: string;
}

export interface FileStartMessage {
  type: 'file_start';
  fileId: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  chunkHashes?: string[]; // Optional: SHA-256 hashes for chunk verification
}

export interface FileChunkMessage {
  type: 'file_chunk';
  fileId: string;
  chunkIndex: number;
  data: string; // base64 encrypted
  hash?: string; // Optional: SHA-256 hash of this chunk
}

export interface FileCompleteMessage {
  type: 'file_complete';
  fileId: string;
  fileHash?: string; // Optional: SHA-256 hash of complete file
}

export interface FileErrorMessage {
  type: 'file_error';
  fileId: string;
  error: string;
}

// New reliable file transfer protocol messages

export interface FileStartAckMessage {
  type: 'file_start_ack';
  fileId: string;
  accepted: boolean;
  reason?: string; // If rejected: 'too_large', 'unsupported_type', etc.
}

export interface ChunkAckMessage {
  type: 'chunk_ack';
  fileId: string;
  chunkIndex: number;
  status: 'received' | 'failed';
  hash?: string; // SHA-256 of received chunk for verification
}

export interface ChunkRetryRequestMessage {
  type: 'chunk_retry';
  fileId: string;
  chunkIndices: number[]; // Request retransmission of specific chunks
}

export interface FileCompleteAckMessage {
  type: 'file_complete_ack';
  fileId: string;
  status: 'success' | 'failed';
  missingChunks?: number[];
  fileHash?: string; // SHA-256 of complete file
}

export interface TransferCancelMessage {
  type: 'transfer_cancel';
  fileId: string;
  reason: 'user_cancelled' | 'error' | 'timeout';
}

export type DataChannelMessage =
  | HandshakeMessage
  | FileStartMessage
  | FileChunkMessage
  | FileCompleteMessage
  | FileErrorMessage
  | FileStartAckMessage
  | ChunkAckMessage
  | ChunkRetryRequestMessage
  | FileCompleteAckMessage
  | TransferCancelMessage;

// Connection state
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'registered'
  | 'pairing'
  | 'waiting_approval'
  | 'pending_approval'
  | 'matched'
  | 'webrtc_connecting'
  | 'handshaking'
  | 'connected';

// Chat message
export interface ChatMessage {
  id: string;
  content: string;
  sender: 'me' | 'peer';
  timestamp: Date;
}

// File transfer state
export type TransferState =
  | 'pending'
  | 'awaiting_start_ack'
  | 'transferring'
  | 'awaiting_complete_ack'
  | 'receiving'
  | 'sending'
  | 'complete'
  | 'failed'
  | 'cancelled';

// File transfer
export interface FileTransfer {
  id: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: number;
  ackedChunks?: number; // Chunks acknowledged by receiver (for reliable transfers)
  failedChunks?: number[]; // Chunks that need retry (for reliable transfers)
  retryCount?: number; // Current retry count for the transfer (for reliable transfers)
  state?: TransferState; // Transfer state (for reliable transfers)
  status: 'receiving' | 'sending' | 'complete' | 'failed';
  error?: string;
  data?: Uint8Array[];
  chunkHashes?: string[]; // SHA-256 hashes for verification
  fileHash?: string; // Full file hash for integrity check
  lastActivityTime?: number; // For timeout detection
  transferSpeed?: number; // bytes/second
  estimatedTimeRemaining?: number; // seconds
  direction?: 'sending' | 'receiving'; // For reliable transfers
}
