# Server Implementation Plan: Relay Registry + Rendezvous + Dead Drop

## Overview
Implement the signaling server as a Cloudflare Worker with Durable Objects for:
1. Relay Registry - track online peers and their capacity
2. Rendezvous Registry - match peers using meeting points
3. Dead Drop Storage - async message exchange

## Architecture

```
Cloudflare Worker
├── /ws - WebSocket endpoint
├── /health - Health check
└── Durable Objects
    ├── RelayRegistry - peer tracking
    └── RendezvousRegistry - meeting points + dead drops
```

## TDD Test Cases

### 1. Relay Registry Tests

```javascript
// tests/relay-registry.test.js

describe('RelayRegistry', () => {
  describe('register', () => {
    it('should register a peer with capacity info', async () => {
      const registry = new RelayRegistry();
      registry.register('peer1', { maxConnections: 20, publicKey: 'pk1' });

      expect(registry.getPeer('peer1')).toEqual({
        peerId: 'peer1',
        maxConnections: 20,
        connectedCount: 0,
        publicKey: 'pk1',
      });
    });

    it('should update existing peer on re-register', async () => {
      const registry = new RelayRegistry();
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer1', { maxConnections: 30 });

      expect(registry.getPeer('peer1').maxConnections).toBe(30);
    });
  });

  describe('getAvailableRelays', () => {
    it('should return peers with less than 50% capacity', async () => {
      const registry = new RelayRegistry();
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer2', { maxConnections: 20 });
      registry.updateLoad('peer1', 5);  // 25% - available
      registry.updateLoad('peer2', 15); // 75% - not available

      const available = registry.getAvailableRelays('exclude1', 10);

      expect(available).toHaveLength(1);
      expect(available[0].peerId).toBe('peer1');
    });

    it('should exclude the requesting peer', async () => {
      const registry = new RelayRegistry();
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer2', { maxConnections: 20 });

      const available = registry.getAvailableRelays('peer1', 10);

      expect(available.find(p => p.peerId === 'peer1')).toBeUndefined();
    });

    it('should return at most N peers', async () => {
      const registry = new RelayRegistry();
      for (let i = 0; i < 20; i++) {
        registry.register(`peer${i}`, { maxConnections: 20 });
      }

      const available = registry.getAvailableRelays('exclude', 5);

      expect(available).toHaveLength(5);
    });

    it('should shuffle results for load distribution', async () => {
      const registry = new RelayRegistry();
      for (let i = 0; i < 10; i++) {
        registry.register(`peer${i}`, { maxConnections: 20 });
      }

      const results1 = registry.getAvailableRelays('x', 10).map(p => p.peerId);
      const results2 = registry.getAvailableRelays('x', 10).map(p => p.peerId);

      // Not guaranteed but highly likely to be different order
      expect(results1).not.toEqual(results2);
    });
  });

  describe('updateLoad', () => {
    it('should update connected count', async () => {
      const registry = new RelayRegistry();
      registry.register('peer1', { maxConnections: 20 });
      registry.updateLoad('peer1', 10);

      expect(registry.getPeer('peer1').connectedCount).toBe(10);
    });
  });

  describe('unregister', () => {
    it('should remove peer from registry', async () => {
      const registry = new RelayRegistry();
      registry.register('peer1', { maxConnections: 20 });
      registry.unregister('peer1');

      expect(registry.getPeer('peer1')).toBeUndefined();
    });
  });
});
```

### 2. Rendezvous Registry Tests

