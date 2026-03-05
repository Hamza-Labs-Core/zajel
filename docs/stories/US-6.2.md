# US-6.2: Automated GitHub Issue Creation

## Story

As a development team, I want the AI to automatically create GitHub issues for significant error patterns, so that detected problems are immediately tracked in our project management workflow without manual triage.

## Acceptance Criteria

- When the AI analysis from US-6.1 identifies a new error pattern that does not already have a corresponding GitHub issue, a GitHub issue is automatically created via the GitHub REST API.
- The created issue includes:
  - An AI-generated title (max 80 characters).
  - A structured markdown body containing: severity, component, detection time, error signature, AI analysis description, affected versions and platforms, estimated user impact, reproduction hints, suggested fix, and scrubbed log excerpts in a collapsible `<details>` block.
  - Labels: `ai-detected`, the severity level (e.g., `critical`, `high`), and the component name (e.g., `crypto`, `network`).
  - Labels are created automatically if they do not yet exist in the repository.
- A maximum of 10 GitHub issues are created per cron run to prevent flooding.
- The `issue_tracking` table in D1 is updated with the `github_issue_number` and `github_issue_url` after successful creation.
- If the GitHub API is unavailable or returns an error, the issue creation is queued: the `issue_tracking` row is stored with `github_issue_number = NULL`, and the next cron run retries creation for any rows missing a GitHub issue number.
- If the GitHub API rate limit is hit (HTTP 403 with `X-RateLimit-Remaining: 0`), the worker backs off and stops creating issues for the remainder of that run.
- The GitHub Personal Access Token is stored as a Cloudflare Worker secret (`GITHUB_TOKEN`) and scoped to minimum permissions: `issues:write` and `repo:read`.
- The repository owner and name are configured via Worker environment variables (`GITHUB_OWNER`, `GITHUB_REPO`).
- No user-identifying data (IP addresses, session hashes, pairing codes, keys, peer IDs) is ever included in the GitHub issue body.

## Technical Design

### Architecture

GitHub issue creation is a downstream step in the Log Processor Worker pipeline (US-6.1). After the AI analysis produces structured results, the GitHub module checks for un-reported signatures and creates issues via the GitHub REST API.

```
[AI Analysis (US-6.1)]
    |
    v
[GitHub Module]
    +-- Check issue_tracking: github_issue_number IS NULL?
    +-- Create issue via POST /repos/{owner}/{repo}/issues
    +-- Update issue_tracking with github_issue_number + URL
    +-- On failure: leave github_issue_number NULL for retry
```

### Implementation Details

**GitHub client (`src/github.ts`):**
A lightweight GitHub REST API client that wraps `fetch()` calls. No external library needed -- the API is simple enough to call directly following the pattern used in `packages/server/src/index.js` for HTTP calls.

Key methods:
- `createIssue(title, body, labels)` -- `POST /repos/{owner}/{repo}/issues`
- `searchIssueBySignature(signature)` -- `GET /repos/{owner}/{repo}/issues?labels=ai-detected&state=open` with body search (used by US-6.4 for dedup)
- `addComment(issueNumber, body)` -- `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` (used by US-6.4)
- `reopenIssue(issueNumber)` -- `PATCH /repos/{owner}/{repo}/issues/{issue_number}` (used by US-6.4)
- `ensureLabelsExist(labels)` -- `POST /repos/{owner}/{repo}/labels` for any missing labels
- `checkRateLimit()` -- read `X-RateLimit-Remaining` header from responses

**Issue body builder (`src/issue-body.ts`):**
Constructs the markdown body from the AI analysis output and raw cluster data. Uses the template from the plan document (Section 4.2). Scrubs all input data through the privacy filter before inclusion.

**Privacy filter (`src/privacy.ts`):**
A final pass over the issue body to catch any data that should not reach GitHub:
- Strip anything matching IP address patterns (`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`)
- Strip hex strings longer than 16 characters (potential keys/hashes)
- Strip pairing code patterns (6-digit numeric codes)
- Strip session hash references

**Pipeline integration (`src/pipeline.ts` modification):**
After the AI analysis loop, add a GitHub issue creation pass:
1. Query `issue_tracking` for rows where `github_issue_number IS NULL` and `ai_analysis IS NOT NULL`.
2. For each (up to 10), call `createIssue()`.
3. On success, update the row with `github_issue_number` and `github_issue_url`.
4. On rate limit, stop and log.
5. On other errors, log and continue to next cluster.

### Files to Create/Modify

| File | Description |
|------|-------------|
| `packages/log-processor-cf/src/github.ts` | GitHub REST API client (create, search, comment, reopen, labels) |
| `packages/log-processor-cf/src/issue-body.ts` | Markdown issue body builder from AI analysis |
| `packages/log-processor-cf/src/privacy.ts` | Privacy scrubbing filter for GitHub-bound data |
| `packages/log-processor-cf/src/pipeline.ts` | Modified to add GitHub issue creation pass after AI analysis |
| `packages/log-processor-cf/src/types.ts` | Add `GitHubIssuePayload`, `GitHubApiResponse` interfaces |
| `packages/log-processor-cf/wrangler.jsonc` | Add `GITHUB_OWNER`, `GITHUB_REPO` vars; document `GITHUB_TOKEN` secret |
| `packages/log-processor-cf/tests/unit/github.test.ts` | GitHub client unit tests |
| `packages/log-processor-cf/tests/unit/issue-body.test.ts` | Issue body builder tests |
| `packages/log-processor-cf/tests/unit/privacy.test.ts` | Privacy filter tests |

### Data Models / Schemas

**GitHub Issue Creation Request:**

