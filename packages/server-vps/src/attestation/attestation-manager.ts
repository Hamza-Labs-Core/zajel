/**
 * Attestation Manager
 *
 * Manages client attestation and server identity for the VPS server.
 *
 * Responsibilities:
 * - Forward attestation challenges/responses to/from the bootstrap server
 * - Cache session tokens for attested clients
 * - Generate server identity proofs for client verification
 * - Enforce grace period for unattested connections
 * - Handle session token expiry and re-attestation
 */

import * as crypto from 'crypto';
import { logger } from '../utils/logger.js';


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttestationConfig {
  /** Bootstrap server URL for forwarding attestation requests */
  bootstrapUrl: string | null;
  /** Ed25519 private key for VPS server identity (base64) */
  vpsIdentityKey: string | null;
  /** Session token TTL in milliseconds (default: 1 hour) */
  sessionTokenTtl: number;
  /** Grace period in milliseconds for unattested connections (default: 30 seconds) */
  gracePeriod: number;
}

export interface AttestationSession {
  /** Whether the client has been attested */
  attested: boolean;
  /** Session token from bootstrap (after successful attestation) */
  sessionToken: string | null;
  /** When the session token expires (epoch ms) */
  tokenExpiresAt: number;
  /** When the connection was established (epoch ms) */
  connectedAt: number;
  /** Whether attestation is in progress */
  attestationPending: boolean;
  /** Device ID from the client's attest_request */
  deviceId: string | null;
}

/** Bootstrap challenge response from POST /attest/challenge */
export interface BootstrapChallengeResponse {
  nonce: string;
  regions: Array<{ offset: number; length: number }>;
}

/** Bootstrap verify response from POST /attest/verify */
export interface BootstrapVerifyResponse {
  valid: boolean;
  session_token?: string;
}

/** Server identity keypair (Ed25519) */
export interface VpsIdentityKeypair {
  publicKey: Buffer;
  privateKey: Buffer;
}

// ---------------------------------------------------------------------------
// AttestationManager
// ---------------------------------------------------------------------------

export class AttestationManager {
  private config: AttestationConfig;
  private sessions: Map<string, AttestationSession> = new Map();
  private keypair: VpsIdentityKeypair | null = null;
  private _enabled: boolean;

