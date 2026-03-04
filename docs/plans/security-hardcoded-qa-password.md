# Security Remediation: Hardcoded QA Admin Password

**Severity**: HIGH
**Status**: Open
**Date**: 2026-02-27

---

## 1. Current State Analysis

### 1.1 The Finding

In `packages/admin-cf/tests/e2e/helpers.ts:13-16`, the QA super-admin credentials have hardcoded fallback values:

```typescript
export const SUPER_ADMIN_CREDS = {
  username: process.env['ADMIN_CF_USERNAME'] || 'admin',
  password: process.env['ADMIN_CF_PASSWORD'] || 'admin1234567890',
};
```

The comment at `packages/admin-cf/tests/e2e/admin-e2e.test.ts:7` further documents this:

```
 * Required env: none (defaults to QA URL and admin/admin1234567890)
```

### 1.2 Where the Credentials Are Used

The credentials appear in exactly **two files**, both within the E2E test suite:

| File | Lines | Usage |
|------|-------|-------|
| `packages/admin-cf/tests/e2e/helpers.ts` | 13-16, 260 | Defines `SUPER_ADMIN_CREDS` constant; used in `loginAsSuperAdmin()` helper |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | 7-8, 18, 89-90, 102, 108, 170, 226 | Imports and uses `SUPER_ADMIN_CREDS` across all test sections |

The password string `admin1234567890` does **not** appear anywhere else in the codebase (no CI workflow files, no deployment scripts, no server code).

### 1.3 How the Admin User Is Initialized

The admin system uses a one-time `/admin/api/auth/init` endpoint (in `packages/admin-cf/src/admin-users-do.ts:79-108`):

1. The `handleInit` method checks whether any users exist in Durable Object storage.
2. If zero users exist, it creates the first super-admin with the provided username and password.
3. If any users already exist, it returns `400 Already initialized`.
4. The init endpoint enforces a **minimum 12-character password** (line 96).
5. Passwords are hashed with **PBKDF2 (100,000 iterations, SHA-256, 32-byte salt)** before storage.

The init endpoint is **not called from CI**. There is no automated admin initialization in any GitHub Actions workflow. The admin was initialized manually using `curl` as described in `docs/ADMIN_DASHBOARD_SETUP.md:37-40`.

### 1.4 How CI Passes Credentials

**It does not.** The admin E2E tests (`npm run test:e2e` in `packages/admin-cf`) are **not wired into any CI workflow**. Searching all workflow files under `.github/workflows/` reveals:

- The `pr-pipeline.yml` deploys the admin-cf Worker to QA (lines 1226-1261) but does not run E2E tests against it.
- No workflow sets `ADMIN_CF_USERNAME` or `ADMIN_CF_PASSWORD` environment variables.
- The `server-tests.yml` runs `test:e2e` only for `zajel-signaling`, not `admin-cf`.

The E2E tests are designed to be run **manually by developers** against the live QA deployment, relying on the hardcoded fallback values to avoid needing environment setup.

### 1.5 What Is Publicly Accessible

| Domain | Resolves | Status |
|--------|----------|--------|
| `admin.zajel.qa.hamzalabs.dev` | Yes (104.21.23.68, 172.67.209.123 -- Cloudflare IPs) | **Live and publicly accessible** |
| `admin.zajel.hamzalabs.dev` (production) | No (NXDOMAIN) | Not deployed |

The QA admin dashboard is served by a Cloudflare Worker with **no additional access control** (no Cloudflare Access, no IP allowlist, no WAF rule restricting access). Anyone on the internet can reach the login page and attempt authentication.

### 1.6 Security Controls Already In Place

- **PBKDF2 password hashing**: 100K iterations with 32-byte random salt (in `crypto.ts`).
- **Timing-safe comparison**: Login handler performs hash even for nonexistent users (line 125 of `admin-users-do.ts`).
- **Rate limiting**: 5 login attempts per minute per IP (in-memory per worker isolate, in `index.ts:19-21`).
- **12-character minimum password**: Enforced at both init and create-user endpoints.
- **JWT with expiry**: Tokens expire after 4 hours (240 minutes).
- **Role-based access**: Separate `admin` and `super-admin` roles; user management requires super-admin.

---

## 2. Risk Assessment

### 2.1 Attack Scenario

