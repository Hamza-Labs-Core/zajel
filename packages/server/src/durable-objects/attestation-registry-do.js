/**
 * AttestationRegistry Durable Object
 *
 * Manages app attestation for the Zajel infrastructure:
 * - Reference binary metadata per version/platform
 * - Registered devices (device_id -> build_version, registered_at)
 * - Active challenges (nonce tracking to prevent replay)
 * - Version policy (minimum_version, blocked_versions, etc.)
 *
 * Storage key prefixes:
 * - device:{device_id}        -> { device_id, build_version, platform, registered_at, last_seen }
 * - reference:{version}:{platform} -> { version, platform, build_hash, size, critical_regions }
 * - nonce:{nonce}             -> { device_id, created_at, regions }
 * - version_policy            -> { minimum_version, recommended_version, blocked_versions, sunset_dates }
 */

import {
  importAttestationSigningKey,
  importSessionSigningKey,
  importVerifyKey,
  exportPublicKeyBase64,
  verifyBuildTokenSignature,
  generateNonce,
  computeHmac,
  createSessionToken,
  compareVersions,
} from '../crypto/attestation.js';

import { hexToBytes } from '../crypto/signing.js';
import { getCorsHeaders } from '../cors.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';
import { parseJsonBody, BodyTooLargeError } from '../utils/request-validation.js';
import { createLogger } from '../logger.js';

/** Session token TTL: 1 hour */
const SESSION_TOKEN_TTL = 60 * 60 * 1000;

/** Nonce TTL: 5 minutes (challenges expire) */
const NONCE_TTL = 5 * 60 * 1000;

/** Device TTL: 90 days (stale devices are cleaned up) */
const DEVICE_TTL = 90 * 24 * 60 * 60 * 1000;

/** Maximum active nonces per device */
const MAX_NONCES_PER_DEVICE = 5;

/** Maximum device entries */
const MAX_DEVICE_ENTRIES = 100000;

/** Maximum age for build tokens: 30 days */
const MAX_TOKEN_AGE = 30 * 24 * 60 * 60 * 1000;

/** Maximum clock skew tolerance: 1 minute */
const MAX_CLOCK_SKEW = 60 * 1000;

/** Generic error message for all attestation verification failures */
const VERIFY_FAILED_MSG = 'Verification failed';

/** Number of regions per challenge */
const MIN_CHALLENGE_REGIONS = 3;
const MAX_CHALLENGE_REGIONS = 5;

