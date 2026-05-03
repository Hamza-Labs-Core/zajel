/**
 * Unit tests for Membership.pruneStale().
 *
 * Without periodic pruning, the gossip membership table accumulates
 * every short-lived peer ever gossiped about — short-lived CI probes,
 * crashed VPSs, deleted Cranl containers. They sit in `suspect` or
 * `failed` forever because only an explicit `leave` announcement
 * evicts them, and dead peers can't send one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Membership } from '../../src/federation/gossip/membership.js';
import type { MembershipEntry, ServerStatus } from '../../src/types.js';

function makeEntry(
  serverId: string,
  status: ServerStatus,
  lastSeen: number,
): MembershipEntry {
  return {
    serverId,
    nodeId: serverId,
    endpoint: `ws://${serverId}.example.com`,
    publicKey: new Uint8Array(32),
    status,
    incarnation: 0,
    lastSeen,
  };
}

describe('Membership.pruneStale', () => {
  let membership: Membership;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T00:00:00Z'));
    membership = new Membership('ed25519:local');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes failed members older than the default 30 min TTL', () => {
    const nowMs = Date.now();
    membership.upsert(makeEntry('ed25519:fresh-fail', 'failed', nowMs - 5 * 60 * 1000));
    membership.upsert(makeEntry('ed25519:stale-fail', 'failed', nowMs - 40 * 60 * 1000));

    const removed = membership.pruneStale();
    expect(removed).toBe(1);

    const ids = membership.getAll().map((m) => m.serverId).sort();
    expect(ids).toEqual(['ed25519:fresh-fail']);
  });

  it('removes suspect members older than the default 1 hour TTL', () => {
    const nowMs = Date.now();
    membership.upsert(makeEntry('ed25519:recent-suspect', 'suspect', nowMs - 55 * 60 * 1000));
    membership.upsert(makeEntry('ed25519:old-suspect', 'suspect', nowMs - 70 * 60 * 1000));

    const removed = membership.pruneStale();
    expect(removed).toBe(1);

    const ids = membership.getAll().map((m) => m.serverId).sort();
    expect(ids).toEqual(['ed25519:recent-suspect']);
  });

  it('never prunes alive members, however old', () => {
    const nowMs = Date.now();
    membership.upsert(makeEntry('ed25519:old-alive', 'alive', nowMs - 24 * 60 * 60 * 1000));

    const removed = membership.pruneStale();
    expect(removed).toBe(0);
    expect(membership.getAll().map((m) => m.serverId)).toEqual(['ed25519:old-alive']);
  });

  it('never prunes the local server even if its lastSeen is ancient', () => {
    const nowMs = Date.now();
    membership.upsert(makeEntry('ed25519:local', 'failed', nowMs - 24 * 60 * 60 * 1000));

    const removed = membership.pruneStale();
    expect(removed).toBe(0);
    expect(membership.getAll().map((m) => m.serverId)).toContain('ed25519:local');
  });

  it('emits member-leave for each purged entry', () => {
    const nowMs = Date.now();
    membership.upsert(makeEntry('ed25519:stale-a', 'failed', nowMs - 40 * 60 * 1000));
    membership.upsert(makeEntry('ed25519:stale-b', 'left', nowMs - 40 * 60 * 1000));

    const left: string[] = [];
    membership.on('member-leave', (id) => left.push(id));

    membership.pruneStale();
    expect(left.sort()).toEqual(['ed25519:stale-a', 'ed25519:stale-b']);
  });

  it('respects custom TTL options', () => {
    const nowMs = Date.now();
    membership.upsert(makeEntry('ed25519:fail-2min', 'failed', nowMs - 2 * 60 * 1000));

    // With a 1-min failed TTL, the 2-min-old one should be pruned.
    expect(membership.pruneStale({ failedTtlMs: 60 * 1000 })).toBe(1);
  });

  it('returns 0 when nothing to prune', () => {
    const nowMs = Date.now();
    membership.upsert(makeEntry('ed25519:alive', 'alive', nowMs));
    membership.upsert(makeEntry('ed25519:recent-fail', 'failed', nowMs - 60 * 1000));

    expect(membership.pruneStale()).toBe(0);
    expect(membership.getAll()).toHaveLength(2);
  });
});
