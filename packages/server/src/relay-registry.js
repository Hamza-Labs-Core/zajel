/**
 * RelayRegistry
 *
 * Manages peer relay registration and tracking for the Zajel signaling server.
 * Tracks online peers, their connection capacity, and provides load-balanced
 * relay selection for peer-to-peer connections.
 */

export class RelayRegistry {
  constructor() {
    /** @type {Map<string, PeerInfo>} */
    this.peers = new Map();
  }

  /**
   * Register a peer as an available relay
   * @param {string} peerId - Unique peer identifier
   * @param {Object} options - Registration options
   * @param {number} [options.maxConnections=20] - Maximum connections this peer can handle
   * @param {string} [options.publicKey] - Public key for E2E encryption
   */
  register(peerId, { maxConnections = 20, publicKey = null } = {}) {
    const existing = this.peers.get(peerId);
    const now = Date.now();

    this.peers.set(peerId, {
      peerId,
      maxConnections,
      connectedCount: existing?.connectedCount ?? 0,
      publicKey,
      registeredAt: existing?.registeredAt ?? now,
      lastUpdate: now,
    });
  }

  /**
   * Get peer information by ID
   * @param {string} peerId - Peer identifier
   * @returns {PeerInfo|undefined} Peer info or undefined if not found
   */
  getPeer(peerId) {
    return this.peers.get(peerId);
  }

  /**
   * Update the connection load for a peer
   * @param {string} peerId - Peer identifier
   * @param {number} connectedCount - Current number of connections
   */
  updateLoad(peerId, connectedCount) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.connectedCount = connectedCount;
      peer.lastUpdate = Date.now();
    }
  }

  /**
   * Get available relays with less than 50% capacity
   * Results are shuffled for load distribution
   * @param {string} excludePeerId - Peer ID to exclude from results (usually the requester)
   * @param {number} [count=10] - Maximum number of relays to return
   * @returns {Array<RelayInfo>} Available relays sorted randomly
   */
  getAvailableRelays(excludePeerId, count = 10) {
    const available = [];

    for (const [id, peer] of this.peers) {
      if (id === excludePeerId) continue;

      const capacity = peer.connectedCount / peer.maxConnections;
      if (capacity < 0.5) {
        available.push({
          peerId: id,
          publicKey: peer.publicKey,
          capacity,
        });
      }
    }

    // Fisher-Yates shuffle for random distribution
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }

    return available.slice(0, count);
  }

  /**
   * Unregister a peer from the relay registry
   * @param {string} peerId - Peer identifier to remove
   */
  unregister(peerId) {
    this.peers.delete(peerId);
  }

  /**
   * Get all registered peers
   * @returns {Array<PeerInfo>} All peer info objects
   */
  getAllPeers() {
    return Array.from(this.peers.values());
  }

  /**
   * Get registry statistics
   * @returns {Object} Statistics about the registry
   */
  getStats() {
    let totalCapacity = 0;
    let totalConnected = 0;
    let availableRelays = 0;

    for (const peer of this.peers.values()) {
      totalCapacity += peer.maxConnections;
      totalConnected += peer.connectedCount;

      const capacity = peer.connectedCount / peer.maxConnections;
      if (capacity < 0.5) {
        availableRelays++;
      }
    }

    return {
      totalPeers: this.peers.size,
      totalCapacity,
      totalConnected,
      availableRelays,
    };
  }
}

/**
 * @typedef {Object} PeerInfo
 * @property {string} peerId - Unique peer identifier
 * @property {number} maxConnections - Maximum connections this peer can handle
 * @property {number} connectedCount - Current number of active connections
 * @property {string|null} publicKey - Public key for E2E encryption
 * @property {number} registeredAt - Unix timestamp of registration
 * @property {number} lastUpdate - Unix timestamp of last update
 */

/**
 * @typedef {Object} RelayInfo
 * @property {string} peerId - Relay peer identifier
 * @property {string|null} publicKey - Public key for E2E encryption
 * @property {number} capacity - Current capacity ratio (0-1)
 */