```typescript
interface GitHubIssuePayload {
  title: string;                      // AI-generated, max 80 chars
  body: string;                       // Markdown from issue-body.ts
  labels: string[];                   // ['ai-detected', severity, component]
}

interface GitHubCreateIssueResponse {
  id: number;
  number: number;
  html_url: string;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
}
```

**Issue body template (markdown):**

```markdown
## AI-Detected Issue

**Severity:** {severity}
**Component:** {component}
**Detection Time:** {timestamp}
**Error Signature:** `{signature}`

## Analysis

{ai_description}

## Affected Scope

- **Versions:** {versions}
- **Platforms:** {platforms}
- **Estimated Impact:** {affected_users_estimate}
- **Occurrences:** {count} in last {window}

## Reproduction Hints

{ai_reproduction_hints}

## Suggested Fix

{ai_suggested_fix}

## Scrubbed Log Excerpts

<details>
<summary>Sample Error Messages ({n} samples)</summary>

{scrubbed_samples}

</details>

---
*This issue was automatically created by the Zajel AI log analyzer.*
*Error signature: `{signature}`*
```

**Updated wrangler.jsonc vars:**

```jsonc
{
  "vars": {
    "GITHUB_OWNER": "user-or-org",
    "GITHUB_REPO": "zajel",
    "MAX_ISSUES_PER_RUN": "10"
  }
  // Secret: GITHUB_TOKEN (set via `wrangler secret put GITHUB_TOKEN`)
}
```

### API Endpoints

This story does not expose new HTTP endpoints. All GitHub API calls are outbound from the worker to `api.github.com`.

**Outbound API calls:**

| Method | URL | Purpose |
|--------|-----|---------|
| `POST` | `https://api.github.com/repos/{owner}/{repo}/issues` | Create issue |
| `GET` | `https://api.github.com/repos/{owner}/{repo}/issues` | Search for existing issues |
| `POST` | `https://api.github.com/repos/{owner}/{repo}/issues/{number}/comments` | Add comment (US-6.4) |
| `PATCH` | `https://api.github.com/repos/{owner}/{repo}/issues/{number}` | Reopen issue (US-6.4) |
| `POST` | `https://api.github.com/repos/{owner}/{repo}/labels` | Ensure labels exist |

## Dependencies

- **US-6.1** (Automated Error Pattern Analysis): This story extends the log processor pipeline created in US-6.1 with GitHub integration.
- **GitHub Personal Access Token**: Must be generated with `issues:write` and `repo:read` scopes and stored as a Worker secret.
- **GitHub repository**: Target repository must exist with the configured owner/repo.
- **Cloudflare Workers**: Outbound fetch to `api.github.com` must be allowed (it is by default).

## Testing Strategy

- **Unit tests (`tests/unit/github.test.ts`):**
  - Mock `fetch` to simulate GitHub API responses.
  - Successful issue creation: verify correct request body, headers (Authorization, Accept, User-Agent), and response parsing.
  - Rate limit response (403 + `X-RateLimit-Remaining: 0`): verify backoff behavior.
  - Server error (500): verify retry queueing (github_issue_number stays NULL).
  - Network failure: verify graceful handling.
  - Label creation: verify `POST /labels` is called for missing labels.

- **Unit tests (`tests/unit/issue-body.test.ts`):**
  - Verify markdown structure matches the expected template.
  - Verify all fields are populated from AI analysis.
  - Verify scrubbed log excerpts are wrapped in `<details>` tags.
  - Verify title is truncated to 80 characters.
  - Verify labels array includes `ai-detected`, severity, and component.

- **Unit tests (`tests/unit/privacy.test.ts`):**
  - IP addresses in error messages are removed.
  - Long hex strings (potential keys) are removed.
  - Pairing codes are removed.
  - Session hashes are removed.
  - Normal text content is preserved.

- **Pipeline integration tests:**
  - Seed D1 with issue_tracking rows missing github_issue_number.
  - Mock GitHub API.
  - Trigger pipeline; verify issues created and D1 updated.
  - Verify max 10 issues per run cap.
  - Simulate GitHub API failure mid-run; verify partial completion.

## Technical Notes

**GitHub API best practices:**
- Include `User-Agent: zajel-log-processor` header in all requests (GitHub requires it).
- Include `Accept: application/vnd.github+json` header.
- Include `X-GitHub-Api-Version: 2022-11-28` header for API stability.
- The GitHub search endpoint for issues has a separate rate limit of 30 requests/minute for authenticated users. The issues creation endpoint uses the standard 5,000 requests/hour limit.
- Labels are case-sensitive. The `ensureLabelsExist()` method should check existing labels first (GET) before creating (POST) to avoid duplicates.

**Token security:**
- The `GITHUB_TOKEN` is stored as a Cloudflare Worker secret (`wrangler secret put GITHUB_TOKEN`), never in `wrangler.jsonc` or source code.
- The token should be a fine-grained personal access token scoped to only the target repository with `Issues: Read and write` and `Metadata: Read` permissions.

**Privacy considerations:**
- The privacy filter runs as the final step before issue body construction to catch any data that slipped through client-side scrubbing.
- Error messages from end users could theoretically contain typed text fragments. The scrubber should aggressively strip anything that looks like personal data.
- The issue body template uses `<details>` blocks for log excerpts to keep issues readable.

**Codebase patterns:**
- The existing admin-cf worker uses `fetch()` directly for service binding calls (see `packages/admin-cf/src/routes/servers.ts`). Follow the same pattern for GitHub API calls rather than importing an external library.
- Error handling follows the pattern from `packages/server/src/index.js`: try/catch with descriptive error messages.

## Estimation

**M (Medium)** -- The GitHub REST API is straightforward, and the issue body template is already defined in the plan. The main effort is in the privacy filter, rate limit handling, retry logic, and comprehensive testing. Estimated 2-3 days.
