/**
 * Security tests for NaN input handling.
 *
 * Verifies that NaN, Infinity, -Infinity, and other non-finite numeric
 * inputs are rejected or sanitized to prevent state corruption.
 *
 * The server already uses Number.isFinite() guards for numeric fields
 * in server-registry-do.js (connections, relayConnections, etc.).
 * These tests verify those guards work as expected.
 *
 * Covers:
 * - connections: NaN in server registration and heartbeat
 * - relayConnections: NaN / Infinity
 * - signalingConnections: -Infinity
 * - activeCodes: NaN
 * - timestamp: NaN in build token
 * - string-type connection values
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { AttestationRegistryDO } from '../../src/durable-objects/attestation-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';
import {
  importAttestationSigningKey,
  signPayloadEd25519,
} from '../../src/crypto/attestation.js';

async function generateTestSeed() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  return Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('NaN Input Validation', () => {
  describe('ServerRegistryDO - Registration', () => {
    let mockState;
    let registry;

    beforeEach(() => {
      mockState = new MockState();
      registry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'ci-secret',
        REPLAY_GRACE_MODE: 'true', // Allow registration without timestamp/nonce
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should sanitize NaN connections to 0 on registration', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:nan-test',
        endpoint: 'wss://nan.example.com',
        publicKey: 'key1',
        connections: NaN,
        relayConnections: NaN,
        signalingConnections: NaN,
        activeCodes: NaN,
      }, authHeaders));

      const entry = await mockState.storage.get('server:ed25519:nan-test');
      expect(entry).toBeDefined();
      expect(entry.connections).toBe(0);
      expect(entry.relayConnections).toBe(0);
      expect(entry.signalingConnections).toBe(0);
      expect(entry.activeCodes).toBe(0);
    });

    it('should sanitize Infinity connections to 0 on registration', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:inf-test',
        endpoint: 'wss://inf.example.com',
        publicKey: 'key1',
        connections: Infinity,
        relayConnections: -Infinity,
      }, authHeaders));

      const entry = await mockState.storage.get('server:ed25519:inf-test');
      expect(entry).toBeDefined();
      expect(entry.connections).toBe(0);
      expect(entry.relayConnections).toBe(0);
    });

    it('should sanitize negative connections to 0', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:neg-test',
        endpoint: 'wss://neg.example.com',
        publicKey: 'key1',
        connections: -5,
      }, authHeaders));

      const entry = await mockState.storage.get('server:ed25519:neg-test');
      expect(entry).toBeDefined();
      expect(entry.connections).toBe(0);
    });
  });

  describe('ServerRegistryDO - Heartbeat', () => {
    let mockState;
    let registry;

    beforeEach(async () => {
      mockState = new MockState();
      registry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'ci-secret',
        REPLAY_GRACE_MODE: 'true',
      });
      vi.useFakeTimers();

      // Register a server first
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:heartbeat-nan',
        endpoint: 'wss://hb.example.com',
        publicKey: 'key1',
        connections: 10,
      }, { Authorization: 'Bearer test-secret' }));
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should not update connections field when NaN is provided in heartbeat', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-nan',
        connections: NaN,
      }, authHeaders));

      const entry = await mockState.storage.get('server:ed25519:heartbeat-nan');
      // Should keep original value since NaN fails Number.isFinite check
      expect(entry.connections).toBe(10);
    });

    it('should not update connections field when Infinity is provided in heartbeat', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-nan',
        connections: Infinity,
      }, authHeaders));

      const entry = await mockState.storage.get('server:ed25519:heartbeat-nan');
      expect(entry.connections).toBe(10);
    });

    it('should handle string-type connection values in heartbeat', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-nan',
        connections: 'not-a-number',
      }, authHeaders));

      const entry = await mockState.storage.get('server:ed25519:heartbeat-nan');
      // String fails typeof check, should keep original
      expect(entry.connections).toBe(10);
    });

    it('should not update relay/signaling/activeCodes with non-finite values', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      // Set valid values first
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-nan',
        connections: 20,
        relayConnections: 10,
        signalingConnections: 10,
        activeCodes: 5,
      }, authHeaders));

      // Advance 31s to satisfy min heartbeat interval
      vi.advanceTimersByTime(31000);

      // Now try non-finite values
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-nan',
        relayConnections: NaN,
        signalingConnections: Infinity,
        activeCodes: -Infinity,
      }, authHeaders));

      const entry = await mockState.storage.get('server:ed25519:heartbeat-nan');
      // Should keep previous valid values
      expect(entry.relayConnections).toBe(10);
      expect(entry.signalingConnections).toBe(10);
      expect(entry.activeCodes).toBe(5);
    });
  });

  describe('AttestationRegistryDO - Build Token Timestamp', () => {
    let mockState;
    let attestationDO;
    let seedHex;

    beforeEach(async () => {
      mockState = new MockState();
      seedHex = await generateTestSeed();
      attestationDO = new AttestationRegistryDO(mockState, {
        ATTESTATION_SIGNING_KEY: seedHex,
        CI_UPLOAD_SECRET: 'test-secret',
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should reject build token with NaN timestamp', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      // NaN serializes as null in JSON, so the timestamp field will be null
      const tokenPayload = JSON.stringify({
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: null, // NaN becomes null in JSON.stringify
      });
      const signature = await signPayloadEd25519(signingKey, tokenPayload);

      const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: { payload: tokenPayload, signature },
        device_id: 'device-nan-ts',
      }));

      // Null timestamp should fail the !timestamp check
      expect(resp.status).toBe(400);
    });

    it('should reject build token with future timestamp beyond clock skew tolerance', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const tokenPayload = JSON.stringify({
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now() + 5 * 60 * 1000, // 5 minutes in the future
      });
      const signature = await signPayloadEd25519(signingKey, tokenPayload);

      const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: { payload: tokenPayload, signature },
        device_id: 'device-future-ts',
      }));

      expect(resp.status).toBe(403);
      const data = await resp.json();
      expect(data.error).toContain('future timestamp');
    });
  });
});
