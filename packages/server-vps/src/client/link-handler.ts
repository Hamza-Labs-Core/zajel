/**
 * Device Link Handler
 *
 * Manages device linking flows where a web client links to a mobile app.
 * Owns pending link requests and expiry timers.
 * Extracted from SignalingHandler to separate device-linking concerns.
 */

import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { PAIRING_CODE } from '../constants.js';
import type {
  LinkRequestMessage,
  LinkResponseMessage,
} from './types.js';

export interface LinkHandlerDeps {
  send: (ws: WebSocket, message: object) => boolean;
  sendError: (ws: WebSocket, message: string) => void;
  /** Look up a WebSocket by pairing code (signaling registry). */
  getPairingCodeWs: (code: string) => WebSocket | undefined;
  /** Look up the pairing code for a WebSocket (signaling registry). */
  getWsPairingCode: (ws: WebSocket) => string | undefined;
  /** Look up the public key for a pairing code (signaling registry). */
  getPairingCodePublicKey: (code: string) => string | undefined;
  /** Timeout in ms for link requests. */
  linkRequestTimeout: number;
}

export class LinkHandler {
  // Pending device link requests: linkCode -> request info
  private pendingLinkRequests: Map<string, {
    webClientCode: string;
    webPublicKey: string;
    deviceName: string;
    timestamp: number;
  }> = new Map();

  // Timer references for link request expiration (Issue #9: Memory leak fix)
  private linkRequestTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private readonly send: (ws: WebSocket, message: object) => boolean;
  private readonly sendError: (ws: WebSocket, message: string) => void;
  private readonly getPairingCodeWs: (code: string) => WebSocket | undefined;
  private readonly getWsPairingCode: (ws: WebSocket) => string | undefined;
  private readonly getPairingCodePublicKey: (code: string) => string | undefined;
  private readonly linkRequestTimeout: number;

  constructor(deps: LinkHandlerDeps) {
    this.send = deps.send;
    this.sendError = deps.sendError;
    this.getPairingCodeWs = deps.getPairingCodeWs;
    this.getWsPairingCode = deps.getWsPairingCode;
    this.getPairingCodePublicKey = deps.getPairingCodePublicKey;
    this.linkRequestTimeout = deps.linkRequestTimeout;
  }

  // ---------------------------------------------------------------------------
  // Link request
  // ---------------------------------------------------------------------------

  handleLinkRequest(ws: WebSocket, message: LinkRequestMessage): void {
    const { linkCode, publicKey, deviceName = 'Unknown Browser' } = message;
    const webClientCode = this.getWsPairingCode(ws);

    if (!webClientCode) {
      this.sendError(ws, 'Not registered. Send register message first.');
      return;
    }

    if (!linkCode) {
      this.sendError(ws, 'Missing required field: linkCode');
      return;
    }

    // Validate link code format (Issue #17)
    if (!PAIRING_CODE.REGEX.test(linkCode)) {
      this.sendError(ws, 'Invalid link code format');
      return;
    }

    if (!publicKey) {
      this.sendError(ws, 'Missing required field: publicKey');
      return;
    }

    const mobileWs = this.getPairingCodeWs(linkCode);

    if (!mobileWs) {
      this.send(ws, {
        type: 'link_error',
        error: 'Link request could not be processed',
      });
      return;
    }

    // Clear any existing timer for this link code
    const existingLinkTimer = this.linkRequestTimers.get(linkCode);
    if (existingLinkTimer) {
      clearTimeout(existingLinkTimer);
      this.linkRequestTimers.delete(linkCode);
    }

    this.pendingLinkRequests.set(linkCode, {
      webClientCode,
      webPublicKey: publicKey,
      deviceName,
      timestamp: Date.now(),
    });

    // Set timeout (Issue #9: Prevents memory leak)
    const linkTimer = setTimeout(() => {
      this.expireLinkRequest(linkCode);
      this.linkRequestTimers.delete(linkCode);
    }, this.linkRequestTimeout);
    this.linkRequestTimers.set(linkCode, linkTimer);

    this.send(mobileWs, {
      type: 'link_request',
      linkCode,
      publicKey,
      deviceName,
      expiresIn: this.linkRequestTimeout,
    });

    logger.debug(`[Link] Request: web ${logger.pairingCode(webClientCode)} -> mobile ${logger.pairingCode(linkCode)}`);
  }

  // ---------------------------------------------------------------------------
  // Link response
  // ---------------------------------------------------------------------------

