/**
 * Core types for the Zajel federated server
 */

// Server identity types
export interface ServerIdentity {
  serverId: string;           // "ed25519:<base64-public-key>"
  nodeId: string;             // 160-bit hex hash for DHT positioning
  ephemeralId: string;        // Short human-readable ID like "srv-abc123"
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface ServerInfo {
  serverId: string;
  nodeId: string;
  endpoint: string;
  publicKey: Uint8Array;
  status: ServerStatus;
  incarnation: number;
  lastSeen: number;
  metadata: ServerMetadata;
}

export interface ServerMetadata {
  region?: string;
  version?: string;
  capacity?: number;
  startedAt?: number;
}

export type ServerStatus = 'alive' | 'suspect' | 'failed' | 'left' | 'unknown';

// DHT / Hash Ring types
export interface HashRingNode {
  serverId: string;
  nodeId: string;
  position: bigint;
  virtualPositions: bigint[];
  endpoint: string;
  status: ServerStatus;
  metadata: ServerMetadata;
}

export interface HashRange {
  start: bigint;
  end: bigint;
}

// Gossip protocol types
export type GossipMessageType =
  | 'ping'
  | 'ping_ack'
  | 'ping_req'
  | 'join'
  | 'leave'
  | 'suspect'
  | 'confirm'
  | 'state_sync';

export interface GossipMessage {
  type: 'gossip';
  subtype: GossipMessageType;
  senderId: string;
  sequenceNumber: number;
  timestamp: number;
  payload: unknown;
  piggyback?: MembershipUpdate[];
  signature: string;
}

export interface MembershipUpdate {
  serverId: string;
  status: ServerStatus;
  incarnation: number;
  endpoint?: string;
  nodeId?: string;
}

export interface MembershipEntry {
  serverId: string;
  nodeId: string;
  endpoint: string;
  publicKey: Uint8Array;
  status: ServerStatus;
  incarnation: number;
  lastSeen: number;
  metadata: ServerMetadata;
}

// Registry types
export interface DailyPointEntry {
  id?: number;
  pointHash: string;
  peerId: string;
  deadDrop: string | null;
  relayId: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  vectorClock: VectorClock;
}

export interface HourlyTokenEntry {
  id?: number;
  tokenHash: string;
  peerId: string;
  relayId: string | null;
  expiresAt: number;
  createdAt: number;
  vectorClock: VectorClock;
}

export interface RelayEntry {
  peerId: string;
  maxConnections: number;
  connectedCount: number;
  publicKey: string | null;
  registeredAt: number;
  lastUpdate: number;
}

export interface DeadDropResult {
  peerId: string;
  deadDrop: string;
  relayId: string | null;
}

export interface LiveMatchResult {
  peerId: string;
  relayId: string | null;
}

// Vector clock for conflict resolution
export interface VectorClock {
  [serverId: string]: number;
}

// Client protocol types
export type ClientMessageType =
  | 'register'
  | 'update_load'
  | 'register_rendezvous'
  | 'get_relays'
  | 'ping'
  | 'heartbeat';

export interface ClientMessage {
  type: ClientMessageType;
  [key: string]: unknown;
}

export interface ServerInfoMessage {
  type: 'server_info';
  serverId: string;
  nodeId: string;
  region?: string;
  serverList: Array<{
    serverId: string;
    endpoint: string;
    region?: string;
  }>;
}

export interface RedirectMessage {
  type: 'redirect';
  targetServers: Array<{
    serverId: string;
    endpoint: string;
  }>;
  points: string[];
  reason: string;
}

export interface RendezvousPartialMessage {
  type: 'rendezvous_partial';
  localResult: {
    handledPoints: string[];
    liveMatches: LiveMatchResult[];
    deadDrops: DeadDropResult[];
  };
  redirects: Array<{
    points: string[];
    servers: Array<{
      serverId: string;
      endpoint: string;
    }>;
  }>;
}

// Server-to-server protocol types
export interface ServerHelloMessage {
  type: 'server_hello';
  serverId: string;
  nodeId: string;
  endpoint: string;
  protocolVersion: number;
  timestamp: number;
  signature: string;
}

export interface ReplicateMessage {
  type: 'replicate';
  subtype: 'daily_point' | 'hourly_token';
  pointHash: string;
  entry: DailyPointEntry | HourlyTokenEntry;
  vectorClock: VectorClock;
  originServerId: string;
  signature: string;
}

export interface ReplicateAckMessage {
  type: 'replicate_ack';
  pointHash: string;
  success: boolean;
  vectorClock: VectorClock;
}

// Configuration types
export interface ServerConfig {
  identity: {
    keyPath: string;
    ephemeralIdPrefix: string;
  };
  network: {
    host: string;
    port: number;
    publicEndpoint: string;
    region?: string;
  };
  bootstrap: {
    serverUrl: string;          // CF Workers bootstrap server URL
    heartbeatInterval: number;  // How often to ping CF
    nodes: string[];            // Legacy: direct peer nodes
    retryInterval: number;
    maxRetries: number;
  };
  gossip: {
    interval: number;
    suspicionTimeout: number;
    failureTimeout: number;
    indirectPingCount: number;
    stateExchangeInterval: number;
  };
  dht: {
    replicationFactor: number;
    writeQuorum: number;
    readQuorum: number;
    virtualNodes: number;
  };
  storage: {
    type: 'sqlite';
    path: string;
  };
  client: {
    maxConnectionsPerPeer: number;
    heartbeatInterval: number;
    heartbeatTimeout: number;
  };
  cleanup: {
    interval: number;
    dailyPointTtl: number;
    hourlyTokenTtl: number;
  };
}
