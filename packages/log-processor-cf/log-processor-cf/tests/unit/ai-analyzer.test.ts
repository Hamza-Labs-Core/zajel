/**
 * Unit tests for the AI analyzer module.
 *
 * Tests prompt building, JSON response parsing (including malformed
 * and markdown-wrapped responses), and the full analyzeErrorCluster
 * flow with mock Workers AI.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  parseAiResponse,
  analyzeErrorCluster,
} from '../../src/ai-analyzer.js';
import type { Env, ErrorCluster } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCluster(overrides: Partial<ErrorCluster> = {}): ErrorCluster {
  return {
    errorSignature: 'sig_abc123',
    category: 'crypto',
    totalCount: 15,
    appVersions: '1.0.0,1.0.1',
    platforms: 'android,ios',
    sampleMessage: 'ChaCha20 decryption failed: bad tag',
    sampleStackTrace: 'at decrypt (crypto.dart:42)\nat handleMessage (protocol.dart:100)',
    firstSeen: 1700000000000,
    lastSeen: 1700003600000,
    ...overrides,
  };
}

const VALID_AI_RESPONSE = JSON.stringify({
  title: 'ChaCha20 decryption failure on incoming messages',
  severity: 'high',
  component: 'crypto',
  description: 'The ChaCha20-Poly1305 AEAD decryption is failing due to an authentication tag mismatch.',
  reproduction_hints: 'Send a message between two peers with mismatched session keys.',
  suggested_fix: 'Verify session key derivation uses the correct HKDF salt.',
  is_regression: false,
  affected_users_estimate: 'some',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildPrompt', () => {
  it('includes error signature and category', () => {
    const cluster = makeCluster();
    const prompt = buildPrompt(cluster);

    expect(prompt).toContain('sig_abc123');
    expect(prompt).toContain('crypto');
    expect(prompt).toContain('ChaCha20 decryption failed');
    expect(prompt).toContain('1.0.0,1.0.1');
    expect(prompt).toContain('android,ios');
  });

  it('includes the stack trace', () => {
    const cluster = makeCluster();
    const prompt = buildPrompt(cluster);

    expect(prompt).toContain('crypto.dart:42');
    expect(prompt).toContain('protocol.dart:100');
  });
});

describe('parseAiResponse', () => {
  it('parses valid JSON response', () => {
    const result = parseAiResponse(VALID_AI_RESPONSE);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('ChaCha20 decryption failure on incoming messages');
    expect(result!.severity).toBe('high');
    expect(result!.component).toBe('crypto');
    expect(result!.isRegression).toBe(false);
    expect(result!.affectedUsersEstimate).toBe('some');
  });

  it('parses markdown-wrapped JSON (```json ... ```)', () => {
    const wrapped = '```json\n' + VALID_AI_RESPONSE + '\n```';
    const result = parseAiResponse(wrapped);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('ChaCha20 decryption failure on incoming messages');
    expect(result!.severity).toBe('high');
  });

  it('parses markdown-wrapped JSON without language tag', () => {
    const wrapped = '```\n' + VALID_AI_RESPONSE + '\n```';
    const result = parseAiResponse(wrapped);

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('returns null for completely invalid JSON', () => {
    const result = parseAiResponse('This is not JSON at all.');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = parseAiResponse('');
    expect(result).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const incomplete = JSON.stringify({
      title: 'Some title',
      // missing severity, component, description
    });
    const result = parseAiResponse(incomplete);
    expect(result).toBeNull();
  });

  it('returns null for invalid severity value', () => {
    const badSeverity = JSON.stringify({
      title: 'Test',
      severity: 'extreme',
      component: 'crypto',
      description: 'Some description',
    });
    const result = parseAiResponse(badSeverity);
    expect(result).toBeNull();
  });

  it('defaults affected_users_estimate to "few" if invalid', () => {
    const response = JSON.stringify({
      title: 'Test',
      severity: 'low',
      component: 'ui',
      description: 'Some description',
      reproduction_hints: '',
      suggested_fix: '',
      is_regression: false,
      affected_users_estimate: 'everyone',
    });
    const result = parseAiResponse(response);

    expect(result).not.toBeNull();
    expect(result!.affectedUsersEstimate).toBe('few');
  });

  it('defaults is_regression to false if not boolean', () => {
    const response = JSON.stringify({
      title: 'Test',
      severity: 'low',
      component: 'ui',
      description: 'A description',
      is_regression: 'maybe',
    });
    const result = parseAiResponse(response);

    expect(result).not.toBeNull();
    expect(result!.isRegression).toBe(false);
  });
});

describe('analyzeErrorCluster', () => {
  it('returns parsed analysis from AI response', async () => {
    const mockAI = {
      async run() {
        return { response: VALID_AI_RESPONSE };
      },
    };

    const env = {
      AI: mockAI,
      DB: {} as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPO: 'test/repo',
    } as unknown as Env;

    const cluster = makeCluster();
    const { analysis, tokensUsed } = await analyzeErrorCluster(env, cluster);

    expect(analysis).not.toBeNull();
    expect(analysis!.title).toBe('ChaCha20 decryption failure on incoming messages');
    expect(analysis!.severity).toBe('high');
    expect(tokensUsed).toBeGreaterThan(0);
  });

  it('returns null analysis when AI returns empty string', async () => {
    const mockAI = {
      async run() {
        return { response: '' };
      },
    };

    const env = {
      AI: mockAI,
      DB: {} as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPO: 'test/repo',
    } as unknown as Env;

    const cluster = makeCluster();
    const { analysis, tokensUsed } = await analyzeErrorCluster(env, cluster);

    expect(analysis).toBeNull();
    expect(tokensUsed).toBe(0);
  });

  it('returns null analysis when AI throws error (graceful degradation)', async () => {
    const mockAI = {
      async run() {
        throw new Error('AI service unavailable');
      },
    };

    const env = {
      AI: mockAI,
      DB: {} as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPO: 'test/repo',
    } as unknown as Env;

    const cluster = makeCluster();
    const { analysis, tokensUsed } = await analyzeErrorCluster(env, cluster);

    expect(analysis).toBeNull();
    expect(tokensUsed).toBe(0);
  });

  it('handles AI returning raw string instead of object', async () => {
    const mockAI = {
      async run() {
        return VALID_AI_RESPONSE; // string, not { response: string }
      },
    };

    const env = {
      AI: mockAI,
      DB: {} as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPO: 'test/repo',
    } as unknown as Env;

    const cluster = makeCluster();
    const { analysis } = await analyzeErrorCluster(env, cluster);

    expect(analysis).not.toBeNull();
    expect(analysis!.severity).toBe('high');
  });

  it('returns null analysis when AI returns malformed JSON', async () => {
    const mockAI = {
      async run() {
        return { response: 'Here is my analysis: {broken json' };
      },
    };

    const env = {
      AI: mockAI,
      DB: {} as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPO: 'test/repo',
    } as unknown as Env;

    const cluster = makeCluster();
    const { analysis, tokensUsed } = await analyzeErrorCluster(env, cluster);

    expect(analysis).toBeNull();
    expect(tokensUsed).toBeGreaterThan(0); // tokens were used even though parsing failed
  });
});