1. Attacker reads the public GitHub repository and finds the hardcoded password `admin1234567890` with username `admin`.
2. Attacker navigates to `https://admin.zajel.qa.hamzalabs.dev/admin/`.
3. Attacker enters `admin` / `admin1234567890`.
4. If the QA instance was initialized with these exact credentials, the attacker gains **super-admin access** to the QA admin dashboard.

### 2.2 Impact If Exploited

With super-admin access to the QA admin dashboard, an attacker can:

- **View all registered VPS servers**, including their endpoints, regions, and connection statistics.
- **Create new admin users** to maintain persistent access.
- **Delete existing admin users** (except themselves), potentially locking out legitimate administrators.
- **Navigate to VPS dashboards** by clicking server cards, which passes the admin JWT token in the URL to VPS servers. This could grant access to individual VPS admin panels.
- **Observe real-time infrastructure topology**: Server count, health status, connection volumes, and region distribution -- all useful for reconnaissance.

### 2.3 Mitigating Factors

- This is a **QA environment**, not production. Production (`admin.zajel.hamzalabs.dev`) does not resolve.
- The admin dashboard provides **read-only monitoring** plus user management. There is no ability to modify server configuration, push code, or access user message data through the admin API.
- The password may have been **changed manually** after the initial init. The hardcoded value is a fallback default in test code, not the actual deployed credential. However, we cannot confirm this without testing.
- Rate limiting (5 attempts/minute) provides minimal protection. With the exact password from the source code, only one attempt is needed.

### 2.4 Severity Rating

| Factor | Rating | Reasoning |
|--------|--------|-----------|
| Exploitability | **High** | Password is in a public repo, endpoint is publicly accessible |
| Impact | **Medium** | QA environment only; read-mostly access; no user data exposure |
| Likelihood | **High** | Zero-effort credential discovery for anyone who reads the repo |
| Overall | **HIGH** | The combination of public repo + public endpoint + known password eliminates all barriers to unauthorized access |

---

## 3. Step-by-Step Remediation Plan

### Phase 1: Immediate Credential Rotation (Priority: URGENT)

**Goal**: Ensure the live QA admin is not using the hardcoded password.

**Step 1.1**: Rotate the QA admin password manually.

```bash
# 1. Login with current credentials to verify access
curl -s -X POST https://admin.zajel.qa.hamzalabs.dev/admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "<current-password>"}'

# 2. There is no password change endpoint currently.
#    The remediation is to:
#    a) Delete the Durable Object storage (redeploy with new migration tag)
#    b) Re-initialize with a strong randomly generated password
#    c) Store the new password in GitHub Secrets as ADMIN_CF_PASSWORD
```

If the current password IS `admin1234567890`, the QA environment is actively compromised and should be treated as such:

1. Delete all DO storage by adding a new migration in `wrangler.jsonc` (bump from `v1` to `v2` with `deleted_classes` + `new_classes` to reset state).
2. Redeploy.
3. Re-initialize with a cryptographically random password (minimum 20 characters).
4. Store the new credentials in GitHub Secrets.

**Step 1.2**: Add a password change endpoint to `AdminUsersDO` (see Phase 2).

### Phase 2: Remove Hardcoded Fallbacks from Test Code

**Goal**: Eliminate the hardcoded password from source control entirely.

#### File: `packages/admin-cf/tests/e2e/helpers.ts`

Replace the fallback pattern with mandatory environment variables:

```typescript
// BEFORE (insecure):
export const SUPER_ADMIN_CREDS = {
  username: process.env['ADMIN_CF_USERNAME'] || 'admin',
  password: process.env['ADMIN_CF_PASSWORD'] || 'admin1234567890',
};

// AFTER (secure):
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Set it before running E2E tests.`
    );
  }
  return value;
}

export const SUPER_ADMIN_CREDS = {
  username: requireEnv('ADMIN_CF_USERNAME'),
  password: requireEnv('ADMIN_CF_PASSWORD'),
};
```

#### File: `packages/admin-cf/tests/e2e/admin-e2e.test.ts`

Update the header comment to reflect the new requirement:

```typescript
// BEFORE:
 * Required env: none (defaults to QA URL and admin/admin1234567890)
 * Optional env: ADMIN_CF_URL, ADMIN_CF_USERNAME, ADMIN_CF_PASSWORD

// AFTER:
 * Required env: ADMIN_CF_USERNAME, ADMIN_CF_PASSWORD
 * Optional env: ADMIN_CF_URL (defaults to QA URL)
