/**
 * Membership Management
 *
 * Tracks the membership state of all known servers in the federation.
 * Uses incarnation numbers for consistency and conflict resolution.
 */

import { EventEmitter } from 'events';
import type { MembershipEntry, ServerStatus, MembershipUpdate, ServerMetadata } from '../../types.js';

export interface MembershipEvents {
  'member-join': (entry: MembershipEntry) => void;
  'member-leave': (serverId: string) => void;
  'member-suspect': (entry: MembershipEntry) => void;
  'member-failed': (entry: MembershipEntry) => void;
  'member-alive': (entry: MembershipEntry) => void;
  'member-update': (entry: MembershipEntry) => void;
}

export class Membership extends EventEmitter {
  private members: Map<string, MembershipEntry> = new Map();
  private localServerId: string;
  private localIncarnation = 0;

  constructor(localServerId: string) {
    super();
    this.localServerId = localServerId;
  }

  /**
   * Get our local incarnation number
   */
  get incarnation(): number {
    return this.localIncarnation;
  }

  /**
   * Increment our incarnation (used to refute suspicion)
   */
  incrementIncarnation(): number {
    this.localIncarnation++;
    return this.localIncarnation;
  }

  /**
   * Add or update a member
   */
  upsert(entry: MembershipEntry): boolean {
    const existing = this.members.get(entry.serverId);

    if (!existing) {
      // New member
      this.members.set(entry.serverId, entry);
      this.emit('member-join', entry);
      return true;
    }

    // Check if this is newer information (higher incarnation)
    if (entry.incarnation > existing.incarnation) {
      this.members.set(entry.serverId, entry);
      this.emitStatusChange(existing.status, entry);
      return true;
    }

    // Same incarnation - prefer alive over suspect over failed
    if (entry.incarnation === existing.incarnation) {
      const priority: Record<ServerStatus, number> = {
        alive: 3,
        suspect: 2,
        failed: 1,
        left: 0,
        unknown: 0,
      };

      if (priority[entry.status] > priority[existing.status]) {
        this.members.set(entry.serverId, entry);
        this.emitStatusChange(existing.status, entry);
        return true;
      }
    }

    return false;
  }

  /**
   * Apply a membership update from gossip
   */
  applyUpdate(update: MembershipUpdate): boolean {
    const existing = this.members.get(update.serverId);

    // If this is about us and marks us as suspect/failed, refute it
    if (update.serverId === this.localServerId) {
      if (update.status === 'suspect' || update.status === 'failed') {
        this.incrementIncarnation();
        return false; // We'll broadcast our higher incarnation
      }
      return false;
    }

    if (!existing) {
      // Only accept if we have enough info to create a full entry
      if (update.endpoint && update.nodeId) {
        // For now, skip - we need the full entry from state sync
        return false;
      }
      return false;
    }

    // Check incarnation
    if (update.incarnation > existing.incarnation) {
      existing.status = update.status;
      existing.incarnation = update.incarnation;
      existing.lastSeen = Date.now();
      this.emitStatusChange(existing.status, existing);
      return true;
    }

    if (update.incarnation === existing.incarnation) {
      const priority: Record<ServerStatus, number> = {
        alive: 3,
        suspect: 2,
        failed: 1,
        left: 0,
        unknown: 0,
      };

      if (priority[update.status] > priority[existing.status]) {
        existing.status = update.status;
        existing.lastSeen = Date.now();
        this.emitStatusChange(existing.status, existing);
        return true;
      }
    }

    return false;
  }

  /**
   * Mark a member as suspect
   */
  suspect(serverId: string): boolean {
    const entry = this.members.get(serverId);
    if (!entry || entry.status !== 'alive') return false;

    entry.status = 'suspect';
    entry.lastSeen = Date.now();
    this.emit('member-suspect', entry);
    return true;
  }

  /**
   * Mark a member as failed
   */
  fail(serverId: string): boolean {
    const entry = this.members.get(serverId);
    if (!entry) return false;

    entry.status = 'failed';
    entry.lastSeen = Date.now();
    this.emit('member-failed', entry);
    return true;
  }

  /**
   * Mark a member as alive (refute suspicion)
   */
  alive(serverId: string, incarnation: number): boolean {
    const entry = this.members.get(serverId);
    if (!entry) return false;

    if (incarnation >= entry.incarnation) {
      entry.status = 'alive';
      entry.incarnation = incarnation;
      entry.lastSeen = Date.now();
      this.emit('member-alive', entry);
      return true;
    }
    return false;
  }

  /**
   * Remove a member (graceful leave)
   */
  remove(serverId: string): boolean {
    const entry = this.members.get(serverId);
    if (!entry) return false;

    entry.status = 'left';
    this.members.delete(serverId);
    this.emit('member-leave', serverId);
    return true;
  }

  /**
   * Get a member by ID
   */
  get(serverId: string): MembershipEntry | undefined {
    return this.members.get(serverId);
  }

  /**
   * Get all members
   */
  getAll(): MembershipEntry[] {
    return Array.from(this.members.values());
  }

  /**
   * Get all alive members
   */
  getAlive(): MembershipEntry[] {
    return this.getAll().filter(m => m.status === 'alive');
  }

  /**
   * Get members by status
   */
  getByStatus(status: ServerStatus): MembershipEntry[] {
    return this.getAll().filter(m => m.status === status);
  }

  /**
   * Get random alive members (excluding self)
   */
  getRandomAlive(count: number, exclude: string[] = []): MembershipEntry[] {
    const candidates = this.getAlive().filter(
      m => m.serverId !== this.localServerId && !exclude.includes(m.serverId)
    );

    // Fisher-Yates shuffle
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }

    return candidates.slice(0, count);
  }

  /**
   * Get count of members
   */
  get size(): number {
    return this.members.size;
  }

  /**
   * Get count of alive members
   */
  get aliveCount(): number {
    return this.getAlive().length;
  }

  /**
   * Check if a server is alive
   */
  isAlive(serverId: string): boolean {
    const entry = this.members.get(serverId);
    return entry?.status === 'alive';
  }

  /**
   * Generate updates for piggybacking
   * Returns recent state changes that should be gossiped
   */
  getRecentUpdates(limit = 10): MembershipUpdate[] {
    // Sort by lastSeen descending to get most recent
    const sorted = this.getAll()
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit);

    return sorted.map(m => ({
      serverId: m.serverId,
      status: m.status,
      incarnation: m.incarnation,
      endpoint: m.endpoint,
      nodeId: m.nodeId,
    }));
  }

  /**
   * Merge a full state from another server (state sync)
   */
  mergeState(entries: MembershipEntry[]): number {
    let changes = 0;
    for (const entry of entries) {
      if (entry.serverId === this.localServerId) continue;
      if (this.upsert(entry)) {
        changes++;
      }
    }
    return changes;
  }

  /**
   * Export full state for state sync
   */
  exportState(): MembershipEntry[] {
    return this.getAll();
  }

  /**
   * Emit appropriate event for status change
   */
  private emitStatusChange(oldStatus: ServerStatus, entry: MembershipEntry): void {
    switch (entry.status) {
      case 'alive':
        this.emit('member-alive', entry);
        break;
      case 'suspect':
        this.emit('member-suspect', entry);
        break;
      case 'failed':
        this.emit('member-failed', entry);
        break;
      case 'left':
        this.emit('member-leave', entry.serverId);
        break;
      default:
        this.emit('member-update', entry);
    }
  }
}