/**
 * Validate an ID string for use in storage keys.
 * Allows alphanumeric characters, dots, hyphens, and underscores.
 * @param {string} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9._-]+$/.test(id);
}

export class AttestationRegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env);

    // Schedule periodic cleanup alarm
    if (state.blockConcurrencyWhile) {
      state.blockConcurrencyWhile(async () => {
        const currentAlarm = await state.storage.getAlarm();
        if (!currentAlarm) {
          await state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
        }
      });
    }
  }

  /**
   * Periodic alarm for cleaning up expired nonces and stale device entries.
   */
  async alarm() {
    const now = Date.now();

    // Clean up expired nonces
    const nonces = await this.state.storage.list({ prefix: 'nonce:' });
    const deleteNonceKeys = [];
    for (const [key, value] of nonces) {
      if (now - value.created_at > NONCE_TTL) {
        deleteNonceKeys.push(key);
      }
    }
    if (deleteNonceKeys.length > 0) {
      for (let i = 0; i < deleteNonceKeys.length; i += 128) {
        await this.state.storage.delete(deleteNonceKeys.slice(i, i + 128));
      }
    }

    // Clean up stale device entries (not seen in 90 days)
    const devices = await this.state.storage.list({ prefix: 'device:' });
    const deleteDeviceKeys = [];
    for (const [key, device] of devices) {
      const lastActivity = device.last_seen || device.registered_at;
      if (now - lastActivity > DEVICE_TTL) {
        deleteDeviceKeys.push(key);
      }
    }
    if (deleteDeviceKeys.length > 0) {
      for (let i = 0; i < deleteDeviceKeys.length; i += 128) {
        await this.state.storage.delete(deleteDeviceKeys.slice(i, i + 128));
      }
    }

    // Schedule next cleanup
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  async fetch(request) {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request, this.env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // POST /attest/register
      if (request.method === 'POST' && url.pathname === '/attest/register') {
        return await this.handleRegister(request, corsHeaders);
      }

      // POST /attest/upload-reference
      if (request.method === 'POST' && url.pathname === '/attest/upload-reference') {
        return await this.handleUploadReference(request, corsHeaders);
      }

      // POST /attest/challenge
      if (request.method === 'POST' && url.pathname === '/attest/challenge') {
        return await this.handleChallenge(request, corsHeaders);
      }

      // POST /attest/verify
      if (request.method === 'POST' && url.pathname === '/attest/verify') {
        return await this.handleVerify(request, corsHeaders);
      }

      // GET /attest/versions
      if (request.method === 'GET' && url.pathname === '/attest/versions') {
        return await this.handleGetVersions(corsHeaders);
      }

      // POST /attest/versions
      if (request.method === 'POST' && url.pathname === '/attest/versions') {
        return await this.handleSetVersions(request, corsHeaders);
      }

      return new Response(
        JSON.stringify({ error: 'Not Found' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return new Response(
          JSON.stringify({ error: 'Request body too large' }),
          { status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      this.logger.error('[attestation-registry] Unhandled error', error);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  }

  /**
   * POST /attest/register
   * Accepts { build_token, device_id }
   * Build token format: { payload: JSON string, signature: base64 }
   * Payload: { version, platform, build_hash, timestamp }
   */
  async handleRegister(request, corsHeaders) {
    const body = await parseJsonBody(request, 8192);
    const { build_token, device_id } = body;

    if (!build_token || !device_id) {
      return this.jsonResponse(
        { error: 'Missing required fields: build_token, device_id' },
        400,
        corsHeaders
      );
    }

    // Validate device_id format
    if (!isValidId(device_id)) {
      return this.jsonResponse({ error: 'Invalid device_id format' }, 400, corsHeaders);
    }

    if (!build_token.payload || !build_token.signature) {
      return this.jsonResponse(
        { error: 'Invalid build_token format: must include payload and signature' },
        400,
        corsHeaders
      );
    }

    // Verify build token signature using a dedicated build token verify key,
    // or fall back to deriving from ATTESTATION_SIGNING_KEY for backward compatibility.
    let verifyKey;
    if (this.env.BUILD_TOKEN_VERIFY_KEY) {
      try {
        verifyKey = await importVerifyKey(this.env.BUILD_TOKEN_VERIFY_KEY);
      } catch (e) {
        return this.jsonResponse(
          { error: 'Build token verification configuration error' },
          500,
          corsHeaders
        );
      }
    } else if (this.env.ATTESTATION_SIGNING_KEY) {
      let signingKey;
      try {
        signingKey = await importAttestationSigningKey(this.env.ATTESTATION_SIGNING_KEY);
      } catch (e) {
        return this.jsonResponse(
          { error: 'Attestation service configuration error' },
          500,
          corsHeaders
        );
      }
      const publicKeyBase64 = await exportPublicKeyBase64(signingKey);
      verifyKey = await importVerifyKey(publicKeyBase64);
    } else {
      return this.jsonResponse(
        { error: 'Build token verification not configured' },
        503,
        corsHeaders
      );
    }

    const valid = await verifyBuildTokenSignature(
      verifyKey,
      build_token.payload,
      build_token.signature
    );

    if (!valid) {
      return this.jsonResponse(
        { error: 'Invalid build token signature' },
        403,
        corsHeaders
      );
    }

    // Parse and validate the token payload
    let tokenData;
    try {
      tokenData = JSON.parse(build_token.payload);
    } catch {
      return this.jsonResponse(
        { error: 'Invalid build token payload' },
        400,
        corsHeaders
      );
    }

    const { version, platform, build_hash, timestamp } = tokenData;

    if (!version || !platform || !build_hash || !timestamp) {
      return this.jsonResponse(
        { error: 'Build token missing required fields: version, platform, build_hash, timestamp' },
        400,
        corsHeaders
      );
    }

    // Check build token timestamp
    const tokenAge = Date.now() - timestamp;
    if (tokenAge < -MAX_CLOCK_SKEW) {
      return this.jsonResponse(
        { error: 'Build token has a future timestamp' },
        403,
        corsHeaders
      );
    }
    if (tokenAge > MAX_TOKEN_AGE) {
      return this.jsonResponse(
        { error: 'Build token expired' },
        403,
        corsHeaders
      );
    }

    // Check version against policy
    const policy = await this.getVersionPolicy();
    const versionCheck = this.checkVersionPolicy(version, policy);
    if (versionCheck.blocked) {
      return this.jsonResponse(
        { error: versionCheck.reason },
        403,
        corsHeaders
      );
    }

    // Enforce maximum device entry count (skip check if device already exists)
    const existingDevice = await this.state.storage.get(`device:${device_id}`);
    if (!existingDevice) {
      const deviceCount = await this.state.storage.list({ prefix: 'device:', limit: MAX_DEVICE_ENTRIES + 1 });
      if (deviceCount.size >= MAX_DEVICE_ENTRIES) {
        return this.jsonResponse({ error: 'Device registry full' }, 503, corsHeaders);
      }
    }

    // Register the device
    const deviceEntry = {
      device_id,
      build_version: version,
      platform,
      build_hash,
      registered_at: Date.now(),
      last_seen: Date.now(),
    };

    await this.state.storage.put(`device:${device_id}`, deviceEntry);

    this.logger.info('[audit] Device registered', {
      action: 'device_register',
      device_id,
      version,
      platform,
      ip: request.headers.get('CF-Connecting-IP'),
    });

    return this.jsonResponse(
      {
        status: 'registered',
        device: deviceEntry,
        version_status: versionCheck.status,
        ...(versionCheck.status === 'update_recommended'
          ? { recommended_version: policy.recommended_version }
          : {}),
      },
      200,
      corsHeaders
    );
  }

  /**
   * POST /attest/upload-reference
   * CI uploads reference binary metadata for a new release.
   * Protected by CI_UPLOAD_SECRET.
   * Body: { version, platform, build_hash, size, critical_regions }
   */
  async handleUploadReference(request, corsHeaders) {
    // Verify CI secret
    const authHeader = request.headers.get('Authorization');
    if (!this.env.CI_UPLOAD_SECRET) {
      return this.jsonResponse(
        { error: 'CI upload not configured' },
        503,
        corsHeaders
      );
    }

    const expected = `Bearer ${this.env.CI_UPLOAD_SECRET}`;
    if (!authHeader || !timingSafeEqual(authHeader, expected)) {
      this.logger.warn('[audit] Unauthorized reference upload attempt', {
        action: 'reference_upload_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return this.jsonResponse(
        { error: 'Unauthorized' },
        401,
        corsHeaders
      );
    }

    const body = await parseJsonBody(request, 65536);
    const { version, platform, build_hash, size, critical_regions } = body;

    if (!version || !platform || !build_hash) {
      return this.jsonResponse(
        { error: 'Missing required fields: version, platform, build_hash' },
        400,
        corsHeaders
      );
    }

    if (!isValidId(version) || !isValidId(platform)) {
      return this.jsonResponse(
        { error: 'Invalid version or platform format' },
        400,
        corsHeaders
      );
    }

    if (!critical_regions || !Array.isArray(critical_regions) || critical_regions.length === 0) {
      return this.jsonResponse(
        { error: 'critical_regions must be a non-empty array of { offset, length, hmac } objects' },
        400,
        corsHeaders
      );
    }

    // Validate each critical region
    for (const region of critical_regions) {
      if (typeof region.offset !== 'number' || typeof region.length !== 'number') {
        return this.jsonResponse(
          { error: 'Each critical_region must have numeric offset and length' },
          400,
          corsHeaders
        );
      }
    }

    const referenceEntry = {
      version,
      platform,
      build_hash,
      size: size || 0,
      critical_regions,
      uploaded_at: Date.now(),
    };

    await this.state.storage.put(`reference:${version}:${platform}`, referenceEntry);

    this.logger.info('[audit] Reference uploaded', {
      action: 'reference_upload',
      version,
      platform,
    });

    return this.jsonResponse(
      { success: true, reference: referenceEntry },
      200,
      corsHeaders
    );
  }

  /**
   * POST /attest/challenge
   * Accepts { device_id, build_version }
   * Returns { nonce, regions: [{ offset, length }...] }
   */
  async handleChallenge(request, corsHeaders) {
    const body = await parseJsonBody(request, 2048);
    const { device_id, build_version } = body;

    if (!device_id || !build_version) {
      return this.jsonResponse(
        { error: 'Missing required fields: device_id, build_version' },
        400,
        corsHeaders
      );
    }

    if (!isValidId(device_id)) {
      return this.jsonResponse({ error: 'Invalid device_id format' }, 400, corsHeaders);
    }

    // Verify device is registered
    const device = await this.state.storage.get(`device:${device_id}`);
    if (!device) {
      return this.jsonResponse(
        { error: 'Device not registered' },
        404,
        corsHeaders
      );
    }

    // Update device last_seen
    device.last_seen = Date.now();
    await this.state.storage.put(`device:${device_id}`, device);

    // Rate limit: max active nonces per device
    const now = Date.now();
    const allNonces = await this.state.storage.list({ prefix: 'nonce:' });
    let deviceNonceCount = 0;
    for (const [, value] of allNonces) {
      if (value.device_id === device_id && now - value.created_at <= NONCE_TTL) {
        deviceNonceCount++;
      }
    }
    if (deviceNonceCount >= MAX_NONCES_PER_DEVICE) {
      return this.jsonResponse(
        { error: 'Too many pending challenges. Please complete or wait for existing challenges to expire.' },
        429,
        corsHeaders
      );
    }

    // Look up reference binary for this version and platform
    const reference = await this.state.storage.get(
      `reference:${build_version}:${device.platform}`
    );
    if (!reference) {
      return this.jsonResponse(
        { error: 'No reference binary found for this version and platform' },
        404,
        corsHeaders
      );
    }

    // Select random regions from critical_regions
    const numRegions = MIN_CHALLENGE_REGIONS + Math.floor(
      Math.random() * (MAX_CHALLENGE_REGIONS - MIN_CHALLENGE_REGIONS + 1)
    );
    const selectedRegions = this.selectRandomRegions(
      reference.critical_regions,
      numRegions
    );

    // Generate nonce
    const nonce = generateNonce();

    // Store the challenge for verification (with TTL)
    const challengeEntry = {
      device_id,
      build_version,
      platform: device.platform,
      nonce,
      regions: selectedRegions,
      created_at: Date.now(),
    };

    await this.state.storage.put(`nonce:${nonce}`, challengeEntry);

    return this.jsonResponse(
      {
        nonce,
        regions: selectedRegions.map((r, i) => ({
          index: i,
          offset: r.offset,
          length: r.length,
        })),
      },
      200,
      corsHeaders
    );
  }

  /**
   * POST /attest/verify
   * Accepts { device_id, nonce, responses: [{ region_index, hmac }...] }
   * Returns { valid: true/false, session_token? }
   */
  async handleVerify(request, corsHeaders) {
    const body = await parseJsonBody(request, 16384);
    const { device_id, nonce, responses } = body;

    if (!device_id || !nonce || !responses || !Array.isArray(responses)) {
      return this.jsonResponse(
        { error: 'Missing required fields: device_id, nonce, responses (array)' },
        400,
        corsHeaders
      );
    }

    if (!isValidId(device_id)) {
      return this.jsonResponse({ error: 'Invalid device_id format' }, 400, corsHeaders);
    }

    // Look up the challenge
    const challenge = await this.state.storage.get(`nonce:${nonce}`);
    if (!challenge) {
      console.error('[verify] Invalid or expired nonce', { device_id });
      return this.jsonResponse(
        { error: 'Invalid or expired nonce' },
        403,
        corsHeaders
      );
    }

    // Verify nonce hasn't expired
    if (Date.now() - challenge.created_at > NONCE_TTL) {
      await this.state.storage.delete(`nonce:${nonce}`);
      console.error('[verify] Challenge expired', { device_id, nonce });
      return this.jsonResponse(
        { error: 'Challenge expired' },
        403,
        corsHeaders
      );
    }

    // Verify device_id matches
    if (challenge.device_id !== device_id) {
      console.error('[verify] Device ID mismatch', { device_id, expected: challenge.device_id });
      return this.jsonResponse(
        { error: 'Device ID mismatch' },
        403,
        corsHeaders
      );
    }

    // Delete the nonce to prevent replay
    await this.state.storage.delete(`nonce:${nonce}`);

    // Look up reference binary to get expected HMACs
    const reference = await this.state.storage.get(
      `reference:${challenge.build_version}:${challenge.platform}`
    );
    if (!reference) {
      console.error('[verify] Reference binary not found', { version: challenge.build_version, platform: challenge.platform });
      return this.jsonResponse(
        { valid: false, error: 'Reference binary no longer available' },
        200,
        corsHeaders
      );
    }

    // Verify each response
    // The reference critical_regions should have pre-computed HMACs for the nonce
    // In practice, the server stores reference binary data and computes HMAC on the fly.
    // For this implementation, critical_regions store pre-computed region_data (hex)
    // and we compute HMAC(region_data, nonce) to compare with the client's response.
    if (responses.length !== challenge.regions.length) {
      console.error('[verify] Wrong response count', { expected: challenge.regions.length, got: responses.length });
      return this.jsonResponse(
        { valid: false, error: 'Wrong number of responses' },
        200,
        corsHeaders
      );
    }

    for (const response of responses) {
      const { region_index, hmac } = response;

      if (region_index < 0 || region_index >= challenge.regions.length) {
        console.error('[verify] Invalid region_index', { region_index });
        return this.jsonResponse(
          { valid: false, error: VERIFY_FAILED_MSG },
          200,
          corsHeaders
        );
      }

      const challengeRegion = challenge.regions[region_index];

      // Find the matching critical region in reference data
      const refRegion = reference.critical_regions.find(
        (r) => r.offset === challengeRegion.offset && r.length === challengeRegion.length
      );

      if (!refRegion || !refRegion.data_hex) {
        console.error('[verify] Reference data not available for region', { region_index });
        return this.jsonResponse(
          { valid: false, error: VERIFY_FAILED_MSG },
          200,
          corsHeaders
        );
      }

      // Compute expected HMAC: HMAC-SHA256(region_bytes, nonce)
      const regionBytes = hexToBytes(refRegion.data_hex);
      const expectedHmac = await computeHmac(regionBytes, nonce);

      if (!timingSafeEqual(hmac, expectedHmac)) {
        console.error('[verify] HMAC mismatch', { region_index });
        return this.jsonResponse(
          { valid: false, error: 'HMAC mismatch' },
          200,
          corsHeaders
        );
      }
    }

    // All HMACs match - issue session token
    if (!this.env.ATTESTATION_SIGNING_KEY) {
      return this.jsonResponse(
        { valid: true, error: 'Session token signing not configured' },
        200,
        corsHeaders
      );
    }

    const signingKey = await importSessionSigningKey(this.env.ATTESTATION_SIGNING_KEY);

    const tokenData = {
      device_id,
      build_version: challenge.build_version,
      platform: challenge.platform,
      issued_at: Date.now(),
      expires_at: Date.now() + SESSION_TOKEN_TTL,
    };

    const sessionToken = await createSessionToken(signingKey, tokenData);

    this.logger.info('[audit] Attestation verified', {
      action: 'attest_verify_success',
      device_id,
    });

    return this.jsonResponse(
      { valid: true, session_token: sessionToken },
      200,
      corsHeaders
    );
  }

  /**
   * GET /attest/versions
   * Returns the version policy.
   */
  async handleGetVersions(corsHeaders) {
    const policy = await this.getVersionPolicy();
    return this.jsonResponse(policy, 200, corsHeaders);
  }

  /**
   * POST /attest/versions
   * Updates the version policy. Protected by CI_UPLOAD_SECRET.
   */
  async handleSetVersions(request, corsHeaders) {
    // Verify admin secret (reuse CI_UPLOAD_SECRET as admin secret)
    const authHeader = request.headers.get('Authorization');
    if (!this.env.CI_UPLOAD_SECRET) {
      return this.jsonResponse(
        { error: 'Admin access not configured' },
        503,
        corsHeaders
      );
    }

    const expected = `Bearer ${this.env.CI_UPLOAD_SECRET}`;
    if (!authHeader || !timingSafeEqual(authHeader, expected)) {
      this.logger.warn('[audit] Unauthorized version policy update attempt', {
        action: 'version_policy_failed',
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return this.jsonResponse(
        { error: 'Unauthorized' },
        401,
        corsHeaders
      );
    }

    const body = await parseJsonBody(request, 4096);
    const {
      minimum_version,
      recommended_version,
      blocked_versions,
      sunset_dates,
    } = body;

    // Validate version formats
    const semverRegex = /^\d+\.\d+\.\d+$/;
    if (minimum_version && !semverRegex.test(minimum_version)) {
      return this.jsonResponse({ error: 'Invalid minimum_version format (expected X.Y.Z)' }, 400, corsHeaders);
    }
    if (recommended_version && !semverRegex.test(recommended_version)) {
      return this.jsonResponse({ error: 'Invalid recommended_version format (expected X.Y.Z)' }, 400, corsHeaders);
    }

    const policy = {
      minimum_version: minimum_version || '1.0.0',
      recommended_version: recommended_version || '1.0.0',
      blocked_versions: blocked_versions || [],
      sunset_dates: sunset_dates || {},
    };

    await this.state.storage.put('version_policy', policy);

    this.logger.info('[audit] Version policy updated', {
      action: 'version_policy_updated',
      policy,
    });

    return this.jsonResponse(
      { success: true, policy },
      200,
      corsHeaders
    );
  }

  /**
   * Get the current version policy from storage, or return defaults.
   */
  async getVersionPolicy() {
    const policy = await this.state.storage.get('version_policy');
    return policy || {
      minimum_version: '1.0.0',
      recommended_version: '1.0.0',
      blocked_versions: [],
      sunset_dates: {},
    };
  }

  /**
   * Check a version against the version policy.
   * @param {string} version
   * @param {object} policy
   * @returns {{ blocked: boolean, status: string, reason?: string }}
   */
  checkVersionPolicy(version, policy) {
    // Check blocked list (exact string match, no parsing needed)
    if (policy.blocked_versions && policy.blocked_versions.includes(version)) {
      return {
        blocked: true,
        status: 'blocked',
        reason: `Version ${version} has been blocked`,
      };
    }

    try {
      // Check minimum version
      if (policy.minimum_version && compareVersions(version, policy.minimum_version) < 0) {
        return {
          blocked: true,
          status: 'below_minimum',
          reason: `Version ${version} is below minimum required version ${policy.minimum_version}`,
        };
      }

      // Check if update is recommended
      if (
        policy.recommended_version &&
        compareVersions(version, policy.recommended_version) < 0
      ) {
        return {
          blocked: false,
          status: 'update_recommended',
        };
      }
    } catch (e) {
      // Invalid version format - reject the client
      return {
        blocked: true,
        status: 'invalid_version',
        reason: `Invalid version format: ${version}`,
      };
    }

    return {
      blocked: false,
      status: 'current',
    };
  }

  /**
   * Select random regions from the available critical regions.
   * @param {Array} criticalRegions - Available regions
   * @param {number} count - How many to select
   * @returns {Array} Selected regions
   */
  selectRandomRegions(criticalRegions, count) {
    const available = [...criticalRegions];
    const selected = [];
    const selectCount = Math.min(count, available.length);

    for (let i = 0; i < selectCount; i++) {
      const idx = Math.floor(Math.random() * available.length);
      selected.push(available[idx]);
      available.splice(idx, 1);
    }

    return selected;
  }

  /**
   * Helper to return a JSON response.
   */
  jsonResponse(data, status, corsHeaders) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

