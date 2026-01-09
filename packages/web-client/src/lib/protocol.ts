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
}

export interface FileChunkMessage {
  type: 'file_chunk';
  fileId: string;
  chunkIndex: number;
  data: string; // base64 encrypted
}

export interface FileCompleteMessage {
  type: 'file_complete';
  fileId: string;
}

export interface FileErrorMessage {
  type: 'file_error';
  fileId: string;
  error: string;
}

export type DataChannelMessage =
  | HandshakeMessage
  | FileStartMessage
  | FileChunkMessage
  | FileCompleteMessage
  | FileErrorMessage;

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

// File transfer
export interface FileTransfer {
  id: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: number;
  status: 'receiving' | 'sending' | 'complete' | 'failed';
  error?: string;
  data?: Uint8Array[];
}
