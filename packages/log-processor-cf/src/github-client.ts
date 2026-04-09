/**
 * GitHub REST API v3 client for issue creation and management.
 *
 * Creates issues from AI analysis, updates existing issues with
 * new occurrence data, and searches for duplicates.
 */

import type { Env, ErrorCluster, AiAnalysis, GitHubIssueResult, LogEntry, RelatedLogs } from './types.js';

const GITHUB_API_BASE = 'https://api.github.com';

/** Minimum remaining rate limit before stopping issue creation */
const RATE_LIMIT_FLOOR = 5;

/**
 * Module-level flag indicating whether GitHub rate limit has been hit.
 * The pipeline checks this before attempting more GitHub API calls.
 */
export let rateLimitHit = false;

/**
 * Reset the rate limit flag. Called at the start of each pipeline run.
 */
export function resetRateLimitFlag(): void {
  rateLimitHit = false;
}

/**
 * Rate limit information from GitHub API response headers.
 */
export interface RateLimitInfo {
  remaining: number;
  resetAt: number;
  isLimited: boolean;
}

/**
 * Check GitHub rate limit from response headers.
 * Updates the module-level rateLimitHit flag if remaining < RATE_LIMIT_FLOOR.
 */
export function checkRateLimit(response: Response): RateLimitInfo {
  const remainingHeader = response.headers.get('X-RateLimit-Remaining');
  const resetHeader = response.headers.get('X-RateLimit-Reset');

  const remaining = remainingHeader !== null ? parseInt(remainingHeader, 10) : -1;
  const resetAt = resetHeader !== null ? parseInt(resetHeader, 10) : 0;
  const isLimited = remaining >= 0 && remaining < RATE_LIMIT_FLOOR;

  if (isLimited) {
    rateLimitHit = true;
    const resetDate = new Date(resetAt * 1000).toISOString();
    console.warn(
      `GitHub rate limit low: ${remaining} remaining, resets at ${resetDate}`,
    );
  }

  // Check for 403 rate limit response
  if (response.status === 403) {
    rateLimitHit = true;
    if (resetAt > 0) {
      const resetDate = new Date(resetAt * 1000).toISOString();
      console.warn(`GitHub rate limit exceeded (403), resets at ${resetDate}`);
    }
  }

  return { remaining, resetAt, isLimited };
}

/**
 * Format a timestamp as a time string for the event timeline.
 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * Format a timestamp as a short time string (HH:MM:SS) for timeline entries.
 */
function formatTimeShort(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().substring(11, 19);
}

/**
 * Build a markdown table from log entries.
 */
function buildLogTable(logs: LogEntry[]): string {
  if (logs.length === 0) return '_No entries_';

  const header = '| Time | Severity | Category | Message |\n|------|----------|----------|---------|\n';
  const rows = logs
    .map(
      (log) =>
        `| ${formatTimestamp(log.timestamp)} | ${log.severity} | ${log.category} | ${log.message.substring(0, 120)} |`,
    )
    .join('\n');

  return header + rows;
}

/**
 * Build an event timeline from cluster data and related logs.
 */
function buildEventTimeline(
  cluster: ErrorCluster,
  relatedLogs?: RelatedLogs,
): string {
  const events: Array<{ timestamp: number; description: string }> = [];

  // Cluster first/last seen
  const versionStr = cluster.versions[0] ? `, ${cluster.versions[0]}` : '';
  const platformStr = cluster.platforms[0] ? `, ${cluster.platforms[0]}` : '';
  events.push({
    timestamp: cluster.firstSeen,
    description: `Error first seen (${cluster.totalCount} total${versionStr}${platformStr})`,
  });

  // Add related server log events
  if (relatedLogs?.serverLogs) {
    for (const log of relatedLogs.serverLogs.slice(0, 5)) {
      events.push({
        timestamp: log.timestamp,
        description: `Server log: "${log.message.substring(0, 80)}"`,
      });
    }
  }

  // Add related app log events
  if (relatedLogs?.appLogs) {
    for (const log of relatedLogs.appLogs.slice(0, 5)) {
      events.push({
        timestamp: log.timestamp,
        description: `App log: "${log.message.substring(0, 80)}"`,
      });
    }
  }

  events.push({
    timestamp: cluster.lastSeen,
    description: `Error last seen (${cluster.totalCount} occurrences, ${cluster.platforms.length} platform${cluster.platforms.length !== 1 ? 's' : ''})`,
  });

  // Sort by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  return events
    .map((e) => `- \`${formatTimeShort(e.timestamp)}\` — ${e.description}`)
    .join('\n');
}