```

#### Files to modify:
| File | Change |
|------|--------|
| `packages/admin-cf/tests/e2e/helpers.ts` | Remove fallback values; add `requireEnv()` helper; make `BASE_URL` the only optional env var |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Update header comment (lines 7-8) |

### Phase 3: Add Password Change Endpoint

**Goal**: Allow administrators to change passwords without needing to destroy and recreate the Durable Object.

#### File: `packages/admin-cf/src/admin-users-do.ts`

Add a `handleChangePassword` method:

```typescript
/**
 * Change password for authenticated user
 */
private async handleChangePassword(request: Request): Promise<Response> {
  const authResult = await this.requireAuth(request);
  if (authResult instanceof Response) return authResult;

  const body = await request.json() as {
    currentPassword: string;
    newPassword: string;
  };

  if (!body.currentPassword || !body.newPassword) {
    return this.jsonResponse(
      { success: false, error: 'Current password and new password required' },
      400
    );
  }

  if (body.newPassword.length < 12) {
    return this.jsonResponse(
      { success: false, error: 'Password must be at least 12 characters' },
      400
    );
  }

  const user = await this.state.storage.get<AdminUser>(`user:${authResult.sub}`);
  if (!user) {
    return this.jsonResponse({ success: false, error: 'User not found' }, 404);
  }

  const isValid = await verifyPassword(body.currentPassword, user.passwordHash, user.salt);
  if (!isValid) {
    return this.jsonResponse(
      { success: false, error: 'Current password is incorrect' },
      401
    );
  }

  const newSalt = generateSalt();
  const newHash = await hashPassword(body.newPassword, newSalt);
  user.passwordHash = newHash;
  user.salt = newSalt;
  await this.state.storage.put(`user:${user.id}`, user);

  return this.jsonResponse({ success: true });
}
```

Wire the route in the `fetch` handler and in `packages/admin-cf/src/index.ts`.

#### Files to modify:
| File | Change |
|------|--------|
| `packages/admin-cf/src/admin-users-do.ts` | Add `handleChangePassword` method; add route in `fetch()` |
| `packages/admin-cf/src/index.ts` | Add route for `POST /admin/api/auth/change-password` |
| `packages/admin-cf/src/routes/auth.ts` | Add `handleChangePassword` export |

### Phase 4: Wire Admin E2E Tests into CI with Secrets

**Goal**: Run admin E2E tests in CI without exposing credentials.

#### File: `.github/workflows/pr-pipeline.yml`

Add an E2E test step after the admin-cf deployment step:

```yaml
- name: Run admin E2E tests
  if: needs.detect-changes.outputs.admin == 'true'
  working-directory: packages/admin-cf
  run: npm run test:e2e
  env:
    ADMIN_CF_URL: https://admin.zajel.qa.hamzalabs.dev
    ADMIN_CF_USERNAME: ${{ secrets.ADMIN_CF_USERNAME }}
    ADMIN_CF_PASSWORD: ${{ secrets.ADMIN_CF_PASSWORD }}