  constructor(config: AttestationConfig) {
    this.config = config;
    this._enabled = !!config.bootstrapUrl;

    if (!this._enabled) {
      logger.warn('[Attestation] BOOTSTRAP_URL not configured - attestation disabled (all clients allowed)');
    }

    // Initialize server identity keypair
    this.initKeypair();
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the Ed25519 keypair for server identity.
   * If VPS_IDENTITY_KEY env is set, load from it.
   * Otherwise generate an ephemeral keypair for dev/testing.
   */
  private initKeypair(): void {
    if (this.config.vpsIdentityKey) {
      try {
        const privateKeyBytes = Buffer.from(this.config.vpsIdentityKey, 'base64');
        // Node.js crypto Ed25519 keys: create keypair from seed
        const keyObj = crypto.createPrivateKey({
          key: Buffer.concat([
            // PKCS8 ASN.1 prefix for Ed25519
            Buffer.from('302e020100300506032b657004220420', 'hex'),
            privateKeyBytes.subarray(0, 32), // Ed25519 seed is 32 bytes
          ]),
          format: 'der',
          type: 'pkcs8',
        });
        const pubKeyObj = crypto.createPublicKey(keyObj);

        this.keypair = {
          privateKey: Buffer.from(
            keyObj.export({ type: 'pkcs8', format: 'der' })
          ),
          publicKey: Buffer.from(
            pubKeyObj.export({ type: 'spki', format: 'der' })
          ),
        };
        logger.info('[Attestation] Server identity loaded from VPS_IDENTITY_KEY');
      } catch (err) {
        logger.warn(`[Attestation] Failed to load VPS_IDENTITY_KEY, generating ephemeral keypair: ${err}`);
        this.generateEphemeralKeypair();
      }
    } else {
      this.generateEphemeralKeypair();
    }
  }

  /**
   * Generate an ephemeral Ed25519 keypair for dev/testing.
   */
  private generateEphemeralKeypair(): void {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.keypair = {
      publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
      privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })),
    };
    if (this._enabled) {
      logger.warn('[Attestation] Using ephemeral keypair - set VPS_IDENTITY_KEY for production');
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Whether attestation is enabled (bootstrap URL configured).
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Get the server's public key in base64 (raw 32-byte Ed25519 key).
   */
  getPublicKeyBase64(): string {
    if (!this.keypair) return '';
    // Extract raw 32-byte public key from SPKI DER format
    // SPKI for Ed25519 is: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
    // The raw key starts at offset 12
    const raw = this.keypair.publicKey.subarray(12);
    return raw.toString('base64');
  }

  /**
   * Sign data with the server's Ed25519 private key.
   * Returns the signature in base64.
   */
  signData(data: Buffer): string {
    if (!this.keypair) {
      throw new Error('Server identity keypair not initialized');
    }
    const privKey = crypto.createPrivateKey({
      key: this.keypair.privateKey,
      format: 'der',
      type: 'pkcs8',
    });
    const signature = crypto.sign(null, data, privKey);
    return signature.toString('base64');
  }

  /**
   * Create a session for a new WebSocket connection.
   * Returns a unique connection ID.
   */
  createSession(): string {
    const connectionId = crypto.randomUUID();
    this.sessions.set(connectionId, {
      attested: !this._enabled, // Auto-attested if attestation disabled
      sessionToken: null,
      tokenExpiresAt: 0,
      connectedAt: Date.now(),
      attestationPending: false,
      deviceId: null,
    });
    return connectionId;
  }

  /**
   * Remove a session when a client disconnects.
   */
  removeSession(connectionId: string): void {
    this.sessions.delete(connectionId);
  }

  /**
   * Get the session for a connection.
   */
  getSession(connectionId: string): AttestationSession | undefined {
    return this.sessions.get(connectionId);
  }

  /**
   * Check if a client is attested (or if attestation is disabled).
   */
  isAttested(connectionId: string): boolean {
    if (!this._enabled) return true;

    const session = this.sessions.get(connectionId);
    if (!session) return false;

    // Check if attested and token not expired
    if (session.attested && session.sessionToken) {
      if (Date.now() < session.tokenExpiresAt) {
        return true;
      }
      // Token expired - need re-attestation
      session.attested = false;
      session.sessionToken = null;
      return false;
    }

    return session.attested;
  }

  /**
   * Check if a client is within the grace period.
   */
  isInGracePeriod(connectionId: string): boolean {
    if (!this._enabled) return true;

    const session = this.sessions.get(connectionId);
    if (!session) return false;

    const elapsed = Date.now() - session.connectedAt;
    return elapsed < this.config.gracePeriod;
  }

  /**
   * Check if a client should be allowed to perform operations.
   * Returns true if attested, or within grace period.
   */
  isAllowed(connectionId: string): boolean {
    if (!this._enabled) return true;
    return this.isAttested(connectionId) || this.isInGracePeriod(connectionId);
  }

  // ---------------------------------------------------------------------------
  // Attestation Flow
  // ---------------------------------------------------------------------------

  /**
   * Phase 1: Handle attest_request from client.
   * Forwards to bootstrap's POST /attest/challenge.
   *
   * Returns the challenge from bootstrap, or null on failure.
   */
  async requestChallenge(
    connectionId: string,
    buildToken: string,
    deviceId: string
  ): Promise<BootstrapChallengeResponse | null> {
    if (!this._enabled || !this.config.bootstrapUrl) {
      return null;
    }

    const session = this.sessions.get(connectionId);
    if (!session) return null;

    session.attestationPending = true;
    session.deviceId = deviceId;

    try {
      const url = `${this.config.bootstrapUrl}/attest/challenge`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ build_token: buildToken, device_id: deviceId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn(`[Attestation] Challenge request failed: ${response.status} - ${errorText}`);
        session.attestationPending = false;
        return null;
      }

      const result = (await response.json()) as BootstrapChallengeResponse;
      return result;
    } catch (err) {
      logger.warn(`[Attestation] Challenge request error: ${err}`);
      session.attestationPending = false;
      return null;
    }
  }

  /**
   * Phase 2: Handle attest_response from client.
   * Forwards to bootstrap's POST /attest/verify.
   *
   * Returns the verification result.
   */
  async verifyAttestation(
    connectionId: string,
    nonce: string,
    responses: Array<{ region_index: number; hmac: string }>
  ): Promise<BootstrapVerifyResponse> {
    if (!this._enabled || !this.config.bootstrapUrl) {
      return { valid: false };
    }

    const session = this.sessions.get(connectionId);
    if (!session) return { valid: false };

    try {
      const url = `${this.config.bootstrapUrl}/attest/verify`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: session.deviceId,
          nonce,
          responses,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn(`[Attestation] Verify request failed: ${response.status} - ${errorText}`);
        session.attestationPending = false;
        return { valid: false };
      }

      const result = (await response.json()) as BootstrapVerifyResponse;

      if (result.valid && result.session_token) {
        // Attestation succeeded - store session token
        session.attested = true;
        session.sessionToken = result.session_token;
        session.tokenExpiresAt = Date.now() + this.config.sessionTokenTtl;
        session.attestationPending = false;
        logger.info(`[Attestation] Client attested successfully (connection: ${connectionId.substring(0, 8)}...)`);
      } else {
        session.attestationPending = false;
        logger.warn(`[Attestation] Client attestation failed (connection: ${connectionId.substring(0, 8)}...)`);
      }

      return result;
    } catch (err) {
      logger.warn(`[Attestation] Verify request error: ${err}`);
      session.attestationPending = false;
      return { valid: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Server Identity Proof
  // ---------------------------------------------------------------------------

  /**
   * Generate a server identity proof for the connecting client.
   * The server signs a nonce to prove it controls the identity key.
   *
   * Returns the proof message to send to the client.
   */
  generateServerIdentityProof(): {
    type: 'server_identity';
    public_key: string;
    nonce: string;
    signature: string;
  } {
    const nonce = crypto.randomBytes(32).toString('base64');
    const signature = this.signData(Buffer.from(nonce, 'base64'));

    return {
      type: 'server_identity',
      public_key: this.getPublicKeyBase64(),
      nonce,
      signature,
    };
  }

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  /**
   * Get connections that have exceeded the grace period without attestation.
   */
  getExpiredGracePeriodConnections(): string[] {
    if (!this._enabled) return [];

    const expired: string[] = [];
    const now = Date.now();

    for (const [connectionId, session] of this.sessions) {
      if (
        !session.attested &&
        !session.attestationPending &&
        now - session.connectedAt >= this.config.gracePeriod
      ) {
        expired.push(connectionId);
      }
    }

    return expired;
  }

  /**
   * Get the count of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get the count of attested sessions.
   */
  get attestedCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.attested) count++;
    }
    return count;
  }

  /**
   * Shutdown - clear all sessions.
   */
  shutdown(): void {
    this.sessions.clear();
  }
}