/**
 * Build the issue body markdown from an error cluster and optional AI analysis,
 * enriched with related logs and stack traces.
 */
export function buildIssueBody(
  cluster: ErrorCluster,
  analysis: AiAnalysis | null,
  timeWindow: string,
  relatedLogs?: RelatedLogs,
  fullStackTraces?: string[],
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

  let body = `## AI-Detected Issue

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

</details>`;

  // Related Server Logs section
  if (relatedLogs?.serverLogs && relatedLogs.serverLogs.length > 0) {
    body += `

<details>
<summary>Related Server Logs (${relatedLogs.serverLogs.length} entries)</summary>

${buildLogTable(relatedLogs.serverLogs)}

</details>`;
  }

  // Related App Logs section
  if (relatedLogs?.appLogs && relatedLogs.appLogs.length > 0) {
    body += `

<details>
<summary>Related App Logs (${relatedLogs.appLogs.length} entries)</summary>

${buildLogTable(relatedLogs.appLogs)}

</details>`;
  }

  // Full Stack Traces section
  if (fullStackTraces && fullStackTraces.length > 0) {
    const traceEntries = fullStackTraces
      .map((trace, i) => `### Report ${i + 1}\n\`\`\`\n${trace}\n\`\`\``)
      .join('\n\n');

    body += `

<details>
<summary>Full Stack Traces (${fullStackTraces.length} reports)</summary>

${traceEntries}

</details>`;
  }

  // Event Timeline section
  const hasRelatedLogs =
    (relatedLogs?.serverLogs && relatedLogs.serverLogs.length > 0) ||
    (relatedLogs?.appLogs && relatedLogs.appLogs.length > 0);

  if (hasRelatedLogs) {
    body += `

## Event Timeline

${buildEventTimeline(cluster, relatedLogs)}`;
  }

  body += `

---
*This issue was automatically created by the Zajel AI log analyzer.*
*Error signature: \`${cluster.errorSignature}\`*`;

  return body;
}

/**
 * Build the labels array for a GitHub issue.
 *
 * Includes ai-detected, severity, component, and optionally
 * version, platform, and environment labels.
 */
export function buildLabels(
  analysis: AiAnalysis | null,
  category: string,
  cluster?: ErrorCluster,
  environment?: string,
): string[] {
  const labels = ['ai-detected'];
  if (analysis) {
    labels.push(analysis.severity);
    labels.push(analysis.component);
  } else {
    labels.push(category);
  }

  // Add primary version label
  if (cluster?.versions && cluster.versions.length > 0 && cluster.versions[0]) {
    labels.push(`v${cluster.versions[0]}`);
  }

  // Add primary platform label
  if (cluster?.platforms && cluster.platforms.length > 0 && cluster.platforms[0]) {
    labels.push(cluster.platforms[0]);
  }

  // Add environment label
  if (environment) {
    labels.push(environment);
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

    checkRateLimit(response);

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
 * Create a new GitHub issue from an error cluster and AI analysis,
 * enriched with related logs and stack traces.
 *
 * Returns the issue number and URL, or null if creation fails.
 */
export async function createGitHubIssue(
  env: Env,
  cluster: ErrorCluster,
  analysis: AiAnalysis | null,
  timeWindow: string,
  relatedLogs?: RelatedLogs,
  fullStackTraces?: string[],
): Promise<GitHubIssueResult | null> {
  try {
    const title = analysis?.title ?? `[${cluster.category}] ${cluster.errorSignature.substring(0, 60)}`;
    const body = buildIssueBody(cluster, analysis, timeWindow, relatedLogs, fullStackTraces);
    const labels = buildLabels(analysis, cluster.category, cluster, env.ENVIRONMENT);

    const response = await githubFetch(
      env,
      `/repos/${env.GITHUB_REPO}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          body,
          labels,
          assignees: ['claude'],
        }),
      },
    );

    checkRateLimit(response);

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

    checkRateLimit(commentResponse);

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

      checkRateLimit(reopenResponse);

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
