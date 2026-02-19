/**
 * Attestation Tests
 *
 * Tests for the VPS attestation integration:
 * - AttestationManager: session management, bootstrap forwarding, server identity
 * - ClientHandler: attestation message handling, grace period, chunk operation gating
 *
 * Tests cover:
 * - Happy path: full attestation flow
 * - Invalid token rejection
 * - Session token caching and expiry
 * - Grace period enforcement
 * - Server identity proof generation
 * - Attestation disabled mode (no bootstrap URL)
 * - Chunk operations gated by attestation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ClientHandler, type ClientHandlerConfig } from '../../src/client/handler.js';
import { AttestationManager, type AttestationConfig } from '../../src/attestation/attestation-manager.js';
import { RelayRegistry } from '../../src/registry/relay-registry.js';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { ATTESTATION } from '../../src/constants.js';
import type { ServerIdentity } from '../../src/types.js';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as crypto from 'crypto';

// Valid 32-byte base64-encoded public keys for testing
const VALID_PUBKEY_1 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';
const VALID_PUBKEY_2 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI=';

// Valid pairing codes
const PEER_CODE_1 = 'ATT234';
const PEER_CODE_2 = 'ATT567';

// Mock WebSocket implementation (same pattern as other test files)
class MockWebSocket extends EventEmitter {
  readyState: number = 1; // OPEN
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  sentMessages: any[] = [];

  send(data: string): void {
    if (this.readyState === MockWebSocket.OPEN) {
      this.sentMessages.push(JSON.parse(data));
    }
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  get OPEN(): number {
    return MockWebSocket.OPEN;
  }

  getLastMessage(): any {
    return this.sentMessages[this.sentMessages.length - 1];
  }

  getMessagesByType(type: string): any[] {
    return this.sentMessages.filter((m: any) => m.type === type);
  }

  clearMessages(): void {
    this.sentMessages = [];
  }
}

// Mock DistributedRendezvous
class MockDistributedRendezvous extends EventEmitter {
  async registerDailyPoints() {
    return { local: { deadDrops: [] }, redirects: [] };
  }
  async registerHourlyTokens() {
    return { local: { liveMatches: [] }, redirects: [] };
  }
  async unregisterPeer() {}
}

// Default test identity
function createTestIdentity(): ServerIdentity {
  return {
    serverId: 'test-server-id',
    nodeId: 'test-node-id',
    ephemeralId: 'srv-test',
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32),
  };
}

// Default client handler config
function createTestConfig(): ClientHandlerConfig {
  return {
    heartbeatInterval: 30000,
    heartbeatTimeout: 90000,
    maxConnectionsPerPeer: 10,
    pairRequestTimeout: 5000,
    pairRequestWarningTime: 2000,
  };
}

// Helper: register a peer with a pairing code
async function registerPeer(handler: ClientHandler, ws: MockWebSocket, code: string, pubkey: string) {
  await handler.handleMessage(ws as any, JSON.stringify({
    type: 'register',
    pairingCode: code,
    publicKey: pubkey,
  }));
}

// Helper: create test storage
function createTestStorage(): { storage: SQLiteStorage; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'zajel-attest-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const storage = new SQLiteStorage(dbPath);
  return { storage, tmpDir };
}

// =============================================================================
// AttestationManager Unit Tests
// =============================================================================

describe('AttestationManager', () => {
  describe('Initialization', () => {
    it('should be disabled when bootstrapUrl is null', () => {
      const manager = new AttestationManager({
        bootstrapUrl: null,
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      expect(manager.enabled).toBe(false);
    });

    it('should be enabled when bootstrapUrl is set', () => {
      const manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      expect(manager.enabled).toBe(true);
    });

    it('should generate ephemeral keypair when vpsIdentityKey is null', () => {
      const manager = new AttestationManager({
        bootstrapUrl: null,
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      // Should have a valid public key
      const pubKey = manager.getPublicKeyBase64();
      expect(pubKey).toBeTruthy();
      expect(Buffer.from(pubKey, 'base64').length).toBe(32);
    });

    it('should generate ephemeral keypair when vpsIdentityKey is invalid', () => {
      const manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: 'not-valid-base64-key!!!',
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      // Should still have a valid public key (from ephemeral)
      const pubKey = manager.getPublicKeyBase64();
      expect(pubKey).toBeTruthy();
      expect(Buffer.from(pubKey, 'base64').length).toBe(32);
    });

    it('should load keypair from valid vpsIdentityKey', () => {
      // Generate a real Ed25519 key to use
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
      // Extract the 32-byte seed from PKCS8 DER (last 32 bytes of the structure)
      const seed = Buffer.from(pkcs8).subarray(16, 48);
      const keyBase64 = seed.toString('base64');

      const manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: keyBase64,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      const pubKey = manager.getPublicKeyBase64();
      expect(pubKey).toBeTruthy();
      expect(Buffer.from(pubKey, 'base64').length).toBe(32);
    });
  });

  describe('Session Management', () => {
    let manager: AttestationManager;

    beforeEach(() => {
      manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });
    });

    afterEach(() => {
      manager.shutdown();
    });

    it('should create a session and return a unique ID', () => {
      const id1 = manager.createSession();
      const id2 = manager.createSession();

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it('should track session count', () => {
      expect(manager.sessionCount).toBe(0);

      const id1 = manager.createSession();
      expect(manager.sessionCount).toBe(1);

      manager.createSession();
      expect(manager.sessionCount).toBe(2);

      manager.removeSession(id1);
      expect(manager.sessionCount).toBe(1);
    });

    it('should remove a session', () => {
      const id = manager.createSession();
      expect(manager.getSession(id)).toBeDefined();

      manager.removeSession(id);
      expect(manager.getSession(id)).toBeUndefined();
    });

    it('should clear all sessions on shutdown', () => {
      manager.createSession();
      manager.createSession();
      expect(manager.sessionCount).toBe(2);

      manager.shutdown();
      expect(manager.sessionCount).toBe(0);
    });
  });

  describe('Attestation Status', () => {
    let manager: AttestationManager;

    beforeEach(() => {
      manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });
    });

    afterEach(() => {
      manager.shutdown();
    });

    it('should not be attested on creation (when attestation is enabled)', () => {
      const id = manager.createSession();
      expect(manager.isAttested(id)).toBe(false);
    });

    it('should report within grace period on new session', () => {
      const id = manager.createSession();
      expect(manager.isInGracePeriod(id)).toBe(true);
    });

    it('should report allowed during grace period', () => {
      const id = manager.createSession();
      expect(manager.isAllowed(id)).toBe(true);
    });

    it('should return false for unknown connection', () => {
      expect(manager.isAttested('nonexistent')).toBe(false);
      expect(manager.isInGracePeriod('nonexistent')).toBe(false);
      expect(manager.isAllowed('nonexistent')).toBe(false);
    });
  });

  describe('Attestation Disabled', () => {
    let manager: AttestationManager;

    beforeEach(() => {
      manager = new AttestationManager({
        bootstrapUrl: null,
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });
    });

    afterEach(() => {
      manager.shutdown();
    });

    it('should auto-attest sessions when disabled', () => {
      const id = manager.createSession();
      expect(manager.isAttested(id)).toBe(true);
      expect(manager.isAllowed(id)).toBe(true);
    });

    it('should always return true for isAllowed when disabled', () => {
      expect(manager.isAllowed('any-id')).toBe(true);
    });

    it('should always return true for isInGracePeriod when disabled', () => {
      expect(manager.isInGracePeriod('any-id')).toBe(true);
    });
  });

  describe('Grace Period Expiry', () => {
    it('should detect expired grace period connections', () => {
      const manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 100, // 100ms for testing
      });

      const id = manager.createSession();
      expect(manager.getExpiredGracePeriodConnections()).toHaveLength(0);

      // Manually set connectedAt to past
      const session = manager.getSession(id);
      if (session) {
        session.connectedAt = Date.now() - 200;
      }

      const expired = manager.getExpiredGracePeriodConnections();
      expect(expired).toHaveLength(1);
      expect(expired[0]).toBe(id);

      manager.shutdown();
    });

    it('should not report attested sessions as expired', () => {
      const manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 100,
      });

      const id = manager.createSession();
      const session = manager.getSession(id);
      if (session) {
        session.connectedAt = Date.now() - 200;
        session.attested = true;
        session.sessionToken = 'test-token';
        session.tokenExpiresAt = Date.now() + 3600000;
      }

      expect(manager.getExpiredGracePeriodConnections()).toHaveLength(0);

      manager.shutdown();
    });

    it('should not report pending attestation sessions as expired', () => {
      const manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 100,
      });

      const id = manager.createSession();
      const session = manager.getSession(id);
      if (session) {
        session.connectedAt = Date.now() - 200;
        session.attestationPending = true;
      }

      expect(manager.getExpiredGracePeriodConnections()).toHaveLength(0);

      manager.shutdown();
    });
  });

  describe('Session Token Expiry', () => {
    it('should report not attested when token expires', () => {
      const manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 100, // 100ms for testing
        gracePeriod: 30000,
      });

      const id = manager.createSession();
      const session = manager.getSession(id);
      if (session) {
        session.attested = true;
        session.sessionToken = 'test-token';
        session.tokenExpiresAt = Date.now() - 1; // Already expired
      }

      expect(manager.isAttested(id)).toBe(false);

      manager.shutdown();
    });

    it('should report attested when token is valid', () => {
      const manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      const id = manager.createSession();
      const session = manager.getSession(id);
      if (session) {
        session.attested = true;
        session.sessionToken = 'test-token';
        session.tokenExpiresAt = Date.now() + 3600000;
      }

      expect(manager.isAttested(id)).toBe(true);

      manager.shutdown();
    });
  });

  describe('Server Identity', () => {
    it('should generate valid server identity proof', () => {
      const manager = new AttestationManager({
        bootstrapUrl: null,
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      const proof = manager.generateServerIdentityProof();

      expect(proof.type).toBe('server_identity');
      expect(proof.public_key).toBeTruthy();
      expect(proof.nonce).toBeTruthy();
      expect(proof.signature).toBeTruthy();

      // Verify the nonce is a 32-byte base64 value
      const nonceBytes = Buffer.from(proof.nonce, 'base64');
      expect(nonceBytes.length).toBe(32);

      // Verify the public key is 32 bytes
      const pubKeyBytes = Buffer.from(proof.public_key, 'base64');
      expect(pubKeyBytes.length).toBe(32);

      manager.shutdown();
    });

    it('should produce valid signatures that can be verified', () => {
      const manager = new AttestationManager({
        bootstrapUrl: null,
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      const proof = manager.generateServerIdentityProof();

      // Reconstruct the public key for verification
      const rawPubKey = Buffer.from(proof.public_key, 'base64');
      // Build SPKI DER format for Ed25519 public key
      const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
      const spkiDer = Buffer.concat([spkiPrefix, rawPubKey]);
      const pubKeyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

      const nonceBuffer = Buffer.from(proof.nonce, 'base64');
      const signatureBuffer = Buffer.from(proof.signature, 'base64');

      const valid = crypto.verify(null, nonceBuffer, pubKeyObj, signatureBuffer);
      expect(valid).toBe(true);

      manager.shutdown();
    });

    it('should generate different nonces each time', () => {
      const manager = new AttestationManager({
        bootstrapUrl: null,
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      const proof1 = manager.generateServerIdentityProof();
      const proof2 = manager.generateServerIdentityProof();

      expect(proof1.nonce).not.toBe(proof2.nonce);
      // But same public key
      expect(proof1.public_key).toBe(proof2.public_key);

      manager.shutdown();
    });
  });

  describe('Bootstrap Forwarding', () => {
    let manager: AttestationManager;

    beforeEach(() => {
      manager = new AttestationManager({
        bootstrapUrl: 'https://bootstrap.example.com',
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });
    });

    afterEach(() => {
      manager.shutdown();
      vi.restoreAllMocks();
    });

    it('should forward challenge request to bootstrap', async () => {
      const mockChallenge = {
        nonce: 'test-nonce-123',
        regions: [
          { offset: 0x4A200, length: 4096 },
          { offset: 0xBF800, length: 2048 },
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockChallenge,
      } as Response);

      const connId = manager.createSession();
      const result = await manager.requestChallenge(connId, 'build-token-abc', 'device-123');

      expect(result).toEqual(mockChallenge);
      expect(fetchSpy).toHaveBeenCalledOnce();

      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://bootstrap.example.com/attest/challenge');
      expect((opts as RequestInit).method).toBe('POST');

      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.build_token).toBe('build-token-abc');
      expect(body.device_id).toBe('device-123');
    });

    it('should return null when bootstrap returns an error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      } as Response);

      const connId = manager.createSession();
      const result = await manager.requestChallenge(connId, 'bad-token', 'device-123');

      expect(result).toBeNull();
    });

    it('should return null when fetch throws', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const connId = manager.createSession();
      const result = await manager.requestChallenge(connId, 'token', 'device');

      expect(result).toBeNull();
    });

    it('should return null for unknown connection', async () => {
      const result = await manager.requestChallenge('nonexistent', 'token', 'device');
      expect(result).toBeNull();
    });

    it('should forward verify request to bootstrap', async () => {
      const mockVerifyResponse = {
        valid: true,
        session_token: 'session-token-xyz',
      };

      // First mock: challenge request
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ nonce: 'test-nonce', regions: [] }),
        } as Response)
        // Second mock: verify request
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockVerifyResponse,
        } as Response);

      const connId = manager.createSession();
      await manager.requestChallenge(connId, 'token', 'device-123');

      const result = await manager.verifyAttestation(connId, 'test-nonce', [
        { region_index: 0, hmac: 'hmac-1' },
        { region_index: 1, hmac: 'hmac-2' },
      ]);

      expect(result.valid).toBe(true);
      expect(result.session_token).toBe('session-token-xyz');

      // Session should now be attested
      expect(manager.isAttested(connId)).toBe(true);
      expect(manager.attestedCount).toBe(1);
    });

    it('should not attest when verify returns invalid', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ valid: false }),
      } as Response);

      const connId = manager.createSession();
      // Manually set device ID since we're skipping requestChallenge
      const session = manager.getSession(connId);
      if (session) session.deviceId = 'device-123';

      const result = await manager.verifyAttestation(connId, 'nonce', [
        { region_index: 0, hmac: 'bad-hmac' },
      ]);

      expect(result.valid).toBe(false);
      expect(manager.isAttested(connId)).toBe(false);
    });

    it('should return invalid when verify fetch fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const connId = manager.createSession();
      const session = manager.getSession(connId);
      if (session) session.deviceId = 'device-123';

      const result = await manager.verifyAttestation(connId, 'nonce', [
        { region_index: 0, hmac: 'hmac' },
      ]);

      expect(result.valid).toBe(false);
    });

    it('should return null for challenge when disabled', async () => {
      const disabledManager = new AttestationManager({
        bootstrapUrl: null,
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      const connId = disabledManager.createSession();
      const result = await disabledManager.requestChallenge(connId, 'token', 'device');
      expect(result).toBeNull();

      disabledManager.shutdown();
    });

    it('should return invalid for verify when disabled', async () => {
      const disabledManager = new AttestationManager({
        bootstrapUrl: null,
        vpsIdentityKey: null,
        sessionTokenTtl: 3600000,
        gracePeriod: 30000,
      });

      const connId = disabledManager.createSession();
      const result = await disabledManager.verifyAttestation(connId, 'nonce', []);
      expect(result.valid).toBe(false);

      disabledManager.shutdown();
    });
  });
});

// =============================================================================
// ClientHandler Attestation Integration Tests
// =============================================================================

describe('ClientHandler Attestation Integration', () => {
  const attestationConfig: AttestationConfig = {
    bootstrapUrl: 'https://bootstrap.example.com',
    vpsIdentityKey: null,
    sessionTokenTtl: 3600000,
    gracePeriod: 30000,
  };

  // Use null sentinel to mean "no attestation config" to distinguish from default
  const NO_ATTESTATION = null;

  function createHandler(
    attConfig: AttestationConfig | null = attestationConfig,
    storage?: SQLiteStorage
  ): ClientHandler {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const relayRegistry = new RelayRegistry();
    const distributedRendezvous = new MockDistributedRendezvous();

    return new ClientHandler(
      identity,
      'ws://localhost:8080',
      config,
      relayRegistry,
      distributedRendezvous as any,
      {},
      storage,
      attConfig ?? undefined
    );
  }

  describe('Connection Handling', () => {
    let handler: ClientHandler;

    beforeEach(() => {
      handler = createHandler();
    });

    afterEach(async () => {
      await handler.shutdown();
    });

    it('should send server_identity on connection when attestation is configured', () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);

      const identityMsgs = ws.getMessagesByType('server_identity');
      expect(identityMsgs.length).toBe(1);

      const proof = identityMsgs[0];
      expect(proof.public_key).toBeTruthy();
      expect(proof.nonce).toBeTruthy();
      expect(proof.signature).toBeTruthy();
    });

    it('should also send server_info on connection', () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);

      const infoMsgs = ws.getMessagesByType('server_info');
      expect(infoMsgs.length).toBe(1);
      expect(infoMsgs[0].serverId).toBe('test-server-id');
    });

    it('should NOT send server_identity when attestation is not configured', () => {
      const noAttHandler = createHandler(NO_ATTESTATION);
      const ws = new MockWebSocket();
      noAttHandler.handleConnection(ws as any);

      const identityMsgs = ws.getMessagesByType('server_identity');
      expect(identityMsgs.length).toBe(0);

      noAttHandler.shutdown();
    });

    it('should clean up attestation session on disconnect', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);

      const manager = handler.getAttestationManager();
      expect(manager).not.toBeNull();
      expect(manager!.sessionCount).toBe(1);

      await handler.handleDisconnect(ws as any);
      expect(manager!.sessionCount).toBe(0);
    });
  });

  describe('Attestation Flow - Happy Path', () => {
    let handler: ClientHandler;

    beforeEach(() => {
      handler = createHandler();
    });

    afterEach(async () => {
      await handler.shutdown();
      vi.restoreAllMocks();
    });

    it('should handle full attestation flow: request -> challenge -> response -> success', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      // Mock bootstrap challenge response
      const mockChallenge = {
        nonce: 'challenge-nonce-abc',
        regions: [
          { offset: 0x1000, length: 1024 },
          { offset: 0x2000, length: 2048 },
        ],
      };

      const mockVerify = {
        valid: true,
        session_token: 'session-token-12345',
      };

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockChallenge,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockVerify,
        } as Response);

      // Step 1: Client sends attest_request
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_request',
        build_token: 'my-build-token',
        device_id: 'my-device-id',
      }));

      // Should receive attest_challenge
      const challenges = ws.getMessagesByType('attest_challenge');
      expect(challenges.length).toBe(1);
      expect(challenges[0].nonce).toBe('challenge-nonce-abc');
      expect(challenges[0].regions).toEqual(mockChallenge.regions);

      // Step 2: Client sends attest_response
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_response',
        nonce: 'challenge-nonce-abc',
        responses: [
          { region_index: 0, hmac: 'hmac-for-region-0' },
          { region_index: 1, hmac: 'hmac-for-region-1' },
        ],
      }));

      // Should receive attest_success
      const successes = ws.getMessagesByType('attest_success');
      expect(successes.length).toBe(1);
      expect(successes[0].session_token).toBe('session-token-12345');

      // Client should now be attested
      const manager = handler.getAttestationManager()!;
      // We need the connection ID - can infer from session count
      expect(manager.attestedCount).toBe(1);
    });
  });

  describe('Attestation Flow - Failure', () => {
    let handler: ClientHandler;

    beforeEach(() => {
      handler = createHandler();
    });

    afterEach(async () => {
      await handler.shutdown();
      vi.restoreAllMocks();
    });

    it('should handle attestation failure: disconnect client', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      // Mock failed verification
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ nonce: 'nonce', regions: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ valid: false }),
        } as Response);

      // Request challenge
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_request',
        build_token: 'fake-token',
        device_id: 'fake-device',
      }));

      // Send bad response
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_response',
        nonce: 'nonce',
        responses: [{ region_index: 0, hmac: 'wrong-hmac' }],
      }));

      // Should receive attest_failed
      const failures = ws.getMessagesByType('attest_failed');
      expect(failures.length).toBe(1);
      expect(failures[0].message).toContain('failed');

      // WebSocket should be closed
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('should handle challenge request failure from bootstrap', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as Response);

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_request',
        build_token: 'token',
        device_id: 'device',
      }));

      const errors = ws.getMessagesByType('attest_error');
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('bootstrap');
    });
  });

  describe('Attestation Message Validation', () => {
    let handler: ClientHandler;

    beforeEach(() => {
      handler = createHandler();
    });

    afterEach(async () => {
      await handler.shutdown();
    });

    it('should reject attest_request without build_token', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_request',
        device_id: 'device-123',
      }));

      const errors = ws.getMessagesByType('error');
      expect(errors.some(e => e.message.includes('build_token'))).toBe(true);
    });

    it('should reject attest_request without device_id', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_request',
        build_token: 'token',
      }));

      const errors = ws.getMessagesByType('error');
      expect(errors.some(e => e.message.includes('device_id'))).toBe(true);
    });

    it('should reject attest_response without nonce', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_response',
        responses: [{ region_index: 0, hmac: 'hmac' }],
      }));

      const errors = ws.getMessagesByType('error');
      expect(errors.some(e => e.message.includes('nonce'))).toBe(true);
    });

    it('should reject attest_response without responses', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_response',
        nonce: 'nonce-123',
      }));

      const errors = ws.getMessagesByType('error');
      expect(errors.some(e => e.message.includes('responses'))).toBe(true);
    });

    it('should reject attest_response with empty responses array', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_response',
        nonce: 'nonce-123',
        responses: [],
      }));

      const errors = ws.getMessagesByType('error');
      expect(errors.some(e => e.message.includes('responses'))).toBe(true);
    });
  });

  describe('Chunk Operations Gating', () => {
    let handler: ClientHandler;
    let storage: SQLiteStorage;
    let tmpDir: string;

    beforeEach(async () => {
      ({ storage, tmpDir } = createTestStorage());
      await storage.init();

      // Create handler with attestation AND storage (for chunk relay)
      // Use a very short grace period so we can test the gating
      handler = createHandler(
        {
          bootstrapUrl: 'https://bootstrap.example.com',
          vpsIdentityKey: null,
          sessionTokenTtl: 3600000,
          gracePeriod: 50, // 50ms for testing
        },
        storage
      );
    });

    afterEach(async () => {
      await handler.shutdown();
      storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should allow chunk operations during grace period', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      await registerPeer(handler, ws, PEER_CODE_1, VALID_PUBKEY_1);
      ws.clearMessages();

      // Immediately send chunk_announce (within grace period)
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'peer-1',
        chunks: [{ chunkId: 'c1', channelId: 'ch1' }],
      }));

      // Should succeed (within grace period)
      const ack = ws.getMessagesByType('chunk_announce_ack');
      expect(ack.length).toBe(1);
      expect(ack[0].registered).toBe(1);
    });

    it('should block chunk operations after grace period expires', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      await registerPeer(handler, ws, PEER_CODE_1, VALID_PUBKEY_1);
      ws.clearMessages();

      // Wait for grace period to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      // Try to announce chunks
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'peer-1',
        chunks: [{ chunkId: 'c1', channelId: 'ch1' }],
      }));

      // Should be rejected with NOT_ATTESTED error
      const errors = ws.getMessagesByType('error');
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('NOT_ATTESTED');
      expect(errors[0].message).toContain('Attestation required');

      // No announce acknowledgment
      const acks = ws.getMessagesByType('chunk_announce_ack');
      expect(acks.length).toBe(0);
    });

    it('should block chunk_request after grace period expires', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      await registerPeer(handler, ws, PEER_CODE_1, VALID_PUBKEY_1);
      ws.clearMessages();

      await new Promise(resolve => setTimeout(resolve, 100));

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'chunk_request',
        chunkId: 'c1',
        channelId: 'ch1',
      }));

      const errors = ws.getMessagesByType('error');
      expect(errors.some(e => e.code === 'NOT_ATTESTED')).toBe(true);
    });

    it('should block chunk_push after grace period expires', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      await registerPeer(handler, ws, PEER_CODE_1, VALID_PUBKEY_1);
      ws.clearMessages();

      await new Promise(resolve => setTimeout(resolve, 100));

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'chunk_push',
        chunkId: 'c1',
        channelId: 'ch1',
        data: Buffer.from('test').toString('base64'),
      }));

      const errors = ws.getMessagesByType('error');
      expect(errors.some(e => e.code === 'NOT_ATTESTED')).toBe(true);
    });

    it('should allow chunk operations after successful attestation', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      await registerPeer(handler, ws, PEER_CODE_1, VALID_PUBKEY_1);
      ws.clearMessages();

      // Mock successful attestation
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ nonce: 'nonce', regions: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ valid: true, session_token: 'token-abc' }),
        } as Response);

      // Complete attestation
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_request',
        build_token: 'token',
        device_id: 'device',
      }));
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_response',
        nonce: 'nonce',
        responses: [{ region_index: 0, hmac: 'hmac' }],
      }));

      ws.clearMessages();

      // Wait for grace period to expire (shouldn't matter, we're attested)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Chunk operations should work
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'peer-1',
        chunks: [{ chunkId: 'c1', channelId: 'ch1' }],
      }));

      const ack = ws.getMessagesByType('chunk_announce_ack');
      expect(ack.length).toBe(1);
      expect(ack[0].registered).toBe(1);

      vi.restoreAllMocks();
    });
  });

  describe('Non-Attested Operations', () => {
    let handler: ClientHandler;

    beforeEach(() => {
      handler = createHandler();
    });

    afterEach(async () => {
      await handler.shutdown();
    });

    it('should always allow signaling operations (register, pair, etc) regardless of attestation', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      // Wait well past grace period
      // (We manipulate the session directly for this test)
      const manager = handler.getAttestationManager()!;
      // Get the only session
      for (const [, session] of [...(manager as any).sessions]) {
        session.connectedAt = Date.now() - 60000; // 60 seconds ago
      }

      // Register should still work
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'register',
        pairingCode: PEER_CODE_1,
        publicKey: VALID_PUBKEY_1,
      }));

      const registered = ws.getMessagesByType('registered');
      expect(registered.length).toBe(1);
    });

    it('should always allow ping/pong regardless of attestation', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({ type: 'ping' }));

      const pongs = ws.getMessagesByType('pong');
      expect(pongs.length).toBe(1);
    });
  });

  describe('Attestation Not Configured', () => {
    let handler: ClientHandler;
    let storage: SQLiteStorage;
    let tmpDir: string;

    beforeEach(async () => {
      ({ storage, tmpDir } = createTestStorage());
      await storage.init();

      // Create handler WITHOUT attestation config
      handler = createHandler(NO_ATTESTATION, storage);
    });

    afterEach(async () => {
      await handler.shutdown();
      storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should not send server_identity on connection', () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);

      const identityMsgs = ws.getMessagesByType('server_identity');
      expect(identityMsgs.length).toBe(0);
    });

    it('should return error for attest_request when not configured', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'attest_request',
        build_token: 'token',
        device_id: 'device',
      }));

      const errors = ws.getMessagesByType('error');
      expect(errors.some(e => e.message.includes('not configured'))).toBe(true);
    });

    it('should always allow chunk operations when attestation is not configured', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      await registerPeer(handler, ws, PEER_CODE_1, VALID_PUBKEY_1);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'peer-1',
        chunks: [{ chunkId: 'c1', channelId: 'ch1' }],
      }));

      const ack = ws.getMessagesByType('chunk_announce_ack');
      expect(ack.length).toBe(1);
    });
  });
});
