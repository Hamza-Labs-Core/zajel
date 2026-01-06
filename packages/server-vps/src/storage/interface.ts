/**
 * Storage Interface
 *
 * Defines the abstract interface for all storage operations.
 * Currently only SQLite is implemented, but this allows for future backends.
 */

import type {
  DailyPointEntry,
  HourlyTokenEntry,
  RelayEntry,
  VectorClock,
  MembershipEntry,
  ServerIdentity,
} from '../types.js';

export interface Storage {
  // Lifecycle
  init(): Promise<void>;
  close(): void;

  // Server identity
  saveIdentity(identity: ServerIdentity): Promise<void>;
  loadIdentity(): Promise<ServerIdentity | null>;

  // Daily meeting points
  saveDailyPoint(entry: DailyPointEntry): Promise<void>;
  getDailyPoints(pointHash: string): Promise<DailyPointEntry[]>;
  getDailyPointsByPeer(peerId: string): Promise<DailyPointEntry[]>;
  deleteDailyPoint(pointHash: string, peerId: string): Promise<boolean>;
  deleteDailyPointsByPeer(peerId: string): Promise<number>;
  deleteExpiredDailyPoints(beforeTimestamp: number): Promise<number>;
  getDailyPointStats(): Promise<{ totalEntries: number; uniquePoints: number }>;

  // Hourly tokens
  saveHourlyToken(entry: HourlyTokenEntry): Promise<void>;
  getHourlyTokens(tokenHash: string): Promise<HourlyTokenEntry[]>;
  getHourlyTokensByPeer(peerId: string): Promise<HourlyTokenEntry[]>;
  deleteHourlyToken(tokenHash: string, peerId: string): Promise<boolean>;
  deleteHourlyTokensByPeer(peerId: string): Promise<number>;
  deleteExpiredHourlyTokens(beforeTimestamp: number): Promise<number>;
  getHourlyTokenStats(): Promise<{ totalEntries: number; uniqueTokens: number }>;

  // Relay registry
  saveRelay(relay: RelayEntry): Promise<void>;
  getRelay(peerId: string): Promise<RelayEntry | null>;
  getAllRelays(): Promise<RelayEntry[]>;
  getAvailableRelays(excludePeerId: string, maxCapacityRatio: number, limit: number): Promise<RelayEntry[]>;
  updateRelayLoad(peerId: string, connectedCount: number): Promise<boolean>;
  deleteRelay(peerId: string): Promise<boolean>;

  // Known servers (federation)
  saveServer(server: MembershipEntry): Promise<void>;
  upsertServer(server: MembershipEntry): Promise<void>;
  getServer(serverId: string): Promise<MembershipEntry | null>;
  getAllServers(): Promise<MembershipEntry[]>;
  getServersByStatus(status: string): Promise<MembershipEntry[]>;
  updateServerStatus(serverId: string, status: string, incarnation: number): Promise<boolean>;
  deleteServer(serverId: string): Promise<boolean>;

  // Membership snapshot
  saveMembershipSnapshot(snapshot: object): Promise<void>;
  loadMembershipSnapshot(): Promise<object | null>;

  // Vector clocks
  saveVectorClock(key: string, clock: VectorClock): Promise<void>;
  getVectorClock(key: string): Promise<VectorClock | null>;
  deleteVectorClock(key: string): Promise<boolean>;

  // Statistics
  getStats(): Promise<StorageStats>;
}

export interface StorageStats {
  dailyPoints: number;
  hourlyTokens: number;
  relays: number;
  servers: number;
  dbSizeBytes?: number;
}
