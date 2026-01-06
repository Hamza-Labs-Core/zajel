/**
 * Federation Module Exports
 */

export { FederationManager, type FederationConfig, type FederationEvents } from './federation-manager.js';

// Gossip
export { GossipProtocol, type GossipConfig, type GossipProtocolEvents } from './gossip/protocol.js';
export { Membership, type MembershipEvents } from './gossip/membership.js';
export { FailureDetector, type FailureDetectorConfig, type FailureDetectorEvents } from './gossip/failure-detector.js';

// DHT
export {
  HashRing,
  RoutingTable,
  hashToPosition,
  ringDistance,
  isBetween,
} from './dht/hash-ring.js';

// Transport
export {
  ServerConnectionManager,
  type ServerConnectionConfig,
  type ServerConnectionEvents,
  type HandshakePayload,
  type HandshakeAck,
} from './transport/server-connection.js';
