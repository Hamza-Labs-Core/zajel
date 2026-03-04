# Remediation Plan: CodeQL Security Alerts

**Date:** 2026-02-27
**Scope:** 57 open CodeQL alerts across 2 rule categories
**Priority:** Medium-High (workflow permissions) / Medium-Low (path injection)

---

## 1. Alert Inventory

### Summary

| Rule ID | Category | Count | Severity | Files Affected |
|---------|----------|-------|----------|----------------|
| `actions/missing-workflow-permissions` | CI/CD Security | 53 | Warning | 12 workflow files |
| `js/path-injection` | Application Security | 4 | Error | 2 source files |
| **Total** | | **57** | | **14 files** |

> **Note:** GitHub reports "75 alerts" because some alerts were opened on multiple branches
> or at different points in time. The actual distinct open alerts are 57.

---

### Category 1: `js/path-injection` (4 alerts, severity: error)

| Alert # | File | Line | Description |
|---------|------|------|-------------|
| #68 | `packages/web-client/server/index.ts` | 63 | `stat(fullPath)` -- path depends on user-provided value |
| #69 | `packages/web-client/server/index.ts` | 64 | `readFile(fullPath)` -- path depends on user-provided value |
| #66 | `packages/integration-tests/src/scenarios/web-to-web.test.ts` | 134 | `existsSync(filePath)` -- path depends on user-provided value |
| #67 | `packages/integration-tests/src/scenarios/web-to-web.test.ts` | 139 | `readFileSync(filePath)` -- path depends on user-provided value |

### Category 2: `actions/missing-workflow-permissions` (53 alerts, severity: warning)

#### Alerts by workflow file:

| Workflow File | Alert #s | Jobs Missing Permissions |
|---------------|----------|------------------------|
| `ci.yml` | #13, #15 | `analyze`, `test` |
| `ci-server.yml` | #12 | `validate` |
| `ci-website.yml` | #11 | `build` |
| `deploy-server.yml` | #10 | `deploy` |
| `deploy-vps.yml` | #25, #26 | `build`, `deploy` |
| `flutter-tests.yml` | #27, #28, #29, #30 | `analyze`, `unit-tests`, `build-android`, `build-ios` |
| `integration-tests.yml` | #33, #40, #43 | `setup`, `pairing-flow`, `web-to-web` |
| `pr-pipeline.yml` | #31, #35, #38, #39, #42, #45, #46, #47, #48, #50, #52, #53, #55, #56, #57, #59, #60, #63, #65, #73, #74, #75 | 22 jobs total |
| `release.yml` | #16, #17, #18, #19, #20, #21, #22, #32, #36, #58 | 10 jobs |
| `server-tests.yml` | #34, #37 | `unit-tests`, `e2e-tests` |
| `server-vps-tests.yml` | #41, #44 | `unit-tests`, `integration-tests` |
| `web-client-tests.yml` | #49, #51, #54 | `unit-tests`, `build`, `e2e-chromium` |

#### Workflows that ALREADY have proper permissions (no alerts):

| Workflow File | Status |
|---------------|--------|
| `claude.yml` | Has job-level `permissions` |
| `claude-code-review.yml` | Has job-level `permissions` |
| `deploy-website.yml` | Has job-level `permissions` |

---

## 2. Risk Assessment

### Category 1: `js/path-injection` -- MEDIUM-LOW RISK

**Actual Risk: Low (false positive / mitigated)**

