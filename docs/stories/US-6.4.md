# US-6.4: Deduplication

## Story

As a development team, I want the AI to avoid creating duplicate issues, so that the GitHub issue tracker stays clean and each unique error pattern maps to exactly one issue.

## Acceptance Criteria

- Before creating a new GitHub issue for an error signature, the system searches existing open GitHub issues for a matching error signature.
- The search checks both the D1 `issue_tracking` table (primary) and the GitHub Issues API (fallback) for matches.
- If a matching **open** issue is found: a comment is added to the existing issue with updated occurrence counts, affected versions/platforms, and the latest detection timestamp. No new issue is created.
- If a matching **closed** issue is found and the error count exceeds a configurable reopen threshold (default: 10 occurrences since closure): the issue is reopened with a comment explaining the recurrence.
- If a matching closed issue is found but the error count is below the reopen threshold: the recurrence is noted in D1 but the issue is not reopened.
- The error signature stored in the issue body (in the footer line `*Error signature: \`{signature}\`*`) is the primary key for matching.
- D1's `issue_tracking` table is the source of truth for signature-to-issue mapping. GitHub search is used only as a fallback if the D1 record is missing or incomplete.
- The system handles the case where an issue was created manually (not by the AI) for the same error pattern: if the signature appears in the issue body, it is treated as a match.
- A cap of 10 issues created per cron run still applies (from US-6.2), but comments and reopens do not count toward this cap.
- All deduplication decisions are logged in D1 for auditability.

## Technical Design

### Architecture

Deduplication is implemented as a pre-check layer within the GitHub issue creation pipeline (US-6.2). Before calling `createIssue()`, the deduplication module checks for existing issues and routes to the appropriate action: create, comment, or reopen.

```
[Pipeline: New error cluster ready for GitHub]
    |
    v
[Dedup Check]
    +-- Query D1 issue_tracking by error_signature
    |   |
    |   +-- Found with github_issue_number?
    |       +-- Yes, status=open -> ADD COMMENT
    |       +-- Yes, status=closed -> REOPEN (if above threshold) or SKIP
    |       +-- No github_issue_number -> FALL THROUGH to GitHub search
    |
    +-- GitHub API fallback: search issues with label:ai-detected
    |   containing signature string
    |   |
    |   +-- Found? -> Update D1, ADD COMMENT or REOPEN
    |   +-- Not found? -> CREATE NEW ISSUE
    |
    v
[Execute action: create / comment / reopen]
```

### Implementation Details

**Deduplication module (`src/dedup.ts`):**

```typescript
interface DedupResult {
  action: 'create' | 'comment' | 'reopen' | 'skip';
  existingIssueNumber?: number;
  reason: string;
}

async function checkDuplicate(
  signature: string,
  occurrenceCount: number,
  env: Env
): Promise<DedupResult>
```

The function implements a three-tier lookup:

1. **D1 lookup (fast, authoritative):**
   Query `issue_tracking` for the error signature. If found with a `github_issue_number`, determine action based on `status`:
   - `status = 'open'` or `status = 'acknowledged'` -> `{ action: 'comment' }`
   - `status = 'resolved'` and `occurrenceCount >= REOPEN_THRESHOLD` -> `{ action: 'reopen' }`
   - `status = 'resolved'` and `occurrenceCount < REOPEN_THRESHOLD` -> `{ action: 'skip' }`

2. **GitHub search (fallback for data inconsistency):**
   If D1 has no record or no `github_issue_number`, search GitHub via `GET /repos/{owner}/{repo}/issues?labels=ai-detected&state=all&per_page=100`. Filter results by checking the issue body for the signature string. This handles cases where:
   - D1 data was lost or corrupted.
   - An issue was created manually with the signature in the body.
   - The system was redeployed with a fresh D1 database.

3. **No match found:**
   Return `{ action: 'create' }`.

**Comment builder (`src/issue-comment.ts`):**

Builds a markdown comment for existing issues:

```markdown
## Updated Error Report

**Detection Time:** {timestamp}
**New Occurrences:** {count} since last report
**Total Occurrences:** {total_count}

### Changes Since Last Report
- **New Versions Affected:** {new_versions}
- **New Platforms Affected:** {new_platforms}
- **Severity Change:** {previous} -> {current} (if changed)

---
*Automated update by the Zajel AI log analyzer.*
```

**Reopen comment builder:**

```markdown
## Issue Reopened - Error Recurring

This error pattern has recurred with **{count}** new occurrences since the issue was closed.

**Detection Time:** {timestamp}
**Affected Versions:** {versions}
**Affected Platforms:** {platforms}

The error signature `{signature}` matches this issue.

---
*Automatically reopened by the Zajel AI log analyzer.*
```

**Pipeline integration (`src/pipeline.ts` modification):**
Replace the direct `createIssue()` call with a dedup-aware flow:
1. Call `checkDuplicate(signature, count, env)`.
2. Switch on `result.action`:
   - `create`: call `createIssue()` (counts toward 10/run cap).
   - `comment`: call `addComment()` (no cap).
   - `reopen`: call `reopenIssue()` + `addComment()` (no cap).
   - `skip`: log and continue.
3. Update `issue_tracking` with the action taken and timestamp.

**Audit logging:**
Every dedup decision is recorded by updating the `issue_tracking` row's `updated_at` timestamp and, for comments/reopens, incrementing `total_occurrences`. A separate `dedup_log` column (JSON) can store the action history if needed for debugging.

### Files to Create/Modify

