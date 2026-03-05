/**
 * Unit tests for the GitHub REST API client module.
 *
 * Tests issue creation, updates, search, and graceful error handling
 * when the GitHub API is unavailable or returns errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildIssueBody,
  buildLabels,
  createGitHubIssue,
  updateExistingIssue,
  searchExistingIssues,
} from '../../src/github-client.js';
import type { Env, ErrorCluster, AiAnalysis } from '../../src/types.js';

// ─────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────

function makeCluster(overrides: Partial<ErrorCluster> = {}): ErrorCluster {
  return {
    errorSignature: 'network:websocket_connection_failed',
    category: 'network',
    totalCount: 25,
    versions: ['1.3.0'],
    platforms: ['android'],
    sampleMessages: [
      'WebSocket connection failed: ETIMEDOUT',
      'WebSocket handshake timeout',
    ],
    sampleStackTraces: [
      'at WebSocketService.connect (ws.dart:88)',
    ],
    firstSeen: Date.now() - 7200000,
    lastSeen: Date.now() - 300000,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AiAnalysis> = {}): AiAnalysis {
  return {
    title: 'WebSocket connection fails with ETIMEDOUT',
    severity: 'high',
    component: 'network',
    description: 'WebSocket connections are timing out, likely due to server overload or network issues.',
    reproductionHints: 'Connect to a VPS with high latency.',
    suggestedFix: 'Add exponential backoff for WebSocket reconnection.',
    isRegression: false,
    affectedUsersEstimate: 'some',
    ...overrides,
  };
}

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    REPORTS_BUCKET: {} as R2Bucket,
    AI: {} as Ai,
    GITHUB_TOKEN: 'ghp_test_token_123',
    GITHUB_REPO: 'owner/repo',
  };
}

// ─────────────────────────────────────────────
// Global fetch mock management
// ─────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Reset fetch mock before each test
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─────────────────────────────────────────────
// buildIssueBody tests
// ─────────────────────────────────────────────

describe('buildIssueBody', () => {
  it('includes AI analysis fields when available', () => {
    const cluster = makeCluster();
    const analysis = makeAnalysis();
    const body = buildIssueBody(cluster, analysis, '15 minutes');

    expect(body).toContain('**Severity:** high');
    expect(body).toContain('**Component:** network');
    expect(body).toContain('WebSocket connections are timing out');
    expect(body).toContain('Add exponential backoff');
    expect(body).toContain('Connect to a VPS with high latency');
  });

  it('uses fallback text when AI analysis is null', () => {
    const cluster = makeCluster();
    const body = buildIssueBody(cluster, null, '15 minutes');

    expect(body).toContain('**Severity:** unknown');
    expect(body).toContain('AI analysis was not available');
    expect(body).toContain('No reproduction hints available');
    expect(body).toContain('No suggested fix available');
  });

  it('includes error signature', () => {
    const cluster = makeCluster();
    const body = buildIssueBody(cluster, null, '15 minutes');

    expect(body).toContain('`network:websocket_connection_failed`');
  });

  it('includes version and platform information', () => {
    const cluster = makeCluster();
    const body = buildIssueBody(cluster, makeAnalysis(), '2 hours');

    expect(body).toContain('1.3.0');
    expect(body).toContain('android');
    expect(body).toContain('25 in last 2 hours');
  });

  it('includes sample error messages in details block', () => {
    const cluster = makeCluster();
    const body = buildIssueBody(cluster, null, '15 minutes');

    expect(body).toContain('<details>');
    expect(body).toContain('Sample Error Messages (2 samples)');
    expect(body).toContain('WebSocket connection failed: ETIMEDOUT');
  });

  it('includes auto-generation footer', () => {
    const cluster = makeCluster();
    const body = buildIssueBody(cluster, null, '15 minutes');

    expect(body).toContain('automatically created by the Zajel AI log analyzer');
  });
});

// ─────────────────────────────────────────────
// buildLabels tests
// ─────────────────────────────────────────────

describe('buildLabels', () => {
  it('includes ai-detected label always', () => {
    const labels = buildLabels(null, 'network');
    expect(labels).toContain('ai-detected');
  });

  it('includes severity and component from analysis', () => {
    const analysis = makeAnalysis({ severity: 'critical', component: 'crypto' });
    const labels = buildLabels(analysis, 'network');

    expect(labels).toContain('ai-detected');
    expect(labels).toContain('critical');
    expect(labels).toContain('crypto');
  });

  it('falls back to category when analysis is null', () => {
    const labels = buildLabels(null, 'storage');

    expect(labels).toContain('ai-detected');
    expect(labels).toContain('storage');
    expect(labels).not.toContain('medium');
  });
});

// ─────────────────────────────────────────────
// createGitHubIssue tests
// ─────────────────────────────────────────────

describe('createGitHubIssue', () => {
  it('creates issue with correct labels and body', async () => {
    const env = makeEnv();
    const cluster = makeCluster();
    const analysis = makeAnalysis();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          number: 42,
          html_url: 'https://github.com/owner/repo/issues/42',
        }),
    });
    globalThis.fetch = fetchMock;

    const result = await createGitHubIssue(env, cluster, analysis, '15 minutes');

    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(42);
    expect(result!.issueUrl).toBe('https://github.com/owner/repo/issues/42');

    // Verify fetch was called correctly
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.github.com/repos/owner/repo/issues');
    expect(options.method).toBe('POST');

    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('token ghp_test_token_123');
    expect(headers['Accept']).toBe('application/vnd.github.v3+json');

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body['title']).toBe('WebSocket connection fails with ETIMEDOUT');
    expect(body['labels']).toEqual(['ai-detected', 'high', 'network']);
    expect(body['body']).toContain('AI-Detected Issue');
  });

  it('uses fallback title when analysis is null', async () => {
    const env = makeEnv();
    const cluster = makeCluster();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          number: 43,
          html_url: 'https://github.com/owner/repo/issues/43',
        }),
    });
    globalThis.fetch = fetchMock;

    await createGitHubIssue(env, cluster, null, '15 minutes');

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body['title']).toBe('[network] network:websocket_connection_failed');
  });

  it('returns null when GitHub API returns error', async () => {
    const env = makeEnv();
    const cluster = makeCluster();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Validation Failed'),
    });

    const result = await createGitHubIssue(env, cluster, makeAnalysis(), '15 minutes');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (graceful degradation)', async () => {
    const env = makeEnv();
    const cluster = makeCluster();

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await createGitHubIssue(env, cluster, makeAnalysis(), '15 minutes');
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────
// updateExistingIssue tests
// ─────────────────────────────────────────────

describe('updateExistingIssue', () => {
  it('adds comment to existing issue', async () => {
    const env = makeEnv();
    const cluster = makeCluster();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock;

    await updateExistingIssue(env, 42, cluster, false);

    // Should only create a comment (no PATCH to reopen)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues/42/comments');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body['body']).toContain('Updated Error Occurrences');
    expect(body['body']).toContain('25 occurrences');
  });

  it('reopens issue when shouldReopen is true', async () => {
    const env = makeEnv();
    const cluster = makeCluster();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock;

    await updateExistingIssue(env, 42, cluster, true);

    // Should create comment AND reopen
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [reopenUrl, reopenOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(reopenUrl).toBe('https://api.github.com/repos/owner/repo/issues/42');
    expect(reopenOptions.method).toBe('PATCH');

    const body = JSON.parse(reopenOptions.body as string) as Record<string, unknown>;
    expect(body['state']).toBe('open');
  });

  it('handles API failure gracefully (no throw)', async () => {
    const env = makeEnv();
    const cluster = makeCluster();

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    // Should not throw
    await updateExistingIssue(env, 42, cluster, false);
  });
});

// ─────────────────────────────────────────────
// searchExistingIssues tests
// ─────────────────────────────────────────────

describe('searchExistingIssues', () => {
  it('returns issue number and state when found', async () => {
    const env = makeEnv();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          total_count: 1,
          items: [{ number: 99, state: 'open' }],
        }),
    });

    const result = await searchExistingIssues(env, 'crypto:key_exchange_failed');
    expect(result).not.toBeNull();
    expect(result!.number).toBe(99);
    expect(result!.state).toBe('open');
  });

  it('returns null when no issues found', async () => {
    const env = makeEnv();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ total_count: 0, items: [] }),
    });

    const result = await searchExistingIssues(env, 'nonexistent:signature');
    expect(result).toBeNull();
  });

  it('returns null when GitHub API returns error', async () => {
    const env = makeEnv();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    const result = await searchExistingIssues(env, 'some:signature');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (graceful degradation)', async () => {
    const env = makeEnv();

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await searchExistingIssues(env, 'some:signature');
    expect(result).toBeNull();
  });

  it('searches with correct query parameters', async () => {
    const env = makeEnv();
    env.GITHUB_REPO = 'myorg/myrepo';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ total_count: 0, items: [] }),
    });
    globalThis.fetch = fetchMock;

    await searchExistingIssues(env, 'test:signature');

    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain('/search/issues');
    expect(url).toContain('myorg%2Fmyrepo');
    expect(url).toContain('test%3Asignature');
    expect(url).toContain('ai-detected');
  });
});