**File 1: `packages/web-client/server/index.ts` (Alerts #68, #69)**

This is a local development server (`npm run dev` style) that serves the built web client.
The code at lines 63-64 does:

```typescript
await stat(fullPath);                    // line 63
const content = await readFile(fullPath); // line 64
```

CodeQL flags `fullPath` because it derives from `req.url` (user-controlled HTTP request).
However, the code already implements proper path traversal protection:

1. **Line 44:** `decodeURIComponent(filePath)` with error handling for double-encoding attacks
2. **Line 52:** `resolve(DIST_RESOLVED, '.' + filePath)` -- resolves to canonical absolute path
3. **Line 55:** `!fullPath.startsWith(DIST_RESOLVED + '/')` -- verifies resolved path stays within `DIST`
4. **Line 26:** `DIST_RESOLVED = resolve(DIST)` -- pre-resolved base directory

This is a textbook correct implementation of directory traversal prevention. The CodeQL
alert is a **true positive in detection** (user input flows into a file path) but a
**false positive in risk** (the mitigation is correct and complete).

Additionally, this server:
- Only runs locally during development (not deployed to production)
- Serves only static files from the build output directory
- Has security headers (X-Frame-Options, CSP, X-Content-Type-Options)

**File 2: `packages/integration-tests/src/scenarios/web-to-web.test.ts` (Alerts #66, #67)**

This is a test file containing a simple static file server used during integration tests:

```typescript
let filePath = join(WEB_CLIENT_DIST, req.url === '/' ? 'index.html' : req.url!); // line 131
if (!existsSync(filePath) || !extname(filePath)) {                                // line 134
    filePath = join(WEB_CLIENT_DIST, 'index.html');
}
const content = readFileSync(filePath);                                            // line 139
```

This code does NOT have path traversal protection. The `req.url` is used directly with
`join()` which does not prevent `../` traversal. However:

- This server only runs during automated tests (never deployed)
- It binds to `127.0.0.1` only (line 153), not accessible externally
- The test is skipped in CI entirely (`shouldSkipWebToWebTests()` returns true when `CI=true`)
- The `WEB_CLIENT_DIST` directory contains only build artifacts (no sensitive data)

**Actual exploitability: None** -- test-only code, localhost-only, never in production.

### Category 2: `actions/missing-workflow-permissions` -- MEDIUM-HIGH RISK

**Actual Risk: Medium-High (should be fixed)**

When a workflow does not specify a `permissions:` block, the `GITHUB_TOKEN` inherits the
repository or organization default permissions. For repositories created before February
2023, this defaults to **read-write** access across all scopes.

The risk is that:

1. **Compromised actions** (supply chain attack on a third-party action) could use the
   overly-permissive token to modify repository contents, create releases, or alter
   CI/CD pipelines.
2. **Principle of least privilege violation** -- jobs that only need to read code and
   run tests should not have write access to contents, issues, pull requests, etc.
3. **Blast radius** -- if a workflow step is compromised (e.g., via a malicious npm
   package running in a test), the attacker gets whatever permissions the token has.

This is particularly relevant for:
- `deploy-server.yml` and `deploy-vps.yml` which handle production deployments
- `release.yml` which creates GitHub releases
- `pr-pipeline.yml` which runs on every PR with access to secrets via `environment: qa`

---

## 3. Remediation Plan

### Phase 1: Fix Workflow Permissions (53 alerts)

**Strategy:** Add top-level `permissions: {}` (no permissions) to each workflow file, then
grant specific permissions at the job level only where needed. This is the most secure
approach because it follows deny-by-default.

For workflows where ALL jobs need the same minimal permissions, a top-level `permissions:`
block with `contents: read` is sufficient.

#### 3.1 Simple CI/Test Workflows (read-only, no artifacts)

These workflows only checkout code and run tests. They need `contents: read` only.

**`ci-server.yml`** -- Fix alerts: #12
```yaml
# Add after line 14 (after the `on:` block)
permissions:
  contents: read
```

**`ci-website.yml`** -- Fix alerts: #11
```yaml
# Add after line 14 (after the `on:` block)
permissions:
  contents: read
```

**`ci.yml`** -- Fix alerts: #13, #15
```yaml
# Add after line 16 (after the `env:` block)
permissions:
  contents: read
```

**`server-tests.yml`** -- Fix alerts: #34, #37
```yaml
# Add after line 18 (after the concurrency block)
permissions:
  contents: read
```

**`server-vps-tests.yml`** -- Fix alerts: #41, #44
```yaml
# Add after line 18 (after the concurrency block)
permissions:
  contents: read
```

#### 3.2 CI/Test Workflows with Artifacts

These workflows upload/download artifacts but that uses `actions/upload-artifact` which
does NOT require any extra token permissions (it uses the Actions runtime API, not the
GitHub API).

**`flutter-tests.yml`** -- Fix alerts: #27, #28, #29, #30
```yaml
# Add after line 24 (after the defaults block)
permissions:
  contents: read
```

**`web-client-tests.yml`** -- Fix alerts: #49, #51, #54
```yaml
# Add after line 18 (after the concurrency block)
permissions:
  contents: read
```

**`integration-tests.yml`** -- Fix alerts: #33, #40, #43
```yaml
# Add after line 22 (after the concurrency block)
permissions:
  contents: read
```

#### 3.3 Deployment Workflows

**`deploy-server.yml`** -- Fix alerts: #10
```yaml
# Add after line 9 (after the `on:` block)
permissions:
  contents: read
```
Note: `cloudflare/wrangler-action` uses its own `apiToken`, not `GITHUB_TOKEN`.

**`deploy-vps.yml`** -- Fix alerts: #25, #26
```yaml
# Add after line 12 (after the `env:` block)
permissions:
  contents: read
```
Note: SSH/SCP actions use their own SSH keys, not `GITHUB_TOKEN`.

**`deploy-vps-reusable.yml`** -- No alerts (reusable workflows inherit caller permissions)
but should still have explicit permissions for documentation purposes:
```yaml
# Add to each job
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    ...
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    ...
```

#### 3.4 Release Workflow

**`release.yml`** -- Fix alerts: #16, #17, #18, #19, #20, #21, #22, #32, #36, #58

This workflow has 10+ jobs. Most need only `contents: read`. The `release` job and
`skip-release` job need `contents: write` for creating GitHub releases. Currently only
the `release` job (line 481) has `permissions: contents: write`.

**Recommended approach:** Add top-level restrictive permissions, keep existing job-level
overrides.

```yaml
# Add after line 9 (after the `env:` block, before jobs:)
permissions:
  contents: read

# Jobs that already have permissions: keep them as-is
# release job (line 481): already has contents: write -- OK
# skip-release job (line 542): needs contents: read only -- covered by top-level
```

The `release` job also uses `softprops/action-gh-release@v1` and `gh release` commands
which need `contents: write`. The existing job-level `permissions: contents: write` on
the `release` job is correct.

The `skip-release` job (alert #58, lines 531-546) only runs `echo` commands and needs
no special permissions. Covered by top-level `contents: read`.

#### 3.5 PR Pipeline Workflow

**`pr-pipeline.yml`** -- Fix alerts: #31, #35, #38, #39, #42, #45, #46, #47, #48, #50,
#52, #53, #55, #56, #57, #59, #60, #63, #65, #73, #74, #75 (22 alerts)

This is the largest workflow with 20+ jobs. The strategy is:

```yaml
# Add after line 27 (after the env: block, before jobs:)
permissions:
  contents: read
```

Then verify the jobs that need more:

| Job | Current Permissions | Needed Permissions | Action |
|-----|--------------------|--------------------|--------|
| `determine-version` | none | `contents: read` | Covered by top-level |
| `detect-changes` | none | `contents: read` | Covered by top-level |
| `unit-tests` | none | `contents: read` | Covered by top-level |
| `server-tests` | none | `contents: read` | Covered by top-level |
| `headless-client-tests` | none | `contents: read` | Covered by top-level |
| `phase-1-tests` | none | `contents: read` | Covered by top-level |
| `tag-prerelease` | `contents: write` | `contents: write` | Already correct |
| `phase-2-tag` | none | `contents: read` | Covered by top-level |
| `build-android` | none | `contents: read` | Covered by top-level |
| `build-ios` | none | `contents: read` | Covered by top-level |
| `build-linux` | none | `contents: read` | Covered by top-level |
| `build-macos` | none | `contents: read` | Covered by top-level |
| `build-windows` | none | `contents: read` | Covered by top-level |
| `build-web` | none | `contents: read` | Covered by top-level |
| `create-prerelease` | `contents: write` | `contents: write` | Already correct |
| `deploy-cf-signaling` | none | `contents: read` | Covered by top-level |
| `deploy-cf-admin` | none | `contents: read` | Covered by top-level |
| `deploy-cf-website` | none | `contents: read` | Covered by top-level |
| `deploy-vps` | none | `contents: read` | Covered by top-level |
| `e2e-tests` | none | `contents: read` | Covered by top-level |
| `cleanup` | `contents: write` | `contents: write` | Already correct |
| `summary` | none | `contents: read` | Covered by top-level |

The three jobs that already have `permissions: contents: write` (tag-prerelease,
create-prerelease, cleanup) will override the top-level `contents: read` correctly.

---

### Phase 2: Address Path Injection Alerts (4 alerts)

#### 3.6 `packages/web-client/server/index.ts` (Alerts #68, #69) -- Suppress with annotation

The existing code already has correct path traversal mitigation. To resolve the CodeQL
alert, add a suppression comment that documents the analysis:

```typescript
// At line 62-64, change:
    // Check if file exists
    await stat(fullPath);
    const content = await readFile(fullPath);

// To:
    // Check if file exists
    // CodeQL: fullPath is validated above -- resolve() + startsWith() prevents traversal
    await stat(fullPath); // lgtm[js/path-injection]
    const content = await readFile(fullPath); // lgtm[js/path-injection]
```

Alternatively, using CodeQL's native suppression syntax (preferred):

Create or update `.github/codeql/codeql-config.yml`:
```yaml
query-filters:
  - exclude:
      id: js/path-injection
      # Only suppress for the specific files where mitigations are verified
```

However, a blanket exclusion is not recommended. The best approach is either:

**Option A (recommended): Add `codeql` alert dismissal via GitHub UI**

Dismiss alerts #68 and #69 as "Used in tests" / "False positive" with a comment explaining
the `resolve() + startsWith()` mitigation is correct.

**Option B: Harden the code further to satisfy CodeQL's taint tracking**

Move the path validation into a helper function that CodeQL can recognize as a sanitizer:

```typescript
/**
 * Safely resolve a URL path to a file path within the allowed directory.
 * Returns null if the path would escape the allowed directory.
 */
function safePath(basePath: string, urlPath: string): string | null {
  const resolved = resolve(basePath, '.' + urlPath);
  if (!resolved.startsWith(basePath + '/') && resolved !== basePath) {
    return null;
  }
  return resolved;
}
```

Then in the handler:
```typescript
  const fullPath = safePath(DIST_RESOLVED, filePath);
  if (fullPath === null) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  try {
    await stat(fullPath);
    const content = await readFile(fullPath);
```

This may or may not satisfy CodeQL depending on whether it tracks through the helper.
Option A (dismissal) is more reliable for eliminating the alert.

#### 3.7 `packages/integration-tests/src/scenarios/web-to-web.test.ts` (Alerts #66, #67)

The test file's static server lacks path traversal protection. While the risk is negligible
(test code, localhost only, CI-skipped), the fix is simple and good practice:

```typescript
// Replace lines 130-146:
    server = createServer((req, res) => {
      const requestPath = (req.url === '/' ? '/index.html' : req.url!) .split('?')[0];

      // Resolve and validate path stays within dist directory
      const resolvedDist = resolve(WEB_CLIENT_DIST);
      const filePath = resolve(resolvedDist, '.' + requestPath);

      if (!filePath.startsWith(resolvedDist + '/') && filePath !== resolvedDist) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Handle SPA routing - serve index.html for non-file requests
      if (!existsSync(filePath) || !extname(filePath)) {
        const indexPath = join(resolvedDist, 'index.html');
        try {
          const content = readFileSync(indexPath);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      try {
        const content = readFileSync(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
```

---

## 4. Implementation Order

| Step | Action | Alerts Fixed | Risk | Effort |
|------|--------|-------------|------|--------|
| 1 | Add `permissions: contents: read` to 8 simple CI workflows | 19 alerts | None (read-only is always safe) | ~10 min |
| 2 | Add top-level `permissions: contents: read` to `release.yml` | 10 alerts | Low (existing job-level write overrides preserved) | ~5 min |
| 3 | Add top-level `permissions: contents: read` to `pr-pipeline.yml` | 22 alerts | Low (existing job-level write overrides preserved) | ~5 min |
| 4 | Add top-level `permissions: contents: read` to `deploy-vps.yml` and `deploy-server.yml` | 3 alerts | None | ~5 min |
| 5 | Fix path traversal in test file `web-to-web.test.ts` | 2 alerts | None (test code) | ~10 min |
| 6 | Dismiss or suppress `server/index.ts` path injection alerts | 2 alerts | None (already mitigated) | ~5 min |
| **Total** | | **57 alerts** | | **~40 min** |

---

## 5. Specific Code Changes

### 5.1 Workflow Permission Fixes (Steps 1-4)

#### `ci-server.yml`
```yaml
name: CI - Server

on:
  push:
    branches: [main]
    paths:
      - 'packages/server/**'
      - '.github/workflows/ci-server.yml'
  pull_request:
    branches: [main]
    paths:
      - 'packages/server/**'
      - '.github/workflows/ci-server.yml'

permissions:
  contents: read

jobs:
  # ... unchanged
```

#### `ci-website.yml`
```yaml
name: CI - Website

on:
  # ... unchanged

permissions:
  contents: read

jobs:
  # ... unchanged
```

#### `ci.yml`
```yaml
name: CI - App

on:
  # ... unchanged

permissions:
  contents: read

env:
  FLUTTER_VERSION: '3.38.5'

jobs:
  # ... unchanged
```

#### `deploy-server.yml`
```yaml
name: Deploy Server

on:
  # ... unchanged

permissions:
  contents: read

jobs:
  # ... unchanged
```

#### `deploy-vps.yml`
```yaml
name: Deploy VPS Server

on:
  # ... unchanged

permissions:
  contents: read

env:
  NODE_VERSION: '20'

jobs:
  # ... unchanged
```

#### `flutter-tests.yml`
```yaml
name: Flutter Tests

on:
  # ... unchanged

concurrency:
  group: flutter-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

env:
  FLUTTER_VERSION: '3.38.5'
  # ... unchanged
```

#### `integration-tests.yml`
```yaml
name: Cross-App Integration Tests

on:
  # ... unchanged

concurrency:
  group: integration-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  # ... unchanged
```

#### `server-tests.yml`
```yaml
name: Server Tests (CF Workers)

on:
  # ... unchanged

concurrency:
  group: server-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  # ... unchanged
```

#### `server-vps-tests.yml`
```yaml
name: VPS Server Tests

on:
  # ... unchanged

concurrency:
  group: server-vps-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  # ... unchanged
```

#### `web-client-tests.yml`
```yaml
name: Web Client Tests

on:
  # ... unchanged

concurrency:
  group: web-client-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  # ... unchanged
```

#### `release.yml`
```yaml
name: Release - App

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read

env:
  FLUTTER_VERSION: '3.38.5'

jobs:
  # ... unchanged (release job already has job-level contents: write)
```

#### `pr-pipeline.yml`
```yaml
name: PR Pipeline - E2E Tests

on:
  # ... unchanged

concurrency:
  group: pr-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

permissions:
  contents: read

env:
  FLUTTER_VERSION: '3.38.5'
  NODE_VERSION: '20'

jobs:
  # ... unchanged (tag-prerelease, create-prerelease, cleanup already have job-level contents: write)
```

#### `deploy-vps-reusable.yml` (no alerts, but good practice)
```yaml
name: Deploy VPS Server (Reusable)

on:
  workflow_call:
    # ... unchanged

permissions:
  contents: read

env:
  NODE_VERSION: '20'

jobs:
  # ... unchanged
```

---

### 5.2 Path Injection Fix for Test File (Step 5)

**File:** `packages/integration-tests/src/scenarios/web-to-web.test.ts`
**Lines:** 130-146

Replace the server handler with a path-traversal-safe version:

```typescript
    // Start simple static file server for the pre-built web client
    const resolvedDist = resolve(WEB_CLIENT_DIST);
    server = createServer((req, res) => {
      const requestPath = (req.url === '/' ? '/index.html' : req.url!).split('?')[0];

      // Security: prevent directory traversal
      const filePath = resolve(resolvedDist, '.' + requestPath);
      if (!filePath.startsWith(resolvedDist + '/') && filePath !== resolvedDist) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Handle SPA routing - serve index.html for non-file requests
      if (!existsSync(filePath) || !extname(filePath)) {
        try {
          const content = readFileSync(join(resolvedDist, 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      try {
        const content = readFileSync(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
```

### 5.3 Path Injection Dismissal for Dev Server (Step 6)

**File:** `packages/web-client/server/index.ts`
**Lines:** 63-64

**Option A (preferred):** Dismiss alerts #68 and #69 via GitHub Security tab with reason
"False positive" and comment: "Path is validated via resolve() + startsWith() check at
lines 52-58. The resolved fullPath is verified to be within DIST_RESOLVED before any
filesystem access."

**Option B:** If code-level suppression is preferred, the code is already correct.
No changes needed. The only option would be to extract the validation into a named
sanitizer function, but this is cosmetic:

```typescript
function resolveSecurePath(base: string, userPath: string): string | null {
  const resolved = resolve(base, '.' + userPath);
  if (!resolved.startsWith(base + '/') && resolved !== base) {
    return null;
  }
  return resolved;
}
```

---

## 6. Verification Steps

### 6.1 Pre-merge Verification

1. **Run all CI workflows on a PR branch** after adding permissions blocks.
   Every workflow must pass -- a permissions block that is too restrictive will cause
   immediate `403` errors from the GitHub API in the failing step.

2. **Verify `release.yml`** by checking that the `release` job still has `contents: write`
   at the job level, which overrides the top-level `contents: read`.

3. **Verify `pr-pipeline.yml`** by checking that `tag-prerelease`, `create-prerelease`,
   and `cleanup` jobs still have their `permissions: contents: write` blocks.

4. **Run integration tests locally** to verify the path-traversal fix in
   `web-to-web.test.ts` does not break the static file server.

### 6.2 Post-merge Verification

1. **Wait for CodeQL rescan:** After merging to main, GitHub's default CodeQL analysis
   will rescan the codebase. Verify that the `actions/missing-workflow-permissions`
   alerts auto-close.

2. **Check GitHub Security tab:** Navigate to
   `https://github.com/Hamza-Labs-Core/zajel/security/code-scanning`
   and verify the alert count drops from 57 to 0 (or 2 if dismissing rather than
   code-fixing the `server/index.ts` alerts).

3. **Verify via API:**
   ```bash
   gh api repos/Hamza-Labs-Core/zajel/code-scanning/alerts?state=open | jq length
   # Expected: 0
   ```

### 6.3 Regression Prevention

1. **CodeQL runs on every PR** via GitHub's default code scanning. New alerts will
   block PRs if branch protection rules enforce code scanning checks.

2. **Consider adding a status check requirement** for CodeQL in branch protection
   settings to prevent new alerts from being merged.

3. **Document the permissions convention** in `CLAUDE.md` or `CONTRIBUTING.md`:
   - All new workflows MUST have a top-level `permissions:` block
   - Default to `contents: read`
   - Only add write permissions at job level where specifically needed

---

## 7. Notes on CodeQL Configuration

The project uses GitHub's **default CodeQL setup** (not a custom workflow). The analysis
runs automatically and scans three language categories:

| Language | Category |
|----------|----------|
| JavaScript/TypeScript | `/language:javascript-typescript` |
| GitHub Actions | `/language:actions` |
| C/C++ | `/language:c-cpp` |

The Actions language scanner is what detects `actions/missing-workflow-permissions`.
The JavaScript scanner detects `js/path-injection`.

The C/C++ scanner currently produces no alerts (likely scanning Flutter/native build
artifacts found in the repository).

No custom `.github/codeql/` configuration exists. The default query suites are used.
If fine-grained control over alert suppression is needed in the future, a
`codeql-config.yml` can be created in `.github/codeql/`.