```javascript
// tests/rendezvous-registry.test.js

describe('RendezvousRegistry', () => {
  describe('registerDailyPoints', () => {
    it('should register daily meeting points with dead drop', async () => {
      const registry = new RendezvousRegistry();

      registry.registerDailyPoints('peer1', {
        points: ['day_abc123', 'day_def456', 'day_ghi789'],
        deadDrop: 'encrypted_payload',
        relayId: 'relay1',
      });

      const entries = registry.getDailyPoint('day_abc123');
      expect(entries).toHaveLength(1);
      expect(entries[0].peerId).toBe('peer1');
      expect(entries[0].deadDrop).toBe('encrypted_payload');
    });

    it('should find existing dead drops when registering', async () => {
      const registry = new RendezvousRegistry();

      // Alice registers first
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'alice_encrypted',
        relayId: 'relay1',
      });

      // Bob registers same point
      const result = registry.registerDailyPoints('bob', {
        points: ['day_abc123'],
        deadDrop: 'bob_encrypted',
        relayId: 'relay2',
      });

      expect(result.deadDrops).toHaveLength(1);
      expect(result.deadDrops[0].peerId).toBe('alice');
      expect(result.deadDrops[0].deadDrop).toBe('alice_encrypted');
    });

    it('should not return own dead drop', async () => {
      const registry = new RendezvousRegistry();

      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'alice_encrypted',
        relayId: 'relay1',
      });

      // Alice re-registers
      const result = registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'alice_encrypted_new',
        relayId: 'relay1',
      });

      expect(result.deadDrops).toHaveLength(0);
    });
  });

  describe('registerHourlyTokens', () => {
    it('should find live matches for hourly tokens', async () => {
      const registry = new RendezvousRegistry();

      // Alice registers
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      // Bob registers same token
      const result = registry.registerHourlyTokens('bob', {
        tokens: ['hr_abc123'],
        relayId: 'relay2',
      });

      expect(result.liveMatches).toHaveLength(1);
      expect(result.liveMatches[0].peerId).toBe('alice');
      expect(result.liveMatches[0].relayId).toBe('relay1');
    });

    it('should notify original peer of new match', async () => {
      const registry = new RendezvousRegistry();
      const notifications = [];
      registry.onMatch = (peerId, match) => notifications.push({ peerId, match });

      registry.registerHourlyTokens('alice', { tokens: ['hr_abc123'], relayId: 'r1' });
      registry.registerHourlyTokens('bob', { tokens: ['hr_abc123'], relayId: 'r2' });

      expect(notifications).toContainEqual({
        peerId: 'alice',
        match: expect.objectContaining({ peerId: 'bob' }),
      });
    });
  });

  describe('expiration', () => {
    it('should expire daily points after 48 hours', async () => {
      const registry = new RendezvousRegistry();
      jest.useFakeTimers();

      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      });

      // Advance 49 hours
      jest.advanceTimersByTime(49 * 60 * 60 * 1000);
      registry.cleanup();

      const entries = registry.getDailyPoint('day_abc123');
      expect(entries).toHaveLength(0);
    });

    it('should expire hourly tokens after 3 hours', async () => {
      const registry = new RendezvousRegistry();
      jest.useFakeTimers();

      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      // Advance 4 hours
      jest.advanceTimersByTime(4 * 60 * 60 * 1000);
      registry.cleanup();

      const result = registry.registerHourlyTokens('bob', {
        tokens: ['hr_abc123'],
        relayId: 'relay2',
      });

      expect(result.liveMatches).toHaveLength(0);
    });
  });
});
```

### 3. WebSocket Handler Tests

```javascript
// tests/websocket-handler.test.js

describe('WebSocket Handler', () => {
  describe('register message', () => {
    it('should register peer and return available relays', async () => {
      const { ws, handler } = createTestHandler();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
        publicKey: 'pk1',
        maxConnections: 20,
      }));

      expect(ws.sent).toContainEqual(expect.objectContaining({
        type: 'registered',
        relays: expect.any(Array),
      }));
    });
  });

  describe('register_rendezvous message', () => {
    it('should register meeting points and return matches', async () => {
      const { ws, handler } = createTestHandler();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register_rendezvous',
        peerId: 'peer1',
        dailyPoints: ['day_abc'],
        hourlyTokens: ['hr_xyz'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      }));

      expect(ws.sent).toContainEqual(expect.objectContaining({
        type: 'rendezvous_result',
        liveMatches: expect.any(Array),
        deadDrops: expect.any(Array),
      }));
    });
  });

  describe('update_load message', () => {
    it('should update peer connection count', async () => {
      const { ws, handler, registry } = createTestHandler();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
        maxConnections: 20,
      }));

      handler.handleMessage(ws, JSON.stringify({
        type: 'update_load',
        peerId: 'peer1',
        connectedCount: 10,
      }));

      expect(registry.getPeer('peer1').connectedCount).toBe(10);
    });
  });

  describe('disconnect', () => {
    it('should unregister peer on disconnect', async () => {
      const { ws, handler, registry } = createTestHandler();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      handler.handleDisconnect(ws);

      expect(registry.getPeer('peer1')).toBeUndefined();
    });
  });
});
```

## Implementation Files

### 1. RelayRegistry Class

```javascript
// src/relay-registry.js

export class RelayRegistry {
  constructor() {
    this.peers = new Map();
  }

  register(peerId, { maxConnections = 20, publicKey = null }) {
    this.peers.set(peerId, {
      peerId,
      maxConnections,
      connectedCount: 0,
      publicKey,
      registeredAt: Date.now(),
    });
  }

  getPeer(peerId) {
    return this.peers.get(peerId);
  }

  updateLoad(peerId, connectedCount) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.connectedCount = connectedCount;
      peer.lastUpdate = Date.now();
    }
  }

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

    // Shuffle for load distribution
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }

    return available.slice(0, count);
  }

  unregister(peerId) {
    this.peers.delete(peerId);
  }
}
```

### 2. RendezvousRegistry Class

