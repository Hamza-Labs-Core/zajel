/**
 * Threat Intelligence Sharing
 *
 * Extends the SWIM gossip protocol to share IP blocklists and attack
 * patterns across the federation. VPS servers share reputation data
 * to enable cluster-wide defense against distributed attacks.
 */

import type { VPSReputationManager } from '../reputation/ip-reputation.js';
import { logger } from '../utils/logger.js';

export interface BlockedIP {
  ip: string;
  score: number;
  reason: string;
  expiresAt: number;
  serverId: string; // Which server reported this
}

export interface AttackPattern {
  pattern: string; // e.g., "pair_request_flood", "connection_spam"
  severity: 'low' | 'medium' | 'high';
  detectedAt: number;
  metadata?: Record<string, unknown>;
}

export interface ThreatIntelPayload {
  blockedIPs: BlockedIP[];
  attackPatterns: AttackPattern[];
  timestamp: number;
  serverId: string;
}

/**
 * Threat intel messages use a separate message envelope, not the signed
 * GossipMessage format. This avoids modifying the core gossip protocol
 * types and keeps threat intel decoupled from the SWIM protocol.
 */
export interface ThreatIntelMessage {
  type: 'threat_intel'; // Distinct from 'gossip' to avoid GossipMessage type conflicts
  data: ThreatIntelPayload;
}

export class ThreatIntelManager {
  private reputationManager: VPSReputationManager;
  private serverId: string;

  // Track IPs reported by federation (don't re-gossip our own reports)
  private federatedBlockedIPs: Map<string, BlockedIP> = new Map();

  constructor(reputationManager: VPSReputationManager, serverId: string) {
    this.reputationManager = reputationManager;
    this.serverId = serverId;
  }

  /**
   * Generate threat intelligence payload to share with federation.
   * Called periodically by the gossip protocol.
   */
  async generatePayload(): Promise<ThreatIntelPayload> {
    // Get top offenders from local reputation system
    const topOffenders = await this.reputationManager.getTopOffenders(50);

    // Only share IPs with score >= 20 (medium-high threat)
    const blockedIPs: BlockedIP[] = topOffenders
      .filter(entry => entry.reputationScore >= 20)
      .map(entry => ({
        ip: entry.ipAddress,
        score: entry.reputationScore,
        reason: this._inferReason(entry),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
        serverId: this.serverId,
      }));

    // TODO: Implement attack pattern detection
    const attackPatterns: AttackPattern[] = [];

    return {
      blockedIPs,
      attackPatterns,
      timestamp: Date.now(),
      serverId: this.serverId,
    };
  }

  /**
   * Process threat intelligence received from another server.
   * Apply received blocklist to local reputation system.
   */
  async processIncoming(payload: ThreatIntelPayload): Promise<void> {
    if (payload.serverId === this.serverId) {
      // Don't process our own reports
      return;
    }

    logger.info(`[ThreatIntel] Received threat data from ${payload.serverId}: ${payload.blockedIPs.length} IPs`);

    for (const blockedIP of payload.blockedIPs) {
      // Check if IP is already blocked locally
      const localScore = await this.reputationManager.getScore(blockedIP.ip);

      if (localScore < 15) {
        // Local score is low - trust federation report and boost reputation
        await this.reputationManager.recordEvent(
          blockedIP.ip,
          'invalid_request', // Use as generic "bad behavior" event
          {
            source: 'federation',
            reportedBy: blockedIP.serverId,
            remoteScore: blockedIP.score,
            reason: blockedIP.reason,
          }
        );

        logger.info(`[ThreatIntel] Boosted reputation for ${blockedIP.ip} based on federation report`);
      }

      // Track federated blocks
      this.federatedBlockedIPs.set(blockedIP.ip, blockedIP);
    }

    // Process attack patterns
    for (const pattern of payload.attackPatterns) {
      logger.warn(`[ThreatIntel] Attack pattern detected by ${payload.serverId}: ${pattern.pattern} (${pattern.severity})`);
      // TODO: Implement pattern-based defenses
    }
  }

  /**
   * Get list of IPs blocked by federation (for admin dashboard).
   */
  getFederatedBlocks(): BlockedIP[] {
    const now = Date.now();
    const active: BlockedIP[] = [];

    for (const [ip, block] of this.federatedBlockedIPs.entries()) {
      if (block.expiresAt > now) {
        active.push(block);
      } else {
        // Clean up expired blocks
        this.federatedBlockedIPs.delete(ip);
      }
    }

    return active;
  }

  /**
   * Infer reason string from reputation entry counters.
   * @private
   */
  private _inferReason(entry: { rateLimitHits: number; connectionRejects: number; invalidRequests: number }): string {
    if (entry.invalidRequests > 10) return 'invalid_request_spam';
    if (entry.rateLimitHits > 20) return 'rate_limit_abuse';
    if (entry.connectionRejects > 15) return 'connection_spam';
    return 'general_abuse';
  }
}
