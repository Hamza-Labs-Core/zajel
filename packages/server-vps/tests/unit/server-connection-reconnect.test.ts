/**
 * Unit tests for ServerConnectionManager reconnect logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { ServerConnectionManager } from '../../src/federation/transport/server-connection.js';
import type { ServerIdentity, MembershipEntry } from '../../src/types.js';

// Mock timers
vi.useFakeTimers();

describe('ServerConnectionManager - Reconnect Logic', () => {
  let manager: ServerConnectionManager;
  let identity: ServerIdentity;
  let peerEntry: MembershipEntry;

  beforeEach(() => {
    // Create mock identity (must include all required fields from ServerIdentity interface)
    identity = {
      serverId: 'server-001',
      nodeId: 'node-001',
      ephemeralId: 'srv-test-001',
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(64),
    };

    // Create mock peer entry
    peerEntry = {
      serverId: 'server-002',
      nodeId: 'node-002',
      endpoint: 'ws://127.0.0.1:8000',
      publicKey: new Uint8Array(32),
      status: 'alive',
      incarnation: 0,
      lastSeen: Date.now(),
      metadata: {},
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  describe('maxReconnectAttempts = 0 (infinite retries)', () => {
    it('should schedule reconnect on disconnect with maxReconnectAttempts = 0', async () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 30000,
        pingInterval: 30000,
        maxReconnectAttempts: 0, // Infinite
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      // Spy on scheduleReconnect (private method, so we use connect as proxy)
      const connectSpy = vi.spyOn(manager, 'connect').mockResolvedValue(undefined);

      // Simulate a disconnect by triggering handleDisconnect via private method access
      // Since handleDisconnect is private, we need to simulate it via connection lifecycle

      // Alternative: Test via public API by establishing and closing a connection
      // This requires mocking WebSocket, which is complex for unit tests
      // Instead, we'll verify the behavior indirectly via integration tests

      // For unit testing, we need to access private methods
      // This is acceptable in TypeScript with type assertions
      const handleDisconnect = (manager as any).handleDisconnect.bind(manager);
      const scheduleReconnectSpy = vi.spyOn(manager as any, 'scheduleReconnect');

      // Simulate connection state
      const mockWs = new EventEmitter() as any;
      mockWs.readyState = WebSocket.OPEN;
      mockWs.close = vi.fn();
      mockWs.send = vi.fn();
      mockWs.ping = vi.fn();

      const mockConnection = {
        ws: mockWs,
        entry: peerEntry,
        isOutgoing: true,
        reconnectAttempts: 0,
        reconnectTimer: null,
        pingTimer: null,
        handshakeTimeout: null,
      };

      (manager as any).connections.set(peerEntry.serverId, mockConnection);

      // Trigger disconnect
      handleDisconnect(peerEntry.serverId, 1000, 'Normal closure');

      // Verify scheduleReconnect was called
      expect(scheduleReconnectSpy).toHaveBeenCalledWith(peerEntry, 1);
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);
    });

    it('should continue reconnecting after multiple failures with maxReconnectAttempts = 0', async () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 30000,
        pingInterval: 30000,
        maxReconnectAttempts: 0, // Infinite
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      const handleDisconnect = (manager as any).handleDisconnect.bind(manager);
      const scheduleReconnectSpy = vi.spyOn(manager as any, 'scheduleReconnect');

      // Simulate multiple disconnects with increasing attempt counts
      for (let i = 0; i < 10; i++) {
        const mockWs = new EventEmitter() as any;
        mockWs.readyState = WebSocket.OPEN;
        mockWs.close = vi.fn();

        const mockConnection = {
          ws: mockWs,
          entry: peerEntry,
          isOutgoing: true,
          reconnectAttempts: i,
          reconnectTimer: null,
          pingTimer: null,
          handshakeTimeout: null,
        };

        (manager as any).connections.set(peerEntry.serverId, mockConnection);
        handleDisconnect(peerEntry.serverId, 1000, 'Connection lost');
      }

      // Should have scheduled reconnect 10 times (infinite retries)
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(10);
    });
  });

  describe('maxReconnectAttempts > 0 (bounded retries)', () => {
    it('should stop reconnecting after maxReconnectAttempts is reached', async () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 30000,
        pingInterval: 30000,
        maxReconnectAttempts: 3, // Max 3 attempts
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      const handleDisconnect = (manager as any).handleDisconnect.bind(manager);
      const scheduleReconnectSpy = vi.spyOn(manager as any, 'scheduleReconnect');

      // Simulate 5 disconnects with increasing attempt counts
      for (let i = 0; i < 5; i++) {
        const mockWs = new EventEmitter() as any;
        mockWs.readyState = WebSocket.OPEN;
        mockWs.close = vi.fn();

        const mockConnection = {
          ws: mockWs,
          entry: peerEntry,
          isOutgoing: true,
          reconnectAttempts: i,
          reconnectTimer: null,
          pingTimer: null,
          handshakeTimeout: null,
        };

        (manager as any).connections.set(peerEntry.serverId, mockConnection);
        handleDisconnect(peerEntry.serverId, 1000, 'Connection lost');
      }

      // Should have scheduled reconnect only 3 times (attempts 0, 1, 2)
      // Attempts 3 and 4 should not schedule reconnect
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('Incoming vs Outgoing connections', () => {
    it('should NOT reconnect for incoming connections', async () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 30000,
        pingInterval: 30000,
        maxReconnectAttempts: 0, // Infinite
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      const handleDisconnect = (manager as any).handleDisconnect.bind(manager);
      const scheduleReconnectSpy = vi.spyOn(manager as any, 'scheduleReconnect');

      // Simulate incoming connection (isOutgoing = false)
      const mockWs = new EventEmitter() as any;
      mockWs.readyState = WebSocket.OPEN;
      mockWs.close = vi.fn();

      const mockConnection = {
        ws: mockWs,
        entry: peerEntry,
        isOutgoing: false, // Incoming connection
        reconnectAttempts: 0,
        reconnectTimer: null,
        pingTimer: null,
        handshakeTimeout: null,
      };

      (manager as any).connections.set(peerEntry.serverId, mockConnection);
      handleDisconnect(peerEntry.serverId, 1000, 'Normal closure');

      // Should NOT schedule reconnect for incoming connections
      expect(scheduleReconnectSpy).not.toHaveBeenCalled();
    });
  });

  describe('Exponential backoff', () => {
    it('should calculate correct backoff delays with exponential increase', () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 30000,
        pingInterval: 30000,
        maxReconnectAttempts: 0,
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      const scheduleReconnect = (manager as any).scheduleReconnect.bind(manager);

      // Mock setTimeout to capture delay values
      const delays: number[] = [];
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number) => {
        delays.push(delay);
        return {} as any;
      }) as any);

      // Schedule reconnects with increasing attempt counts
      for (let i = 1; i <= 5; i++) {
        scheduleReconnect(peerEntry, i);
      }

      // Verify exponential backoff pattern (jitter applied after clamping)
      // Attempt 1: base = min(1000 * 2^0, 30000) = 1000, delay = 1000 + random(0-1000) = 1000-2000ms
      // Attempt 2: base = min(1000 * 2^1, 30000) = 2000, delay = 2000 + random(0-1000) = 2000-3000ms
      // Attempt 3: base = min(1000 * 2^2, 30000) = 4000, delay = 4000 + random(0-1000) = 4000-5000ms
      // Attempt 4: base = min(1000 * 2^3, 30000) = 8000, delay = 8000 + random(0-1000) = 8000-9000ms
      // Attempt 5: base = min(1000 * 2^4, 30000) = 16000, delay = 16000 + random(0-1000) = 16000-17000ms

      expect(delays[0]).toBeGreaterThanOrEqual(1000);
      expect(delays[0]).toBeLessThan(2000);

      expect(delays[1]).toBeGreaterThanOrEqual(2000);
      expect(delays[1]).toBeLessThan(3000);

      expect(delays[2]).toBeGreaterThanOrEqual(4000);
      expect(delays[2]).toBeLessThan(5000);

      expect(delays[3]).toBeGreaterThanOrEqual(8000);
      expect(delays[3]).toBeLessThan(9000);

      expect(delays[4]).toBeGreaterThanOrEqual(16000);
      expect(delays[4]).toBeLessThan(17000);
    });

    it('should cap backoff at reconnectMaxInterval and still add jitter', () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 5000, // Cap at 5 seconds
        pingInterval: 30000,
        maxReconnectAttempts: 0,
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      const scheduleReconnect = (manager as any).scheduleReconnect.bind(manager);

      const delays: number[] = [];
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number) => {
        delays.push(delay);
        return {} as any;
      }) as any);

      // Schedule reconnect with high attempt count (would exceed max without cap)
      scheduleReconnect(peerEntry, 10); // 1000 * 2^9 = 512000ms without cap

      // With jitter-after-clamp: base = min(512000, 5000) = 5000, delay = 5000 + random(0-1000)
      // So delay should be in range [5000, 6000)
      expect(delays[0]).toBeGreaterThanOrEqual(5000);
      expect(delays[0]).toBeLessThan(6000);
    });
  });

  describe('Failure-retry chain', () => {
    it('should chain retries when connect() fails with maxReconnectAttempts = 0', async () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 30000,
        pingInterval: 30000,
        maxReconnectAttempts: 0, // Infinite
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      // Mock connect to always fail
      const connectSpy = vi.spyOn(manager, 'connect').mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:8000')
      );

      const scheduleReconnectSpy = vi.spyOn(manager as any, 'scheduleReconnect');

      // Capture setTimeout callbacks so we can execute them manually
      const callbacks: Array<() => Promise<void>> = [];
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number) => {
        callbacks.push(callback);
        return {} as any;
      }) as any);

      // Trigger the initial scheduleReconnect
      (manager as any).scheduleReconnect(peerEntry, 1);
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);

      // Execute the first setTimeout callback (attempt 1 fails)
      await callbacks[0]();

      // After failure, scheduleReconnect should be called again with attempt 2
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(2);
      expect(scheduleReconnectSpy).toHaveBeenLastCalledWith(peerEntry, 2);

      // Execute the second setTimeout callback (attempt 2 fails)
      await callbacks[1]();

      // After failure, scheduleReconnect should be called again with attempt 3
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(3);
      expect(scheduleReconnectSpy).toHaveBeenLastCalledWith(peerEntry, 3);

      // Verify connect was called for each attempt
      expect(connectSpy).toHaveBeenCalledTimes(2);
    });

    it('should stop chaining retries when maxReconnectAttempts is reached', async () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 30000,
        pingInterval: 30000,
        maxReconnectAttempts: 2, // Only 2 attempts
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      // Mock connect to always fail
      vi.spyOn(manager, 'connect').mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:8000')
      );

      const scheduleReconnectSpy = vi.spyOn(manager as any, 'scheduleReconnect');

      // Capture setTimeout callbacks
      const callbacks: Array<() => Promise<void>> = [];
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number) => {
        callbacks.push(callback);
        return {} as any;
      }) as any);

      // Trigger the initial scheduleReconnect (attempt 1)
      (manager as any).scheduleReconnect(peerEntry, 1);
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);

      // Execute attempt 1 (fails, attempt < maxReconnectAttempts, so chains)
      await callbacks[0]();
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(2);

      // Execute attempt 2 (fails, attempt === maxReconnectAttempts, should NOT chain)
      await callbacks[1]();
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(2); // No additional call
    });

    it('should not chain retry when connect() succeeds', async () => {
      const config = {
        handshakeTimeout: 10000,
        reconnectInterval: 1000,
        reconnectMaxInterval: 30000,
        pingInterval: 30000,
        maxReconnectAttempts: 0, // Infinite
      };

      manager = new ServerConnectionManager(
        identity,
        'ws://127.0.0.1:9000',
        config
      );

      // Mock connect to succeed
      vi.spyOn(manager, 'connect').mockResolvedValue(undefined);

      const scheduleReconnectSpy = vi.spyOn(manager as any, 'scheduleReconnect');

      // Capture setTimeout callbacks
      const callbacks: Array<() => Promise<void>> = [];
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number) => {
        callbacks.push(callback);
        return {} as any;
      }) as any);

      // Trigger the initial scheduleReconnect
      (manager as any).scheduleReconnect(peerEntry, 1);
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);

      // Execute the callback (connect succeeds, no chaining)
      await callbacks[0]();

      // scheduleReconnect should NOT be called again
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);
    });
  });
});
