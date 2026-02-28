/**
 * Handler Context
 *
 * Defines the shared state and utility interface that sub-handlers receive
 * from the main ClientHandler. This decouples sub-handlers from the
 * concrete ClientHandler class while giving them access to shared state.
 */

import type { WebSocket } from 'ws';
import type { ServerIdentity, ServerMetadata } from '../types.js';
import type { RelayRegistry } from '../registry/relay-registry.js';
import type { DistributedRendezvous } from '../registry/distributed-rendezvous.js';
import type { AttestationManager } from '../attestation/attestation-manager.js';
import type { FederationManager } from '../federation/federation-manager.js';
import type { ChunkRelay } from './chunk-relay.js';
import type { SignalingHandler } from './signaling-handler.js';
import type { ChannelHandler } from './channel-handler.js';
import type { ClientHandlerConfig, ClientInfo } from './types.js';

/**
 * Read-only view of shared handler state, passed to sub-handlers so they
 * can look up peers, send messages, and access registries without holding
 * a reference to the full ClientHandler.
 */
export interface HandlerContext {
  // --- Identity & config ---------------------------------------------------
  readonly identity: ServerIdentity;
  readonly endpoint: string;
  readonly metadata: ServerMetadata;
  readonly config: ClientHandlerConfig;

  // --- Registries -----------------------------------------------------------
  readonly relayRegistry: RelayRegistry;
  readonly distributedRendezvous: DistributedRendezvous;

  // --- Optional subsystems --------------------------------------------------
  readonly attestationManager: AttestationManager | null;
  readonly federation: FederationManager | null;
  readonly chunkRelay: ChunkRelay | null;

  // --- Sub-handlers (for cross-handler lookups) -----------------------------
  readonly signalingHandler: SignalingHandler;
  readonly channelHandler: ChannelHandler;

  // --- Client maps ----------------------------------------------------------
  readonly clients: Map<string, ClientInfo>;
  readonly wsToClient: Map<WebSocket, string>;

  // --- Attestation session map ----------------------------------------------
  readonly wsToConnectionId: Map<WebSocket, string>;

  // --- Utility functions ----------------------------------------------------
  send(ws: WebSocket, message: object): boolean;
  sendError(ws: WebSocket, message: string): void;
  notifyClient(peerId: string, message: object): boolean;
}
