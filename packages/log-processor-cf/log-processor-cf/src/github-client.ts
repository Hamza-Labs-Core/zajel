/**
 * GitHub REST API client for issue creation and management.
 *
 * Uses the GitHub REST API v3 to create issues, update existing issues,
 * search for duplicates, and reopen closed issues. All API calls are
 * wrapped in try/catch for graceful degradation.
 */

import type { AiAnalysis, ErrorCluster, GitHubIssueResult } from './types.js';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Format the issue body using the template from the architecture plan.
 */
export function formatIssueBody(
  cluster: ErrorCluster,
  analysis: AiAnalysis,
): string {
  const now = new Date().toISOString();
  return `## AI-Detected Issue

**Severity:** ${analysis.severity}
**Component:** ${analysis.component}
**Detection Time:** ${now}
**Error Signature:** \`${cluster.errorSignature}\`

## Analysis

${analysis.description}

## Affected Scope

- **Versions:** ${cluster.appVersions}
- **Platforms:** ${cluster.platforms}
- **Estimated Impact:** ${analysis.affectedUsersEstimate}
- **Occurrences:** ${cluster.totalCount} in last processing window
- **Is Regression:** ${analysis.isRegression ? 'Yes' : 'No'}

## Reproduction Hints

${analysis.reproductionHints}

## Suggested Fix

${analysis.suggestedFix}

## Scrubbed Log Excerpts

<details>
<summary>Sample Error Message</summary>

\`\`\`
${cluster.sampleMessage}
\`\`\`

</details>

<details>
<summary>Sample Stack Trace</summary>

\`\`\`
${cluster.sampleStackTrace}
\`\`\`

</details>

---
*This issue was automatically created by the Zajel AI log analyzer.*
*Error signature: \`${cluster.errorSignature}\`*`;
}

/**
 * Create a new GitHub issue.
 *
 * @returns GitHubIssueResult on success, null on failure.
 */
export async function createGitHubIssue(
  token: string,
  repo: string,
  cluster: ErrorCluster,
  analysis: AiAnalysis,
): Promise<GitHubIssueResult | null> {
  try {
    const body = formatIssueBody(cluster, analysis);
    const labels = ['ai-detected', analysis.severity, analysis.component];

    const response = await fetch(`${GITHUB_API_BASE}/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'zajel-log-processor',
      },
      body: JSON.stringify({
        title: analysis.title,
        body,
        labels,
      }),
    });

    if (!response.ok) {
      console.error(
        `GitHub issue creation failed: ${response.status}`,
      );
      return null;
    }

    const data: Record<string, unknown> = await response.json();
    const issueNumber = data['number'] as number;
    const issueUrl = data['html_url'] as string;

    return {
      issueNumber,
      issueUrl,
      action: 'created',
    };
  } catch {
    console.error('GitHub issue creation error');
    return null;
  }
}

/**
 * Update an existing GitHub issue with a comment containing new occurrence data.
 *
 * @returns GitHubIssueResult on success, null on failure.
 */
export async function updateExistingIssue(
  token: string,
  repo: string,
  issueNumber: number,
  cluster: ErrorCluster,
): Promise<GitHubIssueResult | null> {
  try {
    const now = new Date().toISOString();
    const commentBody = `## Updated Occurrence Data

**Time:** ${now}
**Total Occurrences:** ${cluster.totalCount}
**Versions:** ${cluster.appVersions}
**Platforms:** ${cluster.platforms}

This error continues to occur. Latest sample:
\`\`\`
${cluster.sampleMessage}
\`\`\`

---
*Automated update by Zajel AI log analyzer.*`;

    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'zajel-log-processor',
        },
        body: JSON.stringify({ body: commentBody }),
      },
    );

    if (!response.ok) {
      console.error(
        `GitHub issue comment failed: ${response.status}`,
      );
      return null;
    }

    return {
      issueNumber,
      issueUrl: `https://github.com/${repo}/issues/${issueNumber}`,
      action: 'updated',
    };
  } catch {
    console.error('GitHub issue update error');
    return null;
  }
}

/**
 * Reopen a closed GitHub issue and add a comment explaining why.
 *
 * @returns GitHubIssueResult on success, null on failure.
 */
export async function reopenGitHubIssue(
  token: string,
  repo: string,
  issueNumber: number,
  cluster: ErrorCluster,
): Promise<GitHubIssueResult | null> {
  try {
    // Reopen the issue
    const patchResponse = await fetch(
      `${GITHUB_API_BASE}/repos/${repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'zajel-log-processor',
        },
        body: JSON.stringify({ state: 'open' }),
      },
    );

    if (!patchResponse.ok) {
      console.error(
        `GitHub issue reopen failed: ${patchResponse.status}`,
      );
      return null;
    }

    // Add a comment explaining the reopen
    const now = new Date().toISOString();
    const commentBody = `## Issue Reopened — Error Recurrence Detected

**Time:** ${now}
**Total Occurrences:** ${cluster.totalCount}
**Versions:** ${cluster.appVersions}
**Platforms:** ${cluster.platforms}

This error has recurred above the reopen threshold since the issue was closed.

---
*Automated reopen by Zajel AI log analyzer.*`;

    await fetch(
      `${GITHUB_API_BASE}/repos/${repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'zajel-log-processor',
        },
        body: JSON.stringify({ body: commentBody }),
      },
    );

    return {
      issueNumber,
      issueUrl: `https://github.com/${repo}/issues/${issueNumber}`,
      action: 'reopened',
    };
  } catch {
    console.error('GitHub issue reopen error');
    return null;
  }
}

/**
 * Search for existing GitHub issues by error signature.
 * Used as a secondary dedup check against GitHub itself.
 *
 * @returns The issue number if found, null otherwise.
 */
export async function searchExistingIssues(
  token: string,
  repo: string,
  errorSignature: string,
): Promise<{ issueNumber: number; issueUrl: string; state: string } | null> {
  try {
    const query = encodeURIComponent(
      `repo:${repo} "${errorSignature}" in:body label:ai-detected`,
    );
    const response = await fetch(
      `${GITHUB_API_BASE}/search/issues?q=${query}&per_page=1`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'zajel-log-processor',
        },
      },
    );

    if (!response.ok) {
      return null;
    }

    const data: Record<string, unknown> = await response.json();
    const items = data['items'] as Array<Record<string, unknown>> | undefined;

    if (!items || items.length === 0) {
      return null;
    }

    const issue = items[0];
    if (!issue) {
      return null;
    }

    return {
      issueNumber: issue['number'] as number,
      issueUrl: issue['html_url'] as string,
      state: issue['state'] as string,
    };
  } catch {
    return null;
  }
}
