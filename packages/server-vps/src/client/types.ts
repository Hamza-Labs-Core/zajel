/**
 * Client message types and shared interfaces.
 *
 * Extracted from handler.ts to keep type definitions separate from implementation.
 */

import type { WebSocket } from 'ws';

export interface ClientHandlerConfig {
  heartbeatInterval: number;   // Expected heartbeat interval from clients
  heartbeatTimeout: number;    // Time before considering client dead
  maxConnectionsPerPeer: number;
  pairRequestTimeout?: number; // Timeout for pair request approval (default: 120000ms / 2 minutes)
  pairRequestWarningTime?: number; // Time before timeout to send warning (default: 30000ms / 30 seconds)
}

export interface ClientInfo {
  peerId: string;
  ws: WebSocket;
  connectedAt: number;
  lastSeen: number;
  isRelay: boolean;
}

export interface ClientHandlerEvents {
  'client-connected': (info: ClientInfo) => void;
  'client-disconnected': (peerId: string) => void;
  'message-error': (peerId: string | null, error: Error) => void;
}

// Message types from clients
export interface RegisterMessage {
  type: 'register';
  peerId: string;
  maxConnections?: number;
  publicKey?: string;
}

export interface UpdateLoadMessage {
  type: 'update_load';
  peerId: string;
  connectedCount: number;
}

export interface RegisterRendezvousMessage {
  type: 'register_rendezvous';
  peerId: string;
  // Support both naming conventions for backward compatibility
  dailyPoints?: string[];
  daily_points?: string[];
  hourlyTokens?: string[];
  hourly_tokens?: string[];
  // Support both single dead drop (legacy) and map (new)
  deadDrop?: string;
  deadDrops?: Record<string, string>;  // point -> encrypted payload
  dead_drops?: Record<string, string>; // snake_case variant
  relayId: string;
}

export interface GetRelaysMessage {
  type: 'get_relays';
  peerId: string;
  count?: number;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  peerId: string;
}

export interface PingMessage {
  type: 'ping';
}

// WebRTC signaling messages (for pairing code-based connections)
export interface SignalingRegisterMessage {
  type: 'register';
  pairingCode: string;
  publicKey: string;  // Public key for E2E encryption
}

export interface PairRequestMessage {
  type: 'pair_request';
  targetCode: string;
  proposedName?: string;
}

export interface PairResponseMessage {
  type: 'pair_response';
  targetCode: string;
  accepted: boolean;
}

export interface SignalingOfferMessage {
  type: 'offer';
  target: string;  // Target pairing code
  payload: Record<string, unknown>;
}

export interface SignalingAnswerMessage {
  type: 'answer';
  target: string;
  payload: Record<string, unknown>;
}

export interface SignalingIceCandidateMessage {
  type: 'ice_candidate';
  target: string;
  payload: Record<string, unknown>;
}

// VoIP call signaling messages
export interface CallOfferMessage {
  type: 'call_offer';
  target: string;
  payload: Record<string, unknown>;
}

export interface CallAnswerMessage {
  type: 'call_answer';
  target: string;
  payload: Record<string, unknown>;
}

export interface CallRejectMessage {
  type: 'call_reject';
  target: string;
  payload: Record<string, unknown>;
}

export interface CallHangupMessage {
  type: 'call_hangup';
  target: string;
  payload: Record<string, unknown>;
}

export interface CallIceMessage {
  type: 'call_ice';
  target: string;
  payload: Record<string, unknown>;
}

// Device linking messages (web client linking to mobile app)
export interface LinkRequestMessage {
  type: 'link_request';
  linkCode: string;      // The link code from the mobile app's QR
  publicKey: string;     // Web client's public key
  deviceName?: string;   // Browser name (e.g., "Chrome on Windows")
}

export interface LinkResponseMessage {
  type: 'link_response';
  linkCode: string;
  accepted: boolean;
  deviceId?: string;     // Assigned device ID if accepted
}

// Channel upstream message (subscriber -> VPS -> owner)
export interface UpstreamMessageData {
  type: 'upstream-message';
  channelId: string;
  message: Record<string, unknown>;
  ephemeralPublicKey: string;
}

// Channel stream messages
export interface StreamStartMessage {
  type: 'stream-start';
  streamId: string;
  channelId: string;
  title: string;
}

export interface StreamFrameMessage {
  type: 'stream-frame';
  streamId: string;
  channelId: string;
  frame: Record<string, unknown>;
}

export interface StreamEndMessage {
  type: 'stream-end';
  streamId: string;
  channelId: string;
}

// Channel subscription registration (subscriber registers interest)
export interface ChannelSubscribeMessage {
  type: 'channel-subscribe';
  channelId: string;
}

// Channel owner registration (owner registers as the owner)
export interface ChannelOwnerRegisterMessage {
  type: 'channel-owner-register';
  channelId: string;
}

// Chunk relay messages
export interface ChunkAnnounceMessage {
  type: 'chunk_announce';
  peerId: string;
  channelId?: string;
  chunks: Array<{ chunkId: string; routingHash?: string }>;
}

export interface ChunkRequestMessage {
  type: 'chunk_request';
  chunkId: string;
  channelId: string;
}

export interface ChunkPushMessage {
  type: 'chunk_push';
  chunkId: string;
  channelId: string;
  data: string | Record<string, unknown>; // JSON object (from client) or string (legacy)
}

// Attestation messages
export interface AttestRequestMessage {
  type: 'attest_request';
  build_token: string;
  device_id: string;
}

export interface AttestResponseMessage {
  type: 'attest_response';
  nonce: string;
  responses: Array<{ region_index: number; hmac: string }>;
}

// Pending pair request tracking
export interface PendingPairRequest {
  requesterCode: string;
  requesterPublicKey: string;
  targetCode: string;
  timestamp: number;
}

// Rate limiting tracking per WebSocket connection
export interface RateLimitInfo {
  messageCount: number;
  windowStart: number;
}

// Pair request rate limiting tracking per WebSocket connection
export interface PairRequestRateLimitInfo {
  requestCount: number;
  windowStart: number;
}

// Entropy metrics for pairing code monitoring (Issue #41)
export interface EntropyMetrics {
  activeCodes: number;
  peakActiveCodes: number;
  totalRegistrations: number;
  collisionAttempts: number;
  collisionRisk: 'low' | 'medium' | 'high';
}

export type ClientMessage =
  | RegisterMessage
  | UpdateLoadMessage
  | RegisterRendezvousMessage
  | GetRelaysMessage
  | HeartbeatMessage
  | PingMessage
  | SignalingRegisterMessage
  | PairRequestMessage
  | PairResponseMessage
  | SignalingOfferMessage
  | SignalingAnswerMessage
  | SignalingIceCandidateMessage
  | CallOfferMessage
  | CallAnswerMessage
  | CallRejectMessage
  | CallHangupMessage
  | CallIceMessage
  | LinkRequestMessage
  | LinkResponseMessage
  | UpstreamMessageData
  | StreamStartMessage
  | StreamFrameMessage
  | StreamEndMessage
  | ChannelSubscribeMessage
  | ChannelOwnerRegisterMessage
  | ChunkAnnounceMessage
  | ChunkRequestMessage
  | ChunkPushMessage
  | AttestRequestMessage
  | AttestResponseMessage;
