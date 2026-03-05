/**
 * GitHub REST API v3 client for issue creation and management.
 *
 * Creates issues from AI analysis, updates existing issues with
 * new occurrence data, and searches for duplicates.
 */

import type { Env, ErrorCluster, AiAnalysis, GitHubIssueResult } from './types.js';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Build the issue body markdown from an error cluster and optional AI analysis.
 */
export function buildIssueBody(
  cluster: ErrorCluster,
  analysis: AiAnalysis | null,
  timeWindow: string,
): string {
  const now = new Date().toISOString();
  const severity = analysis?.severity ?? 'unknown';
  const component = analysis?.component ?? cluster.category;
  const description = analysis?.description ?? 'AI analysis was not available for this error cluster.';
  const reproductionHints = analysis?.reproductionHints ?? 'No reproduction hints available.';
  const suggestedFix = analysis?.suggestedFix ?? 'No suggested fix available.';
  const affectedEstimate = analysis?.affectedUsersEstimate ?? 'unknown';

  const sampleSection = cluster.sampleMessages
    .map((msg, i) => `**${i + 1}.** \`${msg}\``)
    .join('\n');

  return `## AI-Detected Issue

**Severity:** ${severity}
**Component:** ${component}
**Detection Time:** ${now}
**Error Signature:** \`${cluster.errorSignature}\`

## Analysis

${description}

## Affected Scope

- **Versions:** ${cluster.versions.join(', ')}
- **Platforms:** ${cluster.platforms.join(', ')}
- **Estimated Impact:** ${affectedEstimate}
- **Occurrences:** ${cluster.totalCount} in last ${timeWindow}

## Reproduction Hints

${reproductionHints}

## Suggested Fix

${suggestedFix}

## Scrubbed Log Excerpts

<details>
<summary>Sample Error Messages (${cluster.sampleMessages.length} samples)</summary>

${sampleSection}

</details>

---
*This issue was automatically created by the Zajel AI log analyzer.*
*Error signature: \`${cluster.errorSignature}\`*`;
}

/**
 * Build the labels array for a GitHub issue.
 */
export function buildLabels(analysis: AiAnalysis | null, category: string): string[] {
  const labels = ['ai-detected'];
  if (analysis) {
    labels.push(analysis.severity);
    labels.push(analysis.component);
  } else {
    labels.push(category);
  }
  return labels;
}

/**
 * Make an authenticated request to the GitHub REST API.
 */
async function githubFetch(
  env: Env,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${GITHUB_API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `token ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'zajel-log-processor',
    'Content-Type': 'application/json',
  };

  return fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * Search for existing GitHub issues by error signature.
 *
 * Searches issue bodies for the signature string within the repository.
 * Returns the first matching issue number and state, or null if none found.
 */
export async function searchExistingIssues(
  env: Env,
  signature: string,
): Promise<{ number: number; state: string } | null> {
  try {
    const query = encodeURIComponent(
      `repo:${env.GITHUB_REPO} "${signature}" in:body label:ai-detected`,
    );
    const response = await githubFetch(
      env,
      `/search/issues?q=${query}&per_page=1`,
      { method: 'GET' },
    );

    if (!response.ok) {
      console.error(
        `GitHub search API returned ${response.status}: ${response.statusText}`,
      );
      return null;
    }

    const data = (await response.json()) as {
      total_count: number;
      items: Array<{ number: number; state: string }>;
    };

    if (data.total_count > 0 && data.items[0]) {
      return {
        number: data.items[0].number,
        state: data.items[0].state,
      };
    }

    return null;
  } catch (error) {
    console.error('GitHub issue search failed:', error);
    return null;
  }
}

/**
 * Create a new GitHub issue from an error cluster and AI analysis.
 *
 * Returns the issue number and URL, or null if creation fails.
 */
export async function createGitHubIssue(
  env: Env,
  cluster: ErrorCluster,
  analysis: AiAnalysis | null,
  timeWindow: string,
): Promise<GitHubIssueResult | null> {
  try {
    const title = analysis?.title ?? `[${cluster.category}] ${cluster.errorSignature.substring(0, 60)}`;
    const body = buildIssueBody(cluster, analysis, timeWindow);
    const labels = buildLabels(analysis, cluster.category);

    const response = await githubFetch(
      env,
      `/repos/${env.GITHUB_REPO}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          body,
          labels,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `GitHub issue creation failed (${response.status}): ${errorText}`,
      );
      return null;
    }

    const data = (await response.json()) as {
      number: number;
      html_url: string;
    };

    return {
      issueNumber: data.number,
      issueUrl: data.html_url,
    };
  } catch (error) {
    console.error('GitHub issue creation failed:', error);
    return null;
  }
}

/**
 * Update an existing GitHub issue with a comment about new occurrences.
 *
 * If the issue is closed and the cluster exceeds the reopen threshold,
 * the issue is reopened.
 */
export async function updateExistingIssue(
  env: Env,
  issueNumber: number,
  cluster: ErrorCluster,
  shouldReopen: boolean,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const commentBody = `## Updated Error Occurrences

**Time:** ${now}
**New Total:** ${cluster.totalCount} occurrences
**Versions:** ${cluster.versions.join(', ')}
**Platforms:** ${cluster.platforms.join(', ')}

This error signature continues to appear in diagnostic reports.

---
*Automated update by Zajel AI log analyzer.*`;

    // Add a comment
    const commentResponse = await githubFetch(
      env,
      `/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body: commentBody }),
      },
    );

    if (!commentResponse.ok) {
      console.error(
        `GitHub comment creation failed (${commentResponse.status})`,
      );
    }

    // Reopen the issue if needed
    if (shouldReopen) {
      const reopenResponse = await githubFetch(
        env,
        `/repos/${env.GITHUB_REPO}/issues/${issueNumber}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ state: 'open' }),
        },
      );

      if (!reopenResponse.ok) {
        console.error(
          `GitHub issue reopen failed (${reopenResponse.status})`,
        );
      }
    }
  } catch (error) {
    console.error('GitHub issue update failed:', error);
  }
}
