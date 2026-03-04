/**
 * Attestation Handler
 *
 * Manages client attestation request/response flows and attestation gating.
 * Extracted from ClientHandler to separate attestation concerns.
 */

import type { WebSocket } from 'ws';
import { ATTESTATION } from '../constants.js';
import type { HandlerContext } from './context.js';
import type {
  AttestRequestMessage,
  AttestResponseMessage,
} from './types.js';

export class AttestationHandler {
  private readonly ctx: HandlerContext;

  constructor(ctx: HandlerContext) {
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  // Attestation gate
  // ---------------------------------------------------------------------------

  /**
   * Check if the client is attested or within grace period.
   * If not, send an error and return false.
   * If attestation is not configured, always returns true.
   */
  checkAttestation(ws: WebSocket): boolean {
    if (!this.ctx.attestationManager) return true;

    const connectionId = this.ctx.wsToConnectionId.get(ws);
    if (!connectionId) return true; // No attestation session = not tracked

    if (this.ctx.attestationManager.isAllowed(connectionId)) {
      return true;
    }

    // Client is not attested and grace period expired
    this.ctx.send(ws, {
      type: 'error',
      code: ATTESTATION.ERROR_CODE_NOT_ATTESTED,
      message: 'Attestation required',
    });
    return false;
  }

  // ---------------------------------------------------------------------------
  // Attest request
  // ---------------------------------------------------------------------------

  /**
   * Handle attest_request: Client sends build_token and device_id.
   * VPS forwards to bootstrap's POST /attest/challenge.
   */
  async handleAttestRequest(ws: WebSocket, message: AttestRequestMessage): Promise<void> {
    if (!this.ctx.attestationManager) {
      this.ctx.sendError(ws, 'Attestation not configured');
      return;
    }

    const { build_token, device_id } = message;

    if (!build_token) {
      this.ctx.sendError(ws, 'Missing required field: build_token');
      return;
    }

    if (!device_id) {
      this.ctx.sendError(ws, 'Missing required field: device_id');
      return;
    }

    const connectionId = this.ctx.wsToConnectionId.get(ws);
    if (!connectionId) {
      this.ctx.sendError(ws, 'No attestation session');
      return;
    }

    const challenge = await this.ctx.attestationManager.requestChallenge(
      connectionId,
      build_token,
      device_id
    );

    if (!challenge) {
      this.ctx.send(ws, {
        type: 'attest_error',
        message: 'Failed to get attestation challenge from bootstrap',
      });
      return;
    }

    this.ctx.send(ws, {
      type: 'attest_challenge',
      nonce: challenge.nonce,
      regions: challenge.regions,
    });
  }

  // ---------------------------------------------------------------------------
  // Attest response
  // ---------------------------------------------------------------------------

  /**
   * Handle attest_response: Client sends HMAC responses for the challenge.
   * VPS forwards to bootstrap's POST /attest/verify.
   */
  async handleAttestResponse(ws: WebSocket, message: AttestResponseMessage): Promise<void> {
    if (!this.ctx.attestationManager) {
      this.ctx.sendError(ws, 'Attestation not configured');
      return;
    }

    const { nonce, responses } = message;

    if (!nonce) {
      this.ctx.sendError(ws, 'Missing required field: nonce');
      return;
    }

    if (!responses || !Array.isArray(responses) || responses.length === 0) {
      this.ctx.sendError(ws, 'Missing or empty responses array');
      return;
    }

    const connectionId = this.ctx.wsToConnectionId.get(ws);
    if (!connectionId) {
      this.ctx.sendError(ws, 'No attestation session');
      return;
    }

    const result = await this.ctx.attestationManager.verifyAttestation(
      connectionId,
      nonce,
      responses
    );

    if (result.valid) {
      this.ctx.send(ws, {
        type: 'attest_success',
        session_token: result.session_token || null,
      });
    } else {
      this.ctx.send(ws, {
        type: 'attest_failed',
        message: 'Attestation verification failed',
      });
      // Disconnect client after attestation failure
      ws.close(ATTESTATION.WS_CLOSE_CODE_ATTESTATION_FAILED, 'Attestation failed');
    }
  }
}