  handleLinkResponse(ws: WebSocket, message: LinkResponseMessage): void {
    const { linkCode, accepted, deviceId } = message;
    const mobileCode = this.getWsPairingCode(ws);

    if (!mobileCode) {
      this.sendError(ws, 'Not registered. Send register message first.');
      return;
    }

    if (!linkCode || !PAIRING_CODE.REGEX.test(linkCode)) {
      this.sendError(ws, 'Invalid link code format');
      return;
    }

    if (mobileCode !== linkCode) {
      this.sendError(ws, 'Cannot respond to link request for another device');
      return;
    }

    const pending = this.pendingLinkRequests.get(linkCode);
    if (!pending) {
      this.send(ws, {
        type: 'link_error',
        error: 'No pending link request found',
      });
      return;
    }

    // Clear the timer (Issue #9)
    const existingLinkTimer = this.linkRequestTimers.get(linkCode);
    if (existingLinkTimer) {
      clearTimeout(existingLinkTimer);
      this.linkRequestTimers.delete(linkCode);
    }

    this.pendingLinkRequests.delete(linkCode);

    const webWs = this.getPairingCodeWs(pending.webClientCode);
    if (!webWs) {
      return; // Web client disconnected
    }

    if (accepted) {
      const mobilePublicKey = this.getPairingCodePublicKey(mobileCode);
      if (!mobilePublicKey) {
        this.sendError(ws, 'Public key not found');
        return;
      }

      this.send(webWs, {
        type: 'link_matched',
        linkCode,
        peerPublicKey: mobilePublicKey,
        isInitiator: true,
        deviceId,
      });

      this.send(ws, {
        type: 'link_matched',
        linkCode,
        peerPublicKey: pending.webPublicKey,
        isInitiator: false,
        webClientCode: pending.webClientCode,
        deviceName: pending.deviceName,
      });

      logger.debug(`[Link] Matched: web ${logger.pairingCode(pending.webClientCode)} <-> mobile ${logger.pairingCode(mobileCode)}`);
    } else {
      this.send(webWs, {
        type: 'link_rejected',
        linkCode,
      });

      logger.debug(`[Link] Rejected: web ${logger.pairingCode(pending.webClientCode)} by mobile ${logger.pairingCode(mobileCode)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Expiry
  // ---------------------------------------------------------------------------

  private expireLinkRequest(linkCode: string): void {
    const pending = this.pendingLinkRequests.get(linkCode);

    if (pending) {
      this.pendingLinkRequests.delete(linkCode);

      const webWs = this.getPairingCodeWs(pending.webClientCode);
      if (webWs) {
        this.send(webWs, {
          type: 'link_timeout',
          linkCode,
        });
      }

      const mobileWs = this.getPairingCodeWs(linkCode);
      if (mobileWs) {
        this.send(mobileWs, {
          type: 'link_timeout',
          linkCode,
        });
      }

      logger.debug(`[Link] Expired: web ${logger.pairingCode(pending.webClientCode)} -> mobile ${logger.pairingCode(linkCode)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Disconnect cleanup
  // ---------------------------------------------------------------------------

  /**
   * Clean up link requests when a peer disconnects.
   * Call this with the pairing code of the disconnecting peer.
   */
  handleDisconnect(pairingCode: string): void {
    // Clean up pending link requests where this peer was the mobile app (Issue #9)
    const mobileTimer = this.linkRequestTimers.get(pairingCode);
    if (mobileTimer) {
      clearTimeout(mobileTimer);
      this.linkRequestTimers.delete(pairingCode);
    }
    this.pendingLinkRequests.delete(pairingCode);

    // Also clean up link requests where this peer was the web client
    for (const [linkCode, request] of this.pendingLinkRequests) {
      if (request.webClientCode === pairingCode) {
        const webClientTimer = this.linkRequestTimers.get(linkCode);
        if (webClientTimer) {
          clearTimeout(webClientTimer);
          this.linkRequestTimers.delete(linkCode);
        }
        this.pendingLinkRequests.delete(linkCode);
        // Notify mobile app that web client disconnected
        const mobileWs = this.getPairingCodeWs(linkCode);
        if (mobileWs) {
          this.send(mobileWs, {
            type: 'link_timeout',
            linkCode,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Clear all link request state and timers.
   */
  shutdown(): void {
    // Clear link request timers (Issue #9)
    for (const timer of this.linkRequestTimers.values()) {
      clearTimeout(timer);
    }
    this.linkRequestTimers.clear();
    this.pendingLinkRequests.clear();
  }
}
