import { describe, it, expect } from 'vitest';
import {
  parseThresholdPolicy,
  verifyThresholdSignatures,
  thresholdAuthErrorResponse,
} from '../../src/middleware/threshold-auth.js';

/**
 * Helper to generate an Ed25519 keypair and return base64 public key.
 */
async function generateOperator() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));
  return { keyPair, publicKeyBase64 };
}

/**
 * Helper to sign a payload with an Ed25519 private key.
 */
async function signPayload(payload, privateKey) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const message = new TextEncoder().encode(canonical);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, message);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

describe('Threshold Auth Middleware', () => {
  describe('parseThresholdPolicy', () => {
    it('should return null when OPERATOR_PUBLIC_KEYS is not set', () => {
      const policy = parseThresholdPolicy({});
      expect(policy).toBeNull();
    });

    it('should return null when OPERATOR_PUBLIC_KEYS is empty string', () => {
      const policy = parseThresholdPolicy({ OPERATOR_PUBLIC_KEYS: '' });
      expect(policy).toBeNull();
    });

    it('should parse single operator key', () => {
      const policy = parseThresholdPolicy({
        OPERATOR_PUBLIC_KEYS: 'key1base64',
      });
      expect(policy).not.toBeNull();
      expect(policy.operatorKeys).toEqual(['key1base64']);
      expect(policy.threshold).toBe(1); // Clamped: min(2, 1) = 1
    });

    it('should parse multiple operator keys', () => {
      const policy = parseThresholdPolicy({
        OPERATOR_PUBLIC_KEYS: 'key1,key2,key3',
      });
      expect(policy).not.toBeNull();
      expect(policy.operatorKeys).toEqual(['key1', 'key2', 'key3']);
      expect(policy.threshold).toBe(2); // Default
    });

    it('should trim whitespace from keys', () => {
      const policy = parseThresholdPolicy({
        OPERATOR_PUBLIC_KEYS: ' key1 , key2 , key3 ',
      });
      expect(policy.operatorKeys).toEqual(['key1', 'key2', 'key3']);
    });

    it('should filter out empty keys', () => {
      const policy = parseThresholdPolicy({
        OPERATOR_PUBLIC_KEYS: 'key1,,key2,',
      });
      expect(policy.operatorKeys).toEqual(['key1', 'key2']);
    });

    it('should use ADMIN_THRESHOLD when configured', () => {
      const policy = parseThresholdPolicy({
        OPERATOR_PUBLIC_KEYS: 'key1,key2,key3,key4,key5',
        ADMIN_THRESHOLD: '3',
      });
      expect(policy.threshold).toBe(3);
    });

    it('should clamp threshold to operator count', () => {
      const policy = parseThresholdPolicy({
        OPERATOR_PUBLIC_KEYS: 'key1,key2',
        ADMIN_THRESHOLD: '5',
      });
      expect(policy.threshold).toBe(2); // Clamped to max operator count
    });

    it('should clamp threshold minimum to 1', () => {
      const policy = parseThresholdPolicy({
        OPERATOR_PUBLIC_KEYS: 'key1,key2,key3',
        ADMIN_THRESHOLD: '0',
      });
      expect(policy.threshold).toBe(1); // Clamped to minimum 1
    });
  });

  describe('verifyThresholdSignatures', () => {
    it('should verify when threshold is met (2-of-3)', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();
      const op3 = await generateOperator();

      const env = {
        OPERATOR_PUBLIC_KEYS: `${op1.publicKeyBase64},${op2.publicKeyBase64},${op3.publicKeyBase64}`,
        ADMIN_THRESHOLD: '2',
      };

      const payload = {
        action: 'test',
        timestamp: Date.now(),
      };

      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op2.keyPair.privateKey);

      const result = await verifyThresholdSignatures(payload, [sig1, sig2], env);
      expect(result.verified).toBe(true);
      expect(result.validCount).toBe(2);
      expect(result.threshold).toBe(2);
      expect(result.operatorCount).toBe(3);
    });

    it('should reject when threshold is not met (1-of-3 needed 2)', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();
      const op3 = await generateOperator();

      const env = {
        OPERATOR_PUBLIC_KEYS: `${op1.publicKeyBase64},${op2.publicKeyBase64},${op3.publicKeyBase64}`,
        ADMIN_THRESHOLD: '2',
      };

      const payload = {
        action: 'test',
        timestamp: Date.now(),
      };

      const sig1 = await signPayload(payload, op1.keyPair.privateKey);

      const result = await verifyThresholdSignatures(payload, [sig1], env);
      expect(result.verified).toBe(false);
      expect(result.validCount).toBe(1);
    });

    it('should not count invalid signatures toward threshold', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();
      const unauthorized = await generateOperator();

      const env = {
        OPERATOR_PUBLIC_KEYS: `${op1.publicKeyBase64},${op2.publicKeyBase64}`,
        ADMIN_THRESHOLD: '2',
      };

      const payload = {
        action: 'test',
        timestamp: Date.now(),
      };

      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      // Second signature is from an unauthorized key
      const sigUnauthorized = await signPayload(payload, unauthorized.keyPair.privateKey);

      const result = await verifyThresholdSignatures(payload, [sig1, sigUnauthorized], env);
      expect(result.verified).toBe(false);
      expect(result.validCount).toBe(1);
    });

    it('should not count duplicate signatures from same key twice', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const env = {
        OPERATOR_PUBLIC_KEYS: `${op1.publicKeyBase64},${op2.publicKeyBase64}`,
        ADMIN_THRESHOLD: '2',
      };

      const payload = {
        action: 'test',
        timestamp: Date.now(),
      };

      // Same operator signs twice
      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op1.keyPair.privateKey);

      const result = await verifyThresholdSignatures(payload, [sig1, sig2], env);
      expect(result.verified).toBe(false);
      expect(result.validCount).toBe(1);
    });

    it('should return error when operator keys are not configured', async () => {
      const result = await verifyThresholdSignatures(
        { action: 'test', timestamp: Date.now() },
        ['some-sig'],
        {}
      );
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Operator keys not configured');
    });

    it('should return error when no signatures are provided', async () => {
      const op1 = await generateOperator();
      const env = {
        OPERATOR_PUBLIC_KEYS: op1.publicKeyBase64,
        ADMIN_THRESHOLD: '1',
      };

      const result = await verifyThresholdSignatures(
        { action: 'test', timestamp: Date.now() },
        [],
        env
      );
      expect(result.verified).toBe(false);
      expect(result.error).toBe('No signatures provided');
    });

    it('should return error when signatures is null', async () => {
      const op1 = await generateOperator();
      const env = {
        OPERATOR_PUBLIC_KEYS: op1.publicKeyBase64,
        ADMIN_THRESHOLD: '1',
      };

      const result = await verifyThresholdSignatures(
        { action: 'test', timestamp: Date.now() },
        null,
        env
      );
      expect(result.verified).toBe(false);
      expect(result.error).toBe('No signatures provided');
    });

    it('should accept threshold override via options', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();
      const op3 = await generateOperator();

      const env = {
        OPERATOR_PUBLIC_KEYS: `${op1.publicKeyBase64},${op2.publicKeyBase64},${op3.publicKeyBase64}`,
        ADMIN_THRESHOLD: '3', // Default requires all 3
      };

      const payload = {
        action: 'test',
        timestamp: Date.now(),
      };

      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op2.keyPair.privateKey);

      // Override threshold to 2
      const result = await verifyThresholdSignatures(payload, [sig1, sig2], env, { threshold: 2 });
      expect(result.verified).toBe(true);
      expect(result.validCount).toBe(2);
    });

    it('should verify 3-of-5 threshold correctly', async () => {
      const operators = [];
      for (let i = 0; i < 5; i++) {
        operators.push(await generateOperator());
      }

      const env = {
        OPERATOR_PUBLIC_KEYS: operators.map(op => op.publicKeyBase64).join(','),
        ADMIN_THRESHOLD: '3',
      };

      const payload = {
        action: 'critical-operation',
        timestamp: Date.now(),
      };

      // 3 of 5 sign
      const sig1 = await signPayload(payload, operators[0].keyPair.privateKey);
      const sig2 = await signPayload(payload, operators[2].keyPair.privateKey);
      const sig3 = await signPayload(payload, operators[4].keyPair.privateKey);

      const result = await verifyThresholdSignatures(payload, [sig1, sig2, sig3], env);
      expect(result.verified).toBe(true);
      expect(result.validCount).toBe(3);
      expect(result.threshold).toBe(3);
      expect(result.operatorCount).toBe(5);
    });

    it('should reject 2-of-5 when threshold is 3', async () => {
      const operators = [];
      for (let i = 0; i < 5; i++) {
        operators.push(await generateOperator());
      }

      const env = {
        OPERATOR_PUBLIC_KEYS: operators.map(op => op.publicKeyBase64).join(','),
        ADMIN_THRESHOLD: '3',
      };

      const payload = {
        action: 'critical-operation',
        timestamp: Date.now(),
      };

      const sig1 = await signPayload(payload, operators[0].keyPair.privateKey);
      const sig2 = await signPayload(payload, operators[2].keyPair.privateKey);

      const result = await verifyThresholdSignatures(payload, [sig1, sig2], env);
      expect(result.verified).toBe(false);
      expect(result.validCount).toBe(2);
    });

    it('should handle malformed signature gracefully', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const env = {
        OPERATOR_PUBLIC_KEYS: `${op1.publicKeyBase64},${op2.publicKeyBase64}`,
        ADMIN_THRESHOLD: '1',
      };

      const payload = {
        action: 'test',
        timestamp: Date.now(),
      };

      const result = await verifyThresholdSignatures(
        payload,
        ['not-valid-base64!!!'],
        env
      );
      expect(result.verified).toBe(false);
      expect(result.validCount).toBe(0);
    });

    it('should reject signatures with stale timestamp', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const env = {
        OPERATOR_PUBLIC_KEYS: `${op1.publicKeyBase64},${op2.publicKeyBase64}`,
        ADMIN_THRESHOLD: '2',
      };

      const payload = {
        action: 'test',
        timestamp: Date.now() - (6 * 60 * 1000), // 6 minutes ago
      };

      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op2.keyPair.privateKey);

      const result = await verifyThresholdSignatures(payload, [sig1, sig2], env);
      expect(result.verified).toBe(false);
    });

    it('should reject signatures without timestamp', async () => {
      const op1 = await generateOperator();
      const op2 = await generateOperator();

      const env = {
        OPERATOR_PUBLIC_KEYS: `${op1.publicKeyBase64},${op2.publicKeyBase64}`,
        ADMIN_THRESHOLD: '2',
      };

      const payload = {
        action: 'test',
        // No timestamp
      };

      const sig1 = await signPayload(payload, op1.keyPair.privateKey);
      const sig2 = await signPayload(payload, op2.keyPair.privateKey);

      const result = await verifyThresholdSignatures(payload, [sig1, sig2], env);
      expect(result.verified).toBe(false);
    });
  });

  describe('thresholdAuthErrorResponse', () => {
    it('should return 503 when operator keys not configured', () => {
      const result = {
        verified: false,
        validCount: 0,
        threshold: 0,
        operatorCount: 0,
        error: 'Operator keys not configured',
      };

      const response = thresholdAuthErrorResponse(result, {});
      expect(response.status).toBe(503);
    });

    it('should return 403 when insufficient signatures', async () => {
      const result = {
        verified: false,
        validCount: 1,
        threshold: 2,
        operatorCount: 3,
      };

      const response = thresholdAuthErrorResponse(result, {});
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.validSignatures).toBe(1);
      expect(body.requiredSignatures).toBe(2);
      expect(body.totalOperators).toBe(3);
    });
  });
});
