/**
 * Unit tests for the Workers AI analyzer module.
 *
 * Tests prompt building, response parsing, and graceful degradation
 * when the AI service is unavailable or returns malformed output.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildPrompt, parseAiResponse, analyzeWithAi } from '../../src/ai-analyzer.js';
import type { Env, ErrorCluster } from '../../src/types.js';

// ─────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────

function makeCluster(overrides: Partial<ErrorCluster> = {}): ErrorCluster {
  return {
    errorSignature: 'crypto:x25519_key_exchange_failed',
    category: 'crypto',
    totalCount: 42,
    versions: ['1.2.0', '1.2.1'],
    platforms: ['android', 'ios'],
    sampleMessages: [
      'X25519 key exchange failed: invalid public key length',
      'Key exchange timeout after 5000ms',
    ],
    sampleStackTraces: [
      'at CryptoService.performKeyExchange (crypto_service.dart:123)\nat PeerConnection.establish (peer.dart:45)',
    ],
    firstSeen: Date.now() - 3600000,
    lastSeen: Date.now() - 60000,
    ...overrides,
  };
}

const VALID_AI_RESPONSE = JSON.stringify({
  title: 'X25519 key exchange fails with invalid public key length',
  severity: 'high',
  component: 'crypto',
  description: 'The X25519 key exchange is failing due to invalid public key length. This suggests a key encoding issue.',
  reproduction_hints: 'Try initiating a P2P connection between two devices with different app versions.',
  suggested_fix: 'Validate public key length before attempting key exchange. Expected length is 32 bytes.',
  is_regression: false,
  affected_users_estimate: 'some',
});

// ─────────────────────────────────────────────
// buildPrompt tests
// ─────────────────────────────────────────────

describe('buildPrompt', () => {
  it('includes error signature in prompt', () => {
    const cluster = makeCluster();
    const prompt = buildPrompt(cluster, '15 minutes');
    expect(prompt).toContain('crypto:x25519_key_exchange_failed');
  });

  it('includes category in prompt', () => {
    const cluster = makeCluster();
    const prompt = buildPrompt(cluster, '15 minutes');
    expect(prompt).toContain('Category: crypto');
  });

  it('includes total count and time window', () => {
    const cluster = makeCluster({ totalCount: 100 });
    const prompt = buildPrompt(cluster, '2 hours');
    expect(prompt).toContain('Total Occurrences: 100 in last 2 hours');
  });

  it('includes versions and platforms', () => {
    const cluster = makeCluster();
    const prompt = buildPrompt(cluster, '15 minutes');
    expect(prompt).toContain('1.2.0, 1.2.1');
    expect(prompt).toContain('android, ios');
  });

  it('includes sample messages', () => {
    const cluster = makeCluster();
    const prompt = buildPrompt(cluster, '15 minutes');
    expect(prompt).toContain('X25519 key exchange failed: invalid public key length');
    expect(prompt).toContain('Key exchange timeout after 5000ms');
  });

  it('includes stack traces when available', () => {
    const cluster = makeCluster();
    const prompt = buildPrompt(cluster, '15 minutes');
    expect(prompt).toContain('CryptoService.performKeyExchange');
  });

  it('handles empty stack traces', () => {
    const cluster = makeCluster({ sampleStackTraces: [] });
    const prompt = buildPrompt(cluster, '15 minutes');
    expect(prompt).toContain('No stack traces available');
  });

  it('includes expected JSON schema in prompt', () => {
    const cluster = makeCluster();
    const prompt = buildPrompt(cluster, '15 minutes');
    expect(prompt).toContain('"severity": "critical|high|medium|low"');
    expect(prompt).toContain('"component"');
    expect(prompt).toContain('"is_regression"');
  });
});

// ─────────────────────────────────────────────
// parseAiResponse tests
// ─────────────────────────────────────────────

describe('parseAiResponse', () => {
  it('parses valid JSON response', () => {
    const result = parseAiResponse(VALID_AI_RESPONSE);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('X25519 key exchange fails with invalid public key length');
    expect(result!.severity).toBe('high');
    expect(result!.component).toBe('crypto');
    expect(result!.isRegression).toBe(false);
    expect(result!.affectedUsersEstimate).toBe('some');
  });

  it('parses JSON wrapped in markdown code block', () => {
    const wrapped = '```json\n' + VALID_AI_RESPONSE + '\n```';
    const result = parseAiResponse(wrapped);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('parses JSON wrapped in plain code block', () => {
    const wrapped = '```\n' + VALID_AI_RESPONSE + '\n```';
    const result = parseAiResponse(wrapped);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('returns null for malformed JSON', () => {
    const result = parseAiResponse('This is not JSON at all');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = parseAiResponse('');
    expect(result).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const partial = JSON.stringify({
      title: 'Test',
      severity: 'high',
      // missing component, description, etc.
    });
    const result = parseAiResponse(partial);
    expect(result).toBeNull();
  });

  it('returns null for invalid severity value', () => {
    const invalid = JSON.stringify({
      ...JSON.parse(VALID_AI_RESPONSE),
      severity: 'mega-critical',
    });
    const result = parseAiResponse(invalid);
    expect(result).toBeNull();
  });

  it('returns null for invalid component value', () => {
    const invalid = JSON.stringify({
      ...JSON.parse(VALID_AI_RESPONSE),
      component: 'blockchain',
    });
    const result = parseAiResponse(invalid);
    expect(result).toBeNull();
  });

  it('returns null for invalid affected_users_estimate', () => {
    const invalid = JSON.stringify({
      ...JSON.parse(VALID_AI_RESPONSE),
      affected_users_estimate: 'everyone',
    });
    const result = parseAiResponse(invalid);
    expect(result).toBeNull();
  });

  it('returns null when is_regression is not boolean', () => {
    const invalid = JSON.stringify({
      ...JSON.parse(VALID_AI_RESPONSE),
      is_regression: 'yes',
    });
    const result = parseAiResponse(invalid);
    expect(result).toBeNull();
  });

  it('truncates titles longer than 80 characters', () => {
    const longTitle = 'A'.repeat(100);
    const data = JSON.stringify({
      ...JSON.parse(VALID_AI_RESPONSE),
      title: longTitle,
    });
    const result = parseAiResponse(data);
    expect(result).not.toBeNull();
    expect(result!.title.length).toBe(80);
    expect(result!.title.endsWith('...')).toBe(true);
  });

  it('returns null for non-object JSON', () => {
    const result = parseAiResponse('"just a string"');
    expect(result).toBeNull();
  });

  it('returns null for array JSON', () => {
    const result = parseAiResponse('[1, 2, 3]');
    expect(result).toBeNull();
  });

  it('returns null for empty title', () => {
    const invalid = JSON.stringify({
      ...JSON.parse(VALID_AI_RESPONSE),
      title: '',
    });
    const result = parseAiResponse(invalid);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────
// analyzeWithAi tests
// ─────────────────────────────────────────────

describe('analyzeWithAi', () => {
  function makeEnv(aiRunResult: unknown, shouldThrow = false): Env {
    return {
      DB: {} as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {
        run: shouldThrow
          ? vi.fn().mockRejectedValue(new Error('AI service unavailable'))
          : vi.fn().mockResolvedValue(aiRunResult),
      } as unknown as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };
  }

  it('returns parsed analysis from valid AI response', async () => {
    const env = makeEnv({ response: VALID_AI_RESPONSE });
    const cluster = makeCluster();

    const { analysis, tokensUsed } = await analyzeWithAi(env, cluster, '15 minutes');

    expect(analysis).not.toBeNull();
    expect(analysis!.title).toBe('X25519 key exchange fails with invalid public key length');
    expect(analysis!.severity).toBe('high');
    expect(analysis!.component).toBe('crypto');
    expect(tokensUsed).toBe(0); // No usage metadata in mock
  });

  it('extracts token usage from response metadata', async () => {
    const env = makeEnv({
      response: VALID_AI_RESPONSE,
      usage: { prompt_tokens: 500, completion_tokens: 200 },
    });
    const cluster = makeCluster();

    const { tokensUsed } = await analyzeWithAi(env, cluster, '15 minutes');
    expect(tokensUsed).toBe(700);
  });

  it('handles string response format', async () => {
    const env = makeEnv(VALID_AI_RESPONSE);
    const cluster = makeCluster();

    const { analysis } = await analyzeWithAi(env, cluster, '15 minutes');
    expect(analysis).not.toBeNull();
    expect(analysis!.severity).toBe('high');
  });

  it('returns null analysis for malformed AI response (graceful degradation)', async () => {
    const env = makeEnv({ response: 'I cannot analyze this error.' });
    const cluster = makeCluster();

    const { analysis } = await analyzeWithAi(env, cluster, '15 minutes');
    expect(analysis).toBeNull();
  });

  it('returns null analysis when AI service fails (graceful degradation)', async () => {
    const env = makeEnv(null, true);
    const cluster = makeCluster();

    const { analysis, tokensUsed } = await analyzeWithAi(env, cluster, '15 minutes');
    expect(analysis).toBeNull();
    expect(tokensUsed).toBe(0);
  });

  it('handles unexpected response format', async () => {
    const env = makeEnv({ data: 'something unexpected' });
    const cluster = makeCluster();

    const { analysis } = await analyzeWithAi(env, cluster, '15 minutes');
    expect(analysis).toBeNull();
  });

  it('calls AI with correct model', async () => {
    const runMock = vi.fn().mockResolvedValue({ response: VALID_AI_RESPONSE });
    const env: Env = {
      DB: {} as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: { run: runMock } as unknown as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };
    const cluster = makeCluster();

    await analyzeWithAi(env, cluster, '15 minutes');

    expect(runMock).toHaveBeenCalledWith(
      '@cf/meta/llama-3.1-8b-instruct',
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
        ]),
        max_tokens: 512,
      }),
    );
  });
});
