/**
 * Threat Intelligence Aggregator
 *
 * Aggregates threat data from VPS server heartbeats and provides
 * fleet-wide IP blocklists to the CF Worker reputation system.
 */

export class ThreatAggregator {
  /**
   * @param {DurableObjectStub} doStub - ServerRegistryDO stub for querying
   *   threat data. This is used **only** from the CF Worker entry point
   *   (external to the DO), never from within the DO itself.
   *   Heartbeat-time threat data storage is handled directly inside the
   *   DO's fetch handler (see server-registry-do.js) to avoid circular self-calls.
   */
  constructor(doStub) {
    this.doStub = doStub;
  }

  /**
   * Get aggregated blocked IPs from all VPS servers.
   * Used by reputation manager to boost scores for IPs blocked fleet-wide.
   *
   * @returns {Promise<string[]>} List of blocked IP addresses
   */
  async getBlockedIPs() {
    const response = await this.doStub.fetch(
      new Request('https://internal/threat-intel/blocked-ips')
    );
    const data = await response.json();
    return data.blockedIPs || [];
  }

  /**
   * Check if an IP is blocked fleet-wide.
   *
   * @param {string} ip - IP address to check
   * @returns {Promise<boolean>}
   */
  async isBlockedFleetWide(ip) {
    const blockedIPs = await this.getBlockedIPs();
    return blockedIPs.includes(ip);
  }
}