```javascript
// src/rendezvous-registry.js

export class RendezvousRegistry {
  constructor() {
    this.dailyPoints = new Map();
    this.hourlyTokens = new Map();
    this.DAILY_TTL = 48 * 60 * 60 * 1000;  // 48 hours
    this.HOURLY_TTL = 3 * 60 * 60 * 1000;  // 3 hours
    this.onMatch = null;
  }

  registerDailyPoints(peerId, { points, deadDrop, relayId }) {
    const now = Date.now();
    const result = { deadDrops: [] };

    for (const point of points) {
      if (!this.dailyPoints.has(point)) {
        this.dailyPoints.set(point, []);
      }

      const entries = this.dailyPoints.get(point);

      // Find existing dead drops (not our own)
      for (const entry of entries) {
        if (entry.peerId !== peerId && entry.deadDrop && entry.expires > now) {
          result.deadDrops.push({
            peerId: entry.peerId,
            deadDrop: entry.deadDrop,
            relayId: entry.relayId,
          });
        }
      }

      // Remove old entry from same peer
      const filtered = entries.filter(e => e.peerId !== peerId);

      // Add new entry
      filtered.push({
        peerId,
        deadDrop,
        relayId,
        expires: now + this.DAILY_TTL,
      });

      this.dailyPoints.set(point, filtered);
    }

    return result;
  }

  registerHourlyTokens(peerId, { tokens, relayId }) {
    const now = Date.now();
    const result = { liveMatches: [] };

    for (const token of tokens) {
      if (!this.hourlyTokens.has(token)) {
        this.hourlyTokens.set(token, []);
      }

      const entries = this.hourlyTokens.get(token);

      // Find live matches (not our own)
      for (const entry of entries) {
        if (entry.peerId !== peerId && entry.expires > now) {
          result.liveMatches.push({
            peerId: entry.peerId,
            relayId: entry.relayId,
          });

          // Notify the other peer
          if (this.onMatch) {
            this.onMatch(entry.peerId, { peerId, relayId });
          }
        }
      }

      // Remove old entry from same peer
      const filtered = entries.filter(e => e.peerId !== peerId);

      // Add new entry
      filtered.push({
        peerId,
        relayId,
        expires: now + this.HOURLY_TTL,
      });

      this.hourlyTokens.set(token, filtered);
    }

    return result;
  }

  getDailyPoint(point) {
    const entries = this.dailyPoints.get(point) || [];
    const now = Date.now();
    return entries.filter(e => e.expires > now);
  }

  cleanup() {
    const now = Date.now();

    for (const [point, entries] of this.dailyPoints) {
      const valid = entries.filter(e => e.expires > now);
      if (valid.length === 0) {
        this.dailyPoints.delete(point);
      } else {
        this.dailyPoints.set(point, valid);
      }
    }

    for (const [token, entries] of this.hourlyTokens) {
      const valid = entries.filter(e => e.expires > now);
      if (valid.length === 0) {
        this.hourlyTokens.delete(token);
      } else {
        this.hourlyTokens.set(token, valid);
      }
    }
  }
}
```

### 3. Main Worker

```javascript
// src/index.js

import { RelayRegistry } from './relay-registry.js';
import { RendezvousRegistry } from './rendezvous-registry.js';

const relayRegistry = new RelayRegistry();
const rendezvousRegistry = new RendezvousRegistry();
const wsConnections = new Map();  // peerId → ws

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    if (url.pathname === '/ws') {
      return handleWebSocket(request);
    }

    return new Response('Zajel Signaling Server', { status: 200 });
  },
};

function handleWebSocket(request) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  let peerId = null;

  // Set up match notifications
  rendezvousRegistry.onMatch = (targetPeerId, match) => {
    const targetWs = wsConnections.get(targetPeerId);
    if (targetWs) {
      targetWs.send(JSON.stringify({
        type: 'rendezvous_match',
        match,
      }));
    }
  };

  server.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'register':
        peerId = msg.peerId;
        wsConnections.set(peerId, server);
        relayRegistry.register(peerId, {
          maxConnections: msg.maxConnections || 20,
          publicKey: msg.publicKey,
        });

        server.send(JSON.stringify({
          type: 'registered',
          relays: relayRegistry.getAvailableRelays(peerId, 10),
        }));
        break;

      case 'update_load':
        relayRegistry.updateLoad(msg.peerId, msg.connectedCount);
        break;

      case 'register_rendezvous':
        const dailyResult = rendezvousRegistry.registerDailyPoints(msg.peerId, {
          points: msg.dailyPoints,
          deadDrop: msg.deadDrop,
          relayId: msg.relayId,
        });

        const hourlyResult = rendezvousRegistry.registerHourlyTokens(msg.peerId, {
          tokens: msg.hourlyTokens,
          relayId: msg.relayId,
        });

        server.send(JSON.stringify({
          type: 'rendezvous_result',
          liveMatches: hourlyResult.liveMatches,
          deadDrops: dailyResult.deadDrops,
        }));
        break;

      case 'get_relays':
        server.send(JSON.stringify({
          type: 'relays',
          relays: relayRegistry.getAvailableRelays(msg.peerId, 10),
        }));
        break;
    }
  });

  server.addEventListener('close', () => {
    if (peerId) {
      relayRegistry.unregister(peerId);
      wsConnections.delete(peerId);
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}
```

## File Structure

```
packages/server/
├── src/
│   ├── index.js              # Main worker entry
│   ├── relay-registry.js     # Relay peer tracking
│   └── rendezvous-registry.js # Meeting points + dead drops
├── tests/
│   ├── relay-registry.test.js
│   ├── rendezvous-registry.test.js
│   └── websocket-handler.test.js
├── wrangler.toml
└── package.json
```

## Commands

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Deploy
npx wrangler deploy
```