```

#### GitHub Secrets to create:
| Secret Name | Value |
|-------------|-------|
| `ADMIN_CF_USERNAME` | The QA super-admin username |
| `ADMIN_CF_PASSWORD` | The rotated QA super-admin password (cryptographically random, 20+ chars) |

### Phase 5: Harden the QA Admin Endpoint

**Goal**: Add defense-in-depth controls even for QA.

#### 5.1 Cloudflare Access (Recommended)

Place the QA admin dashboard behind Cloudflare Access (Zero Trust) so only authorized team members can reach the login page. This adds a pre-authentication layer before the Worker is even invoked.

Configuration (via Cloudflare dashboard or Terraform):
- Application: `admin.zajel.qa.hamzalabs.dev`
- Policy: Allow authenticated team members (email domain or GitHub org membership)
- Session duration: 24 hours

#### 5.2 Strengthen Rate Limiting

The current rate limiting is per-isolate in-memory, meaning it resets across CF Worker instances and is not reliable for distributed deployments. Consider:

- Use **Durable Objects** or **Cloudflare Rate Limiting rules** for persistent rate limiting.
- Implement **account lockout** after N failed attempts (e.g., 10 failures within 15 minutes locks the account for 30 minutes).

#### Files to modify:
| File | Change |
|------|--------|
| `packages/admin-cf/src/admin-users-do.ts` | Add failed-attempt tracking per user; implement account lockout |
| `packages/admin-cf/src/index.ts` | Consider moving rate limiting to DO-based persistent storage |

### Phase 6: Add Password Complexity Enforcement

**Goal**: Prevent weak passwords even if they meet the 12-character minimum.

The current validation only checks `password.length < 12`. The hardcoded password `admin1234567890` passes this check despite being trivially guessable (dictionary word + sequential digits).

#### Recommended checks to add in `handleInit` and `handleCreateUser`:

```typescript
function validatePasswordStrength(password: string): string | null {
  if (password.length < 16) {
    return 'Password must be at least 16 characters';
  }
  // Reject passwords that are mostly sequential digits appended to a word
  if (/^[a-z]+\d+$/i.test(password)) {
    return 'Password must not be a word followed by numbers';
  }
  // Require character class diversity
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  const classCount = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
  if (classCount < 3) {
    return 'Password must contain at least 3 of: uppercase, lowercase, digits, special characters';
  }
  return null; // valid
}
```

#### Files to modify:
| File | Change |
|------|--------|
| `packages/admin-cf/src/admin-users-do.ts` | Add `validatePasswordStrength()` function; replace `length < 12` checks in `handleInit` and `handleCreateUser` |

---

## 4. Summary of All Files to Modify

| Phase | File | Change Description |
|-------|------|--------------------|
| 2 | `packages/admin-cf/tests/e2e/helpers.ts` | Remove hardcoded fallbacks; require env vars |
| 2 | `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Update header comment |
| 3 | `packages/admin-cf/src/admin-users-do.ts` | Add password change endpoint |
| 3 | `packages/admin-cf/src/index.ts` | Add route for password change |
| 3 | `packages/admin-cf/src/routes/auth.ts` | Add handler export |
| 4 | `.github/workflows/pr-pipeline.yml` | Wire E2E tests with secrets |
| 5 | `packages/admin-cf/src/admin-users-do.ts` | Add account lockout |
| 6 | `packages/admin-cf/src/admin-users-do.ts` | Add password complexity validation |

---

## 5. Verification Steps

### After Phase 1 (Credential Rotation)

```bash
# Verify old password no longer works
curl -s -X POST https://admin.zajel.qa.hamzalabs.dev/admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin1234567890"}'
# Expected: {"success":false,"error":"Invalid credentials"}

# Verify new password works (from secrets)
curl -s -X POST https://admin.zajel.qa.hamzalabs.dev/admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "<new-username>", "password": "<new-password>"}'
# Expected: {"success":true,"data":{"token":"...","user":{...}}}
```

### After Phase 2 (Fallback Removal)

```bash
# Verify tests fail without env vars
cd packages/admin-cf
unset ADMIN_CF_USERNAME ADMIN_CF_PASSWORD
npm run test:e2e 2>&1 | head -5
# Expected: Error: Missing required environment variable: ADMIN_CF_USERNAME

# Verify tests pass with env vars
ADMIN_CF_USERNAME=admin ADMIN_CF_PASSWORD=<new-password> npm run test:e2e
# Expected: All tests pass
```

### After Phase 3 (Password Change Endpoint)

```bash
# Verify password change works
TOKEN=$(curl -s -X POST https://admin.zajel.qa.hamzalabs.dev/admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "<current>"}' | jq -r '.data.token')

curl -s -X POST https://admin.zajel.qa.hamzalabs.dev/admin/api/auth/change-password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"currentPassword": "<current>", "newPassword": "<new>"}'
# Expected: {"success":true}
```

### After Phase 4 (CI Integration)

- Push a PR that touches `packages/admin-cf/`.
- Verify the admin E2E test job runs and passes in the PR pipeline.
- Verify no credentials appear in CI logs (GitHub Actions automatically masks secrets).

### After Phase 6 (Password Complexity)

```bash
# Verify weak passwords are rejected
curl -s -X POST https://admin.zajel.qa.hamzalabs.dev/admin/api/auth/init \
  -H "Content-Type: application/json" \
  -d '{"username": "test", "password": "admin1234567890"}'
# Expected: {"success":false,"error":"Password must not be a word followed by numbers"}
```

---

## 6. Git History Note

Once the hardcoded password is removed from the source, it will still exist in **git history**. Since the repository is public, this password should be considered permanently compromised regardless of any future code changes. The credential rotation in Phase 1 is therefore the most critical step -- the password itself can never be un-leaked from git history, so the deployed credential must differ from what was ever committed.