| File | Description |
|------|-------------|
| `packages/log-processor-cf/src/dedup.ts` | Deduplication check logic with D1 + GitHub fallback |
| `packages/log-processor-cf/src/issue-comment.ts` | Comment and reopen comment body builders |
| `packages/log-processor-cf/src/pipeline.ts` | Integrate dedup check before issue creation |
| `packages/log-processor-cf/src/github.ts` | Add `searchIssuesByLabel()`, `addComment()`, `reopenIssue()` methods |
| `packages/log-processor-cf/src/types.ts` | Add `DedupResult`, `DedupAction` types |
| `packages/log-processor-cf/wrangler.jsonc` | Add `REOPEN_THRESHOLD` var |
| `packages/log-processor-cf/tests/unit/dedup.test.ts` | Deduplication logic tests |
| `packages/log-processor-cf/tests/unit/issue-comment.test.ts` | Comment builder tests |

### Data Models / Schemas

**Updated `issue_tracking` usage:**

The `status` column tracks the lifecycle:
- `open` -- initial state after creation
- `acknowledged` -- admin has seen it (from US-6.3)
- `in-progress` -- someone is working on it
- `resolved` -- GitHub issue was closed

For dedup, the key fields are:
- `error_signature` (UNIQUE) -- primary dedup key
- `github_issue_number` -- links to GitHub
- `status` -- determines dedup action
- `total_occurrences` -- cumulative count
- `last_detected` -- updated on each new detection

**Reopen threshold configuration:**

```jsonc
{
  "vars": {
    "REOPEN_THRESHOLD": "10"
  }
}
```

### API Endpoints

No new API endpoints. This story modifies the internal pipeline behavior. The GitHub API calls used are:

| Method | URL | Purpose |
|--------|-----|---------|
| `GET` | `https://api.github.com/repos/{owner}/{repo}/issues?labels=ai-detected&state=all&per_page=100` | Search for existing issues by label |
| `POST` | `https://api.github.com/repos/{owner}/{repo}/issues/{number}/comments` | Add comment to existing issue |
| `PATCH` | `https://api.github.com/repos/{owner}/{repo}/issues/{number}` | Reopen closed issue (set `state: "open"`) |

## Dependencies

- **US-6.1** (Automated Error Pattern Analysis): The `issue_tracking` table and error clusters must exist.
- **US-6.2** (Automated GitHub Issue Creation): The GitHub client and issue creation pipeline must be in place. This story modifies that pipeline.
- **GitHub API**: Requires the same `GITHUB_TOKEN` secret from US-6.2 with `issues:write` scope.

## Testing Strategy

- **Unit tests (`tests/unit/dedup.test.ts`):**
  - **D1 match, open issue:** Returns `{ action: 'comment' }` with correct issue number.
  - **D1 match, closed issue, above threshold:** Returns `{ action: 'reopen' }`.
  - **D1 match, closed issue, below threshold:** Returns `{ action: 'skip' }`.
  - **D1 match, no github_issue_number:** Falls through to GitHub search.
  - **D1 miss, GitHub search finds match:** Returns `{ action: 'comment' }` and updates D1.
  - **D1 miss, GitHub search finds no match:** Returns `{ action: 'create' }`.
  - **GitHub API failure during fallback:** Falls back to `{ action: 'create' }` (safe default).
  - **Signature in manually-created issue:** GitHub search finds it; treated as match.

- **Unit tests (`tests/unit/issue-comment.test.ts`):**
  - Comment body includes updated occurrence counts.
  - Comment body includes new versions/platforms if changed.
  - Reopen comment body includes recurrence count and signature.
  - No user-identifying data in comments.

- **Pipeline integration tests:**
  - Seed D1 with existing issue_tracking entries.
  - Run pipeline with overlapping error signatures.
  - Verify: new signatures -> create, existing open -> comment, existing closed above threshold -> reopen.
  - Verify the 10-issue creation cap applies only to `create` actions.
  - Verify `issue_tracking` rows are updated after each action.

- **Edge case tests:**
  - Same signature processed twice in one run: second occurrence should detect the first.
  - GitHub API returns paginated results (>100 issues): verify pagination handling.
  - Race condition: two cron runs overlap and both try to create for the same signature. D1 UNIQUE constraint on `error_signature` prevents double-insert; second run should detect existing record.

## Technical Notes

**GitHub search approach:**
- The plan specifies searching by error signature in the issue body. GitHub's search API (`GET /search/issues?q=...`) supports searching within issue bodies, but the search rate limit is 30 requests/minute. For large volumes, prefer the simpler list approach: `GET /repos/{owner}/{repo}/issues?labels=ai-detected&state=all&per_page=100` and filter client-side by checking `body.includes(signature)`.
- If there are more than 100 AI-detected issues, pagination is needed. Use the `Link` header for next-page URLs.

**D1 as source of truth:**
- The `issue_tracking` table's UNIQUE constraint on `error_signature` is the primary dedup mechanism. The GitHub search is a fallback for edge cases (fresh D1, manual issues).
- This design avoids depending on GitHub search for the hot path, which would be slow and rate-limited.

**Race conditions:**
- CF Workers cron triggers are guaranteed to run at most once per schedule in a single location. However, if the worker takes longer than 15 minutes, two runs could overlap. Use a D1 advisory lock pattern: check `processing_runs` for an in-progress run before starting.

**Reopen threshold rationale:**
- The default threshold of 10 occurrences prevents noisy reopening for rare, intermittent errors. If a resolved error genuinely recurs at significant volume, it deserves a reopen.

## Estimation

**M (Medium)** -- The dedup logic itself is straightforward (D1 lookup + conditional branching), but the GitHub search fallback, comment/reopen builders, and edge case handling add moderate complexity. Estimated 2-3 days.
