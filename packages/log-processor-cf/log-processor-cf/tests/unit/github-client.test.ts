/**
 * Unit tests for the GitHub client module.
 *
 * Tests issue creation, updating, reopening, and search functionality.
 * Mocks the global fetch to simulate GitHub API responses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createGitHubIssue,
  updateExistingIssue,
  reopenGitHubIssue,
  searchExistingIssues,
  formatIssueBody,
} from '../../src/github-client.js';
import type { AiAnalysis, ErrorCluster } from '../../src/types.js';

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
    sampleStackTrace: 'at decrypt (crypto.dart:42)',
    firstSeen: 1700000000000,
    lastSeen: 1700003600000,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AiAnalysis> = {}): AiAnalysis {
  return {
    title: 'ChaCha20 decryption failure on incoming messages',
    severity: 'high',
    component: 'crypto',
    description: 'The AEAD decryption is failing.',
    reproductionHints: 'Send a message between peers.',
    suggestedFix: 'Check key derivation.',
    isRegression: false,
    affectedUsersEstimate: 'some',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(
  status: number,
  body: Record<string, unknown>,
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatIssueBody', () => {
  it('includes all required sections', () => {
    const cluster = makeCluster();
    const analysis = makeAnalysis();
    const body = formatIssueBody(cluster, analysis);

    expect(body).toContain('## AI-Detected Issue');
    expect(body).toContain('**Severity:** high');
    expect(body).toContain('**Component:** crypto');
    expect(body).toContain('`sig_abc123`');
    expect(body).toContain('## Analysis');
    expect(body).toContain('The AEAD decryption is failing.');
    expect(body).toContain('## Reproduction Hints');
    expect(body).toContain('## Suggested Fix');
    expect(body).toContain('ChaCha20 decryption failed: bad tag');
    expect(body).toContain('Zajel AI log analyzer');
  });

  it('includes version and platform info', () => {
    const cluster = makeCluster();
    const analysis = makeAnalysis();
    const body = formatIssueBody(cluster, analysis);

    expect(body).toContain('1.0.0,1.0.1');
    expect(body).toContain('android,ios');
  });
});

describe('createGitHubIssue', () => {
  it('creates an issue and returns result', async () => {
    globalThis.fetch = mockFetch(201, {
      number: 42,
      html_url: 'https://github.com/test/repo/issues/42',
    });

    const result = await createGitHubIssue(
      'test-token',
      'test/repo',
      makeCluster(),
      makeAnalysis(),
    );

    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(42);
    expect(result!.issueUrl).toBe('https://github.com/test/repo/issues/42');
    expect(result!.action).toBe('created');

    // Verify fetch was called with correct params
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/test/repo/issues');
    expect(options.method).toBe('POST');

    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('token test-token');

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body['title']).toBe('ChaCha20 decryption failure on incoming messages');
    expect(body['labels']).toEqual(['ai-detected', 'high', 'crypto']);
  });

  it('returns null on API failure', async () => {
    globalThis.fetch = mockFetch(403, { message: 'Forbidden' });

    const result = await createGitHubIssue(
      'bad-token',
      'test/repo',
      makeCluster(),
      makeAnalysis(),
    );

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error('Network error'),
    ) as unknown as typeof globalThis.fetch;

    const result = await createGitHubIssue(
      'test-token',
      'test/repo',
      makeCluster(),
      makeAnalysis(),
    );

    expect(result).toBeNull();
  });
});

describe('updateExistingIssue', () => {
  it('adds a comment to existing issue', async () => {
    globalThis.fetch = mockFetch(201, { id: 1 });

    const result = await updateExistingIssue(
      'test-token',
      'test/repo',
      42,
      makeCluster(),
    );

    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(42);
    expect(result!.action).toBe('updated');

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.github.com/repos/test/repo/issues/42/comments');
  });

  it('returns null on API failure', async () => {
    globalThis.fetch = mockFetch(500, { message: 'Server error' });

    const result = await updateExistingIssue(
      'test-token',
      'test/repo',
      42,
      makeCluster(),
    );

    expect(result).toBeNull();
  });
});

describe('reopenGitHubIssue', () => {
  it('reopens issue and adds comment', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: callCount }),
      };
    }) as unknown as typeof globalThis.fetch;

    const result = await reopenGitHubIssue(
      'test-token',
      'test/repo',
      42,
      makeCluster(),
    );

    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(42);
    expect(result!.action).toBe('reopened');

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(2); // PATCH + POST comment

    // First call: PATCH to reopen
    const [patchUrl, patchOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(patchUrl).toBe('https://api.github.com/repos/test/repo/issues/42');
    expect(patchOpts.method).toBe('PATCH');
    const patchBody = JSON.parse(patchOpts.body as string) as Record<string, unknown>;
    expect(patchBody['state']).toBe('open');

    // Second call: POST comment
    const [commentUrl] = fetchMock.mock.calls[1] as [string];
    expect(commentUrl).toBe('https://api.github.com/repos/test/repo/issues/42/comments');
  });

  it('returns null when PATCH fails', async () => {
    globalThis.fetch = mockFetch(403, { message: 'Forbidden' });

    const result = await reopenGitHubIssue(
      'test-token',
      'test/repo',
      42,
      makeCluster(),
    );

    expect(result).toBeNull();
  });
});

describe('searchExistingIssues', () => {
  it('returns issue info when match found', async () => {
    globalThis.fetch = mockFetch(200, {
      items: [
        {
          number: 42,
          html_url: 'https://github.com/test/repo/issues/42',
          state: 'open',
        },
      ],
    });

    const result = await searchExistingIssues(
      'test-token',
      'test/repo',
      'sig_abc123',
    );

    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(42);
    expect(result!.state).toBe('open');
  });

  it('returns null when no matches', async () => {
    globalThis.fetch = mockFetch(200, { items: [] });

    const result = await searchExistingIssues(
      'test-token',
      'test/repo',
      'sig_unknown',
    );

    expect(result).toBeNull();
  });

  it('returns null on API failure', async () => {
    globalThis.fetch = mockFetch(403, { message: 'Rate limited' });

    const result = await searchExistingIssues(
      'test-token',
      'test/repo',
      'sig_abc123',
    );

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error('Network error'),
    ) as unknown as typeof globalThis.fetch;

    const result = await searchExistingIssues(
      'test-token',
      'test/repo',
      'sig_abc123',
    );

    expect(result).toBeNull();
  });
});
