/**
 * Registry Module Exports
 */

export { RelayRegistry, type RelayInfo, type RelayResult, type RelayRegistryEvents } from './relay-registry.js';

export {
  RendezvousRegistry,
  type DeadDropResult,
  type LiveMatchResult,
  type RendezvousRegistryConfig,
  type RendezvousRegistryEvents,
} from './rendezvous-registry.js';

export {
  DistributedRendezvous,
  type DistributedRendezvousConfig,
  type DistributedRendezvousEvents,
  type PartialResult,
} from './distributed-rendezvous.js';
